#!/usr/bin/env node
// Fixed-hostname watchdog for the online-order local service.
//
// This intentionally does NOT start Cloudflare Quick Tunnel and does NOT rewrite
// server.js / index.html / cart.html / order-detail.html. A stable public URL
// requires a Cloudflare Named Tunnel, for example:
//   cloudflared tunnel run online-order

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const LOG_DIR = '/tmp';
const CLOUDFLARED_LOG = path.join(LOG_DIR, 'online_order_cloudflared.log');
const NODE_LOG = path.join(LOG_DIR, 'online_order_server.log');
const APP_PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = 10000;
const TUNNEL_NAME = String(process.env.CLOUDFLARE_TUNNEL_NAME || 'online-order').trim();
const TUNNEL_URL = String(process.env.TUNNEL_URL || process.env.PUBLIC_BASE_URL || 'https://order.yourdomain.com').trim();

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function pgrep(pattern) {
    try {
        const out = execSync(`pgrep -f ${JSON.stringify(pattern)}`, { encoding: 'utf8' });
        return out.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

function isNamedTunnelRunning() {
    return pgrep(`cloudflared.*tunnel.*run.*${TUNNEL_NAME}`).length > 0;
}

function hasOldQuickTunnelRunning() {
    return pgrep(`cloudflared.*--url http://localhost:${APP_PORT}`).length > 0;
}

function isNodeServerRunning() {
    return pgrep('node server.js').filter(pid => pid !== process.pid).length > 0;
}

function startNamedTunnel() {
    log(`Starting cloudflared named tunnel "${TUNNEL_NAME}" for fixed URL ${TUNNEL_URL}...`);
    const out = fs.openSync(CLOUDFLARED_LOG, 'a');
    const child = spawn('cloudflared', ['tunnel', 'run', TUNNEL_NAME], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', out, out]
    });
    child.unref();
}

function startNodeServer() {
    log('Starting node server.js...');
    const out = fs.openSync(NODE_LOG, 'a');
    const child = spawn('node', ['server.js'], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', out, out]
    });
    child.unref();
}

async function tick() {
    if (hasOldQuickTunnelRunning()) {
        log(`Old quick tunnel for localhost:${APP_PORT} is still running. Not stopping it automatically; stop it manually if it is this app.`);
    }

    if (!isNamedTunnelRunning()) {
        log(`cloudflared named tunnel "${TUNNEL_NAME}" is not running.`);
        startNamedTunnel();
    }

    if (!isNodeServerRunning()) {
        log('node server.js is not running.');
        startNodeServer();
    }
}

async function main() {
    log(`Fixed tunnel watchdog started. Tunnel name=${TUNNEL_NAME}, public URL=${TUNNEL_URL}`);
    if (TUNNEL_URL.includes('yourdomain.com')) {
        log('TUNNEL_URL is still the placeholder. Set TUNNEL_URL=https://your-real-hostname before using this in production.');
    }
    await tick();
    setInterval(() => { tick().catch(err => log(`tick error: ${err.message}`)); }, POLL_INTERVAL_MS);
}

main();
