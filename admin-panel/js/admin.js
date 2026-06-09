let adminSecret = localStorage.getItem('aspro_admin_secret') || '';

document.addEventListener('DOMContentLoaded', () => {
  if (adminSecret) {
    showAdminPanel();
  }
});

function loginAdmin() {
  const secret = document.getElementById('admin-secret').value;
  if (!secret) return;
  adminSecret = secret;
  localStorage.setItem('aspro_admin_secret', secret);
  showAdminPanel();
}

function logoutAdmin() {
  adminSecret = '';
  localStorage.removeItem('aspro_admin_secret');
  document.getElementById('admin-content').classList.add('hidden');
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('admin-secret').value = '';
}

async function showAdminPanel() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('admin-content').classList.remove('hidden');
  await loadTokens();
}

async function adminFetch(path, options = {}) {
  options.headers = {
    ...options.headers,
    'x-admin-secret': adminSecret,
    'Content-Type': 'application/json'
  };
  const res = await fetch(`${API_BASE_URL}${path}`, options);
  if (res.status === 401) {
    document.getElementById('login-error').textContent = 'Invalid Admin Secret';
    logoutAdmin();
    throw new Error('Unauthorized');
  }
  return res.json();
}

async function loadTokens() {
  try {
    const data = await adminFetch('/api/admin/tokens');
    const tbody = document.getElementById('tokens-list');
    tbody.innerHTML = '';
    
    data.tokens.forEach(token => {
      const daysLeft = token.expiresAt 
        ? Math.max(0, Math.ceil((new Date(token.expiresAt) - new Date()) / (1000 * 60 * 60 * 24))) 
        : '∞';
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family: monospace; font-size: 14px;">${token.token}</td>
        <td><span class="badge ${token.status}">${token.status.toUpperCase()}</span></td>
        <td>${new Date(token.createdAt).toLocaleDateString()}</td>
        <td>${token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : 'Never'}</td>
        <td style="font-weight: 600; color: ${daysLeft < 5 ? 'var(--danger)' : 'var(--success)'}">${daysLeft}</td>
        <td>
          <div style="display: flex; gap: 5px;">
            ${token.status === 'active' 
              ? `<button onclick="updateStatus('${token.id}', 'disabled')" style="background: var(--text-muted); padding: 4px 8px; font-size: 12px;">Disable</button>` 
              : `<button onclick="updateStatus('${token.id}', 'active')" style="background: var(--success); padding: 4px 8px; font-size: 12px;">Enable</button>`}
            <button onclick="changeExpiry('${token.id}')" style="background: var(--accent); padding: 4px 8px; font-size: 12px;">+ Time</button>
            <button class="danger" onclick="deleteToken('${token.id}')" style="padding: 4px 8px; font-size: 12px;">Revoke</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

async function changeExpiry(id) {
  const days = prompt('Enter additional days to add (or new total days from now):', '30');
  if (days === null) return;
  try {
    await adminFetch(`/api/admin/tokens/${id}/expiry`, {
      method: 'PATCH',
      body: JSON.stringify({ expiryDays: parseInt(days) })
    });
    loadTokens();
  } catch (err) {
    alert('Failed to update expiry');
  }
}

async function generateToken() {
  const days = document.getElementById('expiry-days').value;
  try {
    await adminFetch('/api/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({ expiryDays: parseInt(days) })
    });
    loadTokens();
  } catch (err) {
    alert('Failed to generate token');
  }
}

async function updateStatus(id, status) {
  try {
    await adminFetch(`/api/admin/tokens/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    loadTokens();
  } catch (err) {
    alert('Failed to update status');
  }
}

async function deleteToken(id) {
  if (!confirm('Are you sure you want to completely revoke and delete this token?')) return;
  try {
    await adminFetch(`/api/admin/tokens/${id}`, {
      method: 'DELETE'
    });
    loadTokens();
  } catch (err) {
    alert('Failed to delete token');
  }
}
