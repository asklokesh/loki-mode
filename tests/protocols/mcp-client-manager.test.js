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
var mod = require('../../src/protocols/mcp-client-manager');
var MCPClientManager = mod.MCPClientManager;
var validateConfigDir = mod.validateConfigDir;

var MOCK_SERVER_SCRIPT;

function createMockServerScript() {
  MOCK_SERVER_SCRIPT = path.join(os.tmpdir(), '_mock-mcp-server-mgr-' + process.pid + '-' + Date.now() + '.js');
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

const serverName = process.env.MOCK_SERVER_NAME || 'mock';
const toolPrefix = process.env.MOCK_TOOL_PREFIX || '';

function handleLine(line) {
  let req;
  try { req = JSON.parse(line); } catch(e) { return; }
  if (req.id === undefined || req.id === null) return;

  let result;
  switch (req.method) {
    case 'initialize':
      result = { serverInfo: { name: serverName, version: '1.0.0' }, capabilities: { tools: {} } };
      break;
    case 'tools/list':
      result = { tools: [
        { name: toolPrefix + 'ping', description: 'Ping', inputSchema: { type: 'object' } },
        { name: toolPrefix + 'info', description: 'Info', inputSchema: { type: 'object' } }
      ]};
      break;
    case 'tools/call':
      result = req.params && req.params.name
        ? { content: [{ type: 'text', text: 'result from ' + serverName + ':' + req.params.name }] }
        : { isError: true, content: [{ type: 'text', text: 'Missing tool name' }] };
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

function removeMockServerScript() {
  if (MOCK_SERVER_SCRIPT) { try { fs.unlinkSync(MOCK_SERVER_SCRIPT); } catch (_) {} }
}

var tmpDir;
var activeManagers = [];

// Create temp config dir inside cwd so configDir validation passes.
function createTmpConfig(content) {
  var base = path.join(process.cwd(), '.loki-test-tmp');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(base, 'mcp-test-'));
  if (typeof content === 'string') {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), content, 'utf8');
  } else {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(content, null, 2), 'utf8');
  }
  return tmpDir;
}

function trackManager(manager) {
  activeManagers.push(manager);
  return manager;
}

// Force-kill all child processes from tracked managers to prevent lingering handles
async function forceCleanupManagers() {
  for (var i = 0; i < activeManagers.length; i++) {
    var m = activeManagers[i];
    try {
      for (var client of m._clients.values()) {
        if (client._process) {
          try { client._process.kill('SIGKILL'); } catch (_) {}
        }
      }
      await m.shutdown();
    } catch (_) {}
  }
  activeManagers = [];
}

function cleanupTmpDir() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
  var base = path.join(process.cwd(), '.loki-test-tmp');
  try {
    if (fs.readdirSync(base).length === 0) fs.rmdirSync(base);
  } catch (_) {}
}

describe('MCPClientManager', function() {
  beforeEach(function() { createMockServerScript(); activeManagers = []; });
  afterEach(async function() { await forceCleanupManagers(); removeMockServerScript(); cleanupTmpDir(); });

  describe('configDir validation', function() {
    it('rejects configDir pointing outside project root', function() {
      assert.throws(function() { new MCPClientManager({ configDir: '/etc' }); }, /outside the project root/);
    });

    it('rejects configDir with path traversal sequences', function() {
      assert.throws(function() { new MCPClientManager({ configDir: '../../etc' }); }, /outside the project root/);
    });

    it('accepts configDir inside project root', function() {
      assert.doesNotThrow(function() { new MCPClientManager({ configDir: '.loki' }); });
    });

    it('accepts absolute configDir inside project root', function() {
      var inside = path.join(process.cwd(), '.loki');
      assert.doesNotThrow(function() { new MCPClientManager({ configDir: inside }); });
    });

    it('validateConfigDir throws for external paths', function() {
      assert.throws(function() { validateConfigDir('/tmp'); }, /outside the project root/);
      assert.throws(function() { validateConfigDir('/etc'); }, /outside the project root/);
    });

    it('validateConfigDir returns resolved path for internal dirs', function() {
      var result = validateConfigDir('.loki');
      assert.equal(result, path.resolve('.loki'));
    });
  });

  describe('no config = no-op', function() {
    it('returns empty tools when no config exists', async function() {
      var nonExistentDir = path.join(process.cwd(), '.loki-no-config-' + Date.now());
      var manager = trackManager(new MCPClientManager({ configDir: nonExistentDir }));
      var tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      assert.equal(manager.initialized, true);
      assert.equal(manager.serverCount, 0);
      await manager.shutdown();
    });

    it('returns empty tools when config has no mcp_servers', async function() {
      var dir = createTmpConfig({ other_key: 'value' });
      var manager = trackManager(new MCPClientManager({ configDir: dir }));
      var tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      await manager.shutdown();
    });

    it('returns empty tools when mcp_servers is empty', async function() {
      var dir = createTmpConfig({ mcp_servers: [] });
      var manager = trackManager(new MCPClientManager({ configDir: dir }));
      var tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      await manager.shutdown();
    });
  });

  describe('JSON config', function() {
    it('connects to a single server and discovers tools', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      var tools = await manager.discoverTools();
      assert.equal(manager.initialized, true);
      assert.equal(manager.serverCount, 1);
      assert.equal(tools.length, 2);
      var names = tools.map(function(t) { return t.name; });
      assert.ok(names.includes('ping'));
      assert.ok(names.includes('info'));
      await manager.shutdown();
    });

    it('routes tool calls to correct server', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      await manager.discoverTools();
      var result = await manager.callTool('ping', {});
      assert.ok(result.content);
      assert.ok(result.content[0].text.includes('ping'));
      await manager.shutdown();
    });

    it('throws for unknown tool', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      await manager.discoverTools();
      await assert.rejects(function() { return manager.callTool('nonexistent', {}); }, /No server found for tool/);
      await manager.shutdown();
    });
  });

  describe('YAML config', function() {
    it('parses minimal YAML and connects', async function() {
      var yaml = 'mcp_servers:\n  - name: beta\n    command: node\n    args: ["' +
        MOCK_SERVER_SCRIPT.replace(/\\/g, '\\\\') + '"]\n';
      var dir = createTmpConfig(yaml);
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      var tools = await manager.discoverTools();
      assert.equal(manager.serverCount, 1);
      assert.ok(tools.length > 0);
      await manager.shutdown();
    });
  });

  describe('getToolsByServer', function() {
    it('returns tools for a specific server', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      await manager.discoverTools();
      var tools = manager.getToolsByServer('alpha');
      assert.equal(tools.length, 2);
      var none = manager.getToolsByServer('nonexistent');
      assert.deepEqual(none, []);
      await manager.shutdown();
    });
  });

  describe('getAllTools', function() {
    it('returns all tools across servers', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      await manager.discoverTools();
      var tools = manager.getAllTools();
      assert.equal(tools.length, 2);
      await manager.shutdown();
    });
  });

  describe('circuit breaker integration', function() {
    it('reports server state', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      await manager.discoverTools();
      assert.equal(manager.getServerState('alpha'), 'CLOSED');
      assert.equal(manager.getServerState('nonexistent'), null);
      await manager.shutdown();
    });

    it('handles server connection failure gracefully', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'broken', command: 'node', args: ['-e', 'process.exit(1)'] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 2000 }));
      await manager.discoverTools();
      assert.equal(manager.initialized, true);
      assert.equal(manager.serverCount, 1);
      await manager.shutdown();
    });
  });

  describe('discoverTools idempotency', function() {
    it('second call returns already-discovered tools without re-connecting', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      var tools1 = await manager.discoverTools();
      var clientBefore = manager._clients.get('alpha');
      var tools2 = await manager.discoverTools();
      var clientAfter = manager._clients.get('alpha');
      assert.deepEqual(tools1, tools2);
      assert.equal(clientBefore, clientAfter, 'Client instance must not change on second call');
      assert.equal(manager.serverCount, 1);
      await manager.shutdown();
    });
  });

  describe('YAML parser prototype pollution protection', function() {
    it('ignores __proto__ keys in top-level YAML', async function() {
      var yaml = '__proto__:\n  polluted: true\nmcp_servers:\n';
      var dir = createTmpConfig(yaml);
      var manager = trackManager(new MCPClientManager({ configDir: dir }));
      var tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      assert.equal(({}).polluted, undefined);
      await manager.shutdown();
    });

    it('ignores __proto__ keys inside list items', async function() {
      var yaml = 'mcp_servers:\n  - __proto__: injected\n    name: safe\n    command: node\n    args: ["' +
        MOCK_SERVER_SCRIPT.replace(/\\/g, '\\\\') + '"]\n';
      var dir = createTmpConfig(yaml);
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      var tools = await manager.discoverTools();
      assert.ok(tools.length > 0, 'Expected tools from safe server');
      assert.equal(({}).injected, undefined);
      await manager.shutdown();
    });

    it('ignores constructor and prototype keys', async function() {
      var yaml = 'constructor:\n  polluted: yes\nprototype:\n  bad: true\nmcp_servers:\n';
      var dir = createTmpConfig(yaml);
      var manager = trackManager(new MCPClientManager({ configDir: dir }));
      var tools = await manager.discoverTools();
      assert.deepEqual(tools, []);
      await manager.shutdown();
    });
  });

  describe('shutdown', function() {
    it('cleans up all clients and breakers', async function() {
      var dir = createTmpConfig({ mcp_servers: [{ name: 'alpha', command: 'node', args: [MOCK_SERVER_SCRIPT] }] });
      var manager = trackManager(new MCPClientManager({ configDir: dir, timeout: 5000 }));
      await manager.discoverTools();
      assert.equal(manager.serverCount, 1);
      await manager.shutdown();
      assert.equal(manager.serverCount, 0);
      assert.equal(manager.initialized, false);
    });
  });
});
