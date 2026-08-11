"""Prove the size-targeting ladder actually steps down and reports honestly."""
import os
import tempfile

import compression
import conversions
import mediaenc
import svga_codec

PATH = r"F:\svg website\SVGAConverter_AE\sources\src\res\loading.svga"
data = open(PATH, "rb").read()
meta = svga_codec.render_metadata(data)
print("source:", len(data), "bytes  meta:", meta)

with tempfile.TemporaryDirectory() as tmp:
    frames_dir = os.path.join(tmp, "frames")
    rendered = svga_codec.render_frames_to_directory(data, frames_dir, prefix="f_")
    print("rendered", rendered["totalFrames"], "frames to disk")

    for one_mb, target_bytes in ((False, None), (True, 300 * 1024)):
        cfg = compression.get_target_config("standard", one_mb,
                                            target_bytes if one_mb else None)
        out, summary = conversions._encode_from_dir(
            frames_dir, tmp, rendered["fps"], rendered["width"], rendered["height"],
            rendered["totalFrames"], "webp", "standard", one_mb,
            target_bytes if one_mb else len(data))
        mode = "ONE MB" if one_mb else "tier"
        print(f"\n[{mode}] target={cfg['targetSizeMB']}MB tolerance={cfg['toleranceBytes']}B")
        print(f"  final {len(out)} bytes  targetMet={summary['targetMet']} "
              f"ratio={summary['compressionRatio']}")
        for a in summary["attempts"]:
            print(f"    attempt {a['attempt']}: q={a['quality']} -> {a['sizeBytes']} bytes")

    # Frame culling behaviour on a real sequence
    profile = compression.get_video_optimization_profile("standard")
    opt = mediaenc.optimize_frame_sequence(rendered["framePaths"],
                                           source_fps=rendered["fps"], profile=profile)
    print(f"\nframe culling: {opt['sourceFrameCount']} -> {opt['selectedFrameCount']} frames, "
          f"fps {rendered['fps']} -> {opt['outputFps']}, "
          f"hard duplicates skipped={opt['hardDuplicateSkips']}")

print("\nLADDER CHECKS DONE")
