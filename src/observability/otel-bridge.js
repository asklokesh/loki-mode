'use strict';

/**
 * OTEL Bridge - Background process that watches .loki/events/pending/ for
 * event files and creates OpenTelemetry spans from RARV cycle events.
 *
 * Watches for event types:
 *   - otel_span_start / otel_span_end  (explicit span boundaries)
 *   - iteration_start / iteration_complete (RARV iteration lifecycle)
 *   - session_start / session_end (session lifecycle)
 *
 * Requires LOKI_OTEL_ENDPOINT to be set. Intended to run as a background
 * process launched by autonomy/run.sh.
 *
 * Usage:
 *   LOKI_OTEL_ENDPOINT=http://localhost:4318 node src/observability/otel-bridge.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const lokiDir = process.env.LOKI_DIR || '.loki';
const pendingDir = path.join(process.cwd(), lokiDir, 'events', 'pending');
const POLL_INTERVAL_MS = 500;

// Active span registry: key -> Span
const activeSpans = new Map();

// Track processed files to avoid re-processing (timestamp watermark approach)
var lastProcessedFile = '';

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

/**
 * Extract the event type from a parsed event JSON.
 * Events from emit.sh use {type, payload} format.
 * Events from emit_event_json use {type, data} format.
 */
// Known event types that the bridge handles directly
const KNOWN_EVENT_TYPES = new Set([
  'iteration_start', 'iteration_complete',
  'otel_span_start', 'otel_span_end',
  'session_start', 'session_end',
]);

function getEventType(data) {
  const type = data.type || '';

  // If the type is already a known event type, use it directly
  // (events from emit_event_pending use full event type names)
  if (KNOWN_EVENT_TYPES.has(type)) {
    return type;
  }

  // emit.sh format: type + payload.action combined (e.g., type=session, action=start)
  if (data.payload && data.payload.action) {
    const combined = type + '_' + data.payload.action;
    if (KNOWN_EVENT_TYPES.has(combined)) {
      return combined;
    }
  }

  return type;
}

/**
 * Extract payload data from the event, normalizing between the two formats.
 */
function getPayload(data) {
  return data.payload || data.data || {};
}

/**
 * Process a single event file from the pending directory.
 * When called via start(), tracer/traceId/otelRef are bound via closure.
 * When called directly (for testing), they must be provided.
 */
function processEventFile(filepath, tracer, traceId, otelRef) {
  let raw;
  try {
    raw = fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    return; // File may have been removed between readdir and readFile
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return; // Malformed JSON -- skip silently
  }

  const eventType = getEventType(data);
  const payload = getPayload(data);

  switch (eventType) {
    case 'iteration_start': {
      const iteration = payload.iteration || payload.action || '';
      const spanName = 'rarv.iteration.' + iteration;
      const span = tracer.startSpan('rarv.iteration', {
        traceId: traceId,
        attributes: {
          'rarv.iteration': String(iteration),
          'rarv.provider': payload.provider || '',
        },
      });
      activeSpans.set(spanName, span);
      break;
    }

    case 'iteration_complete': {
      const iteration = payload.iteration || payload.action || '';
      const key = 'rarv.iteration.' + iteration;
      const span = activeSpans.get(key);
      if (span) {
        const statusCode = payload.status === 'completed'
          ? otelRef.SpanStatusCode.OK
          : otelRef.SpanStatusCode.ERROR;
        span.setStatus(statusCode, payload.status || '');
        span.setAttribute('rarv.exit_code', String(payload.exit_code || payload.exitCode || '0'));
        span.end();
        activeSpans.delete(key);
      }
      break;
    }

    case 'otel_span_start': {
      const spanName = payload.span_name || payload.action || 'unknown';
      const attrs = {};
      for (const [k, v] of Object.entries(payload)) {
        if (k !== 'action') {
          attrs[k] = String(v);
        }
      }
      const span = tracer.startSpan(spanName, {
        traceId: traceId,
        attributes: attrs,
      });
      activeSpans.set(spanName, span);
      break;
    }

    case 'otel_span_end': {
      const spanName = payload.span_name || payload.action || 'unknown';
      const span = activeSpans.get(spanName);
      if (span) {
        if (payload.status) {
          const code = payload.status === 'ok'
            ? otelRef.SpanStatusCode.OK
            : otelRef.SpanStatusCode.ERROR;
          span.setStatus(code, payload.status);
        }
        span.end();
        activeSpans.delete(spanName);
      }
      break;
    }

    case 'session_start': {
      const span = tracer.startSpan('loki.session', {
        traceId: traceId,
        attributes: {
          'session.provider': payload.provider || '',
          'session.prd': payload.prd || '',
        },
      });
      activeSpans.set('loki.session', span);
      break;
    }

    case 'session_end': {
      const span = activeSpans.get('loki.session');
      if (span) {
        const code = String(payload.result) === '0'
          ? otelRef.SpanStatusCode.OK
          : otelRef.SpanStatusCode.ERROR;
        span.setStatus(code);
        span.setAttribute('session.iterations', String(payload.iterations || '0'));
        span.end();
        activeSpans.delete('loki.session');
      }
      break;
    }

    default:
      // Ignore unknown event types
      break;
  }
}

// ---------------------------------------------------------------------------
// Engine10 gen_ai spans (LOKI_OTEL_GENAI=1): completed runs under .loki/runs/<id>/events.jsonl
// ---------------------------------------------------------------------------

const exportedRuns = new Set();

function genaiEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.LOKI_OTEL_GENAI || '').trim());
}

/** Emit the span tree for one run's envelopes. Returns the number of spans ended. */
function exportEngine10Run(events, tracer, traceId, otelRef, rootParentSpanId) {
  const spans = require('./genai-spans').mapRunEvents(events);
  const live = new Map();
  for (const d of spans) {
    const parent = d.parentKey ? live.get(d.parentKey) : null;
    const span = tracer.startSpan(d.name, { traceId: traceId, parentSpanId: parent ? parent.spanId : (d.parentKey ? undefined : rootParentSpanId), attributes: Object.assign({}, d.attributes) });
    span.startTimeUnixNano = String(d.startNs);
    live.set(d.key, span);
    if (d.status === 'ok') span.setStatus(otelRef.SpanStatusCode.OK);
    else if (d.status === 'error') span.setStatus(otelRef.SpanStatusCode.ERROR);
    span.end(d.endNs);
  }
  return spans.length;
}

function scanEngine10Runs(tracer, traceId, otelRef) {
  if (!genaiEnabled()) return;
  const runsDir = path.join(process.cwd(), lokiDir, 'runs');
  try {
    for (const id of fs.readdirSync(runsDir)) {
      if (exportedRuns.has(id)) continue;
      const f = path.join(runsDir, id, 'events.jsonl');
      if (!fs.existsSync(f)) continue;
      const events = [];
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        try { if (line.trim()) events.push(JSON.parse(line)); } catch (e) { /* torn line */ }
      }
      if (!events.some((e) => e && e.type === 'run.completed')) continue; // export complete trees only
      exportedRuns.add(id);
      const envParent = /^[0-9a-f]{16}$/.test(process.env.LOKI_PARENT_SPAN_ID || '') ? process.env.LOKI_PARENT_SPAN_ID : undefined; // MCP-D: parent from an MCP task's traceparent
      exportEngine10Run(events, tracer, traceId, otelRef, envParent);
    }
  } catch (e) { /* no runs dir */ }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

function scanPendingEvents(tracer, traceId, otelRef) {
  if (!fs.existsSync(pendingDir)) return;
  try {
    var files = fs.readdirSync(pendingDir)
      .filter(function(f) { return f.endsWith('.json'); })
      .sort();
    for (var i = 0; i < files.length; i++) {
      if (files[i] > lastProcessedFile) {
        processEventFile(path.join(pendingDir, files[i]), tracer, traceId, otelRef);
        lastProcessedFile = files[i];
      }
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// start() - initializes OTEL and begins the polling loop
// ---------------------------------------------------------------------------

let pollInterval = null;

function start() {
  const otelMod = require('./otel');
  otelMod.initialize();

  const tracer = otelMod.tracerProvider.getTracer('loki-mode');
  const traceId = process.env.LOKI_TRACE_ID || crypto.randomBytes(16).toString('hex');

  // Bound versions that close over initialized dependencies
  const boundProcessEventFile = (filepath) => processEventFile(filepath, tracer, traceId, otelMod);
  const boundScanPendingEvents = () => { scanPendingEvents(tracer, traceId, otelMod); scanEngine10Runs(tracer, traceId, otelMod); };

  pollInterval = setInterval(boundScanPendingEvents, POLL_INTERVAL_MS);

  // Initial scan on startup
  boundScanPendingEvents();

  const shutdownFn = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }

    // End any active spans with a cancellation status
    for (const [, span] of activeSpans) {
      span.setStatus(otelMod.SpanStatusCode.ERROR, 'bridge_shutdown');
      span.end();
    }
    activeSpans.clear();

    // Flush and shutdown the OTEL exporter
    const exporter = otelMod.getExporter();
    if (exporter) {
      exporter.flush();
    }
    otelMod.shutdown();
  };

  return {
    processEventFile: boundProcessEventFile,
    scanPendingEvents: boundScanPendingEvents,
    activeSpans,
    shutdown: shutdownFn,
    _getTraceId: () => traceId,
    _getLastProcessedFile: function() { return lastProcessedFile; },
    _resetState: function() { lastProcessedFile = ''; },
  };
}

// ---------------------------------------------------------------------------
// Exports (for require() by tests - no side effects)
// ---------------------------------------------------------------------------

module.exports = {
  start,
  processEventFile,
  exportEngine10Run,
  scanEngine10Runs,
  activeSpans,
  _getLastProcessedFile: function() { return lastProcessedFile; },
  _resetState: function() { lastProcessedFile = ''; },
};

// ---------------------------------------------------------------------------
// Main entry point - side effects only when run directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  const instance = start();

  function shutdown() {
    instance.shutdown();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
