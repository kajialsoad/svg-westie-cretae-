"""Read animated-WebP timing straight from the container instead of trusting Pillow."""
import os
import re
import struct
import subprocess
import tempfile

from PIL import Image, ImageDraw

from media import FFMPEG


def webp_anim_timing(path):
    """Parse ANMF chunk durations out of the RIFF container. Authoritative."""
    data = open(path, "rb").read()
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", "not a webp"
    pos = 12
    durations = []
    loop_count = None
    while pos + 8 <= len(data):
        fourcc = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if fourcc == b"ANIM" and len(body) >= 6:
            loop_count = struct.unpack("<H", body[4:6])[0]
        elif fourcc == b"ANMF" and len(body) >= 16:
            # 24-bit little-endian frame duration in ms at offset 12
            durations.append(body[12] | (body[13] << 8) | (body[14] << 16))
        pos += 8 + size + (size & 1)
    return len(durations), sum(durations), durations[:6], loop_count


def ffmpeg_duration(path):
    p = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True)
    txt = p.stderr.decode("utf-8", "ignore")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", txt)
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


FPS = 30
N = 30
tmp = tempfile.mkdtemp()
for i in range(N):
    im = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([i * 2, 0, i * 2 + 20, 40], fill=(255, i * 8 % 255, 0, 255))
    im.save(os.path.join(tmp, f"f_{i + 1:05d}.png"))
pat = os.path.join(tmp, "f_%05d.png")

print(f"expected: {N} frames, {N / FPS * 1000:.0f} ms, {1000 / FPS:.2f} ms/frame\n")

variants = {
    "no -r": ["-framerate", str(FPS), "-i", pat, "-vcodec", "libwebp_anim",
              "-quality", "80", "-loop", "0", "-an", "-pix_fmt", "bgra"],
    "-r 30": ["-framerate", str(FPS), "-i", pat, "-vcodec", "libwebp_anim",
              "-quality", "80", "-loop", "0", "-an", "-r", str(FPS), "-pix_fmt", "bgra"],
    "-r 30 no pixfmt": ["-framerate", str(FPS), "-i", pat, "-vcodec", "libwebp_anim",
                        "-quality", "80", "-loop", "0", "-an", "-r", str(FPS)],
}
for name, args in variants.items():
    out = os.path.join(tmp, re.sub(r"\W+", "_", name) + ".webp")
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-y"] + args + [out],
                       capture_output=True)
    if p.returncode != 0:
        print(f"{name:18s} FAILED")
        continue
    n, total, per, loop = webp_anim_timing(out)
    print(f"{name:18s} ANMF n={n:3d} total={total:5d}ms per={per} loop={loop} "
          f"ffmpegDur={ffmpeg_duration(out)}s")
