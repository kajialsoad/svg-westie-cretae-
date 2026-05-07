/**
 * AnimSuite Pro - PNG Animation Editor
 * Canvas-based animation editor with Fabric.js
 */

// ===== STATE =====
const editorState = {
  canvas: null,
  layers: [],
  selectedLayer: null,
  isPlaying: false,
  currentFrame: 0,
  totalFrames: 0,
  fps: 15,
  duration: 2,
  animationInterval: null,
  frames: [],
  effects: {},
};

// ===== ANIMATION EFFECTS =====
const EFFECTS = {
  fadeIn: { name: 'Fade In', duration: 1 },
  fadeOut: { name: 'Fade Out', duration: 1 },
  bounce: { name: 'Bounce', duration: 1 },
  rotate360: { name: 'Rotate 360°', duration: 2 },
  scaleUp: { name: 'Scale Up', duration: 1 },
  scaleDown: { name: 'Scale Down', duration: 1 },
  slideLeft: { name: 'Slide Left', duration: 1 },
  slideRight: { name: 'Slide Right', duration: 1 },
};

// ===== INIT EDITOR =====
function initEditor() {
  const canvasEl = document.getElementById('editor-canvas');
  if (!canvasEl) return;

  // Initialize Fabric.js canvas
  editorState.canvas = new fabric.Canvas('editor-canvas', {
    backgroundColor: '#1e293b',
    selection: true,
    preserveObjectStacking: true,
  });

  // Handle canvas size changes
  const sizeSelect = document.getElementById('editor-canvas-size');
  if (sizeSelect) {
    sizeSelect.addEventListener('change', (e) => {
      const size = parseInt(e.target.value);
      editorState.canvas.setDimensions({ width: size, height: size });
      editorState.canvas.renderAll();
    });
  }

  // Handle FPS changes
  const fpsInput = document.getElementById('editor-fps');
  if (fpsInput) {
    fpsInput.addEventListener('change', (e) => {
      editorState.fps = parseInt(e.target.value) || 15;
    });
  }

  // Handle duration changes
  const durationInput = document.getElementById('editor-duration');
  if (durationInput) {
    durationInput.addEventListener('change', (e) => {
      editorState.duration = parseFloat(e.target.value) || 2;
    });
  }

  // Object selection handler
  editorState.canvas.on('selection:created', (e) => {
    if (e.selected && e.selected.length > 0) {
      const obj = e.selected[0];
      editorState.selectedLayer = obj;
      updateLayerSelection();
    }
  });

  editorState.canvas.on('selection:updated', (e) => {
    if (e.selected && e.selected.length > 0) {
      const obj = e.selected[0];
      editorState.selectedLayer = obj;
      updateLayerSelection();
    }
  });

  editorState.canvas.on('selection:cleared', () => {
    editorState.selectedLayer = null;
    updateLayerSelection();
  });

  // Object modified handler
  editorState.canvas.on('object:modified', () => {
    renderLayersList();
  });

  console.log('✅ Editor initialized');
}

// ===== FILE UPLOAD =====
function handleEditorDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleEditorFiles(files);
  }
}

function handleEditorFileSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    handleEditorFiles(files);
  }
}

function handleEditorFiles(files) {
  Array.from(files).forEach((file) => {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        addImageToCanvas(e.target.result, file.name);
      };
      reader.readAsDataURL(file);
    }
  });
}

// ===== ADD IMAGE TO CANVAS =====
function addImageToCanvas(imageUrl, filename) {
  fabric.Image.fromURL(imageUrl, (img) => {
    // Scale image to fit canvas
    const canvasSize = editorState.canvas.width;
    const scale = Math.min(canvasSize / img.width, canvasSize / img.height) * 0.5;
    
    img.scale(scale);
    img.set({
      left: canvasSize / 2,
      top: canvasSize / 2,
      originX: 'center',
      originY: 'center',
      id: `layer_${Date.now()}`,
      name: filename || `Layer ${editorState.layers.length + 1}`,
    });

    editorState.canvas.add(img);
    editorState.layers.push(img);
    editorState.canvas.setActiveObject(img);
    editorState.selectedLayer = img;
    
    renderLayersList();
    editorState.canvas.renderAll();
    
    showToast(`Added ${filename}`, 'success');
  });
}

// ===== LAYERS LIST =====
function renderLayersList() {
  const layersList = document.getElementById('layers-list');
  if (!layersList) return;

  layersList.innerHTML = '';

  editorState.layers.forEach((layer, index) => {
    const layerDiv = document.createElement('div');
    layerDiv.className = 'layer-item';
    layerDiv.style.cssText = `
      padding: 8px 12px;
      margin: 4px 0;
      background: ${layer === editorState.selectedLayer ? '#f59e0b' : '#1e293b'};
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: 0.2s;
    `;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = layer.name || `Layer ${index + 1}`;
    nameSpan.style.fontSize = '0.85rem';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑️';
    deleteBtn.style.cssText = `
      background: #ef4444;
      border: none;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
    `;
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteLayer(layer);
    };

    layerDiv.onclick = () => selectLayer(layer);
    layerDiv.appendChild(nameSpan);
    layerDiv.appendChild(deleteBtn);
    layersList.appendChild(layerDiv);
  });
}

function selectLayer(layer) {
  editorState.canvas.setActiveObject(layer);
  editorState.selectedLayer = layer;
  editorState.canvas.renderAll();
  renderLayersList();
}

function deleteLayer(layer) {
  editorState.canvas.remove(layer);
  editorState.layers = editorState.layers.filter(l => l !== layer);
  if (editorState.selectedLayer === layer) {
    editorState.selectedLayer = null;
  }
  renderLayersList();
  editorState.canvas.renderAll();
  showToast('Layer deleted', 'info');
}

function updateLayerSelection() {
  renderLayersList();
}

// ===== ANIMATION EFFECTS =====
function applyEffect(effectName) {
  if (!editorState.selectedLayer) {
    showToast('Please select a layer first', 'error');
    return;
  }

  const layerId = editorState.selectedLayer.id;
  
  if (!editorState.effects[layerId]) {
    editorState.effects[layerId] = [];
  }

  editorState.effects[layerId].push({
    type: effectName,
    startTime: 0,
    duration: EFFECTS[effectName]?.duration || 1,
  });

  showToast(`Applied ${EFFECTS[effectName]?.name || effectName}`, 'success');
}

// ===== ANIMATION PLAYBACK =====
function editorPlay() {
  if (editorState.isPlaying) return;
  if (editorState.layers.length === 0) {
    showToast('Add images first', 'error');
    return;
  }

  editorState.isPlaying = true;
  editorState.currentFrame = 0;
  editorState.totalFrames = Math.floor(editorState.fps * editorState.duration);

  const frameDelay = 1000 / editorState.fps;

  editorState.animationInterval = setInterval(() => {
    renderFrame(editorState.currentFrame);
    editorState.currentFrame++;

    // Update timeline
    const progress = (editorState.currentFrame / editorState.totalFrames) * 100;
    const cursor = document.getElementById('timeline-cursor');
    const timeDisplay = document.getElementById('timeline-time');
    if (cursor) cursor.style.left = `${progress}%`;
    if (timeDisplay) timeDisplay.textContent = `${(editorState.currentFrame / editorState.fps).toFixed(2)}s`;

    if (editorState.currentFrame >= editorState.totalFrames) {
      editorState.currentFrame = 0; // Loop
    }
  }, frameDelay);

  showToast('Playing animation', 'info');
}

function editorPause() {
  if (!editorState.isPlaying) return;
  
  clearInterval(editorState.animationInterval);
  editorState.isPlaying = false;
  
  showToast('Paused', 'info');
}

function editorReset() {
  editorPause();
  editorState.currentFrame = 0;
  
  // Reset all objects to original state
  editorState.layers.forEach(layer => {
    layer.set({
      opacity: 1,
      scaleX: layer.scaleX,
      scaleY: layer.scaleY,
      angle: 0,
    });
  });
  
  editorState.canvas.renderAll();
  
  const cursor = document.getElementById('timeline-cursor');
  const timeDisplay = document.getElementById('timeline-time');
  if (cursor) cursor.style.left = '0%';
  if (timeDisplay) timeDisplay.textContent = '0.00s';
  
  showToast('Reset to start', 'info');
}

function renderFrame(frameIndex) {
  const t = frameIndex / editorState.totalFrames;

  editorState.layers.forEach(layer => {
    const layerId = layer.id;
    const effects = editorState.effects[layerId] || [];

    // Reset layer
    layer.set({
      opacity: 1,
      angle: 0,
      left: layer.left,
      top: layer.top,
    });

    // Apply effects
    effects.forEach(effect => {
      const effectT = Math.min(1, t / (effect.duration / editorState.duration));

      switch (effect.type) {
        case 'fadeIn':
          layer.set({ opacity: effectT });
          break;
        case 'fadeOut':
          layer.set({ opacity: 1 - effectT });
          break;
        case 'bounce':
          const bounceY = Math.abs(Math.sin(effectT * Math.PI * 4)) * 50;
          layer.set({ top: layer.top - bounceY });
          break;
        case 'rotate360':
          layer.set({ angle: effectT * 360 });
          break;
        case 'scaleUp':
          const scaleUp = 1 + effectT;
          layer.set({ scaleX: layer.scaleX * scaleUp, scaleY: layer.scaleY * scaleUp });
          break;
        case 'scaleDown':
          const scaleDown = 1 - effectT * 0.5;
          layer.set({ scaleX: layer.scaleX * scaleDown, scaleY: layer.scaleY * scaleDown });
          break;
        case 'slideLeft':
          layer.set({ left: layer.left - effectT * editorState.canvas.width });
          break;
        case 'slideRight':
          layer.set({ left: layer.left + effectT * editorState.canvas.width });
          break;
      }
    });
  });

  editorState.canvas.renderAll();
}

// ===== RESET ANIMATIONS =====
function resetAnimations() {
  editorState.effects = {};
  showToast('All effects cleared', 'info');
}

// ===== EXPORT ANIMATION =====
async function exportAnimation() {
  if (editorState.layers.length === 0) {
    showToast('Add images first', 'error');
    return;
  }

  const exportBtn = document.getElementById('export-btn');
  const exportResult = document.getElementById('export-result');
  const exportResultInfo = document.getElementById('export-result-info');
  
  exportBtn.classList.add('loading');
  exportBtn.disabled = true;

  try {
    // Get export settings
    const format = document.querySelector('input[name="export-format"]:checked')?.value || 'gif';
    const sizeTier = document.querySelector('input[name="editor-size"]:checked')?.value || 'standard';
    const fps = parseInt(document.getElementById('editor-fps')?.value) || 15;
    const duration = parseFloat(document.getElementById('editor-duration')?.value) || 2;

    // Generate frames
    const totalFrames = Math.floor(fps * duration);
    const frames = [];

    for (let i = 0; i < totalFrames; i++) {
      renderFrame(i);
      
      // Capture frame as blob
      const dataURL = editorState.canvas.toDataURL('image/png');
      const blob = await (await fetch(dataURL)).blob();
      frames.push(blob);
    }

    // Send to backend
    const formData = new FormData();
    frames.forEach((blob, index) => {
      formData.append('files', blob, `frame_${index}.png`);
    });
    formData.append('format', format);
    formData.append('sizeTier', sizeTier);
    formData.append('fps', fps);

    const res = await fetch('/api/convert/png-animation', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || 'Export failed');
    }

    // Show result
    exportResult.style.display = 'block';
    exportResultInfo.innerHTML = `
      <strong>✅ Export Complete</strong><br>
      Format: ${format.toUpperCase()}<br>
      Size: ${data.sizeMB} MB<br>
      Frames: ${totalFrames}
    `;

    // Download button
    const dlBtn = document.getElementById('export-download-btn');
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = `/api/download/${data.jobId}`;
      a.download = data.filename;
      a.click();
      showToast('Download started!', 'success');
    };

    showToast('Animation exported!', 'success');

  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    exportBtn.classList.remove('loading');
    exportBtn.disabled = false;
    editorReset();
  }
}

// ===== INIT ON LOAD =====
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEditor);
} else {
  initEditor();
}
