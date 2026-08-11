"""Temporary end-to-end verification of the upgraded pipeline."""
import io
import math
import time

import numpy as np
from PIL import Image, ImageDraw

import compression
import conversions
import svga_codec


def make_frames(n=60, w=300, h=300):
    frames = []
    for i in range(n):
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        t = i / n * 2 * math.pi
        cx = w / 2 + 70 * math.cos(t)
        cy = h / 2 + 70 * math.sin(t)
        d.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=(255, 90, 40, 220))
        d.rectangle([10, 10, 60, 60], fill=(30, 200, 255, 160))
        frames.append(im)
    return frames


frames = make_frames()
t0 = time.time()
svga = svga_codec.encode(frames, 24)
print(f"encode: {len(svga)} bytes for {len(frames)} frames in {time.time()-t0:.2f}s")

meta = svga_codec.info(svga)
print("info:", meta)
assert meta["frames"] == len(frames), meta
assert meta["fps"] == 24
assert meta["width"] == 300 and meta["height"] == 300

t0 = time.time()
rendered, fps, w, h = svga_codec.render_frames(svga)
print(f"render: {len(rendered)} frames {w}x{h} @{fps} in {time.time()-t0:.2f}s")
assert len(rendered) == len(frames)

# Round-trip fidelity: encoded frames are the source frames, so the render must
# reproduce them closely.
a = np.asarray(frames[5]).astype(int)
b = np.asarray(rendered[5]).astype(int)
alpha_err = np.abs(a[..., 3] - b[..., 3]).max()
opaque = a[..., 3] > 200
rgb_err = np.abs(a[..., :3][opaque] - b[..., :3][opaque]).max() if opaque.any() else 0
print(f"round-trip: max alpha err={alpha_err} max rgb err(opaque)={rgb_err}")
assert alpha_err <= 40, alpha_err
assert rgb_err <= 40, rgb_err

# Recompression must not grow the file and must stay decodable.
recompressed = svga_codec.optimize_svga_direct(svga, {
    "removeUnusedAssets": True, "dedupeAssets": True, "colors": 128, "quality": 60})
print(f"recompress: {len(svga)} -> {len(recompressed)} bytes")
assert len(recompressed) <= len(svga)
meta2 = svga_codec.info(recompressed)
assert meta2["frames"] == meta["frames"] and meta2["fps"] == meta["fps"], meta2
r2, _, _, _ = svga_codec.render_frames(recompressed, max_frames=3)
assert len(r2) == 3

# ONE MB targeting
target = 200 * 1024
out, attempts = svga_codec.optimize_svga_to_target(svga, target, "standard", meta)
print(f"target {target}: {len(out)} bytes, {len(attempts)} attempts")

# Exports
for kind in ("svga-to-webp", "svga-to-gif", "svga-to-mp4", "svga-to-alpha-webm",
             "svga-to-png", "svga-to-json", "svga-to-lottie"):
    t0 = time.time()
    data, ext, mime = conversions.convert(kind, svga, tier="standard")
    print(f"{kind:24s} -> {len(data):8d} bytes .{ext} in {time.time()-t0:.2f}s")
    assert len(data) > 0

# ONE MB export path
data, ext, mime = conversions.convert("svga-to-webp", svga, tier="standard", one_mb=True)
print(f"svga-to-webp ONE MB -> {len(data)} bytes")
with Image.open(io.BytesIO(data)) as im:
    print("  webp frames:", getattr(im, "n_frames", 1), "mode", im.mode)
    assert getattr(im, "n_frames", 1) == len(frames)
    assert im.mode in ("RGBA", "RGB", "P")

# Alpha survives the WebP round-trip
with Image.open(io.BytesIO(data)) as im:
    first = im.convert("RGBA")
    arr = np.asarray(first)
    print("  corner alpha (should be ~0):", int(arr[0, 150, 3]))
    assert int(arr[0, 150, 3]) < 40

print("\nALL CHECKS PASSED")
