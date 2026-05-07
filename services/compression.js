/**
 * AnimSuite Pro - Smart Compression Engine
 * Controls output file size (5MB / 10MB / 15MB)
 */

const fs = require('fs');

// Size tier configurations
const SIZE_TIERS = {
  lite: {
    label: 'Lite',
    maxSizeMB: 5,
    maxSizeBytes: 5 * 1024 * 1024,
    resolution: 480,
    fpsRange: [10, 15],
    quality: 50,
  },
  standard: {
    label: 'Standard',
    maxSizeMB: 10,
    maxSizeBytes: 10 * 1024 * 1024,
    resolution: 720,
    fpsRange: [15, 20],
    quality: 70,
  },
  high: {
    label: 'High Quality',
    maxSizeMB: 15,
    maxSizeBytes: 15 * 1024 * 1024,
    resolution: 720,
    fpsRange: [20, 24],
    quality: 85,
  },
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

  // Cap to tier's max FPS
  let fps = Math.min(originalFps, maxFps);
  // Ensure minimum
  fps = Math.max(fps, minFps);

  return fps;
}

/**
 * Calculate optimal resolution for a given tier
 * @param {string} tier - Size tier
 * @param {number} originalWidth - Original video width
 * @param {number} originalHeight - Original video height
 * @returns {Object} - { width, height }
 */
function calculateResolution(tier, originalWidth, originalHeight) {
  const settings = getTierSettings(tier);
  const maxDim = settings.resolution;

  if (originalWidth <= maxDim && originalHeight <= maxDim) {
    return { width: originalWidth, height: originalHeight };
  }

  const aspect = originalWidth / originalHeight;

  if (originalWidth > originalHeight) {
    return {
      width: maxDim,
      height: Math.round(maxDim / aspect),
    };
  } else {
    return {
      width: Math.round(maxDim * aspect),
      height: maxDim,
    };
  }
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
 * @param {Object} videoInfo - { duration, width, height, fps }
 * @returns {Object} - Full compression settings
 */
function getCompressionParams(tier, videoInfo) {
  const settings = getTierSettings(tier);
  const fps = calculateFPS(tier, videoInfo.fps);
  const resolution = calculateResolution(tier, videoInfo.width, videoInfo.height);
  const bitrate = calculateBitrate(settings.maxSizeMB * 0.8, videoInfo.duration); // 80% target for safety

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

module.exports = {
  SIZE_TIERS,
  getTierSettings,
  calculateBitrate,
  calculateFPS,
  calculateResolution,
  checkSizeRequirement,
  getCompressionParams,
};
