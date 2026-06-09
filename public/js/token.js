// Token logic for AnimSuite Pro
document.addEventListener('DOMContentLoaded', () => {
  checkToken();
});

const getToken = () => localStorage.getItem('aspro_token');
const setToken = (token) => localStorage.setItem('aspro_token', token);
const clearToken = () => localStorage.removeItem('aspro_token');

async function checkToken() {
  const token = getToken();
  if (!token) {
    showLockScreen();
    return;
  }

  // Verify token silently
  try {
    const res = await fetch('/api/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    
    if (data.valid) {
      unlockScreen();
    } else {
      clearToken();
      showLockScreen();
    }
  } catch (err) {
    console.error('Token verification error:', err);
    showLockScreen();
  }
}

async function verifyAccessToken() {
  const input = document.getElementById('access-token-input');
  const errorDiv = document.getElementById('token-error');
  const btn = document.getElementById('verify-token-btn');
  const token = input.value.trim();

  if (!token) {
    errorDiv.textContent = 'Please enter a token';
    return;
  }

  errorDiv.textContent = '';
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const res = await fetch('/api/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();

    if (data.valid) {
      setToken(token);
      unlockScreen();
    } else {
      errorDiv.textContent = data.error || 'Invalid Token';
    }
  } catch (err) {
    errorDiv.textContent = 'Connection Error. Try again.';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function showLockScreen() {
  document.getElementById('token-lock-overlay').classList.remove('hidden');
  document.getElementById('app-wrapper').classList.add('blur-content');
}

function unlockScreen() {
  document.getElementById('token-lock-overlay').classList.add('hidden');
  document.getElementById('app-wrapper').classList.remove('blur-content');
  
  // Re-check system status once unlocked
  if (typeof checkSystemStatus === 'function') {
    checkSystemStatus();
  }
}

// Intercept fetch to add Authorization header
const originalFetch = window.fetch;
window.fetch = async function () {
  let [resource, config] = arguments;
  
  if (typeof resource === 'string' && resource.startsWith('/api') && resource !== '/api/verify-token' && !resource.startsWith('/api/admin')) {
    const token = getToken();
    if (token) {
      config = config || {};
      config.headers = config.headers || {};
      
      // Handle Headers object vs plain object
      if (config.headers instanceof Headers) {
        config.headers.append('Authorization', `Bearer ${token}`);
      } else {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    } else {
      // If no token and trying to call API, throw error or show lock
      showLockScreen();
      return Promise.reject(new Error("No access token"));
    }
  }
  
  const response = await originalFetch(resource, config);
  
  // If backend rejects token mid-session, lock immediately
  if (response.status === 401 || response.status === 403) {
    if (typeof resource === 'string' && resource.startsWith('/api') && resource !== '/api/verify-token' && !resource.startsWith('/api/admin')) {
      clearToken();
      showLockScreen();
    }
  }
  
  return response;
};
