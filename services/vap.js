/**
 * VAP (AlphaPlayer) encode / decode.
 * Packed layout: left alpha + right RGB (or top alpha + bottom RGB).
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpegService = require('./ffmpeg');

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v % 2 === 0 ? v : v + 1;
}

function detectVapLayout(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w >= 4 && w % 2 === 0 && h > 0 && w / h >= 1.85) return 'lr-alpha-rgb';
  if (h >= 4 && h % 2 === 0 && w > 0 && h / w >= 1.85) return 'tb-alpha-rgb';
  return 'none';
}

function qualityPreset(quality) {
  const q = String(quality || 'medium').toLowerCase();
  if (q === 'low') return { webpQuality: 52, bitrateMbps: 2, maxDim: 360, fpsCap: 15 };
  if (q === 'high') return { webpQuality: 90, bitrateMbps: 8, maxDim: 1080, fpsCap: 60 };
  return { webpQuality: 75, bitrateMbps: 4, maxDim: 540, fpsCap: 30 };
}

function resolveMaxDim(resolution, quality) {
  const preset = qualityPreset(quality);
  if (!resolution || resolution === 'original') return preset.maxDim;
  const n = parseInt(resolution, 10);
  return Number.isFinite(n) && n > 0 ? n : preset.maxDim;
}

function vapFilter(layout, fps) {
  const rate = Math.max(1, Math.min(60, Number(fps) || 24));
  if (layout === 'lr-alpha-rgb') {
    return `fps=${rate},split[a][c];[a]crop=iw/2:ih:0:0,format=gray[al];[c]crop=iw/2:ih:iw/2:0[rgb];[rgb][al]alphamerge,format=rgba`;
  }
  if (layout === 'tb-alpha-rgb') {
    return `fps=${rate},split[a][c];[a]crop=iw:ih/2:0:0,format=gray[al];[c]crop=iw:ih/2:0:ih/2[rgb];[rgb][al]alphamerge,format=rgba`;
  }
  return `fps=${rate},format=rgba`;
}

async function probeVap(inputPath) {
  const info = await ffmpegService.getVideoInfo(inputPath);
  const layout = detectVapLayout(info.width, info.height);
  const visibleWidth = layout === 'lr-alpha-rgb' ? Math.floor(info.width / 2) : info.width;
  const visibleHeight = layout === 'tb-alpha-rgb' ? Math.floor(info.height / 2) : info.height;
  return {
    duration: info.duration,
    packedWidth: info.width,
    packedHeight: info.height,
    width: visibleWidth,
    height: visibleHeight,
    fps: Math.max(1, Math.round(info.fps || 24)),
    hasAudio: !!info.hasAudio,
    layout,
    hasSplitAlpha: layout !== 'none',
  };
}

function listPngSequence(dir, prefix) {
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function extractRgbaFrames(inputPath, outputDir, options = {}) {
  const fps = Math.max(1, Math.min(60, Number(options.fps) || 24));
  const layout = options.layout || 'none';
  const maxDim = options.maxDim || 0;
  fs.mkdirSync(outputDir, { recursive: true });
  const pattern = path.join(outputDir, 'vap_%04d.png');
  let vf = vapFilter(layout, fps);
  if (maxDim > 0) {
    vf += `,scale='min(${maxDim},iw)':-1:flags=lanczos`;
  }
  await ffmpegService.runFFmpeg([
    '-y',
    '-i', inputPath,
    '-vf', vf,
    '-start_number', '1',
    '-an',
    pattern,
  ]);
  const files = listPngSequence(outputDir, 'vap_');
  if (!files.length) {
    throw new Error('No frames extracted from video');
  }
  const meta = await sharp(files[0]).metadata();
  return {
    files,
    width: meta.width || 1,
    height: meta.height || 1,
    fps,
  };
}

async function encodeVapMp4(framesDir, prefix, outputPath, options = {}) {
  const fps = Math.max(1, Math.min(60, Number(options.fps) || 24));
  const bitrateMbps = Math.max(1, Number(options.bitrateMbps) || 4);
  const keepAlpha = options.keepAlpha !== false;
  const inputPattern = path.join(framesDir, `${prefix}%04d.png`);
  const vf = keepAlpha
    ? 'format=rgba,split[rgb][a];[a]alphaextract,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[al];[rgb]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[rg];[al][rg]hstack=inputs=2'
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';

  await ffmpegService.runFFmpeg([
    '-y',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', inputPattern,
    '-vf', vf,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${bitrateMbps}M`,
    '-maxrate', `${bitrateMbps}M`,
    '-bufsize', `${bitrateMbps * 2}M`,
    '-movflags', '+faststart',
    '-an',
    outputPath,
  ], {
    onProgress: options.onProgress,
  });
}

async function copyRgbaSequence(frameBuffers, outputDir, prefix, size) {
  fs.mkdirSync(outputDir, { recursive: true });
  const width = even(size.width);
  const height = even(size.height);
  const files = [];
  for (let i = 0; i < frameBuffers.length; i++) {
    const raw = frameBuffers[i].imageBuffer || frameBuffers[i].buffer;
    const out = path.join(outputDir, `${prefix}${String(i + 1).padStart(4, '0')}.png`);
    await sharp(raw)
      .ensureAlpha()
      .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    files.push(out);
  }
  return { files, width, height };
}

module.exports = {
  detectVapLayout,
  qualityPreset,
  resolveMaxDim,
  probeVap,
  extractRgbaFrames,
  encodeVapMp4,
  copyRgbaSequence,
};
