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
  const btnId = module === 'svga-webp' ? 'svga-convert-btn' : 'video-convert-btn';
  const newBtnId = module === 'svga-webp' ? 'svga-new-btn' : 'video-new-btn';
  
  const zone = document.getElementById(zoneId);
  const btn = document.getElementById(btnId);
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
  btn.disabled = false;
  if (newBtn) newBtn.style.display = 'block';
  
  // Auto-trigger preview & conversion
  if (module === 'svga-webp') {
    showSVGAPreview(file);
  }
  startConversion(module);
}

let svgaPlayer = null;
let svgaParser = null;

function showSVGAPreview(file) {
  const previewBox = document.getElementById('svga-upload-preview');
  const fileNameEl = document.getElementById('svga-file-name');
  const fileSizeEl = document.getElementById('svga-file-size');
  
  previewBox.style.display = 'block';
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';

  const url = URL.createObjectURL(file);
  
  if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml') {
    const playerCanvas = document.getElementById('svga-player-canvas');
    playerCanvas.innerHTML = `<img src="${url}" style="max-height:100%; max-width:100%;">`;
    // We don't revoke immediately because the img needs it
  } else {
    // Treat as SVGA
    if (!svgaPlayer) {
      svgaPlayer = new SVGA.Player('#svga-player-canvas');
      svgaParser = new SVGA.Parser();
    }
    
    // Clear canvas first
    document.getElementById('svga-player-canvas').innerHTML = '';

    svgaParser.load(url, (videoItem) => {
      svgaPlayer.setVideoItem(videoItem);
      svgaPlayer.startAnimation();
      URL.revokeObjectURL(url);
    }, (err) => {
      console.error('SVGA Preview Error:', err);
      showToast('Failed to preview SVGA file', 'error');
    });
  }
}

function resetModule(module) {
  state.files[module] = null;
  const prefix = module === 'svga-webp' ? 'svga' : 'video';
  const zoneId = module === 'svga-webp' ? 'svga-upload-zone' : 'video-upload-zone';
  const btnId = module === 'svga-webp' ? 'svga-convert-btn' : 'video-convert-btn';
  const newBtnId = module === 'svga-webp' ? 'svga-new-btn' : 'video-new-btn';
  const resultId = module === 'svga-webp' ? 'svga-result' : 'video-result';

  const zone = document.getElementById(zoneId);
  const btn = document.getElementById(btnId);
  const newBtn = document.getElementById(newBtnId);
  const result = document.getElementById(resultId);

  zone.classList.remove('has-file');
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

  btn.disabled = true;
  if (newBtn) newBtn.style.display = 'none';
  result.style.display = 'none';
  
  if (module === 'svga-webp') {
    const previewBox = document.getElementById('svga-upload-preview');
    if (previewBox) previewBox.style.display = 'none';
    if (svgaPlayer) svgaPlayer.stopAnimation();
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
      // Auto-trigger if we have a file
      const module = state.currentPage === 'svga-webp' ? 'svga-webp' : 'video-svga';
      if (state.files[module]) startConversion(module);
    }
  }
  const bgOpt = e.target.closest('.bg-option');
  if (bgOpt) {
    bgOpt.closest('.bg-options').querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
    bgOpt.classList.add('selected');
    const radio = bgOpt.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
      if (state.files['video-svga']) startConversion('video-svga');
    }
  }
  const fmtOpt = e.target.closest('.format-option');
  if (fmtOpt) {
    const group = fmtOpt.closest('.format-options');
    if (group) {
      group.querySelectorAll('.format-option').forEach(o => o.classList.remove('selected'));
      fmtOpt.classList.add('selected');
      const radio = fmtOpt.querySelector('input[type="radio"]');
      if (radio) {
        radio.checked = true;
        if (state.files['svga-webp']) startConversion('svga-webp');
      }
    } else {
      // PNG Editor format options
      fmtOpt.closest('.export-format').querySelectorAll('.format-option').forEach(o => o.classList.remove('selected'));
      fmtOpt.classList.add('selected');
    }
  }
});

// ===== CONVERSION =====
let conversionTimeout = null;

async function startConversion(module) {
  // Debounce to prevent multiple rapid triggers
  if (conversionTimeout) clearTimeout(conversionTimeout);
  
  conversionTimeout = setTimeout(async () => {
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
      const formData = new FormData();
      formData.append('file', file);
      formData.append('sizeTier', sizeTier);

      if (module === 'svga-webp') {
        const formatRadio = document.querySelector('input[name="svga-format"]:checked');
        formData.append('format', formatRadio ? formatRadio.value : 'webp');
      }

      if (module === 'video-svga') {
        const bgRadio = document.querySelector('input[name="video-bg"]:checked');
        formData.append('bgColor', bgRadio ? bgRadio.value : 'white');
        formData.append('similarity', document.getElementById('tolerance-slider').value);
      }

      progressBar.style.width = '30%';
      progressStep.textContent = 'Uploading & Processing...';

      const endpoint = module === 'svga-webp' ? '/api/convert/svga' : '/api/convert/video-svga';
      const res = await fetch(endpoint, { method: 'POST', body: formData });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(errData.error || 'Conversion failed');
      }
      
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Conversion failed');

      progressBar.style.width = '100%';
      progressStep.textContent = 'Complete!';

      // Show result
      setTimeout(async () => {
        progressSection.style.display = 'none';
        resultContent.style.display = 'block';
        if (statusEl) statusEl.style.display = 'none';

        const infoEl = document.getElementById(`${prefix}-result-info`);
        infoEl.innerHTML = `
          <strong>✅ Conversion Complete</strong><br>
          File: ${data.filename}<br>
          Size: ${data.sizeMB} MB<br>
          ${data.framesProcessed ? `Frames: ${data.framesProcessed}` : ''}
        `;

        // Preview for WebP/GIF or JSON
        const preview = document.getElementById('svga-preview');
        const jsonViewer = document.getElementById('svga-json-viewer');
        const jsonContent = document.getElementById('svga-json-content');
        const formatRadio = document.querySelector('input[name="svga-format"]:checked');
        const format = formatRadio ? formatRadio.value : 'webp';

        if (module === 'svga-webp' && format === 'json') {
          preview.style.display = 'none';
          jsonViewer.style.display = 'block';
          
          // Fetch the actual JSON to display it
          try {
            const jsonRes = await fetch(`/api/download/${data.jobId}`);
            const jsonData = await jsonRes.json();
            jsonContent.textContent = JSON.stringify(jsonData, null, 2);
          } catch (e) {
            jsonContent.textContent = 'Error loading JSON preview';
          }
        } else if (module === 'svga-webp') {
          preview.style.display = 'block';
          jsonViewer.style.display = 'none';
          preview.innerHTML = `<img src="/api/download/${data.jobId}?t=${Date.now()}" alt="Preview" style="max-height:300px; width:auto; display:block; margin:0 auto;">`;
        }

        // Download button
        const dlBtn = document.getElementById(`${prefix}-download-btn`);
        dlBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = `/api/download/${data.jobId}`;
          a.download = data.filename;
          a.click();
          showToast('Download started!', 'success');
        };

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
  }, 300); // 300ms debounce
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
