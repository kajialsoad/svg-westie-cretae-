/**
 * AnimSuite Pro - Main Server
 * Media Conversion & Animation Platform
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1000mb' }));
app.use(express.urlencoded({ extended: true, limit: '1000mb' }));

// Serve static frontend based on domain or MODE
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const adminDomain = process.env.ADMIN_DOMAIN || 'admin'; 
  
  // If MODE is ADMIN, we serve only the admin panel (for separate service setup)
  if (process.env.MODE === 'ADMIN') {
    return express.static(path.join(__dirname, 'admin-panel'))(req, res, next);
  }

  // If host matches admin domain, serve admin panel
  if (host.includes(adminDomain)) {
    return express.static(path.join(__dirname, 'admin-panel'))(req, res, next);
  }
  next();
});

// Default static serving for the main website
app.use(express.static(path.join(__dirname, 'public')));

const tokenManager = require('./services/tokenManager');

// Admin Auth Middleware
const adminAuthMiddleware = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== (process.env.ADMIN_SECRET || 'super-secure-admin-key-123')) {
    return res.status(401).json({ error: 'Unauthorized Admin Access' });
  }
  next();
};

// Token API routes
app.post('/api/verify-token', (req, res) => {
  const { token } = req.body;
  if (tokenManager.verifyToken(token)) {
    return res.json({ valid: true });
  }
  return res.status(403).json({ valid: false, error: 'Invalid or Expired Token' });
});

// Admin API routes
app.get('/api/admin/tokens', adminAuthMiddleware, (req, res) => {
  res.json({ tokens: tokenManager.getTokens() });
});
app.post('/api/admin/tokens', adminAuthMiddleware, (req, res) => {
  const { expiryDays } = req.body;
  const newToken = tokenManager.generateToken(expiryDays);
  res.json(newToken);
});
app.patch('/api/admin/tokens/:id/status', adminAuthMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const updated = tokenManager.updateTokenStatus(id, status);
  if (updated) return res.json(updated);
  res.status(404).json({ error: 'Token not found' });
});
app.patch('/api/admin/tokens/:id/expiry', adminAuthMiddleware, (req, res) => {
  const { id } = req.params;
  const { expiryDays } = req.body;
  const updated = tokenManager.setTokenExpiry(id, parseInt(expiryDays));
  if (updated) return res.json(updated);
  res.status(404).json({ error: 'Token not found' });
});
app.delete('/api/admin/tokens/:id', adminAuthMiddleware, (req, res) => {
  const { id } = req.params;
  tokenManager.deleteToken(id);
  res.json({ success: true });
});

// App Token Middleware
const appTokenMiddleware = (req, res, next) => {
  if (req.path === '/health' || req.path === '/api/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access Denied. Missing Token.' });
  }
  const token = authHeader.split(' ')[1];
  if (!tokenManager.verifyToken(token)) {
    return res.status(403).json({ error: 'Invalid, Expired, or Revoked Token.' });
  }
  next();
};

// API Routes
const convertRoutes = require('./routes/convert');
app.use('/api', appTokenMiddleware, convertRoutes);

// Catch-all: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       🎬 AnimSuite Pro v1.0.0            ║');
  console.log('║   Media Conversion & Animation Platform   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   🌐 http://localhost:${PORT}               ║`);
  console.log('║   📡 API: /api/health                    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
