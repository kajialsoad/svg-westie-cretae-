/**
 * AnimSuite Pro - FFmpeg Service
 * Video/image processing using FFmpeg via child_process
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

/**
 * Execute an FFmpeg command and return a promise
 * @param {Array} args - FFmpeg arguments array
 * @returns {Promise} - Resolves when complete
 */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`FFmpeg not found. Please install FFmpeg: ${err.message}`));
    });
  });
}

/**
 * Check if FFmpeg is available
 * @returns {Promise<boolean>}
 */
async function checkFFmpeg() {
  try {
    await runFFmpeg(['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract frames from a video file
 * @param {string} inputPath - Path to video file
 * @param {string} outputDir - Directory to save frames
 * @param {Object} options - { fps, maxWidth }
 * @returns {Promise<string[]>} - Array of frame file paths
 */
async function extractFrames(inputPath, outputDir, options = {}) {
  const fps = options.fps || 24;
  const maxWidth = options.maxWidth || 720;

  fs.mkdirSync(outputDir, { recursive: true });

  const outputPattern = path.join(outputDir, 'frame_%04d.png');

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', `fps=${fps},scale=${maxWidth}:-1:flags=lanczos`,
    '-pix_fmt', 'rgba',
    outputPattern,
  ];

  await runFFmpeg(args);

  // Read generated frames
  const files = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
    .sort()
    .map(f => path.join(outputDir, f));

  return files;
}

/**
 * Remove background from a frame using color key
 * @param {string} inputPath - Input frame path
 * @param {string} outputPath - Output frame path
 * @param {Object} options - { bgColor, similarity, blend }
 */
async function removeBackground(inputPath, outputPath, options = {}) {
  const bgColor = options.bgColor || 'white';
  const similarity = options.similarity || 0.3;
  const blend = options.blend || 0.2;

  // If bgColor is 'none', just copy the file without processing
  if (bgColor.toLowerCase() === 'none') {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  let filterStr;

  switch (bgColor.toLowerCase()) {
    case 'green':
      filterStr = `chromakey=0x00FF00:${similarity}:${blend},format=rgba`;
      break;
    case 'black':
      filterStr = `colorkey=0x000000:${similarity}:${blend},format=rgba`;
      break;
    case 'white':
    default:
      filterStr = `colorkey=0xFFFFFF:${similarity}:${blend},format=rgba`;
      break;
  }

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', filterStr,
    '-pix_fmt', 'rgba',
    outputPath,
  ];

  await runFFmpeg(args);
}

/**
 * Remove background from all frames in a directory
 * @param {string[]} framePaths - Array of frame file paths
 * @param {string} outputDir - Output directory for processed frames
 * @param {Object} options - { bgColor, similarity, blend }
 * @returns {Promise<string[]>} - Array of processed frame paths
 */
async function removeBackgroundBatch(framePaths, outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const processedPaths = [];

  for (let i = 0; i < framePaths.length; i++) {
    const outputPath = path.join(outputDir, `processed_${String(i + 1).padStart(4, '0')}.png`);
    await removeBackground(framePaths[i], outputPath, options);
    processedPaths.push(outputPath);
  }

  return processedPaths;
}

/**
 * Convert frames to animated WebP
 * @param {string} framesDir - Directory containing frame PNGs
 * @param {string} outputPath - Output WebP path
 * @param {Object} options - { fps, quality, loop }
 */
async function framesToWebP(framesDir, outputPath, options = {}) {
  const fps = options.fps || 24;
  const quality = options.quality || 80;
  const loop = options.loop !== undefined ? options.loop : 0;

  const inputPattern = path.join(framesDir, '*.png');

  const args = [
    '-y',
    '-framerate', String(fps),
    '-pattern_type', 'glob',
    '-i', inputPattern,
    '-vcodec', 'libwebp',
    '-lossless', '0',
    '-compression_level', '4',
    '-quality', String(quality),
    '-loop', String(loop),
    '-an',
    outputPath,
  ];

  await runFFmpeg(args);
}

/**
 * Convert frames to animated WebP (Windows compatible - no glob)
 * @param {string} framesDir - Directory containing sequential PNGs
 * @param {string} prefix - Frame filename prefix (e.g., 'processed_')
 * @param {string} outputPath - Output WebP path
 * @param {Object} options - { fps, quality, loop }
 */
async function framesToWebPSequence(framesDir, prefix, outputPath, options = {}) {
  const fps = options.fps || 24;
  const quality = options.quality || 90;
  const loop = options.loop !== undefined ? options.loop : 0;

  const inputPattern = path.join(framesDir, `${prefix}%04d.png`);

  const args = [
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
    '-vcodec', 'libwebp_anim',
    '-lossless', '1',
    '-compression_level', '4',
    '-quality', '100',
    '-loop', String(loop),
    '-an',
    '-pix_fmt', 'rgba',
    outputPath,
  ];

  await runFFmpeg(args);
}

/**
 * Convert frames to GIF
 * @param {string} framesDir - Directory containing sequential PNGs
 * @param {string} prefix - Frame filename prefix
 * @param {string} outputPath - Output GIF path
 * @param {Object} options - { fps, maxWidth }
 */
async function framesToGIF(framesDir, prefix, outputPath, options = {}) {
  const fps = options.fps || 15;
  const maxWidth = options.maxWidth || 480;

  const inputPattern = path.join(framesDir, `${prefix}%04d.png`);
  const palettePath = path.join(framesDir, 'palette.png');

  // Step 1: Generate palette
  await runFFmpeg([
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
    '-vf', `fps=${fps},scale=${maxWidth}:-1:flags=lanczos,palettegen=stats_mode=diff`,
    palettePath,
  ]);

  // Step 2: Create GIF with palette
  await runFFmpeg([
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
    '-i', palettePath,
    '-lavfi', `fps=${fps},scale=${maxWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0',
    outputPath,
  ]);

  // Cleanup palette
  try { fs.unlinkSync(palettePath); } catch { }
}

/**
 * Get video metadata (duration, resolution, etc.)
 * @param {string} inputPath - Path to video file
 * @returns {Promise<Object>} - { duration, width, height, fps }
 */
async function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];

    const proc = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      try {
        const info = JSON.parse(stdout);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video') || {};
        resolve({
          duration: parseFloat(info.format?.duration || 0),
          width: parseInt(videoStream.width || 0),
          height: parseInt(videoStream.height || 0),
          fps: eval(videoStream.r_frame_rate || '24') || 24,
        });
      } catch {
        resolve({ duration: 10, width: 720, height: 720, fps: 24 });
      }
    });

    proc.on('error', () => {
      resolve({ duration: 10, width: 720, height: 720, fps: 24 });
    });
  });
}

/**
 * Create a temporary directory for a job
 * @param {string} jobId - Job identifier
 * @returns {string} - Path to temp directory
 */
function createTempDir(jobId) {
  const tempDir = path.join(os.tmpdir(), 'animsuite', jobId);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up temp directory
 * @param {string} tempDir - Path to temp directory
 */
function cleanupTempDir(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

module.exports = {
  runFFmpeg,
  checkFFmpeg,
  extractFrames,
  removeBackground,
  removeBackgroundBatch,
  framesToWebP,
  framesToWebPSequence,
  framesToGIF,
  getVideoInfo,
  createTempDir,
  cleanupTempDir,
};
