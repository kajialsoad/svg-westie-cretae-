const { Client } = require('ssh2');
const { execSync } = require('child_process');
const path = require('path');

console.log('=== Deploying AnimSuite Pro (Safe & Isolated) ===\n');

// ==============================================================================
// ⚙️ CONFIGURATION - USER SPECIFIC VALUES
// Please fill in these values to connect to your Hostinger VPS server safely.
// ==============================================================================
const SSH_CONFIG = {
    host: process.env.VPS_HOST || '161.97.81.254',       // Your Contabo VPS IP Address
    port: 22,                    // SSH Port (Default is 22)
    username: process.env.VPS_USER || 'root',            // SSH Username (typically root or ubuntu)
    password: process.env.VPS_PASSWORD,   // SSH Password, read from env var (never hardcode/commit this)
};

if (!SSH_CONFIG.password) {
    console.error('❌ Missing VPS_PASSWORD environment variable. Set it before running: $env:VPS_PASSWORD="..."');
    process.exit(1);
}

const REMOTE_ROOT = '/var/www/animsuite-pro'; // Dedicated folder on VPS
const PM2_APP_NAME = 'animsuite';             // Unique PM2 process name
const DEPLOY_BRANCH = 'main';                 // Git branch to deploy from (e.g. main/master)
// ==============================================================================

function connect() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => resolve(conn))
            .on('error', reject)
            .connect(SSH_CONFIG);
    });
}

function execRemote(conn, command, label) {
    return new Promise((resolve, reject) => {
        if (label) {
            console.log(`\n[REMOTE] 🔵 ${label}`);
        }

        conn.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let stdout = '';
            let stderr = '';

            stream.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    reject(new Error(`Remote command failed with code ${code}`));
                }
            }).on('data', (data) => {
                stdout += data.toString();
                process.stdout.write(data.toString());
            }).stderr.on('data', (data) => {
                stderr += data.toString();
                process.stderr.write(data.toString());
            });
        });
    });
}

async function main() {
    let conn;
    try {
        console.log('🔌 Connecting to VPS server...');
        conn = await connect();
        console.log('✅ Connected to server successfully.');

        // Step 1: Remote directory checks and git pull
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  STEP 1: REMOTE GIT PULL (${DEPLOY_BRANCH})`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        await execRemote(
            conn,
            [
                `cd ${REMOTE_ROOT}`,
                'git merge --abort || true',
                'git fetch origin',
                `git reset --hard origin/${DEPLOY_BRANCH}`,
                `git pull origin ${DEPLOY_BRANCH}`
            ].join(' && '),
            'Syncing code from GitHub (force updating to latest main)'
        );

        // Step 2: Install node dependencies
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  STEP 2: INSTALL NODE DEPENDENCIES');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        await execRemote(
            conn,
            `cd ${REMOTE_ROOT} && npm install --production`,
            'Installing production dependencies'
        );

        // Step 3: Restart PM2 service safely (isolated reload)
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  STEP 3: RESTART PM2 SERVICE SAFELY');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        // This only restarts/reloads the 'animsuite' app. 
        // Other PM2 processes remain completely untouched and safe.
        const pm2Command = 
            `if pm2 show ${PM2_APP_NAME} > /dev/null 2>&1; then ` +
            `  echo "Reloading existing PM2 process: ${PM2_APP_NAME}" && pm2 reload ${PM2_APP_NAME}; ` +
            `else ` +
            `  echo "Starting new PM2 process: ${PM2_APP_NAME}" && cd ${REMOTE_ROOT} && pm2 start server.js --name ${PM2_APP_NAME}; ` +
            `fi`;

        await execRemote(
            conn,
            pm2Command,
            'Safely reloading application in PM2'
        );

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  🎉 DEPLOYMENT COMPLETE SAFELY!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  ✓ App is running under PM2 process: ${PM2_APP_NAME}`);
        console.log('  ✓ No other server processes or sites were affected.');

    } catch (error) {
        console.error('\n❌ Deployment failed:', error.message);
        process.exitCode = 1;
    } finally {
        if (conn) {
            conn.end();
            console.log('\n🔌 Disconnected from server.');
        }
    }
}

main();
