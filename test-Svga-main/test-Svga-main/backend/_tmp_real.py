"""Verify against a real exporter-produced SVGA + measure the old-vs-new encoder."""
import io
import os
import tempfile
import time
import zlib

import numpy as np
from PIL import Image

import compression
import conversions
import mediaenc
import svga_codec

PATH = r"F:\svg website\SVGAConverter_AE\sources\src\res\loading.svga"
data = open(PATH, "rb").read()
print(f"source: {len(data)} bytes")

meta = svga_codec.info(data)
print("info:", meta)

d = svga_codec.decode(data)
has_shapes = any(f["shapes"] for s in d["sprites"] for f in s["frames"])
has_keep = any(sh["type"] == svga_codec.SHAPE_TYPE_KEEP
               for s in d["sprites"] for f in s["frames"] for sh in f["shapes"])
has_clip = any(f["clipPath"] for s in d["sprites"] for f in s["frames"])
has_matte = any(s["matteKey"] for s in d["sprites"])
print(f"features: shapes={has_shapes} KEEP={has_keep} clipPath={has_clip} "
      f"matte={has_matte} sprites={len(d['sprites'])} images={len(d['images'])}")

# ---- streaming render ----
t0 = time.time()
nonempty = 0
total = 0
coverages = []
for frame in svga_codec.iter_render_frames(data):
    a = np.asarray(frame)
    cov = float((a[..., 3] > 8).mean())
    coverages.append(cov)
    if a[..., 3].max() > 0:
        nonempty += 1
    total += 1
    frame.close()
print(f"render: {total} frames in {time.time()-t0:.2f}s, non-empty {nonempty}/{total}")
assert nonempty == total, f"{total - nonempty} blank frames"
assert max(coverages) > min(coverages) + 0.005, "animation is not actually moving"
print(f"coverage varies {min(coverages)*100:.2f}% -> {max(coverages)*100:.2f}% (animation moves)")

# ---- recompression preserves structure and pixels ----
opt = svga_codec.optimize_svga_direct(data, {
    "removeUnusedAssets": True, "dedupeAssets": True, "colors": 256, "quality": 100})
print(f"recompress: {len(data)} -> {len(opt)} bytes ({len(opt)/len(data)*100:.1f}%)")
m2 = svga_codec.info(opt)
assert (m2["frames"], m2["fps"], m2["width"], m2["height"], m2["sprites"]) == \
       (meta["frames"], meta["fps"], meta["width"], meta["height"], meta["sprites"]), m2

worst = 0.0
gen_a = svga_codec.iter_render_frames(data)
gen_b = svga_codec.iter_render_frames(opt)
for fa, fb in zip(gen_a, gen_b):
    worst = max(worst, float(np.abs(np.asarray(fa).astype(np.int16)
                                    - np.asarray(fb).astype(np.int16)).mean()))
    fa.close()
    fb.close()
print(f"recompressed render max mean-abs diff: {worst:.4f}")
assert worst < 1.0, worst

# ---- exports ----
for kind in ("svga-to-webp", "svga-to-gif", "svga-to-mp4"):
    t0 = time.time()
    out, ext, mime = conversions.convert(kind, data, tier="standard")
    print(f"{kind:20s} -> {len(out):8d} bytes in {time.time()-t0:.1f}s")
    assert len(out) > 0

# transparency must survive the WebP path
def webp_anim_timing(blob):
    """Sum ANMF frame durations straight from the RIFF container.

    Pillow's info['duration'] is unreliable for animated WebP, so the container
    is parsed directly - this is the only trustworthy timing check.
    """
    import struct
    assert blob[:4] == b"RIFF" and blob[8:12] == b"WEBP"
    pos, durations, loop = 12, [], None
    while pos + 8 <= len(blob):
        fourcc = blob[pos:pos + 4]
        size = struct.unpack("<I", blob[pos + 4:pos + 8])[0]
        body = blob[pos + 8:pos + 8 + size]
        if fourcc == b"ANIM" and len(body) >= 6:
            loop = struct.unpack("<H", body[4:6])[0]
        elif fourcc == b"ANMF" and len(body) >= 16:
            durations.append(body[12] | (body[13] << 8) | (body[14] << 16))
        pos += 8 + size + (size & 1)
    return len(durations), sum(durations), loop


out, _, _ = conversions.convert("svga-to-webp", data, tier="standard")
n_anmf, total_ms, loop = webp_anim_timing(out)
expected_ms = meta["frames"] / meta["fps"] * 1000
with Image.open(io.BytesIO(out)) as im:
    im.seek(0)
    arr = np.asarray(im.convert("RGBA"))
    mode, n_frames = im.mode, im.n_frames
# libwebp coalesces identical consecutive frames and lengthens their duration,
# so frame COUNT legitimately drops. Total duration is the timing guarantee.
print(f"webp: mode={mode} n_frames={n_frames} (source {meta['frames']}) "
      f"duration={total_ms}ms (source {expected_ms:.0f}ms) loop={loop} "
      f"cornerAlpha={int(arr[3, 3, 3])}")
assert int(arr[3, 3, 3]) == 0, "transparency lost in WebP export"
assert loop == 0, f"expected infinite loop, got {loop}"
assert abs(total_ms - expected_ms) <= expected_ms * 0.02, (total_ms, expected_ms)


# --------- old vs new image-sequence encoder ---------
def old_encode(frame_paths, fps_in):
    """The previous encoder: a full FrameEntity per sprite per frame slot."""
    import struct

    def varint(v):
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

    def tag(fn, wt):
        return varint((fn << 3) | wt)

    def ld(b):
        return varint(len(b)) + b

    def wf32(v):
        return struct.pack("<f", float(v))

    with Image.open(frame_paths[0]) as probe:
        w0, h0 = probe.size
    n = len(frame_paths)

    body = bytearray()
    body += tag(1, 2) + ld(b"2.0.0")
    p = bytearray()
    p += tag(1, 5) + wf32(w0)
    p += tag(2, 5) + wf32(h0)
    p += tag(3, 0) + varint(fps_in)
    p += tag(4, 0) + varint(n)
    body += tag(2, 2) + ld(bytes(p))

    for idx, path in enumerate(frame_paths):
        with Image.open(path) as im:
            buf = io.BytesIO()
            im.convert("RGBA").save(buf, format="WEBP", quality=80, method=4)
        body += tag(3, 2) + ld(tag(1, 2) + ld(f"frame_{idx:04d}".encode())
                               + tag(2, 2) + ld(buf.getvalue()))

    for idx in range(n):
        s = bytearray()
        s += tag(1, 2) + ld(f"frame_{idx:04d}".encode())
        for j in range(n):
            fb = bytearray()
            fb += tag(1, 5) + wf32(1.0 if j == idx else 0.0)
            lb = (tag(1, 5) + wf32(0) + tag(2, 5) + wf32(0) +
                  tag(3, 5) + wf32(w0) + tag(4, 5) + wf32(h0))
            fb += tag(2, 2) + ld(bytes(lb))
            tb = b"".join(tag(i + 1, 5) + wf32(v)
                          for i, v in enumerate((1, 0, 0, 1, 0, 0)))
            fb += tag(3, 2) + ld(tb)
            s += tag(2, 2) + ld(bytes(fb))
        body += tag(4, 2) + ld(bytes(s))
    return zlib.compress(bytes(body), 9)


with tempfile.TemporaryDirectory() as tmp:
    r = svga_codec.render_frames_to_directory(data, tmp, prefix="f_", max_frames=120)
    paths = r["framePaths"]
    old = old_encode(paths, r["fps"])
    new = svga_codec.encode(paths, r["fps"])
    print(f"\nimage-sequence encoder, {len(paths)} frames:")
    print(f"  previous: {len(old):8d} bytes")
    print(f"  current : {len(new):8d} bytes  ({len(new)/len(old)*100:.1f}%)")
    assert len(new) < len(old)

    # structural overhead alone (same images, timeline model differs)
    print(f"  saved   : {len(old)-len(new):8d} bytes")
    assert svga_codec.info(new)["frames"] == len(paths)

print("\nALL REAL-FILE CHECKS PASSED")
