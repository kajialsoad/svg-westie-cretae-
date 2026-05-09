/**
 * AnimSuite Pro - FFmpeg Service
 * Video/image processing using FFmpeg via child_process
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

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
 * @param {Object} options - { fps, maxWidth, pixFmt }
 * @returns {Promise<string[]>} - Array of frame file paths
 */
async function extractFrames(inputPath, outputDir, options = {}) {
  const fps = options.fps || 24;
  const maxWidth = options.maxWidth || 720;
  const pixFmt = options.pixFmt || 'rgba';

  fs.mkdirSync(outputDir, { recursive: true });

  const outputPattern = path.join(outputDir, 'frame_%04d.png');

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', `fps=${fps},scale=${maxWidth}:-1:flags=lanczos`,
    '-sws_flags', 'lanczos+accurate_rnd',
    '-pix_fmt', pixFmt,
    '-frame_pts', '1',
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
    case 'blue':
      filterStr = `chromakey=0x0000FF:${similarity}:${blend},format=rgba`;
      break;
    case 'black':
      filterStr = `colorkey=0x000000:${similarity}:${blend},format=rgba`;
      break;
    case 'white':
      filterStr = `colorkey=0xFFFFFF:${similarity}:${blend},format=rgba`;
      break;
    case 'auto_detected':
      filterStr = `colorkey=${options.detectedHex.replace('#', '0x')}:${similarity}:${blend},format=rgba`;
      break;
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

  if (options.bgColor === 'auto' && framePaths.length > 0) {
    try {
      const frameImg = sharp(framePaths[0]);
      const { width: fw, height: fh } = await frameImg.metadata();
      const sampleDepth = Math.min(10, Math.floor(fw * 0.05)); // 5% depth or 10px max

      // Sample all 4 edges, 1px strips
      const regions = [
        { left: 0, top: 0, width: fw, height: sampleDepth },              // top edge
        { left: 0, top: fh - sampleDepth, width: fw, height: sampleDepth }, // bottom edge
        { left: 0, top: 0, width: sampleDepth, height: fh },              // left edge
        { left: fw - sampleDepth, top: 0, width: sampleDepth, height: fh }, // right edge
      ];

      const colorCounts = {};
      let totalAlpha = 0;
      let totalSamples = 0;

      for (const region of regions) {
        const { data, info } = await sharp(framePaths[0])
          .extract(region)
          .resize(8, 8, { fit: 'fill' }) // downsample to 8x8 for speed
          .raw()
          .toBuffer({ resolveWithObject: true });

        const channels = info.channels; // 3=RGB, 4=RGBA
        const pixels = data.length / channels;

        for (let i = 0; i < pixels; i++) {
          const r = data[i * channels];
          const g = data[i * channels + 1];
          const b = data[i * channels + 2];
          const a = channels === 4 ? data[i * channels + 3] : 255;

          totalAlpha += a;
          totalSamples++;

          // Quantize to nearest 16 for grouping similar colors, clamped to 255
          const qr = Math.min(255, Math.round(r / 16) * 16);
          const qg = Math.min(255, Math.round(g / 16) * 16);
          const qb = Math.min(255, Math.round(b / 16) * 16);
          const key = `${qr},${qg},${qb}`;
          colorCounts[key] = (colorCounts[key] || 0) + 1;
        }
      }

      const avgAlpha = totalSamples > 0 ? totalAlpha / totalSamples : 255;

      if (avgAlpha < 10) {
        // Already transparent
        console.log('Auto-Detect: Video already has transparent background.');
        options.bgColor = 'none';
      } else {
        // Pick dominant edge color
        const dominantKey = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0][0];
        const [r, g, b] = dominantKey.split(',').map(Number);
        const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        console.log(`Auto-Detect: Dominant background color detected as ${hex} (from edge sampling)`);
        options.bgColor = 'auto_detected';
        options.detectedHex = hex;
      }
    } catch (e) {
      console.warn('Auto-Detect Warning: Failed to sample background color. Skipping removal.', e.message);
      options.bgColor = 'none';
    }
  }

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
    '-lossless', '0',
    '-compression_level', '6',
    '-quality', String(quality),
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
        const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');
        resolve({
          duration: parseFloat(info.format?.duration || 0),
          width: parseInt(videoStream.width || 0),
          height: parseInt(videoStream.height || 0),
          fps: eval(videoStream.r_frame_rate || '24') || 24,
          hasAudio: !!audioStream,
        });
      } catch {
        resolve({ duration: 10, width: 720, height: 720, fps: 24, hasAudio: false });
      }
    });

    proc.on('error', () => {
      resolve({ duration: 10, width: 720, height: 720, fps: 24, hasAudio: false });
    });
  });
}

/**
 * Extract audio from a video file as MP3
 * @param {string} inputPath - Path to video file
 * @param {string} outputPath - Path to save MP3
 * @returns {Promise<boolean>} - Success or failure
 */
async function extractAudio(inputPath, outputPath) {
  const args = [
    '-y',
    '-i', inputPath,
    '-vn', // No video
    '-acodec', 'libmp3lame',
    '-ab', '128k',
    '-ar', '44100',
    outputPath,
  ];

  try {
    await runFFmpeg(args);
    return true;
  } catch (e) {
    console.warn('Audio extraction failed:', e.message);
    return false;
  }
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
  extractAudio,
  createTempDir,
  cleanupTempDir,
};
