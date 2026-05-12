/**
 * AnimSuite Pro - Smart Compression Engine
 * Controls output file size with strict governance.
 */

const fs = require('fs');

// Size tier configurations
const SIZE_TIERS = {
  lite: {
    label: 'Lite',
    maxSizeMB: 5,
    maxSizeBytes: 5 * 1024 * 1024,
    resolution: 480,
    fpsRange: [15, 30],
    quality: 60,
  },
  standard: {
    label: 'Standard',
    maxSizeMB: 10,
    maxSizeBytes: 10 * 1024 * 1024,
    resolution: 720,
    fpsRange: [20, 30],
    quality: 70,
  },
  high: {
    label: 'High Quality',
    maxSizeMB: 15,
    maxSizeBytes: 15 * 1024 * 1024,
    resolution: 1080,
    fpsRange: [24, 60],
    quality: 85,
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
};

/**
 * Get compression settings for a size tier
 * @param {string} tier - 'lite', 'standard', or 'high'
 * @returns {Object} - Compression settings
 */
function getTierSettings(tier) {
  return SIZE_TIERS[tier] || SIZE_TIERS.standard;
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

module.exports = {
  SIZE_TIERS,
  getTierSettings,
  calculateBitrate,
  calculateFPS,
  calculateResolution,
  checkSizeRequirement,
  getCompressionParams,
  getVideoOptimizationProfile,
  getSizeGovernance,
  getRetryPlan,
};
