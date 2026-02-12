#!/usr/bin/env node
/**
 * Loki Mode HTTP API Server (v1.2.0) - LEGACY
 * NOTE: The production API is now the unified FastAPI server at dashboard/server.py (port 57374)
 * This file is kept for backward compatibility only.
 * Zero npm dependencies - uses only Node.js built-ins
 *
 * Usage:
 *   node autonomy/api-server.js [--port 57374]
 *   LOKI_DASHBOARD_PORT=57374 node autonomy/api-server.js
 *   loki api start
 *
 * Endpoints:
 *   GET  /health              - Health check
 *   GET  /status              - Session status
 *   GET  /events              - SSE stream
 *   GET  /logs                - Recent log lines
 *   POST /start               - Start session
 *   POST /stop                - Stop session
 *   POST /pause               - Pause session
 *   POST /resume              - Resume session
 *   GET  /memory              - Cross-project learnings summary
 *   GET  /memory/:type        - Get learnings (patterns|mistakes|successes)
 *   GET  /memory/search?q=    - Search learnings
 *   GET  /memory/stats        - Statistics by project/category
 *   DELETE /memory/:type      - Clear specific learning type
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Validate port number is in valid range
function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    let port = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' || args[i] === '-p') {
            // Ensure next argument exists and is a number
            if (i + 1 < args.length) {
                const val = parseInt(args[i + 1], 10);
                if (isValidPort(val)) {
                    port = val;
                }
                i++; // Skip the value
            }
        } else if (args[i].startsWith('--port=')) {
            const val = parseInt(args[i].split('=')[1], 10);
            if (isValidPort(val)) {
                port = val;
            }
        } else if (/^\d+$/.test(args[i])) {
            // Bare number as port (backwards compatible)
            const val = parseInt(args[i], 10);
            if (isValidPort(val)) {
                port = val;
            }
        }
    }

    return { port };
}

const cliArgs = parseArgs();

// Configuration
const PORT = cliArgs.port || parseInt(process.env.LOKI_DASHBOARD_PORT || '57374');
const MAX_BODY_SIZE = parseInt(process.env.LOKI_API_MAX_BODY || '1048576'); // 1MB default
const LOKI_DIR = process.env.LOKI_DIR || path.join(process.cwd(), '.loki');
const STATE_DIR = path.join(LOKI_DIR, 'state');
const LOG_DIR = path.join(LOKI_DIR, 'logs');

// Find skill directory
function findSkillDir() {
    const candidates = [
        path.join(process.env.HOME || '', '.claude/skills/loki-mode'),
        path.dirname(__dirname),
        process.cwd()
    ];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'SKILL.md')) &&
            fs.existsSync(path.join(dir, 'autonomy/run.sh'))) {
            return dir;
        }
    }
    return process.cwd();
}

const SKILL_DIR = findSkillDir();
const RUN_SH = path.join(SKILL_DIR, 'autonomy', 'run.sh');

// Ensure directories exist
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

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
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Utility: get version
function getVersion() {
    const versionFile = path.join(SKILL_DIR, 'VERSION');
    return readFile(versionFile) || 'unknown';
}

// Get current status
function getStatus() {
    const pidFile = path.join(LOKI_DIR, 'loki.pid');
    const statusFile = path.join(LOKI_DIR, 'STATUS.txt');
    const pauseFile = path.join(LOKI_DIR, 'PAUSE');
    const stopFile = path.join(LOKI_DIR, 'STOP');

    const pidStr = readFile(pidFile);
    const pid = pidStr ? parseInt(pidStr) : null;
    const running = isRunning(pid);

    let state = 'stopped';
    if (running) {
        if (fs.existsSync(pauseFile)) {
            state = 'paused';
        } else if (fs.existsSync(stopFile)) {
            state = 'stopping';
        } else {
            state = 'running';
        }
    }

    // Read status text
    const statusText = readFile(statusFile);

    // Read orchestrator state if available
    let currentPhase = '';
    let currentTask = '';
    const orchFile = path.join(STATE_DIR, 'orchestrator.json');
    if (fs.existsSync(orchFile)) {
        try {
            const orch = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
            currentPhase = orch.currentPhase || '';
            currentTask = orch.currentTask || '';
        } catch {
            // ignore parse errors
        }
    }

    // Read queue stats
    let pendingTasks = 0;
    const queueFile = path.join(LOKI_DIR, 'queue', 'pending.json');
    if (fs.existsSync(queueFile)) {
        try {
            const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
            pendingTasks = queue.tasks?.length || 0;
        } catch {
            // ignore
        }
    }

    return {
        state,
        pid,
        statusText,
        currentPhase,
        currentTask,
        pendingTasks,
        provider: readFile(path.join(STATE_DIR, 'provider')) || 'claude',
        version: getVersion(),
        lokiDir: LOKI_DIR,
        timestamp: new Date().toISOString()
    };
}

// Broadcast to SSE clients
function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(message);
        } catch {
            sseClients.delete(client);
        }
    }
}

// Parse JSON body with size limit
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            body += chunk;
        });

        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                resolve({});
            }
        });

        req.on('error', () => resolve({}));
    });
}

// Request handler
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
        return json({ status: 'ok', version: getVersion() });
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

        // Send initial status
        res.write(`data: ${JSON.stringify(getStatus())}\n\n`);

        sseClients.add(res);

        // Periodic updates every 2 seconds
        const interval = setInterval(() => {
            try {
                res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
            } catch {
                clearInterval(interval);
                sseClients.delete(res);
            }
        }, 2000);

        // Clean up on close, error, or finish
        const cleanup = () => {
            clearInterval(interval);
            sseClients.delete(res);
        };

        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
        res.on('finish', cleanup);
        return;
    }

    if (method === 'GET' && pathname === '/logs') {
        let lines = parseInt(url.searchParams.get('lines'), 10);
        // Validate lines: must be positive, default to 50, cap at 10000
        if (!Number.isInteger(lines) || lines < 1) {
            lines = 50;
        } else if (lines > 10000) {
            lines = 10000;
        }
        const logFile = path.join(LOG_DIR, 'session.log');

        if (!fs.existsSync(logFile)) {
            return json({ logs: [], total: 0 });
        }

        const content = fs.readFileSync(logFile, 'utf8');
        const allLines = content.trim().split('\n').filter(l => l);
        const logs = allLines.slice(-lines);
        return json({ logs, total: allLines.length });
    }

    if (method === 'POST' && pathname === '/start') {
        let body;
        try {
            body = await parseBody(req);
        } catch (err) {
            return json({ error: err.message }, 413);
        }
        const prd = body.prd || '';
        const provider = body.provider || 'claude';
        const parallel = body.parallel || false;
        const background = body.background !== false; // default true for API

        // Check if already running
        const status = getStatus();
        if (status.state === 'running') {
            return json({ error: 'Session already running', pid: status.pid }, 409);
        }

        if (!fs.existsSync(RUN_SH)) {
            return json({ error: 'run.sh not found', path: RUN_SH }, 500);
        }

        // Build arguments
        const args = ['--provider', provider];
        if (parallel) args.push('--parallel');
        if (background) args.push('--bg');
        if (prd) args.push(prd);

        const child = spawn(RUN_SH, args, {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd()
        });
        child.unref();

        // Save provider for status
        fs.writeFileSync(path.join(STATE_DIR, 'provider'), provider);

        // Broadcast update
        setTimeout(() => broadcast('status', getStatus()), 500);

        return json({
            started: true,
            pid: child.pid,
            provider,
            args
        });
    }

    if (method === 'POST' && pathname === '/stop') {
        const stopFile = path.join(LOKI_DIR, 'STOP');
        const pidFile = path.join(LOKI_DIR, 'loki.pid');

        // Touch STOP file (signals graceful shutdown)
        fs.writeFileSync(stopFile, new Date().toISOString());

        // Also try to kill process directly
        const pidStr = readFile(pidFile);
        if (pidStr) {
            const pid = parseInt(pidStr);
            if (isRunning(pid)) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {
                    // ignore
                }
            }
        }

        broadcast('status', getStatus());
        return json({ stopped: true });
    }

    if (method === 'POST' && pathname === '/pause') {
        const pauseFile = path.join(LOKI_DIR, 'PAUSE');
        fs.writeFileSync(pauseFile, new Date().toISOString());
        broadcast('status', getStatus());
        return json({ paused: true });
    }

    if (method === 'POST' && pathname === '/resume') {
        const pauseFile = path.join(LOKI_DIR, 'PAUSE');
        const stopFile = path.join(LOKI_DIR, 'STOP');

        try { fs.unlinkSync(pauseFile); } catch {}
        try { fs.unlinkSync(stopFile); } catch {}

        broadcast('status', getStatus());
        return json({ resumed: true });
    }

    // === Memory/Learnings endpoints ===
    const LEARNINGS_DIR = path.join(process.env.HOME || '', '.loki', 'learnings');

    if (method === 'GET' && pathname === '/memory') {
        // List summary of all learnings
        const result = { patterns: 0, mistakes: 0, successes: 0, location: LEARNINGS_DIR };

        for (const type of ['patterns', 'mistakes', 'successes']) {
            const filepath = path.join(LEARNINGS_DIR, `${type}.jsonl`);
            if (fs.existsSync(filepath)) {
                const content = fs.readFileSync(filepath, 'utf8');
                const count = (content.match(/"description"/g) || []).length;
                result[type] = count;
            }
        }
        return json(result);
    }

    if (method === 'GET' && pathname.startsWith('/memory/search')) {
        const query = url.searchParams.get('q') || '';
        if (!query) {
            return json({ error: 'Missing query parameter ?q=' }, 400);
        }

        const results = [];
        const queryLower = query.toLowerCase();

        for (const type of ['patterns', 'mistakes', 'successes']) {
            const filepath = path.join(LEARNINGS_DIR, `${type}.jsonl`);
            if (!fs.existsSync(filepath)) continue;

            const lines = fs.readFileSync(filepath, 'utf8').split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.description && entry.description.toLowerCase().includes(queryLower)) {
                        results.push({ type, ...entry });
                    }
                } catch {}
            }
        }
        return json({ query, results, count: results.length });
    }

    if (method === 'GET' && pathname.match(/^\/memory\/(patterns|mistakes|successes)$/)) {
        const type = pathname.split('/')[2];
        const filepath = path.join(LEARNINGS_DIR, `${type}.jsonl`);
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const offset = parseInt(url.searchParams.get('offset')) || 0;

        if (!fs.existsSync(filepath)) {
            return json({ type, entries: [], total: 0 });
        }

        const entries = [];
        const lines = fs.readFileSync(filepath, 'utf8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.description) {
                    entries.push(entry);
                }
            } catch {}
        }

        const total = entries.length;
        const paginated = entries.slice(offset, offset + limit);

        return json({ type, entries: paginated, total, limit, offset });
    }

    if (method === 'GET' && pathname === '/memory/stats') {
        const stats = { byCategory: {}, byProject: {} };

        for (const type of ['patterns', 'mistakes', 'successes']) {
            const filepath = path.join(LEARNINGS_DIR, `${type}.jsonl`);
            if (!fs.existsSync(filepath)) continue;

            const lines = fs.readFileSync(filepath, 'utf8').split('\n');
            let count = 0;
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.description) {
                        count++;
                        const proj = entry.project || 'unknown';
                        stats.byProject[proj] = (stats.byProject[proj] || 0) + 1;
                    }
                } catch {}
            }
            stats.byCategory[type] = count;
        }
        return json(stats);
    }

    if (method === 'DELETE' && pathname.match(/^\/memory\/(patterns|mistakes|successes)$/)) {
        const type = pathname.split('/')[2];
        const filepath = path.join(LEARNINGS_DIR, `${type}.jsonl`);

        fs.mkdirSync(LEARNINGS_DIR, { recursive: true });
        const header = JSON.stringify({ version: '1.0', created: new Date().toISOString() });
        fs.writeFileSync(filepath, header + '\n');

        return json({ cleared: type });
    }

    // 404 for unknown routes
    json({ error: 'not found', path: pathname }, 404);
}

// Start server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log(`Loki Mode API v${getVersion()}`);
    console.log(`Listening on http://localhost:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health           - Health check');
    console.log('  GET  /status           - Session status');
    console.log('  GET  /events           - SSE stream (real-time updates)');
    console.log('  GET  /logs             - Recent log lines (?lines=50)');
    console.log('  POST /start            - Start session');
    console.log('  POST /stop             - Stop session');
    console.log('  POST /pause            - Pause after current task');
    console.log('  POST /resume           - Resume paused session');
    console.log('  GET  /memory           - Cross-project learnings summary');
    console.log('  GET  /memory/:type     - Get learnings by type');
    console.log('  GET  /memory/search?q= - Search learnings');
    console.log('  GET  /memory/stats     - Statistics');
    console.log('');
    console.log(`LOKI_DIR: ${LOKI_DIR}`);
    console.log(`SKILL_DIR: ${SKILL_DIR}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
});
