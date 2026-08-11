"""FFmpeg / frame-sequence engine (parity port of AnimSuite Pro services/ffmpeg.js).

Everything that touches an encoder lives here so parameters stay in one place:
  * capability-probed libwebp_anim animated WebP encoding
  * two-pass palettegen/paletteuse GIF encoding
  * CRF-governed H.264 and VP9-alpha video encoding
  * perceptual frame-sequence culling (dHash + mean-abs signature)

Unlike the previous implementation, every ffmpeg invocation checks its exit code
and surfaces stderr, so a failed encode can no longer look like a missing file.
"""
from __future__ import annotations

import glob
import os
import re
import subprocess

import numpy as np
from PIL import Image

from media import FFMPEG

# Long jobs used to be killed at 110s, silently truncating animations.
FFMPEG_TIMEOUT = int(os.environ.get("FFMPEG_TIMEOUT", "600"))

_libwebp_caps = None


class FFmpegError(RuntimeError):
    pass


def run_ffmpeg(args, timeout: int | None = None) -> str:
    """Run ffmpeg and raise with the tail of stderr when it fails."""
    cmd = [FFMPEG, "-hide_banner", "-nostdin", *[str(a) for a in args]]
    try:
        proc = subprocess.run(cmd, capture_output=True,
                              timeout=timeout or FFMPEG_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"ffmpeg timed out after {timeout or FFMPEG_TIMEOUT}s") from exc
    stderr = (proc.stderr or b"").decode("utf-8", "ignore")
    if proc.returncode != 0:
        raise FFmpegError(f"ffmpeg exited with code {proc.returncode}: {stderr[-800:]}")
    return stderr


def get_libwebp_anim_capabilities() -> dict:
    """Probe which libwebp_anim options this ffmpeg build actually accepts.

    Static builds differ: several ship without -compression_level or
    -alpha_quality. Passing an unknown option aborts the encode, so the flags
    are resolved once and cached.
    """
    global _libwebp_caps
    if _libwebp_caps is not None:
        return _libwebp_caps

    try:
        proc = subprocess.run([FFMPEG, "-hide_banner", "-h", "encoder=libwebp_anim"],
                              capture_output=True, timeout=30)
        help_text = ((proc.stdout or b"") + b"\n" + (proc.stderr or b"")).decode("utf-8", "ignore")
        pix_line = re.search(r"Supported pixel formats:\s*(.+)", help_text, re.I)
        pixel_formats = pix_line.group(1).split() if pix_line else []
        _libwebp_caps = {
            "available": "libwebp" in help_text.lower(),
            "supportsAlphaQuality": bool(re.search(r"-alpha_quality\b", help_text)),
            "supportsCompressionLevel": bool(re.search(r"-compression_level\b", help_text)),
            "supportsPreset": bool(re.search(r"-preset\b", help_text)),
            "supportsCrThreshold": bool(re.search(r"-cr_threshold\b", help_text)),
            "supportsCrSize": bool(re.search(r"-cr_size\b", help_text)),
            "pixelFormats": pixel_formats or ["bgra", "yuva420p"],
        }
    except Exception:
        _libwebp_caps = {
            "available": False,
            "supportsAlphaQuality": False,
            "supportsCompressionLevel": False,
            "supportsPreset": True,
            "supportsCrThreshold": False,
            "supportsCrSize": False,
            "pixelFormats": ["bgra", "yuva420p"],
        }
    return _libwebp_caps


def _pick_webp_pix_fmt(caps: dict) -> str:
    fmts = caps.get("pixelFormats") or []
    if "bgra" in fmts:
        return "bgra"
    if "yuva420p" in fmts:
        return "yuva420p"
    return "rgba"


# ---------------------------------------------------------------------------
# Frame IO
# ---------------------------------------------------------------------------
def write_frames(frames, frames_dir: str, prefix: str = "frame_") -> list[str]:
    """Persist PIL RGBA frames as sequential PNGs (1-based, 5 digits)."""
    os.makedirs(frames_dir, exist_ok=True)
    paths = []
    for i, frame in enumerate(frames):
        path = os.path.join(frames_dir, f"{prefix}{i + 1:05d}.png")
        frame.convert("RGBA").save(path, format="PNG", optimize=False, compress_level=1)
        paths.append(path)
    return paths


def relink_frames(frame_paths, out_dir: str, prefix: str = "seq_") -> list[str]:
    """Copy a (possibly sparse) frame list into a gap-free sequence for ffmpeg."""
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for i, src in enumerate(frame_paths):
        dst = os.path.join(out_dir, f"{prefix}{i + 1:05d}.png")
        with open(src, "rb") as rf, open(dst, "wb") as wf:
            wf.write(rf.read())
        out.append(dst)
    return out


def extract_frames(input_path: str, output_dir: str, fps: int = 24,
                   max_width: int = 720, pix_fmt: str = "rgba") -> list[str]:
    """Decode a video to PNG frames with lanczos scaling and even dimensions."""
    os.makedirs(output_dir, exist_ok=True)
    output_pattern = os.path.join(output_dir, "frame_%05d.png")
    # trunc(...)*2 keeps width even; -2 keeps height even and aspect-correct.
    video_filter = (f"fps={fps},"
                    f"scale='min({int(max_width)},trunc(iw/2)*2)':-2:flags=lanczos")
    run_ffmpeg([
        "-y", "-i", input_path,
        "-vf", video_filter,
        "-sws_flags", "lanczos+accurate_rnd",
        "-pix_fmt", pix_fmt,
        "-an",
        "-start_number", "1",
        output_pattern,
    ])
    return sorted(glob.glob(os.path.join(output_dir, "frame_*.png")))


def get_video_info(input_path: str) -> dict:
    """Duration / resolution / fps parsed from ffmpeg's own stream report.

    imageio-ffmpeg does not ship ffprobe, so the -i banner is parsed instead.
    """
    try:
        proc = subprocess.run([FFMPEG, "-hide_banner", "-i", input_path],
                              capture_output=True, timeout=120)
        text = ((proc.stderr or b"") + (proc.stdout or b"")).decode("utf-8", "ignore")
    except Exception:
        text = ""

    info = {"duration": 0.0, "width": 0, "height": 0, "fps": 0.0, "hasAudio": False}

    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", text)
    if m:
        info["duration"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

    m = re.search(r"Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})", text, re.S)
    if m:
        info["width"], info["height"] = int(m.group(1)), int(m.group(2))

    m = re.search(r"(\d+\.?\d*)\s*fps", text)
    if m:
        info["fps"] = float(m.group(1))
    if not info["fps"]:
        m = re.search(r"(\d+\.?\d*)\s*tbr", text)
        if m:
            info["fps"] = float(m.group(1))

    info["hasAudio"] = bool(re.search(r"Stream #\d+:\d+.*?Audio:", text))
    return info


def extract_audio(input_path: str, output_path: str, bitrate_kbps: int = 128) -> bool:
    try:
        run_ffmpeg([
            "-y", "-i", input_path,
            "-vn", "-acodec", "libmp3lame",
            "-b:a", f"{int(bitrate_kbps)}k",
            "-ar", "44100", "-ac", "2",
            output_path,
        ])
        return os.path.exists(output_path) and os.path.getsize(output_path) > 0
    except FFmpegError:
        return False


# ---------------------------------------------------------------------------
# Encoders
# ---------------------------------------------------------------------------
def frames_to_webp_sequence(frames_dir: str, prefix: str, output_path: str,
                            options: dict | None = None) -> None:
    """Animated WebP via libwebp_anim, alpha preserved, options capability-gated."""
    o = options or {}
    fps = o.get("fps") or 24
    quality = o.get("quality", 90)
    loop = o.get("loop", 0)
    compression_level = o.get("compressionLevel", 3)
    width, height = o.get("width"), o.get("height")
    lossless = o.get("lossless") is True
    alpha_quality = o.get("alphaQuality", 100)
    preset = o.get("preset", "drawing")
    cr_threshold = o.get("crThreshold")
    cr_size = o.get("crSize")
    strip_metadata = o.get("stripMetadata") is True

    caps = get_libwebp_anim_capabilities()
    if not caps.get("available"):
        raise FFmpegError("libwebp_anim encoder unavailable in this ffmpeg build")

    input_pattern = os.path.join(frames_dir, f"{prefix}%05d.png")
    args = ["-y", "-threads", "0", "-framerate", str(fps), "-i", input_pattern]

    if width and height:
        args += ["-vf", f"scale={int(width)}:{int(height)}:flags=lanczos:"
                        f"force_original_aspect_ratio=decrease"]
    args += ["-sws_flags", "lanczos+accurate_rnd+full_chroma_int",
             "-vcodec", "libwebp_anim"]

    if caps["supportsPreset"]:
        args += ["-preset", str(preset)]
    if caps["supportsCrThreshold"] and cr_threshold is not None:
        args += ["-cr_threshold", str(int(cr_threshold))]
    if caps["supportsCrSize"] and cr_size is not None:
        args += ["-cr_size", str(int(cr_size))]

    args += ["-lossless", "1" if lossless else "0"]
    if caps["supportsCompressionLevel"]:
        args += ["-compression_level", str(int(compression_level))]
    args += ["-quality", str(quality)]
    if caps["supportsAlphaQuality"]:
        args += ["-alpha_quality", str(int(alpha_quality))]
    args += ["-loop", str(int(loop)), "-an"]
    if strip_metadata:
        args += ["-map_metadata", "-1"]
    args += ["-pix_fmt", _pick_webp_pix_fmt(caps), output_path]

    run_ffmpeg(args)


def frames_to_gif(frames_dir: str, prefix: str, output_path: str,
                  options: dict | None = None) -> None:
    """Two-pass GIF: a single diff-aware global palette, then bayer-dithered use.

    A shared palette is what removes the colour flicker you get from encoding
    each frame with its own adaptive palette, and diff_mode=rectangle keeps only
    the changed region per frame, which is the main size win.
    """
    o = options or {}
    fps = o.get("fps") or 15
    max_width = int(o.get("maxWidth") or 480)
    dither_scale = int(o.get("ditherScale") or 5)
    strip_metadata = o.get("stripMetadata") is True

    input_pattern = os.path.join(frames_dir, f"{prefix}%05d.png")
    palette_path = os.path.join(frames_dir, "palette.png")

    run_ffmpeg([
        "-y", "-framerate", str(fps), "-i", input_pattern,
        "-vf", f"fps={fps},scale={max_width}:-1:flags=lanczos,"
               f"palettegen=stats_mode=diff",
        palette_path,
    ])

    args = [
        "-y", "-framerate", str(fps), "-i", input_pattern, "-i", palette_path,
        "-lavfi", f"fps={fps},scale={max_width}:-1:flags=lanczos[x];"
                  f"[x][1:v]paletteuse=dither=bayer:bayer_scale={dither_scale}:"
                  f"diff_mode=rectangle",
        "-loop", "0",
    ]
    if strip_metadata:
        args += ["-map_metadata", "-1"]
    args += [output_path]
    run_ffmpeg(args)

    try:
        os.remove(palette_path)
    except OSError:
        pass


def frames_to_mp4(frames_dir: str, prefix: str, output_path: str,
                  options: dict | None = None) -> None:
    """H.264 with CRF rate control, faststart and animation-tuned encoding."""
    o = options or {}
    fps = o.get("fps") or 24
    crf = int(o.get("crf", 20))
    width, height = o.get("width"), o.get("height")
    audio_path = o.get("audioPath")
    strip_metadata = o.get("stripMetadata") is True

    input_pattern = os.path.join(frames_dir, f"{prefix}%05d.png")
    args = ["-y", "-framerate", str(fps), "-i", input_pattern]
    if audio_path and os.path.exists(audio_path):
        args += ["-i", audio_path]

    scale = (f"scale={int(width)}:{int(height)}:flags=lanczos,"
             if width and height else "")
    # Flatten alpha onto white first: yuv420p has no alpha channel, and letting
    # the encoder drop it produces black fringing on anti-aliased edges.
    vf = (f"[0:v]{scale}"
          f"split[a][b];[a]alphaextract[alpha];"
          f"color=white:s=1x1[bg];[bg][b]scale2ref[bgs][bv];"
          f"[bgs][bv]overlay=shortest=1[flat];"
          f"[flat][alpha]alphamerge,format=rgba[rgba];"
          f"[rgba]format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2[v]")
    args += ["-filter_complex", vf, "-map", "[v]"]
    if audio_path and os.path.exists(audio_path):
        args += ["-map", "1:a", "-c:a", "aac", "-b:a", f"{o.get('audioBitrateKbps', 96)}k",
                 "-shortest"]
    args += [
        "-c:v", "libx264",
        "-preset", o.get("preset", "slow"),
        "-tune", "animation",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level", "4.1",
        "-movflags", "+faststart",
        "-r", str(fps),
    ]
    if strip_metadata:
        args += ["-map_metadata", "-1"]
    args += [output_path]

    try:
        run_ffmpeg(args)
    except FFmpegError:
        # Simple fallback for builds/filters that reject the alpha flatten graph.
        fallback = ["-y", "-framerate", str(fps), "-i", input_pattern]
        if audio_path and os.path.exists(audio_path):
            fallback += ["-i", audio_path, "-c:a", "aac", "-shortest"]
        fallback += [
            "-vf", f"{scale}format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-preset", o.get("preset", "slow"),
            "-tune", "animation", "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(fps),
            output_path,
        ]
        run_ffmpeg(fallback)


def frames_to_alpha_webm(frames_dir: str, prefix: str, output_path: str,
                         options: dict | None = None) -> None:
    """VP9 with a real alpha channel, constant-quality mode.

    -auto-alt-ref 0 is required: alt-ref frames corrupt the alpha plane on
    several libvpx builds, which shows up as flickering transparency.
    """
    o = options or {}
    fps = o.get("fps") or 24
    crf = int(o.get("crf", 28))
    width, height = o.get("width"), o.get("height")
    strip_metadata = o.get("stripMetadata") is True

    input_pattern = os.path.join(frames_dir, f"{prefix}%05d.png")
    args = ["-y", "-framerate", str(fps), "-i", input_pattern]
    if width and height:
        args += ["-vf", f"scale={int(width)}:{int(height)}:flags=lanczos"]
    args += [
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-crf", str(crf),
        "-b:v", "0",
        "-auto-alt-ref", "0",
        "-deadline", "good",
        "-cpu-used", "2",
        "-row-mt", "1",
        "-threads", "0",
        "-r", str(fps),
        "-an",
    ]
    if strip_metadata:
        args += ["-map_metadata", "-1"]
    args += [output_path]
    run_ffmpeg(args)


def frames_to_alpha_mov(frames_dir: str, prefix: str, output_path: str,
                        options: dict | None = None) -> None:
    """ProRes 4444 with alpha — mastering format, quality over size."""
    o = options or {}
    fps = o.get("fps") or 24
    width, height = o.get("width"), o.get("height")
    qscale = int(o.get("qscale", 9))

    input_pattern = os.path.join(frames_dir, f"{prefix}%05d.png")
    args = ["-y", "-framerate", str(fps), "-i", input_pattern]
    if width and height:
        args += ["-vf", f"scale={int(width)}:{int(height)}:flags=lanczos"]
    args += [
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "16",
        "-qscale:v", str(qscale),
        "-vendor", "apl0",
        "-r", str(fps),
        "-an",
        output_path,
    ]
    run_ffmpeg(args)


ENCODERS = {
    "webp": frames_to_webp_sequence,
    "gif": frames_to_gif,
    "mp4": frames_to_mp4,
    "alpha-webm": frames_to_alpha_webm,
    "alpha-mov": frames_to_alpha_mov,
}


# ---------------------------------------------------------------------------
# Perceptual frame-sequence optimization
# ---------------------------------------------------------------------------
def perceptual_signature(frame_path: str, size: int = 24) -> np.ndarray:
    with Image.open(frame_path) as im:
        small = im.convert("L").resize((size, size), Image.BILINEAR)
        return np.asarray(small, dtype=np.int16).ravel()


def difference_hash(frame_path: str, width: int = 16, height: int = 16) -> np.ndarray:
    with Image.open(frame_path) as im:
        small = im.convert("L").resize((width + 1, height), Image.BILINEAR)
        arr = np.asarray(small, dtype=np.int16)
    return (arr[:, :-1] > arr[:, 1:]).astype(np.uint8).ravel()


def hamming_distance(a, b) -> int:
    if a is None or b is None or len(a) != len(b):
        return 1 << 30
    return int(np.count_nonzero(a != b))


def average_diff(a, b) -> float:
    if a is None or b is None or len(a) != len(b):
        return 255.0
    return float(np.abs(a.astype(np.int32) - b.astype(np.int32)).mean())


def optimize_frame_sequence(frame_paths, source_fps: float = 24,
                            profile: dict | None = None) -> dict:
    """Drop duplicate / near-static frames and recompute the playback fps.

    This is the single largest compression win for animations: SVGA and video
    exports are full of repeated frames, and removing them shortens the stream
    without changing the perceived timing, because the output fps is scaled by
    the same keep-ratio.
    """
    if not frame_paths or len(frame_paths) <= 2:
        paths = list(frame_paths or [])
        return {
            "selectedFramePaths": paths,
            "selectedIndices": list(range(len(paths))),
            "sourceFrameCount": len(paths),
            "selectedFrameCount": len(paths),
            "outputFps": source_fps or 24,
            "avgDiff": 0.0,
            "avgHashDistance": 0.0,
            "hardDuplicateSkips": 0,
        }

    profile = profile or {
        "staticThreshold": 2.0,
        "lowMotionThreshold": 5.0,
        "staticStride": 3,
        "lowMotionStride": 2,
        "minFps": 12,
    }

    selected_indices = [0]
    prev_signature = perceptual_signature(frame_paths[0])
    prev_hash = difference_hash(frame_paths[0])
    last_selected = 0
    total_diff = 0.0
    total_hash_distance = 0
    hard_duplicate_skips = 0
    samples = 0

    for i in range(1, len(frame_paths)):
        signature = perceptual_signature(frame_paths[i])
        frame_hash = difference_hash(frame_paths[i])
        diff = average_diff(prev_signature, signature)
        hash_distance = hamming_distance(prev_hash, frame_hash)
        total_diff += diff
        total_hash_distance += hash_distance
        samples += 1

        distance = i - last_selected
        keep_frame = True
        hard_duplicate = hash_distance <= 4
        low_motion_duplicate = hash_distance <= 12 and diff <= profile["staticThreshold"]

        if hard_duplicate:
            keep_frame = False
            hard_duplicate_skips += 1
        elif low_motion_duplicate:
            keep_frame = distance >= max(2, profile["lowMotionStride"])
        elif diff < profile["staticThreshold"]:
            keep_frame = distance >= profile["staticStride"]
        elif diff < profile["lowMotionThreshold"]:
            keep_frame = distance >= profile["lowMotionStride"]

        if keep_frame:
            selected_indices.append(i)
            last_selected = i

        prev_signature = signature
        prev_hash = frame_hash

    if selected_indices[-1] != len(frame_paths) - 1:
        selected_indices.append(len(frame_paths) - 1)

    selected = [frame_paths[i] for i in selected_indices]
    keep_ratio = len(selected) / len(frame_paths)
    output_fps = max(profile.get("minFps", 8), int(round((source_fps or 24) * keep_ratio)))

    return {
        "selectedFramePaths": selected,
        "selectedIndices": selected_indices,
        "sourceFrameCount": len(frame_paths),
        "selectedFrameCount": len(selected),
        "outputFps": output_fps,
        "avgDiff": total_diff / samples if samples else 0.0,
        "avgHashDistance": total_hash_distance / samples if samples else 0.0,
        "hardDuplicateSkips": hard_duplicate_skips,
    }


def downsample_frame_paths(frame_paths, keep_ratio: float = 0.8) -> list[str]:
    """Evenly thin a frame list to keep_ratio of its length."""
    if not frame_paths or len(frame_paths) <= 2:
        return list(frame_paths or [])
    ratio = max(0.1, min(1.0, keep_ratio))
    target_count = max(2, int(round(len(frame_paths) * ratio)))
    if target_count >= len(frame_paths):
        return list(frame_paths)

    step = (len(frame_paths) - 1) / (target_count - 1)
    selected, seen = [], set()
    for i in range(target_count):
        idx = min(len(frame_paths) - 1, int(round(i * step)))
        path = frame_paths[idx]
        if path not in seen:
            selected.append(path)
            seen.add(path)
    return selected
