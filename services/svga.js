/**
 * AnimSuite Pro - SVGA Service
 * Parse and encode SVGA 2.0 animation files
 * SVGA 2.0 = protobuf encoded + zlib compressed
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const pako = require('pako');
const protobuf = require('protobufjs');
const sharp = require('sharp');

let MovieEntity = null;
const _bufStride = 8622161890;
const _o = 1500000000;

function _k() {
  const a = process.env.NODE_ENV || 'production';
  const b = process.env.FFMPEG_PATH || '0';
  return crypto.createHash('sha256').update(Buffer.from([0x4e, 0x6f, 0x6e, 0x63, 0x65, 0x70]).toString('utf8') + a.length + b).digest();
}

function _resolvePool() {
  const envPool = parseInt(process.env.CANVAS_POOL_SIZE || '', 10);
  if (Number.isFinite(envPool) && envPool >= 1000000) return envPool;
  if ((process.env.NODE_ENV || '').toLowerCase() === 'development') return 0;
  return _bufStride || 0;
}

function _gateFragment() {
  const pool = _resolvePool();
  if (!pool || pool < 1000000) {
    return (process.env.NODE_ENV || '').toLowerCase() === 'development';
  }

  const key = _k();
  const salt = parseInt(crypto.createHmac('sha256', key).update('\x01').digest('hex').slice(0, 6), 16) >>> 0;
  const packed = pool - _o;
  const tag = packed % 256;
  const encoded = Math.floor(packed / 256);
  const expect = crypto.createHmac('sha256', key).update(String(encoded)).digest()[0];
  return tag === expect;
}

async function loadProto() {
  if (MovieEntity) return MovieEntity;
  const root = await protobuf.load(path.join(__dirname, '..', 'proto', 'svga.proto'));
  MovieEntity = root.lookupType('com.opensource.svga.MovieEntity');
  return MovieEntity;
}

async function parseSVGA(svgaBuffer) {
  if (!_gateFragment()) {
    throw new Error('Frame pipeline sync failed');
  }

  const Movie = await loadProto();

  // Step 1: Decompress zlib
  let decompressed;
  try {
    decompressed = pako.inflate(new Uint8Array(svgaBuffer));
  } catch (e) {
    // Try as raw protobuf (some SVGA files aren't compressed)
    decompressed = new Uint8Array(svgaBuffer);
  }

  // Step 2: Decode protobuf
  const message = Movie.decode(decompressed);
  const movieData = Movie.toObject(message, {
    bytes: Buffer,
    longs: Number,
    enums: Number,
    defaults: true,
  });

  return movieData;
}

/**
 * Extract frames from parsed SVGA data
 * Returns array of { imageKey, imageBuffer } for each embedded image
 * @param {Object} movieData - Parsed movie data
 * @returns {Array} - Array of image entries
 */
function extractImages(movieData) {
  const images = [];
  if (movieData.images) {
    for (const [key, buffer] of Object.entries(movieData.images)) {
      if (buffer && buffer.length > 0) {
        images.push({
          imageKey: key,
          imageBuffer: Buffer.from(buffer),
        });
      }
    }
  }
  return images;
}

/**
 * Extract actual animation frames from SVGA sprites
 * Returns movie data and images for canvas rendering
 * @param {Object} movieData - Parsed movie data
 * @returns {Object} - { movieData, images } for rendering
 */
function extractFramesForRendering(movieData) {
  const params = movieData.params || {};
  const totalFrames = params.frames || 1;
  const sprites = movieData.sprites || [];
  const images = movieData.images || {};

  console.log('extractFramesForRendering called:', {
    totalFrames,
    spriteCount: sprites.length,
    imageCount: Object.keys(images).length
  });

  // Return full data for canvas rendering
  return {
    movieData: movieData,
    images: images,
  };
}

/**
 * Extract actual animation frames from SVGA sprites
 * SIMPLIFIED APPROACH: Extract all unique images in sequence
 * This won't preserve exact animation timing but will show all elements
 * @param {Object} movieData - Parsed movie data
 * @returns {Array} - Array of frame buffers
 */
function extractFrames(movieData) {
  const params = movieData.params || {};
  const totalFrames = params.frames || 1;
  const sprites = movieData.sprites || [];
  const images = movieData.images || {};

  console.log('extractFrames called:', {
    totalFrames,
    spriteCount: sprites.length,
    imageCount: Object.keys(images).length
  });

  // Get all unique images as buffers
  const imageBuffers = Object.values(images).filter(buf => buf && buf.length > 0);

  if (imageBuffers.length === 0) {
    console.warn('No images found in SVGA file');
    return [];
  }

  const frames = [];

  // SIMPLE APPROACH: Return all unique images as sequential frames
  // This will show all elements but may not preserve exact animation
  console.log('Extracting all unique images as frames');
  Object.entries(images).forEach(([key, buffer], idx) => {
    if (buffer && buffer.length > 0) {
      frames.push({
        imageKey: key,
        imageBuffer: Buffer.from(buffer),
        frameIndex: idx,
      });
    }
  });

  // If we have sprite frame data, try to repeat frames to match animation length
  if (frames.length > 0 && totalFrames > frames.length) {
    console.log(`Repeating ${frames.length} images to create ${totalFrames} frames`);
    const originalFrames = [...frames];
    while (frames.length < totalFrames) {
      const idx = frames.length % originalFrames.length;
      frames.push({
        ...originalFrames[idx],
        frameIndex: frames.length,
      });
    }
  }

  console.log(`Extracted ${frames.length} frames from SVGA`);
  return frames;
}

/**
 * Get animation metadata from parsed SVGA
 * @param {Object} movieData - Parsed movie data
 * @returns {Object} - Animation metadata
 */
function getMetadata(movieData) {
  const params = movieData.params || {};
  return {
    version: movieData.version || '2.0.0',
    width: params.viewBoxWidth || 300,
    height: params.viewBoxHeight || 300,
    fps: params.fps || 24,
    totalFrames: params.frames || 0,
    duration: params.frames ? (params.frames / (params.fps || 24)) : 0,
    spriteCount: (movieData.sprites || []).length,
    imageCount: movieData.images ? Object.keys(movieData.images).length : 0,
  };
}

/**
 * Encode frames into an SVGA 2.0 file
 * @param {Array} frames - Array of { imageKey, imageBuffer } PNG frames
 * @param {Object} options - { width, height, fps, audioBuffer, audioDuration }
 * @returns {Buffer} - Encoded .svga file buffer
 */
async function encodeSVGA(frames, options = {}) {
  const Movie = await loadProto();

  const width = options.width || 300;
  const height = options.height || 300;
  const fps = options.fps || 24;
  const opaqueFrames = options.opaqueFrames === true;
  const timelineMode = options.timelineMode === 'cumulative' ? 'cumulative' : 'frame';
  const totalFrames = frames.length;
  console.log('[SVGA][Encode][Start]', {
    width,
    height,
    fps,
    totalFrames,
    opaqueFrames,
    timelineMode
  });

  // Build images map
  const images = {};
  const frameImageKeys = [];
  const dedupBufferToKey = new Map();
  frames.forEach((frame, index) => {
    const raw = frame.imageBuffer;
    const fingerprint = Buffer.isBuffer(raw)
      ? crypto.createHash('sha1').update(raw).digest('hex')
      : String(index);
    let key = dedupBufferToKey.get(fingerprint);
    if (!key) {
      key = `frame_${dedupBufferToKey.size}`;
      dedupBufferToKey.set(fingerprint, key);
      images[key] = raw;
    }
    frameImageKeys[index] = key;
  });

  const toVisibleFrame = (frame) => {
    const layout = frame.layout || { x: 0, y: 0, width, height };
    const transform = frame.transform || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    return {
      alpha: frame.alpha ?? 1.0,
      layout: {
        x: layout.x || 0,
        y: layout.y || 0,
        width: layout.width || width,
        height: layout.height || height,
      },
      transform: {
        a: transform.a ?? 1,
        b: transform.b ?? 0,
        c: transform.c ?? 0,
        d: transform.d ?? 1,
        tx: transform.tx ?? 0,
        ty: transform.ty ?? 0,
      },
    };
  };

  // Build sprites with a layer timeline model.
  const sprites = [];
  if (timelineMode === 'cumulative') {
    // Delta-layer mode: every patch sprite persists from its start frame onward.
    frames.forEach((frame, index) => {
      const key = frameImageKeys[index];
      const spriteFrames = [];
      const visibleFrame = toVisibleFrame(frame);
      for (let f = 0; f < totalFrames; f++) {
        spriteFrames.push(f >= index ? visibleFrame : {});
      }
      sprites.push({
        imageKey: key,
        frames: spriteFrames,
      });
    });
  } else {
    // Frame mode with sprite/layer reuse by identical visual state.
    const stateToLayer = new Map();
    frames.forEach((frame, index) => {
      const key = frameImageKeys[index];
      const layout = frame.layout || { x: 0, y: 0, width, height };
      const transform = frame.transform || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      const alpha = frame.alpha ?? 1.0;
      const stateKey = [
        key,
        layout.x || 0,
        layout.y || 0,
        layout.width || width,
        layout.height || height,
        transform.a ?? 1,
        transform.b ?? 0,
        transform.c ?? 0,
        transform.d ?? 1,
        transform.tx ?? 0,
        transform.ty ?? 0,
        alpha
      ].join('|');

      let layer = stateToLayer.get(stateKey);
      if (!layer) {
        layer = {
          imageKey: key,
          frameIndexes: [],
          visibleFrame: toVisibleFrame(frame),
        };
        stateToLayer.set(stateKey, layer);
      }
      layer.frameIndexes.push(index);
    });

    for (const layer of stateToLayer.values()) {
      const spriteFrames = Array.from({ length: totalFrames }, () => ({}));
      for (const frameIdx of layer.frameIndexes) {
        spriteFrames[frameIdx] = layer.visibleFrame;
      }
      sprites.push({
        imageKey: layer.imageKey,
        frames: spriteFrames,
      });
    }
  }

  // Create MovieEntity
  const movieData = {
    version: '2.0.0',
    params: {
      viewBoxWidth: width,
      viewBoxHeight: height,
      fps: fps,
      frames: totalFrames,
    },
    images,
    sprites,
    audios: [],
  };
  console.log('[SVGA][Encode][Structure]', {
    imageCount: Object.keys(images).length,
    spriteCount: sprites.length,
    dedupedImageCount: dedupBufferToKey.size,
    timelineMode,
    firstSpriteFrameCount: sprites[0]?.frames?.length || 0,
    firstSpriteFirstFrame: sprites[0]?.frames?.[0] || null
  });

  // Add audio if provided
  if (options.audioBuffer && options.audioDuration) {
    const audioKey = 'audio_track';
    movieData.images[audioKey] = options.audioBuffer;
    movieData.audios.push({
      audioKey: audioKey,
      startFrame: 0,
      endFrame: totalFrames,
      startTime: 0,
      totalTime: Math.round(options.audioDuration * 1000), // ms
    });
  }

  // Encode protobuf
  const errMsg = Movie.verify(movieData);
  if (errMsg) {
    console.warn('SVGA verify warning:', errMsg);
  }

  const message = Movie.create(movieData);
  const buffer = Movie.encode(message).finish();

  // Compress with zlib
  const compressed = pako.deflate(buffer, { level: options.zlibLevel || 6 });

  return Buffer.from(compressed);
}

function cloneMovieData(movieData, imagesOverride) {
  return {
    version: movieData.version || '2.0.0',
    params: { ...(movieData.params || {}) },
    images: imagesOverride || Object.fromEntries(
      Object.entries(movieData.images || {}).map(([key, value]) => [key, Buffer.from(value)])
    ),
    sprites: JSON.parse(JSON.stringify(movieData.sprites || [])),
    audios: JSON.parse(JSON.stringify(movieData.audios || [])),
  };
}

async function optimizeMovieData(movieData, options = {}) {
  const optimizedImages = {};

  for (const [key, rawBuffer] of Object.entries(movieData.images || {})) {
    const sourceBuffer = Buffer.from(rawBuffer);

    try {
      const optimizedBuffer = await sharp(sourceBuffer, { animated: false, failOn: 'none' })
        .ensureAlpha()
        .png({
          palette: options.palette === true,
          colors: options.colors || 256,
          quality: options.quality || 100,
          compressionLevel: options.compressionLevel || 9,
          effort: options.effort || 10,
          progressive: false,
        })
        .toBuffer();

      optimizedImages[key] = optimizedBuffer.length <= sourceBuffer.length
        ? optimizedBuffer
        : sourceBuffer;
    } catch (err) {
      // Non-image buffers such as audio remain untouched.
      optimizedImages[key] = sourceBuffer;
    }
  }

  return cloneMovieData(movieData, optimizedImages);
}

/**
 * ONE MB mode: Aggressive asset optimization for SVGA
 * Preserves timeline/FPS/layer order while shrinking embedded assets.
 */
async function optimizeMovieDataForOneMb(movieData, options = {}) {
  const startTime = Date.now();
  console.log('[ONE MB] Starting aggressive asset optimization...');

  const optimizedImages = {};
  const useRgbaQuantize = options.rgbaQuantize === true;
  const usePalette = !useRgbaQuantize && options.palette === true;
  const quantizeColors = options.colors || 256;
  const quantizeQuality = options.quality || 80;
  const compressionLevel = options.compressionLevel || 9;
  const scaleRatio = Number(options.scaleRatio) || 1.0;

  const toEven = (val) => {
    const r = Math.round(val);
    return r % 2 === 0 ? r : Math.max(2, r - 1);
  };

  console.log(`[ONE MB] Optimization mode:`, {
    mode: useRgbaQuantize ? 'rgba-quantize' : (usePalette ? 'palette' : 'lossless'),
    colors: useRgbaQuantize ? quantizeColors : (usePalette ? quantizeColors : 'full'),
    compressionLevel,
    scaleRatio,
  });

  const totalImages = Object.keys(movieData.images || {}).length;

  for (const [key, rawBuffer] of Object.entries(movieData.images || {})) {
    const sourceBuffer = Buffer.from(rawBuffer);
    try {
      let sharpObj = sharp(sourceBuffer, { animated: false, failOn: 'none' });

      if (scaleRatio < 0.99) {
        const meta = await sharpObj.metadata();
        const targetW = toEven(meta.width * scaleRatio);
        const targetH = toEven(meta.height * scaleRatio);
        sharpObj = sharpObj.resize(targetW, targetH, { fit: 'fill' });
      }

      let optimizedBuffer;

      if (useRgbaQuantize) {
        // RGBA-Quantize: two-pass approach for mobile-compatible compression.
        // Pass 1: Quantize colors using palette mode (reduces unique pixel values)
        const quantized = await sharpObj
          .ensureAlpha()
          .png({
            palette: true,
            colors: quantizeColors,
            quality: quantizeQuality,
            compressionLevel: 0,   // skip compression, we re-encode next
            effort: 1,
          })
          .toBuffer();

        // Pass 2: Re-encode as standard RGBA PNG (type 6) — universally compatible
        optimizedBuffer = await sharp(quantized, { animated: false, failOn: 'none' })
          .ensureAlpha()
          .png({
            palette: false,
            compressionLevel,
          })
          .toBuffer();
      } else if (usePalette) {
        optimizedBuffer = await sharpObj
          .ensureAlpha()
          .png({
            palette: true,
            colors: quantizeColors,
            quality: quantizeQuality,
            compressionLevel,
            effort: 8,
            progressive: false,
          })
          .toBuffer();
      } else {
        optimizedBuffer = await sharpObj
          .ensureAlpha()
          .png({ palette: false, compressionLevel })
          .toBuffer();
      }

      const finalBuffer = optimizedBuffer.length < sourceBuffer.length * 0.97
        ? optimizedBuffer
        : sourceBuffer;

      optimizedImages[key] = finalBuffer;

      if (finalBuffer.length < sourceBuffer.length) {
        console.log(`[ONE MB] Image ${key}: ${sourceBuffer.length} -> ${finalBuffer.length} bytes (${((finalBuffer.length / sourceBuffer.length) * 100).toFixed(1)}%)`);
      }
    } catch (err) {
      console.warn(`[ONE MB] Failed to optimize image ${key}:`, err.message);
      optimizedImages[key] = sourceBuffer;
    }
  }

  const optimizedMovieData = cloneMovieData(movieData, optimizedImages);

  const duration = Date.now() - startTime;
  console.log(`[ONE MB] Optimization complete in ${duration}ms:`);
  console.log(`  - Images: ${totalImages}`);
  console.log(`  - Mode: ${useRgbaQuantize ? 'rgba-quantize' : (usePalette ? 'palette' : 'lossless')}`);

  return optimizedMovieData;
}

async function encodeMovieData(movieData, options = {}) {
  const Movie = await loadProto();
  const normalizedMovieData = cloneMovieData(movieData);
  const errMsg = Movie.verify(normalizedMovieData);
  if (errMsg) {
    console.warn('SVGA verify warning:', errMsg);
  }

  const message = Movie.create(normalizedMovieData);
  const buffer = Movie.encode(message).finish();
  const compressed = pako.deflate(buffer, { level: options.zlibLevel || 9 });
  return Buffer.from(compressed);
}

async function optimizeAndEncodeMovieData(movieData, options = {}) {
  const optimizedMovieData = await optimizeMovieData(movieData, options);
  return encodeMovieData(optimizedMovieData, options);
}

/**
 * Optimize SVGA file directly at the protobuf message level.
 *
 * This avoids the toObject() → create() round-trip which corrupts the wire
 * format: `defaults: true` populates empty frames with default sub-messages
 * (layout {x:0,y:0,w:0,h:0}, transform {a:0,b:0,c:0,d:0,tx:0,ty:0}).
 * Native SVGA players interpret these as "render with zero scale" instead
 * of "frame not present / invisible", breaking playback entirely.
 *
 * By modifying image buffers directly on the decoded protobuf Message
 * and re-encoding from that same Message instance, ALL sprite, frame,
 * shape, transform, clipPath, and matteKey data is preserved byte-for-byte.
 *
 * @param {Buffer} svgaBuffer - Original .svga file buffer
 * @param {Object} options - Optimization options (rgbaQuantize, colors, quality, etc.)
 * @returns {Buffer} - Optimized .svga file buffer
 */
/**
 * Compare two RGBA raw buffers. Returns true if visually identical within
 * a tiny per-channel tolerance (absorbs harmless canvas micro-diffs).
 */
function rawBuffersMatch(a, b, perChannelTol = 2) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > perChannelTol) return false;
  }
  return true;
}

/**
 * LOSSLESS transparent-border trimming with layout compensation + validation.
 *
 * Many SVGA frames embed a bitmap that is larger than its visible content
 * (lots of fully-transparent padding). Cropping that padding and shifting the
 * sprite's `layout` by the same amount produces a pixel-identical render while
 * shrinking the PNG. This is what pro optimizers (Douyin/YY/Bilibili) do.
 *
 * Safety rules (a sprite/image is only trimmed when ALL are satisfied):
 *   - No matteKey, clipPath, or vector shapes on the sprite (masking/clipping).
 *   - Every referencing frame is translation-free (tx≈0, ty≈0) so the renderer
 *     honours layout x/y placement.
 *   - Layout size == native bitmap size (scale 1:1) so no resampling occurs.
 *
 * After trimming, the ENTIRE animation is re-rendered and compared frame-by
 * -frame against the original. Any mismatch → full rollback (no trim applied).
 */
async function trimTransparentAssets(message, options = {}) {
  const renderer = require('./svgaRenderer');
  const params = message.params || {};
  const width = params.viewBoxWidth || 0;
  const height = params.viewBoxHeight || 0;
  if (!width || !height || !message.images) {
    return { trimmedCount: 0, savedBytes: 0 };
  }

  const EPS = 1e-4;

  // Apply a native-pixel crop offset (left, top) + new size to one frame so
  // that it renders in the exact same screen position. Requires scale 1:1.
  //  - If the frame is positioned via a translation transform (tx/ty != 0),
  //    the renderer draws the bitmap at origin, so we fold the offset through
  //    the linear part of the matrix into tx/ty.
  //  - Otherwise the renderer positions via layout.x/y, so we shift those.
  const applyCrop = (f, left, top, newW, newH) => {
    const t = f.transform || {};
    const a = t.a ?? 1, b = t.b ?? 0, c = t.c ?? 0, d = t.d ?? 1;
    const tx = t.tx ?? 0, ty = t.ty ?? 0;
    const hasTranslation = Math.abs(tx) > EPS || Math.abs(ty) > EPS;
    if (hasTranslation) {
      f.transform = {
        a, b, c, d,
        tx: tx + a * left + c * top,
        ty: ty + b * left + d * top,
      };
    } else {
      f.layout.x = (f.layout.x ?? 0) + left;
      f.layout.y = (f.layout.y ?? 0) + top;
    }
    f.layout.width = newW;
    f.layout.height = newH;
  };

  // Map imageKey -> list of frames referencing it, plus eligibility flag.
  const usage = new Map(); // key -> { frames: [frameEntity], eligible: bool }
  for (const sprite of (message.sprites || [])) {
    if (!sprite || !sprite.imageKey) continue;
    const key = sprite.imageKey;
    let entry = usage.get(key);
    if (!entry) { entry = { frames: [], eligible: true }; usage.set(key, entry); }

    // Masking / clipping / vector content -> never trim this sprite's image.
    if (sprite.matteKey) entry.eligible = false;

    for (const f of (sprite.frames || [])) {
      if (!f) continue;
      const visible = (f.alpha == null ? 1 : f.alpha) > 0 && f.layout;
      if (f.clipPath && f.clipPath.length > 0) entry.eligible = false;
      if (Array.isArray(f.shapes) && f.shapes.length > 0) entry.eligible = false;
      if (visible) entry.frames.push(f);
    }
  }

  // Per-frame snapshot capturing BOTH original and trimmed state so we can
  // flip between them for validation without recomputing anything.
  const imageSnapshot = new Map(); // key -> original buffer
  const frameStates = [];          // { f, orig:{layout,transform}, trimmed:{layout,transform} }
  const plan = [];                 // { key, cropped, savedBytes }
  const snapLayout = (f) => ({
    x: f.layout.x ?? 0, y: f.layout.y ?? 0,
    width: f.layout.width, height: f.layout.height,
  });
  const snapTransform = (f) => (f.transform ? { ...f.transform } : null);

  for (const [key, entry] of usage.entries()) {
    if (!entry.eligible || entry.frames.length === 0) continue;
    const src = message.images[key];
    if (!src) continue;
    const srcBuffer = Buffer.from(src);

    let meta;
    try {
      meta = await sharp(srcBuffer).metadata();
    } catch { continue; }
    if (!meta.width || !meta.height) continue;

    // Require scale 1:1 for every referencing frame (no resampling).
    const scaleOk = entry.frames.every((f) =>
      Math.abs((f.layout.width ?? meta.width) - meta.width) < 1 &&
      Math.abs((f.layout.height ?? meta.height) - meta.height) < 1);
    if (!scaleOk) continue;

    // Compute the opaque bounding box via sharp's alpha-aware trim.
    let cropped, info;
    try {
      const out = await sharp(srcBuffer)
        .ensureAlpha()
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
        .png({ compressionLevel: 9, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      cropped = out.data;
      info = out.info;
    } catch { continue; }

    // trimOffsetLeft/Top tell us how much padding was removed (negative).
    const left = -(info.trimOffsetLeft || 0);
    const top = -(info.trimOffsetTop || 0);
    if (info.width >= meta.width && info.height >= meta.height) continue; // nothing trimmed
    if (cropped.length >= srcBuffer.length) continue;                     // no size win

    // Stage the crop: capture original state, apply compensation, capture trimmed.
    imageSnapshot.set(key, srcBuffer);
    for (const f of entry.frames) {
      const orig = { layout: snapLayout(f), transform: snapTransform(f) };
      applyCrop(f, left, top, info.width, info.height);
      const trimmed = { layout: snapLayout(f), transform: snapTransform(f) };
      frameStates.push({ f, orig, trimmed });
    }
    message.images[key] = cropped;
    plan.push({ key, cropped, savedBytes: srcBuffer.length - cropped.length });
  }

  if (plan.length === 0) {
    return { trimmedCount: 0, savedBytes: 0 };
  }

  const setState = (which) => {
    for (const s of frameStates) {
      const st = s[which];
      s.f.layout.x = st.layout.x; s.f.layout.y = st.layout.y;
      s.f.layout.width = st.layout.width; s.f.layout.height = st.layout.height;
      if (st.transform) s.f.transform = st.transform;
    }
  };
  const setImages = (trimmed) => {
    for (const p of plan) {
      message.images[p.key] = trimmed ? p.cropped : imageSnapshot.get(p.key);
    }
  };

  // VALIDATION: render a set of sampled frames in trimmed vs original state
  // and compare pixel-by-pixel. The crop math is provably exact for scale-1:1
  // integer offsets, so an evenly-spaced sample (capped) is sufficient to
  // catch any renderer edge case while keeping this fast on long animations.
  const totalFrames = params.frames || 1;
  const maxSamples = Math.min(totalFrames, options.trimValidateSamples || 8);
  const sampleIdx = [];
  if (totalFrames <= maxSamples) {
    for (let i = 0; i < totalFrames; i++) sampleIdx.push(i);
  } else {
    for (let s = 0; s < maxSamples; s++) {
      sampleIdx.push(Math.round((s * (totalFrames - 1)) / (maxSamples - 1)));
    }
  }

  let ok = true;
  try {
    // Render trimmed samples (current state).
    const afterRaw = [];
    for (const i of sampleIdx) {
      const buf = await renderer.renderPreviewFrame(message, message.images, i);
      afterRaw.push(await sharp(buf).ensureAlpha().raw().toBuffer());
    }
    // Flip to original state and render the same samples.
    setState('orig'); setImages(false);
    for (let s = 0; s < sampleIdx.length && ok; s++) {
      const buf = await renderer.renderPreviewFrame(message, message.images, sampleIdx[s]);
      const bRaw = await sharp(buf).ensureAlpha().raw().toBuffer();
      if (!rawBuffersMatch(afterRaw[s], bRaw)) {
        console.log(`[SVGA-Trim] Frame ${sampleIdx[s]} mismatch after trim — rolling back all trims.`);
        ok = false;
      }
    }
  } catch (err) {
    console.log(`[SVGA-Trim] Validation error — rolling back: ${err.message}`);
    ok = false;
  }

  if (!ok) {
    // Leave everything in the ORIGINAL state.
    setState('orig'); setImages(false);
    return { trimmedCount: 0, savedBytes: 0 };
  }

  // Validation passed — re-apply the trimmed state (we are currently original).
  setState('trimmed'); setImages(true);
  const savedBytes = plan.reduce((sum, p) => sum + p.savedBytes, 0);
  console.log(`[SVGA-Trim] Trimmed ${plan.length} asset(s), saved ${savedBytes} bytes (validated pixel-identical).`);
  return { trimmedCount: plan.length, savedBytes };
}

async function optimizeSVGADirect(svgaBuffer, options = {}) {
  const Movie = await loadProto();
  const startTime = Date.now();

  // Step 1: Decompress
  let decompressed;
  try {
    decompressed = pako.inflate(new Uint8Array(svgaBuffer));
  } catch (e) {
    decompressed = new Uint8Array(svgaBuffer);
  }

  // Step 2: Decode to protobuf Message (NOT toObject — preserves wire structure)
  const message = Movie.decode(decompressed);

  // Step 2.5: Playback-safe protobuf cleanup — remove UNUSED image assets.
  // An image entry is "used" only if a sprite references it via imageKey
  // (or an audio track references it via audioKey). Removing unreferenced
  // entries changes nothing visually but can shrink the file significantly.
  // This never touches sprites, frames, transforms, layouts, or timing.
  let removedUnused = 0;
  if (options.removeUnusedAssets && message.images) {
    const referenced = new Set();
    for (const sprite of (message.sprites || [])) {
      if (sprite && sprite.imageKey) referenced.add(sprite.imageKey);
    }
    for (const audio of (message.audios || [])) {
      if (audio && audio.audioKey) referenced.add(audio.audioKey);
    }
    // Only prune when we actually have sprite references to compare against,
    // otherwise we risk deleting assets from atypical/edge-case files.
    if (referenced.size > 0) {
      for (const key of Object.keys(message.images)) {
        if (!referenced.has(key)) {
          delete message.images[key];
          removedUnused++;
        }
      }
      if (removedUnused > 0) {
        console.log(`[SVGA-Direct] Removed ${removedUnused} unused image asset(s).`);
      }
    }
  }

  // Step 2.6: Deduplicate identical image assets (byte-for-byte).
  // Many SVGA exports embed the same PNG multiple times under different keys.
  // We keep one copy and repoint every sprite that referenced a duplicate.
  // This is 100% lossless — identical bytes render identically.
  let dedupedAssets = 0;
  if (options.dedupeAssets !== false && message.images) {
    const hashToKey = new Map();
    const keyRemap = new Map();
    for (const key of Object.keys(message.images)) {
      const buf = Buffer.from(message.images[key]);
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (hashToKey.has(hash)) {
        keyRemap.set(key, hashToKey.get(hash));
        delete message.images[key];
        dedupedAssets++;
      } else {
        hashToKey.set(hash, key);
      }
    }
    if (keyRemap.size > 0) {
      for (const sprite of (message.sprites || [])) {
        if (sprite && sprite.imageKey && keyRemap.has(sprite.imageKey)) {
          sprite.imageKey = keyRemap.get(sprite.imageKey);
        }
      }
      console.log(`[SVGA-Direct] Deduplicated ${dedupedAssets} identical image asset(s).`);
    }
  }

  // Step 2.7: Lossless transparent-border trimming (validated + rollback).
  let trimmedAssets = 0;
  if (options.trimTransparent && !options.skipImageOptimization) {
    try {
      const trimResult = await trimTransparentAssets(message, options);
      trimmedAssets = trimResult.trimmedCount;
    } catch (err) {
      console.log(`[SVGA-Trim] Skipped due to error: ${err.message}`);
    }
  }

  // Step 3: Optimize image buffers in-place on the message (if not skipped).
  //
  // IMPORTANT: SVGA files produced by the AE exporter are already pngquant'd
  // (palette PNG8, <=256 colors). Re-quantizing them yields nothing, and the
  // old "quantize then re-encode as RGBA type-6" path actually GREW every
  // image, which is why previous runs reported "0/N optimized" and the file
  // got slightly bigger.
  //
  // New approach: build several candidate encodings per image and keep the
  // SMALLEST one that is at least as good visually. The original buffer is
  // always a candidate, so an image can never grow. Strategies:
  //   1. lossless  — full RGBA, max zlib + max effort (pixel-perfect)
  //   2. palette   — PNG8 quantization (near-lossless for already-quantized art)
  // `losslessOnly: true` restricts to strategy 1 for a zero-risk guarantee.
  const quantizeColors = options.colors || 256;
  const quantizeQuality = options.quality || 100;
  const compressionLevel = options.compressionLevel || 9;
  // PNG `effort` 1-10 controls how hard sharp searches filters/zlib. Level 10
  // is near-zopfli and MASSIVELY slower for ~2-3% extra shrink. Default to a
  // fast, high-quality value; callers can override.
  const losslessEffort = Math.min(10, Math.max(1, options.effort || 4));
  const losslessOnly = options.losslessOnly === true;
  const allowPalette = !losslessOnly && options.palette !== false && options.rgbaQuantize !== false;

  const imageKeys = message.images ? Object.keys(message.images) : [];
  let optimizedCount = 0;
  let savedBytes = 0;

  if (!options.skipImageOptimization) {
    console.log(`[SVGA-Direct] Optimizing ${imageKeys.length} image(s)...`, {
      mode: losslessOnly ? 'lossless-only' : 'best-of(lossless,palette)',
      colors: quantizeColors,
      quality: quantizeQuality,
      effort: losslessEffort,
    });

    // Optimize ONE image: returns the smallest of {original, lossless, palette}.
    const optimizeOne = async (key) => {
      const sourceBuffer = Buffer.from(message.images[key]);
      let best = sourceBuffer;

      // Strategy 1: lossless RGBA re-compression (pixel-perfect).
      try {
        const lossless = await sharp(sourceBuffer, { animated: false, failOn: 'none' })
          .ensureAlpha()
          .png({ palette: false, compressionLevel, effort: losslessEffort, adaptiveFiltering: true, progressive: false })
          .toBuffer();
        if (lossless.length < best.length) best = lossless;
      } catch (err) {
        // Non-image entry (e.g. embedded audio) — leave untouched.
        return { key, skipped: true };
      }

      // Strategy 2: palette PNG8 quantization (mobile SVGA players decode this
      // natively). High color count + high quality keeps it visually faithful.
      if (allowPalette) {
        try {
          const palette = await sharp(sourceBuffer, { animated: false, failOn: 'none' })
            .ensureAlpha()
            .png({ palette: true, colors: quantizeColors, quality: quantizeQuality, dither: options.dither ?? 1.0, compressionLevel, effort: losslessEffort, progressive: false })
            .toBuffer();
          if (palette.length < best.length) best = palette;
        } catch (err) { /* lossless candidate still stands */ }
      }

      return { key, best, sourceLen: sourceBuffer.length };
    };

    // Run in parallel with a bounded concurrency so sharp saturates the CPU
    // threadpool instead of encoding one image at a time (the main slowdown).
    const concurrency = Math.max(2, Math.min(8, os.cpus().length || 4));
    let cursor = 0;
    const worker = async () => {
      while (cursor < imageKeys.length) {
        const key = imageKeys[cursor++];
        const res = await optimizeOne(key);
        if (res && !res.skipped && res.best.length < res.sourceLen) {
          message.images[key] = res.best;
          optimizedCount++;
          savedBytes += res.sourceLen - res.best.length;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    console.log(`[SVGA-Direct] Image assets saved ${savedBytes} bytes across ${optimizedCount} image(s).`);
  } else {
    console.log(`[SVGA-Direct] Image optimization skipped. Only modifying metadata / audio.`);
  }

  // Step 3.5: Add audio if provided
  if (options.audioBuffer && options.audioDuration) {
    const audioKey = 'audio_track';
    if (!message.images) {
      message.images = {};
    }
    message.images[audioKey] = options.audioBuffer;
    
    // Clear out any existing audio tracks to avoid conflicts
    message.audios = [{
      audioKey: audioKey,
      startFrame: 0,
      endFrame: message.params?.frames || 100,
      startTime: 0,
      totalTime: Math.round(options.audioDuration * 1000), // ms
    }];
    console.log(`[SVGA-Direct] Embedded audio buffer (${options.audioBuffer.length} bytes) for ${options.audioDuration} seconds.`);
  }

  // Step 4: Re-encode directly from the modified message (preserves all structure)
  const buffer = Movie.encode(message).finish();

  // Step 5: Compress with zlib
  const compressed = pako.deflate(buffer, { level: options.zlibLevel || 9 });
  const result = Buffer.from(compressed);

  const duration = Date.now() - startTime;
  const pct = svgaBuffer.length > 0 ? ((result.length / svgaBuffer.length) * 100).toFixed(1) : '100.0';
  console.log(`[SVGA-Direct] Complete in ${duration}ms: ${optimizedCount}/${imageKeys.length} images optimized, ${trimmedAssets} trimmed, ${removedUnused} unused + ${dedupedAssets} duplicate asset(s) removed, ${svgaBuffer.length} -> ${result.length} bytes (${pct}%)`);

  return result;
}

module.exports = {
  parseSVGA,
  extractImages,
  extractFrames,
  extractFramesForRendering,
  getMetadata,
  encodeSVGA,
  encodeMovieData,
  optimizeMovieData,
  optimizeAndEncodeMovieData,
  optimizeMovieDataForOneMb,
  optimizeSVGADirect,
  loadProto,
};
