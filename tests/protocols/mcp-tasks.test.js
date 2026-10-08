'use strict';
// MCP-D: Tasks extension (io.modelcontextprotocol/tasks) over loki_v10_verify / loki_v10_run, and _meta.traceparent propagation.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const server = require('../../src/protocols/mcp-server');
const bridge = require('../../src/observability/otel-bridge');

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const call = (method, params, id) => server.handleRequest({ jsonrpc: '2.0', method, params, id: id || 1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(20); } throw new Error('timeout'); }

// Injected spawner: records argv/env, runs a node one-liner in place of the python adapter.
let seen;
function fakeSpawner(script) {
  return (cmd, args, opts) => { seen = { cmd, args, env: opts.env }; return spawn(process.execPath, ['-e', script], { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] }); };
}
const OK = 'process.stdout.write(JSON.stringify({exit_code:0,verified:true,output:"ok"})+"\\n")';
const SLOW = 'setTimeout(()=>{},60000)';

describe('MCP tasks (LOKI_MCP_TASKS)', () => {
  const saved = { t: process.env.LOKI_MCP_TASKS, s: process.env.LOKI_MCP_AUTH_TOKEN };
  beforeEach(() => { seen = undefined; process.env.LOKI_MCP_TASKS = '1'; server._setTaskSpawnerForTests(fakeSpawner(OK)); });
  afterEach(() => {
    server._setTaskSpawnerForTests(null);
    for (const [k, v] of [['LOKI_MCP_TASKS', saved.t], ['LOKI_MCP_AUTH_TOKEN', saved.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('flag off: tasks/* are unknown methods (-32601)', () => {
    delete process.env.LOKI_MCP_TASKS;
    for (const m of ['tasks/create', 'tasks/get', 'tasks/result', 'tasks/cancel']) assert.equal(call(m, {}).error.code, -32601, m);
  });

  it('create returns a task id; poll sees working then completed; result is the adapter output verbatim', async () => {
    server._setTaskSpawnerForTests(fakeSpawner('setTimeout(()=>process.stdout.write(JSON.stringify({exit_code:0,verified:true,output:"ok"})+"\\n"),150)'));
    const c = call('tasks/create', { tool: 'loki_v10_verify', arguments: { receipt_path: '/r/receipt.json', repo_path: '/r' } });
    const id = c.result.task.taskId;
    assert.match(id, /^[0-9a-f-]{16,}$/);
    assert.equal(call('tasks/get', { taskId: id }).result.task.status, 'working');
    await until(() => call('tasks/get', { taskId: id }).result.task.status === 'completed');
    const r = call('tasks/result', { taskId: id }).result;
    assert.equal(r.content[0].text, '{"exit_code":0,"verified":true,"output":"ok"}');
    assert.deepEqual(seen.args.slice(-3), ['verify', '/r/receipt.json', '/r']);
  });

  it('only loki_v10_verify and loki_v10_run can be tasks; other tools and unknown arguments are refused (-32602)', () => {
    assert.equal(call('tasks/create', { tool: 'loki_start_project', arguments: {} }).error.code, -32602);
    assert.equal(call('tasks/create', { tool: 'loki_v10_verify', arguments: { receipt_path: '/r/x.json', verdict: 'VERIFIED' } }).error.code, -32602);
    assert.equal(call('tasks/create', { tool: 'loki_v10_verify', arguments: { receipt_path: '--x' } }).error.code, -32602);
    assert.equal(seen, undefined);
  });

  it('cancel stops the child by its recorded pid and the task reads cancelled', async () => {
    server._setTaskSpawnerForTests(fakeSpawner(SLOW));
    const id = call('tasks/create', { tool: 'loki_v10_verify', arguments: { repo_path: '/r' } }).result.task.taskId;
    const pid = server._taskPidForTests(id);
    assert.ok(Number.isInteger(pid) && pid > 1);
    process.kill(pid, 0);
    assert.equal(call('tasks/cancel', { taskId: id }).result.task.status, 'cancelled');
    await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
    assert.equal(call('tasks/get', { taskId: id }).result.task.status, 'cancelled');
    assert.equal(call('tasks/get', { taskId: 'nope' }).error.code, -32602);
  });

  it('traceparent: a valid _meta.traceparent becomes LOKI_TRACE_ID and LOKI_PARENT_SPAN_ID of the child; tracestate and baggage are not forwarded', () => {
    call('tasks/create', { tool: 'loki_v10_verify', arguments: { repo_path: '/r' }, _meta: { traceparent: TP, tracestate: 'vendor=secret', baggage: 'k=v' } });
    assert.equal(seen.env.LOKI_TRACE_ID, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(seen.env.LOKI_PARENT_SPAN_ID, 'b7ad6b7169203331');
    assert.ok(!JSON.stringify(seen.env).includes('vendor=secret'));
  });

  it('traceparent: malformed values are ignored, never forwarded', () => {
    for (const bad of ['garbage', '00-' + '0'.repeat(32) + '-b7ad6b7169203331-01', '00-0af7651916cd43dd8448eb211c80319c-' + '0'.repeat(16) + '-01', TP + 'x', 42]) {
      seen = undefined;
      delete process.env.LOKI_TRACE_ID;
      call('tasks/create', { tool: 'loki_v10_verify', arguments: { repo_path: '/r' }, _meta: { traceparent: bad } });
      assert.equal(seen.env.LOKI_PARENT_SPAN_ID, undefined, String(bad));
      assert.equal(seen.env.LOKI_TRACE_ID, undefined, String(bad));
    }
    assert.equal(server.parseTraceparent(TP).parentSpanId, 'b7ad6b7169203331');
  });

  it('the child env carries no tokens or secrets', () => {
    process.env.LOKI_MCP_AUTH_TOKEN = 'tok-123';
    process.env.LOKI_CONTROL_TOKEN = 'ctl-456';
    process.env.GH_TOKEN = 'gh-789';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-000';
    try {
      call('tasks/create', { tool: 'loki_v10_verify', arguments: { repo_path: '/r' }, _meta: { traceparent: TP } });
      const blob = JSON.stringify(seen.env);
      for (const s of ['tok-123', 'ctl-456', 'gh-789', 'aws-000']) assert.ok(!blob.includes(s), s);
      assert.equal(seen.env.LOKI_NO_BROWSER, '1');
    } finally { for (const k of ['LOKI_CONTROL_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) delete process.env[k]; }
  });

  it('task creation needs auth when auth is enabled; no spawn happens without it', () => {
    const auth = server.getAuth();
    const orig = auth.validate;
    Object.defineProperty(auth, 'enabled', { get: () => true, configurable: true });
    auth.validate = () => ({ valid: false, error: 'no token' });
    try {
      for (const m of ['tasks/create', 'tasks/get', 'tasks/result', 'tasks/cancel']) assert.equal(call(m, { tool: 'loki_v10_verify', arguments: { repo_path: '/r' }, taskId: 'x' }).error.code, -32001, m);
      assert.equal(seen, undefined);
    } finally { auth.validate = orig; delete auth.enabled; }
  });
});

describe('traceparent as the parent of the first span (OTEL-1 exporter)', () => {
  const events = [
    { v: 1, seq: 0, ts: '2026-10-08T10:00:00.000Z', run: 'r1', type: 'run.started', stage: null, data: { provider: 'claude', model: 'm' } },
    { v: 1, seq: 1, ts: '2026-10-08T10:00:01.000Z', run: 'r1', type: 'stage.started', stage: 'verify', data: {} },
    { v: 1, seq: 2, ts: '2026-10-08T10:00:02.000Z', run: 'r1', type: 'stage.completed', stage: 'verify', data: {} },
    { v: 1, seq: 3, ts: '2026-10-08T10:00:03.000Z', run: 'r1', type: 'run.completed', stage: null, data: { verdict: 'VERIFIED' } },
  ];
  const mk = () => { const made = []; return { made, tracer: { startSpan: (name, o) => { const s = { name, spanId: 'id' + made.length, opts: o, setStatus() {}, end() {} }; made.push(s); return s; } } }; };
  const ref = { SpanStatusCode: { OK: 1, ERROR: 2 } };

  it('root span parent is the given parent span id; children still point at their own parents', () => {
    const { made, tracer } = mk();
    bridge.exportEngine10Run(events, tracer, '0af7651916cd43dd8448eb211c80319c', ref, 'b7ad6b7169203331');
    assert.equal(made[0].opts.parentSpanId, 'b7ad6b7169203331');
    assert.equal(made[0].opts.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.equal(made[1].opts.parentSpanId, made[0].spanId);
  });

  it('no parent given: root has no parent (unchanged)', () => {
    const { made, tracer } = mk();
    bridge.exportEngine10Run(events, tracer, 'a'.repeat(32), ref);
    assert.equal(made[0].opts.parentSpanId, undefined);
  });
});
