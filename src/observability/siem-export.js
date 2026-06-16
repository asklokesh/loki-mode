'use strict';

/**
 * SIEM event export for audit/security events.
 *
 * Two well-specified, vendor-agnostic export formats:
 *   1. CEF (Common Event Format) - ArcSight/QRadar/most SIEMs accept it.
 *   2. Splunk HEC (HTTP Event Collector) JSON - Splunk's native ingest API.
 *
 * Design mirrors src/observability/otel.js:
 *   - Zero egress unless an endpoint env var is configured (auto-detect, no
 *     required flags).
 *   - SSRF-safe endpoint validation (only http:/https:, same guard the
 *     OTLPExporter uses).
 *   - Network failures are logged, never thrown: observability must never
 *     break the application.
 *
 * Auto-detected configuration (no flags required):
 *   LOKI_SPLUNK_HEC_URL    - Splunk HEC collector URL. Presence enables HEC.
 *   LOKI_SPLUNK_HEC_TOKEN  - Splunk HEC auth token (sent as "Splunk <token>").
 *   LOKI_SPLUNK_HEC_INDEX  - optional Splunk index name.
 *   LOKI_SPLUNK_HEC_SOURCETYPE - optional sourcetype (default loki:audit).
 *   LOKI_CEF_VENDOR / LOKI_CEF_PRODUCT - override CEF vendor/product fields.
 *
 * GitHub Enterprise SAML SSO event ingestion is intentionally NOT implemented
 * here. It is a docs-only follow-up (see docs/siem-integration.md): it requires
 * an outbound API client with org-scoped admin tokens and lives outside the
 * local audit path, so no code is warranted yet.
 */

const path = require('path');

// ---------------------------------------------------------------------------
// Version (matches the OTEL scope-version pattern)
// ---------------------------------------------------------------------------

let _version = '0.0.0';
try {
  const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
  _version = pkg.version || '0.0.0';
} catch (_) {
  // Fallback if package.json is not found
}

// ---------------------------------------------------------------------------
// CEF severity mapping
// ---------------------------------------------------------------------------

// CEF severity is 0-10. Map common audit levels into that range.
const CEF_SEVERITY = {
  debug: 1,
  info: 3,
  notice: 4,
  warning: 6,
  warn: 6,
  error: 8,
  critical: 9,
  alert: 10,
  emergency: 10,
};

function cefSeverityFor(entry) {
  // Failed events are elevated regardless of declared level.
  if (entry && entry.success === false) {
    return 8;
  }
  const level = String((entry && (entry.level || entry.severity)) || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(CEF_SEVERITY, level)
    ? CEF_SEVERITY[level]
    : 3;
}

// ---------------------------------------------------------------------------
// CEF (Common Event Format) formatter
// ---------------------------------------------------------------------------

// CEF header pipes must be escaped with a backslash. Backslash itself too.
function escapeCefHeader(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    // Newlines would break the single-line record; collapse to spaces.
    .replace(/[\r\n]+/g, ' ');
}

// CEF extension values escape backslash, equals, and newlines (not pipes).
function escapeCefExtension(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Flatten the audit "details" object into dotted keys for CEF extension space.
 * Bounded depth to avoid pathological nesting.
 */
function flattenDetails(obj, prefix, out, depth) {
  if (depth > 4 || obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      flattenDetails(v, key, out, depth + 1);
    } else {
      out[key] = Array.isArray(v) ? v.join(',') : v;
    }
  }
  return out;
}

/**
 * Convert a Loki audit entry into a single-line CEF record.
 *
 * Format:
 *   CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extension
 *
 * @param {object} entry - audit entry (audit.py log_event shape or generic).
 * @param {object} [opts] - { vendor, product, version }
 * @returns {string} a single-line CEF record (no trailing newline).
 */
function toCEF(entry, opts) {
  const o = opts || {};
  const vendor = o.vendor || process.env.LOKI_CEF_VENDOR || 'Autonomi';
  const product = o.product || process.env.LOKI_CEF_PRODUCT || 'Loki Mode';
  const version = o.version || _version;

  const e = entry || {};
  // Signature id and name come from the action; fall back to "event".
  const signatureId = e.action || e.event || 'event';
  const name = e.action || e.event || 'Loki audit event';
  const severity = cefSeverityFor(e);

  const header =
    'CEF:0|' +
    escapeCefHeader(vendor) + '|' +
    escapeCefHeader(product) + '|' +
    escapeCefHeader(version) + '|' +
    escapeCefHeader(signatureId) + '|' +
    escapeCefHeader(name) + '|' +
    String(severity);

  // Build the extension key=value space. Use CEF standard keys where possible.
  const ext = {};
  if (e.timestamp) ext.rt = e.timestamp;
  if (e.user_id) ext.suser = e.user_id;
  if (e.ip_address) ext.src = e.ip_address;
  if (e.resource_type) ext.cs1 = e.resource_type;
  if (e.resource_type) ext.cs1Label = 'resourceType';
  if (e.resource_id) ext.cs2 = e.resource_id;
  if (e.resource_id) ext.cs2Label = 'resourceId';
  if (e.token_id) ext.cs3 = e.token_id;
  if (e.token_id) ext.cs3Label = 'tokenId';
  if (typeof e.success === 'boolean') ext.outcome = e.success ? 'success' : 'failure';
  if (e.error) ext.msg = e.error;

  // Flatten details under a "loki." namespace so they survive round-trips.
  if (e.details && typeof e.details === 'object') {
    flattenDetails(e.details, 'loki', ext, 0);
  }

  const extStr = Object.entries(ext)
    .map(([k, v]) => escapeCefExtension(k) + '=' + escapeCefExtension(v))
    .join(' ');

  return extStr ? header + '|' + extStr : header + '|';
}

// ---------------------------------------------------------------------------
// Splunk HEC JSON formatter
// ---------------------------------------------------------------------------

/**
 * Convert a Loki audit entry into a Splunk HEC event envelope.
 *
 * HEC expects: { time, host, source, sourcetype, index, event }
 * where "time" is epoch SECONDS (float allowed).
 *
 * @param {object} entry - audit entry.
 * @param {object} [opts] - { sourcetype, index, host, source }
 * @returns {object} the HEC envelope object (JSON-serializable).
 */
function toHEC(entry, opts) {
  const o = opts || {};
  const e = entry || {};

  let epochSeconds = Date.now() / 1000;
  if (e.timestamp) {
    const parsed = Date.parse(e.timestamp);
    if (!Number.isNaN(parsed)) {
      epochSeconds = parsed / 1000;
    }
  }

  const envelope = {
    time: epochSeconds,
    source: o.source || 'loki-mode',
    sourcetype: o.sourcetype || process.env.LOKI_SPLUNK_HEC_SOURCETYPE || 'loki:audit',
    event: e,
  };

  const host = o.host || process.env.LOKI_SERVICE_NAME;
  if (host) envelope.host = host;

  const index = o.index || process.env.LOKI_SPLUNK_HEC_INDEX;
  if (index) envelope.index = index;

  return envelope;
}

// ---------------------------------------------------------------------------
// SSRF-safe endpoint validation (mirrors OTLPExporter constructor guard)
// ---------------------------------------------------------------------------

/**
 * Validate that an endpoint URL is safe to POST to.
 * Only http: and https: schemes are permitted, matching the OTEL guard.
 *
 * @param {string} endpoint
 * @returns {URL} the parsed URL
 * @throws {Error} if the scheme is not http:/https: or the URL is malformed.
 */
function validateEndpoint(endpoint) {
  // Throws TypeError on malformed input; let it propagate to the caller.
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid SIEM endpoint scheme "${parsed.protocol}". Only http: and https: are allowed.`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Splunk HEC sender
// ---------------------------------------------------------------------------

function _defaultErrorHandler(err) {
  process.stderr.write(`[loki-siem] HEC export error: ${err && (err.message || err.code) || String(err)}\n`);
}

/**
 * Splunk HEC sender. Constructed only when an endpoint is configured.
 * No constructor side effects beyond validating the endpoint.
 */
class HECSender {
  constructor(endpoint, token, opts) {
    // SSRF guard up front. Mirrors OTLPExporter.
    this._url = validateEndpoint(endpoint);
    this._token = token || '';
    const o = opts || {};
    this._sourcetype = o.sourcetype;
    this._index = o.index;
    this._host = o.host;
    this._source = o.source;
    this._errorHandler = o.errorHandler || _defaultErrorHandler;
  }

  /**
   * Send a single audit entry to Splunk HEC. Fire-and-forget.
   * Returns the serialized body (for testing/inspection).
   */
  send(entry) {
    const envelope = toHEC(entry, {
      sourcetype: this._sourcetype,
      index: this._index,
      host: this._host,
      source: this._source,
    });
    const body = JSON.stringify(envelope);
    this._post(body);
    return body;
  }

  _post(body) {
    const isHttps = this._url.protocol === 'https:';
    const httpModule = isHttps ? require('https') : require('http');

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (this._token) {
      headers.Authorization = `Splunk ${this._token}`;
    }

    const options = {
      hostname: this._url.hostname,
      port: this._url.port || (isHttps ? 443 : 80),
      path: this._url.pathname + (this._url.search || ''),
      method: 'POST',
      headers,
    };

    let req;
    try {
      req = httpModule.request(options, (res) => {
        res.resume(); // drain to free the socket
      });
    } catch (err) {
      // Synchronous construction errors must never escape.
      try { this._errorHandler(err); } catch (_) { /* swallow */ }
      return;
    }

    req.on('error', (err) => {
      // Observability must never break the application.
      try { this._errorHandler(err); } catch (_) { /* swallow */ }
    });

    req.write(body);
    req.end();
  }
}

// ---------------------------------------------------------------------------
// Auto-detection: build a sender only when an endpoint env var is present.
// No env var configured => null => zero egress.
// ---------------------------------------------------------------------------

/**
 * Build a Splunk HEC sender from the environment, or return null when no HEC
 * endpoint is configured. This is the "no egress unless configured" gate.
 *
 * @param {object} [env] - environment override (defaults to process.env).
 * @returns {HECSender|null}
 */
function createHECSenderFromEnv(env) {
  const e = env || process.env;
  const url = (e.LOKI_SPLUNK_HEC_URL || '').trim();
  if (!url) return null; // Not configured: never send.
  return new HECSender(url, (e.LOKI_SPLUNK_HEC_TOKEN || '').trim(), {
    sourcetype: e.LOKI_SPLUNK_HEC_SOURCETYPE,
    index: e.LOKI_SPLUNK_HEC_INDEX,
    host: e.LOKI_SERVICE_NAME,
  });
}

/**
 * Whether any SIEM exporter is configured via the environment.
 * @param {object} [env]
 * @returns {boolean}
 */
function isConfigured(env) {
  const e = env || process.env;
  return Boolean((e.LOKI_SPLUNK_HEC_URL || '').trim());
}

// ---------------------------------------------------------------------------
// Ready-to-use OTEL collector templates for popular vendors.
//
// These are NOT egress: they are env-var recipes a user copies. Each returns
// the set of env vars to export so the existing OTEL bridge (otel.js) ships to
// that vendor's OTLP/HTTP endpoint. Region/site and API key are injected by
// the caller. Documented in docs/siem-integration.md.
// ---------------------------------------------------------------------------

const OTEL_TEMPLATES = {
  /**
   * Datadog OTLP intake. Datadog accepts OTLP/HTTP at its agent or, with the
   * OTel collector contrib exporter, directly. The common path is the Datadog
   * Agent's OTLP receiver on :4318. For Agentless intake use the collector.
   * site examples: datadoghq.com, datadoghq.eu, us5.datadoghq.com
   */
  datadog(opts) {
    const o = opts || {};
    const endpoint = o.endpoint || 'http://localhost:4318';
    const vars = {
      LOKI_OTEL_ENDPOINT: endpoint,
      LOKI_SERVICE_NAME: o.serviceName || 'loki-mode',
    };
    // Header is honored by the @opentelemetry exporter when the real SDK path
    // is active. The built-in JSON exporter posts to a local agent that holds
    // the API key, so the header is optional there.
    if (o.apiKey) {
      vars.OTEL_EXPORTER_OTLP_HEADERS = `dd-api-key=${o.apiKey}`;
    }
    if (o.site) {
      vars.OTEL_RESOURCE_ATTRIBUTES =
        `deployment.environment=${o.environment || 'production'},dd.site=${o.site}`;
    }
    return vars;
  },

  /**
   * Honeycomb OTLP/HTTP. Honeycomb ingests OTLP directly at
   * https://api.honeycomb.io (or api.eu1.honeycomb.io). Auth via the
   * x-honeycomb-team header; dataset via x-honeycomb-dataset for metrics.
   */
  honeycomb(opts) {
    const o = opts || {};
    const endpoint = o.endpoint || 'https://api.honeycomb.io';
    const headers = [];
    if (o.apiKey) headers.push(`x-honeycomb-team=${o.apiKey}`);
    if (o.dataset) headers.push(`x-honeycomb-dataset=${o.dataset}`);
    const vars = {
      LOKI_OTEL_ENDPOINT: endpoint,
      LOKI_SERVICE_NAME: o.serviceName || 'loki-mode',
    };
    if (headers.length) {
      vars.OTEL_EXPORTER_OTLP_HEADERS = headers.join(',');
    }
    return vars;
  },
};

module.exports = {
  // Formatters
  toCEF,
  toHEC,
  cefSeverityFor,
  escapeCefHeader,
  escapeCefExtension,
  // Endpoint safety
  validateEndpoint,
  // HEC sender
  HECSender,
  createHECSenderFromEnv,
  isConfigured,
  // OTEL vendor templates
  OTEL_TEMPLATES,
  // Version (for testing)
  _version,
};
