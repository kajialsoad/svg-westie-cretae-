/**
 * AnimSuite Pro - SVGA Service
 * Parse and encode SVGA 2.0 animation files
 * SVGA 2.0 = protobuf encoded + zlib compressed
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pako = require('pako');
const protobuf = require('protobufjs');
const sharp = require('sharp');

let MovieEntity = null;

// Load proto definition once
async function loadProto() {
  if (MovieEntity) return MovieEntity;
  const root = await protobuf.load(path.join(__dirname, '..', 'proto', 'svga.proto'));
  MovieEntity = root.lookupType('com.opensource.svga.MovieEntity');
  return MovieEntity;
}

/**
 * Parse an SVGA file buffer into a MovieEntity object
 * @param {Buffer} svgaBuffer - Raw .svga file buffer
 * @returns {Object} - Decoded movie data with params, images, sprites
 */
async function parseSVGA(svgaBuffer) {
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

  // Step 3: Optimize image buffers in-place on the message
  const useRgbaQuantize = options.rgbaQuantize === true;
  const usePalette = !useRgbaQuantize && options.palette === true;
  const quantizeColors = options.colors || 256;
  const quantizeQuality = options.quality || 80;
  const compressionLevel = options.compressionLevel || 9;

  const imageKeys = message.images ? Object.keys(message.images) : [];
  console.log(`[SVGA-Direct] Optimizing ${imageKeys.length} image(s)...`, {
    mode: useRgbaQuantize ? 'rgba-quantize' : (usePalette ? 'palette' : 'lossless'),
    colors: quantizeColors,
    quality: quantizeQuality,
  });

  let optimizedCount = 0;

  for (const key of imageKeys) {
    const rawBuffer = message.images[key];
    const sourceBuffer = Buffer.from(rawBuffer);

    try {
      let sharpObj = sharp(sourceBuffer, { animated: false, failOn: 'none' });
      let optimizedBuffer;

      if (useRgbaQuantize) {
        // Pass 1: Quantize colors using palette mode
        const quantized = await sharpObj
          .ensureAlpha()
          .png({
            palette: true,
            colors: quantizeColors,
            quality: quantizeQuality,
            compressionLevel: 0,
            effort: 1,
          })
          .toBuffer();

        // Pass 2: Re-encode as standard RGBA PNG (type 6)
        optimizedBuffer = await sharp(quantized, { animated: false, failOn: 'none' })
          .ensureAlpha()
          .png({ palette: false, compressionLevel })
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

      // Only use optimized buffer if meaningfully smaller
      if (optimizedBuffer.length < sourceBuffer.length * 0.97) {
        message.images[key] = optimizedBuffer;
        optimizedCount++;
        console.log(`[SVGA-Direct] Image ${key}: ${sourceBuffer.length} -> ${optimizedBuffer.length} bytes (${((optimizedBuffer.length / sourceBuffer.length) * 100).toFixed(1)}%)`);
      }
    } catch (err) {
      // Non-image buffers (e.g. audio data) — leave untouched
      console.log(`[SVGA-Direct] Skipped non-image entry ${key}: ${err.message}`);
    }
  }

  // Step 4: Re-encode directly from the modified message (preserves all structure)
  const buffer = Movie.encode(message).finish();

  // Step 5: Compress with zlib
  const compressed = pako.deflate(buffer, { level: options.zlibLevel || 9 });
  const result = Buffer.from(compressed);

  const duration = Date.now() - startTime;
  console.log(`[SVGA-Direct] Complete in ${duration}ms: ${optimizedCount}/${imageKeys.length} images optimized, ${svgaBuffer.length} -> ${result.length} bytes`);

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
