'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { MCPClient } = require('../../src/protocols/mcp-client');

// ---------------------------------------------------------------------------
// Mock MCP server script (spawned as subprocess for stdio tests)
// ---------------------------------------------------------------------------

const MOCK_SERVER_SCRIPT = path.join(__dirname, '_mock-mcp-server.js');

// Create the mock server script before tests
function ensureMockServer() {
  const script = `'use strict';
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
  if (req.id === undefined || req.id === null) return; // notification

  let result;
  switch (req.method) {
    case 'initialize':
      result = {
        serverInfo: { name: 'mock-server', version: '1.0.0', protocolVersion: '2024-11-05' },
        capabilities: { tools: {} }
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          { name: 'echo', description: 'Echoes back the input', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
          { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
        ]
      };
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
        // Simulate a slow response (2s delay)
        setTimeout(() => {
          const resp = { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'slow done' }] }, id: req.id };
          process.stdout.write(JSON.stringify(resp) + '\\n');
        }, 2000);
        return; // Don't send immediate response
      } else {
        result = { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + (req.params && req.params.name) }] };
      }
      break;
    default:
      const errResp = { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: req.id };
      process.stdout.write(JSON.stringify(errResp) + '\\n');
      return;
  }

  const resp = { jsonrpc: '2.0', result: result, id: req.id };
  process.stdout.write(JSON.stringify(resp) + '\\n');
}
`;
  fs.writeFileSync(MOCK_SERVER_SCRIPT, script, 'utf8');
}

function cleanupMockServer() {
  try { fs.unlinkSync(MOCK_SERVER_SCRIPT); } catch (_) {}
}

describe('MCPClient', () => {
  beforeEach(() => {
    ensureMockServer();
  });

  afterEach(async () => {
    cleanupMockServer();
  });

  describe('constructor', () => {
    it('requires config with name', () => {
      assert.throws(() => new MCPClient(), /requires a config/);
      assert.throws(() => new MCPClient({}), /requires a config/);
    });

    it('accepts valid config', () => {
      const client = new MCPClient({ name: 'test', command: 'node', args: ['server.js'] });
      assert.equal(client.name, 'test');
      assert.equal(client.connected, false);
    });
  });

  describe('stdio connection lifecycle', () => {
    let client;

    afterEach(async () => {
      if (client) await client.shutdown();
    });

    it('connects, handshakes, and discovers tools', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      const tools = await client.connect();
      assert.equal(client.connected, true);
      assert.ok(Array.isArray(tools));
      assert.equal(tools.length, 2);

      const toolNames = tools.map((t) => t.name);
      assert.ok(toolNames.includes('echo'));
      assert.ok(toolNames.includes('add'));
    });

    it('calls a tool and gets result', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();

      const result = await client.callTool('echo', { message: 'hello world' });
      assert.ok(result.content);
      assert.equal(result.content[0].text, 'hello world');
    });

    it('calls add tool with numeric args', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();

      const result = await client.callTool('add', { a: 3, b: 7 });
      assert.ok(result.content);
      assert.equal(result.content[0].text, '10');
    });

    it('throws when calling tool without connecting', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT]
      });

      await assert.rejects(
        () => client.callTool('echo', { message: 'hello' }),
        /not connected/
      );
    });

    it('shuts down gracefully', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();
      assert.equal(client.connected, true);

      await client.shutdown();
      assert.equal(client.connected, false);
      assert.equal(client.tools, null);
    });

    it('handles double connect gracefully', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      const tools1 = await client.connect();
      const tools2 = await client.connect(); // Should return cached
      assert.deepEqual(tools1, tools2);
    });

    it('handles double shutdown gracefully', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();
      await client.shutdown();
      await client.shutdown(); // Should not throw
    });
  });

  describe('timeout handling', () => {
    let client;

    afterEach(async () => {
      if (client) await client.shutdown();
    });

    it('rejects when timeout expires', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();

      // Create a client with very short timeout for the call
      // We need to directly call a tool that delays
      // Alternatively, reduce the timeout and call slow tool
      const shortClient = new MCPClient({
        name: 'mock-short',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 200  // Very short timeout
      });

      await shortClient.connect();

      await assert.rejects(
        () => shortClient.callTool('slow', {}),
        /Timeout/
      );

      await shortClient.shutdown();
    });
  });

  describe('invalid response handling', () => {
    let client;

    afterEach(async () => {
      if (client) await client.shutdown();
    });

    it('handles error responses from server', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();

      // Call a tool the mock server does not know about -- returns isError result
      const result = await client.callTool('fail', {});
      assert.ok(result.isError);
      assert.equal(result.content[0].text, 'Tool failed');
    });
  });

  describe('refreshTools', () => {
    let client;

    afterEach(async () => {
      if (client) await client.shutdown();
    });

    it('re-fetches tool list', async () => {
      client = new MCPClient({
        name: 'mock',
        command: 'node',
        args: [MOCK_SERVER_SCRIPT],
        timeout: 5000
      });

      await client.connect();
      const tools = await client.refreshTools();
      assert.equal(tools.length, 2);
    });
  });
});
