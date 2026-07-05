#!/usr/bin/env bash
# AnimSuite Pro - Automated Deployment Script for VPS
# This script pulls the latest changes from GitHub, installs dependencies, and restarts the app using PM2.

# Exit immediately if a command exits with a non-zero status
set -e

# Configuration
APP_DIR="/var/www/animsuite-pro"
PM2_APP_NAME="animsuite"
BRANCH="main" # Change this if your default branch is different (e.g. master)

echo "🚀 Starting deployment for AnimSuite Pro..."

# 1. Navigate to application directory
if [ -d "$APP_DIR" ]; then
    echo "📂 Navigating to application directory: $APP_DIR"
    cd "$APP_DIR"
else
    echo "❌ Error: Application directory $APP_DIR does not exist."
    echo "Please set up the directory or update the APP_DIR path in this script."
    exit 1
fi

# 2. Fetch and pull latest changes from Git
echo "🔄 Fetching latest changes from GitHub..."
git fetch origin

echo "🔀 Pulling latest changes on branch '$BRANCH'..."
git pull origin "$BRANCH"

# 3. Install/Update Node dependencies
echo "📦 Installing production dependencies..."
npm install --production

# 4. Restart or Start application via PM2
echo "🔄 Restarting application with PM2..."
if pm2 show "$PM2_APP_NAME" > /dev/null 2>&1; then
    echo "✅ PM2 process found. Reloading app..."
    pm2 reload "$PM2_APP_NAME"
else
    echo "ℹ️ PM2 process not running. Starting new process..."
    pm2 start server.js --name "$PM2_APP_NAME"
fi

# 5. Save PM2 process list
echo "💾 Saving PM2 process list for server reboots..."
pm2 save

echo "🎉 Deployment completed successfully!"
