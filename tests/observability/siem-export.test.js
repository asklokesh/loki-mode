'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const siem = require('../../src/observability/siem-export');

// A representative Loki audit entry (matches dashboard/audit.py log_event shape).
const SAMPLE_ENTRY = {
  timestamp: '2026-02-15T14:30:00.000Z',
  action: 'revoke_token',
  resource_type: 'token',
  resource_id: 'tok_123',
  user_id: 'alice',
  token_id: 'tok_admin',
  ip_address: '10.0.0.4',
  success: false,
  error: 'expired credential',
  level: 'warning',
  details: { provider: 'claude', cost: 4.25, nested: { region: 'us-east' } },
};

describe('siem-export: CEF formatter', () => {
  it('produces a single-line CEF:0 record with the correct 7-field header', () => {
    const cef = siem.toCEF(SAMPLE_ENTRY, { version: '9.9.9' });
    assert.ok(!cef.includes('\n'), 'CEF record must be single-line');
    // CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extension
    const headerAndExt = cef.split('|');
    assert.equal(headerAndExt[0], 'CEF:0');
    assert.equal(headerAndExt[1], 'Autonomi');
    assert.equal(headerAndExt[2], 'Loki Mode');
    assert.equal(headerAndExt[3], '9.9.9');
    assert.equal(headerAndExt[4], 'revoke_token'); // signature id from action
    assert.equal(headerAndExt[5], 'revoke_token'); // name from action
  });

  it('elevates severity for failed events', () => {
    assert.equal(siem.cefSeverityFor({ success: false, level: 'info' }), 8);
    assert.equal(siem.cefSeverityFor({ success: true, level: 'info' }), 3);
    assert.equal(siem.cefSeverityFor({ level: 'critical' }), 9);
  });

  it('maps audit fields into CEF extension keys', () => {
    const cef = siem.toCEF(SAMPLE_ENTRY);
    assert.match(cef, /rt=2026-02-15T14:30:00\.000Z/);
    assert.match(cef, /suser=alice/);
    assert.match(cef, /src=10\.0\.0\.4/);
    assert.match(cef, /outcome=failure/);
    assert.match(cef, /cs1=token/);
    assert.match(cef, /cs1Label=resourceType/);
  });

  it('flattens nested details under the loki. namespace', () => {
    const cef = siem.toCEF(SAMPLE_ENTRY);
    assert.match(cef, /loki\.provider=claude/);
    assert.match(cef, /loki\.cost=4\.25/);
    assert.match(cef, /loki\.nested\.region=us-east/);
  });

  it('escapes pipes and backslashes in header fields', () => {
    const cef = siem.toCEF({ action: 'weird|name\\here' });
    // The pipe and backslash in the name must be escaped so they do not
    // create phantom header fields.
    assert.match(cef, /weird\\\|name\\\\here/);
  });

  it('escapes equals and newlines in extension values', () => {
    const cef = siem.toCEF({ action: 'x', error: 'a=b\nc' });
    assert.match(cef, /msg=a\\=b\\nc/);
    assert.ok(!cef.includes('\n'), 'newline in value must be escaped, not literal');
  });
});

describe('siem-export: Splunk HEC formatter', () => {
  it('wraps the entry in a HEC envelope with epoch-seconds time', () => {
    const env = siem.toHEC(SAMPLE_ENTRY, { sourcetype: 'loki:audit', index: 'security' });
    assert.equal(env.sourcetype, 'loki:audit');
    assert.equal(env.index, 'security');
    assert.equal(env.source, 'loki-mode');
    // 2026-02-15T14:30:00.000Z => 1771166400 seconds
    assert.equal(env.time, Date.parse('2026-02-15T14:30:00.000Z') / 1000);
    assert.deepEqual(env.event, SAMPLE_ENTRY);
  });

  it('defaults sourcetype to loki:audit and omits index when unset', () => {
    const env = siem.toHEC({ action: 'login' });
    assert.equal(env.sourcetype, 'loki:audit');
    assert.ok(!('index' in env));
  });
});

describe('siem-export: SSRF-safe endpoint validation', () => {
  it('accepts http and https', () => {
    assert.ok(siem.validateEndpoint('http://splunk.local:8088/services/collector'));
    assert.ok(siem.validateEndpoint('https://splunk.example.com:8088/x'));
  });

  it('rejects non-http(s) schemes (file:, gopher:, ftp:)', () => {
    assert.throws(() => siem.validateEndpoint('file:///etc/passwd'), /Only http: and https:/);
    assert.throws(() => siem.validateEndpoint('gopher://x'), /Only http: and https:/);
    assert.throws(() => siem.validateEndpoint('ftp://x/y'), /Only http: and https:/);
  });

  it('rejects malformed URLs', () => {
    assert.throws(() => siem.validateEndpoint('not a url'));
  });

  it('HECSender constructor enforces the same guard', () => {
    assert.throws(() => new siem.HECSender('file:///etc/passwd', 'tok'), /Only http: and https:/);
  });
});

describe('siem-export: no egress without endpoint', () => {
  const SIEM_ENV_KEYS = [
    'LOKI_SPLUNK_HEC_URL', 'LOKI_SPLUNK_HEC_TOKEN',
    'LOKI_SPLUNK_HEC_INDEX', 'LOKI_SPLUNK_HEC_SOURCETYPE',
  ];
  const saved = {};

  beforeEach(() => {
    for (const k of SIEM_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of SIEM_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('isConfigured() is false and createHECSenderFromEnv() is null with no env', () => {
    assert.equal(siem.isConfigured(), false);
    assert.equal(siem.createHECSenderFromEnv(), null);
  });

  it('isConfigured() is true once LOKI_SPLUNK_HEC_URL is set', () => {
    assert.equal(siem.isConfigured({ LOKI_SPLUNK_HEC_URL: 'http://x:8088' }), true);
    assert.ok(siem.createHECSenderFromEnv({ LOKI_SPLUNK_HEC_URL: 'http://x:8088' }));
  });

  it('makes ZERO network connections when no endpoint is configured', async () => {
    // Stand up a local server. If anything connects, the test fails.
    let connections = 0;
    const server = http.createServer((req, res) => {
      connections += 1;
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // No env configured -> sender is null -> no possible egress.
    const sender = siem.createHECSenderFromEnv();
    assert.equal(sender, null);

    // Formatters are pure and must also never touch the network.
    siem.toCEF(SAMPLE_ENTRY);
    siem.toHEC(SAMPLE_ENTRY);

    // Give any (erroneously) scheduled request a tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 0, 'no connections expected without an endpoint');

    await new Promise((resolve) => server.close(resolve));
  });

  it('DOES send to the configured endpoint (round-trip proof egress works when enabled)', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body });
        res.end('{"text":"Success","code":0}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const sender = siem.createHECSenderFromEnv({
      LOKI_SPLUNK_HEC_URL: `http://127.0.0.1:${port}/services/collector`,
      LOKI_SPLUNK_HEC_TOKEN: 'secret-token',
      LOKI_SPLUNK_HEC_INDEX: 'security',
    });
    assert.ok(sender);
    const sentBody = sender.send(SAMPLE_ENTRY);

    // Wait for the async POST to arrive.
    const deadline = Date.now() + 2000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(received.length, 1, 'server should have received exactly one event');
    assert.equal(received[0].auth, 'Splunk secret-token', 'HEC token sent as Splunk auth header');

    const envelope = JSON.parse(received[0].body);
    assert.equal(envelope.sourcetype, 'loki:audit');
    assert.equal(envelope.index, 'security');
    assert.deepEqual(envelope.event, SAMPLE_ENTRY);
    assert.equal(received[0].body, sentBody, 'returned body matches what was sent');

    await new Promise((resolve) => server.close(resolve));
  });
});

describe('siem-export: OTEL vendor templates', () => {
  it('datadog template sets LOKI_OTEL_ENDPOINT and dd-api-key header', () => {
    const vars = siem.OTEL_TEMPLATES.datadog({ apiKey: 'dd-key', site: 'datadoghq.eu' });
    assert.equal(vars.LOKI_OTEL_ENDPOINT, 'http://localhost:4318');
    assert.match(vars.OTEL_EXPORTER_OTLP_HEADERS, /dd-api-key=dd-key/);
    assert.match(vars.OTEL_RESOURCE_ATTRIBUTES, /dd\.site=datadoghq\.eu/);
  });

  it('honeycomb template sets endpoint and x-honeycomb-team header', () => {
    const vars = siem.OTEL_TEMPLATES.honeycomb({ apiKey: 'hc-key', dataset: 'loki' });
    assert.equal(vars.LOKI_OTEL_ENDPOINT, 'https://api.honeycomb.io');
    assert.match(vars.OTEL_EXPORTER_OTLP_HEADERS, /x-honeycomb-team=hc-key/);
    assert.match(vars.OTEL_EXPORTER_OTLP_HEADERS, /x-honeycomb-dataset=loki/);
  });

  it('templates emit no secrets when none are provided', () => {
    const dd = siem.OTEL_TEMPLATES.datadog({});
    assert.ok(!('OTEL_EXPORTER_OTLP_HEADERS' in dd));
    const hc = siem.OTEL_TEMPLATES.honeycomb({});
    assert.ok(!('OTEL_EXPORTER_OTLP_HEADERS' in hc));
  });
});
