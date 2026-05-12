/**
 * AnimSuite Pro - Main Application Logic
 */

// ===== STATE =====
const state = {
  currentPage: 'home',
  files: { 'svga-webp': null, 'video-svga': null },
  jobs: {},
  history: JSON.parse(localStorage.getItem('animsuite_history') || '[]'),
};

let svgaLibLoadingPromise = null;
async function ensureSVGALibraryLoaded() {
  if (typeof SVGA !== 'undefined') return true;
  if (svgaLibLoadingPromise) return svgaLibLoadingPromise;

  const sources = [
    '/js/vendor/svga.min.js',
    'https://cdn.jsdelivr.net/npm/svgaplayerweb@2.3.1/build/svga.min.js',
    'https://unpkg.com/svgaplayerweb@2.3.1/build/svga.min.js'
  ];

  svgaLibLoadingPromise = (async () => {
    for (const src of sources) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.async = true;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        if (typeof SVGA !== 'undefined') {
          return true;
        }
      } catch (e) { }
    }
    return false;
  })();

  return svgaLibLoadingPromise;
}
window.ensureSVGALibraryLoaded = ensureSVGALibraryLoaded;

// ===== NAVIGATION =====
function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) {
    target.classList.add('active');
    state.currentPage = page;
  }
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });

  if (page === 'home') renderHistory();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== SYSTEM HEALTH =====
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (data.ffmpeg) {
      dot.classList.add('online');
      text.textContent = 'System Ready';
    } else {
      text.textContent = 'FFmpeg Missing';
    }
  } catch {
    document.querySelector('.status-text').textContent = 'Offline';
  }
}

// ===== DRAG & DROP =====
function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}
function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}
function handleDrop(e, module) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setFile(module, file);
}
function handleFileSelect(e, module) {
  const file = e.target.files[0];
  if (file) setFile(module, file);
}

function setFile(module, file) {
  state.files[module] = file;
  const prefix = module === 'svga-webp' ? 'svga' : 'video';
  const zoneId = module === 'svga-webp' ? 'svga-upload-zone' : 'video-upload-zone';
  const newBtnId = module === 'svga-webp' ? 'svga-new-btn' : 'video-new-btn';
  const convertWrapperId = module === 'svga-webp' ? 'svga-convert-wrapper' : 'video-convert-wrapper';

  const zone = document.getElementById(zoneId);
  const newBtn = document.getElementById(newBtnId);

  zone.classList.add('has-file');
  const content = zone.querySelector('.upload-content');
  content.innerHTML = `
    <div class="upload-icon" style="color: var(--green);">
      <svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="24" stroke="currentColor" stroke-width="2"/><path d="M22 32L28 38L42 24" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <p class="upload-text"><strong>${file.name}</strong></p>
    <p class="upload-hint">${(file.size / (1024 * 1024)).toFixed(2)} MB</p>
    <button class="remove-file-btn" onclick="event.stopPropagation(); resetModule('${module}')">Remove</button>
  `;

  if (newBtn) newBtn.style.display = 'block';

  if (convertWrapperId) {
    document.getElementById(convertWrapperId).style.display = 'block';
  }

  if (module === 'video-svga') {
    const audioSelector = document.getElementById('video-audio-selector');
    if (audioSelector) audioSelector.style.display = 'block';
    const bgSelector = document.getElementById('video-bg-selector');
    if (bgSelector) bgSelector.style.display = 'block';
  }

  // Show preview
  if (module === 'svga-webp') {
    showSVGAPreview(file);
  } else {
    showVideoPreview(file);
  }
}

function showVideoPreview(file) {
  const previewBox = document.getElementById('video-upload-preview');
  const fileNameEl = document.getElementById('video-file-name');
  const fileSizeEl = document.getElementById('video-file-size');
  const playerCanvas = document.getElementById('video-player-canvas');

  previewBox.style.display = 'block';
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';

  const url = URL.createObjectURL(file);
  playerCanvas.innerHTML = `
    <video src="${url}" autoplay loop muted playsinline style="
      max-width: 100%;
      max-height: 100%;
      display: block;
      margin: 0 auto;
      object-fit: contain;
    "></video>
  `;
}

// SVGA Preview is now handled by svga-preview.js

function resetModule(module) {
  state.files[module] = null;
  const prefix = module === 'svga-webp' ? 'svga' : 'video';
  const zoneId = module === 'svga-webp' ? 'svga-upload-zone' : 'video-upload-zone';
  const btnId = module === 'svga-webp' ? 'svga-convert-btn' : 'video-convert-btn';
  const newBtnId = module === 'svga-webp' ? 'svga-new-btn' : 'video-new-btn';
  const resultId = module === 'svga-webp' ? 'svga-result' : 'video-result';

  const zone = document.getElementById(zoneId);
  const newBtn = document.getElementById(newBtnId);
  const result = document.getElementById(resultId);
  const convertWrapper = document.getElementById(`${prefix}-convert-wrapper`);

  zone.classList.remove('has-file');
  if (module === 'video-svga') {
    const audioSelector = document.getElementById('video-audio-selector');
    if (audioSelector) audioSelector.style.display = 'none';
    const bgSelector = document.getElementById('video-bg-selector');
    if (bgSelector) bgSelector.style.display = 'none';
  }

  const content = zone.querySelector('.upload-content');

  if (module === 'svga-webp') {
    content.innerHTML = `
      <div class="upload-icon">
        <svg viewBox="0 0 64 64" fill="none">
          <rect x="8" y="16" width="48" height="40" rx="8" stroke="currentColor" stroke-width="2" stroke-dasharray="4 4" />
          <path d="M32 28V48" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path d="M24 36L32 28L40 36" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <p class="upload-text">Drag & drop your <strong>.svga</strong> file here</p>
      <p class="upload-hint">or click to browse</p>
      <input type="file" accept=".svga" class="file-input" id="svga-file-input" onchange="handleFileSelect(event, 'svga-webp')">
    `;
  } else {
    content.innerHTML = `
      <div class="upload-icon">
        <svg viewBox="0 0 64 64" fill="none">
          <rect x="8" y="16" width="48" height="40" rx="8" stroke="currentColor" stroke-width="2" stroke-dasharray="4 4" />
          <polygon points="28,24 40,32 28,40" fill="currentColor" opacity="0.5" />
        </svg>
      </div>
      <p class="upload-text">Drag & drop your <strong>video</strong> here</p>
      <p class="upload-hint">MP4, MOV • Max 10 seconds • Max 50MB</p>
      <input type="file" accept="video/mp4,video/quicktime,video/x-msvideo,.mp4,.mov,.avi" class="file-input" id="video-file-input" onchange="handleFileSelect(event, 'video-svga')">
    `;
  }

  if (newBtn) newBtn.style.display = 'none';
  result.style.display = 'none';
  if (convertWrapper) convertWrapper.style.display = 'none';

  if (module === 'svga-webp') {
    const previewBox = document.getElementById('svga-upload-preview');
    if (previewBox) previewBox.style.display = 'none';
    // Player cleanup is handled by svga-preview.js
  } else if (module === 'video-svga') {
    const previewBox = document.getElementById('video-upload-preview');
    if (previewBox) previewBox.style.display = 'none';
  }

  showToast('Reset complete', 'info');
}

// ===== SIZE CARD SELECTION =====
document.addEventListener('click', (e) => {
  const card = e.target.closest('.size-card');
  if (card) {
    const group = card.closest('.size-cards');
    group.querySelectorAll('.size-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const radio = card.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
      // Removed auto-trigger to allow manual convert
    }
  }

  const toggleBtn = e.target.closest('.toggle-btn');
  if (toggleBtn) {
    const group = toggleBtn.closest('.toggle-group');
    group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('selected'));
    toggleBtn.classList.add('selected');
    const radio = toggleBtn.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
      const options = document.getElementById('bg-removal-options');
      if (options) {
        options.style.display = radio.value === 'yes' ? 'block' : 'none';
      }
    }
  }

  const bgOpt = e.target.closest('.bg-option');
  if (bgOpt) {
    const group = bgOpt.closest('.bg-options');
    group.querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
    bgOpt.classList.add('selected');
    const radio = bgOpt.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
    }
  }
});

// ===== CONVERSION =====
async function startConversion(module) {
  const file = state.files[module];
  if (!file) return;

  const prefix = module === 'svga-webp' ? 'svga' : 'video';
  const statusEl = document.getElementById(`${prefix}-convert-status`);
  const resultArea = document.getElementById(`${prefix}-result`);
  const progressBar = document.getElementById(`${prefix}-progress-bar`);
  const progressStep = document.getElementById(`${prefix}-progress-step`);
  const resultContent = document.getElementById(`${prefix}-result-content`);
  const progressSection = document.getElementById(`${prefix}-progress`);

  // Get selected size tier
  const sizeRadio = document.querySelector(`input[name="${prefix}-size"]:checked`);
  const sizeTier = sizeRadio ? sizeRadio.value : 'standard';

  // UI: Loading state
  if (statusEl) statusEl.style.display = 'flex';
  resultArea.style.display = 'block';
  resultContent.style.display = 'none';
  progressSection.style.display = 'block';
  progressBar.style.width = '10%';
  progressBar.style.background = 'linear-gradient(90deg, var(--accent), var(--purple))';
  progressStep.textContent = 'Starting...';

  try {
    console.log('Starting conversion:', { module, file: file.name, sizeTier });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('sizeTier', sizeTier);

    if (module === 'svga-webp') {
      const formatRadio = document.querySelector('input[name="svga-format"]:checked');
      const format = formatRadio ? formatRadio.value : 'webp';
      formData.append('format', format);
      console.log('SVGA format:', format);
    }

    if (module === 'video-svga') {
      const toggleRadio = document.querySelector('input[name="video-bg-toggle"]:checked');
      const isRemoving = toggleRadio ? toggleRadio.value === 'yes' : false;
      
      formData.append('removeBg', isRemoving);
      
      if (isRemoving) {
        const bgRadio = document.querySelector('input[name="video-bg"]:checked');
        const bgColor = bgRadio ? bgRadio.value : 'white';
        formData.append('bgColor', bgColor);
      } else {
        formData.append('bgColor', 'none');
      }

      const includeAudio = document.getElementById('video-include-audio').checked;
      formData.append('includeAudio', includeAudio);
      console.log('Video options:', { isRemoving, includeAudio });
    }

    progressBar.style.width = '30%';
    progressStep.textContent = 'Uploading & Processing...';

    const endpoint = module === 'svga-webp' ? '/api/convert/svga' : '/api/convert/video-svga';
    console.log('Sending request to:', endpoint);

    const res = await fetch(endpoint, { method: 'POST', body: formData });

    console.log('Response status:', res.status);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Server error' }));
      console.error('Conversion error:', errData);
      throw new Error(errData.error || 'Conversion failed');
    }

    const data = await res.json();
    console.log('Conversion response:', data);

    if (!data.success) throw new Error(data.error || 'Conversion failed');

    progressBar.style.width = '100%';
    progressStep.textContent = 'Complete!';

    // Show result
    setTimeout(async () => {
      progressSection.style.display = 'none';
      resultContent.style.display = 'block';
      if (statusEl) statusEl.style.display = 'none';

      console.log('📍 Result section now visible');

      // Scroll to result - AFTER a small delay to ensure rendering
      setTimeout(() => {
        resultArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
        console.log('📍 Scrolled to result area');
      }, 100);

      const infoEl = document.getElementById(`${prefix}-result-info`);
      infoEl.innerHTML = `
        <strong>✅ Conversion Complete</strong><br>
        File: ${data.filename}<br>
        Size: ${data.sizeMB} MB<br>
        ${data.framesProcessed ? `Frames: ${data.framesProcessed}` : ''}
      `;

      // Preview logic
      const convertedPreviewBox = document.getElementById(`${prefix}-converted-preview-box`);
      const convertedCanvas = document.getElementById(`${prefix}-converted-canvas`);
      const convertedDetails = document.getElementById(`${prefix}-converted-details`);
      const jsonViewer = document.getElementById('svga-json-viewer');
      const jsonContent = document.getElementById('svga-json-content');
      const formatRadio = document.querySelector('input[name="svga-format"]:checked');
      const format = formatRadio ? formatRadio.value : 'webp';

      if (module === 'svga-webp' && format === 'json') {
        if (convertedPreviewBox) convertedPreviewBox.style.display = 'none';
        if (jsonViewer) jsonViewer.style.display = 'block';

        // Fetch the actual JSON to display it
        try {
          const jsonRes = await fetch(`/api/download/${data.jobId}`);
          const jsonData = await jsonRes.json();
          if (jsonContent) jsonContent.textContent = JSON.stringify(jsonData, null, 2);
        } catch (e) {
          if (jsonContent) jsonContent.textContent = 'Error loading JSON preview';
        }
      } else if (module === 'svga-webp') {
        if (convertedPreviewBox) convertedPreviewBox.style.display = 'block';
        if (jsonViewer) jsonViewer.style.display = 'none';

        // Render image in player-canvas (same as Source Preview)
        if (convertedCanvas) {
          convertedCanvas.innerHTML = '';

          const previewUrl = `/api/download/${data.jobId}?preview=1&t=${Date.now()}`;

          const img = document.createElement('img');
          img.src = previewUrl;
          img.alt = `Converted ${format.toUpperCase()}`;
          img.style.cssText = `
            max-width: 100%;
            max-height: 100%;
            display: block;
            margin: 0 auto;
            object-fit: contain;
          `;

          img.onerror = function () {
            convertedCanvas.innerHTML = '<div style="color:#888;padding:2rem;">Preview not available — use Download button</div>';
          };

          convertedCanvas.appendChild(img);
        }

        // Show file details (same as Source Preview)
        if (convertedDetails) {
          convertedDetails.innerHTML = `
            <span>${data.filename}</span>
            <span>${data.sizeMB} MB</span>
          `;
        }
      } else if (module === 'video-svga') {
        if (convertedPreviewBox) convertedPreviewBox.style.display = 'block';

        if (convertedCanvas) {
          convertedCanvas.innerHTML = '<div style="color:#888;">Loading SVGA Preview...</div>';
          convertedCanvas.classList.remove('checkerboard-bg', 'opaque-preview');

          const isRemoving = data.removeBg === true;

          const svgaReady = await ensureSVGALibraryLoaded();
          if (svgaReady && typeof SVGA !== 'undefined') {
            const parser = new SVGA.Parser();
            const previewEndpoint = `/api/download/${data.jobId}?preview=1&t=${Date.now()}`;

            let previewObjectUrl = null;
            try {
              const previewRes = await fetch(previewEndpoint, { cache: 'no-store' });
              console.log('[Preview][SVGA][Fetch]', {
                status: previewRes.status,
                ok: previewRes.ok,
                contentType: previewRes.headers.get('content-type')
              });
              if (!previewRes.ok) {
                throw new Error(`Preview download failed: HTTP ${previewRes.status}`);
              }
              const previewBlob = await previewRes.blob();
              previewObjectUrl = URL.createObjectURL(previewBlob);
            } catch (fetchErr) {
              console.error('[Preview][SVGA][FetchError]', fetchErr);
              convertedCanvas.innerHTML = '<div style="color:#888;padding:2rem;">Preview fetch failed. Please retry or download file.</div>';
              return;
            }

            parser.load(previewObjectUrl, (videoItem) => {
              const nativeW = videoItem.videoSize.width || 300;
              const nativeH = videoItem.videoSize.height || 300;
              console.log('[Preview][SVGA][Meta]', {
                width: nativeW,
                height: nativeH,
                fps: videoItem.FPS || 0,
                removeBg: isRemoving
              });

              if (isRemoving) {
                convertedCanvas.classList.add('checkerboard-bg');
                convertedCanvas.classList.remove('opaque-preview');
              } else {
                convertedCanvas.classList.remove('checkerboard-bg');
                convertedCanvas.classList.add('opaque-preview');
              }

              const isCanvasVisible = (canvas) => {
                try {
                  const ctx = canvas.getContext('2d');
                  if (!ctx) return false;
                  const samplePoints = [
                    [Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.2)],
                    [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5)],
                    [Math.floor(canvas.width * 0.8), Math.floor(canvas.height * 0.8)],
                  ];
                  for (const [x, y] of samplePoints) {
                    const p = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
                    const rgb = p[0] + p[1] + p[2];
                    if (rgb > 20 || p[3] > 0) {
                      return true;
                    }
                  }
                  return false;
                } catch (e) {
                  console.warn('[Preview][SVGA] visibility check failed:', e.message);
                  return true;
                }
              };

              const mountPlayer = (alphaEnabled) => {
                convertedCanvas.innerHTML = '';
                const canvas = document.createElement('canvas');
                canvas.width = nativeW;
                canvas.height = nativeH;
                const ctx = canvas.getContext('2d', {
                  alpha: alphaEnabled,
                  premultipliedAlpha: false,
                  desynchronized: true
                });
                console.log('[Preview][SVGA][Canvas]', {
                  width: canvas.width,
                  height: canvas.height,
                  alphaEnabled,
                  ctxCreated: !!ctx
                });
                if (ctx) {
                  ctx.imageSmoothingEnabled = true;
                  ctx.imageSmoothingQuality = 'high';
                }
                convertedCanvas.appendChild(canvas);

                const player = new SVGA.Player(canvas);
                player.clearsAfterStop = false;
                player.fillMode = 'Forward';
                if (player.setContentMode) {
                  player.setContentMode('AspectFit');
                }
                player.setVideoItem(videoItem);
                player.startAnimation();
                return { canvas, player };
              };

              let active = mountPlayer(isRemoving ? true : false);

              // NO mode: if strict opaque context renders blank, retry with alpha=true compatibility mode.
              if (!isRemoving) {
                setTimeout(() => {
                  const visible = isCanvasVisible(active.canvas);
                  console.log('[Preview][SVGA][OpaqueCheck]', { visible });
                  if (!visible) {
                    try {
                      active.player.stopAnimation();
                    } catch (e) {}
                    active = mountPlayer(true);
                    setTimeout(() => {
                      const visibleAfterFallback = isCanvasVisible(active.canvas);
                      console.log('[Preview][SVGA][FallbackCheck]', { visibleAfterFallback });
                    }, 400);
                  }
                }, 500);
              }

              if (previewObjectUrl) {
                URL.revokeObjectURL(previewObjectUrl);
              }
            }, (err) => {
              console.error('SVGA load error:', err);
              convertedCanvas.innerHTML = '<div style="color:#888;padding:2rem;">SVGA Preview failed. Please download to view.</div>';
              if (previewObjectUrl) {
                URL.revokeObjectURL(previewObjectUrl);
              }
            });
          } else {
            convertedCanvas.innerHTML = '<div style="color:#888;padding:2rem;">SVGA library not loaded</div>';
          }
        }

        if (convertedDetails) {
          convertedDetails.innerHTML = `
            <span>${data.filename}</span>
            <span class="size-badge">${data.sizeMB} MB</span>
          `;
        }
      }

      // Download button
      const dlBtn = document.getElementById(`${prefix}-download-btn`);
      if (dlBtn) {
        dlBtn.onclick = () => {
          console.log('Download button clicked:', { jobId: data.jobId, filename: data.filename });
          const a = document.createElement('a');
          a.href = `/api/download/${data.jobId}`;
          a.download = data.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          showToast('Download started!', 'success');
        };
      } else {
        console.error('Download button not found:', `${prefix}-download-btn`);
      }

      // Save to history
      addToHistory({
        jobId: data.jobId,
        filename: data.filename,
        originalName: file.name,
        module: module,
        date: new Date().toISOString(),
        size: data.sizeMB
      });
    }, 500);

  } catch (err) {
    progressBar.style.width = '100%';
    progressBar.style.background = 'var(--red)';
    progressStep.textContent = `Error: ${err.message}`;
    showToast(err.message, 'error');
    if (statusEl) statusEl.style.display = 'none';
  }
}

// ===== TOAST =====
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ===== HISTORY MANAGEMENT =====
function addToHistory(item) {
  state.history.unshift(item);
  if (state.history.length > 20) state.history.pop();
  localStorage.setItem('animsuite_history', JSON.stringify(state.history));
}

function renderHistory() {
  const container = document.getElementById('recent-conversions-section');
  const list = document.getElementById('history-list');

  if (state.history.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = state.history.map((item, idx) => `
    <div class="history-item">
      <div class="history-info">
        <div class="history-name">${item.originalName} → ${item.filename.split('.').pop().toUpperCase()}</div>
        <div class="history-meta">${new Date(item.date).toLocaleString()} • ${item.size} MB</div>
      </div>
      <div class="history-actions">
        <button class="history-btn dl" onclick="downloadFromHistory('${item.jobId}', '${item.filename}')">Download</button>
        <button class="history-btn del" onclick="removeFromHistory(${idx})">×</button>
      </div>
    </div>
  `).join('');
}

function downloadFromHistory(jobId, filename) {
  const a = document.createElement('a');
  a.href = `/api/download/${jobId}`;
  a.download = filename;
  a.click();
  showToast('Download started!', 'success');
}

function removeFromHistory(index) {
  state.history.splice(index, 1);
  localStorage.setItem('animsuite_history', JSON.stringify(state.history));
  renderHistory();
}

function clearHistory() {
  if (confirm('Clear all conversion history?')) {
    state.history = [];
    localStorage.removeItem('animsuite_history');
    renderHistory();
  }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  renderHistory();
  navigateTo('home');
});
