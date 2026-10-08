'use strict';

/**
 * OpenTelemetry initialization module.
 *
 * Lazy initialization: ONLY loads when LOKI_OTEL_ENDPOINT env var is set.
 * When not set, this module should never be imported directly -- use index.js
 * which returns no-op functions with zero overhead.
 *
 * Implements a minimal OTLP/HTTP+JSON exporter using Node.js built-in http/https
 * modules. Enterprises will bring their own OTEL collector.
 */

const crypto = require('crypto');
const path = require('path');

// -------------------------------------------------------------------
// Trace ID / Span ID generation (W3C Trace Context compatible)
// -------------------------------------------------------------------

function generateTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

// -------------------------------------------------------------------
// Timestamp helpers (nanoseconds as string for OTLP JSON)
// -------------------------------------------------------------------

// Anchor hrtime to wall-clock so we get absolute nanosecond timestamps
const _hrtimeAnchorNs = process.hrtime.bigint();
const _wallAnchorNs = BigInt(Date.now()) * 1000000n;

function nowNanos() {
  const elapsed = process.hrtime.bigint() - _hrtimeAnchorNs;
  return (_wallAnchorNs + elapsed).toString();
}

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------

// Maximum number of distinct label combinations per metric before eviction
const MAX_METRIC_CARDINALITY = 1000;

// Maximum number of raw samples stored per histogram series before capping.
// Prevents unbounded memory growth when flush is infrequent.
const MAX_HISTOGRAM_SAMPLES = 10000;

// Read scope version from package.json
let _scopeVersion = '0.0.0';
try {
  const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
  _scopeVersion = pkg.version || '0.0.0';
} catch (_) {
  // Fallback if package.json is not found
}

// -------------------------------------------------------------------
// Span representation
// -------------------------------------------------------------------

const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

class Span {
  constructor(name, traceId, parentSpanId, attributes) {
    this.name = name;
    this.traceId = traceId || generateTraceId();
    this.spanId = generateSpanId();
    this.parentSpanId = parentSpanId || '';
    this.startTimeUnixNano = nowNanos();
    this.endTimeUnixNano = null;
    this.status = { code: SpanStatusCode.UNSET };
    this.attributes = attributes || {};
    this._ended = false;
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
    return this;
  }

  setStatus(code, message) {
    this.status = { code };
    if (message) {
      this.status.message = message;
    }
    return this;
  }

  end(endNanos) {
    if (this._ended) return;
    this._ended = true;
    this.endTimeUnixNano = endNanos !== undefined ? String(endNanos) : nowNanos(); // endNanos: replayed spans (gen_ai bridge) keep event time
    // Register with the exporter
    if (_activeExporter) {
      _activeExporter.addSpan(this);
    }
  }

  /**
   * Returns the W3C traceparent header value for context propagation.
   */
  traceparent() {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  /**
   * Serialize to OTLP JSON span format.
   */
  toOTLP() {
    const attrs = [];
    for (const [key, val] of Object.entries(this.attributes)) {
      const attr = { key };
      if (typeof val === 'number') {
        if (Number.isInteger(val)) {
          attr.value = { intValue: String(val) };
        } else {
          attr.value = { doubleValue: val };
        }
      } else if (typeof val === 'boolean') {
        attr.value = { boolValue: val };
      } else {
        attr.value = { stringValue: String(val) };
      }
      attrs.push(attr);
    }

    const span = {
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: this.startTimeUnixNano,
      endTimeUnixNano: this.endTimeUnixNano || nowNanos(),
      attributes: attrs,
      status: this.status,
    };

    if (this.parentSpanId) {
      span.parentSpanId = this.parentSpanId;
    }

    return span;
  }
}

// -------------------------------------------------------------------
// Metric types
// -------------------------------------------------------------------

class Counter {
  constructor(name, description, unit) {
    this.name = name;
    this.description = description || '';
    this.unit = unit || '';
    this._value = 0;
    this._labeledValues = {};
  }

  add(value, labels) {
    if (value < 0) return; // counters are monotonic
    if (labels) {
      const key = JSON.stringify(labels);
      if (!(key in this._labeledValues)) {
        if (Object.keys(this._labeledValues).length >= MAX_METRIC_CARDINALITY) {
          // Refuse new label sets to preserve monotonicity of existing counters.
          // Eviction would destroy accumulated counts and violate the monotonic invariant.
          process.stderr.write(
            `[loki-otel] Counter "${this.name}" cardinality limit reached; dropping new label set: ${key}\n`
          );
          return;
        }
        this._labeledValues[key] = 0;
      }
      this._labeledValues[key] += value;
    } else {
      this._value += value;
    }
  }

  get(labels) {
    if (labels) {
      const key = JSON.stringify(labels);
      return this._labeledValues[key] || 0;
    }
    return this._value;
  }

  toOTLP() {
    const dataPoints = [];

    // Only emit the unlabeled data point if it has been incremented,
    // or if there are no labeled values (always need at least one point).
    if (this._value !== 0 || Object.keys(this._labeledValues).length === 0) {
      dataPoints.push({
        attributes: [],
        asInt: String(this._value),
        timeUnixNano: nowNanos(),
      });
    }

    // Include all labeled data points
    for (const [key, value] of Object.entries(this._labeledValues)) {
      const labels = JSON.parse(key);
      const attrs = Object.entries(labels).map(([k, v]) => ({
        key: k,
        value: { stringValue: String(v) },
      }));
      dataPoints.push({
        attributes: attrs,
        asInt: String(value),
        timeUnixNano: nowNanos(),
      });
    }

    return {
      name: this.name,
      description: this.description,
      unit: this.unit,
      sum: {
        dataPoints,
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: true,
      },
    };
  }
}

class Gauge {
  constructor(name, description, unit) {
    this.name = name;
    this.description = description || '';
    this.unit = unit || '';
    this._value = 0;
    this._labeledValues = {};
  }

  set(value, labels) {
    if (labels) {
      const key = JSON.stringify(labels);
      if (!(key in this._labeledValues) && Object.keys(this._labeledValues).length >= MAX_METRIC_CARDINALITY) {
        const firstKey = Object.keys(this._labeledValues)[0];
        delete this._labeledValues[firstKey];
      }
      this._labeledValues[key] = value;
    } else {
      this._value = value;
    }
  }

  get(labels) {
    if (labels) {
      const key = JSON.stringify(labels);
      return this._labeledValues[key] || 0;
    }
    return this._value;
  }

  toOTLP() {
    const dataPoints = [];

    // Only emit the unlabeled data point if it has been set to a non-zero value,
    // or if there are no labeled values (always need at least one point).
    if (this._value !== 0 || Object.keys(this._labeledValues).length === 0) {
      dataPoints.push({
        attributes: [],
        asDouble: this._value,
        timeUnixNano: nowNanos(),
      });
    }

    // Include all labeled data points
    for (const [key, value] of Object.entries(this._labeledValues)) {
      const labels = JSON.parse(key);
      const attrs = Object.entries(labels).map(([k, v]) => ({
        key: k,
        value: { stringValue: String(v) },
      }));
      dataPoints.push({
        attributes: attrs,
        asDouble: value,
        timeUnixNano: nowNanos(),
      });
    }

    return {
      name: this.name,
      description: this.description,
      unit: this.unit,
      gauge: { dataPoints },
    };
  }
}

class Histogram {
  constructor(name, description, unit, boundaries) {
    this.name = name;
    this.description = description || '';
    this.unit = unit || '';
    this.boundaries = boundaries || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this._values = [];
    this._labeledValues = {};
  }

  record(value, labels) {
    if (labels) {
      const key = JSON.stringify(labels);
      if (!(key in this._labeledValues)) {
        if (Object.keys(this._labeledValues).length >= MAX_METRIC_CARDINALITY) {
          // Refuse new label sets rather than evicting existing series.
          // Eviction would lose all accumulated histogram data for that series.
          process.stderr.write(
            `[loki-otel] Histogram "${this.name}" cardinality limit reached; dropping new label set: ${key}\n`
          );
          return;
        }
        this._labeledValues[key] = [];
      }
      if (this._labeledValues[key].length < MAX_HISTOGRAM_SAMPLES) {
        this._labeledValues[key].push(value);
      }
      // Silently drop samples beyond the cap to bound memory usage.
    } else {
      if (this._values.length < MAX_HISTOGRAM_SAMPLES) {
        this._values.push(value);
      }
      // Silently drop samples beyond the cap to bound memory usage.
    }
  }

  get(labels) {
    if (labels) {
      const key = JSON.stringify(labels);
      return this._labeledValues[key] || [];
    }
    return this._values;
  }

  _computeBucketCounts(values) {
    const counts = new Array(this.boundaries.length + 1).fill(0);
    for (const v of values) {
      let placed = false;
      for (let i = 0; i < this.boundaries.length; i++) {
        if (v <= this.boundaries[i]) {
          counts[i]++;
          placed = true;
          break;
        }
      }
      if (!placed) {
        counts[this.boundaries.length]++;
      }
    }
    return counts;
  }

  toOTLP() {
    const dataPoints = [];

    const makePoint = (values, attrs) => {
      const bucketCounts = this._computeBucketCounts(values);
      const sum = values.reduce((a, b) => a + b, 0);
      return {
        attributes: attrs || [],
        count: String(values.length),
        sum: sum,
        bucketCounts: bucketCounts.map(String),
        explicitBounds: this.boundaries,
        timeUnixNano: nowNanos(),
      };
    };

    if (Object.keys(this._labeledValues).length > 0) {
      for (const [key, values] of Object.entries(this._labeledValues)) {
        const labels = JSON.parse(key);
        const attrs = Object.entries(labels).map(([k, v]) => ({
          key: k,
          value: { stringValue: String(v) },
        }));
        dataPoints.push(makePoint(values, attrs));
      }
    } else if (this._values.length > 0) {
      dataPoints.push(makePoint(this._values));
    }

    return {
      name: this.name,
      description: this.description,
      unit: this.unit,
      histogram: {
        dataPoints,
        aggregationTemporality: 2, // CUMULATIVE
      },
    };
  }
}

// -------------------------------------------------------------------
// OTLP HTTP/JSON Exporter (uses Node.js built-in http/https)
// -------------------------------------------------------------------

let _activeExporter = null;

class OTLPExporter {
  constructor(endpoint) {
    // SSRF protection: only allow http: and https: schemes
    const parsedUrl = new URL(endpoint);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        `Invalid OTEL endpoint scheme "${parsedUrl.protocol}". Only http: and https: are allowed.`
      );
    }
    this._endpoint = endpoint.replace(/\/$/, '');
    this._pendingSpans = [];
    this._flushTimer = null;
    this._flushIntervalMs = 5000;
    this._serviceName = process.env.LOKI_SERVICE_NAME || 'loki-mode';
    this._errorHandler = OTLPExporter._defaultErrorHandler;
    this._startFlushTimer();
  }

  static _defaultErrorHandler(err) {
    process.stderr.write(`[loki-otel] export error: ${err.message || err.code || String(err)}\n`);
  }

  /**
   * Set a custom error handler for export failures.
   * @param {Function} handler - function(err) called on network errors
   */
  setErrorHandler(handler) {
    this._errorHandler = handler || OTLPExporter._defaultErrorHandler;
  }

  addSpan(span) {
    this._pendingSpans.push(span);
    // Auto-flush if batch is large
    if (this._pendingSpans.length >= 100) {
      this.flush();
    }
  }

  _startFlushTimer() {
    this._flushTimer = setInterval(() => {
      if (this._pendingSpans.length > 0) {
        this.flush();
      }
    }, this._flushIntervalMs);
    // Allow the process to exit even if the timer is running
    if (this._flushTimer.unref) {
      this._flushTimer.unref();
    }
  }

  flush() {
    if (this._pendingSpans.length === 0) return;

    const spans = this._pendingSpans.splice(0);
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: this._serviceName },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'loki-mode-otel', version: _scopeVersion },
              spans: spans.map((s) => s.toOTLP()),
            },
          ],
        },
      ],
    };

    this._send('/v1/traces', payload);
    return payload;
  }

  flushMetrics(metricsList) {
    if (!metricsList || metricsList.length === 0) return;

    const metrics = metricsList.map((m) => m.toOTLP());

    // Reset histogram sample arrays after export so they don't grow unboundedly
    // between flush cycles. Bucket counts are recomputed from the fresh arrays
    // on the next flush.
    for (const m of metricsList) {
      if (m instanceof Histogram) {
        m._values = [];
        for (const key of Object.keys(m._labeledValues)) {
          m._labeledValues[key] = [];
        }
      }
    }

    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: this._serviceName },
              },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: 'loki-mode-otel', version: _scopeVersion },
              metrics,
            },
          ],
        },
      ],
    };

    this._send('/v1/metrics', payload);
    return payload;
  }

  _send(path, payload) {
    const url = new URL(this._endpoint + path);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? require('https') : require('http');

    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = httpModule.request(options, (res) => {
      // Consume response to free socket
      res.resume();
    });

    req.on('error', (err) => {
      // Log but never throw - observability should never break the application
      try {
        this._errorHandler(err);
      } catch (_) {
        // Error handler itself failed; swallow to protect the app
      }
    });

    req.write(body);
    req.end();
  }

  shutdown() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this.flush();
  }
}

// -------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------

let _initialized = false;
let _tracerProvider = null;
let _meterProvider = null;
let _realSDKProvider = null;
let _usingRealSDK = false;

function initialize() {
  if (_initialized) return;

  const endpoint = process.env.LOKI_OTEL_ENDPOINT;
  if (!endpoint) {
    throw new Error('LOKI_OTEL_ENDPOINT is not set. Use index.js for conditional loading.');
  }

  // Try real OpenTelemetry SDK first, fall back to custom OTLP exporter
  let usingRealSDK = false;
  try {
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const api = require('@opentelemetry/api');

    const exporter = new OTLPTraceExporter({ url: endpoint + '/v1/traces' });
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();

    _tracerProvider = {
      getTracer: (name) => api.trace.getTracer(name),
    };
    _meterProvider = {
      getMeter: (name) => ({
        createCounter: (n, desc, unit) => new Counter(n, desc, unit),
        createGauge: (n, desc, unit) => new Gauge(n, desc, unit),
        createHistogram: (n, desc, unit, boundaries) => new Histogram(n, desc, unit, boundaries),
      }),
    };
    _realSDKProvider = provider;
    usingRealSDK = true;
  } catch (_sdkErr) {
    // Real SDK not available -- fall back to custom OTLP exporter
    _activeExporter = new OTLPExporter(endpoint);
    _tracerProvider = {
      getTracer: (name) => ({
        startSpan: (spanName, options) => {
          const opts = options || {};
          return new Span(
            spanName,
            opts.traceId,
            opts.parentSpanId,
            opts.attributes
          );
        },
      }),
    };

    _meterProvider = {
      getMeter: (name) => ({
        createCounter: (n, desc, unit) => new Counter(n, desc, unit),
        createGauge: (n, desc, unit) => new Gauge(n, desc, unit),
        createHistogram: (n, desc, unit, boundaries) => new Histogram(n, desc, unit, boundaries),
      }),
    };
  }

  _initialized = true;
  _usingRealSDK = usingRealSDK;
}

function shutdown() {
  if (_realSDKProvider) {
    try { _realSDKProvider.shutdown(); } catch (_e) { /* ignore */ }
    _realSDKProvider = null;
  }
  if (_activeExporter) {
    _activeExporter.shutdown();
  }
  _activeExporter = null;
  _initialized = false;
  _usingRealSDK = false;
  _tracerProvider = null;
  _meterProvider = null;
}

function isUsingRealSDK() {
  return _usingRealSDK;
}

function isInitialized() {
  return _initialized;
}

function getExporter() {
  return _activeExporter;
}

module.exports = {
  initialize,
  shutdown,
  isInitialized,
  isUsingRealSDK,
  getExporter,
  get tracerProvider() {
    return _tracerProvider;
  },
  get meterProvider() {
    return _meterProvider;
  },
  // Exported for testing and direct use
  Span,
  Counter,
  Gauge,
  Histogram,
  SpanStatusCode,
  OTLPExporter,
  generateTraceId,
  generateSpanId,
  nowNanos,
  MAX_METRIC_CARDINALITY,
  MAX_HISTOGRAM_SAMPLES,
};
