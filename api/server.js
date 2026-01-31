#!/usr/bin/env node
/**
 * Loki Mode HTTP/SSE API Server
 *
 * Provides REST API and Server-Sent Events for loki-mode integration.
 * Zero npm dependencies - uses only Node.js built-in modules.
 *
 * Usage:
 *   node api/server.js [--port 3000] [--host 127.0.0.1]
 *   loki serve [--port 3000]
 *
 * Endpoints:
 *   GET  /health  - Liveness check
 *   GET  /status  - Current session state + metrics
 *   GET  /events  - SSE stream of real-time events
 *   GET  /logs    - Recent log entries (?lines=100)
 *   POST /start   - Start new session {"prd":"path","provider":"claude"}
 *   POST /stop    - Graceful stop
 *   POST /pause   - Pause execution
 *   POST /resume  - Resume execution
 *   POST /input   - Inject human input {"input":"directive text"}
 *
 * @version 1.0.0
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

//=============================================================================
// Configuration
//=============================================================================

const DEFAULT_PORT = 9898;
const DEFAULT_HOST = '127.0.0.1';
const PROJECT_DIR = process.env.LOKI_PROJECT_DIR || process.cwd();

// Security constants
const VALID_PROVIDERS = ['claude', 'codex', 'gemini'];
const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit
const MAX_LOG_LINES = 1000;
const LOKI_DIR = path.join(PROJECT_DIR, '.loki');

// Parse CLI args
const args = process.argv.slice(2);
let PORT = DEFAULT_PORT;
let HOST = DEFAULT_HOST;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) PORT = parseInt(args[i + 1], 10);
  if (args[i] === '--host' && args[i + 1]) HOST = args[i + 1];
}

//=============================================================================
// Event Bus (SSE Broadcasting)
//=============================================================================

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this.eventBuffer = [];
    this.bufferSize = 100;
    this.eventId = 0;
  }

  addClient(res) {
    this.clients.add(res);
    // Send buffered events to new client
    for (const event of this.eventBuffer) {
      this.sendToClient(res, event);
    }
    return () => this.clients.delete(res);
  }

  broadcast(type, data) {
    const event = {
      id: `evt_${++this.eventId}`,
      type,
      timestamp: new Date().toISOString(),
      data
    };

    // Buffer for late joiners
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.bufferSize) {
      this.eventBuffer.shift();
    }

    // Broadcast to all clients
    for (const client of this.clients) {
      this.sendToClient(client, event);
    }

    this.emit('event', event);
  }

  sendToClient(res, event) {
    try {
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (e) {
      this.clients.delete(res);
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.broadcast('heartbeat', { time: Date.now() });
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  cleanup() {
    this.stopHeartbeat();
    // Close all SSE clients
    for (const client of this.clients) {
      try {
        client.end();
      } catch (e) {
        // Client may already be closed
      }
    }
    this.clients.clear();
  }
}

const eventBus = new EventBus();

//=============================================================================
// Process Manager (run.sh lifecycle)
//=============================================================================

class ProcessManager {
  constructor() {
    this.process = null;
    this.status = 'idle'; // idle, starting, running, paused, stopping, completed, failed
    this.startedAt = null;
    this.prdPath = null;
    this.provider = null;
    this.fileWatcher = null;
    this.lastDashboardState = null;
  }

  async start(options = {}) {
    // Check for any active session (running, starting, or paused)
    if (this.status === 'running' || this.status === 'starting' || this.status === 'paused') {
      throw new Error('Session already running');
    }

    const { prd, provider = 'claude' } = options;

    // Validate provider (security: prevent command injection)
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`Invalid provider: ${provider}. Must be one of: ${VALID_PROVIDERS.join(', ')}`);
    }

    // Validate PRD path (security: prevent path traversal)
    if (prd) {
      const normalizedPrd = path.normalize(prd);
      if (normalizedPrd.includes('..') || path.isAbsolute(normalizedPrd) && !normalizedPrd.startsWith(PROJECT_DIR)) {
        throw new Error('Invalid PRD path: path traversal not allowed');
      }
    }
    this.prdPath = prd;
    this.provider = provider;
    this.status = 'starting';
    this.startedAt = new Date().toISOString();

    // Build command
    const runScript = path.join(PROJECT_DIR, 'autonomy', 'run.sh');
    const args = [];
    if (provider && provider !== 'claude') {
      args.push('--provider', provider);
    }
    if (prd) {
      args.push(prd);
    }

    // Spawn run.sh
    this.process = spawn('bash', [runScript, ...args], {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        LOKI_API_MODE: '1',
        LOKI_NO_DASHBOARD: '1', // Don't open browser
        FORCE_COLOR: '0' // Disable ANSI colors for parsing
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.status = 'running';
    eventBus.broadcast('session:started', {
      provider: this.provider,
      prd: this.prdPath,
      pid: this.process.pid
    });

    // Parse stdout for events
    this.process.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.parseLogLine(line);
        }
      }
    });

    this.process.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          eventBus.broadcast('log:entry', { level: 'error', message: line });
        }
      }
    });

    // Handle exit
    this.process.on('exit', (code, signal) => {
      const success = code === 0;
      this.status = success ? 'completed' : 'failed';
      eventBus.broadcast(success ? 'session:completed' : 'session:failed', {
        exitCode: code,
        signal,
        duration: Date.now() - new Date(this.startedAt).getTime()
      });
      this.process = null;
      this.stopFileWatcher();
    });

    this.process.on('error', (err) => {
      this.status = 'failed';
      eventBus.broadcast('session:failed', { error: err.message });
      this.process = null;
      this.stopFileWatcher();
    });

    // Start watching .loki/ for state changes
    this.startFileWatcher();

    return { pid: this.process.pid, status: this.status };
  }

  parseLogLine(line) {
    // Strip ANSI codes
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '');

    // Detect event patterns
    if (clean.includes('Phase:') || clean.includes('PHASE:')) {
      const match = clean.match(/Phase:\s*(\w+)/i);
      if (match) {
        eventBus.broadcast('phase:changed', { phase: match[1] });
      }
    }

    if (clean.includes('Task completed') || clean.includes('TASK COMPLETE')) {
      eventBus.broadcast('task:completed', { message: clean });
    }

    if (clean.includes('Task started') || clean.includes('Starting task')) {
      eventBus.broadcast('task:started', { message: clean });
    }

    if (clean.includes('Quality gate') || clean.includes('Gate:')) {
      const passed = clean.toLowerCase().includes('pass');
      eventBus.broadcast(passed ? 'gate:passed' : 'gate:failed', { message: clean });
    }

    // Always emit as log entry
    const level = clean.includes('[ERROR]') ? 'error'
                : clean.includes('[WARN]') ? 'warn'
                : clean.includes('[DEBUG]') ? 'debug'
                : 'info';
    eventBus.broadcast('log:entry', { level, message: clean });
  }

  startFileWatcher() {
    const dashboardPath = path.join(LOKI_DIR, 'dashboard-state.json');

    // Poll for changes (more reliable than fs.watch across platforms)
    this.fileWatcher = setInterval(async () => {
      try {
        const content = await fs.promises.readFile(dashboardPath, 'utf8');
        const state = JSON.parse(content);

        if (this.lastDashboardState) {
          // Diff and emit changes
          if (state.phase !== this.lastDashboardState.phase) {
            eventBus.broadcast('phase:changed', {
              phase: state.phase,
              previous: this.lastDashboardState.phase
            });
          }
        }

        this.lastDashboardState = state;
      } catch (e) {
        // File doesn't exist yet or is being written
      }
    }, 1000);
  }

  stopFileWatcher() {
    if (this.fileWatcher) {
      clearInterval(this.fileWatcher);
      this.fileWatcher = null;
    }
  }

  async stop() {
    if (!this.process) {
      return { status: 'idle' };
    }

    this.status = 'stopping';

    // Touch STOP file for graceful shutdown
    const stopFile = path.join(LOKI_DIR, 'STOP');
    await fs.promises.writeFile(stopFile, '');

    // Wait for graceful exit (5s), then force kill
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGTERM');
        }
      }, 5000);

      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(timeout);
          this.status = 'idle';
          resolve({ status: 'stopped' });
        });
      } else {
        clearTimeout(timeout);
        resolve({ status: 'idle' });
      }
    });
  }

  async pause() {
    if (this.status !== 'running' && this.status !== 'starting') {
      throw new Error('No running session to pause');
    }

    // Ensure .loki directory exists
    await fs.promises.mkdir(LOKI_DIR, { recursive: true });

    const pauseFile = path.join(LOKI_DIR, 'PAUSE');
    await fs.promises.writeFile(pauseFile, '');
    this.status = 'paused';
    eventBus.broadcast('session:paused', {});
    return { status: 'paused' };
  }

  async resume() {
    if (this.status !== 'paused') {
      throw new Error('Session is not paused');
    }

    const pauseFile = path.join(LOKI_DIR, 'PAUSE');
    try {
      await fs.promises.unlink(pauseFile);
    } catch (e) {
      // File might not exist
    }
    this.status = 'running';
    eventBus.broadcast('session:resumed', {});
    return { status: 'running' };
  }

  async injectInput(input) {
    // Validate input
    if (typeof input !== 'string' || input.length === 0) {
      throw new Error('Input must be a non-empty string');
    }
    if (input.length > MAX_BODY_SIZE) {
      throw new Error('Input too large');
    }

    // Ensure .loki directory exists
    await fs.promises.mkdir(LOKI_DIR, { recursive: true });

    const inputFile = path.join(LOKI_DIR, 'HUMAN_INPUT.md');
    await fs.promises.writeFile(inputFile, input);
    eventBus.broadcast('input:injected', { preview: input.slice(0, 100) });
    return { status: 'injected' };
  }

  getStatus() {
    return {
      status: this.status,
      pid: this.process?.pid || null,
      provider: this.provider,
      prd: this.prdPath,
      startedAt: this.startedAt,
      uptime: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0,
      dashboard: this.lastDashboardState
    };
  }
}

const processManager = new ProcessManager();

//=============================================================================
// HTTP Request Handlers
//=============================================================================

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS headers - restrict to localhost for security
  const origin = req.headers.origin || '';
  const allowedOrigins = ['http://localhost', 'http://127.0.0.1'];
  const isAllowed = allowedOrigins.some(allowed => origin.startsWith(allowed));
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : 'http://localhost');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Route handling
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', version: '1.0.0' });
    }

    if (method === 'GET' && pathname === '/status') {
      return sendJson(res, 200, processManager.getStatus());
    }

    if (method === 'GET' && pathname === '/events') {
      return handleSSE(req, res);
    }

    if (method === 'GET' && pathname === '/logs') {
      const lines = Math.min(parseInt(url.searchParams.get('lines') || '50', 10), MAX_LOG_LINES);
      return handleLogs(res, lines);
    }

    if (method === 'POST' && pathname === '/start') {
      const body = await parseBody(req);
      const result = await processManager.start(body);
      return sendJson(res, 201, result);
    }

    if (method === 'POST' && pathname === '/stop') {
      const result = await processManager.stop();
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && pathname === '/pause') {
      const result = await processManager.pause();
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && pathname === '/resume') {
      const result = await processManager.resume();
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && pathname === '/input') {
      const body = await parseBody(req);
      if (!body.input) {
        return sendJson(res, 400, { error: 'Missing input field' });
      }
      const result = await processManager.injectInput(body.input);
      return sendJson(res, 200, result);
    }

    // 404
    sendJson(res, 404, { error: 'Not found', path: pathname });

  } catch (err) {
    console.error('Request error:', err);
    sendJson(res, err.message.includes('already running') ? 409 : 500, {
      error: err.message
    });
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial status
  res.write(`event: connected\ndata: ${JSON.stringify({ status: processManager.status })}\n\n`);

  // Register client
  const removeClient = eventBus.addClient(res);

  // Handle disconnect
  req.on('close', removeClient);
}

async function handleLogs(res, lines) {
  const logFiles = [
    path.join(LOKI_DIR, 'logs', 'session.log'),
    path.join(LOKI_DIR, 'logs', 'agent.log')
  ];

  const logs = [];
  for (const logFile of logFiles) {
    try {
      const content = await fs.promises.readFile(logFile, 'utf8');
      const fileLines = content.split('\n').filter(l => l.trim());
      logs.push(...fileLines.slice(-lines));
    } catch (e) {
      // File doesn't exist
    }
  }

  // Sort by timestamp if possible, return last N
  sendJson(res, 200, {
    lines: logs.slice(-lines),
    count: logs.length
  });
}

//=============================================================================
// Utilities
//=============================================================================

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

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
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

//=============================================================================
// Server Startup
//=============================================================================

const server = http.createServer(handleRequest);

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  eventBus.cleanup();
  processManager.stop().then(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Ensure .loki directories exist
async function ensureDirectories() {
  await fs.promises.mkdir(path.join(LOKI_DIR, 'logs'), { recursive: true });
  await fs.promises.mkdir(path.join(LOKI_DIR, 'queue'), { recursive: true });
  await fs.promises.mkdir(path.join(LOKI_DIR, 'state'), { recursive: true });
}

// Start server
ensureDirectories().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Loki API server running at http://${HOST}:${PORT}`);
    console.log(`Project directory: ${PROJECT_DIR}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health  - Health check');
    console.log('  GET  /status  - Session status');
    console.log('  GET  /events  - SSE event stream');
    console.log('  GET  /logs    - Recent logs');
    console.log('  POST /start   - Start session');
    console.log('  POST /stop    - Stop session');
    console.log('  POST /pause   - Pause session');
    console.log('  POST /resume  - Resume session');
    console.log('  POST /input   - Inject human input');
    console.log('');
    eventBus.startHeartbeat();
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});

module.exports = { server, processManager, eventBus };
