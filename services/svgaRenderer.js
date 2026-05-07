/**
 * AnimSuite Pro - SVGA Canvas Renderer
 * Renders SVGA frames with proper sprite transforms
 */

const { createCanvas, loadImage } = require('canvas');

/**
 * Render a single SVGA frame with all sprites and transforms
 * @param {Object} frameData - Frame data with sprites and transforms
 * @param {Number} width - Canvas width
 * @param {Number} height - Canvas height
 * @returns {Buffer} - PNG buffer of rendered frame
 */
async function renderFrame(frameData, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  
  // Clear canvas with transparency
  ctx.clearRect(0, 0, width, height);
  
  // Sort sprites by z-index if available (render back to front)
  const sprites = frameData.sprites || [];
  
  for (const sprite of sprites) {
    try {
      // Load sprite image
      const img = await loadImage(sprite.imageBuffer);
      
      // Save context state
      ctx.save();
      
      // Apply alpha
      ctx.globalAlpha = sprite.alpha || 1.0;
      
      // Apply transform matrix if available
      if (sprite.transform) {
        const t = sprite.transform;
        // SVGA uses affine transform matrix: [a, b, c, d, tx, ty]
        // a, d: scale
        // b, c: skew/rotation
        // tx, ty: translation
        ctx.transform(
          t.a || 1,  // horizontal scaling
          t.b || 0,  // horizontal skewing
          t.c || 0,  // vertical skewing
          t.d || 1,  // vertical scaling
          t.tx || 0, // horizontal translation
          t.ty || 0  // vertical translation
        );
      }
      
      // Apply layout (position and size) if available
      let dx = 0, dy = 0, dw = img.width, dh = img.height;
      if (sprite.layout) {
        dx = sprite.layout.x || 0;
        dy = sprite.layout.y || 0;
        dw = sprite.layout.width || img.width;
        dh = sprite.layout.height || img.height;
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
  
  const renderedFrames = [];
  
  // Build frame data structure
  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const frameSprites = [];
    
    // Collect all sprites visible in this frame
    for (const sprite of sprites) {
      if (!sprite.imageKey || !images[sprite.imageKey]) continue;
      
      const spriteFrames = sprite.frames || [];
      const frameData = spriteFrames[frameIdx];
      
      if (!frameData || frameData.alpha <= 0) continue;
      
      frameSprites.push({
        imageBuffer: images[sprite.imageKey],
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
