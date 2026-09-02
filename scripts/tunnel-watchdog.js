#!/usr/bin/env node
// Keeps server.js / merchant.html / index.html / cart.html in sync with the
// current trycloudflare.com quick-tunnel hostname, and keeps both the
// cloudflared tunnel and the node server processes alive.
//
// trycloudflare.com quick tunnels hand out a brand-new random hostname every
// time the `cloudflared` process (re)starts. This watchdog polls cloudflared's
// local metrics endpoint for the live hostname, rewrites every file that
// hardcodes it, and restarts the node server so the change takes effect —
// so nobody has to do that by hand again.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = '/tmp';
const CLOUDFLARED_LOG = path.join(LOG_DIR, 'online_order_cloudflared.log');
const NODE_LOG = path.join(LOG_DIR, 'online_order_server.log');
const METRICS_PORT = 20241;
const METRICS_URL = `http://127.0.0.1:${METRICS_PORT}/quicktunnel`;
const APP_PORT = 3000;
const POLL_INTERVAL_MS = 10000;
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

const FILES = ['server.js', 'merchant.html', 'index.html', 'cart.html', 'order-detail.html'].map(f => path.join(ROOT, f));

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

function isCloudflaredRunning() {
    // pgrep -f matches as a regex against the full command line, so this
    // matches regardless of what other flags (e.g. --metrics) precede --url.
    return pgrep(`cloudflared.*--url http://localhost:${APP_PORT}`).length > 0;
}

function isNodeServerRunning() {
    // Exclude this watchdog's own process (it also runs under `node`).
    return pgrep('node server.js').filter(pid => pid !== process.pid).length > 0;
}

function startCloudflared() {
    log('Starting cloudflared quick tunnel...');
    const out = fs.openSync(CLOUDFLARED_LOG, 'a');
    const child = spawn('cloudflared', ['tunnel', '--metrics', `127.0.0.1:${METRICS_PORT}`, '--url', `http://localhost:${APP_PORT}`], {
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

function restartNodeServer() {
    const pids = pgrep('node server.js').filter(pid => pid !== process.pid);
    if (pids.length) {
        log(`Stopping node server.js (pid ${pids.join(', ')})...`);
        for (const pid of pids) {
            try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
    }
    setTimeout(startNodeServer, 1000);
}

async function getLiveTunnelHostname() {
    try {
        const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const data = await res.json();
        return data.hostname || null;
    } catch {
        return null;
    }
}

function syncFiles(newUrl) {
    let changedAny = false;
    for (const file of FILES) {
        const content = fs.readFileSync(file, 'utf8');
        if (!URL_PATTERN.test(content)) continue;
        URL_PATTERN.lastIndex = 0;
        const updated = content.replace(URL_PATTERN, newUrl);
        if (updated !== content) {
            fs.writeFileSync(file, updated);
            log(`Updated ${path.basename(file)} -> ${newUrl}`);
            changedAny = true;
        }
    }
    return changedAny;
}

function getUrlInFiles() {
    const content = fs.readFileSync(FILES[0], 'utf8');
    const match = content.match(URL_PATTERN);
    return match ? match[0] : null;
}

async function tick() {
    if (!isCloudflaredRunning()) {
        log('cloudflared is not running.');
        startCloudflared();
        return; // give it a moment; next tick will pick up the hostname
    }

    if (!isNodeServerRunning()) {
        log('node server.js is not running.');
        startNodeServer();
    }

    const liveHostname = await getLiveTunnelHostname();
    if (!liveHostname) return; // metrics not up yet, try again next tick

    const liveUrl = `https://${liveHostname}`;
    const fileUrl = getUrlInFiles();

    if (fileUrl && fileUrl !== liveUrl) {
        log(`Tunnel URL changed: ${fileUrl} -> ${liveUrl}`);
        syncFiles(liveUrl);
        restartNodeServer();
    }
}

async function main() {
    log('Tunnel watchdog started.');
    await tick();
    setInterval(() => { tick().catch(err => log(`tick error: ${err.message}`)); }, POLL_INTERVAL_MS);
}

main();
