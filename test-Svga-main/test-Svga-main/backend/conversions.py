"""Format conversions between SVGA and GIF / MP4 / WebP / PNG / Lottie / JSON.

Every export runs through the shared size-governance loop in `compression.py`:
render once, then walk an encoder ladder until the output fits the requested
budget, keeping the smallest candidate produced along the way. Frame timing,
fps and canvas size are preserved for SVGA exports - size comes out of encoder
tuning, not by dropping frames or shrinking the canvas.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import zipfile

from PIL import Image, ImageSequence

import compression
import mediaenc
import svga_codec

# Formats that keep a real alpha channel end to end.
ALPHA_FORMATS = {"webp", "alpha-webm", "alpha-mov", "png", "svga"}


# ---------------------------------------------------------------------------
# frame sources
# ---------------------------------------------------------------------------
def _frames_from_animated_image(data):
    """Read GIF/WebP/APNG frames and derive fps from the real frame durations."""
    im = Image.open(io.BytesIO(data))
    frames = []
    durations = []
    for page in ImageSequence.Iterator(im):
        frames.append(page.convert("RGBA").copy())
        durations.append(page.info.get("duration") or im.info.get("duration") or 50)

    if durations:
        avg = sum(d for d in durations if d) / max(1, len([d for d in durations if d]))
    else:
        avg = 50
    fps = max(1, min(60, round(1000 / max(1, avg))))
    return frames, fps


def _frames_from_video(data, ext, fps=20, max_dim=750):
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, f"in.{ext}")
        with open(src, "wb") as f:
            f.write(data)
        frame_dir = os.path.join(tmp, "frames")
        paths = mediaenc.extract_frames(src, frame_dir, fps=fps, max_width=max_dim)
        frames = []
        for p in paths:
            with Image.open(p) as im:
                frames.append(im.convert("RGBA").copy())
    return frames, fps


# ---------------------------------------------------------------------------
# shared export pipeline
# ---------------------------------------------------------------------------
def _encode_from_dir(frames_dir, tmp, fps, width, height, frame_count, target,
                     tier="standard", one_mb=False, source_size_bytes=None,
                     audio_path=None):
    """Encode-many size targeting loop over an already-rendered frame directory.

    Returns (bytes, summary). Frames stay on disk the whole time, so attempt
    count does not scale memory use.
    """
    tier = compression.normalize_tier(tier)
    target_config = compression.get_target_config(tier, one_mb, source_size_bytes)
    metadata = {"width": width, "height": height, "fps": fps, "frames": frame_count}
    max_attempts = compression.get_max_attempts(target, one_mb, target_config)
    encoder = mediaenc.ENCODERS[target]
    ext = {"webp": "webp", "gif": "gif", "mp4": "mp4",
           "alpha-webm": "webm", "alpha-mov": "mov"}[target]

    attempts = []
    best = None

    if True:
        previous_size = None
        for attempt in range(1, max_attempts + 1):
            plan = (compression.get_one_mb_attempt_plan(
                        target, attempt, metadata, tier,
                        {"targetBytes": target_config["targetBytes"],
                         "sourceSizeBytes": source_size_bytes or target_config["targetBytes"]})
                    if one_mb else
                    compression.get_default_plan(target, tier, metadata))
            plan["fps"] = fps
            if audio_path:
                plan["audioPath"] = audio_path
                plan["audioBitrateKbps"] = compression \
                    .get_video_optimization_profile(tier)["audioBitrateKbps"]

            out_path = os.path.join(tmp, f"out_{attempt}.{ext}")
            encoder(frames_dir, "f_", out_path, plan)
            with open(out_path, "rb") as f:
                candidate = f.read()
            try:
                os.remove(out_path)
            except OSError:
                pass

            attempts.append({
                "attempt": attempt,
                "sizeBytes": len(candidate),
                "sizeMB": round(len(candidate) / (1024 * 1024), 2),
                "quality": plan.get("quality"),
                "crf": plan.get("crf"),
            })

            if best is None or len(candidate) < len(best):
                best = candidate

            if len(candidate) <= target_config["toleranceBytes"]:
                best = candidate
                break

            if one_mb and previous_size:
                improvement = (previous_size - len(candidate)) / max(1, previous_size)
                if attempt >= 4 and improvement < 0.03:
                    break
            previous_size = len(candidate)

    summary = compression.create_compression_summary(
        source_size_bytes or len(best or b""), len(best or b""),
        target_config, attempts, one_mb)
    return best, summary


def _render_and_encode(data, target, tier="standard", one_mb=False, overrides=None,
                       flatten_background=None, audio_path=None):
    """Stream-render an SVGA to disk, then run the encoder ladder over it."""
    with tempfile.TemporaryDirectory() as tmp:
        frames_dir = os.path.join(tmp, "frames")
        rendered = svga_codec.render_frames_to_directory(
            data, frames_dir, prefix="f_", overrides=overrides,
            flatten_background=flatten_background)
        return _encode_from_dir(
            frames_dir, tmp, rendered["fps"], rendered["width"], rendered["height"],
            rendered["totalFrames"], target, tier, one_mb, len(data), audio_path)


# ---------------------------------------------------------------------------
# to SVGA
# ---------------------------------------------------------------------------
def gif_to_svga(data, tier="standard"):
    frames, fps = _frames_from_animated_image(data)
    governance = compression.get_size_governance(compression.normalize_tier(tier))
    return svga_codec.encode_adaptive(frames, fps,
                                      target_bytes=governance["targetBytes"], tier=tier)


def webp_to_svga(data, tier="standard"):
    return gif_to_svga(data, tier)


def mp4_to_svga(data, ext="mp4", tier="standard"):
    tier = compression.normalize_tier(tier)
    settings = compression.get_tier_settings(tier)
    fps = compression.calculate_fps(tier, 20)
    frames, _ = _frames_from_video(data, ext, fps=fps, max_dim=settings["resolution"])
    if not frames:
        raise ValueError("Could not read video frames")
    governance = compression.get_size_governance(tier)
    return svga_codec.encode_adaptive(frames, fps,
                                      target_bytes=governance["targetBytes"], tier=tier)


PRESET_FPS = {"small": 12, "balanced": 15, "quality": 20}
PRESET_DIM = {"small": 480, "balanced": 540, "quality": 720}
PRESET_TIER = {"small": "lite", "balanced": "standard", "quality": "high"}


def mp4_to_svga_advanced(data, ext="mp4", remove_bg=False, preset="balanced",
                         tier=None, one_mb=False):
    """Video -> SVGA with motion-aware frame culling and size governance.

    The frame culler is what makes this fit a budget without visible damage:
    duplicate and near-static frames are dropped, and the output fps is scaled
    by the same keep-ratio so the animation still plays at its original speed.
    """
    tier = compression.normalize_tier(tier or PRESET_TIER.get(preset, "standard"))
    fps = PRESET_FPS.get(preset, 15)
    max_dim = min(PRESET_DIM.get(preset, 540), compression.get_tier_settings(tier)["resolution"])
    profile = compression.get_video_optimization_profile(tier, remove_bg)

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, f"in.{ext}")
        with open(src, "wb") as f:
            f.write(data)

        raw_dir = os.path.join(tmp, "raw")
        frame_paths = mediaenc.extract_frames(src, raw_dir, fps=fps, max_width=max_dim)
        if not frame_paths:
            raise ValueError("Could not read video frames")
        frame_paths = frame_paths[:compression.MAX_ENCODE_FRAMES]

        if remove_bg:
            from bgremove import _cut
            cut_dir = os.path.join(tmp, "cut")
            os.makedirs(cut_dir, exist_ok=True)
            cut_paths = []
            for p in frame_paths:
                with Image.open(p) as im:
                    cut = _cut(im.convert("RGBA"))
                dst = os.path.join(cut_dir, os.path.basename(p))
                cut.save(dst, format="PNG", compress_level=1)
                cut_paths.append(dst)
            frame_paths = cut_paths

        optimized = mediaenc.optimize_frame_sequence(frame_paths, source_fps=fps,
                                                     profile=profile)
        selected = optimized["selectedFramePaths"]
        out_fps = optimized["outputFps"]

        frames = []
        for p in selected:
            with Image.open(p) as im:
                frames.append(im.convert("RGBA").copy())

    if not frames:
        raise ValueError("Could not read video frames")

    source_size = len(data)
    if one_mb:
        target_bytes = compression.get_target_config(tier, True, source_size)["targetBytes"]
    else:
        target_bytes = compression.get_size_governance(tier)["targetBytes"]

    svga = svga_codec.encode_adaptive(frames, out_fps, target_bytes=target_bytes,
                                      tier=tier, max_size=max_dim)
    return svga, "svga", "application/octet-stream"


# ---------------------------------------------------------------------------
# from SVGA
# ---------------------------------------------------------------------------
def svga_to_webp(data, tier="standard", one_mb=False):
    out, _summary = _render_and_encode(data, "webp", tier, one_mb)
    return out


def svga_to_gif(data, tier="standard", one_mb=False):
    # GIF has one transparent index and no alpha blending, so semi-transparent
    # edges are flattened onto white first instead of turning into black fringes.
    out, _summary = _render_and_encode(data, "gif", tier, one_mb,
                                       flatten_background=(255, 255, 255, 255))
    return out


def svga_to_mp4(data, tier="standard", one_mb=False):
    out, _summary = _render_and_encode(data, "mp4", tier, one_mb)
    return out


def svga_to_alpha_webm(data, tier="standard", one_mb=False):
    out, _summary = _render_and_encode(data, "alpha-webm", tier, one_mb)
    return out


def svga_to_alpha_mov(data, tier="standard", one_mb=False):
    out, _summary = _render_and_encode(data, "alpha-mov", tier, one_mb)
    return out


def svga_to_png(data, tier="standard", one_mb=False):
    """Zip of all PNG frames, each run through the best-of PNG optimizer."""
    profile = compression.get_video_optimization_profile(compression.normalize_tier(tier))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for i, frame in enumerate(svga_codec.iter_render_frames(data)):
            buf = io.BytesIO()
            frame.save(buf, format="PNG", optimize=True, compress_level=9)
            frame.close()
            zf.writestr(f"frame_{i:05d}.png", svga_codec.optimize_png_bytes(
                buf.getvalue(),
                colors=profile["png"]["colors"],
                quality=profile["png"]["quality"],
                compression_level=9,
                allow_palette=profile["png"]["palette"],
            ))
    return out.getvalue()


def svga_to_json(data, tier="standard", one_mb=False):
    d = svga_codec.decode(data)
    out = {
        "version": d["version"],
        "params": {"viewBoxWidth": d["width"], "viewBoxHeight": d["height"],
                   "fps": d["fps"], "frames": d["frames"]},
        "images": list(d["images"].keys()),
        "sprites": [{"imageKey": s["imageKey"], "matteKey": s["matteKey"],
                     "frameCount": len(s["frames"])} for s in d["sprites"]],
        "audios": d["audios"],
    }
    if one_mb:
        return json.dumps(out, separators=(",", ":")).encode("utf-8")
    return json.dumps(out, indent=2).encode("utf-8")


def svga_to_lottie(data, tier="standard", one_mb=False):
    """Lottie with base64 image assets, deduplicated and PNG-optimized.

    Identical frames share one asset instead of being embedded repeatedly, which
    is where most of the bloat in a frame-sequence Lottie comes from.
    """
    import base64
    import hashlib

    meta = svga_codec.render_metadata(data)
    w, h, fps = meta["width"], meta["height"], meta["fps"]
    profile = compression.get_video_optimization_profile(compression.normalize_tier(tier))

    assets = []
    layers = []
    hash_to_id = {}
    frame_count = 0

    for i, f in enumerate(svga_codec.iter_render_frames(data)):
        frame_count += 1
        digest = hashlib.sha1(f.tobytes()).hexdigest()
        aid = hash_to_id.get(digest)
        if aid is None:
            buf = io.BytesIO()
            f.save(buf, format="PNG", optimize=True, compress_level=9)
            payload = svga_codec.optimize_png_bytes(
                buf.getvalue(),
                colors=profile["png"]["colors"],
                quality=profile["png"]["quality"],
                compression_level=9,
                allow_palette=profile["png"]["palette"] or one_mb,
            )
            aid = f"image_{len(hash_to_id)}"
            hash_to_id[digest] = aid
            assets.append({"id": aid, "w": w, "h": h, "u": "",
                           "p": "data:image/png;base64," + base64.b64encode(payload).decode(),
                           "e": 1})
        layers.append({
            "ddd": 0, "ind": i + 1, "ty": 2, "nm": f"frame_{i}", "refId": aid,
            "ks": {"o": {"a": 0, "k": 100}, "p": {"a": 0, "k": [w / 2, h / 2, 0]},
                   "a": {"a": 0, "k": [w / 2, h / 2, 0]}, "s": {"a": 0, "k": [100, 100, 100]}},
            "ip": i, "op": i + 1, "st": i, "bm": 0,
        })
        f.close()

    if not frame_count:
        raise ValueError("empty animation")

    lottie = {"v": "5.7.0", "fr": fps, "ip": 0, "op": frame_count, "w": w, "h": h,
              "nm": "SVGA Export", "ddd": 0, "assets": assets, "layers": layers}
    return json.dumps(lottie, separators=(",", ":")).encode("utf-8")


def svga_to_svga(data, tier="standard", one_mb=False):
    """Recompress an SVGA in place - timeline, fps and geometry untouched."""
    meta = svga_codec.info(data)
    if one_mb:
        target = compression.get_target_config(tier, True, len(data))["targetBytes"]
        out, _attempts = svga_codec.optimize_svga_to_target(data, target, tier, meta)
        return out
    return svga_codec.optimize_svga_direct(data, compression.get_default_plan("svga", tier, meta))


# ---------------------------------------------------------------------------
# layer editor export
# ---------------------------------------------------------------------------
EXPORT_TARGETS = {
    "gif": ("gif", "image/gif"),
    "mp4": ("mp4", "video/mp4"),
    "webp": ("webp", "image/webp"),
    "png": ("zip", "application/zip"),
    "alpha-webm": ("webm", "video/webm"),
    "alpha-mov": ("mov", "video/quicktime"),
    "svga": ("svga", "application/octet-stream"),
    "json": ("json", "application/json"),
    "lottie": ("json", "application/json"),
}


def svga_export(data, edits, target, tier="standard", one_mb=False):
    """Render an SVGA with per-layer edits applied, then export to `target`."""
    if target not in EXPORT_TARGETS:
        raise ValueError("Unsupported export target")
    ext, mime = EXPORT_TARGETS[target]

    overrides = None
    if edits:
        overrides = {int(k): v for k, v in edits.items()}

    # With no edits an SVGA target is a pure recompression: keep the original
    # structure rather than flattening it into an image sequence.
    if target == "svga" and not overrides:
        return svga_to_svga(data, tier, one_mb), ext, mime

    if target == "json":
        return svga_to_json(data, tier, one_mb), ext, mime
    if target == "lottie":
        return svga_to_lottie(data, tier, one_mb), ext, mime

    if target == "svga":
        # Edited layers have to be flattened into an image sequence; render to
        # disk first so a long animation does not have to fit in memory.
        with tempfile.TemporaryDirectory() as tmp:
            frames_dir = os.path.join(tmp, "frames")
            rendered = svga_codec.render_frames_to_directory(
                data, frames_dir, prefix="f_", overrides=overrides)
            governance = compression.get_size_governance(compression.normalize_tier(tier))
            target_bytes = (compression.get_target_config(tier, True, len(data))["targetBytes"]
                            if one_mb else governance["targetBytes"])
            return svga_codec.encode_adaptive(
                rendered["framePaths"], rendered["fps"],
                target_bytes=target_bytes, tier=tier), ext, mime

    if target == "png":
        profile = compression.get_video_optimization_profile(compression.normalize_tier(tier))
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for i, f in enumerate(svga_codec.iter_render_frames(data, overrides=overrides)):
                buf = io.BytesIO()
                f.save(buf, format="PNG", optimize=True, compress_level=9)
                f.close()
                zf.writestr(f"frame_{i:05d}.png", svga_codec.optimize_png_bytes(
                    buf.getvalue(), profile["png"]["colors"], profile["png"]["quality"],
                    9, profile["png"]["palette"]))
        return out.getvalue(), ext, mime

    flatten = (255, 255, 255, 255) if target == "gif" else None
    out, _summary = _render_and_encode(data, target, tier, one_mb, overrides, flatten)
    return out, ext, mime


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------
CONVERSIONS = {
    "gif-to-svga": (gif_to_svga, "svga", "application/octet-stream"),
    "webp-to-svga": (webp_to_svga, "svga", "application/octet-stream"),
    "mp4-to-svga": (mp4_to_svga, "svga", "application/octet-stream"),
    "svga-to-svga": (svga_to_svga, "svga", "application/octet-stream"),
    "svga-to-gif": (svga_to_gif, "gif", "image/gif"),
    "svga-to-mp4": (svga_to_mp4, "mp4", "video/mp4"),
    "svga-to-png": (svga_to_png, "zip", "application/zip"),
    "svga-to-webp": (svga_to_webp, "webp", "image/webp"),
    "svga-to-alpha-webm": (svga_to_alpha_webm, "webm", "video/webm"),
    "svga-to-alpha-mov": (svga_to_alpha_mov, "mov", "video/quicktime"),
    "svga-to-lottie": (svga_to_lottie, "json", "application/json"),
    "svga-to-json": (svga_to_json, "json", "application/json"),
}


def convert(kind, data, src_ext="mp4", tier="standard", one_mb=False):
    fn, out_ext, mime = CONVERSIONS[kind]
    tier = compression.normalize_tier(tier)
    if kind == "mp4-to-svga":
        result = fn(data, src_ext, tier)
    elif kind in ("gif-to-svga", "webp-to-svga"):
        result = fn(data, tier)
    else:
        result = fn(data, tier, one_mb)
    return result, out_ext, mime
