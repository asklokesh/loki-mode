#!/usr/bin/env node
/**
 * Minimal HTTP API for loki-mode
 * Zero npm dependencies - uses only Node.js built-ins
 * Usage: node api-examples/node-api.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.LOKI_DASHBOARD_PORT || 57374;
const LOKI_DIR = process.env.LOKI_DIR || path.join(process.env.HOME, '.loki');
const STATE_DIR = path.join(LOKI_DIR, 'state');

// Ensure state directory exists
fs.mkdirSync(STATE_DIR, { recursive: true });

// SSE clients for real-time updates
const sseClients = new Set();

// Utility: read file safely
function readFile(filepath) {
    try {
        return fs.readFileSync(filepath, 'utf8').trim();
    } catch {
        return '';
    }
}

// Utility: check if process is running
function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Get current status
function getStatus() {
    const pidFile = path.join(STATE_DIR, 'session.pid');
    const pid = readFile(pidFile);
    let state = 'stopped';

    if (pid && isRunning(parseInt(pid))) {
        state = fs.existsSync(path.join(STATE_DIR, 'paused')) ? 'paused' : 'running';
    }

    return {
        state,
        project: readFile(path.join(STATE_DIR, 'current_project')),
        task: readFile(path.join(STATE_DIR, 'current_task')),
        provider: readFile(path.join(STATE_DIR, 'provider')) || 'claude',
        timestamp: new Date().toISOString()
    };
}

// Broadcast to SSE clients
function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        client.write(message);
    }
}

// Parse JSON body
function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                resolve({});
            }
        });
    });
}

// Request handler
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // JSON response helper
    const json = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };

    // Routes
    if (method === 'GET' && pathname === '/health') {
        return json({ status: 'ok' });
    }

    if (method === 'GET' && pathname === '/status') {
        return json(getStatus());
    }

    if (method === 'GET' && pathname === '/events') {
        // Server-Sent Events
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    if (method === 'POST' && pathname === '/start') {
        const body = await parseBody(req);
        const prd = body.prd || '';
        const provider = body.provider || 'claude';

        const runScript = path.join(process.cwd(), 'autonomy', 'run.sh');
        if (!fs.existsSync(runScript)) {
            return json({ error: 'run.sh not found' }, 500);
        }

        const args = ['--provider', provider];
        if (prd) args.push(prd);

        const child = spawn(runScript, args, {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();

        fs.writeFileSync(path.join(STATE_DIR, 'session.pid'), String(child.pid));
        fs.writeFileSync(path.join(STATE_DIR, 'provider'), provider);

        broadcast('status', { state: 'running', provider });
        return json({ started: true, pid: child.pid });
    }

    if (method === 'POST' && pathname === '/stop') {
        const pidFile = path.join(STATE_DIR, 'session.pid');
        const pid = readFile(pidFile);

        if (pid && isRunning(parseInt(pid))) {
            process.kill(parseInt(pid), 'SIGTERM');
            broadcast('status', { state: 'stopped' });
            return json({ stopped: true });
        }
        return json({ error: 'no session running' }, 404);
    }

    if (method === 'POST' && pathname === '/pause') {
        fs.writeFileSync(path.join(STATE_DIR, 'paused'), '1');
        broadcast('status', getStatus());
        return json({ paused: true });
    }

    if (method === 'POST' && pathname === '/resume') {
        try {
            fs.unlinkSync(path.join(STATE_DIR, 'paused'));
        } catch {}
        broadcast('status', getStatus());
        return json({ resumed: true });
    }

    if (method === 'GET' && pathname === '/logs') {
        const lines = parseInt(url.searchParams.get('lines')) || 50;
        const logFile = path.join(LOKI_DIR, 'logs', 'session.log');

        if (!fs.existsSync(logFile)) {
            return json({ logs: [] });
        }

        const content = fs.readFileSync(logFile, 'utf8');
        const allLines = content.trim().split('\n');
        const logs = allLines.slice(-lines);
        return json({ logs });
    }

    json({ error: 'not found' }, 404);
}

// Start server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log(`Loki API listening on http://localhost:${PORT}`);
    console.log('Endpoints:');
    console.log('  GET  /health  - Health check');
    console.log('  GET  /status  - Current status');
    console.log('  GET  /events  - SSE stream');
    console.log('  GET  /logs    - Recent logs');
    console.log('  POST /start   - Start session');
    console.log('  POST /stop    - Stop session');
    console.log('  POST /pause   - Pause session');
    console.log('  POST /resume  - Resume session');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
