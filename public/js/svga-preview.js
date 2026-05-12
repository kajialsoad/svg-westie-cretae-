/**
 * Production-Level SVGA Preview System
 * Preserves 1:1 fidelity with original SVGA engine
 */

let svgaPlayer = null;
let svgaParser = null;

async function showSVGAPreview(file) {
  const previewBox = document.getElementById('svga-upload-preview');
  const fileNameEl = document.getElementById('svga-file-name');
  const fileSizeEl = document.getElementById('svga-file-size');
  const playerCanvas = document.getElementById('svga-player-canvas');
  
  console.log('🔥 PRODUCTION SVGA Preview System');
  console.log('File:', file.name, (file.size / (1024 * 1024)).toFixed(2), 'MB');
  
  previewBox.style.display = 'block';
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';

  const url = URL.createObjectURL(file);
  
  // Handle SVG images
  if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml') {
    playerCanvas.innerHTML = `<img src="${url}" style="max-height:100%; max-width:100%;">`;
    return;
  }
  
  // Check/load SVGA library
  const loader = window.ensureSVGALibraryLoaded;
  if (typeof SVGA === 'undefined' && typeof loader === 'function') {
    await loader();
  }
  if (typeof SVGA === 'undefined') {
    playerCanvas.innerHTML = '<div style="color:#888;padding:2rem;">SVGA library not loaded</div>';
    URL.revokeObjectURL(url);
    return;
  }
  
  // Clear and prepare
  playerCanvas.innerHTML = '';
  
  // Stop existing player
  if (svgaPlayer) {
    try {
      svgaPlayer.stopAnimation();
      svgaPlayer.clear();
    } catch (e) {}
  }
  
  // Create container
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
  playerCanvas.appendChild(container);
  container.innerHTML = '<div style="color:#888;">Loading...</div>';
  
  // Timeout
  const timeout = setTimeout(() => {
    container.innerHTML = '<div style="color:#888;padding:2rem;">Preview timeout<br><small>Conversion will work</small></div>';
  }, 8000);
  
  // Create parser
  svgaParser = new SVGA.Parser();
  
  // Load SVGA
  svgaParser.load(url, (videoItem) => {
    clearTimeout(timeout);
    
    const width = videoItem.videoSize.width || 300;
    const height = videoItem.videoSize.height || 300;
    const fps = Math.min(videoItem.FPS || 30, 60);
    
    console.log('✅ Loaded:', width, 'x', height, fps, 'FPS');
    
    container.innerHTML = '';
    
    // Create canvas - ORIGINAL size (1:1 fidelity)
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    // Use ACTUAL SVGA size for display (no scaling)
    const dw = width;
    const dh = height;
    
    console.log('Display: ORIGINAL SIZE', dw, 'x', dh);
    
    // CSS display size = ACTUAL size (1:1, no scaling)
    canvas.style.cssText = `
      width:${dw}px;
      height:${dh}px;
      display:block;
      margin:0 auto;
      transform:translate3d(0,0,0);
      backface-visibility:hidden;
      will-change:transform;
      contain:strict;
      isolation:isolate;
      object-fit:contain;
      image-rendering:auto;
    `;
    
    container.classList.add('checkerboard-bg');
    container.appendChild(canvas);
    
    // Context - PRODUCTION settings
    const ctx = canvas.getContext('2d', {
      alpha: true,
      premultipliedAlpha: false,
      desynchronized: true,  // CRITICAL: Low-latency
      willReadFrequently: false
    });
    
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    
    // Create player
    svgaPlayer = new SVGA.Player(canvas);
    svgaPlayer.loops = 0;
    svgaPlayer.clearsAfterStop = false;
    svgaPlayer.fillMode = 'Forward';
    
    if (svgaPlayer.setContentMode) {
      svgaPlayer.setContentMode('AspectFit');
    }
    
    // Start
    svgaPlayer.setVideoItem(videoItem);
    svgaPlayer.startAnimation();
    
    console.log('🚀 Preview Started - Production Mode');
    
    URL.revokeObjectURL(url);
    
  }, (error) => {
    clearTimeout(timeout);
    console.error('Load error:', error);
    container.innerHTML = '<div style="color:#888;padding:2rem;">Preview unavailable<br><small>Conversion will work</small></div>';
    URL.revokeObjectURL(url);
  });
}
