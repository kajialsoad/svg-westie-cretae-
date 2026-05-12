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
  const videoFilter = `fps=${fps},scale=${maxWidth}:-1:flags=lanczos`;

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', videoFilter,
    '-sws_flags', 'lanczos+accurate_rnd',
    '-pix_fmt', pixFmt,
    '-start_number', '1',
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

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const normalized = hex.replace('#', '').trim();
  if (normalized.length !== 6) return null;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r, g, b };
}

function colorDistance(r, g, b, target) {
  const dr = r - target.r;
  const dg = g - target.g;
  const db = b - target.b;
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
}

function getLuma(r, g, b) {
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

function getSaturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min;
}

/**
 * Compute local gradient magnitude for a pixel (simple Sobel-like).
 * High value = textured/detailed area = likely foreground.
 */
function getLocalGradient(rgba, width, height, x, y) {
  if (x <= 0 || x >= width - 1 || y <= 0 || y >= height - 1) return 0;
  const idx = (y * width + x) * 4;
  const left = ((y * width) + (x - 1)) * 4;
  const right = ((y * width) + (x + 1)) * 4;
  const up = (((y - 1) * width) + x) * 4;
  const down = (((y + 1) * width) + x) * 4;
  let gx = 0, gy = 0;
  for (let c = 0; c < 3; c++) {
    gx += Math.abs(rgba[right + c] - rgba[left + c]);
    gy += Math.abs(rgba[down + c] - rgba[up + c]);
  }
  return (gx + gy) / 6; // average gradient per channel
}

function resolveReferenceColor(keyColor, detectedHex) {
  if (keyColor === 'green') return { r: 0, g: 255, b: 0 };
  if (keyColor === 'black') return { r: 0, g: 0, b: 0 };
  if (keyColor === 'white') return { r: 255, g: 255, b: 255 };
  return hexToRgb(detectedHex) || { r: 255, g: 255, b: 255 };
}

/**
 * ============================================================
 * V3.3 FOREGROUND-FIRST BACKGROUND REMOVAL
 * ============================================================
 * Decision Priority (NEVER violated):
 *   P0: Foreground map (texture/edge) → ALWAYS KEEP
 *   P1: Border-connected flat BG     → REMOVE (if not P0)
 *   P2: Interior flat BG region      → REMOVE (if not P0)
 *   P3: Unknown / uncertain          → KEEP (default)
 *
 * Pipeline:
 *   1. buildForegroundMap()   — identify FG via gradient (immutable)
 *   2. buildBGMask()          — flood-fill with FG blocking
 *   3. interiorDetect()       — interior regions with FG blocking
 *   4. resolveConflicts()     — FG wins ALWAYS
 *   5. erode + composite
 * ============================================================
 */

/**
 * Build an immutable foreground map from texture/gradient analysis.
 * Per-pixel only — NO flood-fill expansion (avoids noise/spark spread).
 * Pixels with high local gradient = confirmed foreground = NEVER removable.
 */
function buildForegroundMap(rgba, width, height) {
  const pixelCount = width * height;
  const fgMap = new Uint8Array(pixelCount);
  // Increased from 12 to 18 to prevent compression noise/artifacts in background
  // from being mistakenly identified as foreground. High quality videos
  // usually have noise < 10, but upscaled or compressed ones can reach 15+.
  const FG_GRADIENT_THRESHOLD = 18;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const grad = getLocalGradient(rgba, width, height, x, y);
      if (grad > FG_GRADIENT_THRESHOLD) {
        fgMap[y * width + x] = 1;
      }
    }
  }
  return fgMap;
}

/**
 * Lightweight conflict resolver.
 * Rule: FG[i]=1 → KEEP (always). BG[i]=1 → REMOVE. else → KEEP.
 */
function resolveConflicts(foregroundMap, bgMask, pixelCount) {
  const finalMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (foregroundMap[i]) {
      finalMask[i] = 0; // FG wins — NEVER remove
    } else if (bgMask[i]) {
      finalMask[i] = 1; // Confirmed BG — remove
    }
    // else: unknown → 0 (keep — foreground-first default)
  }
  return finalMask;
}

function getMaskThresholds(keyColor) {
  // UNIFIED thresholds for ALL output modes.
  // These are the conservative (white-mode-quality) thresholds that preserve foreground.
  // Per-color optimized:
  // White: generous — white BG is very distinct from typical foreground
  // Black: ultra-tight — dark foreground easily confused with dark BG
  // Green: moderate — green screen is usually very distinct
  if (keyColor === 'green') return { seed: 52, grow: 74 };
  if (keyColor === 'black') return { seed: 16, grow: 26 };  // Middle-ground: tighter than orig (18/28) but not so tight that real BG is missed
  if (keyColor === 'white') return { seed: 42, grow: 62 };
  return { seed: 16, grow: 24 };
}

function isBackgroundCandidate(r, g, b, keyColor, referenceColor, threshold, isSeed, localGradient) {
  // COLOR-SPECIFIC TEXTURE GUARD:
  // White BG: allow some noise (compression artifacts), guard at 20
  // Black BG: protect dark foreground aggressively, guard at 8
  // Green BG: moderate, guard at 12
  const textureLimit = keyColor === 'black' ? 8 : keyColor === 'white' ? 20 : 12;
  if (localGradient !== undefined && localGradient > textureLimit) return false;

  const dist = colorDistance(r, g, b, referenceColor);
  if (dist > threshold) return false;

  const saturation = getSaturation(r, g, b);
  const luma = getLuma(r, g, b);
  const strictBoost = isSeed ? 12 : 0;

  if (keyColor === 'green') {
    // Must be clearly green-dominant
    return g >= (r + 25 + strictBoost) && g >= (b + 25 + strictBoost) && saturation >= 35;
  }
  if (keyColor === 'black') {
    // Must be very dark AND very unsaturated (pure black area only)
    // Middle-ground: orig was luma<=60/sat<=35 (too loose), first fix was 40/25 (too tight)
    // Pure black BG: luma ~0-20. Dark FG glow: luma ~30-80. luma<=50 catches BG, protects most FG.
    // Seeds get strictBoost=12 → luma<=38, sat<=24 for seeds (extra tight at border start)
    return luma <= (50 - strictBoost) && saturation <= (30 - Math.floor(strictBoost / 2));
  }
  if (keyColor === 'white') {
    // White BG: generous — white is very distinct from typical foreground
    // Catches off-white, light grey, near-white, light gradient areas
    return luma >= (130 + strictBoost) && saturation <= (60 - Math.floor(strictBoost / 2));
  }
  return true;
}

function buildConnectedBackgroundMask(rgba, width, height, keyColor, referenceColor, foregroundMap) {
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let qHead = 0;
  let qTail = 0;
  const { seed, grow } = getMaskThresholds(keyColor);

  const testPixel = (idx, threshold, isSeed) => {
    // V3.3: FG map blocks — foreground pixels are walls, never BG
    if (foregroundMap && foregroundMap[idx]) return false;
    const o = idx * 4;
    const x = idx % width;
    const y = Math.floor(idx / width);
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const grad = getLocalGradient(rgba, width, height, x, y);
    return isBackgroundCandidate(r, g, b, keyColor, referenceColor, threshold, isSeed, grad);
  };

  const enqueue = (idx) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    // V3.3: Skip FG pixels entirely during seeding
    if (foregroundMap && foregroundMap[idx]) return;
    if (testPixel(idx, seed, true)) {
      mask[idx] = 1;
      queue[qTail++] = idx;
    }
  };

  // Only seed from image borders — never from interior
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue(((height - 1) * width) + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(y * width);
    enqueue((y * width) + (width - 1));
  }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = Math.floor(idx / width);

    const neighbors = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < width - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - width);
    if (y < height - 1) neighbors.push(idx + width);

    for (const nIdx of neighbors) {
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      if (testPixel(nIdx, grow, false)) {
        mask[nIdx] = 1;
        queue[qTail++] = nIdx;
      }
    }
  }

  return mask;
}

function erodeBackgroundMask(mask, width, height, iterations = 1) {
  let current = new Uint8Array(mask);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Uint8Array(current);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width) + x;
        if (!current[idx]) continue;
        const left = idx - 1;
        const right = idx + 1;
        const up = idx - width;
        const down = idx + width;
        if (!current[left] || !current[right] || !current[up] || !current[down]) {
          next[idx] = 0;
        }
      }
    }
    current = next;
  }
  return current;
}

// Legacy helpers kept for compatibility but NOT used in v3 pipeline
function getLocalFlatness(rgba, width, height, x, y) {
  const center = ((y * width) + x) * 4;
  const cr = rgba[center];
  const cg = rgba[center + 1];
  const cb = rgba[center + 2];

  let diffSum = 0;
  let count = 0;
  const neighbors = [
    [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const o = ((ny * width) + nx) * 4;
    const dr = cr - rgba[o];
    const dg = cg - rgba[o + 1];
    const db = cb - rgba[o + 2];
    diffSum += Math.sqrt((dr * dr) + (dg * dg) + (db * db));
    count++;
  }
  return count > 0 ? (diffSum / count) : 999;
}

/**
 * INTERIOR BACKGROUND REGION DETECTION
 * 
 * After border flood-fill, some background areas may be "trapped" inside
 * foreground objects (e.g., the center of a wreath, inside a frame).
 * 
 * This function finds those interior regions by:
 * 1. Scanning ALL unvisited pixels that match background color
 * 2. Flood-filling each connected region
 * 3. Only marking as background if the region is:
 *    - LARGE (>= 0.5% of total image area) — small spots are likely foreground detail
 *    - VERY FLAT (avg texture <= 6) — textured areas are foreground
 *    - COLOR-MATCHED to the detected background reference
 * 
 * This is SAFE because small/textured regions are always kept as foreground.
 */
function detectInteriorBackgroundRegions(rgba, width, height, keyColor, referenceColor, existingMask, foregroundMap) {
  const pixelCount = width * height;
  // Lowered from 0.001 to 0.0005 — extremely aggressive to catch small fragmented regions
  const minRegionPct = 0.0005;
  const minRegionSize = Math.max(30, Math.floor(pixelCount * minRegionPct));
  const visited = new Uint8Array(pixelCount);
  const result = new Uint8Array(existingMask);

  // Mark already-masked pixels AND foreground pixels as visited (walls)
  for (let i = 0; i < pixelCount; i++) {
    if (existingMask[i]) visited[i] = 1;
    // V3.3: FG pixels are walls — interior detection cannot enter them
    if (foregroundMap && foregroundMap[i]) visited[i] = 1;
  }

  // UNIFIED: same color thresholds for ALL output modes
  // Black: 20 (middle-ground between orig 22 and first fix 15)
  const interiorColorThreshold = keyColor === 'green' ? 50 : keyColor === 'white' ? 48 : 20;
  // Increased from 8 to 12 to handle noise in interior regions
  const maxAvgTexture = 12;

  // UNIFIED: same luma/saturation checks for ALL output modes
  // Black: luma<=45/sat<=25 — tighter than orig (50/30) to protect dark FG gradients
  const lumaCheck = (luma, sat) => {
    if (keyColor === 'black') return luma <= 45 && sat <= 25;
    if (keyColor === 'white') return luma >= 130 && sat <= 55;
    if (keyColor === 'green') return true; // color distance + saturation already filtered
    return true;
  };

  for (let startIdx = 0; startIdx < pixelCount; startIdx++) {
    if (visited[startIdx]) continue;
    visited[startIdx] = 1;

    // Check if this pixel matches background color
    const o = startIdx * 4;
    const sr = rgba[o], sg = rgba[o + 1], sb = rgba[o + 2];
    const dist = colorDistance(sr, sg, sb, referenceColor);
    if (dist > interiorColorThreshold) continue;

    const sLuma = getLuma(sr, sg, sb);
    const sSat = getSaturation(sr, sg, sb);
    if (!lumaCheck(sLuma, sSat)) continue;

    // Flood-fill this connected region
    const regionQueue = [startIdx];
    const regionPixels = [];
    let totalTexture = 0;
    let qIdx = 0;

    while (qIdx < regionQueue.length) {
      const idx = regionQueue[qIdx++];
      regionPixels.push(idx);

      const x = idx % width;
      const y = Math.floor(idx / width);
      totalTexture += getLocalGradient(rgba, width, height, x, y);

      // 8-connected neighbors (was 4-connected)
      // 8-connected allows flood-fill to bypass single-pixel-wide diagonal FG walls
      // that particles/sparks create between white background regions
      const neighbors = [];
      if (x > 0) neighbors.push(idx - 1);
      if (x < width - 1) neighbors.push(idx + 1);
      if (y > 0) neighbors.push(idx - width);
      if (y < height - 1) neighbors.push(idx + width);
      // diagonal neighbors
      if (x > 0 && y > 0) neighbors.push(idx - width - 1);
      if (x < width - 1 && y > 0) neighbors.push(idx - width + 1);
      if (x > 0 && y < height - 1) neighbors.push(idx + width - 1);
      if (x < width - 1 && y < height - 1) neighbors.push(idx + width + 1);

      for (const nIdx of neighbors) {
        if (visited[nIdx]) continue;
        visited[nIdx] = 1;
        const no = nIdx * 4;
        const nd = colorDistance(rgba[no], rgba[no + 1], rgba[no + 2], referenceColor);
        if (nd > interiorColorThreshold) continue;
        const nLuma = getLuma(rgba[no], rgba[no + 1], rgba[no + 2]);
        const nSat = getSaturation(rgba[no], rgba[no + 1], rgba[no + 2]);
        if (!lumaCheck(nLuma, nSat)) continue;
        regionQueue.push(nIdx);
      }
    }

    // Only mark as background if region is LARGE and FLAT
    const avgTexture = regionPixels.length > 0 ? totalTexture / regionPixels.length : 999;
    if (regionPixels.length >= minRegionSize && avgTexture <= maxAvgTexture) {
      for (const idx of regionPixels) {
        result[idx] = 1;
      }
    }
    // else: region is too small or too textured → keep as foreground (SAFE DEFAULT)
  }

  return result;
}

/**
 * V3 BINARY COMPOSITE — The core of foreground preservation.
 * 
 * mask=1 (confirmed background) → replace with target color
 * mask=0 (everything else)      → KEEP PIXEL EXACTLY AS ORIGINAL
 * 
 * NO alpha manipulation. NO soft edges. NO ghosting. ZERO foreground damage.
 */
function binaryComposite(rgba, bgMask, outputBg) {
  const out = Buffer.from(rgba);
  const pixelCount = bgMask.length;
  const useTransparentOutput = !outputBg;

  let bgPixels = 0;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;

    if (bgMask[i]) {
      // This pixel is CONFIRMED background — replace it
      bgPixels++;
      if (useTransparentOutput) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      } else {
        out[o] = outputBg.r;
        out[o + 1] = outputBg.g;
        out[o + 2] = outputBg.b;
        out[o + 3] = 255;
      }
    }
    // else: KEEP PIXEL EXACTLY AS-IS — do nothing, out already has original data
  }

  return {
    buffer: out,
    stats: {
      totalPixels: pixelCount,
      bgPixels,
      bgRatio: pixelCount > 0 ? bgPixels / pixelCount : 0,
      softEdgePixels: 0,
      softEdgeRatio: 0,
      transparentOutput: useTransparentOutput,
    },
  };
}

/**
 * V3.3 Foreground-First Background Removal.
 * 
 * Pipeline:
 * 1. Build FOREGROUND MAP (texture/gradient — immutable, NEVER overridden)
 * 2. Build border-connected BG mask (FG pixels = walls, can't flood through)
 * 3. Detect interior BG regions (FG pixels = walls)
 * 4. Resolve conflicts: FG ALWAYS wins over BG
 * 5. Erode combined mask (safety buffer)
 * 6. Binary composite (mask=1 → new BG, mask=0 → original untouched)
 * 
 * "Foreground is always preserved. Only background is modified or removed."
 */
async function removeBackground(inputPath, outputPath, options = {}) {
  const keyColor = String(options.keyColor || 'auto_detected').toLowerCase();

  if (keyColor === 'none') {
    fs.copyFileSync(inputPath, outputPath);
    return {
      totalPixels: 0,
      bgPixels: 0,
      bgRatio: 0,
      softEdgePixels: 0,
      softEdgeRatio: 0,
      transparentOutput: false,
      keyColor,
      referenceColor: null,
    };
  }

  const outputBg = resolveOutputBackground(options.outputBg);
  const referenceColor = resolveReferenceColor(keyColor, options.detectedHex);
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const out = Buffer.from(data);

  // ============================================================
  // UNIFIED PIPELINE — identical for ALL output modes
  // Only binaryComposite uses outputBg to fill background pixels.
  // ============================================================

  // Step 1: Build FOREGROUND MAP — identify textured/detailed pixels FIRST
  // This is immutable: once marked FG, nothing can override it
  const foregroundMap = buildForegroundMap(out, width, height);

  // Step 2: Border flood-fill with FG blocking
  // FG pixels act as walls — flood-fill cannot enter foreground territory
  const borderMask = buildConnectedBackgroundMask(out, width, height, keyColor, referenceColor, foregroundMap);

  // Step 3: Interior BG regions with FG blocking
  // FG pixels act as walls — interior detection cannot grab foreground details
  const rawBgMask = detectInteriorBackgroundRegions(out, width, height, keyColor, referenceColor, borderMask, foregroundMap);

  // Step 4: RESOLVE CONFLICTS — FG always wins, unknown = keep
  const resolvedMask = resolveConflicts(foregroundMap, rawBgMask, width * height);

  // Step 5: Erosion — ALWAYS based on SOURCE keyColor, never on output mode
  // Black: 2 iterations (reduced from 3 — 3 was eating too far into dark FG borders)
  // White/Green/other: 1 iteration
  const erosionIterations = keyColor === 'black' ? 2 : 1;
  const bgMask = erodeBackgroundMask(resolvedMask, width, height, erosionIterations);

  // Step 6: Check if main pipeline found enough BG. If not, run per-pixel fallback.
  // This handles frames where animation particles create continuous FG walls,
  // blocking BOTH border flood-fill and interior detection.
  let finalBgMask = bgMask;
  const pixelCount = width * height;
  let bgPixelCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (bgMask[i]) bgPixelCount++;
  }
  const bgRatio = pixelCount > 0 ? bgPixelCount / pixelCount : 0;

  if (bgRatio < 0.05 && keyColor !== 'none') {
    // Per-pixel fallback: mark flat, non-FG, color-matched pixels as BG
    // Uses VERY tight thresholds — only catches obvious background pixels
    const fallbackMask = new Uint8Array(bgMask);
    const fbColorThreshold = keyColor === 'white' ? 30 : keyColor === 'black' ? 16 : 40;
    const fbTextureLimit = 10; // Increased from 6 to handle noise in fallback pass
    let fallbackAdded = 0;

    for (let i = 0; i < pixelCount; i++) {
      if (fallbackMask[i]) continue; // already BG
      if (foregroundMap[i]) continue; // FG protected
      const o = i * 4;
      const r = out[o], g = out[o + 1], b = out[o + 2];
      const dist = colorDistance(r, g, b, referenceColor);
      if (dist > fbColorThreshold) continue;
      const luma = getLuma(r, g, b);
      const sat = getSaturation(r, g, b);
      if (keyColor === 'white' && (luma < 160 || sat > 40)) continue;
      if (keyColor === 'black' && (luma > 35 || sat > 20)) continue;
      const x = i % width;
      const y = Math.floor(i / width);
      const grad = getLocalGradient(out, width, height, x, y);
      if (grad > fbTextureLimit) continue;
      fallbackMask[i] = 1;
      fallbackAdded++;
    }

    if (fallbackAdded > 0) {
      // Re-resolve conflicts: FG still wins
      const resolvedFallback = resolveConflicts(foregroundMap, fallbackMask, pixelCount);
      finalBgMask = erodeBackgroundMask(resolvedFallback, width, height, erosionIterations);
      console.log('[removeBackground][Fallback]', {
        mainBgRatio: bgRatio.toFixed(4),
        fallbackAdded,
        newBgRatio: (finalBgMask.reduce((s, v) => s + v, 0) / pixelCount).toFixed(4),
      });
    }
  }

  // Step 7: Binary composite — mask=1 → new BG color, mask=0 → original pixel UNTOUCHED
  const composed = binaryComposite(out, finalBgMask, outputBg);

  await sharp(composed.buffer, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(outputPath);

  return {
    ...composed.stats,
    keyColor,
    referenceColor,
  };
}

async function getAlphaStats(imagePath) {
  try {
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels || 4;
    const pixelCount = Math.max(1, info.width * info.height);
    let alphaSum = 0;
    let transparentPixels = 0;
    let nearTransparentPixels = 0;
    for (let i = 0; i < data.length; i += channels) {
      const a = data[i + 3];
      alphaSum += a;
      if (a <= 8) transparentPixels++;
      if (a <= 30) nearTransparentPixels++;
    }
    return {
      avgAlpha: alphaSum / pixelCount,
      transparentRatio: transparentPixels / pixelCount,
      nearTransparentRatio: nearTransparentPixels / pixelCount,
    };
  } catch {
    return { avgAlpha: 255, transparentRatio: 0, nearTransparentRatio: 0 };
  }
}

async function detectDominantEdgeColor(framePath) {
  const frameImg = sharp(framePath);
  const { width: fw, height: fh } = await frameImg.metadata();
  const sampleDepth = Math.max(3, Math.min(14, Math.floor(fw * 0.08))); // 8% depth or 14px max — wider sample for more reliable BG detection

  const regions = [
    { left: 0, top: 0, width: fw, height: sampleDepth },
    { left: 0, top: fh - sampleDepth, width: fw, height: sampleDepth },
    { left: 0, top: 0, width: sampleDepth, height: fh },
    { left: fw - sampleDepth, top: 0, width: sampleDepth, height: fh },
  ];

  const colorCounts = {};
  let totalAlpha = 0;
  let totalSamples = 0;

  for (const region of regions) {
    const { data, info } = await sharp(framePath)
      .extract(region)
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const pixels = data.length / channels;
    for (let i = 0; i < pixels; i++) {
      const r = data[i * channels];
      const g = data[i * channels + 1];
      const b = data[i * channels + 2];
      const a = channels === 4 ? data[i * channels + 3] : 255;
      totalAlpha += a;
      totalSamples++;

      const qr = Math.min(255, Math.round(r / 16) * 16);
      const qg = Math.min(255, Math.round(g / 16) * 16);
      const qb = Math.min(255, Math.round(b / 16) * 16);
      const key = `${qr},${qg},${qb}`;
      colorCounts[key] = (colorCounts[key] || 0) + 1;
    }
  }

  const avgAlpha = totalSamples > 0 ? totalAlpha / totalSamples : 255;
  const dominantKey = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominantKey) {
    return { avgAlpha, hex: null };
  }
  const [r, g, b] = dominantKey.split(',').map(Number);
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { avgAlpha, hex };
}

function mapEdgeColorToKeyColor(hexColor) {
  if (!hexColor || typeof hexColor !== 'string') return 'white';
  const normalized = hexColor.replace('#', '').toUpperCase();
  const r = parseInt(normalized.slice(0, 2), 16) || 0;
  const g = parseInt(normalized.slice(2, 4), 16) || 0;
  const b = parseInt(normalized.slice(4, 6), 16) || 0;

  if (g > 120 && g > r * 1.2 && g > b * 1.2) return 'green';
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 128 ? 'black' : 'white';
}

function resolveOutputBackground(outputBg) {
  const val = String(outputBg || 'transparent').toLowerCase();
  if (val === 'transparent' || val === 'none' || val === 'nobackground') return null;
  if (val === 'green') return { r: 0, g: 255, b: 0 };
  if (val === 'black') return { r: 0, g: 0, b: 0 };
  if (val === 'white') return { r: 255, g: 255, b: 255 };
  return null;
}

/**
 * Remove background from all frames in a directory
 * @param {string[]} framePaths - Array of frame file paths
 * @param {string} outputDir - Output directory for processed frames
 * @param {Object} options - { outputBg, keyColor }
 * @returns {Promise<string[]>} - Array of processed frame paths
 */
async function removeBackgroundBatch(framePaths, outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  // UNIFIED: No more aggressive mode. All output modes use the same pipeline.
  const outputBg = String(options.outputBg || '').toLowerCase();
  const isNoBackground = outputBg === 'nobackground';

  let keyColor = String(options.keyColor || 'auto').toLowerCase();
  let detectedHex = null;

  // Auto-detect source background color when needed
  if ((keyColor === 'auto' || isNoBackground) && framePaths.length > 0) {
    try {
      const edgeInfo = await detectDominantEdgeColor(framePaths[0]);
      detectedHex = edgeInfo.hex || '#FFFFFF';
      keyColor = mapEdgeColorToKeyColor(detectedHex);
    } catch {
      keyColor = 'white';
    }
  }

  console.log('[UNIFIED][removeBackgroundBatch]', {
    outputBg,
    keyColor,
    detectedHex,
    frameCount: framePaths.length,
    pipeline: 'unified — same segmentation for all modes',
  });

  const processedPaths = [];
  const frameStats = [];
  const toFixedNumber = (value, digits = 4, fallback = 0) =>
    Number((Number.isFinite(value) ? value : fallback).toFixed(digits));

  // UNIFIED PIPELINE: same foreground map, same segmentation, same conflict resolver
  // Only binaryComposite output color differs between modes

  for (let i = 0; i < framePaths.length; i++) {
    const outputPath = path.join(outputDir, `processed_${String(i + 1).padStart(4, '0')}.png`);
    const stats = await removeBackground(framePaths[i], outputPath, {
      keyColor,
      detectedHex,
      outputBg: options.outputBg,
    }) || {};

    processedPaths.push(outputPath);
    frameStats.push({
      frameIndex: i,
      ...stats,
      bgRatio: Number.isFinite(stats.bgRatio) ? stats.bgRatio : 0,
      softEdgeRatio: Number.isFinite(stats.softEdgeRatio) ? stats.softEdgeRatio : 0,
    });
  }

  const bgRatios = frameStats.map((s) => s.bgRatio).sort((a, b) => a - b);
  const mid = Math.floor(bgRatios.length / 2);
  const medianBgRatio = bgRatios.length === 0
    ? 0
    : (bgRatios.length % 2 === 0 ? (bgRatios[mid - 1] + bgRatios[mid]) / 2 : bgRatios[mid]);
  const flaggedFrames = frameStats
    .filter((s) => Math.abs(s.bgRatio - medianBgRatio) > 0.22)
    .map((s) => ({ frameIndex: s.frameIndex, bgRatio: toFixedNumber(s.bgRatio) }));

  return {
    processedPaths,
    report: {
      keyColor,
      detectedHex,
      pipeline: 'unified',
      frameCount: frameStats.length,
      medianBgRatio: toFixedNumber(medianBgRatio),
      flaggedFrames,
      sample: frameStats.slice(0, 5).map((s) => ({
        frameIndex: s.frameIndex,
        bgRatio: toFixedNumber(s.bgRatio),
        softEdgeRatio: toFixedNumber(s.softEdgeRatio),
      })),
    },
  };
}

async function getPerceptualSignature(framePath, size = 24) {
  const { data } = await sharp(framePath)
    .resize(size, size, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

async function getDifferenceHash(framePath, width = 16, height = 16) {
  const sampleWidth = width + 1;
  const { data } = await sharp(framePath)
    .resize(sampleWidth, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bits = new Uint8Array(width * height);
  let idx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = data[y * sampleWidth + x];
      const right = data[y * sampleWidth + x + 1];
      bits[idx++] = left > right ? 1 : 0;
    }
  }
  return bits;
}

function getHammingDistance(bitsA, bitsB) {
  if (!bitsA || !bitsB || bitsA.length !== bitsB.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < bitsA.length; i++) {
    if (bitsA[i] !== bitsB[i]) distance++;
  }
  return distance;
}

function getAverageDiff(sigA, sigB) {
  if (!sigA || !sigB || sigA.length !== sigB.length) return 255;
  let total = 0;
  for (let i = 0; i < sigA.length; i++) {
    total += Math.abs(sigA[i] - sigB[i]);
  }
  return total / sigA.length;
}

async function optimizeFrameSequence(framePaths, options = {}) {
  if (!Array.isArray(framePaths) || framePaths.length <= 2) {
    return {
      selectedFramePaths: framePaths || [],
      selectedIndices: framePaths ? framePaths.map((_, idx) => idx) : [],
      sourceFrameCount: framePaths?.length || 0,
      selectedFrameCount: framePaths?.length || 0,
      outputFps: options.sourceFps || 24,
      avgDiff: 0,
    };
  }

  const sourceFps = options.sourceFps || 24;
  const profile = options.profile || {
    staticThreshold: 2.0,
    lowMotionThreshold: 5.0,
    staticStride: 3,
    lowMotionStride: 2,
    minFps: 12,
  };

  const selectedIndices = [0];
  let prevSignature = await getPerceptualSignature(framePaths[0]);
  let prevHash = await getDifferenceHash(framePaths[0]);
  let lastSelected = 0;
  let totalDiff = 0;
  let totalHashDistance = 0;
  let keptByHardDuplicate = 0;
  let diffSamples = 0;

  for (let i = 1; i < framePaths.length; i++) {
    const signature = await getPerceptualSignature(framePaths[i]);
    const frameHash = await getDifferenceHash(framePaths[i]);
    const diff = getAverageDiff(prevSignature, signature);
    const hashDistance = getHammingDistance(prevHash, frameHash);
    totalDiff += diff;
    totalHashDistance += hashDistance;
    diffSamples++;

    const distance = i - lastSelected;
    let keepFrame = true;
    const hardDuplicate = hashDistance <= 4;
    const lowMotionDuplicate = hashDistance <= 12 && diff <= profile.staticThreshold;

    if (hardDuplicate) {
      // Strict duplicate (or almost duplicate): skip aggressively.
      keepFrame = false;
      keptByHardDuplicate++;
    } else if (lowMotionDuplicate) {
      keepFrame = distance >= Math.max(2, profile.lowMotionStride);
    } else if (diff < profile.staticThreshold) {
      keepFrame = distance >= profile.staticStride;
    } else if (diff < profile.lowMotionThreshold) {
      keepFrame = distance >= profile.lowMotionStride;
    }

    if (keepFrame) {
      selectedIndices.push(i);
      lastSelected = i;
    }

    prevSignature = signature;
    prevHash = frameHash;
  }

  if (selectedIndices[selectedIndices.length - 1] !== framePaths.length - 1) {
    selectedIndices.push(framePaths.length - 1);
  }

  const selectedFramePaths = selectedIndices.map(idx => framePaths[idx]);
  const keepRatio = selectedFramePaths.length / framePaths.length;
  const outputFps = Math.max(profile.minFps || 8, Math.round(sourceFps * keepRatio));

  return {
    selectedFramePaths,
    selectedIndices,
    sourceFrameCount: framePaths.length,
    selectedFrameCount: selectedFramePaths.length,
    outputFps,
    avgDiff: diffSamples > 0 ? totalDiff / diffSamples : 0,
    avgHashDistance: diffSamples > 0 ? totalHashDistance / diffSamples : 0,
    hardDuplicateSkips: keptByHardDuplicate,
  };
}

function downsampleFramePaths(framePaths, keepRatio = 0.8) {
  if (!Array.isArray(framePaths) || framePaths.length <= 2) {
    return framePaths || [];
  }
  const ratio = Math.max(0.1, Math.min(1, keepRatio));
  const targetCount = Math.max(2, Math.round(framePaths.length * ratio));
  if (targetCount >= framePaths.length) return framePaths;

  const selected = [];
  const step = (framePaths.length - 1) / (targetCount - 1);
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.min(framePaths.length - 1, Math.round(i * step));
    selected.push(framePaths[idx]);
  }

  // Remove accidental duplicates caused by rounding
  const deduped = [];
  const seen = new Set();
  for (const frame of selected) {
    if (!seen.has(frame)) {
      deduped.push(frame);
      seen.add(frame);
    }
  }
  return deduped;
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
 * Get per-frame timestamps from source video (seconds).
 * Uses ffprobe decoded frame timeline to support timestamp-based slot mapping.
 * @param {string} inputPath
 * @returns {Promise<number[]>}
 */
async function getVideoFrameTimestamps(inputPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'frame=best_effort_timestamp_time,pkt_pts_time,pkt_dts_time',
      '-of', 'json',
      inputPath,
    ];

    const proc = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout || '{}');
        const frames = Array.isArray(parsed.frames) ? parsed.frames : [];
        const timestamps = frames
          .map((f) => {
            const raw = f.best_effort_timestamp_time ?? f.pkt_pts_time ?? f.pkt_dts_time;
            const t = Number(raw);
            return Number.isFinite(t) ? t : null;
          })
          .filter((t) => t !== null && t >= 0);
        resolve(timestamps);
      } catch {
        resolve([]);
      }
    });

    proc.on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Extract audio from a video file as MP3
 * @param {string} inputPath - Path to video file
 * @param {string} outputPath - Path to save MP3
 * @returns {Promise<boolean>} - Success or failure
 */
async function extractAudio(inputPath, outputPath, options = {}) {
  const bitrate = options.bitrateKbps || 128;
  const args = [
    '-y',
    '-i', inputPath,
    '-vn', // No video
    '-acodec', 'libmp3lame',
    '-ab', `${bitrate}k`,
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
  getVideoFrameTimestamps,
  extractAudio,
  optimizeFrameSequence,
  downsampleFramePaths,
  createTempDir,
  cleanupTempDir,
};
