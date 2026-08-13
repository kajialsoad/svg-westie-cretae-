/**
 * AnimSuite Pro - SVGA Canvas Renderer
 * Renders SVGA frames with proper sprite transforms
 */

const fs = require('fs');
const path = require('path');
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

function hasMeaningfulTransform(transform) {
  if (!transform) return false;
  const a = transform.a != null ? transform.a : 1;
  const b = transform.b != null ? transform.b : 0;
  const c = transform.c != null ? transform.c : 0;
  const d = transform.d != null ? transform.d : 1;
  const tx = transform.tx != null ? transform.tx : 0;
  const ty = transform.ty != null ? transform.ty : 0;
  return Math.abs(a - 1) > 0.001 ||
    Math.abs(b) > 0.001 ||
    Math.abs(c) > 0.001 ||
    Math.abs(d - 1) > 0.001 ||
    Math.abs(tx) > 0.001 ||
    Math.abs(ty) > 0.001;
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

      const usesTransformPlacement = hasMeaningfulTransform(sprite.transform);
      const transform = sprite.transform || null;
      const layout = sprite.layout || null;

      // Apply transform matrix if available
      if (transform) {
        const t = transform;
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

      // Preserve explicit layout size even when a transform exists.
      // For translated transforms, avoid double-applying layout x/y.
      let dx = layout && layout.x != null ? layout.x : 0;
      let dy = layout && layout.y != null ? layout.y : 0;
      const dw = layout && layout.width != null ? layout.width : img.width;
      const dh = layout && layout.height != null ? layout.height : img.height;

      if (usesTransformPlacement && transform) {
        const hasTransformTranslation = Math.abs(transform.tx != null ? transform.tx : 0) > 0.001 ||
          Math.abs(transform.ty != null ? transform.ty : 0) > 0.001;
        if (hasTransformTranslation) {
          dx = 0;
          dy = 0;
        }
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

async function renderFramesToDirectory(movieData, images, outputDir, options = {}) {
  const params = movieData.params || {};
  const width = params.viewBoxWidth || 300;
  const height = params.viewBoxHeight || 300;
  const totalFrames = params.frames || 1;
  const sprites = movieData.sprites || [];

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Rendering ${totalFrames} frames to disk at ${width}x${height}`);

  const convertedImages = {};
  for (const [key, rawBuf] of Object.entries(images || {})) {
    const buf = toNodeBuffer(rawBuf);
    if (buf && buf.length > 0) {
      convertedImages[key] = buf;
    }
  }

  let previewBuffer = null;
  const framePaths = [];

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const frameSprites = [];

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

    let buffer;
    if (frameSprites.length > 0) {
      buffer = await renderFrame({ sprites: frameSprites }, width, height);
    } else {
      const canvas = createCanvas(width, height);
      buffer = canvas.toBuffer('image/png');
    }

    if (!previewBuffer) {
      previewBuffer = buffer;
    }

    const framePath = path.join(outputDir, `frame_${String(frameIdx + 1).padStart(4, '0')}.png`);
    fs.writeFileSync(framePath, buffer);
    framePaths.push(framePath);

    if (typeof options.onFrame === 'function') {
      options.onFrame({
        frameIndex: frameIdx,
        totalFrames,
        framePath,
      });
    }

    if ((frameIdx + 1) % 10 === 0) {
      console.log(`Rendered ${frameIdx + 1}/${totalFrames} frames to disk`);
    }
  }

  return {
    width,
    height,
    totalFrames,
    framePaths,
    previewBuffer,
  };
}

async function renderPreviewFrame(movieData, images, frameIndex = 0) {
  const params = movieData.params || {};
  const width = params.viewBoxWidth || 300;
  const height = params.viewBoxHeight || 300;
  const sprites = movieData.sprites || [];

  const convertedImages = {};
  for (const [key, rawBuf] of Object.entries(images || {})) {
    const buf = toNodeBuffer(rawBuf);
    if (buf && buf.length > 0) {
      convertedImages[key] = buf;
    }
  }

  const frameSprites = [];
  for (const sprite of sprites) {
    if (!sprite.imageKey || !convertedImages[sprite.imageKey]) continue;

    const spriteFrames = sprite.frames || [];
    const frameData = spriteFrames[frameIndex];

    if (!frameData || !frameData.alpha || frameData.alpha <= 0) continue;

    frameSprites.push({
      imageBuffer: convertedImages[sprite.imageKey],
      alpha: frameData.alpha,
      transform: frameData.transform,
      layout: frameData.layout,
    });
  }

  if (frameSprites.length > 0) {
    return renderFrame({ sprites: frameSprites }, width, height);
  }

  const canvas = createCanvas(width, height);
  return canvas.toBuffer('image/png');
}

/**
 * Compose multiple SVGAs by stacking layers (bottom → top) into one animation.
 * @param {Array<{movieData: Object, images: Object, name?: string}>} layers
 * @param {Object} options
 * @returns {Promise<{frames: Array, width: number, height: number, fps: number}>}
 */
async function composeStackedLayers(layers, options = {}) {
  if (!layers || !layers.length) {
    throw new Error('At least one SVGA layer is required');
  }

  const transforms = options.transforms || [];
  let outW = 0;
  let outH = 0;
  let outFps = 0;
  let outFrames = 0;

  const prepared = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const t = transforms[i] || {};
    const speed = t.speed != null ? t.speed : 1;
    const scale = t.scale != null ? t.scale : 1;
    if (layer.staticPng) {
      const w = layer.width || 300;
      const h = layer.height || 300;
      outW = Math.max(outW, Math.ceil(w * scale + Math.abs(t.x || 0) * 2));
      outH = Math.max(outH, Math.ceil(h * scale + Math.abs(t.y || 0) * 2));
      outFps = Math.max(outFps, 20);
      outFrames = Math.max(outFrames, 1);
      prepared.push({
        name: layer.name || 'image',
        width: w,
        height: h,
        frameCount: 1,
        rendered: [{ buffer: layer.staticPng }],
        transform: {
          scale,
          x: t.x || 0,
          y: t.y || 0,
          rotation: t.rotation || 0,
          opacity: t.opacity != null ? t.opacity : 1,
          speed: 1,
          tintOn: !!t.tintOn,
          tint: t.tint || '#ffffff'
        }
      });
      continue;
    }

    const params = layer.movieData.params || {};
    const w = params.viewBoxWidth || 300;
    const h = params.viewBoxHeight || 300;
    const baseFps = params.fps || 20;
    const frames = params.frames || 1;

    outW = Math.max(outW, Math.ceil(w * scale + Math.abs(t.x || 0) * 2));
    outH = Math.max(outH, Math.ceil(h * scale + Math.abs(t.y || 0) * 2));
    outFps = Math.max(outFps, Math.round(baseFps * speed));
    // Longer duration if slowed down
    const effectiveFrames = Math.max(1, Math.round(frames / Math.max(0.25, speed)));
    outFrames = Math.max(outFrames, effectiveFrames);

    const rendered = await renderAllFrames(layer.movieData, layer.images || layer.movieData.images || {});
    prepared.push({
      name: layer.name || 'layer',
      width: w,
      height: h,
      frameCount: frames,
      rendered,
      transform: {
        scale,
        x: t.x || 0,
        y: t.y || 0,
        rotation: t.rotation || 0,
        opacity: t.opacity != null ? t.opacity : 1,
        speed,
        tintOn: !!t.tintOn,
        tint: t.tint || '#ffffff'
      }
    });
  }

  outW = options.width || Math.max(outW, 1);
  outH = options.height || Math.max(outH, 1);
  outFps = options.fps || outFps || 20;
  outFrames = options.frames || outFrames || 1;

  const composed = [];
  for (let i = 0; i < outFrames; i++) {
    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext('2d', { alpha: true, premultipliedAlpha: false });
    ctx.clearRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (const layer of prepared) {
      const speed = layer.transform.speed || 1;
      const srcIdx = Math.min(
        layer.frameCount - 1,
        Math.max(0, Math.floor(i * speed))
      );
      const frame = layer.rendered[srcIdx];
      if (!frame || !frame.buffer) continue;
      const img = await loadImage(frame.buffer);

      const scale = layer.transform.scale || 1;
      const dw = layer.width * scale;
      const dh = layer.height * scale;
      const cx = outW / 2 + (layer.transform.x || 0);
      const cy = outH / 2 + (layer.transform.y || 0);
      const rot = ((layer.transform.rotation || 0) * Math.PI) / 180;

      ctx.save();
      ctx.globalAlpha = layer.transform.opacity != null ? layer.transform.opacity : 1;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      if (layer.transform.tintOn && layer.transform.tint && layer.transform.tint !== '#ffffff') {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = layer.transform.tint;
        ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }

    composed.push({ imageBuffer: canvas.toBuffer('image/png') });
  }

  return { frames: composed, width: outW, height: outH, fps: outFps };
}

module.exports = {
  renderFrame,
  renderAllFrames,
  renderFramesToDirectory,
  renderPreviewFrame,
  composeStackedLayers,
};
