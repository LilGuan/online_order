const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

function checkPort(port) {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', error => reject(new Error(`Port ${port} is unavailable (${error.code}). Close the existing service or choose another PORT in .env.`)));
        probe.listen(port, () => probe.close(resolve));
    });
}

function checkReady(port) {
    return new Promise(resolve => {
        const request = http.get({ hostname: 'localhost', port, path: '/api/menu', timeout: 2000 }, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(false));
    });
}

async function start() {
    if (process.platform !== 'win32') throw new Error('This launcher is for Windows. On macOS use npm run watch:tunnel.');
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT in .env.');
    const cloudflared = process.env.CLOUDFLARED_BIN || 'cloudflared';
    const config = process.env.CLOUDFLARED_CONFIG || path.join(os.homedir(), '.cloudflared', 'config.yml');
    const tunnelName = process.env.CLOUDFLARE_TUNNEL_NAME || 'online-order';
    if (!fs.existsSync(config)) throw new Error(`Missing Cloudflare Named Tunnel configuration: ${config}. See WINDOWS-START.md.`);
    const validation = spawnSync(cloudflared, ['--config', config, 'tunnel', 'ingress', 'validate'], {
        cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 15000
    });
    if (validation.error) throw new Error(`Cloudflare configuration check failed: ${validation.error.message}`);
    if (validation.status !== 0) throw new Error('Invalid Cloudflare configuration. See the diagnostics above.');
    await checkPort(port);

    const children = new Set();
    let stopping = false;
    function stop(exitCode) {
        if (stopping) return;
        stopping = true;
        process.exitCode = exitCode;
        for (const child of children) child.kill();
    }
    function launch(binary, args, label) {
        const child = spawn(binary, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
        children.add(child);
        child.on('error', error => {
            console.error(`${label} failed: ${error.message}`);
            children.delete(child);
            stop(1);
        });
        child.on('exit', code => {
            children.delete(child);
            if (!stopping) {
                console.error(`${label} stopped (exit ${code}). Startup has stopped.`);
                stop(1);
            }
        });
        return child;
    }
    process.on('SIGINT', () => stop(0));
    process.on('SIGTERM', () => stop(0));
    launch(process.execPath, [path.join(ROOT, 'server.js')], 'Order server');
    try {
        const deadline = Date.now() + 120000;
        while (!stopping && Date.now() < deadline) {
            if (await checkReady(port)) break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (stopping) return;
        if (!await checkReady(port)) throw new Error('Order server did not become ready within 120 seconds.');
        launch(cloudflared, ['--config', config, 'tunnel', 'run', tunnelName], 'Cloudflare Tunnel');
        console.log(`Local admin: http://localhost:${port}/merchant.html`);
        console.log('Keep this window open. Press Ctrl+C to stop the services started here.');
    } catch (error) {
        console.error(error.message);
        stop(1);
    }
}

if (require.main === module) start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});

module.exports = { checkPort, checkReady };
