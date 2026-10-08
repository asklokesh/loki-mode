'use strict';

/**
 * Pure mapper: engine10 events.jsonl envelopes -> gen_ai span descriptors.
 * No I/O, no network, no clock. Attributes are built from a fixed whitelist of
 * event fields, so prompt or completion content and secrets can never reach a span.
 */

// OpenTelemetry GenAI semantic conventions version these attribute names follow.
const GENAI_SEMCONV_VERSION = '1.37.0';

const AGENT_NAME = 'loki';

function toNs(ts) {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? BigInt(ms) * 1000000n : null;
}

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// Unknown usage is absent, never 0 (mirrors engine10/cost.ts): an unmetered or
// unmeasured cost event, or an all-zero usage record, carries no token attributes.
function usageAttrs(d) {
  if (d.source === 'cli-invoker-unmetered' || d.source === 'not measured') return {};
  if (!isNum(d.input_tokens) || !isNum(d.output_tokens)) return {};
  if (d.input_tokens === 0 && d.output_tokens === 0) return {};
  return { 'gen_ai.usage.input_tokens': d.input_tokens, 'gen_ai.usage.output_tokens': d.output_tokens };
}

/**
 * @param {Array<{seq:number,ts:string,run:string,type:string,stage:string|null,data:object}>} events
 * @returns {Array<{key:string,parentKey:string|null,name:string,startNs:bigint,endNs:bigint,status:'ok'|'error'|'unset',attributes:object}>}
 */
function mapRunEvents(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e.type === 'string' && toNs(e.ts) !== null);
  if (list.length === 0) return [];
  const started = list.find((e) => e.type === 'run.started');
  const root = started || list[0];
  const last = list[list.length - 1];
  const done = list.find((e) => e.type === 'run.completed');
  const provider = started && typeof started.data.provider === 'string' ? started.data.provider : null;
  const runModel = started && typeof started.data.model === 'string' ? started.data.model : null;

  const base = { 'gen_ai.agent.name': AGENT_NAME };
  if (provider) base['gen_ai.provider.name'] = provider;
  const rootKey = 'run:' + root.run;
  const spans = [{
    key: rootKey, parentKey: null, name: 'invoke_agent ' + AGENT_NAME,
    startNs: toNs(root.ts), endNs: toNs((done || last).ts),
    status: done ? (done.data.verdict === 'FAILED' ? 'error' : 'ok') : 'unset',
    attributes: Object.assign({ 'gen_ai.operation.name': 'invoke_agent' }, base, runModel ? { 'gen_ai.request.model': runModel } : {}),
  }];

  const open = new Map();
  const costs = [];
  for (const e of list) {
    const d = e.data || {};
    if (e.type === 'stage.started' && e.stage) {
      open.set(e.stage, e);
    } else if ((e.type === 'stage.completed' || e.type === 'stage.failed' || e.type === 'stage.skipped') && e.stage) {
      const s = open.get(e.stage);
      open.delete(e.stage);
      spans.push({
        key: 'stage:' + e.stage, parentKey: rootKey, name: 'stage ' + e.stage,
        startNs: toNs((s || e).ts), endNs: toNs(e.ts), status: e.type === 'stage.failed' ? 'error' : 'ok',
        attributes: { 'gen_ai.operation.name': 'invoke_agent', 'loki.stage': e.stage },
      });
    } else if (e.type === 'cost') {
      costs.push(e);
    } else if (e.type.indexOf('tool.') === 0 && typeof d.name === 'string' && d.name) {
      const t = toNs(e.ts);
      spans.push({
        key: 'tool:' + e.seq, parentKey: e.stage ? 'stage:' + e.stage : rootKey, name: 'execute_tool ' + d.name,
        startNs: t, endNs: t, status: e.type === 'tool.failed' ? 'error' : 'ok',
        attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': d.name },
      });
    }
  }
  // Stages still open at the end of the log end at the last event.
  for (const [stage, s] of open) {
    spans.push({
      key: 'stage:' + stage, parentKey: rootKey, name: 'stage ' + stage,
      startNs: toNs(s.ts), endNs: toNs(last.ts), status: 'unset',
      attributes: { 'gen_ai.operation.name': 'invoke_agent', 'loki.stage': stage },
    });
  }
  for (const e of costs) {
    const attrs = usageAttrs(e.data || {});
    const stageSpan = spans.find((s) => s.key === 'stage:' + e.stage);
    const targets = stageSpan ? [stageSpan, spans[0]] : [spans[0]];
    for (const t of targets) {
      if (t === spans[0] && typeof e.data.model === 'string' && e.data.model) t.attributes['gen_ai.request.model'] = e.data.model;
      for (const [k, v] of Object.entries(attrs)) t.attributes[k] = (t.attributes[k] || 0) + v;
    }
    if (stageSpan && typeof e.data.model === 'string' && e.data.model) stageSpan.attributes['gen_ai.request.model'] = e.data.model;
  }
  // Parents before children so a replaying exporter can link them.
  const rank = (x) => (x.parentKey === null ? 0 : x.key.indexOf('stage:') === 0 ? 1 : 2);
  return spans.map((x, i) => ({ x, i })).sort((p, q) => rank(p.x) - rank(q.x) || p.i - q.i).map((o) => o.x);
}

module.exports = { GENAI_SEMCONV_VERSION, mapRunEvents };
