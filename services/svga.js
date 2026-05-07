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
 * This generates one image per frame based on sprite animations
 * @param {Object} movieData - Parsed movie data
 * @returns {Array} - Array of frame buffers (one per animation frame)
 */
function extractFrames(movieData) {
  const params = movieData.params || {};
  const totalFrames = params.frames || 1;
  const sprites = movieData.sprites || [];
  const images = movieData.images || {};

  // If there are sprites with frame data, we need to render each frame
  // For now, we'll return the base images repeated for each frame
  // This is a simplified approach - full sprite rendering would require canvas
  const frames = [];
  
  // Get all unique images
  const imageBuffers = Object.values(images).filter(buf => buf && buf.length > 0);
  
  if (imageBuffers.length === 0) {
    return [];
  }

  // If we have sprites, try to extract frame-specific images
  if (sprites.length > 0) {
    // For each frame, collect visible sprites
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      // Find sprites visible in this frame
      for (const sprite of sprites) {
        if (sprite.imageKey && images[sprite.imageKey]) {
          const spriteFrames = sprite.frames || [];
          if (spriteFrames[frameIdx] && spriteFrames[frameIdx].alpha > 0) {
            frames.push({
              imageKey: sprite.imageKey,
              imageBuffer: Buffer.from(images[sprite.imageKey]),
              frameIndex: frameIdx,
            });
            break; // One image per frame for now
          }
        }
      }
    }
  }

  // Fallback: if no frames extracted, return all images
  if (frames.length === 0) {
    return imageBuffers.map((buf, idx) => ({
      imageKey: `frame_${idx}`,
      imageBuffer: Buffer.from(buf),
      frameIndex: idx,
    }));
  }

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
 * @param {Object} options - { width, height, fps }
 * @returns {Buffer} - Encoded .svga file buffer
 */
async function encodeSVGA(frames, options = {}) {
  const Movie = await loadProto();

  const width = options.width || 300;
  const height = options.height || 300;
  const fps = options.fps || 24;
  const totalFrames = frames.length;

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
        spriteFrames.push({
          alpha: 1.0,
          layout: { x: 0, y: 0, width, height },
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        });
      } else {
        // This frame is hidden
        spriteFrames.push({
          alpha: 0.0,
          layout: { x: 0, y: 0, width, height },
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        });
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
  };

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
  getMetadata,
  encodeSVGA,
  loadProto,
};
