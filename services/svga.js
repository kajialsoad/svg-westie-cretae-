/**
 * AnimSuite Pro - SVGA Service
 * Parse and encode SVGA 2.0 animation files
 * SVGA 2.0 = protobuf encoded + zlib compressed
 */

const path = require('path');
const fs = require('fs');
const pako = require('pako');
const protobuf = require('protobufjs');

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
    enums: String,
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
  const totalFrames = frames.length;
  console.log('[SVGA][Encode][Start]', {
    width,
    height,
    fps,
    totalFrames,
    opaqueFrames
  });

  // Build images map
  const images = {};
  frames.forEach((frame, index) => {
    const key = `frame_${index}`;
    images[key] = frame.imageBuffer;
  });

  // Build sprites - one sprite per frame with simple display
  const sprites = [];

  // Create a single sprite that cycles through all frames
  // Each frame shows the corresponding image
  frames.forEach((frame, index) => {
    const key = `frame_${index}`;
    const spriteFrames = [];

    for (let f = 0; f < totalFrames; f++) {
      if (f === index) {
        // This frame is visible
        const visibleFrame = {
          alpha: 1.0, // Keep explicit alpha for player compatibility (fully opaque)
          layout: { x: 0, y: 0, width: width, height: height },
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        };

        spriteFrames.push(visibleFrame);
      } else {
        // This frame is hidden - send empty object to save space
        spriteFrames.push({});
      }
    }

    sprites.push({
      imageKey: key,
      frames: spriteFrames,
    });
  });

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
  const compressed = pako.deflate(buffer);

  return Buffer.from(compressed);
}

module.exports = {
  parseSVGA,
  extractImages,
  extractFrames,
  extractFramesForRendering,
  getMetadata,
  encodeSVGA,
  loadProto,
};
