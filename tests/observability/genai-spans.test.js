'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GENAI_SEMCONV_VERSION, mapRunEvents } = require('../../src/observability/genai-spans');

let seq = 0;
const ev = (type, stage, data, ts) => ({ v: 1, seq: seq++, ts, run: 'r1', type, stage, data: data || {} });
const T = (s) => '2026-10-08T10:00:' + String(s).padStart(2, '0') + '.000Z';

function fixture(costData) {
  seq = 0;
  return [
    ev('run.started', null, { provider: 'claude', model: 'claude-sonnet-5-5', prompt: 'SECRET PROMPT BODY' }, T(0)),
    ev('stage.started', 'implement', {}, T(1)),
    ev('tool.called', 'implement', { name: 'Edit', input: 'api_key=sk-LEAK' }, T(2)),
    ev('cost', 'implement', costData, T(3)),
    ev('stage.completed', 'implement', {}, T(4)),
    ev('stage.started', 'verify', {}, T(5)),
    ev('stage.failed', 'verify', {}, T(6)),
    ev('run.completed', null, { verdict: 'PARTIAL' }, T(7)),
  ];
}
const byName = (spans, n) => spans.find((s) => s.name === n);

describe('genai-spans mapRunEvents', () => {
  it('pins the semconv version in one constant', () => {
    assert.match(GENAI_SEMCONV_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('maps the exact span tree and attribute names with cost data', () => {
    const spans = mapRunEvents(fixture({ model: 'claude-sonnet-5-5', usd: 0.5, input_tokens: 100, output_tokens: 20, source: 'x.json' }));
    assert.deepEqual(spans.map((s) => s.name).sort(), ['execute_tool Edit', 'invoke_agent loki', 'stage implement', 'stage verify']);
    const root = byName(spans, 'invoke_agent loki');
    assert.equal(root.parentKey, null);
    assert.deepEqual(root.attributes, {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'loki', 'gen_ai.provider.name': 'claude',
      'gen_ai.request.model': 'claude-sonnet-5-5', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20,
    });
    const impl = byName(spans, 'stage implement');
    assert.equal(impl.parentKey, root.key);
    assert.equal(impl.attributes['gen_ai.usage.input_tokens'], 100);
    assert.equal(byName(spans, 'stage verify').status, 'error');
    const tool = byName(spans, 'execute_tool Edit');
    assert.equal(tool.parentKey, impl.key);
    assert.equal(tool.attributes['gen_ai.operation.name'], 'execute_tool');
    assert.equal(tool.attributes['gen_ai.tool.name'], 'Edit');
    assert.equal(root.startNs, 1791453600000000000n);
  });

  it('unknown cost stays absent, never 0', () => {
    for (const c of [{ model: 'm', usd: null, input_tokens: 0, output_tokens: 0, source: 'not measured' }, { model: 'm', usd: 0, input_tokens: 0, output_tokens: 0, source: 'cli-invoker-unmetered' }, {}]) {
      const root = byName(mapRunEvents(fixture(c)), 'invoke_agent loki');
      assert.equal('gen_ai.usage.input_tokens' in root.attributes, false);
      assert.equal('gen_ai.usage.output_tokens' in root.attributes, false);
    }
  });

  it('never carries prompt content, tool input or secrets', () => {
    const json = JSON.stringify(mapRunEvents(fixture({ model: 'm', input_tokens: 1, output_tokens: 1, source: 's' })), (k, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.equal(json.includes('SECRET PROMPT BODY'), false);
    assert.equal(json.includes('sk-LEAK'), false);
  });

  it('is pure: same input, same output, input untouched', () => {
    const f = fixture({ model: 'm', input_tokens: 5, output_tokens: 6, source: 's' });
    const copy = JSON.stringify(f);
    const a = mapRunEvents(f), b = mapRunEvents(f);
    assert.equal(JSON.stringify(f), copy);
    assert.deepEqual(a.map((s) => s.key), b.map((s) => s.key));
    assert.deepEqual(mapRunEvents([]), []);
  });
});

describe('otel-bridge engine10 export', () => {
  const saved = { e: process.env.LOKI_OTEL_ENDPOINT, g: process.env.LOKI_OTEL_GENAI, d: process.env.LOKI_DIR };
  let dir;
  afterEach(() => {
    for (const [k, v] of [['LOKI_OTEL_ENDPOINT', saved.e], ['LOKI_OTEL_GENAI', saved.g], ['LOKI_DIR', saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports a completed run with event timestamps and parent links; flag off exports nothing', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genai-bridge-'));
    const runDir = path.join(dir, '.loki', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), fixture({ model: 'm', input_tokens: 3, output_tokens: 4, source: 's' }).map((e) => JSON.stringify(e)).join('\n') + '\n');
    const bridge = require('../../src/observability/otel-bridge');
    const made = [];
    const tracer = { startSpan: (name, o) => { const s = { name, spanId: 'id' + made.length, opts: o, setStatus() {}, end(n) { this.endN = n; } }; made.push(s); return s; } };
    const ref = { SpanStatusCode: { OK: 1, ERROR: 2 } };
    const n = bridge.exportEngine10Run(JSON.parse('[' + fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').join(',') + ']'), tracer, 'a'.repeat(32), ref);
    assert.equal(n, 4);
    assert.equal(made[0].opts.parentSpanId, undefined);
    assert.equal(made[1].opts.parentSpanId, made[0].spanId);
    assert.equal(made[0].endN, 1791453607000000000n);
    delete process.env.LOKI_OTEL_GENAI;
    made.length = 0;
    process.env.LOKI_DIR = '.loki';
    const cwd = process.cwd();
    process.chdir(dir);
    try { bridge.scanEngine10Runs(tracer, 'a'.repeat(32), ref); } finally { process.chdir(cwd); }
    assert.equal(made.length, 0);
  });
});
