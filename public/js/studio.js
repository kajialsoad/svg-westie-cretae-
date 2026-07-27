/**
 * AnimSuite Pro — Studio modules (SVGA Edit, VAP, Multi Preview, converters)
 * UI + client preview wired; conversion backends land in a later phase.
 */

const studioState = {
  files: {
    'svga-edit': null,
    'vap-mp4': null,
    'vap-convert': null,
    'svga-vap': null
  },
  multiFiles: [],
  multiPlayers: [],
  multiZoom: 1,
  multiLoop: true,
  vapObjectUrl: null,
  convertObjectUrl: null,
  edit: {
    layers: [], // { id, file, name, size, url, videoItem, player, shell, visible }
    activeLayerId: null,
    selectedKey: null,
    paused: false,
    composing: false
  }
};

const STUDIO_ACCEPT = {
  'svga-edit': ['.svga'],
  'vap-mp4': ['.mp4', '.vap', 'video/mp4'],
  'multi-svga': ['.svga'],
  'vap-convert': ['.mp4', '.mov', '.vap', 'video/mp4', 'video/quicktime'],
  'svga-vap': ['.svga']
};

function studioNotify(msg, type) {
  if (typeof showToast === 'function') showToast(msg, type || 'info');
  else console.log('[studio]', msg);
}

function studioFileOk(file, module) {
  const name = (file.name || '').toLowerCase();
  const rules = STUDIO_ACCEPT[module] || [];
  return rules.some((r) => {
    if (r.startsWith('.')) return name.endsWith(r);
    return file.type === r;
  });
}

function studioFormatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function studioHandleDragOver(e) {
  handleDragOver(e);
}

function studioHandleDrop(e, module) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  if (module === 'multi-svga') {
    studioLoadMulti(files);
    return;
  }
  if (module === 'svga-edit') {
    studioEditLoadFiles(files);
    return;
  }
  const file = files[0];
  if (!studioFileOk(file, module)) {
    studioNotify('Unsupported file for this module', 'error');
    return;
  }
  studioLoadFile(module, file);
}

function studioHandleFileSelect(e, module) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  if (module === 'multi-svga') {
    studioLoadMulti(files);
    e.target.value = '';
    return;
  }
  if (module === 'svga-edit') {
    studioEditLoadFiles(files);
    e.target.value = '';
    return;
  }
  const file = files[0];
  if (!studioFileOk(file, module)) {
    studioNotify('Unsupported file for this module', 'error');
    return;
  }
  studioLoadFile(module, file);
  e.target.value = '';
}

async function studioLoadFile(module, file) {
  studioState.files[module] = file;

  if (module === 'vap-mp4') {
    document.getElementById('vap-mp4-upload-zone').style.display = 'none';
    document.getElementById('vap-mp4-workspace').style.display = 'grid';
    document.getElementById('vap-mp4-file-name').textContent = file.name;
    document.getElementById('vap-mp4-file-size').textContent = studioFormatSize(file.size);
    const video = document.getElementById('vap-mp4-video');
    if (studioState.vapObjectUrl) URL.revokeObjectURL(studioState.vapObjectUrl);
    studioState.vapObjectUrl = URL.createObjectURL(file);
    video.src = studioState.vapObjectUrl;
    video.play().catch(() => {});
    return;
  }

  if (module === 'vap-convert') {
    document.getElementById('vap-convert-upload-zone').style.display = 'none';
    document.getElementById('vap-convert-workspace').style.display = 'grid';
    document.getElementById('vap-convert-file-name').textContent = file.name;
    document.getElementById('vap-convert-file-size').textContent = studioFormatSize(file.size);
    const video = document.getElementById('vap-convert-video');
    if (studioState.convertObjectUrl) URL.revokeObjectURL(studioState.convertObjectUrl);
    studioState.convertObjectUrl = URL.createObjectURL(file);
    video.src = studioState.convertObjectUrl;
    return;
  }

  if (module === 'svga-vap') {
    document.getElementById('svga-vap-upload-zone').style.display = 'none';
    document.getElementById('svga-vap-workspace').style.display = 'grid';
    document.getElementById('svga-vap-file-name').textContent = file.name;
    document.getElementById('svga-vap-file-size').textContent = studioFormatSize(file.size);
    await studioPlaySvga(file, 'svga-vap-player');
  }
}

async function studioEnsureSvgaLib() {
  if (typeof SVGA !== 'undefined') return true;
  if (typeof window.ensureSVGALibraryLoaded === 'function') {
    await window.ensureSVGALibraryLoaded();
  }
  return typeof SVGA !== 'undefined';
}

function studioEstimateImageBytes(img) {
  try {
    if (img && img.src && img.src.startsWith('data:')) {
      const b64 = img.src.split(',')[1] || '';
      return Math.round((b64.length * 3) / 4);
    }
  } catch (_) {}
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  return w * h * 4;
}

function studioFormatKb(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kb';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function studioEditAddFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) studioEditLoadFiles(files);
}

async function studioEditLoadFiles(files) {
  const svgas = files.filter((f) => studioFileOk(f, 'svga-edit'));
  if (!svgas.length) {
    studioNotify('Please select .svga files', 'error');
    return;
  }

  const ok = await studioEnsureSvgaLib();
  if (!ok) {
    studioNotify('SVGA library not loaded', 'error');
    return;
  }

  document.getElementById('svga-edit-upload-zone').style.display = 'none';
  document.getElementById('svga-edit-workspace').style.display = 'grid';
  document.getElementById('svga-edit-reset-btn').style.display = 'inline-flex';

  for (const file of svgas) {
    await studioEditAddLayer(file);
  }

  studioEditRebuildPreview();
  studioEditRenderLayerList();
  studioEditUpdateMeta();
}

function studioEditAddLayer(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const parser = new SVGA.Parser();
    parser.load(url, (videoItem) => {
      const id = 'L' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const layer = {
        id,
        file,
        name: file.name,
        size: file.size,
        url,
        videoItem,
        player: null,
        wrapEl: null,
        visible: true,
        w: videoItem.videoSize.width || 300,
        h: videoItem.videoSize.height || 300,
        fps: videoItem.FPS || 20,
        baseFps: videoItem.FPS || 20,
        frames: videoItem.frames || 0,
        options: {
          speed: 100,
          scale: 100,
          x: 0,
          y: 0,
          rotation: 0,
          opacity: 100,
          tint: '#ffffff',
          tintOn: false
        }
      };
      studioState.edit.layers.push(layer);
      if (!studioState.edit.activeLayerId) studioState.edit.activeLayerId = id;
      resolve(layer);
    }, (err) => {
      console.error(err);
      URL.revokeObjectURL(url);
      studioNotify('Failed: ' + file.name, 'error');
      resolve(null);
    });
  });
}

function studioEditRebuildPreview() {
  const stageEl = document.getElementById('svga-edit-player');
  const layers = studioState.edit.layers;
  stageEl.innerHTML = '';
  stageEl.style.cssText =
    'position:relative;display:flex;align-items:center;justify-content:center;overflow:visible;background:transparent;border:0;min-height:480px;';

  if (!layers.length) {
    stageEl.innerHTML = '<div style="color:#888;padding:2rem;">Add SVGA layers</div>';
    return;
  }

  let outW = 0;
  let outH = 0;
  layers.forEach((l) => {
    outW = Math.max(outW, l.w);
    outH = Math.max(outH, l.h);
  });

  const maxSide = Math.min(560, Math.max(280, Math.min(window.innerWidth * 0.45, window.innerHeight * 0.65)));
  const fit = Math.min(maxSide / outW, maxSide / outH);
  studioState.edit.previewFit = fit;
  studioState.edit.outW = outW;
  studioState.edit.outH = outH;

  const shell = document.createElement('div');
  shell.className = 'svga-edit-compose-shell';
  shell.style.cssText =
    'position:relative;width:' + Math.round(outW * fit) + 'px;height:' + Math.round(outH * fit) + 'px;overflow:visible;border:0;background:transparent;';

  layers.forEach((layer) => {
    if (layer.player) {
      try {
        layer.player.stopAnimation();
        layer.player.clear();
      } catch (_) {}
      layer.player = null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'svga-edit-layer-wrap';
    wrap.dataset.layerId = layer.id;
    wrap.style.cssText =
      'position:absolute;left:50%;top:50%;width:' + layer.w + 'px;height:' + layer.h + 'px;' +
      'margin-left:' + Math.round(-layer.w / 2) + 'px;margin-top:' + Math.round(-layer.h / 2) + 'px;' +
      'transform-origin:center center;overflow:visible;border:0;pointer-events:auto;cursor:grab;';

    const canvas = document.createElement('canvas');
    canvas.width = layer.w;
    canvas.height = layer.h;
    canvas.style.cssText =
      'width:' + layer.w + 'px;height:' + layer.h + 'px;display:block;border:0;outline:0;background:transparent;pointer-events:none;';

    wrap.appendChild(canvas);
    shell.appendChild(wrap);
    layer.wrapEl = wrap;
    studioEditEnableLayerDrag(layer, wrap);

    // Apply speed to FPS before play
    const speedMul = (layer.options.speed || 100) / 100;
    layer.videoItem.FPS = Math.max(1, Math.round((layer.baseFps || 20) * speedMul));

    const player = new SVGA.Player(canvas);
    player.loops = 0;
    player.clearsAfterStop = false;
    if (player.setClipsToBounds) player.setClipsToBounds(false);
    player.setVideoItem(layer.videoItem);
    if (layer.visible) player.startAnimation();
    layer.player = player;

    studioEditApplyLayerTransform(layer);
  });

  stageEl.appendChild(shell);
  studioEditRefreshLayerZIndex();
  studioState.edit.paused = false;

  const totalSize = layers.reduce((s, l) => s + l.size, 0);
  document.getElementById('svga-edit-file-name').textContent =
    layers.length === 1 ? layers[0].name : layers.length + ' SVGA layers stacked';
  document.getElementById('svga-edit-file-size').textContent = studioFormatSize(totalSize);

  const active = layers.find((l) => l.id === studioState.edit.activeLayerId) || layers[layers.length - 1];
  if (active) {
    studioState.edit.activeLayerId = active.id;
    studioRenderEditImages(active.videoItem);
    studioEditLoadOptionsToUI(active);
  }
}

function studioEditApplyLayerTransform(layer) {
  if (!layer || !layer.wrapEl) return;
  const fit = studioState.edit.previewFit || 1;
  const o = layer.options || {};
  const scale = fit * ((o.scale || 100) / 100);
  const x = o.x || 0;
  const y = o.y || 0;
  const rot = o.rotation || 0;
  const opacity = Math.max(0, Math.min(1, (o.opacity != null ? o.opacity : 100) / 100));

  layer.wrapEl.style.display = layer.visible ? 'block' : 'none';
  layer.wrapEl.style.opacity = String(opacity);
  layer.wrapEl.style.transform =
    'translate(' + x + 'px, ' + y + 'px) rotate(' + rot + 'deg) scale(' + scale + ')';
  layer.wrapEl.classList.toggle('is-active-layer', layer.id === studioState.edit.activeLayerId);

  if (o.tintOn) {
    const hue = studioEditColorToHue(o.tint || '#ffffff');
    layer.wrapEl.style.filter = 'sepia(1) saturate(6) hue-rotate(' + hue + 'deg)';
  } else {
    layer.wrapEl.style.filter = 'none';
  }
}

function studioEditRefreshLayerZIndex() {
  studioState.edit.layers.forEach((layer, index) => {
    if (!layer.wrapEl) return;
    const boost = layer.id === studioState.edit.activeLayerId ? 1000 : 0;
    layer.wrapEl.style.zIndex = String(index + 1 + boost);
  });
}

function studioEditEnableLayerDrag(layer, wrap) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    if (!layer.visible) return;

    // Select this layer for editing
    studioState.edit.activeLayerId = layer.id;
    studioEditRefreshLayerZIndex();
    studioEditRenderLayerList();
    studioRenderEditImages(layer.videoItem);
    studioEditLoadOptionsToUI(layer);

    dragging = true;
    wrap.classList.add('is-dragging');
    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    originX = layer.options.x || 0;
    originY = layer.options.y || 0;
    e.preventDefault();
    e.stopPropagation();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const point = e.touches ? e.touches[0] : e;
    layer.options.x = Math.round(originX + (point.clientX - startX));
    layer.options.y = Math.round(originY + (point.clientY - startY));
    studioEditApplyLayerTransform(layer);

    const xEl = document.getElementById('svga-edit-pos-x');
    const yEl = document.getElementById('svga-edit-pos-y');
    if (studioState.edit.activeLayerId === layer.id) {
      if (xEl) xEl.value = layer.options.x;
      if (yEl) yEl.value = layer.options.y;
    }
    e.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('is-dragging');
  };

  wrap.addEventListener('mousedown', onDown);
  wrap.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

function studioEditColorToHue(hex) {
  const h = (hex || '#ffffff').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) hue = ((b - r) / d + 2) * 60;
    else hue = ((r - g) / d + 4) * 60;
  }
  return Math.round(hue);
}

function studioEditGetActiveLayer() {
  return studioState.edit.layers.find((l) => l.id === studioState.edit.activeLayerId) || null;
}

function studioEditLoadOptionsToUI(layer) {
  if (!layer) return;
  const o = layer.options;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  set('svga-edit-speed', o.speed);
  set('svga-edit-scale', o.scale);
  set('svga-edit-pos-x', o.x);
  set('svga-edit-pos-y', o.y);
  set('svga-edit-rotation', o.rotation);
  set('svga-edit-opacity', o.opacity);
  set('svga-edit-tint', o.tint);
  const tintOn = document.getElementById('svga-edit-tint-on');
  if (tintOn) tintOn.checked = !!o.tintOn;

  const sv = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  sv('svga-edit-speed-val', o.speed + '%');
  sv('svga-edit-scale-val', o.scale + '%');
  sv('svga-edit-rotation-val', o.rotation + '°');
  sv('svga-edit-opacity-val', o.opacity + '%');
}

function studioEditReadOptionsFromUI() {
  return {
    speed: parseInt(document.getElementById('svga-edit-speed')?.value, 10) || 100,
    scale: parseInt(document.getElementById('svga-edit-scale')?.value, 10) || 100,
    x: parseInt(document.getElementById('svga-edit-pos-x')?.value, 10) || 0,
    y: parseInt(document.getElementById('svga-edit-pos-y')?.value, 10) || 0,
    rotation: parseInt(document.getElementById('svga-edit-rotation')?.value, 10) || 0,
    opacity: parseInt(document.getElementById('svga-edit-opacity')?.value, 10) || 100,
    tint: document.getElementById('svga-edit-tint')?.value || '#ffffff',
    tintOn: !!document.getElementById('svga-edit-tint-on')?.checked
  };
}

function studioEditOnOptionChange() {
  const layer = studioEditGetActiveLayer();
  if (!layer) return;
  const o = studioEditReadOptionsFromUI();
  layer.options = o;

  document.getElementById('svga-edit-speed-val').textContent = o.speed + '%';
  document.getElementById('svga-edit-scale-val').textContent = o.scale + '%';
  document.getElementById('svga-edit-rotation-val').textContent = o.rotation + '°';
  document.getElementById('svga-edit-opacity-val').textContent = o.opacity + '%';

  studioEditApplyLayerTransform(layer);

  // Speed change needs player FPS update
  const newFps = Math.max(1, Math.round((layer.baseFps || 20) * (o.speed / 100)));
  if (layer.videoItem && layer.videoItem.FPS !== newFps && layer.player) {
    layer.videoItem.FPS = newFps;
    try {
      const wasPaused = studioState.edit.paused;
      layer.player.setVideoItem(layer.videoItem);
      if (!wasPaused && layer.visible) layer.player.startAnimation();
      else if (wasPaused) layer.player.pauseAnimation();
    } catch (_) {}
  }
}

function studioEditResetOptions() {
  const layer = studioEditGetActiveLayer();
  if (!layer) return;
  layer.options = {
    speed: 100,
    scale: 100,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 100,
    tint: '#ffffff',
    tintOn: false
  };
  studioEditLoadOptionsToUI(layer);
  studioEditOnOptionChange();
}

function studioEditUpdateMeta() {
  const layers = studioState.edit.layers;
  if (!layers.length) {
    ['size', 'frames', 'fps', 'duration', 'version'].forEach((k) => {
      const el = document.getElementById('svga-edit-meta-' + k);
      if (el) el.textContent = '—';
    });
    return;
  }
  let outW = 0;
  let outH = 0;
  let fps = 0;
  let frames = 0;
  layers.forEach((l) => {
    outW = Math.max(outW, l.w);
    outH = Math.max(outH, l.h);
    fps = Math.max(fps, l.fps);
    frames = Math.max(frames, l.frames);
  });
  const duration = fps > 0 ? frames / fps : 0;
  document.getElementById('svga-edit-meta-size').textContent = outW + ' × ' + outH;
  document.getElementById('svga-edit-meta-frames').textContent = String(frames);
  document.getElementById('svga-edit-meta-fps').textContent = String(fps);
  document.getElementById('svga-edit-meta-duration').textContent = duration.toFixed(1) + 's';
  document.getElementById('svga-edit-meta-version').textContent = String(layers.length);
  document.getElementById('svga-edit-layer-count').textContent = String(layers.length);
}

function studioEditRenderLayerList() {
  const list = document.getElementById('svga-edit-layer-list');
  const layers = studioState.edit.layers;
  list.innerHTML = '';
  document.getElementById('svga-edit-layer-count').textContent = String(layers.length);

  if (!layers.length) {
    list.innerHTML = '<div class="svga-edit-empty">No layers yet</div>';
    return;
  }

  // Show top layer first in UI (visual stack), but keep array order bottom→top
  layers.forEach((layer, index) => {
    const row = document.createElement('div');
    row.className = 'svga-edit-layer-row' + (layer.id === studioState.edit.activeLayerId ? ' selected' : '');
    row.innerHTML =
      '<div class="svga-edit-layer-main">' +
      '<span class="svga-edit-layer-order">' + (index + 1) + '</span>' +
      '<div class="svga-edit-layer-info">' +
      '<div class="svga-edit-image-key">' + layer.name + '</div>' +
      '<div class="svga-edit-image-meta">' + layer.w + '×' + layer.h + ' · ' + layer.frames + 'f · ' +
      studioFormatSize(layer.size) + (index === layers.length - 1 ? ' · top' : index === 0 ? ' · bottom' : '') +
      '</div></div></div>' +
      '<div class="svga-edit-layer-actions">' +
      '<button type="button" class="studio-chip-btn" data-act="vis" title="Show/Hide">' + (layer.visible ? '👁' : '🚫') + '</button>' +
      '<button type="button" class="studio-chip-btn" data-act="up" title="Move up">↑</button>' +
      '<button type="button" class="studio-chip-btn" data-act="down" title="Move down">↓</button>' +
      '<button type="button" class="studio-chip-btn" data-act="del" title="Remove">×</button>' +
      '</div>';

    row.querySelector('.svga-edit-layer-main').addEventListener('click', () => {
      studioState.edit.activeLayerId = layer.id;
      studioEditRefreshLayerZIndex();
      studioState.edit.layers.forEach((l) => studioEditApplyLayerTransform(l));
      studioEditRenderLayerList();
      studioRenderEditImages(layer.videoItem);
      studioEditLoadOptionsToUI(layer);
    });

    row.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.getAttribute('data-act');
        if (act === 'vis') {
          layer.visible = !layer.visible;
          studioEditRebuildPreview();
          studioEditRenderLayerList();
        } else if (act === 'up') {
          if (index < layers.length - 1) {
            const t = layers[index + 1];
            layers[index + 1] = layers[index];
            layers[index] = t;
            studioEditRebuildPreview();
            studioEditRenderLayerList();
          }
        } else if (act === 'down') {
          if (index > 0) {
            const t = layers[index - 1];
            layers[index - 1] = layers[index];
            layers[index] = t;
            studioEditRebuildPreview();
            studioEditRenderLayerList();
          }
        } else if (act === 'del') {
          studioEditRemoveLayer(layer.id);
        }
      });
    });

    list.appendChild(row);
  });
}

function studioEditRemoveLayer(id) {
  const idx = studioState.edit.layers.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const [layer] = studioState.edit.layers.splice(idx, 1);
  try {
    if (layer.player) {
      layer.player.stopAnimation();
      layer.player.clear();
    }
  } catch (_) {}
  if (layer.url) URL.revokeObjectURL(layer.url);
  if (studioState.edit.activeLayerId === id) {
    studioState.edit.activeLayerId = studioState.edit.layers.length
      ? studioState.edit.layers[studioState.edit.layers.length - 1].id
      : null;
  }
  if (!studioState.edit.layers.length) {
    studioResetEdit();
    return;
  }
  studioEditRebuildPreview();
  studioEditRenderLayerList();
  studioEditUpdateMeta();
}

function studioRenderEditImages(videoItem) {
  const list = document.getElementById('svga-edit-image-list');
  if (!list || !videoItem) return;
  const images = videoItem.images || {};
  const keys = Object.keys(images);
  document.getElementById('svga-edit-image-count').textContent = String(keys.length);
  list.innerHTML = '';
  studioState.edit.selectedKey = null;
  document.getElementById('svga-edit-replace-btn').disabled = true;

  if (!keys.length) {
    list.innerHTML = '<div class="svga-edit-empty">No images in this layer</div>';
    return;
  }

  keys.forEach((key) => {
    const img = images[key];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'svga-edit-image-row';
    row.dataset.key = key;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'svga-edit-thumb';
    if (img && (img.src || img instanceof HTMLImageElement || img instanceof HTMLCanvasElement)) {
      const clone = document.createElement('img');
      clone.alt = key;
      if (img.src) clone.src = img.src;
      else if (img instanceof HTMLCanvasElement) clone.src = img.toDataURL('image/png');
      thumbWrap.appendChild(clone);
    }

    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    const bytes = studioEstimateImageBytes(img);

    const info = document.createElement('div');
    info.className = 'svga-edit-image-info';
    info.innerHTML =
      '<div class="svga-edit-image-key">' + key + '</div>' +
      '<div class="svga-edit-image-meta">' + iw + ' × ' + ih + ' · ' + studioFormatKb(bytes) + '</div>';

    row.appendChild(thumbWrap);
    row.appendChild(info);
    row.addEventListener('click', () => studioEditSelectImage(key));
    list.appendChild(row);
  });
}

function studioEditSelectImage(key) {
  studioState.edit.selectedKey = key;
  document.querySelectorAll('.svga-edit-image-row').forEach((el) => {
    el.classList.toggle('selected', el.dataset.key === key);
  });
  document.getElementById('svga-edit-replace-btn').disabled = false;
}

function studioEditPickReplace() {
  if (!studioState.edit.selectedKey || !studioState.edit.activeLayerId) {
    studioNotify('Select a layer image first', 'error');
    return;
  }
  document.getElementById('svga-edit-replace-input').click();
}

function studioEditReplaceSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  const layer = studioState.edit.layers.find((l) => l.id === studioState.edit.activeLayerId);
  if (!file || !studioState.edit.selectedKey || !layer) return;

  const key = studioState.edit.selectedKey;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      layer.videoItem.images[key] = img;
      try {
        if (layer.player && typeof layer.player.setImage === 'function') {
          layer.player.setImage(img, key);
        } else if (layer.player) {
          layer.player.setVideoItem(layer.videoItem);
          layer.player.startAnimation();
        }
      } catch (err) {
        console.error(err);
      }
      studioRenderEditImages(layer.videoItem);
      studioEditSelectImage(key);
      studioNotify('Replaced image: ' + key, 'success');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function studioEditPlayPause() {
  const layers = studioState.edit.layers;
  if (!layers.length) return;
  studioState.edit.paused = !studioState.edit.paused;
  layers.forEach((layer) => {
    if (!layer.player || !layer.visible) return;
    try {
      if (studioState.edit.paused) layer.player.pauseAnimation();
      else layer.player.startAnimation();
    } catch (_) {}
  });
}

function studioEditRestart() {
  studioState.edit.paused = false;
  studioState.edit.layers.forEach((layer) => {
    if (!layer.player || !layer.visible) return;
    try {
      layer.player.startAnimation();
    } catch (_) {}
  });
}

async function studioEditExportCompose() {
  const layers = studioState.edit.layers.filter((l) => l.visible);
  if (!layers.length) {
    studioNotify('Add at least one visible SVGA layer', 'error');
    return;
  }

  const btn = document.getElementById('svga-edit-export-btn');
  if (studioState.edit.composing) return;
  studioState.edit.composing = true;
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const formData = new FormData();
    // Upload in bottom → top order
    const transforms = [];
    layers.forEach((layer) => {
      formData.append('files', layer.file, layer.name);
      transforms.push({
        scale: (layer.options.scale || 100) / 100,
        x: layer.options.x || 0,
        y: layer.options.y || 0,
        rotation: layer.options.rotation || 0,
        opacity: (layer.options.opacity != null ? layer.options.opacity : 100) / 100,
        speed: (layer.options.speed || 100) / 100,
        tintOn: !!layer.options.tintOn,
        tint: layer.options.tint || '#ffffff'
      });
    });
    formData.append('transforms', JSON.stringify(transforms));

    const res = await fetch('/api/convert/compose-svga', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Compose failed');

    const a = document.createElement('a');
    a.href = data.downloadUrl;
    a.download = data.filename || 'composed.svga';
    document.body.appendChild(a);
    a.click();
    a.remove();

    studioNotify('Composed SVGA ready (' + layers.length + ' layers)', 'success');
  } catch (err) {
    console.error(err);
    studioNotify(err.message || 'Export failed', 'error');
  } finally {
    studioState.edit.composing = false;
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function studioResetEdit() {
  studioState.edit.layers.forEach((layer) => {
    try {
      if (layer.player) {
        layer.player.stopAnimation();
        layer.player.clear();
      }
    } catch (_) {}
    if (layer.url) URL.revokeObjectURL(layer.url);
  });
  studioState.edit = {
    layers: [],
    activeLayerId: null,
    selectedKey: null,
    paused: false,
    composing: false
  };
  studioState.files['svga-edit'] = null;

  document.getElementById('svga-edit-workspace').style.display = 'none';
  document.getElementById('svga-edit-upload-zone').style.display = '';
  document.getElementById('svga-edit-reset-btn').style.display = 'none';
  document.getElementById('svga-edit-player').innerHTML = '';
  document.getElementById('svga-edit-image-list').innerHTML = '';
  document.getElementById('svga-edit-layer-list').innerHTML = '';
  document.getElementById('svga-edit-image-count').textContent = '0';
  document.getElementById('svga-edit-layer-count').textContent = '0';
  ['size', 'frames', 'fps', 'duration', 'version'].forEach((k) => {
    const el = document.getElementById('svga-edit-meta-' + k);
    if (el) el.textContent = '—';
  });
}

async function studioPlaySvga(file, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '<div style="color:#888;padding:2rem;text-align:center;">Loading…</div>';

  const ok = await studioEnsureSvgaLib();
  if (!ok) {
    el.innerHTML = '<div style="color:#888;padding:2rem;text-align:center;">SVGA library not loaded</div>';
    return;
  }

  const url = URL.createObjectURL(file);
  const parser = new SVGA.Parser();

  parser.load(url, (videoItem) => {
    const w = videoItem.videoSize.width || 300;
    const h = videoItem.videoSize.height || 300;
    const baseFit = studioCalcBaseFit(w, h);

    el.innerHTML = '';
    el.style.cssText = 'overflow:visible;background:transparent;border:0;display:flex;justify-content:center;';

    const shell = document.createElement('div');
    shell.style.cssText =
      'width:' + Math.round(w * baseFit) + 'px;height:' + Math.round(h * baseFit) + 'px;overflow:visible;border:0;background:transparent;';

    const stage = document.createElement('div');
    stage.style.cssText =
      'width:' + w + 'px;height:' + h + 'px;transform:scale(' + baseFit + ');transform-origin:top left;overflow:visible;border:0;';

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText =
      'width:' + w + 'px;height:' + h + 'px;display:block;border:0;outline:0;background:transparent;';

    stage.appendChild(canvas);
    shell.appendChild(stage);
    el.appendChild(shell);

    const player = new SVGA.Player(canvas);
    player.loops = 0;
    player.clearsAfterStop = false;
    if (player.setClipsToBounds) player.setClipsToBounds(false);
    player.setVideoItem(videoItem);
    player.startAnimation();

    URL.revokeObjectURL(url);
  }, (err) => {
    el.innerHTML = '<div style="color:#ef4444;padding:2rem;text-align:center;">Failed to load SVGA</div>';
    console.error(err);
    URL.revokeObjectURL(url);
  });
}

function studioWatchCanvasSize(canvas, applyFn) {
  let locking = false;
  const obs = new MutationObserver(() => {
    if (locking) return;
    locking = true;
    applyFn();
    locking = false;
  });
  obs.observe(canvas, { attributes: true, attributeFilter: ['style', 'width', 'height'] });
  return obs;
}

function studioVapPlayPause() {
  const video = document.getElementById('vap-mp4-video');
  if (!video || !video.src) return;
  if (video.paused) video.play();
  else video.pause();
}

function studioVapToggleBg() {
  const stage = document.getElementById('vap-mp4-stage');
  const on = document.getElementById('vap-mp4-checker')?.checked;
  stage?.classList.toggle('solid-bg', !on);
}

function studioSelectFormat(input) {
  const parent = input.closest('.format-options');
  if (!parent) return;
  parent.querySelectorAll('.format-option').forEach((el) => el.classList.remove('selected'));
  input.closest('.format-option')?.classList.add('selected');
}

function studioAction(module) {
  const labels = {
    'svga-edit': 'SVGA Editing export',
    'vap-mp4': 'VAP MP4 export',
    'vap-convert': 'VAP → SVGA/WebP conversion',
    'svga-vap': 'SVGA → VAP MP4 encoding'
  };
  if (!studioState.files[module]) {
    studioNotify('Upload a file first', 'error');
    return;
  }
  studioNotify(labels[module] + ' — pipeline coming next (UI ready)', 'info');
}

/* ===== Multi SVGA Preview ===== */

async function studioLoadMulti(files) {
  const svgas = files.filter((f) => studioFileOk(f, 'multi-svga'));
  if (!svgas.length) {
    studioNotify('Please select .svga files', 'error');
    return;
  }

  studioState.multiFiles = studioState.multiFiles.concat(svgas);
  document.getElementById('multi-svga-upload-zone').style.display = 'none';
  document.getElementById('multi-svga-toolbar').style.display = 'flex';
  document.getElementById('multi-svga-grid').style.display = 'flex';
  document.getElementById('multi-svga-clear-btn').style.display = 'inline-flex';
  document.getElementById('multi-svga-count').textContent = studioState.multiFiles.length + ' files';

  const ok = await studioEnsureSvgaLib();
  if (!ok) {
    studioNotify('SVGA library not loaded', 'error');
    return;
  }

  for (const file of svgas) {
    await studioAddMultiCard(file);
  }
}

function studioApplyStageTransform(entry) {
  if (!entry || !entry.stage || !entry.shell) return;
  const z = studioState.multiZoom;
  const fit = entry.baseFit * z;
  const dw = Math.round(entry.w * fit);
  const dh = Math.round(entry.h * fit);
  entry.shell.style.width = dw + 'px';
  entry.shell.style.height = dh + 'px';
  // Native canvas size + CSS scale = no left/right crop from size mismatch
  entry.stage.style.transform = 'scale(' + fit + ')';
  entry.stage.style.transformOrigin = 'top left';
}

function studioCalcBaseFit(videoW, videoH) {
  const maxW = Math.min(window.innerWidth - 96, 900);
  const maxH = Math.min(window.innerHeight * 0.75, 780);
  return Math.min(maxW / videoW, maxH / videoH);
}

function studioAddMultiCard(file) {
  return new Promise((resolve) => {
    const grid = document.getElementById('multi-svga-grid');
    const card = document.createElement('div');
    card.className = 'multi-svga-card';

    const shell = document.createElement('div');
    shell.className = 'multi-shell';

    const stage = document.createElement('div');
    stage.className = 'multi-stage';
    shell.appendChild(stage);

    const meta = document.createElement('div');
    meta.className = 'multi-meta';
    meta.innerHTML =
      '<div class="multi-name" title="' + file.name.replace(/"/g, '') + '">' + file.name + '</div>' +
      '<div class="multi-info">' + studioFormatSize(file.size) + ' · loading…</div>';

    card.appendChild(shell);
    card.appendChild(meta);
    grid.appendChild(card);

    const url = URL.createObjectURL(file);
    const parser = new SVGA.Parser();

    parser.load(url, (videoItem) => {
      const w = videoItem.videoSize.width || 200;
      const h = videoItem.videoSize.height || 200;
      const fps = videoItem.FPS || 20;
      const frames = videoItem.frames || 0;
      const baseFit = studioCalcBaseFit(w, h);

      // Canvas stays 1:1 with SVGA pixels — never CSS-shrink the drawing surface
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.style.cssText =
        'width:' + w + 'px;height:' + h + 'px;display:block;border:0;outline:0;background:transparent;';

      stage.style.width = w + 'px';
      stage.style.height = h + 'px';
      stage.innerHTML = '';
      stage.appendChild(canvas);

      const ctx = canvas.getContext('2d', {
        alpha: true,
        premultipliedAlpha: false
      });
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      }

      const player = new SVGA.Player(canvas);
      player.loops = studioState.multiLoop ? 0 : 1;
      player.clearsAfterStop = false;
      player.fillMode = 'Forward';
      if (player.setClipsToBounds) player.setClipsToBounds(false);
      player.setVideoItem(videoItem);
      player.startAnimation();

      // Keep native CSS size if player tries to change it
      const relock = () => {
        canvas.style.setProperty('width', w + 'px', 'important');
        canvas.style.setProperty('height', h + 'px', 'important');
        canvas.style.setProperty('border', '0', 'important');
        canvas.style.setProperty('outline', '0', 'important');
        canvas.style.setProperty('background', 'transparent', 'important');
      };
      relock();
      const observer = studioWatchCanvasSize(canvas, relock);

      const entry = { player, canvas, shell, stage, w, h, baseFit, observer, relock };
      studioApplyStageTransform(entry);
      studioState.multiPlayers.push(entry);

      meta.querySelector('.multi-info').textContent =
        studioFormatSize(file.size) + ' · ' + w + '×' + h + ' · ' + fps + 'fps · ' + frames + 'f';

      URL.revokeObjectURL(url);
      resolve();
    }, (err) => {
      console.error(err);
      meta.querySelector('.multi-info').textContent = studioFormatSize(file.size) + ' · failed';
      URL.revokeObjectURL(url);
      resolve();
    });
  });
}

function studioMultiSetLoop() {
  studioState.multiLoop = !!document.getElementById('multi-svga-loop')?.checked;
  studioState.multiPlayers.forEach((entry) => {
    const p = entry.player || entry;
    try {
      p.loops = studioState.multiLoop ? 0 : 1;
      if (studioState.multiLoop) p.startAnimation();
    } catch (_) {}
  });
}

function studioMultiZoom(dir) {
  studioState.multiZoom = Math.max(0.4, Math.min(3, +(studioState.multiZoom + dir * 0.15).toFixed(2)));
  document.getElementById('multi-svga-zoom-label').textContent =
    Math.round(studioState.multiZoom * 100) + '%';
  studioState.multiPlayers.forEach((entry) => studioApplyStageTransform(entry));
}

function studioMultiRefitAll() {
  studioState.multiPlayers.forEach((entry) => {
    if (!entry || !entry.w) return;
    entry.baseFit = studioCalcBaseFit(entry.w, entry.h);
    studioApplyStageTransform(entry);
  });
}

window.addEventListener('resize', () => {
  if (studioState.multiPlayers.length) studioMultiRefitAll();
});

function studioClearMulti() {
  studioState.multiPlayers.forEach((entry) => {
    try {
      if (entry.observer) entry.observer.disconnect();
    } catch (_) {}
    const p = entry.player || entry;
    try {
      p.stopAnimation();
      p.clear();
    } catch (_) {}
  });
  studioState.multiPlayers = [];
  studioState.multiFiles = [];
  studioState.multiZoom = 1;

  const grid = document.getElementById('multi-svga-grid');
  if (grid) {
    grid.innerHTML = '';
    grid.style.display = 'none';
  }
  document.getElementById('multi-svga-toolbar').style.display = 'none';
  document.getElementById('multi-svga-clear-btn').style.display = 'none';
  document.getElementById('multi-svga-upload-zone').style.display = '';
  document.getElementById('multi-svga-count').textContent = '0 files';
  document.getElementById('multi-svga-zoom-label').textContent = '100%';
}
