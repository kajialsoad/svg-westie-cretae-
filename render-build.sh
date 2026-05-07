#!/usr/bin/env bash
# Render.com build script with FFmpeg

set -e

echo "📦 Installing Node dependencies..."
npm install

echo "🎬 Installing FFmpeg..."
apt-get update
apt-get install -y ffmpeg

echo "✅ Build complete!"
