"""Pure-python SVGA 2.x codec: decode (protobuf + zlib), render frames (PIL), and encode."""
import struct
import zlib
import io
import base64
from PIL import Image


# ---------- low level protobuf ----------
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


def _parse_fields(buf):
    pos = 0
    n = len(buf)
    fields = {}
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


# ---------- decode ----------
def decode(svga_bytes):
    raw = zlib.decompress(svga_bytes)
    fields = _parse_fields(raw)
    version = fields[1][0][1].decode('utf-8', 'ignore') if 1 in fields else '2.0.0'
    w = h = 0
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
            key = e[1][0][1].decode('utf-8', 'ignore')
            images[key] = e[2][0][1]

    sprites = []
    for _wt, val in fields.get(4, []):
        sp = _parse_fields(val)
        image_key = sp[1][0][1].decode('utf-8', 'ignore') if 1 in sp else ''
        frames = []
        for _fwt, fval in sp.get(2, []):
            fr = _parse_fields(fval)
            alpha = _f32(fr[1][0][1]) if 1 in fr else 1.0
            transform = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
            if 3 in fr:
                t = _parse_fields(fr[3][0][1])
                defaults = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
                transform = [_f32(t[i][0][1]) if i in t else defaults[i - 1] for i in range(1, 7)]
            layout = None
            if 2 in fr:
                ld = _parse_fields(fr[2][0][1])
                layout = [_f32(ld[i][0][1]) if i in ld else 0.0 for i in range(1, 5)]
            frames.append({'alpha': alpha, 'transform': transform, 'layout': layout})
        sprites.append({'imageKey': image_key, 'frames': frames})

    return {
        'version': version,
        'width': w,
        'height': h,
        'fps': fps,
        'frames': nframes,
        'images': images,
        'sprites': sprites,
    }


def info(svga_bytes):
    d = decode(svga_bytes)
    duration = round(d['frames'] / d['fps'], 2) if d['fps'] else 0
    return {
        'version': d['version'],
        'width': round(d['width']),
        'height': round(d['height']),
        'fps': d['fps'],
        'frames': d['frames'],
        'duration': duration,
        'assets': len(d['images']),
        'sprites': len(d['sprites']),
    }


# ---------- render ----------
def render_frames(svga_bytes, max_frames=600, overrides=None):
    d = decode(svga_bytes)
    w = max(1, round(d['width']))
    h = max(1, round(d['height']))
    pil_images = {}
    for k, raw in d['images'].items():
        try:
            pil_images[k] = Image.open(io.BytesIO(raw)).convert('RGBA')
        except Exception:
            pass

    nframes = min(d['frames'], max_frames) if d['frames'] else 0
    sprites = d['sprites']
    order = list(range(len(sprites)))
    if overrides:
        order.sort(key=lambda idx: overrides.get(idx, {}).get('order', idx))
    out = []
    for i in range(nframes):
        canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        for si in order:
            sp = sprites[si]
            if i >= len(sp['frames']):
                continue
            fr = sp['frames'][i]
            ov = overrides.get(si) if overrides else None
            if ov and not ov.get('visible', True):
                continue
            alpha = fr['alpha'] * (float(ov.get('opacity', 1.0)) if ov else 1.0)
            if alpha <= 0.001:
                continue
            img = pil_images.get(sp['imageKey'])
            if img is None:
                continue
            a, b, c, dd, tx, ty = fr['transform']
            if ov:
                s = float(ov.get('scale', 1.0))
                dx = float(ov.get('dx', 0.0))
                dy = float(ov.get('dy', 0.0))
                a, b, c, dd = a * s, b * s, c * s, dd * s
                tx = tx * s + dx
                ty = ty * s + dy
            det = a * dd - b * c
            if abs(det) < 1e-9:
                continue
            coeffs = (
                dd / det, -c / det, (-dd * tx + c * ty) / det,
                -b / det, a / det, (b * tx - a * ty) / det,
            )
            try:
                layer = img.transform((w, h), Image.AFFINE, coeffs, resample=Image.BILINEAR)
            except Exception:
                continue
            if alpha < 0.999:
                r, g, bl, al = layer.split()
                al = al.point(lambda p: int(p * alpha))
                layer = Image.merge('RGBA', (r, g, bl, al))
            canvas = Image.alpha_composite(canvas, layer)
        out.append(canvas)
    return out, d['fps'], w, h


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
                       "visibleFrames": visible, "frameCount": len(sp['frames'])})
    return {"width": round(d['width']), "height": round(d['height']), "fps": d['fps'],
            "frames": d['frames'], "layerCount": len(d['sprites']), "layers": result}


# ---------- encode ----------
def encode(frames, fps, max_size=750, max_frames=150, img_format="png", quality=90):
    """frames: list of PIL.Image (RGBA). Builds an image-sequence SVGA."""
    if not frames:
        raise ValueError("no frames")
    if len(frames) > max_frames:
        step = len(frames) / max_frames
        frames = [frames[int(i * step)] for i in range(max_frames)]

    base = frames[0]
    w, h = base.size
    scale = 1.0
    if max(w, h) > max_size:
        scale = max_size / max(w, h)
        w = max(1, int(w * scale))
        h = max(1, int(h * scale))

    images = {}
    sprites = []
    n = len(frames)
    for idx, fr in enumerate(frames):
        im = fr.convert('RGBA')
        if scale != 1.0:
            im = im.resize((w, h), Image.LANCZOS)
        buf = io.BytesIO()
        if img_format == "webp":
            im.save(buf, format='WEBP', quality=int(quality), method=4)
        else:
            im.save(buf, format='PNG', optimize=True)
        key = f"frame_{idx:04d}"
        images[key] = buf.getvalue()
        sf = []
        for j in range(n):
            sf.append({'alpha': 1.0 if j == idx else 0.0,
                       'transform': [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                       'layout': [0.0, 0.0, float(w), float(h)]})
        sprites.append({'imageKey': key, 'frames': sf})

    body = bytearray()
    body += _tag(1, 2) + _ld(b'2.0.0')
    p = bytearray()
    p += _tag(1, 5) + _wf32(w)
    p += _tag(2, 5) + _wf32(h)
    p += _tag(3, 0) + _varint(fps)
    p += _tag(4, 0) + _varint(n)
    body += _tag(2, 2) + _ld(bytes(p))
    for k, v in images.items():
        entry = _tag(1, 2) + _ld(k.encode()) + _tag(2, 2) + _ld(v)
        body += _tag(3, 2) + _ld(bytes(entry))
    for sp in sprites:
        s = bytearray()
        s += _tag(1, 2) + _ld(sp['imageKey'].encode())
        for f in sp['frames']:
            fb = bytearray()
            fb += _tag(1, 5) + _wf32(f['alpha'])
            lay = f['layout']
            lb = _tag(1, 5) + _wf32(lay[0]) + _tag(2, 5) + _wf32(lay[1]) + _tag(3, 5) + _wf32(lay[2]) + _tag(4, 5) + _wf32(lay[3])
            fb += _tag(2, 2) + _ld(lb)
            t = f['transform']
            tb = (_tag(1, 5) + _wf32(t[0]) + _tag(2, 5) + _wf32(t[1]) + _tag(3, 5) + _wf32(t[2]) +
                  _tag(4, 5) + _wf32(t[3]) + _tag(5, 5) + _wf32(t[4]) + _tag(6, 5) + _wf32(t[5]))
            fb += _tag(3, 2) + _ld(tb)
            s += _tag(2, 2) + _ld(bytes(fb))
        body += _tag(4, 2) + _ld(bytes(s))

    return zlib.compress(bytes(body), 9)


def encode_adaptive(frames, fps, target_bytes=5 * 1024 * 1024, preset="balanced"):
    """Encode an image-sequence SVGA, auto-reducing size/quality to fit target_bytes."""
    cfgs = {"small": (480, 68), "balanced": (540, 80), "quality": (720, 90)}
    size, q = cfgs.get(preset, cfgs["balanced"])
    n = len(frames)
    data = encode(frames, fps, max_size=size, max_frames=n, img_format="webp", quality=q)
    attempts = 0
    while len(data) > target_bytes and attempts < 5:
        ratio = target_bytes / len(data)
        size = max(280, int(size * (ratio ** 0.5) * 0.95))
        q = max(45, int(q * (ratio ** 0.25)))
        data = encode(frames, fps, max_size=size, max_frames=n, img_format="webp", quality=q)
        attempts += 1
    return data
