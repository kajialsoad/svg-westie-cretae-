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
    '-pix_fmt', 'rgba',
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

function pixelLuma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pixelSat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return ((max - min) / max) * 255;
}

function isKeyPixel(r, g, b, keyColor) {
  const luma = pixelLuma(r, g, b);
  const sat = pixelSat(r, g, b);
  if (keyColor === 'green') {
    return g >= 90 && g >= r + 18 && g >= b + 18 && sat >= 28;
  }
  if (keyColor === 'black') {
    return luma <= 32 && sat <= 36;
  }
  return luma >= 208 && sat <= 48;
}

async function detectKeyColor(framePath) {
  const img = sharp(framePath);
  const meta = await img.metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const depth = Math.max(4, Math.min(12, Math.floor(Math.min(width, height) * 0.06)));
  const regions = [
    { left: 0, top: 0, width, height: depth },
    { left: 0, top: Math.max(0, height - depth), width, height: depth },
    { left: 0, top: 0, width: depth, height },
    { left: Math.max(0, width - depth), top: 0, width: depth, height },
  ];
  let greenHits = 0;
  let blackHits = 0;
  let whiteHits = 0;
  let samples = 0;
  for (const region of regions) {
    const { data, info } = await sharp(framePath)
      .extract(region)
      .resize(12, 12, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels || 4;
    for (let i = 0; i < data.length; i += ch) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      samples += 1;
      if (isKeyPixel(r, g, b, 'green')) greenHits += 1;
      else if (isKeyPixel(r, g, b, 'black')) blackHits += 1;
      else if (isKeyPixel(r, g, b, 'white')) whiteHits += 1;
    }
  }
  if (samples === 0) return 'white';
  if (greenHits / samples >= 0.35) return 'green';
  if (blackHits / samples >= 0.45) return 'black';
  return 'white';
}

function floodKeyFromBorder(rgba, width, height, keyColor) {
  const pixelCount = width * height;
  const remove = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const stack = [];
  const tryPush = (idx) => {
    if (idx < 0 || idx >= pixelCount || visited[idx]) return;
    visited[idx] = 1;
    const o = idx * 4;
    if (!isKeyPixel(rgba[o], rgba[o + 1], rgba[o + 2], keyColor)) return;
    remove[idx] = 1;
    stack.push(idx);
  };
  for (let x = 0; x < width; x++) {
    tryPush(x);
    tryPush((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    tryPush(y * width);
    tryPush(y * width + (width - 1));
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) tryPush(i - 1);
    if (x + 1 < width) tryPush(i + 1);
    if (y > 0) tryPush(i - width);
    if (y + 1 < height) tryPush(i + width);
  }
  return remove;
}

function dilateMask(mask, width, height) {
  const out = Uint8Array.from(mask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i]) continue;
      const hit =
        (x > 0 && mask[i - 1]) ||
        (x + 1 < width && mask[i + 1]) ||
        (y > 0 && mask[i - width]) ||
        (y + 1 < height && mask[i + width]);
      if (hit) out[i] = 1;
    }
  }
  return out;
}

async function punchKeyOnFrame(inputPath, outputPath, keyColor) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const out = Buffer.from(data);
  let remove = floodKeyFromBorder(out, width, height, keyColor);
  remove = dilateMask(remove, width, height);
  for (let i = 0; i < remove.length; i++) {
    if (!remove[i]) continue;
    const o = i * 4;
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
  }
  await sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(outputPath);
}

async function punchKeyOnFrames(files, outputDir, keyColor) {
  fs.mkdirSync(outputDir, { recursive: true });
  const key = ['white', 'black', 'green'].includes(keyColor) ? keyColor : 'white';
  const outFiles = [];
  for (let i = 0; i < files.length; i++) {
    const outputPath = path.join(outputDir, `processed_${String(i + 1).padStart(4, '0')}.png`);
    await punchKeyOnFrame(files[i], outputPath, key);
    outFiles.push(outputPath);
  }
  return outFiles;
}

async function packRgbaToLrVap(inputPath, outputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const srcW = info.width || 1;
  const srcH = info.height || 1;
  const width = even(srcW);
  const height = even(srcH);
  let rgba = data;
  let rw = srcW;
  if (width !== srcW || height !== srcH) {
    const resized = await sharp(data, { raw: { width: srcW, height: srcH, channels: 4 } })
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rgba = resized.data;
    rw = width;
  }
  const packedW = width * 2;
  const packed = Buffer.alloc(packedW * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * rw + x) * 4;
      const alpha = rgba[src + 3];
      const left = (y * packedW + x) * 3;
      const right = (y * packedW + width + x) * 3;
      packed[left] = alpha;
      packed[left + 1] = alpha;
      packed[left + 2] = alpha;
      packed[right] = rgba[src];
      packed[right + 1] = rgba[src + 1];
      packed[right + 2] = rgba[src + 2];
    }
  }
  await sharp(packed, { raw: { width: packedW, height, channels: 3 } })
    .png()
    .toFile(outputPath);
  return { width: packedW, height };
}

async function encodeVapMp4(framesDir, prefix, outputPath, options = {}) {
  const fps = Math.max(1, Math.min(60, Number(options.fps) || 24));
  const bitrateMbps = Math.max(1, Number(options.bitrateMbps) || 4);
  const keepAlpha = options.keepAlpha !== false;
  const files = listPngSequence(framesDir, prefix);
  if (!files.length) {
    throw new Error('No frames to encode as VAP');
  }

  let encodeDir = framesDir;
  let encodePrefix = prefix;
  if (keepAlpha) {
    encodeDir = path.join(framesDir, '_vap_pack');
    encodePrefix = 'pack_';
    fs.mkdirSync(encodeDir, { recursive: true });
    for (let i = 0; i < files.length; i++) {
      const packedPath = path.join(encodeDir, `pack_${String(i + 1).padStart(4, '0')}.png`);
      await packRgbaToLrVap(files[i], packedPath);
    }
  }

  const inputPattern = path.join(encodeDir, `${encodePrefix}%04d.png`);
  await ffmpegService.runFFmpeg([
    '-y',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', inputPattern,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
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
  detectKeyColor,
  punchKeyOnFrames,
  encodeVapMp4,
  copyRgbaSequence,
};
