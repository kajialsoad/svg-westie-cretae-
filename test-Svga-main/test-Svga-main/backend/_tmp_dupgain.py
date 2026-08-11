"""Does dropping duplicate frames actually help libwebp_anim, which already
does inter-frame conditional replenishment? Measure instead of assuming."""
import os
import tempfile

import numpy as np
from PIL import Image

import compression
import mediaenc
import svga_codec

PATH = r"F:\svg website\SVGAConverter_AE\sources\src\res\loading.svga"
data = open(PATH, "rb").read()

with tempfile.TemporaryDirectory() as tmp:
    frames_dir = os.path.join(tmp, "frames")
    r = svga_codec.render_frames_to_directory(data, frames_dir, prefix="f_")
    fps, w, h = r["fps"], r["width"], r["height"]
    all_paths = r["framePaths"]

    plan = compression.get_one_mb_attempt_plan("webp", 4, {"width": w, "height": h},
                                              "standard", {"targetBytes": 300 * 1024})
    plan["fps"] = fps

    full_out = os.path.join(tmp, "full.webp")
    mediaenc.frames_to_webp_sequence(frames_dir, "f_", full_out, plan)
    full_size = os.path.getsize(full_out)

    profile = compression.get_video_optimization_profile("standard")
    opt = mediaenc.optimize_frame_sequence(all_paths, source_fps=fps, profile=profile)
    culled_dir = os.path.join(tmp, "culled")
    mediaenc.relink_frames(opt["selectedFramePaths"], culled_dir, prefix="f_")
    culled_plan = dict(plan)
    culled_plan["fps"] = opt["outputFps"]
    culled_out = os.path.join(tmp, "culled.webp")
    mediaenc.frames_to_webp_sequence(culled_dir, "f_", culled_out, culled_plan)
    culled_size = os.path.getsize(culled_out)

    print(f"all frames   : {len(all_paths):4d} @ {fps}fps -> {full_size:8d} bytes")
    print(f"culled frames: {opt['selectedFrameCount']:4d} @ {opt['outputFps']}fps "
          f"-> {culled_size:8d} bytes  ({culled_size / full_size * 100:.1f}%)")

    # Alpha must survive the ffmpeg webp path
    with Image.open(full_out) as im:
        im.seek(0)
        arr = np.asarray(im.convert("RGBA"))
        print(f"ffmpeg webp: mode={im.mode} n_frames={im.n_frames} "
              f"cornerAlpha={int(arr[5, 5, 3])} (0 = transparency preserved)")

    # How much do the duplicates actually cost inside one encode?
    print(f"\nduplicates present: {opt['hardDuplicateSkips']} of {len(all_paths)}")
    print(f"cost per skipped duplicate: "
          f"{(full_size - culled_size) / max(1, len(all_paths) - opt['selectedFrameCount']):.0f} bytes")
