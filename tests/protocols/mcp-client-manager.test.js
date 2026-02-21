'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { MCPClientManager } = require('../../src/protocols/mcp-client-manager');

// ---------------------------------------------------------------------------
// Helpers: temporary config directory and mock server
// ---------------------------------------------------------------------------

const MOCK_SERVER_SCRIPT = path.join(__dirname, '_mock-mcp-server-mgr.js');

function createMockServerScript() {
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

const serverName = process.env.MOCK_SERVER_NAME || 'mock';
const toolPrefix = process.env.MOCK_TOOL_PREFIX || '';

function handleLine(line) {
  let req;
  try { req = JSON.parse(line); } catch(e) { return; }
  if (req.id === undefined || req.id === null) return;

  let result;
  switch (req.method) {
    case 'initialize':
      result = {
        serverInfo: { name: serverName, version: '1.0.0', protocolVersion: '2024-11-05' },
        capabilities: { tools: {} }
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          { name: toolPrefix + 'ping', description: 'Ping', inputSchema: { type: 'object' } },
          { name: toolPrefix + 'info', description: 'Info', inputSchema: { type: 'object' } }
        ]
      };
      break;
    case 'tools/call':
      if (req.params && req.params.name) {
        result = { content: [{ type: 'text', text: 'result from ' + serverName + ':' + req.params.name }] };
      } else {
        result = { isError: true, content: [{ type: 'text', text: 'Missing tool name' }] };
      }
      break;
    default:
      const errResp = { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: req.id };
      process.stdout.write(JSON.stringify(errResp) + '\\n');
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', result: result, id: req.id }) + '\\n');
}
`;
  fs.writeFileSync(MOCK_SERVER_SCRIPT, script, 'utf8');
}

function removeMockServerScript() {
  try { fs.unlinkSync(MOCK_SERVER_SCRIPT); } catch (_) {}
}

let tmpDir;

function createTmpConfig(content) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-mcp-test-'));
  if (typeof content === 'string') {
    // YAML
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), content, 'utf8');
  } else {
    // JSON
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(content, null, 2), 'utf8');
  }
  return tmpDir;
}

function cleanupTmpDir() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
}

describe('MCPClientManager', () => {
  beforeEach(() => {
    createMockServerScript();
  });

  afterEach(async () => {
    removeMockServerScript();
    cleanupTmpDir();
  });

  describe('no config = no-op', () => {
    it('returns empty tools when no config exists', async () => {
      const nonExistentDir = path.join(os.tmpdir(), 'loki-no-config-' + Date.now());
      const manager = new MCPClientManager({ configDir: nonExistentDir });
      const tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      assert.equal(manager.initialized, true);
      assert.equal(manager.serverCount, 0);
      await manager.shutdown();
    });

    it('returns empty tools when config has no mcp_servers', async () => {
      const dir = createTmpConfig({ other_key: 'value' });
      const manager = new MCPClientManager({ configDir: dir });
      const tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      await manager.shutdown();
    });

    it('returns empty tools when mcp_servers is empty', async () => {
      const dir = createTmpConfig({ mcp_servers: [] });
      const manager = new MCPClientManager({ configDir: dir });
      const tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      await manager.shutdown();
    });
  });

  describe('JSON config', () => {
    it('connects to a single server and discovers tools', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          {
            name: 'alpha',
            command: 'node',
            args: [MOCK_SERVER_SCRIPT]
          }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      const tools = await manager.discoverTools();

      assert.equal(manager.initialized, true);
      assert.equal(manager.serverCount, 1);
      assert.equal(tools.length, 2);

      const names = tools.map((t) => t.name);
      assert.ok(names.includes('ping'));
      assert.ok(names.includes('info'));

      await manager.shutdown();
    });

    it('routes tool calls to correct server', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          { name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      await manager.discoverTools();

      const result = await manager.callTool('ping', {});
      assert.ok(result.content);
      assert.ok(result.content[0].text.includes('ping'));

      await manager.shutdown();
    });

    it('throws for unknown tool', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          { name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      await manager.discoverTools();

      await assert.rejects(
        () => manager.callTool('nonexistent', {}),
        /No server found for tool/
      );

      await manager.shutdown();
    });
  });

  describe('YAML config', () => {
    it('parses minimal YAML and connects', async () => {
      const yaml = `mcp_servers:
  - name: beta
    command: node
    args: ["${MOCK_SERVER_SCRIPT.replace(/\\/g, '\\\\')}"]
`;
      const dir = createTmpConfig(yaml);

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      const tools = await manager.discoverTools();

      assert.equal(manager.serverCount, 1);
      assert.ok(tools.length > 0);

      await manager.shutdown();
    });
  });

  describe('getToolsByServer', () => {
    it('returns tools for a specific server', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          { name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      await manager.discoverTools();

      const tools = manager.getToolsByServer('alpha');
      assert.equal(tools.length, 2);

      const none = manager.getToolsByServer('nonexistent');
      assert.deepEqual(none, []);

      await manager.shutdown();
    });
  });

  describe('getAllTools', () => {
    it('returns all tools across servers', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          { name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      await manager.discoverTools();

      const tools = manager.getAllTools();
      assert.equal(tools.length, 2);

      await manager.shutdown();
    });
  });

  describe('circuit breaker integration', () => {
    it('reports server state', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          { name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      await manager.discoverTools();

      assert.equal(manager.getServerState('alpha'), 'CLOSED');
      assert.equal(manager.getServerState('nonexistent'), null);

      await manager.shutdown();
    });

    it('handles server connection failure gracefully', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          {
            name: 'broken',
            command: 'node',
            args: ['-e', 'process.exit(1)']  // Immediately exits
          }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 2000 });
      const tools = await manager.discoverTools();

      // Should not throw, but returns no tools for the broken server
      assert.equal(manager.initialized, true);
      // The server count is still 1 (it was attempted)
      assert.equal(manager.serverCount, 1);

      await manager.shutdown();
    });
  });

  describe('shutdown', () => {
    it('cleans up all clients and breakers', async () => {
      const dir = createTmpConfig({
        mcp_servers: [
          { name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }
        ]
      });

      const manager = new MCPClientManager({ configDir: dir, timeout: 5000 });
      await manager.discoverTools();
      assert.equal(manager.serverCount, 1);

      await manager.shutdown();
      assert.equal(manager.serverCount, 0);
      assert.equal(manager.initialized, false);
    });
  });
});
