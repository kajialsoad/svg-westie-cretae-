"""Can libwebp_anim take variable per-frame durations via the concat demuxer?

If yes, consecutive duplicate frames can be dropped and their time handed to the
preceding frame - size drops while TOTAL DURATION stays exactly the same.
"""
import os
import struct
import subprocess
import tempfile

import svga_codec
import mediaenc
from media import FFMPEG


def webp_timing(path):
    blob = open(path, "rb").read()
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


def coalesce(frame_paths, fps, tolerance=4, diff_tolerance=1.0):
    """Merge consecutive near-identical frames, moving their time to the keeper."""
    base = 1000.0 / fps
    kept = [frame_paths[0]]
    holds = [1]
    ref_hash = mediaenc.difference_hash(frame_paths[0])
    ref_sig = mediaenc.perceptual_signature(frame_paths[0])
    for path in frame_paths[1:]:
        h = mediaenc.difference_hash(path)
        s = mediaenc.perceptual_signature(path)
        if (mediaenc.hamming_distance(ref_hash, h) <= tolerance
                and mediaenc.average_diff(ref_sig, s) <= diff_tolerance):
            holds[-1] += 1
        else:
            kept.append(path)
            holds.append(1)
            ref_hash, ref_sig = h, s
    # Distribute exact millisecond budget so the total never drifts.
    total_units = sum(holds)
    durations = []
    acc = 0.0
    for hold in holds:
        acc += hold * base
        durations.append(acc)
    prev = 0.0
    out = []
    for d in durations:
        out.append(max(1, int(round(d - prev))))
        prev = round(d)
    return kept, out, total_units * base


PATH = r"F:\svg website\SVGAConverter_AE\sources\src\res\loading.svga"
data = open(PATH, "rb").read()

with tempfile.TemporaryDirectory() as tmp:
    frames_dir = os.path.join(tmp, "frames")
    r = svga_codec.render_frames_to_directory(data, frames_dir, prefix="f_")
    fps, paths = r["fps"], r["framePaths"]
    print(f"rendered {len(paths)} frames @ {fps}fps = {len(paths)/fps*1000:.0f} ms")

    kept, durations, expected_ms = coalesce(paths, fps)
    print(f"coalesced: {len(paths)} -> {len(kept)} frames, "
          f"duration sum={sum(durations)} ms (expected {expected_ms:.0f} ms)")

    listing = os.path.join(tmp, "list.txt")
    with open(listing, "w", encoding="utf-8") as f:
        f.write("ffconcat version 1.0\n")
        for path, ms in zip(kept, durations):
            f.write(f"file '{path.replace(chr(92), '/')}'\n")
            f.write(f"duration {ms / 1000.0:.6f}\n")
        f.write(f"file '{kept[-1].replace(chr(92), '/')}'\n")

    out = os.path.join(tmp, "concat.webp")
    p = subprocess.run([
        FFMPEG, "-hide_banner", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", listing,
        "-vcodec", "libwebp_anim", "-preset", "drawing",
        "-lossless", "0", "-quality", "82", "-loop", "0", "-an",
        "-fps_mode", "vfr", "-pix_fmt", "bgra", out,
    ], capture_output=True)

    if p.returncode != 0:
        print("CONCAT FAILED:", p.stderr.decode("utf-8", "ignore")[-600:])
    else:
        n, total, loop = webp_timing(out)
        print(f"concat webp : {os.path.getsize(out):7d} bytes  ANMF n={n} "
              f"total={total} ms loop={loop}")

    # baseline for comparison, same quality
    base_out = os.path.join(tmp, "base.webp")
    mediaenc.frames_to_webp_sequence(frames_dir, "f_", base_out, {
        "fps": fps, "quality": 82, "preset": "drawing", "crThreshold": 18, "crSize": 24})
    n2, total2, loop2 = webp_timing(base_out)
    print(f"baseline    : {os.path.getsize(base_out):7d} bytes  ANMF n={n2} "
          f"total={total2} ms loop={loop2}")
