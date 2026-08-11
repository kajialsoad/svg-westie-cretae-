"""Smart Compression Engine (parity port of AnimSuite Pro services/compression.js).

Central governance for output size / quality across every conversion module.
All tier numbers, thresholds and attempt ladders are kept byte-identical to the
proven Node implementation so both backends produce comparable output.
"""
from __future__ import annotations

import copy
import os

# ---------------------------------------------------------------------------
# Size tiers
# ---------------------------------------------------------------------------
SIZE_TIERS = {
    "lite": {
        "label": "Lite",
        "maxSizeMB": 5,
        "maxSizeBytes": 5 * 1024 * 1024,
        "resolution": 480,
        "fpsRange": (15, 30),
        "quality": 82,
    },
    "standard": {
        "label": "Standard",
        "maxSizeMB": 10,
        "maxSizeBytes": 10 * 1024 * 1024,
        "resolution": 720,
        "fpsRange": (20, 30),
        "quality": 92,
    },
    "high": {
        "label": "High Quality",
        "maxSizeMB": 15,
        "maxSizeBytes": 15 * 1024 * 1024,
        "resolution": 1080,
        "fpsRange": (24, 60),
        "quality": 96,
    },
    "ultra": {
        "label": "Ultra Fidelity",
        "maxSizeMB": 50,
        "maxSizeBytes": 50 * 1024 * 1024,
        "resolution": 1920,
        "fpsRange": (1, 120),
        "quality": 100,
        "lossless": True,
    },
}

# Motion-aware frame culling + PNG asset profiles per tier.
VIDEO_OPTIMIZATION_PROFILES = {
    "lite": {
        "staticThreshold": 2.5,
        "lowMotionThreshold": 6.0,
        "staticStride": 5,
        "lowMotionStride": 3,
        "minFps": 10,
        "keepNearLossless": False,
        "png": {"palette": True, "colors": 128, "quality": 72, "compressionLevel": 9},
        "audioBitrateKbps": 64,
    },
    "standard": {
        "staticThreshold": 2.0,
        "lowMotionThreshold": 5.0,
        "staticStride": 4,
        "lowMotionStride": 2,
        "minFps": 12,
        "keepNearLossless": False,
        "png": {"palette": True, "colors": 192, "quality": 82, "compressionLevel": 9},
        "audioBitrateKbps": 80,
    },
    "high": {
        "staticThreshold": 1.5,
        "lowMotionThreshold": 4.0,
        "staticStride": 3,
        "lowMotionStride": 2,
        "minFps": 16,
        "keepNearLossless": True,
        "png": {"palette": False, "colors": 256, "quality": 92, "compressionLevel": 9},
        "audioBitrateKbps": 96,
    },
    "ultra": {
        "staticThreshold": 0.8,
        "lowMotionThreshold": 2.0,
        "staticStride": 1,
        "lowMotionStride": 1,
        "minFps": 24,
        "keepNearLossless": True,
        "png": {"palette": False, "colors": 256, "quality": 100, "compressionLevel": 9},
        "audioBitrateKbps": 128,
    },
}

VIDEO_SVGA_SIZE_POLICY = {
    "minSizeMB": 5,
    "preferredMinMB": 25,
    "preferredMaxMB": 30,
    "hardMaxMB": 50,
}

ONE_MB_POLICY = {
    "label": "ONE MB",
    "targetSizeMB": 1,
    "targetBytes": 1024 * 1024,
    "toleranceBytes": round(1.35 * 1024 * 1024),
}

# Hard ceilings so a hostile / huge upload cannot exhaust the worker.
MAX_RENDER_FRAMES = int(os.environ.get("SVGA_MAX_RENDER_FRAMES", "1200"))
MAX_ENCODE_FRAMES = int(os.environ.get("SVGA_MAX_ENCODE_FRAMES", "600"))


def get_tier_settings(tier: str) -> dict:
    return SIZE_TIERS.get(tier) or SIZE_TIERS["standard"]


def normalize_tier(tier) -> str:
    t = str(tier or "standard").strip().lower()
    return t if t in SIZE_TIERS else "standard"


def is_one_mb_mode_enabled(value) -> bool:
    if value is True:
        return True
    return str(value or "").strip().lower() in ("true", "1", "yes", "on")


def to_even_number(value) -> int:
    safe = max(2, int(round(value or 2)))
    return safe if safe % 2 == 0 else safe - 1


def get_target_config(tier: str = "standard", one_mb_mode: bool = False,
                      source_size_bytes=None) -> dict:
    """Resolve the byte budget for a job (tier ceiling or adaptive ONE MB)."""
    settings = get_tier_settings(tier)
    if not one_mb_mode:
        return {
            "mode": "tier",
            "label": settings["label"],
            "targetSizeMB": settings["maxSizeMB"],
            "targetBytes": settings["maxSizeBytes"],
            "maxSizeMB": settings["maxSizeMB"],
            "maxSizeBytes": settings["maxSizeBytes"],
            "toleranceBytes": settings["maxSizeBytes"],
        }

    safe_source = None
    try:
        if source_size_bytes is not None:
            safe_source = max(1, int(source_size_bytes))
    except (TypeError, ValueError):
        safe_source = None

    target_bytes = min(ONE_MB_POLICY["targetBytes"], safe_source) if safe_source \
        else ONE_MB_POLICY["targetBytes"]
    tolerance_bytes = min(safe_source, max(target_bytes, round(target_bytes * 1.12))) \
        if safe_source else ONE_MB_POLICY["toleranceBytes"]

    return {
        "mode": "one-mb",
        "label": ONE_MB_POLICY["label"],
        "targetSizeMB": round(target_bytes / (1024 * 1024), 2),
        "targetBytes": target_bytes,
        "maxSizeMB": round(target_bytes / (1024 * 1024), 2),
        "maxSizeBytes": target_bytes,
        "toleranceBytes": tolerance_bytes,
        "outputCeilingBytes": safe_source or ONE_MB_POLICY["targetBytes"],
    }


def estimate_compression_ratio(input_bytes, target_bytes) -> float:
    return max(1, int(input_bytes or 1)) / max(1, int(target_bytes or 1))


def calculate_bitrate(target_size_mb: float, duration_sec: float) -> int:
    if not duration_sec or duration_sec <= 0:
        duration_sec = 1
    target_bits = target_size_mb * 8 * 1024 * 1024
    return int(target_bits / duration_sec / 1000)


def calculate_fps(tier: str, original_fps: float) -> int:
    settings = get_tier_settings(tier)
    min_fps, max_fps = settings["fpsRange"]
    if tier == "ultra":
        return max(1, int(round(original_fps or 24)))
    fps = min(original_fps or 24, max_fps)
    return max(1, int(round(max(fps, min_fps))))


def calculate_resolution(tier: str, original_width: int, original_height: int) -> dict:
    """Fit inside the tier's max dimension, aspect preserved, even dimensions."""
    settings = get_tier_settings(tier)
    max_dim = settings["resolution"]
    ow = max(1, int(original_width or 1))
    oh = max(1, int(original_height or 1))

    if ow <= max_dim and oh <= max_dim:
        return {"width": ow if ow % 2 == 0 else ow - 1,
                "height": oh if oh % 2 == 0 else oh - 1}

    aspect = ow / oh
    if ow >= oh:
        tw, th = max_dim, int(round(max_dim / aspect))
    else:
        th, tw = max_dim, int(round(max_dim * aspect))

    return {"width": tw if tw % 2 == 0 else tw - 1,
            "height": th if th % 2 == 0 else th - 1}


def get_compression_params(tier, width, height, duration, original_fps) -> dict:
    settings = get_tier_settings(tier)
    fps = calculate_fps(tier, original_fps or 24)
    resolution = calculate_resolution(tier, width, height)
    bitrate = calculate_bitrate(settings["maxSizeMB"] * 0.8, duration or 1)
    return {
        "tier": tier,
        "label": settings["label"],
        "maxSizeMB": settings["maxSizeMB"],
        "fps": fps,
        "width": resolution["width"],
        "height": resolution["height"],
        "quality": settings["quality"],
        "bitrateKbps": bitrate,
    }


def get_video_optimization_profile(tier: str, remove_bg: bool = False) -> dict:
    base = VIDEO_OPTIMIZATION_PROFILES.get(tier) or VIDEO_OPTIMIZATION_PROFILES["standard"]
    profile = copy.deepcopy(base)
    # No-background mode can keep richer colours while still optimizing size.
    if not remove_bg and not profile["keepNearLossless"]:
        profile["png"]["palette"] = False
        profile["png"]["quality"] = max(profile["png"]["quality"], 88)
    return profile


def get_size_governance(tier: str) -> dict:
    settings = get_tier_settings(tier)
    tier_max_mb = settings["maxSizeMB"] or VIDEO_SVGA_SIZE_POLICY["hardMaxMB"]
    effective_max_mb = min(tier_max_mb, VIDEO_SVGA_SIZE_POLICY["hardMaxMB"])
    target_max_mb = min(
        effective_max_mb,
        max(VIDEO_SVGA_SIZE_POLICY["preferredMaxMB"], VIDEO_SVGA_SIZE_POLICY["minSizeMB"]),
    )
    return {
        "minBytes": VIDEO_SVGA_SIZE_POLICY["minSizeMB"] * 1024 * 1024,
        "preferredMinBytes": VIDEO_SVGA_SIZE_POLICY["preferredMinMB"] * 1024 * 1024,
        "preferredMaxBytes": VIDEO_SVGA_SIZE_POLICY["preferredMaxMB"] * 1024 * 1024,
        "targetBytes": target_max_mb * 1024 * 1024,
        "maxBytes": effective_max_mb * 1024 * 1024,
    }


def get_retry_plan(tier: str, attempt_index: int, current_fps: float,
                   size_ratio: float = 1.0) -> dict:
    """Progressive keep-ratio / fps / scale back-off for video -> SVGA."""
    settings = get_tier_settings(tier)
    capped = max(1, min(5, attempt_index))
    keep_ratios = [0.92, 0.82, 0.72, 0.60, 0.50]
    fps_ratios = [0.94, 0.86, 0.78, 0.70, 0.62]
    scale_ratios = [1.00, 0.95, 0.90, 0.85, 0.80]

    keep_ratio = keep_ratios[capped - 1]
    fps_ratio = fps_ratios[capped - 1]
    scale_ratio = scale_ratios[capped - 1]

    if size_ratio > 1.6:
        keep_ratio = max(0.35, keep_ratio - 0.08)
        fps_ratio = max(0.50, fps_ratio - 0.08)
        scale_ratio = max(0.72, scale_ratio - 0.08)
    if size_ratio > 2.2:
        keep_ratio = max(0.30, keep_ratio - 0.08)
        fps_ratio = max(0.45, fps_ratio - 0.08)
        scale_ratio = max(0.68, scale_ratio - 0.08)

    return {
        "keepRatio": keep_ratio,
        "scaleRatio": scale_ratio,
        "targetFps": max(settings["fpsRange"][0], int(round(current_fps * fps_ratio))),
    }


# ---------------------------------------------------------------------------
# Per-attempt encoder plans (identical ladders to the Node engine)
# ---------------------------------------------------------------------------
_WEBP_PLANS = [
    {"quality": 96, "compressionLevel": 5, "alphaQuality": 100, "preset": "drawing", "lossless": False, "crThreshold": 0,  "crSize": 16},
    {"quality": 92, "compressionLevel": 5, "alphaQuality": 100, "preset": "drawing", "lossless": False, "crThreshold": 8,  "crSize": 16},
    {"quality": 88, "compressionLevel": 4, "alphaQuality": 96,  "preset": "drawing", "lossless": False, "crThreshold": 12, "crSize": 16},
    {"quality": 82, "compressionLevel": 4, "alphaQuality": 92,  "preset": "drawing", "lossless": False, "crThreshold": 18, "crSize": 24},
    {"quality": 74, "compressionLevel": 4, "alphaQuality": 88,  "preset": "drawing", "lossless": False, "crThreshold": 24, "crSize": 24},
    {"quality": 66, "compressionLevel": 3, "alphaQuality": 82,  "preset": "drawing", "lossless": False, "crThreshold": 30, "crSize": 24},
    {"quality": 58, "compressionLevel": 3, "alphaQuality": 74,  "preset": "drawing", "lossless": False, "crThreshold": 38, "crSize": 32},
    {"quality": 50, "compressionLevel": 3, "alphaQuality": 66,  "preset": "drawing", "lossless": False, "crThreshold": 46, "crSize": 32},
    {"quality": 44, "compressionLevel": 2, "alphaQuality": 58,  "preset": "drawing", "lossless": False, "crThreshold": 56, "crSize": 32},
    {"quality": 38, "compressionLevel": 2, "alphaQuality": 50,  "preset": "drawing", "lossless": False, "crThreshold": 64, "crSize": 32},
]

_GIF_SCALES = [1.0, 0.94, 0.88, 0.82, 0.76, 0.70]
_GIF_DITHER = [5, 4, 4, 3, 3, 2]

# Palette PNG8 quantization ladder for SVGA -> SVGA recompression.
# The optimizer always keeps the SMALLEST of {original, lossless, palette}, so a
# frame can never grow. Images are NEVER resized: rewriting sprite geometry
# breaks playback in native SVGA players.
_SVGA_PLANS = [
    {"colors": 256, "quality": 100},
    {"colors": 256, "quality": 90},
    {"colors": 200, "quality": 80},
    {"colors": 164, "quality": 70},
    {"colors": 128, "quality": 55},
    {"colors": 96,  "quality": 40},
    {"colors": 64,  "quality": 25},
    {"colors": 48,  "quality": 15},
]

# MP4 / alpha-video CRF ladder. Lower CRF = better quality, bigger file.
_H264_CRF = [20, 23, 26, 28, 31, 34, 37, 40]
_VP9_CRF = [28, 31, 34, 37, 40, 44, 48, 52]


def get_max_attempts(fmt: str, one_mb_mode: bool, target_config: dict) -> int:
    """Mirror of the Node attempt budget: 8 normally, 10 for a tiny budget."""
    if not one_mb_mode:
        return 1
    if fmt == "gif":
        return len(_GIF_SCALES)
    if fmt == "svga":
        return len(_SVGA_PLANS)
    if fmt in ("mp4", "alpha-webm", "alpha-mov"):
        return len(_H264_CRF)
    if fmt == "json":
        return 1
    return 10 if (target_config or {}).get("targetBytes", 0) <= 512 * 1024 else 8


def get_one_mb_attempt_plan(fmt: str, attempt_index: int, metadata: dict | None = None,
                            tier: str = "standard", constraints: dict | None = None) -> dict:
    """Resolve encoder parameters for one attempt of the size-targeting loop."""
    metadata = metadata or {}
    constraints = constraints or {}
    settings = get_tier_settings(tier)
    width = metadata.get("width") or metadata.get("viewBoxWidth") or 720
    height = metadata.get("height") or metadata.get("viewBoxHeight") or 720
    target_bytes = int(constraints.get("targetBytes") or ONE_MB_POLICY["targetBytes"])
    source_size_bytes = int(constraints.get("sourceSizeBytes") or ONE_MB_POLICY["targetBytes"])
    tiny_budget = target_bytes <= 512 * 1024 or source_size_bytes <= 512 * 1024

    if fmt == "gif":
        capped = max(1, min(len(_GIF_SCALES), attempt_index))
        return {
            "format": "gif",
            "maxWidth": to_even_number(min(settings["resolution"], width * _GIF_SCALES[capped - 1])),
            "ditherScale": _GIF_DITHER[capped - 1],
            "stripMetadata": True,
        }

    if fmt == "json":
        return {"format": "json", "minifyJson": True, "stripMetadata": True}

    if fmt == "svga":
        capped = max(1, min(len(_SVGA_PLANS), attempt_index))
        plan = _SVGA_PLANS[capped - 1]
        return {
            "format": "svga",
            "stripMetadata": True,
            "removeUnusedAssets": True,
            "dedupeAssets": True,
            # trimTransparent stays OFF: it can shift content in native players.
            "trimTransparent": False,
            "compressionLevel": 9,
            "zlibLevel": 9,
            "colors": plan["colors"],
            "quality": plan["quality"],
        }

    if fmt in ("mp4", "alpha-webm", "alpha-mov"):
        ladder = _VP9_CRF if fmt == "alpha-webm" else _H264_CRF
        capped = max(1, min(len(ladder), attempt_index))
        # Keep the canvas until CRF alone stops paying off.
        scale = 1.0 if capped <= 4 else max(0.7, 1.0 - (capped - 4) * 0.08)
        return {
            "format": fmt,
            "crf": ladder[capped - 1],
            "width": to_even_number(width * scale),
            "height": to_even_number(height * scale),
            "stripMetadata": True,
        }

    capped = max(1, min(10 if tiny_budget else 8, attempt_index))
    plan = _WEBP_PLANS[capped - 1]
    return {
        "format": "webp",
        # Never exceed the tier's own quality ceiling.
        "quality": min(plan["quality"], settings["quality"]),
        "compressionLevel": plan["compressionLevel"],
        # Preserve the original animation canvas in ONE MB mode: size reduction
        # comes from encoder tuning, not canvas shrink.
        "width": max(1, int(round(width))),
        "height": max(1, int(round(height))),
        "alphaQuality": plan["alphaQuality"],
        "preset": plan["preset"],
        "lossless": plan["lossless"],
        "crThreshold": plan["crThreshold"],
        "crSize": plan["crSize"],
        "stripMetadata": True,
    }


def get_default_plan(fmt: str, tier: str = "standard", metadata: dict | None = None) -> dict:
    """Single-shot plan used when no size budget is being chased."""
    metadata = metadata or {}
    settings = get_tier_settings(tier)
    width = metadata.get("width") or metadata.get("viewBoxWidth") or 720
    height = metadata.get("height") or metadata.get("viewBoxHeight") or 720

    if fmt == "gif":
        return {
            "format": "gif",
            "maxWidth": to_even_number(min(settings["resolution"], width)),
            "ditherScale": 5,
            "stripMetadata": True,
        }
    if fmt == "svga":
        return {
            "format": "svga",
            "removeUnusedAssets": True,
            "dedupeAssets": True,
            "trimTransparent": False,
            "compressionLevel": 9,
            "zlibLevel": 9,
            "colors": 256,
            "quality": 100,
        }
    if fmt in ("mp4", "alpha-webm", "alpha-mov"):
        return {
            "format": fmt,
            "crf": 20 if fmt != "alpha-webm" else 28,
            "width": max(1, int(round(width))),
            "height": max(1, int(round(height))),
            "stripMetadata": False,
        }
    return {
        "format": "webp",
        "quality": settings["quality"],
        "compressionLevel": 5,
        "width": max(1, int(round(width))),
        "height": max(1, int(round(height))),
        "alphaQuality": 100,
        "preset": "drawing",
        "lossless": bool(settings.get("lossless")),
        "crThreshold": 0,
        "crSize": 16,
        "stripMetadata": False,
    }


def create_compression_summary(input_size, output_size, target_config, attempts,
                               one_mb_mode=False) -> dict:
    safe_input = max(1, int(input_size or 1))
    safe_output = max(1, int(output_size or 1))
    saved_percent = (1 - (safe_output / safe_input)) * 100
    return {
        "mode": "one-mb" if one_mb_mode else "standard",
        "targetSizeMB": target_config.get("targetSizeMB"),
        "targetMet": safe_output <= target_config.get("toleranceBytes", safe_output),
        "finalSizeMB": round(safe_output / (1024 * 1024), 2),
        "inputSizeMB": round(safe_input / (1024 * 1024), 2),
        "compressionRatio": round(estimate_compression_ratio(safe_input, safe_output), 2),
        "savedPercent": round(saved_percent, 1),
        "attempts": attempts,
    }
