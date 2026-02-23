'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

let testDir;
const origCwd = process.cwd();

before(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-transport-test-'));
  process.chdir(testDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------
// StdioTransport unit tests
// -------------------------------------------------------------------
const { StdioTransport } = require('../../src/protocols/transport/stdio');

describe('StdioTransport', () => {
  it('should be constructable with a handler', () => {
    const transport = new StdioTransport(() => null);
    assert.ok(transport);
  });

  it('should call handler with parsed JSON', async () => {
    let receivedRequest = null;
    const handler = (req) => {
      receivedRequest = req;
      return { jsonrpc: '2.0', result: {}, id: req.id };
    };

    const transport = new StdioTransport(handler);

    // Simulate _processLine directly (avoids needing real stdin)
    const responses = [];
    const origSend = transport._send.bind(transport);
    transport._running = true;
    transport._send = (data) => { responses.push(data); };

    transport._processLine('{"jsonrpc":"2.0","method":"ping","id":1}');

    // Allow async resolution
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(receivedRequest);
    assert.equal(receivedRequest.method, 'ping');
    assert.equal(receivedRequest.id, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 1);
  });

  it('should handle parse errors', async () => {
    const transport = new StdioTransport(() => null);
    const responses = [];
    transport._running = true;
    transport._send = (data) => { responses.push(data); };

    transport._processLine('not valid json');

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(responses.length, 1);
    assert.ok(responses[0].error);
    assert.equal(responses[0].error.code, -32700);
  });

  it('should handle batch requests', async () => {
    const handler = (req) => {
      return { jsonrpc: '2.0', result: { method: req.method }, id: req.id };
    };

    const transport = new StdioTransport(handler);
    const responses = [];
    transport._running = true;
    transport._send = (data) => { responses.push(data); };

    const batch = JSON.stringify([
      { jsonrpc: '2.0', method: 'ping', id: 1 },
      { jsonrpc: '2.0', method: 'ping', id: 2 }
    ]);
    transport._processLine(batch);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(responses.length, 1);
    assert.ok(Array.isArray(responses[0]));
    assert.equal(responses[0].length, 2);
  });

  it('should buffer partial lines', async () => {
    let received = [];
    const handler = (req) => {
      received.push(req);
      return { jsonrpc: '2.0', result: {}, id: req.id };
    };
    const transport = new StdioTransport(handler);
    transport._running = true;
    transport._send = () => {};

    // Send partial data - no complete line yet, handler must not be called
    transport._onData('{"jsonrpc":"2.0",');
    assert.equal(received.length, 0);

    // Complete the line
    transport._onData('"method":"ping","id":1}\n');

    // Properly await the async handler resolution
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);
  });

  it('should recover from a throwing handler in batch requests', async () => {
    let callCount = 0;
    const handler = (req) => {
      callCount++;
      if (req.id === 2) throw new Error('simulated handler error');
      return { jsonrpc: '2.0', result: {}, id: req.id };
    };

    const transport = new StdioTransport(handler);
    const responses = [];
    transport._running = true;
    transport._send = (data) => { responses.push(data); };

    const batch = JSON.stringify([
      { jsonrpc: '2.0', method: 'ping', id: 1 },
      { jsonrpc: '2.0', method: 'ping', id: 2 }
    ]);
    transport._processLine(batch);

    await new Promise((r) => setTimeout(r, 50));

    // Batch should have sent an error response rather than crashing
    assert.equal(responses.length, 1);
    const resp = responses[0];
    assert.ok(resp.error, 'Expected error response for throwing batch handler');
    assert.equal(resp.error.code, -32603);
  });

  it('should recover from a throwing handler in single requests', async () => {
    const handler = () => { throw new Error('simulated single error'); };

    const transport = new StdioTransport(handler);
    const responses = [];
    transport._running = true;
    transport._send = (data) => { responses.push(data); };

    transport._processLine('{"jsonrpc":"2.0","method":"ping","id":99}');

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(responses.length, 1);
    assert.ok(responses[0].error);
    assert.equal(responses[0].error.code, -32603);
  });
});

// -------------------------------------------------------------------
// SSETransport unit tests
// -------------------------------------------------------------------
const { SSETransport } = require('../../src/protocols/transport/sse');

describe('SSETransport', () => {
  let transport;
  let port;

  function findFreePort() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer();
      srv.listen(0, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });
  }

  function httpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  before(async () => {
    port = await findFreePort();
    const { handleRequest } = require('../../src/protocols/mcp-server');
    transport = new SSETransport(handleRequest, { port: port });
    transport.start();
    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (transport) transport.stop();
  });

  it('should respond to health check', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp/health',
      method: 'GET'
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, 'ok');
    assert.equal(data.transport, 'sse');
  });

  it('should handle JSON-RPC POST requests', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1
    });
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, body);

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.jsonrpc, '2.0');
    assert.equal(data.id, 1);
    assert.ok(data.result.serverInfo);
  });

  it('should handle tools/list over HTTP', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2
    });
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, body);

    const data = JSON.parse(res.body);
    assert.equal(data.result.tools.length, 5);
  });

  it('should handle tool calls over HTTP', async () => {
    // Initialize .loki dir for the tool
    fs.mkdirSync(path.join(testDir, '.loki', 'state'), { recursive: true });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'loki/start-project',
        arguments: { prd: 'HTTP test project for SSE transport.' }
      },
      id: 3
    });
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, body);

    const data = JSON.parse(res.body);
    assert.equal(data.id, 3);
    const toolResult = JSON.parse(data.result.content[0].text);
    assert.ok(toolResult.success);
    assert.ok(toolResult.projectId);
  });

  it('should return 400 for invalid JSON', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, 'not valid json');

    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error);
    assert.equal(data.error.code, -32700);
  });

  it('should return 404 for unknown paths', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/unknown',
      method: 'GET'
    });
    assert.equal(res.statusCode, 404);
  });

  it('should handle CORS preflight', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'OPTIONS'
    });
    assert.equal(res.statusCode, 204);
    // CORS origin header must be present and must not be wildcard '*'
    const origin = res.headers['access-control-allow-origin'];
    assert.ok(origin, 'Expected access-control-allow-origin header');
    assert.notEqual(origin, '*', 'CORS origin must not be wildcard');
  });

  it('should reject POST body exceeding 10 MB', async () => {
    // Generate a body larger than MAX_BODY_BYTES (10 MB)
    const oversized = 'x'.repeat(11 * 1024 * 1024);

    // The server destroys the socket after sending 413, which may cause
    // ECONNRESET on the client side. Accept either a 413 response or a
    // connection reset as evidence of the size limit being enforced.
    let statusCode = null;
    let errorCode = null;
    try {
      const res = await httpRequest({
        hostname: '127.0.0.1',
        port: port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, oversized);
      statusCode = res.statusCode;
    } catch (err) {
      errorCode = err.code;
    }

    const gotExpectedStatus = statusCode === 413;
    const gotConnectionReset = errorCode === 'ECONNRESET' || errorCode === 'EPIPE';
    assert.ok(
      gotExpectedStatus || gotConnectionReset,
      'Expected 413 status or connection reset, got statusCode=' + statusCode + ' errorCode=' + errorCode
    );
  });

  it('should handle batch requests over HTTP', async () => {
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'ping', id: 10 },
      { jsonrpc: '2.0', method: 'ping', id: 11 }
    ]);
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, body);

    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
  });

  it('should establish SSE connection', async () => {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: port,
        path: '/mcp/events'
      }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          // We should get a connected event
          if (data.includes('event: connected')) {
            req.destroy();
            resolve();
          }
        });

        // Timeout safety
        setTimeout(() => {
          req.destroy();
          reject(new Error('SSE connection did not receive connected event'));
        }, 3000);
      });
      req.on('error', (err) => {
        // Connection destroyed is expected
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
  });
});
