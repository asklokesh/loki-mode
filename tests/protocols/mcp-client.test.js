'use strict';

var test = require('node:test');
var describe = test.describe;
var it = test.it;
var beforeEach = test.beforeEach;
var afterEach = test.afterEach;
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var os = require('os');
var mod = require('../../src/protocols/mcp-client');
var MCPClient = mod.MCPClient;
var MAX_BUFFER_BYTES = mod.MAX_BUFFER_BYTES;
var validateCommand = mod.validateCommand;

// Write mock server to unique temp path to avoid race conditions
var MOCK_SERVER_SCRIPT;

function ensureMockServer() {
  MOCK_SERVER_SCRIPT = path.join(os.tmpdir(), '_mock-mcp-server-' + process.pid + '-' + Date.now() + '.js');
  var script = `'use strict';
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) handleLine(line);
  }
});
process.stdin.resume();

function handleLine(line) {
  let req;
  try { req = JSON.parse(line); } catch(e) { return; }
  if (req.id === undefined || req.id === null) return;

  let result;
  switch (req.method) {
    case 'initialize':
      result = { serverInfo: { name: 'mock-server', version: '1.0.0' }, capabilities: { tools: {} } };
      break;
    case 'tools/list':
      result = { tools: [
        { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
        { name: 'add', description: 'Add', inputSchema: { type: 'object' } }
      ]};
      break;
    case 'tools/call':
      if (req.params && req.params.name === 'echo') {
        result = { content: [{ type: 'text', text: (req.params.arguments && req.params.arguments.message) || '' }] };
      } else if (req.params && req.params.name === 'add') {
        const a = (req.params.arguments && req.params.arguments.a) || 0;
        const b = (req.params.arguments && req.params.arguments.b) || 0;
        result = { content: [{ type: 'text', text: String(a + b) }] };
      } else if (req.params && req.params.name === 'fail') {
        result = { isError: true, content: [{ type: 'text', text: 'Tool failed' }] };
      } else if (req.params && req.params.name === 'slow') {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'slow done' }] }, id: req.id }) + '\\n');
        }, 2000);
        return;
      } else {
        result = { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
      }
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: req.id }) + '\\n');
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', result: result, id: req.id }) + '\\n');
}
`;
  fs.writeFileSync(MOCK_SERVER_SCRIPT, script, 'utf8');
}

function cleanupMockServer() {
  if (MOCK_SERVER_SCRIPT) { try { fs.unlinkSync(MOCK_SERVER_SCRIPT); } catch (_) {} }
}

describe('MCPClient', function() {
  beforeEach(function() { ensureMockServer(); });
  afterEach(async function() { cleanupMockServer(); });

  describe('constructor', function() {
    it('requires config with name', function() {
      assert.throws(function() { new MCPClient(); }, /requires a config/);
      assert.throws(function() { new MCPClient({}); }, /requires a config/);
    });

    it('accepts valid config', function() {
      var client = new MCPClient({ name: 'test', command: 'node', args: ['server.js'] });
      assert.equal(client.name, 'test');
      assert.equal(client.connected, false);
    });
  });

  describe('command validation', function() {
    it('rejects bare shell names', function() {
      ['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].forEach(function(cmd) {
        assert.throws(function() { new MCPClient({ name: 'x', command: cmd }); }, /blocked shell interpreter/);
      });
    });

    it('rejects absolute paths to shell interpreters', function() {
      assert.throws(function() { new MCPClient({ name: 'x', command: '/bin/bash' }); }, /blocked/);
      assert.throws(function() { new MCPClient({ name: 'x', command: '/bin/sh' }); }, /blocked/);
    });

    it('rejects .exe shell variants', function() {
      assert.throws(function() { new MCPClient({ name: 'x', command: 'powershell.exe' }); }, /blocked/);
      assert.throws(function() { new MCPClient({ name: 'x', command: 'cmd.exe' }); }, /blocked/);
    });

    it('allows legitimate commands', function() {
      assert.doesNotThrow(function() { new MCPClient({ name: 'x', command: 'node' }); });
      assert.doesNotThrow(function() { new MCPClient({ name: 'x', command: 'npx' }); });
      assert.doesNotThrow(function() { new MCPClient({ name: 'x', command: 'python3' }); });
    });

    it('validateCommand throws for blocked commands', function() {
      assert.throws(function() { validateCommand('bash'); }, /blocked/);
      assert.throws(function() { validateCommand(''); }, /non-empty/);
    });

    it('validateCommand accepts safe commands', function() {
      assert.doesNotThrow(function() { validateCommand('node'); });
      assert.doesNotThrow(function() { validateCommand('python3'); });
    });
  });

  describe('stdio connection lifecycle', function() {
    var client;
    afterEach(async function() { if (client) { await client.shutdown(); client = null; } });

    it('connects, handshakes, and discovers tools', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      var tools = await client.connect();
      assert.equal(client.connected, true);
      assert.ok(Array.isArray(tools));
      assert.equal(tools.length, 2);
      var names = tools.map(function(t) { return t.name; });
      assert.ok(names.includes('echo'));
      assert.ok(names.includes('add'));
    });

    it('calls a tool and gets result', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();
      var result = await client.callTool('echo', { message: 'hello world' });
      assert.ok(result.content);
      assert.equal(result.content[0].text, 'hello world');
    });

    it('calls add tool with numeric args', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();
      var result = await client.callTool('add', { a: 3, b: 7 });
      assert.equal(result.content[0].text, '10');
    });

    it('throws when calling tool without connecting', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT] });
      await assert.rejects(function() { return client.callTool('echo', { message: 'hello' }); }, /not connected/);
    });

    it('shuts down gracefully', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();
      assert.equal(client.connected, true);
      await client.shutdown();
      assert.equal(client.connected, false);
      assert.equal(client.tools, null);
      client = null;
    });

    it('handles double connect gracefully', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      var tools1 = await client.connect();
      var tools2 = await client.connect();
      assert.deepEqual(tools1, tools2);
    });

    it('handles double shutdown gracefully', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();
      await client.shutdown();
      await client.shutdown();
      client = null;
    });
  });

  describe('negotiation against the real server', function() {
    var client;
    var bridgeDir;
    afterEach(async function() {
      if (client) { await client.shutdown(); client = null; }
      if (bridgeDir) { fs.rmSync(bridgeDir, { recursive: true, force: true }); bridgeDir = null; }
    });

    function bridge() {
      bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-'));
      var script = path.join(bridgeDir, 'bridge.js');
      var serverPath = path.resolve(__dirname, '../../src/protocols/mcp-server');
      fs.writeFileSync(script, "'use strict';\n" +
        "const { handleRequest } = require(" + JSON.stringify(serverPath) + ");\n" +
        "const log = [];\n" +
        "let buf = '';\n" +
        "process.stdin.setEncoding('utf8');\n" +
        "process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) !== -1) {\n" +
        "  const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;\n" +
        "  const req = JSON.parse(line); log.push(req.method);\n" +
        "  const res = handleRequest(req);\n" +
        "  if (res) process.stdout.write(JSON.stringify(res) + '\\n');\n" +
        "  if (req.method === 'tools/list') process.stderr.write('METHODS ' + log.join(',') + '\\n');\n" +
        "} });\nprocess.stdin.resume();\n");
      return script;
    }

    it('adopts the negotiated version and sends notifications/initialized', async function() {
      client = new MCPClient({ name: 'real', command: 'node', args: [bridge()], timeout: 5000 });
      var stderr = '';
      client.on('stderr', function(e) { stderr += e.data; });
      await client.connect();
      assert.equal(client.protocolVersion, '2025-11-25');
      assert.ok(client.serverInfo && client.serverInfo.name === 'loki-mode');
      await new Promise(function(r) { setTimeout(r, 100); });
      assert.match(stderr, /METHODS initialize,notifications\/initialized,tools\/list/);
    });
  });

  describe('concurrent connect() calls', function() {
    var client;
    afterEach(async function() { if (client) { await client.shutdown(); client = null; } });

    it('concurrent connect() calls resolve to the same tools without double-spawning', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      var results = await Promise.all([client.connect(), client.connect()]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(client.connected, true);
      assert.ok(client._process !== null);
    });

    it('connect() after successful connect returns cached tools', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      var tools1 = await client.connect();
      assert.equal(client._connectingPromise, null);
      var tools2 = await client.connect();
      assert.deepEqual(tools1, tools2);
    });
  });

  describe('spawn error handling', function() {
    it('rejects connect() fast when command does not exist', async function() {
      var client = new MCPClient({ name: 'bad', command: 'node-does-not-exist-xyzzy', timeout: 5000 });
      var start = Date.now();
      await assert.rejects(function() { return client.connect(); }, /spawn|ENOENT|not found/i);
      var elapsed = Date.now() - start;
      assert.ok(elapsed < 3000, 'Should fail fast but took ' + elapsed + 'ms');
    });
  });

  describe('timeout handling', function() {
    var client;
    afterEach(async function() { if (client) { await client.shutdown(); client = null; } });

    it('rejects when timeout expires', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();

      var shortClient = new MCPClient({ name: 'mock-short', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 200 });
      try {
        await shortClient.connect();
        await assert.rejects(function() { return shortClient.callTool('slow', {}); }, /Timeout/);
      } finally {
        await shortClient.shutdown();
      }
    });
  });

  describe('invalid response handling', function() {
    var client;
    afterEach(async function() { if (client) { await client.shutdown(); client = null; } });

    it('handles error responses from server', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();
      var result = await client.callTool('fail', {});
      assert.ok(result.isError);
      assert.equal(result.content[0].text, 'Tool failed');
    });
  });

  describe('refreshTools', function() {
    var client;
    afterEach(async function() { if (client) { await client.shutdown(); client = null; } });

    it('re-fetches tool list', async function() {
      client = new MCPClient({ name: 'mock', command: 'node', args: [MOCK_SERVER_SCRIPT], timeout: 5000 });
      await client.connect();
      var tools = await client.refreshTools();
      assert.equal(tools.length, 2);
    });
  });

  describe('stdio buffer overflow protection', function() {
    it('emits error and disconnects when buffer exceeds MAX_BUFFER_BYTES', async function() {
      var overflowScript = path.join(os.tmpdir(), '_overflow-' + process.pid + '-' + Date.now() + '.js');
      var chunkSize = MAX_BUFFER_BYTES + 1024;
      fs.writeFileSync(overflowScript,
        "'use strict';\nprocess.stdin.resume();\nprocess.stdout.write(Buffer.alloc(" + chunkSize + ", 'x').toString());\n",
        'utf8'
      );

      var client = new MCPClient({ name: 'overflow', command: 'node', args: [overflowScript], timeout: 5000 });
      var errors = [];
      client.removeAllListeners('error');
      client.on('error', function(e) { errors.push(e); });

      var errorPromise = new Promise(function(resolve) { client.once('error', resolve); });

      // Start connecting (will receive overflow data from the script)
      var connectPromise = client.connect().catch(function() {});

      await Promise.race([
        errorPromise,
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout waiting for overflow')); }, 5000); })
      ]);

      assert.ok(errors.length > 0);
      assert.ok(errors.some(function(e) { return /buffer overflow/i.test(e.message); }),
        'Expected buffer overflow error, got: ' + errors.map(function(e) { return e.message; }).join(', '));

      await connectPromise;
      try { fs.unlinkSync(overflowScript); } catch (_) {}
    });
  });
});
