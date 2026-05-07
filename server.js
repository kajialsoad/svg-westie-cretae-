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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
const convertRoutes = require('./routes/convert');
app.use('/api', convertRoutes);

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
