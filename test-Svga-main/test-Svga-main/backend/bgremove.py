"""Background removal for images and video using rembg (U2-Net, offline)."""
import io
import os
import tempfile
import subprocess
from PIL import Image
from rembg import remove, new_session

from media import FFMPEG

_session = None


def _sess():
    global _session
    if _session is None:
        _session = new_session("u2net")
    return _session


def _hex_to_rgb(c):
    c = (c or "#FFFFFF").lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    try:
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return (255, 255, 255)


def _cut(img):
    return remove(img.convert("RGBA"), session=_sess()).convert("RGBA")


def _apply_bg(cut, mode, color, bg_img):
    """cut: RGBA foreground. Returns RGBA composited result."""
    w, h = cut.size
    if mode == "color":
        base = Image.new("RGBA", (w, h), _hex_to_rgb(color) + (255,))
        return Image.alpha_composite(base, cut)
    if mode == "image" and bg_img is not None:
        bg = bg_img.convert("RGBA")
        bw, bh = bg.size
        scale = max(w / bw, h / bh)
        bg = bg.resize((max(1, int(bw * scale)), max(1, int(bh * scale))), Image.LANCZOS)
        bx = (bg.size[0] - w) // 2
        by = (bg.size[1] - h) // 2
        bg = bg.crop((bx, by, bx + w, by + h))
        return Image.alpha_composite(bg, cut)
    return cut


def remove_image(data, mode="transparent", color="#FFFFFF", bg_bytes=None):
    img = Image.open(io.BytesIO(data))
    cut = _cut(img)
    bg_img = Image.open(io.BytesIO(bg_bytes)) if bg_bytes else None
    result = _apply_bg(cut, mode, color, bg_img)
    out = io.BytesIO()
    if mode == "transparent":
        result.save(out, format="PNG")
        return out.getvalue(), "png", "image/png"
    result.convert("RGB").save(out, format="PNG")
    return out.getvalue(), "png", "image/png"


def remove_video(data, ext="mp4", mode="transparent", color="#FFFFFF", bg_bytes=None,
                 fps=12, max_dim=480, max_frames=120):
    bg_img = Image.open(io.BytesIO(bg_bytes)) if bg_bytes else None
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, f"in.{ext}")
        with open(src, "wb") as f:
            f.write(data)
        raw_dir = os.path.join(tmp, "raw")
        cut_dir = os.path.join(tmp, "cut")
        os.makedirs(raw_dir)
        os.makedirs(cut_dir)
        subprocess.run(
            [FFMPEG, "-y", "-i", src, "-vf", f"fps={fps},scale='min({max_dim},iw)':-2",
             os.path.join(raw_dir, "f_%05d.png")],
            capture_output=True, timeout=110,
        )
        files = sorted(f for f in os.listdir(raw_dir) if f.startswith("f_"))[:max_frames]
        if not files:
            raise ValueError("Could not read video frames")
        for fn in files:
            frame = Image.open(os.path.join(raw_dir, fn))
            cut = _cut(frame)
            result = _apply_bg(cut, mode, color, bg_img)
            result.save(os.path.join(cut_dir, fn))

        if mode == "transparent":
            out_path = os.path.join(tmp, "out.webm")
            subprocess.run(
                [FFMPEG, "-y", "-framerate", str(fps), "-i", os.path.join(cut_dir, "f_%05d.png"),
                 "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "1M", out_path],
                capture_output=True, timeout=115,
            )
            with open(out_path, "rb") as f:
                return f.read(), "webm", "video/webm"
        out_path = os.path.join(tmp, "out.mp4")
        subprocess.run(
            [FFMPEG, "-y", "-framerate", str(fps), "-i", os.path.join(cut_dir, "f_%05d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", out_path],
            capture_output=True, timeout=115,
        )
        with open(out_path, "rb") as f:
            return f.read(), "mp4", "video/mp4"
