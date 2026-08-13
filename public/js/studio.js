/**
 * AnimSuite Pro — Studio modules (SVGA Edit, VAP, Multi Preview, converters)
 * UI + conversion backends for SVGA Edit, VAP, Multi Preview.
 */

const studioState = {
  files: {
    'svga-edit': null,
    'vap-mp4': null,
    'mp4-vap': null,
    'vap-convert': null,
    'svga-vap': null
  },
  multiFiles: [],
  multiPlayers: [],
  multiZoom: 1,
  multiLoop: true,
  vapObjectUrl: null,
  convertObjectUrl: null,
  mp4VapObjectUrl: null,
  vapRaf: 0,
  vapMeta: null,
  downloads: [],
  multiView: 'grid',
  edit: {
    library: [],
    layers: [],
    activeLayerId: null,
    paused: false,
    composing: false,
    canvasMax: 8,
    inspect: null,
    replaceKey: null
  }
};

const STUDIO_ACCEPT = {
  'svga-edit': ['.svga', '.png', '.jpg', '.jpeg', '.webp', '.gif', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  'vap-mp4': ['.mp4', '.vap', 'video/mp4'],
  'mp4-vap': ['.mp4', '.mov', 'video/mp4', 'video/quicktime'],
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
  if (module === 'vap-convert' && files.length > 1) {
    studioBatchVapConvert(files);
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
  if (module === 'vap-convert' && files.length > 1) {
    studioBatchVapConvert(files);
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
    studioBindVapPreview(video, 'vap-mp4-canvas', 'vap-mp4');
    studioProbeVap(file, 'vap-mp4');
    return;
  }

  if (module === 'mp4-vap') {
    document.getElementById('mp4-vap-upload-zone').style.display = 'none';
    document.getElementById('mp4-vap-workspace').style.display = 'grid';
    document.getElementById('mp4-vap-file-name').textContent = file.name;
    document.getElementById('mp4-vap-file-size').textContent = studioFormatSize(file.size);
    const video = document.getElementById('mp4-vap-video');
    if (studioState.mp4VapObjectUrl) URL.revokeObjectURL(studioState.mp4VapObjectUrl);
    studioState.mp4VapObjectUrl = URL.createObjectURL(file);
    video.src = studioState.mp4VapObjectUrl;
    studioProbeVap(file, 'mp4-vap');
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
    studioBindVapPreview(video, 'vap-convert-canvas', 'vap-convert');
    studioProbeVap(file, 'vap-convert');
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

function studioEditIsSvga(file) {
  return (file.name || '').toLowerCase().endsWith('.svga');
}

function studioEditIsImage(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(name)) return true;
  return (file.type || '').startsWith('image/');
}

function studioEditAddFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) studioEditLoadFiles(files);
}

async function studioEditLoadFiles(files) {
  const accepted = files.filter((f) => studioEditIsSvga(f) || studioEditIsImage(f));
  if (!accepted.length) {
    studioNotify('Upload .svga or image files (png, jpg, webp, gif)', 'error');
    return;
  }

  if (accepted.some((f) => studioEditIsSvga(f))) {
    const ok = await studioEnsureSvgaLib();
    if (!ok) {
      studioNotify('SVGA library not loaded', 'error');
      return;
    }
  }

  for (const file of accepted) {
    await studioEditAddToLibrary(file);
  }

  studioEditRenderLibrary();
  studioEditUpdateMeta();
}

function studioEditNewId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function studioEditDefaultOptions() {
  return {
    speed: 100,
    scale: 100,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 100,
    tint: '#ffffff',
    tintOn: false,
    startFrame: 0,
    endFrame: 0
  };
}

function studioEditAddToLibrary(file) {
  if (studioEditIsImage(file) && !studioEditIsSvga(file)) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        studioState.edit.library.push({
          id: studioEditNewId('A'),
          kind: 'image',
          file,
          name: file.name,
          size: file.size,
          url,
          w: img.naturalWidth || 300,
          h: img.naturalHeight || 300,
          fps: 20,
          frames: 1,
          version: 'image',
          videoItem: null,
          thumbPlayer: null
        });
        resolve(true);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        studioNotify('Failed image: ' + file.name, 'error');
        resolve(null);
      };
      img.src = url;
    });
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const parser = new SVGA.Parser();
    parser.load(url, (videoItem) => {
      studioState.edit.library.push({
        id: studioEditNewId('A'),
        kind: 'svga',
        file,
        name: file.name,
        size: file.size,
        url,
        videoItem,
        w: videoItem.videoSize.width || 300,
        h: videoItem.videoSize.height || 300,
        fps: videoItem.FPS || 20,
        frames: Array.isArray(videoItem.frames)
          ? videoItem.frames.length
          : (Number(videoItem.frames) || 0),
        version: videoItem.version || '2.0.0',
        thumbPlayer: null
      });
      resolve(true);
    }, (err) => {
      console.error(err);
      URL.revokeObjectURL(url);
      studioNotify('Failed: ' + file.name, 'error');
      resolve(null);
    });
  });
}

function studioEditStopLibraryPlayers() {
  studioState.edit.library.forEach((asset) => {
    if (!asset.thumbPlayer) return;
    try {
      asset.thumbPlayer.stopAnimation();
      asset.thumbPlayer.clear();
    } catch (_) {}
    asset.thumbPlayer = null;
  });
}

function studioEditRenderLibrary() {
  const list = document.getElementById('svga-edit-image-list');
  if (!list) return;
  studioEditStopLibraryPlayers();
  const assets = studioState.edit.library;
  document.getElementById('svga-edit-image-count').textContent = String(assets.length);
  list.innerHTML = '';

  if (!assets.length) {
    list.innerHTML = '<div class="svga-edit-empty">Upload images or SVGA, then drag onto Large Preview</div>';
    return;
  }

  assets.forEach((asset) => {
    const card = document.createElement('div');
    card.className = 'svga-asset-card selectable';
    card.draggable = true;
    card.dataset.assetId = asset.id;

    const thumb = document.createElement('div');
    thumb.className = 'svga-asset-thumb';
    thumb.dataset.assetId = asset.id;

    const name = document.createElement('div');
    name.className = 'svga-asset-name';
    name.textContent = asset.name;

    const meta = document.createElement('div');
    meta.className = 'svga-asset-meta';
    meta.textContent = asset.kind === 'svga'
      ? asset.w + ' × ' + asset.h + '  SVGA'
      : asset.w + ' × ' + asset.h + '  image';

    card.appendChild(thumb);
    card.appendChild(name);
    card.appendChild(meta);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'studio-chip-btn svga-asset-add';
    addBtn.textContent = 'Add to preview';
    addBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      studioEditPlaceOnCanvas(asset.id, 0, 0);
    });
    card.appendChild(addBtn);
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', asset.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dblclick', () => studioEditPlaceOnCanvas(asset.id, 0, 0));
    list.appendChild(card);

    if (asset.kind === 'image') {
      const img = document.createElement('img');
      img.alt = asset.name;
      img.src = asset.url;
      img.draggable = false;
      thumb.appendChild(img);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = asset.w;
      canvas.height = asset.h;
      canvas.draggable = false;
      thumb.appendChild(canvas);
      try {
        const player = new SVGA.Player(canvas);
        player.loops = 0;
        player.clearsAfterStop = false;
        player.setVideoItem(asset.videoItem);
        player.startAnimation();
        asset.thumbPlayer = player;
      } catch (err) {
        console.error(err);
      }
    }
  });
}

function studioEditCanvasDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  e.currentTarget.classList.add('is-drop-target');
}

function studioEditCanvasDragLeave(e) {
  e.currentTarget.classList.remove('is-drop-target');
}

function studioEditCanvasDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('is-drop-target');
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) {
    const before = studioState.edit.library.length;
    studioEditLoadFiles(files).then(() => {
      const added = studioState.edit.library.slice(before);
      added.forEach((asset) => studioEditPlaceOnCanvas(asset.id, e.clientX, e.clientY));
    });
    return;
  }
  const assetId = e.dataTransfer.getData('text/plain');
  if (assetId) studioEditPlaceOnCanvas(assetId, e.clientX, e.clientY);
}

function studioEditPlaceOnCanvas(assetId, clientX, clientY) {
  const asset = studioState.edit.library.find((a) => a.id === assetId);
  if (!asset) return;
  if (studioState.edit.layers.length >= studioState.edit.canvasMax) {
    studioNotify('Large Preview holds 8 items max', 'error');
    return;
  }

  const stage = document.getElementById('svga-edit-player');
  const rect = stage.getBoundingClientRect();
  let x = 0;
  let y = 0;
  if (clientX && clientY) {
    x = Math.round(clientX - (rect.left + rect.width / 2));
    y = Math.round(clientY - (rect.top + rect.height / 2));
  } else {
    const n = studioState.edit.layers.length;
    x = (n % 4) * 24 - 36;
    y = Math.floor(n / 4) * 24 - 12;
  }

  const layer = {
    id: studioEditNewId('L'),
    kind: asset.kind,
    file: asset.file,
    name: asset.name,
    size: asset.size,
    url: asset.url,
    videoItem: asset.videoItem ? Object.assign({}, asset.videoItem) : null,
    player: null,
    wrapEl: null,
    visible: true,
    w: asset.w,
    h: asset.h,
    fps: asset.fps,
    baseFps: asset.fps,
    frames: asset.frames,
    version: asset.version,
    options: Object.assign(studioEditDefaultOptions(), { x, y })
  };
  studioState.edit.layers.push(layer);
  studioState.edit.activeLayerId = layer.id;
  studioEditRebuildPreview();
  studioEditRenderLayerList();
  studioEditUpdateMeta();
}

function studioEditRebuildPreview() {
  const stageEl = document.getElementById('svga-edit-player');
  const layers = studioState.edit.layers;
  stageEl.innerHTML = '';
  stageEl.style.position = 'relative';
  stageEl.style.display = 'flex';
  stageEl.style.alignItems = 'center';
  stageEl.style.justifyContent = 'center';
  stageEl.style.overflow = 'hidden';

  if (!layers.length) {
    stageEl.innerHTML = '<div class="svga-edit-stage-hint" id="svga-edit-stage-hint">Drag images or SVGA here to build a layout (max 8)</div>';
    document.getElementById('svga-edit-file-name').textContent = 'Empty canvas';
    document.getElementById('svga-edit-file-size').textContent = '0 / 8 on preview';
    return;
  }

  let outW = 0;
  let outH = 0;
  layers.forEach((l) => {
    outW = Math.max(outW, l.w);
    outH = Math.max(outH, l.h);
  });

  const maxSide = Math.min(720, Math.max(320, Math.min(window.innerWidth * 0.55, window.innerHeight * 0.7)));
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

    if (layer.kind === 'image') {
      const img = document.createElement('img');
      img.src = layer.url;
      img.alt = layer.name;
      img.draggable = false;
      img.style.cssText =
        'width:' + layer.w + 'px;height:' + layer.h + 'px;display:block;border:0;outline:0;pointer-events:none;';
      wrap.appendChild(img);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = layer.w;
      canvas.height = layer.h;
      canvas.style.cssText =
        'width:' + layer.w + 'px;height:' + layer.h + 'px;display:block;border:0;outline:0;background:transparent;pointer-events:none;';
      wrap.appendChild(canvas);

      const speedMul = (layer.options.speed || 100) / 100;
      if (layer.videoItem) {
        layer.videoItem.FPS = Math.max(1, Math.round((layer.baseFps || 20) * speedMul));
        const player = new SVGA.Player(canvas);
        player.loops = 0;
        player.clearsAfterStop = false;
        if (player.setClipsToBounds) player.setClipsToBounds(false);
        player.setVideoItem(layer.videoItem);
        if (layer.visible && !studioState.edit.paused) player.startAnimation();
        layer.player = player;
      }
    }

    shell.appendChild(wrap);
    layer.wrapEl = wrap;
    studioEditEnableLayerDrag(layer, wrap);
    studioEditApplyLayerTransform(layer);
  });

  stageEl.appendChild(shell);
  studioEditRefreshLayerZIndex();

  const totalSize = layers.reduce((s, l) => s + l.size, 0);
  document.getElementById('svga-edit-file-name').textContent = layers.length + ' item layout';
  document.getElementById('svga-edit-file-size').textContent =
    layers.length + ' / 8 on preview · ' + studioFormatSize(totalSize);

  const active = layers.find((l) => l.id === studioState.edit.activeLayerId) || layers[layers.length - 1];
  if (active) {
    studioState.edit.activeLayerId = active.id;
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
  set('svga-edit-frame-start', o.startFrame || 0);
  set('svga-edit-frame-end', o.endFrame || layer.frames || 0);
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

  const speedInput = document.getElementById('svga-edit-speed');
  if (speedInput) speedInput.disabled = layer.kind === 'image';
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
    tintOn: !!document.getElementById('svga-edit-tint-on')?.checked,
    startFrame: parseInt(document.getElementById('svga-edit-frame-start')?.value, 10) || 0,
    endFrame: parseInt(document.getElementById('svga-edit-frame-end')?.value, 10) || 0
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

  try {
    localStorage.setItem('aspro_edit_autosave', JSON.stringify(
      studioState.edit.layers.map((l) => ({ name: l.name, kind: l.kind, options: l.options }))
    ));
  } catch (_) {}

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
    tintOn: false,
    startFrame: 0,
    endFrame: layer.frames || 0
  };
  studioEditLoadOptionsToUI(layer);
  studioEditOnOptionChange();
}

function studioEditUpdateMeta() {
  const layers = studioState.edit.layers;
  if (!layers.length) {
    ['size', 'frames', 'fps', 'duration'].forEach((k) => {
      const el = document.getElementById('svga-edit-meta-' + k);
      if (el) el.textContent = '—';
    });
    const ver = document.getElementById('svga-edit-meta-version');
    if (ver) ver.textContent = '0 / 8';
    const count = document.getElementById('svga-edit-layer-count');
    if (count) count.textContent = '0';
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
  document.getElementById('svga-edit-meta-duration').textContent = duration.toFixed(1) + ' s';
  document.getElementById('svga-edit-meta-version').textContent = layers.length + ' / 8';
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
  if (studioState.edit.activeLayerId === id) {
    studioState.edit.activeLayerId = studioState.edit.layers.length
      ? studioState.edit.layers[studioState.edit.layers.length - 1].id
      : null;
  }
  studioEditRebuildPreview();
  studioEditRenderLayerList();
  studioEditUpdateMeta();
}

function studioEditPickReplace() {
  const input = document.getElementById('svga-edit-replace-input');
  if (input) input.click();
}

async function studioEditInspectActive() {
  const layer = studioEditGetActiveLayer();
  if (!layer) {
    studioNotify('Select a layer on preview first', 'error');
    return;
  }
  const grid = document.getElementById('svga-edit-replace-grid');
  if (layer.kind === 'image') {
    studioState.edit.replaceKey = '__image__';
    if (grid) {
      grid.innerHTML = '<button type="button" class="svga-replace-tile selected" onclick="studioEditPickReplace()"><img src="' +
        layer.url + '"><span>Replace this image</span></button>';
    }
    studioEditPickReplace();
    return;
  }
  try {
    const fd = new FormData();
    fd.append('file', layer.file);
    const res = await fetch('/api/convert/svga-inspect', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Inspect failed');
    layer.inspect = data;
    studioState.edit.inspect = data;
    if (!layer.options.endFrame) layer.options.endFrame = data.frames || 0;
    studioEditLoadOptionsToUI(layer);
    if (!grid) return;
    if (!data.images || !data.images.length) {
      grid.innerHTML = '<div class="svga-edit-empty">No replaceable sprites</div>';
      return;
    }
    grid.innerHTML = data.images.map((img) => (
      '<button type="button" class="svga-replace-tile" data-key="' + img.key + '">' +
      '<img src="' + img.preview + '" alt="">' +
      '<span>' + img.key + '</span></button>'
    )).join('');
    grid.querySelectorAll('.svga-replace-tile').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.svga-replace-tile').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        studioState.edit.replaceKey = btn.getAttribute('data-key');
        studioEditPickReplace();
      });
    });
    studioNotify('Click a sprite, then pick an image', 'info');
  } catch (err) {
    studioNotify(err.message || 'Inspect failed', 'error');
  }
}

function studioEditReplaceSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  const layer = studioEditGetActiveLayer();
  if (!file || !layer) return;
  if (layer.kind === 'image' || studioState.edit.replaceKey === '__image__') {
    try { URL.revokeObjectURL(layer.url); } catch (_) {}
    layer.file = file;
    layer.name = file.name;
    layer.url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      layer.w = img.naturalWidth;
      layer.h = img.naturalHeight;
      studioEditRebuildPreview();
      studioEditRenderLayerList();
    };
    img.src = layer.url;
    studioNotify('Image replaced', 'success');
    return;
  }
  const key = studioState.edit.replaceKey;
  if (!key) {
    studioNotify('Select a sprite tile first', 'error');
    return;
  }
  if (!layer.replacements) layer.replacements = {};
  layer.replacements[key] = file;
  studioNotify('Replacement set for ' + key, 'success');
}

function studioEditApplyText() {
  const layer = studioEditGetActiveLayer();
  const text = document.getElementById('svga-edit-text')?.value || '';
  if (!layer || layer.kind !== 'svga') {
    studioNotify('Select an SVGA layer', 'error');
    return;
  }
  if (!text.trim()) {
    studioNotify('Enter text first', 'error');
    return;
  }
  const key = studioState.edit.replaceKey;
  if (!key || key === '__image__') {
    studioNotify('Load sprites and select one to bake text onto', 'error');
    return;
  }
  layer.textOverlay = {
    imageKey: key,
    text: text.trim(),
    color: document.getElementById('svga-edit-text-color')?.value || '#ffffff',
    fontSize: parseInt(document.getElementById('svga-edit-text-size')?.value, 10) || 32
  };
  studioNotify('Text will bake onto ' + key + ' at export', 'success');
}

async function studioEditExportPatch() {
  const layer = studioEditGetActiveLayer() || studioState.edit.layers.find((l) => l.kind === 'svga' && l.visible);
  if (!layer || layer.kind !== 'svga') {
    studioNotify('Select an SVGA layer to export an edited file', 'error');
    return;
  }
  const btn = document.getElementById('svga-edit-patch-btn');
  studioSetBusy(btn, true);
  try {
    const fd = new FormData();
    fd.append('file', layer.file);
    const keys = [];
    Object.keys(layer.replacements || {}).forEach((key) => {
      keys.push(key);
      fd.append('replacements', layer.replacements[key], layer.replacements[key].name);
    });
    fd.append('replaceKeys', JSON.stringify(keys));
    fd.append('textOverlays', JSON.stringify(layer.textOverlay ? [layer.textOverlay] : []));
    fd.append('hideKeys', JSON.stringify([]));
    const o = layer.options || {};
    const newFps = Math.max(1, Math.round((layer.baseFps || 20) * ((o.speed || 100) / 100)));
    fd.append('fps', String(newFps));
    fd.append('startFrame', String(o.startFrame || 0));
    if (o.endFrame) fd.append('endFrame', String(o.endFrame));
    const res = await fetch('/api/convert/svga-patch', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Edit export failed');
    await studioDownloadResult(data);
    studioNotify('Edited SVGA exported', 'success');
  } catch (err) {
    studioNotify(err.message || 'Edit export failed', 'error');
  } finally {
    studioSetBusy(btn, false);
  }
}

function studioRenderEditImages() {
  return;
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
    studioNotify('Place at least one item on Large Preview', 'error');
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
        kind: layer.kind || 'svga',
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

    const dl = await fetch(data.downloadUrl);
    if (!dl.ok) throw new Error('Download failed');
    const blob = await dl.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = data.filename || 'composed.svga';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);

    studioRememberDownload(data);
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
  studioEditStopLibraryPlayers();
  studioState.edit.layers.forEach((layer) => {
    try {
      if (layer.player) {
        layer.player.stopAnimation();
        layer.player.clear();
      }
    } catch (_) {}
  });
  const urls = new Set();
  studioState.edit.library.forEach((a) => { if (a.url) urls.add(a.url); });
  urls.forEach((url) => URL.revokeObjectURL(url));

  studioState.edit = {
    library: [],
    layers: [],
    activeLayerId: null,
    paused: false,
    composing: false,
    canvasMax: 8
  };
  studioState.files['svga-edit'] = null;

  studioEditRebuildPreview();
  studioEditRenderLibrary();
  studioEditRenderLayerList();
  studioEditUpdateMeta();
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

async function studioBatchVapConvert(files) {
  const list = files.filter((f) => studioFileOk(f, 'vap-convert'));
  if (!list.length) {
    studioNotify('No valid VAP/MP4 files', 'error');
    return;
  }
  studioLoadFile('vap-convert', list[0]);
  const format = document.querySelector('input[name="vap-convert-format"]:checked')?.value || 'svga';
  studioSetProgress('vap-convert-progress', 5, 'Batch 0/' + list.length);
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < list.length; i++) {
    studioSetProgress('vap-convert-progress', Math.round(((i) / list.length) * 100), 'Batch ' + (i + 1) + '/' + list.length);
    try {
      const fd = new FormData();
      fd.append('file', list[i]);
      fd.append('format', format);
      fd.append('quality', document.getElementById('vap-convert-quality')?.value || 'medium');
      fd.append('fps', document.getElementById('vap-convert-fps')?.value || '30');
      fd.append('resolution', document.getElementById('vap-convert-res')?.value || 'original');
      fd.append('keepAlpha', document.getElementById('vap-convert-alpha')?.checked ? '1' : '0');
      const res = await fetch('/api/convert/vap', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      await studioDownloadResult(data);
      ok++;
    } catch (err) {
      fail++;
      studioNotify(list[i].name + ': ' + (err.message || 'failed'), 'error');
    }
  }
  studioSetProgress('vap-convert-progress', 100, ok + ' ok, ' + fail + ' failed');
  studioNotify('Batch done: ' + ok + ' ok, ' + fail + ' failed', fail ? 'error' : 'success');
}

function studioDetectVapLayout(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w >= 4 && w % 2 === 0 && h > 0 && w / h >= 1.85) return 'lr-alpha-rgb';
  if (h >= 4 && h % 2 === 0 && w > 0 && h / w >= 1.85) return 'tb-alpha-rgb';
  return 'none';
}

function studioStopVapPreview() {
  if (studioState.vapRaf) {
    cancelAnimationFrame(studioState.vapRaf);
    studioState.vapRaf = 0;
  }
}

function studioBindVapPreview(video, canvasId, module, forceLayout) {
  const canvas = document.getElementById(canvasId);
  if (!video || !canvas) return;
  studioStopVapPreview();
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const draw = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      const layout = forceLayout || studioDetectVapLayout(vw, vh);
      let visW = vw;
      let visH = vh;
      let colorSx = 0;
      let colorSy = 0;
      let alphaSx = 0;
      let alphaSy = 0;
      if (layout === 'lr-alpha-rgb') {
        visW = Math.floor(vw / 2);
        visH = vh;
        alphaSx = 0;
        colorSx = visW;
      } else if (layout === 'tb-alpha-rgb') {
        visW = vw;
        visH = Math.floor(vh / 2);
        alphaSy = 0;
        colorSy = visH;
      }
      if (canvas.width !== visW) canvas.width = visW;
      if (canvas.height !== visH) canvas.height = visH;
      if (layout === 'none') {
        ctx.drawImage(video, 0, 0, visW, visH);
      } else {
        ctx.clearRect(0, 0, visW, visH);
        ctx.drawImage(video, colorSx, colorSy, visW, visH, 0, 0, visW, visH);
        const color = ctx.getImageData(0, 0, visW, visH);
        ctx.drawImage(video, alphaSx, alphaSy, visW, visH, 0, 0, visW, visH);
        const alpha = ctx.getImageData(0, 0, visW, visH);
        const cd = color.data;
        const ad = alpha.data;
        for (let i = 0; i < cd.length; i += 4) {
          cd[i + 3] = ad[i];
        }
        ctx.putImageData(color, 0, 0);
      }
    }
    studioState.vapRaf = requestAnimationFrame(draw);
  };
  const start = () => {
    studioStopVapPreview();
    video.play().catch(() => {});
    draw();
  };
  video.onloadedmetadata = start;
  if (video.readyState >= 1) start();
}

function studioSetMetaText(prefix, info) {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  if (!info) {
    set(prefix + '-meta-res', '—');
    set(prefix + '-meta-fps', '—');
    set(prefix + '-meta-dur', '—');
    set(prefix + '-meta-alpha', '—');
    return;
  }
  set(prefix + '-meta-res', (info.width || 0) + ' × ' + (info.height || 0));
  set(prefix + '-meta-fps', String(Math.round(info.fps || 0)));
  set(prefix + '-meta-dur', Number(info.duration || 0).toFixed(2) + ' s');
  set(prefix + '-meta-alpha', info.hasSplitAlpha ? 'Split alpha (VAP)' : 'No packed alpha');
}

async function studioProbeVap(file, module) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/convert/vap-info', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Probe failed');
    studioState.vapMeta = data;
    studioSetMetaText(module, data);
  } catch (err) {
    studioNotify(err.message || 'Could not read video info', 'error');
  }
}

function studioSetBusy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('loading', !!on);
  btn.disabled = !!on;
}

function studioSetProgress(id, pct, label) {
  const wrap = document.getElementById(id);
  const bar = wrap ? wrap.querySelector('.studio-progress-bar') : null;
  const text = wrap ? wrap.querySelector('.studio-progress-label') : null;
  if (wrap) wrap.style.display = pct == null ? 'none' : 'block';
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  if (text) text.textContent = label || (Math.round(pct || 0) + '%');
}

function studioRememberDownload(data) {
  studioState.downloads.unshift({
    jobId: data.jobId,
    filename: data.filename,
    size: data.size,
    url: data.downloadUrl,
    at: Date.now()
  });
  studioState.downloads = studioState.downloads.slice(0, 12);
  studioRenderDownloads();
}

function studioRenderDownloads() {
  const el = document.getElementById('studio-download-list');
  if (!el) return;
  if (!studioState.downloads.length) {
    el.innerHTML = '<div class="svga-edit-empty">No exports yet</div>';
    return;
  }
  el.innerHTML = studioState.downloads.map((d) => (
    '<a class="studio-dl-item" href="' + d.url + '" download="' + d.filename + '">' +
    '<strong>' + d.filename + '</strong><span>' + studioFormatSize(d.size || 0) + '</span></a>'
  )).join('');
}

async function studioDownloadResult(data) {
  if (!data || !data.downloadUrl) throw new Error('No output file');
  studioRememberDownload(data);
  const res = await fetch(data.downloadUrl);
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = data.filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob;
}

function studioShowResultPreview(containerId, blob, filename) {
  const box = document.getElementById(containerId);
  if (!box || !blob) return;
  box.style.display = 'block';
  const url = URL.createObjectURL(blob);
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.webp') || name.endsWith('.gif') || name.endsWith('.png')) {
    box.innerHTML = '<p class="setting-label">Preview</p><img alt="preview" src="' + url + '">';
  } else if (name.endsWith('.mp4')) {
    const vidId = containerId + '-video';
    const canvasId = containerId + '-canvas';
    box.innerHTML =
      '<p class="setting-label">Alpha preview</p>' +
      '<div class="vap-preview-stage" id="' + containerId + '-stage">' +
      '<video id="' + vidId + '" class="vap-hidden-source" playsinline loop muted></video>' +
      '<canvas id="' + canvasId + '" class="vap-alpha-canvas"></canvas></div>';
    const video = document.getElementById(vidId);
    video.src = url;
    studioBindVapPreview(video, canvasId, containerId, 'lr-alpha-rgb');
  } else {
    box.innerHTML = '<p class="setting-label">File ready: ' + filename + '</p>';
  }
}

async function studioConvertVapMp4() {
  const file = studioState.files['vap-mp4'];
  if (!file) {
    studioNotify('Upload a file first', 'error');
    return;
  }
  const btn = document.getElementById('vap-mp4-export-btn');
  studioSetBusy(btn, true);
  studioSetProgress('vap-mp4-progress', 20, 'Encoding VAP…');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('format', 'vap');
    fd.append('quality', 'high');
    fd.append('keepAlpha', '1');
    const res = await fetch('/api/convert/vap', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed');
    studioSetProgress('vap-mp4-progress', 100, 'Done');
    const blob = await studioDownloadResult(data);
    studioShowResultPreview('vap-mp4-result', blob, data.filename);
    studioNotify('VAP MP4 exported', 'success');
  } catch (err) {
    studioNotify(err.message || 'VAP export failed', 'error');
  } finally {
    studioSetBusy(btn, false);
    setTimeout(() => studioSetProgress('vap-mp4-progress', null), 2500);
  }
}

function studioMp4VapToggleBg() {
  const on = document.getElementById('mp4-vap-remove-bg')?.checked;
  const box = document.getElementById('mp4-vap-bg-colors');
  if (box) box.style.display = on ? '' : 'none';
}

async function studioConvertMp4Vap() {
  const file = studioState.files['mp4-vap'];
  if (!file) {
    studioNotify('Upload an MP4 first', 'error');
    return;
  }
  const btn = document.getElementById('mp4-vap-btn');
  studioSetBusy(btn, true);
  studioSetProgress('mp4-vap-progress', 15, 'Converting MP4 → VAP…');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('format', 'vap');
    fd.append('layout', 'none');
    fd.append('keepAlpha', '1');
    fd.append('quality', document.getElementById('mp4-vap-quality')?.value || 'medium');
    fd.append('fps', document.getElementById('mp4-vap-fps')?.value || '30');
    fd.append('bitrate', document.getElementById('mp4-vap-bitrate')?.value || '4');
    fd.append('resolution', document.getElementById('mp4-vap-res')?.value || 'original');
    const removeBg = document.getElementById('mp4-vap-remove-bg')?.checked;
    fd.append('removeBg', removeBg ? '1' : '0');
    fd.append('bgColor', document.getElementById('mp4-vap-bg-color')?.value || 'transparent');
    const res = await fetch('/api/convert/vap', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'MP4 → VAP failed');
    studioSetProgress('mp4-vap-progress', 100, 'Done');
    const blob = await studioDownloadResult(data);
    studioShowResultPreview('mp4-vap-result', blob, data.filename);
    studioNotify('VAP MP4 ready', 'success');
  } catch (err) {
    studioNotify(err.message || 'MP4 → VAP failed', 'error');
  } finally {
    studioSetBusy(btn, false);
    setTimeout(() => studioSetProgress('mp4-vap-progress', null), 2500);
  }
}

async function studioConvertVapFormat() {
  const file = studioState.files['vap-convert'];
  if (!file) {
    studioNotify('Upload a file first', 'error');
    return;
  }
  const format = document.querySelector('input[name="vap-convert-format"]:checked')?.value || 'svga';
  const btn = document.getElementById('vap-convert-btn');
  studioSetBusy(btn, true);
  studioSetProgress('vap-convert-progress', 15, 'Extracting frames…');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('format', format);
    fd.append('quality', document.getElementById('vap-convert-quality')?.value || 'medium');
    fd.append('fps', document.getElementById('vap-convert-fps')?.value || '30');
    fd.append('resolution', document.getElementById('vap-convert-res')?.value || 'original');
    fd.append('keepAlpha', document.getElementById('vap-convert-alpha')?.checked ? '1' : '0');
    const res = await fetch('/api/convert/vap', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Conversion failed');
    studioSetProgress('vap-convert-progress', 100, 'Done');
    const blob = await studioDownloadResult(data);
    studioShowResultPreview('vap-convert-result', blob, data.filename);
    studioNotify('Converted to ' + format.toUpperCase(), 'success');
  } catch (err) {
    studioNotify(err.message || 'Conversion failed', 'error');
  } finally {
    studioSetBusy(btn, false);
    setTimeout(() => studioSetProgress('vap-convert-progress', null), 2500);
  }
}

async function studioConvertSvgaVap() {
  const file = studioState.files['svga-vap'];
  if (!file) {
    studioNotify('Upload a file first', 'error');
    return;
  }
  const btn = document.getElementById('svga-vap-btn');
  studioSetBusy(btn, true);
  studioSetProgress('svga-vap-progress', 20, 'Rendering SVGA…');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('fps', document.getElementById('svga-vap-fps')?.value || '30');
    fd.append('bitrate', document.getElementById('svga-vap-bitrate')?.value || '4');
    fd.append('resolution', document.getElementById('svga-vap-res')?.value || 'original');
    fd.append('keepAlpha', document.getElementById('svga-vap-alpha')?.checked ? '1' : '0');
    const res = await fetch('/api/convert/svga-vap', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Encode failed');
    studioSetProgress('svga-vap-progress', 100, 'Done');
    const blob = await studioDownloadResult(data);
    studioShowResultPreview('svga-vap-result', blob, data.filename);
    studioNotify('VAP MP4 encoded', 'success');
  } catch (err) {
    studioNotify(err.message || 'SVGA → VAP failed', 'error');
  } finally {
    studioSetBusy(btn, false);
    setTimeout(() => studioSetProgress('svga-vap-progress', null), 2500);
  }
}

function studioAction(module) {
  if (module === 'vap-mp4') return studioConvertVapMp4();
  if (module === 'mp4-vap') return studioConvertMp4Vap();
  if (module === 'vap-convert') return studioConvertVapFormat();
  if (module === 'svga-vap') return studioConvertSvgaVap();
  studioNotify('Unknown action', 'error');
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

      const controls = document.createElement('div');
      controls.className = 'multi-card-controls';
      controls.innerHTML =
        '<button type="button" class="studio-chip-btn" data-act="play">Play</button>' +
        '<button type="button" class="studio-chip-btn" data-act="pause">Pause</button>' +
        '<button type="button" class="studio-chip-btn" data-act="stop">Stop</button>';
      controls.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const act = btn.getAttribute('data-act');
          try {
            if (act === 'play') player.startAnimation();
            else if (act === 'pause') player.pauseAnimation();
            else {
              player.stopAnimation();
              player.stepToFrame && player.stepToFrame(0, false);
            }
          } catch (_) {}
        });
      });
      card.appendChild(controls);

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

function studioMultiSetView(mode) {
  studioState.multiView = mode === 'list' ? 'list' : 'grid';
  const grid = document.getElementById('multi-svga-grid');
  if (grid) grid.classList.toggle('list-view', studioState.multiView === 'list');
}

function studioMultiAll(act) {
  studioState.multiPlayers.forEach((entry) => {
    const p = entry.player;
    if (!p) return;
    try {
      if (act === 'play') p.startAnimation();
      else if (act === 'pause') p.pauseAnimation();
      else {
        p.stopAnimation();
        if (p.stepToFrame) p.stepToFrame(0, false);
      }
    } catch (_) {}
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

document.addEventListener('DOMContentLoaded', () => {
  if (typeof studioEditRenderLibrary === 'function') studioEditRenderLibrary();
  studioRenderDownloads();
});
