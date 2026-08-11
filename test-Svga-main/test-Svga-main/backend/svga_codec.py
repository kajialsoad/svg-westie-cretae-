"""Pure-python SVGA 2.x codec.

Decode (protobuf + zlib), render frames (premultiplied-alpha compositing with
clipPath / matte / vector-shape support), encode, and recompress existing files
without touching their timeline.

Fidelity rules carried over from the proven AnimSuite Pro renderer:
  * a sprite bitmap is scaled to its frame `layout` size, then the affine
    transform is applied - not drawn at native size
  * compositing happens in premultiplied alpha so resampled edges do not pick
    up dark or coloured halos
  * `clipPath`, `matteKey` masking and vector `shapes` are all honoured, so
    masks and glow layers survive the round-trip
  * images are never resized during recompression: rewriting sprite geometry
    breaks playback in native SVGA players
"""
from __future__ import annotations

import base64
import hashlib
import io
import math
import os
import re
import struct
import zlib
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw

import compression

# Guard against decompression bombs in uploaded assets.
Image.MAX_IMAGE_PIXELS = int(os.environ.get("PIL_MAX_IMAGE_PIXELS", str(64_000_000)))

MAX_INFLATE_BYTES = int(os.environ.get("SVGA_MAX_INFLATE_BYTES", str(512 * 1024 * 1024)))


# ---------------------------------------------------------------------------
# low level protobuf
# ---------------------------------------------------------------------------
def _read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def _iter_fields(buf):
    """Yield (field_number, wire_type, value) in wire order."""
    pos = 0
    n = len(buf)
    while pos < n:
        key, pos = _read_varint(buf, pos)
        fn = key >> 3
        wt = key & 7
        if wt == 0:
            val, pos = _read_varint(buf, pos)
        elif wt == 5:
            val = buf[pos:pos + 4]
            pos += 4
        elif wt == 1:
            val = buf[pos:pos + 8]
            pos += 8
        elif wt == 2:
            ln, pos = _read_varint(buf, pos)
            val = buf[pos:pos + ln]
            pos += ln
        else:
            break
        yield fn, wt, val


def _parse_fields(buf):
    fields = {}
    for fn, wt, val in _iter_fields(buf):
        fields.setdefault(fn, []).append((wt, val))
    return fields


def _f32(b):
    return struct.unpack('<f', b)[0]


def _varint(v):
    out = bytearray()
    v = int(v)
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def _tag(fn, wt):
    return _varint((fn << 3) | wt)


def _ld(b):
    return _varint(len(b)) + b


def _wf32(v):
    return struct.pack('<f', float(v))


def _emit(fn, wt, val):
    """Re-serialize one field exactly as it was read."""
    if wt == 0:
        return _tag(fn, 0) + _varint(val)
    if wt == 2:
        return _tag(fn, 2) + _ld(val)
    if wt in (1, 5):
        return _tag(fn, wt) + bytes(val)
    return b""


def _inflate(svga_bytes):
    """zlib-inflate with a hard output cap; falls back to raw protobuf."""
    try:
        obj = zlib.decompressobj()
        raw = obj.decompress(bytes(svga_bytes), MAX_INFLATE_BYTES)
        if obj.unconsumed_tail:
            raise ValueError("SVGA payload exceeds the inflate limit")
        return raw
    except zlib.error:
        # A few exporters emit uncompressed protobuf.
        return bytes(svga_bytes)


# ---------------------------------------------------------------------------
# decode
# ---------------------------------------------------------------------------
_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _decode_transform(buf):
    t = _parse_fields(buf)
    return tuple(_f32(t[i][0][1]) if i in t else _IDENTITY[i - 1] for i in range(1, 7))


def _decode_layout(buf):
    ld = _parse_fields(buf)
    return [_f32(ld[i][0][1]) if i in ld else 0.0 for i in range(1, 5)]


def _decode_color(buf):
    c = _parse_fields(buf)
    vals = [_f32(c[i][0][1]) if i in c else 0.0 for i in range(1, 5)]
    # SVGA writes 0-1 floats; some exporters write 0-255.
    scale = 1.0 if max(vals[:3] or [0]) <= 1.0 else 1.0 / 255.0
    return (
        int(round(max(0.0, min(1.0, vals[0] * scale)) * 255)),
        int(round(max(0.0, min(1.0, vals[1] * scale)) * 255)),
        int(round(max(0.0, min(1.0, vals[2] * scale)) * 255)),
        int(round(max(0.0, min(1.0, vals[3])) * 255)),
    )


def _decode_shape(buf):
    """ShapeEntity: type=1, shape=2, rect=3, ellipse=4, styles=10, transform=11."""
    s = _parse_fields(buf)
    shape = {"type": s[1][0][1] if 1 in s else 0, "transform": None,
             "d": None, "rect": None, "ellipse": None, "styles": {}}

    if 2 in s:
        args = _parse_fields(s[2][0][1])
        if 1 in args:
            shape["d"] = args[1][0][1].decode("utf-8", "ignore")
    if 3 in s:
        r = _parse_fields(s[3][0][1])
        shape["rect"] = [_f32(r[i][0][1]) if i in r else 0.0 for i in range(1, 6)]
    if 4 in s:
        e = _parse_fields(s[4][0][1])
        shape["ellipse"] = [_f32(e[i][0][1]) if i in e else 0.0 for i in range(1, 5)]
    if 10 in s:
        st = _parse_fields(s[10][0][1])
        shape["styles"] = {
            "fill": _decode_color(st[1][0][1]) if 1 in st else None,
            "stroke": _decode_color(st[2][0][1]) if 2 in st else None,
            "strokeWidth": _f32(st[3][0][1]) if 3 in st else 0.0,
        }
    if 11 in s:
        shape["transform"] = _decode_transform(s[11][0][1])
    return shape


def decode(svga_bytes):
    raw = _inflate(svga_bytes)
    fields = _parse_fields(raw)

    version = fields[1][0][1].decode('utf-8', 'ignore') if 1 in fields else '2.0.0'
    w = h = 0.0
    fps = 20
    nframes = 0
    if 2 in fields:
        p = _parse_fields(fields[2][0][1])
        if 1 in p:
            w = _f32(p[1][0][1])
        if 2 in p:
            h = _f32(p[2][0][1])
        if 3 in p:
            fps = p[3][0][1]
        if 4 in p:
            nframes = p[4][0][1]

    images = {}
    for _wt, val in fields.get(3, []):
        e = _parse_fields(val)
        if 1 in e and 2 in e:
            images[e[1][0][1].decode('utf-8', 'ignore')] = e[2][0][1]

    sprites = []
    for _wt, val in fields.get(4, []):
        sp = _parse_fields(val)
        image_key = sp[1][0][1].decode('utf-8', 'ignore') if 1 in sp else ''
        matte_key = sp[3][0][1].decode('utf-8', 'ignore') if 3 in sp else ''
        frames = []
        for _fwt, fval in sp.get(2, []):
            fr = _parse_fields(fval)
            frames.append({
                'alpha': _f32(fr[1][0][1]) if 1 in fr else 0.0,
                'layout': _decode_layout(fr[2][0][1]) if 2 in fr else None,
                'transform': _decode_transform(fr[3][0][1]) if 3 in fr else None,
                'clipPath': fr[4][0][1].decode('utf-8', 'ignore') if 4 in fr else '',
                'shapes': [_decode_shape(sv) for _swt, sv in fr.get(5, [])],
            })
        sprites.append({'imageKey': image_key, 'matteKey': matte_key, 'frames': frames})

    audios = []
    for _wt, val in fields.get(5, []):
        a = _parse_fields(val)
        audios.append({
            'audioKey': a[1][0][1].decode('utf-8', 'ignore') if 1 in a else '',
            'startFrame': a[2][0][1] if 2 in a else 0,
            'endFrame': a[3][0][1] if 3 in a else 0,
            'startTime': a[4][0][1] if 4 in a else 0,
            'totalTime': a[5][0][1] if 5 in a else 0,
        })

    return {
        'version': version,
        'width': w,
        'height': h,
        'fps': fps or 20,
        'frames': nframes,
        'images': images,
        'sprites': sprites,
        'audios': audios,
    }


def info(svga_bytes):
    d = decode(svga_bytes)
    fps = d['fps'] or 20
    return {
        'version': d['version'],
        'width': round(d['width']),
        'height': round(d['height']),
        'fps': fps,
        'frames': d['frames'],
        'duration': round(d['frames'] / fps, 2) if fps else 0,
        'assets': len(d['images']),
        'sprites': len(d['sprites']),
        'audios': len(d['audios']),
    }


def layers(svga_bytes, max_layers=80):
    d = decode(svga_bytes)
    result = []
    for i, sp in enumerate(d['sprites'][:max_layers]):
        raw = d['images'].get(sp['imageKey'])
        thumb = None
        if raw:
            try:
                im = Image.open(io.BytesIO(raw)).convert('RGBA')
                im.thumbnail((120, 120))
                b = io.BytesIO()
                im.save(b, 'PNG')
                thumb = 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()
            except Exception:
                pass
        visible = sum(1 for f in sp['frames'] if f['alpha'] > 0.01)
        result.append({"index": i, "imageKey": sp['imageKey'], "thumb": thumb,
                       "matteKey": sp['matteKey'],
                       "hasShapes": any(f['shapes'] for f in sp['frames']),
                       "visibleFrames": visible, "frameCount": len(sp['frames'])})
    return {"width": round(d['width']), "height": round(d['height']), "fps": d['fps'],
            "frames": d['frames'], "layerCount": len(d['sprites']), "layers": result}


# ---------------------------------------------------------------------------
# SVG path handling (clipPath + vector shapes)
# ---------------------------------------------------------------------------
_PATH_TOKEN = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)")
_BEZIER_STEPS = 16


def _flatten_cubic(p0, p1, p2, p3, steps=_BEZIER_STEPS):
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        x = (mt ** 3) * p0[0] + 3 * (mt ** 2) * t * p1[0] + 3 * mt * (t ** 2) * p2[0] + (t ** 3) * p3[0]
        y = (mt ** 3) * p0[1] + 3 * (mt ** 2) * t * p1[1] + 3 * mt * (t ** 2) * p2[1] + (t ** 3) * p3[1]
        pts.append((x, y))
    return pts


def parse_svg_path(d: str):
    """Flatten an SVG path into a list of polylines (sub-paths).

    Covers the command set SVGA exporters actually emit: M/L/H/V/C/S/Q/T/Z in
    both absolute and relative form. Arcs are approximated by a line, which is
    safe because SVGA shape data is generated from AE masks, not hand-authored.
    """
    if not d:
        return []

    tokens = []
    for m in _PATH_TOKEN.finditer(d):
        tokens.append(m.group(1) if m.group(1) else float(m.group(2)))

    subpaths = []
    current = []
    cx = cy = 0.0
    start_x = start_y = 0.0
    prev_ctrl = None
    cmd = None
    i = 0

    def flush():
        nonlocal current
        if len(current) >= 2:
            subpaths.append(current)
        current = []

    while i < len(tokens):
        tok = tokens[i]
        if isinstance(tok, str):
            cmd = tok
            i += 1
            if cmd in ("Z", "z"):
                if current:
                    current.append((start_x, start_y))
                    flush()
                cx, cy = start_x, start_y
                prev_ctrl = None
                continue
        if cmd is None:
            i += 1
            continue

        rel = cmd.islower()
        c = cmd.upper()
        try:
            if c == "M":
                x, y = tokens[i], tokens[i + 1]
                i += 2
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                flush()
                current = [(cx, cy)]
                start_x, start_y = cx, cy
                cmd = "l" if rel else "L"
                prev_ctrl = None
            elif c == "L":
                x, y = tokens[i], tokens[i + 1]
                i += 2
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                current.append((cx, cy))
                prev_ctrl = None
            elif c == "H":
                x = tokens[i]
                i += 1
                cx = cx + x if rel else x
                current.append((cx, cy))
                prev_ctrl = None
            elif c == "V":
                y = tokens[i]
                i += 1
                cy = cy + y if rel else y
                current.append((cx, cy))
                prev_ctrl = None
            elif c == "C":
                x1, y1, x2, y2, x, y = tokens[i:i + 6]
                i += 6
                if rel:
                    x1, y1, x2, y2, x, y = cx + x1, cy + y1, cx + x2, cy + y2, cx + x, cy + y
                current.extend(_flatten_cubic((cx, cy), (x1, y1), (x2, y2), (x, y)))
                prev_ctrl = (x2, y2)
                cx, cy = x, y
            elif c == "S":
                x2, y2, x, y = tokens[i:i + 4]
                i += 4
                if rel:
                    x2, y2, x, y = cx + x2, cy + y2, cx + x, cy + y
                x1, y1 = (2 * cx - prev_ctrl[0], 2 * cy - prev_ctrl[1]) if prev_ctrl else (cx, cy)
                current.extend(_flatten_cubic((cx, cy), (x1, y1), (x2, y2), (x, y)))
                prev_ctrl = (x2, y2)
                cx, cy = x, y
            elif c == "Q":
                x1, y1, x, y = tokens[i:i + 4]
                i += 4
                if rel:
                    x1, y1, x, y = cx + x1, cy + y1, cx + x, cy + y
                c1 = (cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy))
                c2 = (x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y))
                current.extend(_flatten_cubic((cx, cy), c1, c2, (x, y)))
                prev_ctrl = (x1, y1)
                cx, cy = x, y
            elif c == "T":
                x, y = tokens[i], tokens[i + 1]
                i += 2
                if rel:
                    x, y = cx + x, cy + y
                x1, y1 = (2 * cx - prev_ctrl[0], 2 * cy - prev_ctrl[1]) if prev_ctrl else (cx, cy)
                c1 = (cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy))
                c2 = (x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y))
                current.extend(_flatten_cubic((cx, cy), c1, c2, (x, y)))
                prev_ctrl = (x1, y1)
                cx, cy = x, y
            elif c == "A":
                # Approximate: skip the arc parameters, line to the endpoint.
                x, y = tokens[i + 5], tokens[i + 6]
                i += 7
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                current.append((cx, cy))
                prev_ctrl = None
            else:
                i += 1
        except (IndexError, TypeError, ValueError):
            break

    flush()
    return subpaths


def _apply_matrix(points, m):
    a, b, c, d, tx, ty = m
    return [(a * x + c * y + tx, b * x + d * y + ty) for x, y in points]


_SUPERSAMPLE = 2

# ShapeEntity.ShapeType
SHAPE_TYPE_SHAPE = 0
SHAPE_TYPE_RECT = 1
SHAPE_TYPE_ELLIPSE = 2
SHAPE_TYPE_KEEP = 3


def _rasterize_subpaths(subpaths, size, matrix, supersample=_SUPERSAMPLE):
    """Anti-aliased coverage mask (uint8) for a set of polylines."""
    w, h = size
    ss = max(1, supersample)
    mask = Image.new("L", (w * ss, h * ss), 0)
    draw = ImageDraw.Draw(mask)
    drawn = False
    for sub in subpaths:
        pts = _apply_matrix(sub, matrix)
        pts = [(x * ss, y * ss) for x, y in pts]
        if len(pts) >= 3:
            draw.polygon(pts, fill=255)
            drawn = True
    if not drawn:
        return None
    if ss > 1:
        mask = mask.resize((w, h), Image.BOX)
    return np.asarray(mask, dtype=np.float32) / 255.0


# ---------------------------------------------------------------------------
# premultiplied-alpha compositing helpers
# ---------------------------------------------------------------------------
def _to_premultiplied(img: Image.Image) -> Image.Image:
    """RGBA -> premultiplied RGBA so affine resampling cannot bleed halos."""
    arr = np.asarray(img.convert("RGBA"), dtype=np.float32)
    a = arr[..., 3:4] / 255.0
    arr[..., :3] *= a
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def _composite_over(canvas: np.ndarray, layer: np.ndarray) -> None:
    """canvas = layer OVER canvas, both premultiplied float32 in-place."""
    inv_alpha = 1.0 - layer[..., 3:4]
    canvas *= inv_alpha
    canvas += layer


def _unpremultiply(canvas: np.ndarray) -> Image.Image:
    a = np.clip(canvas[..., 3:4], 0.0, 1.0)
    rgb = np.where(a > 1e-6, canvas[..., :3] / np.maximum(a, 1e-6), 0.0)
    out = np.empty(canvas.shape, dtype=np.uint8)
    out[..., :3] = np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(a[..., 0] * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def _draw_shapes(shapes, size, base_matrix):
    """Rasterize vector shapes into a premultiplied float32 RGBA layer."""
    w, h = size
    ss = _SUPERSAMPLE
    canvas = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    drew = False

    for shape in shapes:
        m = base_matrix
        if shape.get("transform"):
            sa, sb, sc, sd, stx, sty = shape["transform"]
            a, b, c, d, tx, ty = base_matrix
            # base_matrix * shape_transform
            m = (a * sa + c * sb, b * sa + d * sb,
                 a * sc + c * sd, b * sc + d * sd,
                 a * stx + c * sty + tx, b * stx + d * sty + ty)

        styles = shape.get("styles") or {}
        fill = styles.get("fill")
        stroke = styles.get("stroke")
        stroke_width = float(styles.get("strokeWidth") or 0.0)
        # Approximate the transform's scale so stroke width stays visually right.
        scale = math.sqrt(abs(m[0] * m[3] - m[1] * m[2])) or 1.0
        pen = max(1, int(round(stroke_width * scale * ss)))

        stype = shape.get("type", 0)
        subpaths = []
        if stype == 1 and shape.get("rect"):
            x, y, rw, rh, _r = shape["rect"]
            subpaths = [[(x, y), (x + rw, y), (x + rw, y + rh), (x, y + rh), (x, y)]]
        elif stype == 2 and shape.get("ellipse"):
            ex, ey, rx, ry = shape["ellipse"]
            pts = [(ex + rx * math.cos(t), ey + ry * math.sin(t))
                   for t in np.linspace(0, 2 * math.pi, 48)]
            subpaths = [pts]
        elif shape.get("d"):
            subpaths = parse_svg_path(shape["d"])

        for sub in subpaths:
            pts = [(x * ss, y * ss) for x, y in _apply_matrix(sub, m)]
            if len(pts) < 2:
                continue
            if fill and fill[3] > 0 and len(pts) >= 3:
                draw.polygon(pts, fill=fill)
                drew = True
            if stroke and stroke[3] > 0 and stroke_width > 0:
                draw.line(pts, fill=stroke, width=pen, joint="curve")
                drew = True

    if not drew:
        canvas.close()
        return None

    # Only the drawn region is converted to float. A full-canvas float32 buffer
    # per shape per frame is what makes long vector animations run out of memory.
    bbox_ss = canvas.getbbox()
    if bbox_ss is None:
        canvas.close()
        return None

    x0 = max(0, bbox_ss[0] // ss)
    y0 = max(0, bbox_ss[1] // ss)
    x1 = min(w, -(-bbox_ss[2] // ss))
    y1 = min(h, -(-bbox_ss[3] // ss))
    if x1 <= x0 or y1 <= y0:
        canvas.close()
        return None

    crop = canvas.crop((x0 * ss, y0 * ss, x1 * ss, y1 * ss))
    canvas.close()
    if ss > 1:
        crop = crop.resize((x1 - x0, y1 - y0), Image.BOX)

    arr = np.asarray(crop, dtype=np.float32) / 255.0
    crop.close()
    arr[..., :3] *= arr[..., 3:4]  # premultiply
    return (x0, y0, x1, y1), arr


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------
_EPS = 1e-3


def _compose_matrix(transform, layout, img_size, override=None):
    """Forward matrix mapping source bitmap pixels to canvas pixels.

    Mirrors the reference renderer: the bitmap is first scaled into its layout
    rectangle, then the frame's affine transform is applied. When the transform
    carries a translation, layout x/y is not applied again (double placement).
    """
    a, b, c, d, tx, ty = transform or _IDENTITY
    iw, ih = img_size
    if iw <= 0 or ih <= 0:
        return None

    lx, ly, lw, lh = (layout or [0.0, 0.0, float(iw), float(ih)])
    dw = lw if lw and lw > 0 else float(iw)
    dh = lh if lh and lh > 0 else float(ih)
    dx, dy = lx or 0.0, ly or 0.0

    if abs(tx) > _EPS or abs(ty) > _EPS:
        dx = dy = 0.0

    if override:
        s = float(override.get('scale', 1.0) or 1.0)
        a, b, c, d = a * s, b * s, c * s, d * s
        tx = tx * s + float(override.get('dx', 0.0) or 0.0)
        ty = ty * s + float(override.get('dy', 0.0) or 0.0)

    sx, sy = dw / iw, dh / ih
    return (a * sx, b * sx, c * sy, d * sy,
            a * dx + c * dy + tx, b * dx + d * dy + ty)


def _forward_bbox(matrix, img_size, canvas_size):
    fa, fb, fc, fd, ftx, fty = matrix
    iw, ih = img_size
    w, h = canvas_size
    xs, ys = [], []
    for px, py in ((0, 0), (iw, 0), (0, ih), (iw, ih)):
        xs.append(fa * px + fc * py + ftx)
        ys.append(fb * px + fd * py + fty)
    x0 = max(0, int(math.floor(min(xs))) - 1)
    y0 = max(0, int(math.floor(min(ys))) - 1)
    x1 = min(w, int(math.ceil(max(xs))) + 1)
    y1 = min(h, int(math.ceil(max(ys))) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _invert_for_pil(matrix, x0, y0):
    fa, fb, fc, fd, ftx, fty = matrix
    det = fa * fd - fb * fc
    if abs(det) < 1e-9:
        return None
    A, B = fd / det, -fc / det
    C = (-fd * ftx + fc * fty) / det
    D, E = -fb / det, fa / det
    F = (fb * ftx - fa * fty) / det
    return (A, B, A * x0 + B * y0 + C, D, E, D * x0 + E * y0 + F)


def _shape_base_matrix(frame, override=None):
    """Frame transform in canvas space, with editor overrides folded in.

    Vector shapes are positioned by the frame transform alone: unlike bitmaps
    they carry no layout rectangle to scale into.
    """
    a, b, c, d, tx, ty = frame.get('transform') or _IDENTITY
    if override:
        s = float(override.get('scale', 1.0) or 1.0)
        a, b, c, d = a * s, b * s, c * s, d * s
        tx = tx * s + float(override.get('dx', 0.0) or 0.0)
        ty = ty * s + float(override.get('dy', 0.0) or 0.0)
    return (a, b, c, d, tx, ty)


def _render_sprite_layer(premul_img, frame, canvas_size, alpha, override=None):
    """Return (bbox, premultiplied float32 RGBA patch) or None."""
    matrix = _compose_matrix(frame.get('transform'), frame.get('layout'),
                             premul_img.size, override)
    if matrix is None:
        return None
    bbox = _forward_bbox(matrix, premul_img.size, canvas_size)
    if bbox is None:
        return None
    x0, y0, x1, y1 = bbox
    coeffs = _invert_for_pil(matrix, x0, y0)
    if coeffs is None:
        return None

    try:
        patch = premul_img.transform((x1 - x0, y1 - y0), Image.AFFINE, coeffs,
                                     resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0))
    except (ValueError, OSError):
        return None

    arr = np.asarray(patch, dtype=np.float32) / 255.0
    if alpha < 0.999:
        arr *= alpha
    # BICUBIC can ring past the valid range; keep the premultiplied invariant.
    np.clip(arr, 0.0, 1.0, out=arr)
    np.minimum(arr[..., :3], arr[..., 3:4], out=arr[..., :3])

    clip_path = frame.get('clipPath')
    if clip_path:
        subpaths = parse_svg_path(clip_path)
        if subpaths:
            mask = _rasterize_subpaths(subpaths, canvas_size,
                                       frame.get('transform') or _IDENTITY)
            if mask is not None:
                arr *= mask[y0:y1, x0:x1, None]

    return bbox, arr


def render_metadata(svga_bytes, max_frames=None):
    """Canvas size / fps / renderable frame count without rendering anything."""
    d = decode(svga_bytes)
    cap = max_frames or compression.MAX_RENDER_FRAMES
    return {
        "width": max(1, round(d["width"])),
        "height": max(1, round(d["height"])),
        "fps": d["fps"] or 20,
        "totalFrames": min(d["frames"], cap) if d["frames"] else 0,
    }


def iter_render_frames(svga_bytes, max_frames=None, overrides=None):
    """Yield rendered RGBA frames one at a time (constant memory)."""
    d = decode(svga_bytes)
    w = max(1, round(d['width']))
    h = max(1, round(d['height']))
    canvas_size = (w, h)

    premul_images = {}
    for k, raw in d['images'].items():
        try:
            with Image.open(io.BytesIO(raw)) as im:
                premul_images[k] = _to_premultiplied(im)
        except Exception:
            # Audio blobs and unsupported codecs live in the same map.
            continue

    hard_cap = max_frames or compression.MAX_RENDER_FRAMES
    nframes = min(d['frames'], hard_cap) if d['frames'] else 0
    sprites = d['sprites']

    order = list(range(len(sprites)))
    if overrides:
        order.sort(key=lambda idx: overrides.get(idx, {}).get('order', idx))

    # Sprites referenced as a matte are masks, not drawable content.
    matte_keys = {sp['matteKey'] for sp in sprites if sp.get('matteKey')}

    # Persists across frames: ShapeType.KEEP refers back to earlier frames.
    shape_cache: dict[int, list] = {}

    for i in range(nframes):
        canvas = np.zeros((h, w, 4), dtype=np.float32)
        matte_alpha = {}

        for si in order:
            sp = sprites[si]
            frames = sp['frames']
            if i >= len(frames):
                continue
            frame = frames[i]
            ov = overrides.get(si) if overrides else None
            if ov and not ov.get('visible', True):
                continue

            alpha = (frame['alpha'] or 0.0) * (float(ov.get('opacity', 1.0)) if ov else 1.0)
            if alpha <= 0.001:
                continue

            # A sprite carries a bitmap, vector shapes, or both. AE shape layers
            # keep an imageKey like "layer.vector" that has no entry in the
            # image map, so a missing bitmap must not skip the shape pass.
            img = premul_images.get(sp['imageKey']) if sp['imageKey'] else None

            if img is not None:
                rendered = _render_sprite_layer(img, frame, canvas_size, alpha, ov)
                if rendered is not None:
                    (x0, y0, x1, y1), patch = rendered

                    if sp['imageKey'] in matte_keys:
                        # Keep the coverage for the sprite it masks, don't draw it.
                        full = np.zeros((h, w), dtype=np.float32)
                        full[y0:y1, x0:x1] = patch[..., 3]
                        matte_alpha[sp['imageKey']] = full
                        continue

                    mask = matte_alpha.get(sp['matteKey']) if sp['matteKey'] else None
                    if mask is not None:
                        patch = patch * mask[y0:y1, x0:x1, None]

                    _composite_over(canvas[y0:y1, x0:x1], patch)

            # ShapeType.KEEP (3) means "reuse this sprite's previous shape
            # definition"; only the frame transform changes. AE exports lean on
            # this heavily, so without the cache every animated vector layer
            # after its first frame renders as nothing.
            shapes = frame['shapes']
            if shapes:
                if shapes[0].get('type') == SHAPE_TYPE_KEEP:
                    shapes = shape_cache.get(si)
                else:
                    shape_cache[si] = shapes

            if shapes:
                drawn = _draw_shapes(shapes, canvas_size,
                                     _shape_base_matrix(frame, ov))
                if drawn is not None:
                    (sx0, sy0, sx1, sy1), shape_layer = drawn
                    if alpha < 0.999:
                        shape_layer *= alpha
                    mask = matte_alpha.get(sp['matteKey']) if sp['matteKey'] else None
                    if mask is not None:
                        shape_layer *= mask[sy0:sy1, sx0:sx1, None]
                    _composite_over(canvas[sy0:sy1, sx0:sx1], shape_layer)
                    del shape_layer

        yield _unpremultiply(canvas)
        del canvas


def render_frames(svga_bytes, max_frames=None, overrides=None):
    """Render every frame into a list of RGBA PIL images.

    Convenient, but it holds the whole animation in memory. Anything that only
    streams frames into an encoder should use `render_frames_to_directory`
    instead: a 600-frame 1080p animation is several GB as PIL images.
    """
    meta = render_metadata(svga_bytes)
    frames = list(iter_render_frames(svga_bytes, max_frames=max_frames,
                                     overrides=overrides))
    if not frames:
        raise ValueError("empty animation")
    return frames, meta["fps"], meta["width"], meta["height"]


def render_frames_to_directory(svga_bytes, out_dir, prefix="f_", max_frames=None,
                               overrides=None, flatten_background=None,
                               on_frame=None):
    """Stream rendered frames straight to sequential PNGs on disk.

    Returns {width, height, fps, totalFrames, framePaths}. Only one frame is
    resident at a time, which is what makes long or large animations safe.
    """
    os.makedirs(out_dir, exist_ok=True)
    meta = render_metadata(svga_bytes)
    bg = None
    if flatten_background is not None:
        bg = Image.new("RGBA", (meta["width"], meta["height"]), flatten_background)

    paths = []
    for idx, frame in enumerate(iter_render_frames(svga_bytes, max_frames=max_frames,
                                                  overrides=overrides)):
        if bg is not None:
            frame = Image.alpha_composite(bg, frame)
        path = os.path.join(out_dir, f"{prefix}{idx + 1:05d}.png")
        # compress_level 1: this is a throwaway intermediate, speed over size.
        frame.save(path, format="PNG", compress_level=1)
        paths.append(path)
        frame.close()
        if on_frame is not None:
            on_frame(idx, path)

    if not paths:
        raise ValueError("empty animation")

    return {"width": meta["width"], "height": meta["height"], "fps": meta["fps"],
            "totalFrames": len(paths), "framePaths": paths}


def render_frame_at(svga_bytes, index=0):
    frame = None
    for i, f in enumerate(iter_render_frames(svga_bytes, max_frames=index + 1)):
        frame = f
        if i >= index:
            break
    meta = render_metadata(svga_bytes)
    return frame, meta["fps"], meta["width"], meta["height"]


# ---------------------------------------------------------------------------
# PNG asset optimization (best-of, never grows)
# ---------------------------------------------------------------------------
def _effective_colors(colors: int, quality: int) -> int:
    """Map the plan's quality knob onto a palette size.

    Pillow has no pngquant-style quality parameter, so quality is expressed as
    a colour budget: 100 keeps the requested palette, lower values shrink it.
    """
    q = max(0, min(100, int(quality)))
    return max(8, min(256, int(round(colors * (0.55 + 0.45 * q / 100)))))


def optimize_png_bytes(src: bytes, colors: int = 256, quality: int = 100,
                       compression_level: int = 9, allow_palette: bool = True) -> bytes:
    """Return the smallest of {original, lossless re-encode, palette PNG8}.

    The original is always a candidate, so an asset can never grow. Palette
    output stays PNG, which every native SVGA player decodes - unlike WebP,
    which the iOS player cannot read.
    """
    src = bytes(src)
    best = src
    try:
        with Image.open(io.BytesIO(src)) as probe:
            rgba = probe.convert("RGBA")
    except Exception:
        # Not an image (embedded audio) - leave untouched.
        return src

    try:
        buf = io.BytesIO()
        rgba.save(buf, format="PNG", optimize=True,
                  compress_level=max(0, min(9, compression_level)))
        candidate = buf.getvalue()
        if len(candidate) < len(best):
            best = candidate
    except Exception:
        return src

    if allow_palette:
        try:
            eff = _effective_colors(colors, quality)
            paletted = rgba.quantize(colors=eff, method=Image.Quantize.FASTOCTREE)
            buf = io.BytesIO()
            paletted.save(buf, format="PNG", optimize=True,
                          compress_level=max(0, min(9, compression_level)))
            candidate = buf.getvalue()
            if len(candidate) < len(best):
                best = candidate
        except Exception:
            pass

    return best


def _optimize_image_map(images: dict, options: dict) -> tuple[dict, int, int]:
    """Optimize an imageKey -> bytes map with bounded thread concurrency."""
    colors = int(options.get("colors", 256))
    quality = int(options.get("quality", 100))
    compression_level = int(options.get("compressionLevel", 9))
    allow_palette = options.get("losslessOnly") is not True and options.get("palette") is not False

    keys = list(images.keys())
    workers = max(2, min(8, (os.cpu_count() or 4)))
    result = dict(images)
    optimized = 0
    saved = 0

    def work(key):
        return key, optimize_png_bytes(images[key], colors, quality,
                                       compression_level, allow_palette)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for key, best in pool.map(work, keys):
            src_len = len(images[key])
            if len(best) < src_len:
                result[key] = best
                optimized += 1
                saved += src_len - len(best)

    return result, optimized, saved


# ---------------------------------------------------------------------------
# encode
# ---------------------------------------------------------------------------
_EMPTY_FRAME = b""


def _encode_frame_entity(alpha, layout, transform):
    fb = bytearray()
    fb += _tag(1, 5) + _wf32(alpha)
    lb = (_tag(1, 5) + _wf32(layout[0]) + _tag(2, 5) + _wf32(layout[1]) +
          _tag(3, 5) + _wf32(layout[2]) + _tag(4, 5) + _wf32(layout[3]))
    fb += _tag(2, 2) + _ld(bytes(lb))
    tb = (_tag(1, 5) + _wf32(transform[0]) + _tag(2, 5) + _wf32(transform[1]) +
          _tag(3, 5) + _wf32(transform[2]) + _tag(4, 5) + _wf32(transform[3]) +
          _tag(5, 5) + _wf32(transform[4]) + _tag(6, 5) + _wf32(transform[5]))
    fb += _tag(3, 2) + _ld(bytes(tb))
    return bytes(fb)


def _build_movie(width, height, fps, total_frames, images, sprites, audios=None):
    """Serialize a MovieEntity from an ordered image map + sprite list."""
    body = bytearray()
    body += _tag(1, 2) + _ld(b'2.0.0')

    p = bytearray()
    p += _tag(1, 5) + _wf32(width)
    p += _tag(2, 5) + _wf32(height)
    p += _tag(3, 0) + _varint(int(fps))
    p += _tag(4, 0) + _varint(int(total_frames))
    body += _tag(2, 2) + _ld(bytes(p))

    for k, v in images.items():
        entry = _tag(1, 2) + _ld(k.encode()) + _tag(2, 2) + _ld(bytes(v))
        body += _tag(3, 2) + _ld(entry)

    for sp in sprites:
        s = bytearray()
        s += _tag(1, 2) + _ld(sp['imageKey'].encode())
        for frame_bytes in sp['frames']:
            s += _tag(2, 2) + _ld(frame_bytes)
        body += _tag(4, 2) + _ld(bytes(s))

    for au in (audios or []):
        a = bytearray()
        a += _tag(1, 2) + _ld(au['audioKey'].encode())
        a += _tag(2, 0) + _varint(au.get('startFrame', 0))
        a += _tag(3, 0) + _varint(au.get('endFrame', 0))
        a += _tag(4, 0) + _varint(au.get('startTime', 0))
        a += _tag(5, 0) + _varint(au.get('totalTime', 0))
        body += _tag(5, 2) + _ld(bytes(a))

    return bytes(body)


def encode(frames, fps, max_size=None, max_frames=None, colors=256, quality=100,
           compression_level=9, palette=True, zlib_level=9, audio=None):
    """Build an image-sequence SVGA from PIL frames.

    Two structural wins over a naive encoder:
      * hidden frames are emitted as EMPTY FrameEntity messages (2 bytes each)
        instead of a full alpha+layout+transform record, and each sprite's frame
        list is truncated right after its visible frame. On a 150-frame sequence
        this drops roughly 1 MB of protobuf padding.
      * identical frames are stored once and shared by key, so looping or
        static passages cost nothing extra.
    """
    if not frames:
        raise ValueError("no frames")

    cap = max_frames or compression.MAX_ENCODE_FRAMES
    if len(frames) > cap:
        step = len(frames) / cap
        frames = [frames[int(i * step)] for i in range(cap)]

    def open_frame(item):
        """Frames may be PIL images or PNG paths; paths keep memory flat."""
        if isinstance(item, (str, os.PathLike)):
            with Image.open(item) as im:
                return im.convert('RGBA').copy()
        return item.convert('RGBA')

    first = open_frame(frames[0])
    w, h = first.size
    del first
    scale = 1.0
    if max_size and max(w, h) > max_size:
        scale = max_size / max(w, h)
        w = max(1, int(w * scale))
        h = max(1, int(h * scale))

    images: dict[str, bytes] = {}
    frame_keys: list[str] = []
    hash_to_key: dict[str, str] = {}

    for item in frames:
        im = open_frame(item)
        if scale != 1.0:
            im = im.resize((w, h), Image.LANCZOS)
        digest = hashlib.sha1(im.tobytes()).hexdigest()
        key = hash_to_key.get(digest)
        if key is None:
            buf = io.BytesIO()
            im.save(buf, format='PNG', optimize=True,
                    compress_level=max(0, min(9, compression_level)))
            payload = optimize_png_bytes(buf.getvalue(), colors=colors, quality=quality,
                                         compression_level=compression_level,
                                         allow_palette=palette)
            key = f"frame_{len(hash_to_key):04d}"
            hash_to_key[digest] = key
            images[key] = payload
        frame_keys.append(key)
        del im

    total = len(frame_keys)
    layout = [0.0, 0.0, float(w), float(h)]
    visible = _encode_frame_entity(1.0, layout, _IDENTITY)

    sprites = []
    for idx, key in enumerate(frame_keys):
        # idx empty placeholders to align the timeline, then the visible frame.
        sprites.append({
            'imageKey': key,
            'frames': [_EMPTY_FRAME] * idx + [visible],
        })

    audios = None
    if audio and audio.get('buffer') and audio.get('durationSec'):
        images['audio_track'] = audio['buffer']
        audios = [{
            'audioKey': 'audio_track',
            'startFrame': 0,
            'endFrame': total,
            'startTime': 0,
            'totalTime': int(round(audio['durationSec'] * 1000)),
        }]

    body = _build_movie(w, h, fps, total, images, sprites, audios)
    return zlib.compress(body, max(1, min(9, zlib_level)))


def encode_adaptive(frames, fps, target_bytes=5 * 1024 * 1024, tier="standard",
                    preset=None, max_size=None, audio=None):
    """Encode an image-sequence SVGA, stepping down the palette ladder to fit.

    Resolution is only reduced as a last resort, after the colour ladder is
    exhausted, because canvas changes are what users notice first.
    """
    tier = compression.normalize_tier(tier)
    profile = compression.get_video_optimization_profile(tier)
    base_size = max_size
    if base_size is None and preset:
        base_size = {"small": 480, "balanced": 540, "quality": 720}.get(preset)

    best = None
    for attempt in range(1, len(compression._SVGA_PLANS) + 1):
        plan = compression.get_one_mb_attempt_plan(
            "svga", attempt, {}, tier, {"targetBytes": target_bytes})
        data = encode(frames, fps,
                      max_size=base_size,
                      colors=plan["colors"],
                      quality=plan["quality"],
                      compression_level=profile["png"]["compressionLevel"],
                      palette=True,
                      zlib_level=9,
                      audio=audio)
        if best is None or len(data) < len(best):
            best = data
        if len(data) <= target_bytes:
            return data

    # Colour ladder exhausted: shrink the canvas in measured steps.
    if base_size:
        current = base_size
    elif isinstance(frames[0], (str, os.PathLike)):
        with Image.open(frames[0]) as probe:
            current = max(probe.size)
    else:
        current = max(frames[0].size)
    for ratio in (0.9, 0.8, 0.7, 0.6):
        current = max(280, int(current * ratio))
        data = encode(frames, fps, max_size=current, colors=96, quality=40,
                      compression_level=9, palette=True, zlib_level=9, audio=audio)
        if len(data) < len(best):
            best = data
        if len(data) <= target_bytes:
            return data

    return best


# ---------------------------------------------------------------------------
# in-place recompression (structure preserved byte-for-byte)
# ---------------------------------------------------------------------------
def _rewrite_sprite_image_key(sprite_bytes: bytes, new_key: str) -> bytes:
    """Replace only field 1 (imageKey); every other field is copied verbatim."""
    out = bytearray()
    replaced = False
    for fn, wt, val in _iter_fields(sprite_bytes):
        if fn == 1 and wt == 2 and not replaced:
            out += _tag(1, 2) + _ld(new_key.encode())
            replaced = True
        else:
            out += _emit(fn, wt, val)
    return bytes(out) if replaced else sprite_bytes


def _sprite_image_key(sprite_bytes: bytes) -> str:
    for fn, wt, val in _iter_fields(sprite_bytes):
        if fn == 1 and wt == 2:
            return val.decode("utf-8", "ignore")
    return ""


def _audio_key(audio_bytes: bytes) -> str:
    for fn, wt, val in _iter_fields(audio_bytes):
        if fn == 1 and wt == 2:
            return val.decode("utf-8", "ignore")
    return ""


def optimize_svga_direct(svga_bytes: bytes, options: dict | None = None) -> bytes:
    """Recompress an existing .svga without altering its animation.

    Everything except the embedded image blobs is re-emitted from the original
    wire bytes, so sprites, frames, transforms, layouts, clipPath, matteKey,
    vector shapes and audio survive exactly. That matters: a decode -> re-encode
    round-trip through a protobuf library fills empty frames with default
    sub-messages, which native players read as "draw at zero scale" instead of
    "not present", and playback breaks.

    Passes, in order:
      1. drop image assets no sprite or audio track references
      2. deduplicate byte-identical assets and repoint sprites at the survivor
      3. re-encode every asset to the smallest of {original, lossless, palette}
    """
    options = options or {}
    raw = _inflate(svga_bytes)
    fields = list(_iter_fields(raw))

    # ---- collect the image map and the sprite/audio references -------------
    image_entries = []   # (index_in_fields, key, value_bytes, extra_fields)
    for pos, (fn, wt, val) in enumerate(fields):
        if fn != 3 or wt != 2:
            continue
        key, value, extra = None, None, []
        for efn, ewt, eval_ in _iter_fields(val):
            if efn == 1 and ewt == 2:
                key = eval_.decode("utf-8", "ignore")
            elif efn == 2 and ewt == 2:
                value = eval_
            else:
                extra.append((efn, ewt, eval_))
        if key is not None and value is not None:
            image_entries.append([pos, key, value, extra])

    referenced = set()
    for fn, wt, val in fields:
        if fn == 4 and wt == 2:
            k = _sprite_image_key(val)
            if k:
                referenced.add(k)
        elif fn == 5 and wt == 2:
            k = _audio_key(val)
            if k:
                referenced.add(k)

    # ---- pass 1: unused assets --------------------------------------------
    removed_unused = 0
    if options.get("removeUnusedAssets") and referenced:
        kept = []
        for entry in image_entries:
            if entry[1] in referenced:
                kept.append(entry)
            else:
                removed_unused += 1
        image_entries = kept

    # ---- pass 2: byte-identical duplicates -------------------------------
    key_remap: dict[str, str] = {}
    deduped = 0
    if options.get("dedupeAssets") is not False:
        hash_to_key: dict[str, str] = {}
        kept = []
        for entry in image_entries:
            digest = hashlib.sha1(entry[2]).hexdigest()
            canonical = hash_to_key.get(digest)
            if canonical is not None:
                key_remap[entry[1]] = canonical
                deduped += 1
                continue
            hash_to_key[digest] = entry[1]
            kept.append(entry)
        image_entries = kept

    # ---- pass 3: asset re-encode -----------------------------------------
    optimized_count = 0
    saved_bytes = 0
    if not options.get("skipImageOptimization"):
        image_map = {entry[1]: entry[2] for entry in image_entries}
        optimized_map, optimized_count, saved_bytes = _optimize_image_map(image_map, options)
        for entry in image_entries:
            entry[2] = optimized_map[entry[1]]

    replacements = {entry[0]: entry for entry in image_entries}

    # ---- re-emit ---------------------------------------------------------
    out = bytearray()
    for pos, (fn, wt, val) in enumerate(fields):
        if fn == 3 and wt == 2:
            entry = replacements.get(pos)
            if entry is None:
                continue  # removed or deduplicated away
            body = bytearray()
            body += _tag(1, 2) + _ld(entry[1].encode())
            body += _tag(2, 2) + _ld(entry[2])
            for efn, ewt, eval_ in entry[3]:
                body += _emit(efn, ewt, eval_)
            out += _tag(3, 2) + _ld(bytes(body))
        elif fn == 4 and wt == 2 and key_remap:
            current = _sprite_image_key(val)
            target = key_remap.get(current)
            out += _emit(4, 2, _rewrite_sprite_image_key(val, target) if target else val)
        else:
            out += _emit(fn, wt, val)

    result = zlib.compress(bytes(out), max(1, min(9, int(options.get("zlibLevel", 9)))))

    if len(result) >= len(svga_bytes) and not options.get("allowGrowth"):
        # Nothing gained: hand back the original rather than a larger file.
        return bytes(svga_bytes)

    return result


def optimize_svga_to_target(svga_bytes: bytes, target_bytes: int, tier: str = "standard",
                            metadata: dict | None = None) -> tuple[bytes, list]:
    """Walk the SVGA palette ladder until the file fits target_bytes.

    Mirrors the Node route's loop, including the plateau and far-from-target
    early stops, so a hopeless job does not burn eight full passes.
    """
    tier = compression.normalize_tier(tier)
    attempts = []
    best = bytes(svga_bytes)
    previous_size = None
    max_attempts = compression.get_max_attempts("svga", True, {"targetBytes": target_bytes})

    # Structural passes are lossless and palette-independent: run them once.
    structural = optimize_svga_direct(svga_bytes, {
        "removeUnusedAssets": True,
        "dedupeAssets": True,
        "skipImageOptimization": True,
        "zlibLevel": 9,
    })
    if len(structural) < len(best):
        best = structural

    for attempt in range(1, max_attempts + 1):
        plan = compression.get_one_mb_attempt_plan(
            "svga", attempt, metadata or {}, tier,
            {"targetBytes": target_bytes, "sourceSizeBytes": len(svga_bytes)})
        plan["removeUnusedAssets"] = False
        plan["dedupeAssets"] = False

        candidate = optimize_svga_direct(structural, plan)
        attempts.append({
            "attempt": attempt,
            "sizeBytes": len(candidate),
            "sizeMB": round(len(candidate) / (1024 * 1024), 2),
            "colors": plan.get("colors"),
            "quality": plan.get("quality"),
        })
        if len(candidate) < len(best):
            best = candidate
        if len(candidate) <= target_bytes:
            return candidate, attempts

        if previous_size:
            improvement = (previous_size - len(candidate)) / max(1, previous_size)
            if attempt >= 3 and len(candidate) > target_bytes * 10 and improvement < 0.08:
                break
            if attempt >= 4 and improvement < 0.03:
                break
        previous_size = len(candidate)

    return best, attempts
