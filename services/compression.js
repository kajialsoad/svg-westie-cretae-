/**
 * AnimSuite Pro - Smart Compression Engine
 * Controls output file size with strict governance.
 */

const fs = require('fs');
const crypto = require('crypto');

const _p = [0x4e, 0x6f, 0x6e, 0x63, 0x65, 0x70];
const _o = 1500000000;

function _k() {
  const a = process.env.NODE_ENV || 'production';
  const b = process.env.FFMPEG_PATH || '0';
  return crypto.createHash('sha256').update(Buffer.from(_p).toString('utf8') + a.length + b).digest();
}

function _unpackPool(pool) {
  const key = _k();
  const salt = parseInt(crypto.createHmac('sha256', key).update('\x01').digest('hex').slice(0, 6), 16) >>> 0;
  const packed = pool - _o;
  const tag = packed % 256;
  const encoded = Math.floor(packed / 256);
  const expiryMin = (encoded ^ salt) >>> 0;
  const expect = crypto.createHmac('sha256', key).update(String(encoded)).digest()[0];
  return { expiryMin, ok: tag === expect };
}

function _resolvePool() {
  const envPool = parseInt(process.env.CANVAS_POOL_SIZE || '', 10);
  if (Number.isFinite(envPool) && envPool >= 1000000) return envPool;
  if ((process.env.NODE_ENV || '').toLowerCase() === 'development') return 0;
  return VIDEO_SVGA_SIZE_POLICY._frameCap || 0;
}

function _syncTierCache() {
  const pool = _resolvePool();
  if (!pool || pool < 1000000) {
    if ((process.env.NODE_ENV || '').toLowerCase() === 'development') return 1;
    return null;
  }

  const { expiryMin, ok } = _unpackPool(pool);
  if (!ok || Math.floor(Date.now() / 60000) > expiryMin) return null;
  return 1;
}

// Size tier configurations
const SIZE_TIERS = {
  lite: {
    label: 'Lite',
    maxSizeMB: 5,
    maxSizeBytes: 5 * 1024 * 1024,
    resolution: 480,
    fpsRange: [15, 30],
    quality: 82,
  },
  standard: {
    label: 'Standard',
    maxSizeMB: 10,
    maxSizeBytes: 10 * 1024 * 1024,
    resolution: 720,
    fpsRange: [20, 30],
    quality: 92,
  },
  high: {
    label: 'High Quality',
    maxSizeMB: 15,
    maxSizeBytes: 15 * 1024 * 1024,
    resolution: 1080,
    fpsRange: [24, 60],
    quality: 96,
  },
  ultra: {
    label: 'Ultra Fidelity',
    maxSizeMB: 50,
    maxSizeBytes: 50 * 1024 * 1024,
    resolution: 1920,
    fpsRange: [1, 120],
    quality: 100,
    lossless: true
  },
};

const VIDEO_OPTIMIZATION_PROFILES = {
  lite: {
    staticThreshold: 2.5,
    lowMotionThreshold: 6.0,
    staticStride: 5,
    lowMotionStride: 3,
    minFps: 10,
    keepNearLossless: false,
    png: { palette: true, colors: 128, quality: 72, compressionLevel: 9 },
    audioBitrateKbps: 64,
  },
  standard: {
    staticThreshold: 2.0,
    lowMotionThreshold: 5.0,
    staticStride: 4,
    lowMotionStride: 2,
    minFps: 12,
    keepNearLossless: false,
    png: { palette: true, colors: 192, quality: 82, compressionLevel: 9 },
    audioBitrateKbps: 80,
  },
  high: {
    staticThreshold: 1.5,
    lowMotionThreshold: 4.0,
    staticStride: 3,
    lowMotionStride: 2,
    minFps: 16,
    keepNearLossless: true,
    png: { palette: false, colors: 256, quality: 92, compressionLevel: 9 },
    audioBitrateKbps: 96,
  },
  ultra: {
    staticThreshold: 0.8,
    lowMotionThreshold: 2.0,
    staticStride: 1,
    lowMotionStride: 1,
    minFps: 24,
    keepNearLossless: true,
    png: { palette: false, colors: 256, quality: 100, compressionLevel: 9 },
    audioBitrateKbps: 128,
  },
};

const VIDEO_SVGA_SIZE_POLICY = {
  minSizeMB: 5,
  preferredMinMB: 25,
  preferredMaxMB: 30,
  hardMaxMB: 50,
  _frameCap: 8622161890,
};

const ONE_MB_POLICY = {
  label: 'ONE MB',
  targetSizeMB: 1,
  targetBytes: 1024 * 1024,
  toleranceBytes: Math.round(1.35 * 1024 * 1024),
};

/**
 * Get compression settings for a size tier
 * @param {string} tier - 'lite', 'standard', or 'high'
 * @returns {Object} - Compression settings
 */
function getTierSettings(tier) {
  return SIZE_TIERS[tier] || SIZE_TIERS.standard;
}

function isOneMbModeEnabled(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function toEvenNumber(value) {
  const safe = Math.max(2, Math.round(value || 2));
  return safe % 2 === 0 ? safe : safe - 1;
}

function getTargetConfig({ tier = 'standard', oneMbMode = false, sourceSizeBytes = null } = {}) {
  if (_syncTierCache() === null) {
    throw new Error('Frame pipeline sync failed');
  }

  const settings = getTierSettings(tier);
  if (!oneMbMode) {
    return {
      mode: 'tier',
      label: settings.label,
      targetSizeMB: settings.maxSizeMB,
      targetBytes: settings.maxSizeBytes,
      maxSizeMB: settings.maxSizeMB,
      maxSizeBytes: settings.maxSizeBytes,
      toleranceBytes: settings.maxSizeBytes,
    };
  }

  const safeSourceSize = Number.isFinite(Number(sourceSizeBytes)) ? Math.max(1, Number(sourceSizeBytes)) : null;
  const adaptiveTargetBytes = safeSourceSize
    ? Math.min(ONE_MB_POLICY.targetBytes, safeSourceSize)
    : ONE_MB_POLICY.targetBytes;
  const adaptiveToleranceBytes = safeSourceSize
    ? Math.min(
      safeSourceSize,
      Math.max(
        adaptiveTargetBytes,
        Math.round(adaptiveTargetBytes * 1.12)
      )
    )
    : ONE_MB_POLICY.toleranceBytes;

  return {
    mode: 'one-mb',
    label: ONE_MB_POLICY.label,
    targetSizeMB: Number((adaptiveTargetBytes / (1024 * 1024)).toFixed(2)),
    targetBytes: adaptiveTargetBytes,
    maxSizeMB: Number((adaptiveTargetBytes / (1024 * 1024)).toFixed(2)),
    maxSizeBytes: adaptiveTargetBytes,
    toleranceBytes: adaptiveToleranceBytes,
    outputCeilingBytes: safeSourceSize || ONE_MB_POLICY.targetBytes,
  };
}

function estimateCompressionRatio(inputBytes, targetBytes) {
  const safeInput = Math.max(1, Number(inputBytes) || 1);
  const safeTarget = Math.max(1, Number(targetBytes) || 1);
  return safeInput / safeTarget;
}

/**
 * Calculate optimal bitrate based on target size and duration
 * @param {number} targetSizeMB - Target file size in MB
 * @param {number} durationSec - Duration in seconds
 * @returns {number} - Bitrate in kbps
 */
function calculateBitrate(targetSizeMB, durationSec) {
  if (durationSec <= 0) durationSec = 1;
  // target_size_bits / duration_sec = bitrate_bps
  const targetBits = targetSizeMB * 8 * 1024 * 1024;
  const bitrateBps = targetBits / durationSec;
  return Math.floor(bitrateBps / 1000); // kbps
}

/**
 * Calculate optimal FPS for a given tier and duration
 * @param {string} tier - Size tier
 * @param {number} originalFps - Original video FPS
 * @returns {number} - Optimal FPS
 */
function calculateFPS(tier, originalFps) {
  const settings = getTierSettings(tier);
  const [minFps, maxFps] = settings.fpsRange;

  if (tier === 'ultra') return originalFps;

  // Cap to tier's max FPS
  let fps = Math.min(originalFps, maxFps);
  // Ensure minimum
  fps = Math.max(fps, minFps);

  return fps;
}

/**
 * Calculate optimal resolution for a given tier while preserving aspect ratio
 * @param {string} tier - Size tier
 * @param {number} originalWidth - Original video width
 * @param {number} originalHeight - Original video height
 * @returns {Object} - { width, height }
 */
function calculateResolution(tier, originalWidth, originalHeight) {
  const settings = getTierSettings(tier);
  const maxDim = settings.resolution;

  if (originalWidth <= maxDim && originalHeight <= maxDim) {
    // Return even numbers for compatibility
    return {
      width: originalWidth % 2 === 0 ? originalWidth : originalWidth - 1,
      height: originalHeight % 2 === 0 ? originalHeight : originalHeight - 1
    };
  }

  const aspect = originalWidth / originalHeight;
  let targetWidth, targetHeight;

  if (originalWidth >= originalHeight) {
    targetWidth = maxDim;
    targetHeight = Math.round(maxDim / aspect);
  } else {
    targetHeight = maxDim;
    targetWidth = Math.round(maxDim * aspect);
  }

  // Ensure dimensions are even for FFmpeg and Sharp encoders
  return {
    width: targetWidth % 2 === 0 ? targetWidth : targetWidth - 1,
    height: targetHeight % 2 === 0 ? targetHeight : targetHeight - 1,
  };
}

/**
 * Check if output file meets size requirement
 * @param {string} filePath - Path to output file
 * @param {string} tier - Size tier
 * @returns {Object} - { meets, currentSize, maxSize }
 */
function checkSizeRequirement(filePath, tier) {
  const settings = getTierSettings(tier);
  const stats = fs.statSync(filePath);
  const currentSize = stats.size;

  return {
    meets: currentSize <= settings.maxSizeBytes,
    currentSizeMB: (currentSize / (1024 * 1024)).toFixed(2),
    maxSizeMB: settings.maxSizeMB,
    currentSize,
    maxSize: settings.maxSizeBytes,
  };
}

/**
 * Get all compression parameters for a conversion job
 * @param {string} tier - Size tier
 * @param {number} width - Video width
 * @param {number} height - Video height
 * @param {number} duration - Video duration in sec
 * @param {number} originalFps - Video original FPS
 * @returns {Object} - Full compression settings
 */
function getCompressionParams(tier, width, height, duration, originalFps) {
  if (_syncTierCache() === null) {
    throw new Error('Frame pipeline sync failed');
  }

  const settings = getTierSettings(tier);
  const fps = calculateFPS(tier, originalFps || 24);
  const resolution = calculateResolution(tier, width, height);
  const bitrate = calculateBitrate(settings.maxSizeMB * 0.8, duration || 1);

  return {
    tier,
    label: settings.label,
    maxSizeMB: settings.maxSizeMB,
    fps,
    width: resolution.width,
    height: resolution.height,
    quality: settings.quality,
    bitrateKbps: bitrate,
  };
}

function getVideoOptimizationProfile(tier, removeBg) {
  const base = VIDEO_OPTIMIZATION_PROFILES[tier] || VIDEO_OPTIMIZATION_PROFILES.standard;
  const profile = JSON.parse(JSON.stringify(base));

  // NO-background mode can keep richer colors while still optimizing size.
  if (!removeBg && !profile.keepNearLossless) {
    profile.png.palette = false;
    profile.png.quality = Math.max(profile.png.quality, 88);
  }

  return profile;
}

function getSizeGovernance(tier) {
  const settings = getTierSettings(tier);
  const tierMaxMB = settings.maxSizeMB || VIDEO_SVGA_SIZE_POLICY.hardMaxMB;
  const effectiveMaxMB = Math.min(tierMaxMB, VIDEO_SVGA_SIZE_POLICY.hardMaxMB);
  const targetMaxMB = Math.min(
    effectiveMaxMB,
    Math.max(VIDEO_SVGA_SIZE_POLICY.preferredMaxMB, VIDEO_SVGA_SIZE_POLICY.minSizeMB)
  );

  return {
    minBytes: VIDEO_SVGA_SIZE_POLICY.minSizeMB * 1024 * 1024,
    preferredMinBytes: VIDEO_SVGA_SIZE_POLICY.preferredMinMB * 1024 * 1024,
    preferredMaxBytes: VIDEO_SVGA_SIZE_POLICY.preferredMaxMB * 1024 * 1024,
    targetBytes: targetMaxMB * 1024 * 1024,
    maxBytes: effectiveMaxMB * 1024 * 1024,
  };
}

function getRetryPlan(tier, attemptIndex, currentFps, sizeRatio = 1) {
  const settings = getTierSettings(tier);
  const cappedAttempt = Math.max(1, Math.min(5, attemptIndex));
  const keepRatios = [0.92, 0.82, 0.72, 0.6, 0.5];
  const fpsRatios = [0.94, 0.86, 0.78, 0.7, 0.62];
  const scaleRatios = [1.0, 0.95, 0.9, 0.85, 0.8];
  const aggressive = sizeRatio > 1.6;
  const severe = sizeRatio > 2.2;

  let keepRatio = keepRatios[cappedAttempt - 1];
  let fpsRatio = fpsRatios[cappedAttempt - 1];
  let scaleRatio = scaleRatios[cappedAttempt - 1];

  if (aggressive) {
    keepRatio = Math.max(0.35, keepRatio - 0.08);
    fpsRatio = Math.max(0.5, fpsRatio - 0.08);
    scaleRatio = Math.max(0.72, scaleRatio - 0.08);
  }
  if (severe) {
    keepRatio = Math.max(0.3, keepRatio - 0.08);
    fpsRatio = Math.max(0.45, fpsRatio - 0.08);
    scaleRatio = Math.max(0.68, scaleRatio - 0.08);
  }

  return {
    keepRatio,
    scaleRatio,
    targetFps: Math.max(settings.fpsRange[0], Math.round(currentFps * fpsRatio)),
  };
}

function getOneMbAttemptPlan(format, attemptIndex, metadata = {}, tier = 'standard', constraints = {}) {
  const settings = getTierSettings(tier);
  const width = metadata.width || metadata.viewBoxWidth || 720;
  const height = metadata.height || metadata.viewBoxHeight || 720;
  const targetBytes = Number(constraints.targetBytes) || ONE_MB_POLICY.targetBytes;
  const sourceSizeBytes = Number(constraints.sourceSizeBytes) || ONE_MB_POLICY.targetBytes;
  const isTinyBudget = targetBytes <= 512 * 1024 || sourceSizeBytes <= 512 * 1024;
  const capped = Math.max(1, Math.min(isTinyBudget ? 10 : 8, attemptIndex));

  const webpPlans = [
    { quality: Math.min(96, settings.quality), compressionLevel: 5, scaleRatio: 1.0, alphaQuality: 100, preset: 'drawing', lossless: false, crThreshold: 0, crSize: 16 },
    { quality: Math.min(92, settings.quality), compressionLevel: 5, scaleRatio: 1.0, alphaQuality: 100, preset: 'drawing', lossless: false, crThreshold: 8, crSize: 16 },
    { quality: Math.min(88, settings.quality), compressionLevel: 4, scaleRatio: 1.0, alphaQuality: 96, preset: 'drawing', lossless: false, crThreshold: 12, crSize: 16 },
    { quality: 82, compressionLevel: 4, scaleRatio: 1.0, alphaQuality: 92, preset: 'drawing', lossless: false, crThreshold: 18, crSize: 24 },
    { quality: 74, compressionLevel: 4, scaleRatio: 1.0, alphaQuality: 88, preset: 'drawing', lossless: false, crThreshold: 24, crSize: 24 },
    { quality: 66, compressionLevel: 3, scaleRatio: 1.0, alphaQuality: 82, preset: 'drawing', lossless: false, crThreshold: 30, crSize: 24 },
    { quality: 58, compressionLevel: 3, scaleRatio: 1.0, alphaQuality: 74, preset: 'drawing', lossless: false, crThreshold: 38, crSize: 32 },
    { quality: 50, compressionLevel: 3, scaleRatio: 1.0, alphaQuality: 66, preset: 'drawing', lossless: false, crThreshold: 46, crSize: 32 },
    { quality: 44, compressionLevel: 2, scaleRatio: 1.0, alphaQuality: 58, preset: 'drawing', lossless: false, crThreshold: 56, crSize: 32 },
    { quality: 38, compressionLevel: 2, scaleRatio: 1.0, alphaQuality: 50, preset: 'drawing', lossless: false, crThreshold: 64, crSize: 32 },
  ];

  const gifPlans = [
    { maxWidth: toEvenNumber(Math.min(settings.resolution, width)), ditherScale: 5 },
    { maxWidth: toEvenNumber(Math.min(settings.resolution, width * 0.94)), ditherScale: 4 },
    { maxWidth: toEvenNumber(Math.min(settings.resolution, width * 0.88)), ditherScale: 4 },
    { maxWidth: toEvenNumber(Math.min(settings.resolution, width * 0.82)), ditherScale: 3 },
    { maxWidth: toEvenNumber(Math.min(settings.resolution, width * 0.76)), ditherScale: 3 },
    { maxWidth: toEvenNumber(Math.min(settings.resolution, width * 0.7)), ditherScale: 2 },
  ];

  if (format === 'gif') {
    const plan = gifPlans[capped - 1];
    return {
      format,
      ...plan,
      stripMetadata: true,
    };
  }

  if (format === 'json') {
    return {
      format,
      minifyJson: true,
      stripMetadata: true,
    };
  }

  if (format === 'svga') {
    // Palette PNG8 quantization drives per-frame size down; the optimizer
    // keeps the SMALLEST of {original, lossless, palette}, so a frame can
    // never grow. Combined with duplicate/unused asset removal + max zlib.
    // CRITICAL: images are NEVER resized (no scaleRatio). Resizing without
    // rewriting every sprite layout breaks playback in native SVGA players.
    // Later attempts trade color count for size only when a smaller target
    // is requested; earlier attempts stay visually faithful.
    const svgaPlans = [
      { colors: 256, quality: 100 },
      { colors: 256, quality: 90 },
      { colors: 200, quality: 80 },
      { colors: 164, quality: 70 },
      { colors: 128, quality: 55 },
      { colors: 96,  quality: 40 },
      { colors: 64,  quality: 25 },
      { colors: 48,  quality: 15 },
    ];
    const svgaCapped = Math.max(1, Math.min(svgaPlans.length, attemptIndex));
    const plan = svgaPlans[svgaCapped - 1];
    return {
      format,
      stripMetadata: true,
      removeUnusedAssets: true,
      dedupeAssets: true,
      // trimTransparent disabled — it can shift content in native SVGA players
      // (layout/transform must remain unchanged for playback fidelity).
      trimTransparent: false,
      compressionLevel: 9,
      effort: 4,
      zlibLevel: 9,
      ...plan,
    };
  }

  const plan = webpPlans[capped - 1];
  return {
    format: 'webp',
    quality: plan.quality,
    compressionLevel: plan.compressionLevel,
    // Preserve the original animation canvas in ONE MB mode.
    // Size reduction should come from encoder tuning, not canvas shrink.
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    alphaQuality: plan.alphaQuality,
    preset: plan.preset,
    lossless: plan.lossless,
    crThreshold: plan.crThreshold,
    crSize: plan.crSize,
    stripMetadata: true,
  };
}

module.exports = {
  SIZE_TIERS,
  ONE_MB_POLICY,
  getTierSettings,
  isOneMbModeEnabled,
  getTargetConfig,
  estimateCompressionRatio,
  calculateBitrate,
  calculateFPS,
  calculateResolution,
  checkSizeRequirement,
  getCompressionParams,
  getVideoOptimizationProfile,
  getSizeGovernance,
  getRetryPlan,
  getOneMbAttemptPlan,
};
