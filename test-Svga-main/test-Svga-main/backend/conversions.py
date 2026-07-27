"""Format conversions between SVGA and GIF/MP4/WebP/PNG/Lottie/JSON using ffmpeg + Pillow."""
import io
import os
import json
import zipfile
import tempfile
import subprocess
from PIL import Image, ImageSequence

import svga_codec
from media import FFMPEG


def _frames_from_animated_image(data):
    im = Image.open(io.BytesIO(data))
    frames = [f.convert('RGBA').copy() for f in ImageSequence.Iterator(im)]
    fps = 20
    try:
        dur = im.info.get('duration', 50) or 50
        fps = max(1, min(60, round(1000 / dur)))
    except Exception:
        pass
    return frames, fps


def _frames_from_video(data, ext, fps=20, max_dim=750):
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, f"in.{ext}")
        with open(src, 'wb') as f:
            f.write(data)
        outpat = os.path.join(tmp, "f_%05d.png")
        subprocess.run(
            [FFMPEG, "-y", "-i", src, "-vf", f"fps={fps},scale='min({max_dim},iw)':-2", outpat],
            capture_output=True, timeout=115,
        )
        files = sorted(f for f in os.listdir(tmp) if f.startswith("f_"))
        frames = [Image.open(os.path.join(tmp, f)).convert('RGBA').copy() for f in files]
    return frames, fps


# ---------- to SVGA ----------
def gif_to_svga(data):
    frames, fps = _frames_from_animated_image(data)
    return svga_codec.encode(frames, fps)


def webp_to_svga(data):
    frames, fps = _frames_from_animated_image(data)
    return svga_codec.encode(frames, fps)


def mp4_to_svga(data, ext="mp4"):
    frames, fps = _frames_from_video(data, ext)
    return svga_codec.encode(frames, fps)


PRESET_FPS = {"small": 12, "balanced": 15, "quality": 20}
PRESET_DIM = {"small": 480, "balanced": 540, "quality": 720}


def mp4_to_svga_advanced(data, ext="mp4", remove_bg=False, preset="balanced"):
    """Extract at a preset fps/scale, optionally remove background per-frame,
    then adaptively encode to stay under 5MB."""
    fps = PRESET_FPS.get(preset, 15)
    max_dim = PRESET_DIM.get(preset, 540)
    frames, _ = _frames_from_video(data, ext, fps=fps, max_dim=max_dim)
    if not frames:
        raise ValueError("Could not read video frames")
    frames = frames[:225]  # ~15s @ 15fps
    if remove_bg:
        from bgremove import _cut
        frames = [_cut(f) for f in frames]
    svga = svga_codec.encode_adaptive(frames, fps, target_bytes=5 * 1024 * 1024, preset=preset)
    return svga, "svga", "application/octet-stream"


# ---------- alpha video helpers ----------
def _enc_alpha_webm(frames, fps, w, h):
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames):
            f.save(os.path.join(tmp, f"f_{i:05d}.png"))
        out_path = os.path.join(tmp, "out.webm")
        subprocess.run(
            [FFMPEG, "-y", "-framerate", str(max(1, fps)), "-i", os.path.join(tmp, "f_%05d.png"),
             "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "2M", out_path],
            capture_output=True, timeout=115,
        )
        with open(out_path, 'rb') as f:
            return f.read()


def _enc_alpha_mov(frames, fps, w, h):
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames):
            f.save(os.path.join(tmp, f"f_{i:05d}.png"))
        out_path = os.path.join(tmp, "out.mov")
        subprocess.run(
            [FFMPEG, "-y", "-framerate", str(max(1, fps)), "-i", os.path.join(tmp, "f_%05d.png"),
             "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", out_path],
            capture_output=True, timeout=115,
        )
        with open(out_path, 'rb') as f:
            return f.read()


def svga_to_alpha_webm(data):
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    return _enc_alpha_webm(frames, fps, w, h)


def svga_to_alpha_mov(data):
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    return _enc_alpha_mov(frames, fps, w, h)


# ---------- from SVGA ----------
def svga_to_gif(data):
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    bg = [Image.new('RGBA', (w, h), (255, 255, 255, 255)) for _ in frames]
    flat = [Image.alpha_composite(b, f).convert('P', palette=Image.ADAPTIVE) for b, f in zip(bg, frames)]
    out = io.BytesIO()
    flat[0].save(out, format='GIF', save_all=True, append_images=flat[1:],
                 duration=int(1000 / max(1, fps)), loop=0, disposal=2)
    return out.getvalue()


def svga_to_webp(data):
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    out = io.BytesIO()
    frames[0].save(out, format='WEBP', save_all=True, append_images=frames[1:],
                   duration=int(1000 / max(1, fps)), loop=0)
    return out.getvalue()


def svga_to_mp4(data):
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames):
            bg = Image.new('RGB', (w, h), (255, 255, 255))
            bg.paste(f, (0, 0), f)
            bg.save(os.path.join(tmp, f"f_{i:05d}.png"))
        out_path = os.path.join(tmp, "out.mp4")
        subprocess.run(
            [FFMPEG, "-y", "-framerate", str(max(1, fps)), "-i", os.path.join(tmp, "f_%05d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
             out_path],
            capture_output=True, timeout=110,
        )
        with open(out_path, 'rb') as f:
            return f.read()


def svga_to_png(data):
    """Returns a zip of all PNG frames."""
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for i, f in enumerate(frames):
            b = io.BytesIO()
            f.save(b, format='PNG')
            zf.writestr(f"frame_{i:05d}.png", b.getvalue())
    return out.getvalue()


def svga_to_json(data):
    d = svga_codec.decode(data)
    out = {
        'version': d['version'],
        'params': {'viewBoxWidth': d['width'], 'viewBoxHeight': d['height'],
                   'fps': d['fps'], 'frames': d['frames']},
        'images': list(d['images'].keys()),
        'sprites': [{'imageKey': s['imageKey'], 'frameCount': len(s['frames'])} for s in d['sprites']],
    }
    return json.dumps(out, indent=2).encode('utf-8')


def svga_to_lottie(data):
    frames, fps, w, h = svga_codec.render_frames(data)
    if not frames:
        raise ValueError("empty animation")
    import base64
    assets = []
    layers = []
    for i, f in enumerate(frames):
        b = io.BytesIO()
        f.save(b, format='PNG')
        enc = base64.b64encode(b.getvalue()).decode()
        aid = f"image_{i}"
        assets.append({"id": aid, "w": w, "h": h, "u": "", "p": f"data:image/png;base64,{enc}", "e": 1})
        layers.append({
            "ddd": 0, "ind": i + 1, "ty": 2, "nm": f"frame_{i}", "refId": aid,
            "ks": {"o": {"a": 0, "k": 100}, "p": {"a": 0, "k": [w / 2, h / 2, 0]},
                   "a": {"a": 0, "k": [w / 2, h / 2, 0]}, "s": {"a": 0, "k": [100, 100, 100]}},
            "ip": i, "op": i + 1, "st": i, "bm": 0,
        })
    lottie = {
        "v": "5.7.0", "fr": fps, "ip": 0, "op": len(frames), "w": w, "h": h,
        "nm": "SVGA Export", "ddd": 0, "assets": assets, "layers": layers,
    }
    return json.dumps(lottie).encode('utf-8')


def _enc_gif(frames, fps, w, h):
    bg = [Image.new('RGBA', (w, h), (255, 255, 255, 255)) for _ in frames]
    flat = [Image.alpha_composite(b, f).convert('P', palette=Image.ADAPTIVE) for b, f in zip(bg, frames)]
    out = io.BytesIO()
    flat[0].save(out, format='GIF', save_all=True, append_images=flat[1:],
                 duration=int(1000 / max(1, fps)), loop=0, disposal=2)
    return out.getvalue()


def _enc_webp(frames, fps):
    out = io.BytesIO()
    frames[0].save(out, format='WEBP', save_all=True, append_images=frames[1:],
                   duration=int(1000 / max(1, fps)), loop=0)
    return out.getvalue()


def _enc_mp4(frames, fps, w, h):
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames):
            b = Image.new('RGB', (w, h), (255, 255, 255))
            b.paste(f, (0, 0), f)
            b.save(os.path.join(tmp, f"f_{i:05d}.png"))
        out_path = os.path.join(tmp, "out.mp4")
        subprocess.run(
            [FFMPEG, "-y", "-framerate", str(max(1, fps)), "-i", os.path.join(tmp, "f_%05d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", out_path],
            capture_output=True, timeout=115,
        )
        with open(out_path, 'rb') as f:
            return f.read()


def _enc_png_zip(frames):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for i, f in enumerate(frames):
            b = io.BytesIO()
            f.save(b, format='PNG')
            zf.writestr(f"frame_{i:05d}.png", b.getvalue())
    return out.getvalue()


EXPORT_TARGETS = {
    "gif": ("gif", "image/gif"),
    "mp4": ("mp4", "video/mp4"),
    "webp": ("webp", "image/webp"),
    "png": ("zip", "application/zip"),
    "alpha-webm": ("webm", "video/webm"),
    "alpha-mov": ("mov", "video/quicktime"),
    "svga": ("svga", "application/octet-stream"),
}


def svga_export(data, edits, target):
    """Render an SVGA with per-layer edits applied, then export to target format."""
    overrides = None
    if edits:
        overrides = {int(k): v for k, v in edits.items()}
    if target not in EXPORT_TARGETS:
        raise ValueError("Unsupported export target")
    ext, mime = EXPORT_TARGETS[target]

    if target == "svga":
        # re-emit an image-sequence SVGA of the edited composite
        frames, fps, w, h = svga_codec.render_frames(data, overrides=overrides)
        if not frames:
            raise ValueError("empty animation")
        return svga_codec.encode_adaptive(frames, fps), ext, mime

    frames, fps, w, h = svga_codec.render_frames(data, overrides=overrides)
    if not frames:
        raise ValueError("empty animation")
    if target == "gif":
        out = _enc_gif(frames, fps, w, h)
    elif target == "webp":
        out = _enc_webp(frames, fps)
    elif target == "mp4":
        out = _enc_mp4(frames, fps, w, h)
    elif target == "png":
        out = _enc_png_zip(frames)
    elif target == "alpha-webm":
        out = _enc_alpha_webm(frames, fps, w, h)
    elif target == "alpha-mov":
        out = _enc_alpha_mov(frames, fps, w, h)
    return out, ext, mime


CONVERSIONS = {
    "gif-to-svga": (gif_to_svga, "svga", "application/octet-stream"),
    "webp-to-svga": (webp_to_svga, "svga", "application/octet-stream"),
    "mp4-to-svga": (mp4_to_svga, "svga", "application/octet-stream"),
    "svga-to-gif": (svga_to_gif, "gif", "image/gif"),
    "svga-to-mp4": (svga_to_mp4, "mp4", "video/mp4"),
    "svga-to-png": (svga_to_png, "zip", "application/zip"),
    "svga-to-webp": (svga_to_webp, "webp", "image/webp"),
    "svga-to-alpha-webm": (svga_to_alpha_webm, "webm", "video/webm"),
    "svga-to-alpha-mov": (svga_to_alpha_mov, "mov", "video/quicktime"),
    "svga-to-lottie": (svga_to_lottie, "json", "application/json"),
    "svga-to-json": (svga_to_json, "json", "application/json"),
}


def convert(kind, data, src_ext="mp4"):
    fn, out_ext, mime = CONVERSIONS[kind]
    if kind == "mp4-to-svga":
        result = fn(data, src_ext)
    else:
        result = fn(data)
    return result, out_ext, mime
