/**
 * AnimSuite Pro - SVGA Canvas Renderer
 * Renders SVGA frames with proper sprite transforms
 */

const { createCanvas, loadImage } = require('canvas');

/**
 * Ensure data is a proper Node.js Buffer that loadImage can consume.
 * Protobuf may produce Uint8Array, ArrayBuffer, or nested {type, data} objects.
 */
function toNodeBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data.buffer && data.buffer instanceof ArrayBuffer) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  // protobufjs sometimes wraps bytes as { type: 'Buffer', data: [...] }
  if (data.type === 'Buffer' && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  // If it's an array of numbers, treat as raw byte array
  if (Array.isArray(data)) {
    return Buffer.from(data);
  }
  return null;
}

/**
 * Render a single SVGA frame with all sprites and transforms
 * @param {Object} frameData - Frame data with sprites and transforms
 * @param {Number} width - Canvas width
 * @param {Number} height - Canvas height
 * @returns {Buffer} - PNG buffer of rendered frame
 */
async function renderFrame(frameData, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', {
    alpha: true,
    premultipliedAlpha: false
  });

  // High quality rendering settings
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Clear canvas with transparency
  ctx.clearRect(0, 0, width, height);

  // Sort sprites by z-index if available (render back to front)
  const sprites = frameData.sprites || [];

  for (const sprite of sprites) {
    try {
      // Convert to proper Buffer for node-canvas loadImage
      const imgBuf = toNodeBuffer(sprite.imageBuffer);
      if (!imgBuf || imgBuf.length === 0) {
        continue; // skip empty images silently
      }

      // Load sprite image
      const img = await loadImage(imgBuf);

      // Save context state
      ctx.save();

      // Apply alpha
      ctx.globalAlpha = sprite.alpha != null ? sprite.alpha : 1.0;

      // Apply transform matrix if available
      if (sprite.transform) {
        const t = sprite.transform;
        // SVGA uses affine transform matrix: [a, b, c, d, tx, ty]
        // Use != null to preserve 0 values (|| treats 0 as falsy)
        ctx.transform(
          t.a != null ? t.a : 1,
          t.b != null ? t.b : 0,
          t.c != null ? t.c : 0,
          t.d != null ? t.d : 1,
          t.tx != null ? t.tx : 0,
          t.ty != null ? t.ty : 0
        );
      }

      // Apply layout (position and size) if available
      let dx = 0, dy = 0, dw = img.width, dh = img.height;
      if (sprite.layout) {
        dx = sprite.layout.x != null ? sprite.layout.x : 0;
        dy = sprite.layout.y != null ? sprite.layout.y : 0;
        dw = sprite.layout.width != null ? sprite.layout.width : img.width;
        dh = sprite.layout.height != null ? sprite.layout.height : img.height;
      }

      // Draw sprite
      ctx.drawImage(img, dx, dy, dw, dh);

      // Restore context state
      ctx.restore();
    } catch (err) {
      console.warn('Failed to render sprite:', err.message);
    }
  }

  // Return PNG buffer
  return canvas.toBuffer('image/png');
}

/**
 * Render all frames from SVGA movie data
 * @param {Object} movieData - Parsed SVGA movie data
 * @param {Object} images - Map of imageKey -> Buffer
 * @returns {Array} - Array of {frameIndex, buffer} objects
 */
async function renderAllFrames(movieData, images) {
  const params = movieData.params || {};
  const width = params.viewBoxWidth || 300;
  const height = params.viewBoxHeight || 300;
  const totalFrames = params.frames || 1;
  const sprites = movieData.sprites || [];

  console.log(`Rendering ${totalFrames} frames at ${width}x${height}`);

  // Pre-convert all image buffers to proper Node.js Buffers
  const convertedImages = {};
  let convertedCount = 0;
  let skippedCount = 0;
  for (const [key, rawBuf] of Object.entries(images)) {
    const buf = toNodeBuffer(rawBuf);
    if (buf && buf.length > 0) {
      convertedImages[key] = buf;
      convertedCount++;
      // Log first image's header bytes for debugging
      if (convertedCount === 1) {
        const header = buf.slice(0, 8).toString('hex');
        const isPNG = buf[0] === 0x89 && buf[1] === 0x50;
        const isJPEG = buf[0] === 0xFF && buf[1] === 0xD8;
        const isWebP = buf.slice(0, 4).toString() === 'RIFF';
        console.log(`Image format detection: header=${header}, PNG=${isPNG}, JPEG=${isJPEG}, WebP=${isWebP}, size=${buf.length}`);
      }
    } else {
      skippedCount++;
    }
  }
  console.log(`Image conversion: ${convertedCount} converted, ${skippedCount} skipped out of ${Object.keys(images).length} total`);

  const renderedFrames = [];

  // Build frame data structure
  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const frameSprites = [];

    // Collect all sprites visible in this frame
    for (const sprite of sprites) {
      if (!sprite.imageKey || !convertedImages[sprite.imageKey]) continue;

      const spriteFrames = sprite.frames || [];
      const frameData = spriteFrames[frameIdx];

      if (!frameData || !frameData.alpha || frameData.alpha <= 0) continue;

      frameSprites.push({
        imageBuffer: convertedImages[sprite.imageKey],
        alpha: frameData.alpha,
        transform: frameData.transform,
        layout: frameData.layout,
      });
    }

    // Render this frame
    if (frameSprites.length > 0) {
      const buffer = await renderFrame({ sprites: frameSprites }, width, height);
      renderedFrames.push({
        frameIndex: frameIdx,
        buffer: buffer,
      });
    } else {
      // Empty frame - create transparent canvas
      const canvas = createCanvas(width, height);
      const buffer = canvas.toBuffer('image/png');
      renderedFrames.push({
        frameIndex: frameIdx,
        buffer: buffer,
      });
    }

    if ((frameIdx + 1) % 10 === 0) {
      console.log(`Rendered ${frameIdx + 1}/${totalFrames} frames`);
    }
  }

  console.log(`Rendering complete: ${renderedFrames.length} frames`);
  return renderedFrames;
}

module.exports = {
  renderFrame,
  renderAllFrames,
};
