'use strict';

/**
 * Loki Mode MCP Server
 *
 * Exposes Loki Mode capabilities as MCP tools following the MCP specification
 * (JSON-RPC 2.0 over stdio/SSE).
 *
 * Usage:
 *   node src/protocols/mcp-server.js                         # stdio mode
 *   node src/protocols/mcp-server.js --sse --port 8421       # SSE mode
 *   node src/protocols/mcp-server.js --list-tools            # list registered tools
 *
 * Supports:
 *   - JSON-RPC 2.0 protocol
 *   - Both stdio and SSE transports
 *   - OAuth 2.1 + PKCE authentication (optional)
 *   - Lazy initialization (zero overhead when not invoked)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Lazy tool/resource loading
// ---------------------------------------------------------------------------

let _tools = null;
let _resources = null;

function getTools() {
  if (_tools) return _tools;
  _tools = new Map();

  const toolModules = [
    require('./tools/start-project'),
    require('./tools/project-status'),
    require('./tools/agent-metrics'),
    require('./tools/checkpoint-restore'),
    require('./tools/quality-report')
  ];

  for (const mod of toolModules) {
    _tools.set(mod.TOOL_NAME, mod);
  }

  return _tools;
}

function getResources() {
  if (_resources) return _resources;
  _resources = new Map();

  const resourceModules = [
    require('./resources/continuity'),
    require('./resources/memory')
  ];

  for (const mod of resourceModules) {
    _resources.set(mod.RESOURCE_URI, mod);
  }

  return _resources;
}

// ---------------------------------------------------------------------------
// Auth (lazy)
// ---------------------------------------------------------------------------

let _auth = null;

function getAuth() {
  if (_auth) return _auth;
  const { OAuthValidator } = require('./auth/oauth');
  _auth = new OAuthValidator();
  return _auth;
}

// ---------------------------------------------------------------------------
// Server capability advertisement
// ---------------------------------------------------------------------------

function getServerInfo() {
  let version = 'unknown';
  try {
    const versionPath = path.resolve(__dirname, '..', '..', 'VERSION');
    if (fs.existsSync(versionPath)) {
      version = fs.readFileSync(versionPath, 'utf8').trim();
    }
  } catch (err) {
    // Ignore
  }

  return {
    name: 'loki-mode',
    version: version
  };
}

// Oldest to newest; the last entry is the fallback offered to unknown clients.
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

// MCP-C: 2026-07-28 (stateless profile) is advertised only with LOKI_MCP_2026_07=1. It is never the initialize fallback,
// because that profile removes the handshake and a legacy client must keep getting a stateful version.
const STATELESS_VERSION = '2026-07-28';
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';

function advertisedProtocolVersions() {
  return process.env.LOKI_MCP_2026_07 === '1' ? SUPPORTED_PROTOCOL_VERSIONS.concat(STATELESS_VERSION) : SUPPORTED_PROTOCOL_VERSIONS.slice();
}

function negotiateProtocolVersion(params) {
  const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
  if (requested && advertisedProtocolVersions().includes(requested)) return requested;
  return SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
}

// ---------------------------------------------------------------------------
// MCP-D: Tasks extension (io.modelcontextprotocol/tasks), LOKI_MCP_TASKS=1
// ---------------------------------------------------------------------------
// A task wraps exactly two existing tools, loki_v10_verify and loki_v10_run, by running the read-only adapter in
// mcp/v10_tools.py (argument list, no shell). It never computes or edits a verdict: the task result is the adapter's
// stdout, byte for byte. Cancel kills only the child this server spawned, by its recorded pid. State is in memory.

const TASK_TOOLS = {
  loki_v10_verify: { cmd: 'verify', keys: ['receipt_path', 'repo_path'], required: [['receipt_path', 'repo_path']] },
  loki_v10_run: { cmd: 'run', keys: ['ref', 'repo_path'], required: [['ref'], ['repo_path']] }
};
const TASK_MAX = 64;
const TASK_TIMEOUT_MS = 300000;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
// Same list the adapter's _env() drops for the direct tool (mcp/v10_tools.py _DROPPED_ENV): one mechanism, so a task
// sees the same environment as the direct call. MCP_AUTH_TOKEN is the server's own bearer and is never forwarded.
const TASK_DROPPED_ENV = ['LOKI_CONTROL_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_WEBHOOK_URL', 'MCP_AUTH_TOKEN'];

const tasks = new Map();
let _taskSpawner = null;

function tasksEnabled() {
  return process.env.LOKI_MCP_TASKS === '1';
}

function _setTaskSpawnerForTests(fn) {
  _taskSpawner = fn;
}

function _taskPidForTests(taskId) {
  const t = tasks.get(taskId);
  return t ? t.pid : undefined;
}

/** W3C traceparent -> { traceId, parentSpanId }, or null for anything malformed or all-zero. */
function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT_RE.exec(value);
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], parentSpanId: m[2] };
}

function taskChildEnv(trace) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !TASK_DROPPED_ENV.includes(k)) env[k] = v;
  }
  delete env.LOKI_PARENT_SPAN_ID;
  env.LOKI_NO_BROWSER = '1';
  if (trace) {
    env.LOKI_TRACE_ID = trace.traceId;
    env.LOKI_PARENT_SPAN_ID = trace.parentSpanId;
  }
  return env;
}

function taskArgs(tool, args) {
  const spec = TASK_TOOLS[Object.prototype.hasOwnProperty.call(TASK_TOOLS, tool) ? tool : ''];
  if (!spec) return { error: 'tool cannot run as a task: ' + String(tool) };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'arguments must be an object' };
  for (const k of Object.keys(args)) {
    if (!spec.keys.includes(k)) return { error: 'unknown argument: ' + k };
  }
  for (const k of spec.keys) {
    const v = args[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 4096 || v.includes('\0') || v.startsWith('-')) return { error: 'invalid ' + k };
  }
  for (const anyOf of spec.required) {
    if (!anyOf.some((k) => typeof args[k] === 'string' && args[k] !== '')) return { error: anyOf.join(' or ') + ' is required' };
  }
  return { spec, argv: spec.keys.map((k) => (typeof args[k] === 'string' ? args[k] : '')) };
}

function taskView(t) {
  return { taskId: t.id, status: t.status, tool: t.tool };
}

function taskCreate(params, id) {
  const p = params || {};
  const a = taskArgs(p.tool, p.arguments);
  if (a.error) return makeError(-32602, a.error, id);
  const trace = parseTraceparent(p._meta && p._meta.traceparent);
  while (tasks.size >= TASK_MAX) {
    const old = Array.from(tasks.values()).find((t) => t.status !== 'working');
    if (!old) return makeError(-32603, 'too many running tasks', id);
    tasks.delete(old.id);
  }
  const adapter = path.resolve(__dirname, '..', '..', 'mcp', 'v10_tools.py');
  const cmd = process.env.LOKI_PYTHON || 'python3';
  const args = ['-I', adapter, a.spec.cmd].concat(a.argv);
  const spawner = _taskSpawner || ((c, av, o) => spawn(c, av, { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let child;
  try {
    child = spawner(cmd, args, { env: taskChildEnv(trace) });
  } catch (err) {
    return makeError(-32603, 'could not start task', id);
  }
  const t = { id: crypto.randomUUID(), tool: p.tool, status: 'working', pid: child.pid, stdout: '', text: null, child: child };
  tasks.set(t.id, t);
  if (child.stdout) child.stdout.on('data', (d) => { if (t.stdout.length < 1048576) t.stdout += d; });
  const timer = setTimeout(() => { if (t.status === 'working') { t.status = 'failed'; t.text = 'task timed out'; try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } }, TASK_TIMEOUT_MS);
  timer.unref();
  child.on('error', () => { clearTimeout(timer); if (t.status === 'working') { t.status = 'failed'; t.text = 'adapter could not run'; } });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (t.status !== 'working') return;
    if (code === 0 && t.stdout.trim()) { t.status = 'completed'; t.text = t.stdout.replace(/\n$/, ''); } else { t.status = 'failed'; t.text = 'adapter exited ' + String(code); }
  });
  return makeResult({ task: taskView(t) }, id);
}

function taskDispatch(method, params, id) {
  if (method === 'tasks/create') return taskCreate(params, id);
  const t = params && typeof params.taskId === 'string' ? tasks.get(params.taskId) : undefined;
  if (!t) return makeError(-32602, 'Unknown taskId', id);
  if (method === 'tasks/get') return makeResult({ task: taskView(t) }, id);
  if (method === 'tasks/result') {
    if (t.status === 'working') return makeError(-32602, 'Task not finished', id);
    if (t.status === 'cancelled') return makeError(-32602, 'Task was cancelled', id);
    return makeResult({ content: [{ type: 'text', text: t.text }], isError: t.status === 'failed' }, id);
  }
  // tasks/cancel: signal only the child this server recorded
  if (t.status === 'working') {
    t.status = 'cancelled';
    try { t.child.kill('SIGTERM'); } catch (e) { /* already gone */ }
  }
  return makeResult({ task: taskView(t) }, id);
}

function getCapabilities() {
  return {
    tools: {},
    resources: {}
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 request handler
// ---------------------------------------------------------------------------

function handleRequest(request, ctx) {
  // Validate basic JSON-RPC structure
  if (!request || typeof request !== 'object') {
    return makeError(-32600, 'Invalid request', null);
  }

  const { jsonrpc, method, params, id } = request;

  if (jsonrpc !== '2.0') {
    return makeError(-32600, 'Invalid JSON-RPC version (must be "2.0")', id);
  }

  if (!method || typeof method !== 'string') {
    return makeError(-32600, 'Missing or invalid method', id);
  }

  // Notifications (no id) -- we acknowledge but do not respond
  const isNotification = id === undefined || id === null;

  // Auth check for tool/resource calls
  if (method === 'tools/call' || method === 'resources/read' || (tasksEnabled() && method.startsWith('tasks/'))) {
    const auth = getAuth();
    const overHttp = !!(ctx && ctx.transport === 'http') && method.startsWith('tasks/');
    // Tasks spawn processes: over HTTP a token is mandatory even when general auth is off (fail closed).
    if (overHttp && !auth.enabled) {
      if (isNotification) return null;
      return makeError(-32001, 'Tasks over HTTP require an auth token (set MCP_AUTH_TOKEN)', id);
    }
    if (auth.enabled) {
      let validation = auth.validate(request);
      if (overHttp && !validation.valid && ctx.authorization) validation = auth.validateHeader(ctx.authorization);
      if (!validation.valid) {
        if (isNotification) return null;
        return makeError(-32001, validation.error || 'Unauthorized', id);
      }
    }
  }

  // Stateless profile: a request may carry its protocol version in _meta. No session is created or stored.
  const metaVersion = params && params._meta && typeof params._meta === 'object' ? params._meta[META_PROTOCOL_VERSION] : undefined;
  if (metaVersion !== undefined && !advertisedProtocolVersions().includes(metaVersion)) {
    if (isNotification) return null;
    const err = makeError(-32022, 'Unsupported protocol version: ' + String(metaVersion), id);
    err.error.data = { supported: advertisedProtocolVersions() };
    return err;
  }

  let result;

  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: negotiateProtocolVersion(params),
        serverInfo: getServerInfo(),
        capabilities: getCapabilities()
      };
      break;

    case 'tasks/create':
    case 'tasks/get':
    case 'tasks/result':
    case 'tasks/cancel':
      if (!tasksEnabled()) {
        if (isNotification) return null;
        return makeError(-32601, 'Method not found: ' + method, id);
      }
      return taskDispatch(method, params, id);

    case 'server/discover':
      result = {
        supportedVersions: advertisedProtocolVersions(),
        serverInfo: getServerInfo(),
        capabilities: getCapabilities()
      };
      break;

    case 'initialized':
    case 'notifications/initialized':
      // Client acknowledgment -- no response needed
      return isNotification ? null : makeResult({}, id);

    case 'tools/list':
      result = handleToolsList(params);
      break;

    case 'tools/call': {
      // handleToolsCall may return a Promise if tool.execute() is async.
      // Detect and propagate as a Promise so transports can await it.
      const toolResult = handleToolsCall(params);
      if (toolResult && typeof toolResult.then === 'function') {
        return toolResult.then((r) => makeResult(r, id));
      }
      result = toolResult;
      break;
    }

    case 'resources/list':
      result = handleResourcesList(params);
      break;

    case 'resources/read':
      result = handleResourcesRead(params);
      break;

    case 'ping':
      result = {};
      break;

    default:
      if (isNotification) return null;
      return makeError(-32601, 'Method not found: ' + method, id);
  }

  if (isNotification) return null;
  return makeResult(result, id);
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleToolsList() {
  const tools = getTools();
  const toolList = [];
  for (const [, mod] of tools) {
    toolList.push(mod.schema);
  }
  return { tools: toolList };
}

function handleToolsCall(params) {
  if (!params || !params.name) {
    return { isError: true, content: [{ type: 'text', text: 'Missing tool name' }] };
  }

  const tools = getTools();
  const tool = tools.get(params.name);

  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Unknown tool: ' + params.name }]
    };
  }

  // Execute the tool; handle both sync and async (Promise-returning) tools.
  // Calling JSON.stringify on a Promise silently produces "{}", so we must
  // detect and await any Promise before serializing.
  let rawResult;
  try {
    rawResult = tool.execute(params.arguments || {});
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Tool execution error: ' + err.message }]
    };
  }

  if (rawResult && typeof rawResult.then === 'function') {
    // Async tool: return a Promise so the caller (handleRequest) can propagate it
    return rawResult.then((result) => {
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      };
    }).catch((err) => {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Tool execution error: ' + err.message }]
      };
    });
  }

  // Synchronous tool: return result immediately
  return {
    content: [{ type: 'text', text: JSON.stringify(rawResult) }]
  };
}

function handleResourcesList() {
  const resources = getResources();
  const resourceList = [];
  for (const [, mod] of resources) {
    resourceList.push(mod.schema);
  }
  return { resources: resourceList };
}

function handleResourcesRead(params) {
  if (!params || !params.uri) {
    return {
      contents: [{ uri: '', mimeType: 'text/plain', text: 'Missing resource URI' }]
    };
  }

  const resources = getResources();
  const resource = resources.get(params.uri);

  if (!resource) {
    return {
      contents: [{
        uri: params.uri,
        mimeType: 'text/plain',
        text: 'Unknown resource: ' + params.uri
      }]
    };
  }

  try {
    const result = resource.read();
    return { contents: [result] };
  } catch (err) {
    return {
      contents: [{
        uri: params.uri,
        mimeType: 'text/plain',
        text: 'Resource read error: ' + err.message
      }]
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------------

function makeResult(result, id) {
  return { jsonrpc: '2.0', result: result, id: id };
}

function makeError(code, message, id) {
  return {
    jsonrpc: '2.0',
    error: { code: code, message: message },
    id: id !== undefined ? id : null
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  // --list-tools: print tool names and exit
  if (args.includes('--list-tools')) {
    const tools = getTools();
    for (const name of tools.keys()) {
      console.log(name);
    }
    process.exit(0);
  }

  // --sse mode
  if (args.includes('--sse')) {
    let port = 8421;
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10);
      if (isNaN(port)) port = 8421;
    }

    const { SSETransport } = require('./transport/sse');
    const transport = new SSETransport(handleRequest, { port: port });
    transport.start();

    process.stderr.write('[mcp-server] SSE mode on port ' + port + '\n');

    // Graceful shutdown
    process.on('SIGINT', () => { transport.stop(); process.exit(0); });
    process.on('SIGTERM', () => { transport.stop(); process.exit(0); });
    return;
  }

  // Default: stdio mode
  const { StdioTransport } = require('./transport/stdio');
  const transport = new StdioTransport(handleRequest);
  transport.start();

  process.stderr.write('[mcp-server] stdio mode ready\n');

  process.on('SIGINT', () => { transport.stop(); process.exit(0); });
  process.on('SIGTERM', () => { transport.stop(); process.exit(0); });
}

// Export for testing
module.exports = { parseTraceparent, _setTaskSpawnerForTests, _taskPidForTests, SUPPORTED_PROTOCOL_VERSIONS, handleRequest, getTools, getResources, getAuth, getServerInfo, main };

// Run if executed directly
if (require.main === module) {
  main();
}
