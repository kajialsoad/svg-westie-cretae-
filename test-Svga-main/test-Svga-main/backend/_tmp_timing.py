"""Find why libwebp_anim writes the wrong frame durations."""
import io
import os
import subprocess
import tempfile

from PIL import Image, ImageDraw

from media import FFMPEG

FPS = 30
N = 30  # exactly 1000 ms at 30 fps


def durations(path):
    with Image.open(path) as im:
        total = 0
        per = []
        for i in range(im.n_frames):
            im.seek(i)
            dur = im.info.get("duration", 0)
            per.append(dur)
            total += dur
        return im.n_frames, total, per[:6]


tmp = tempfile.mkdtemp()
for i in range(N):
    im = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([i * 2, 0, i * 2 + 20, 40], fill=(255, i * 8 % 255, 0, 255))
    im.save(os.path.join(tmp, f"f_{i + 1:05d}.png"))
pat = os.path.join(tmp, "f_%05d.png")

variants = {
    "current (no -r)": ["-framerate", str(FPS), "-i", pat,
                        "-vcodec", "libwebp_anim", "-preset", "drawing",
                        "-lossless", "0", "-quality", "80", "-loop", "0", "-an",
                        "-pix_fmt", "bgra"],
    "with output -r": ["-framerate", str(FPS), "-i", pat,
                       "-vcodec", "libwebp_anim", "-preset", "drawing",
                       "-lossless", "0", "-quality", "80", "-loop", "0", "-an",
                       "-r", str(FPS), "-pix_fmt", "bgra"],
    "with -fps_mode cfr": ["-framerate", str(FPS), "-i", pat,
                           "-vcodec", "libwebp_anim", "-preset", "drawing",
                           "-lossless", "0", "-quality", "80", "-loop", "0", "-an",
                           "-fps_mode", "cfr", "-r", str(FPS), "-pix_fmt", "bgra"],
    "no threads0 + -r": ["-framerate", str(FPS), "-i", pat,
                         "-vcodec", "libwebp_anim", "-quality", "80",
                         "-loop", "0", "-an", "-r", str(FPS)],
    "threads 0 + -r": ["-threads", "0", "-framerate", str(FPS), "-i", pat,
                       "-vcodec", "libwebp_anim", "-quality", "80",
                       "-loop", "0", "-an", "-r", str(FPS)],
}

print(f"expected: {N} frames, {N / FPS * 1000:.0f} ms total, "
      f"{1000 / FPS:.1f} ms per frame\n")

for name, args in variants.items():
    out = os.path.join(tmp, name.replace(" ", "_").replace("(", "").replace(")", "") + ".webp")
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-y"] + args + [out],
                       capture_output=True)
    if p.returncode != 0:
        print(f"{name:22s} FAILED: {p.stderr.decode('utf-8', 'ignore')[-200:]}")
        continue
    n, total, per = durations(out)
    print(f"{name:22s} n={n:3d} total={total:6d} ms  per={per}  "
          f"bytes={os.path.getsize(out)}")
