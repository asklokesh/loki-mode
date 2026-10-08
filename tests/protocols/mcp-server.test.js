'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Set up a temp working directory so file operations are isolated
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-test-'));
const origCwd = process.cwd();

before(() => {
  process.chdir(testDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
});

const { handleRequest, getTools, getResources, getServerInfo, SUPPORTED_PROTOCOL_VERSIONS } = require('../../src/protocols/mcp-server');

describe('MCP Server initialization', () => {
  it('should return server info on initialize', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1
    });
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(response.result.serverInfo);
    assert.equal(response.result.serverInfo.name, 'loki-mode');
    assert.ok(response.result.capabilities);
    assert.ok(response.result.capabilities.tools !== undefined);
    assert.ok(response.result.capabilities.resources !== undefined);
  });

  it('should handle initialized notification', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'initialized'
    });
    // Notifications with no id should return null
    assert.equal(response, null);
  });

  it('should accept notifications/initialized notification', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    assert.equal(response, null);
  });

  it('should echo a supported requested protocolVersion', () => {
    for (const v of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
      const response = handleRequest({
        jsonrpc: '2.0', method: 'initialize', id: 2,
        params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } }
      });
      assert.equal(response.result.protocolVersion, v);
    }
  });

  it('should fall back to the latest supported version for an unknown request', () => {
    const response = handleRequest({
      jsonrpc: '2.0', method: 'initialize', id: 3,
      params: { protocolVersion: '2099-01-01' }
    });
    const latest = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
    assert.equal(latest, '2025-11-25');
    assert.equal(response.result.protocolVersion, latest);
  });

  it('should fall back to the latest version when none is requested', () => {
    const response = handleRequest({ jsonrpc: '2.0', method: 'initialize', id: 4 });
    assert.equal(response.result.protocolVersion, '2025-11-25');
  });

  it('should put protocolVersion at the result top level, not in serverInfo', () => {
    const response = handleRequest({ jsonrpc: '2.0', method: 'initialize', id: 5, params: { protocolVersion: '2024-11-05' } });
    assert.equal(response.result.protocolVersion, '2024-11-05');
    assert.equal(response.result.serverInfo.protocolVersion, undefined);
  });

  it('should respond to ping', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'ping',
      id: 2
    });
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 2);
    assert.deepEqual(response.result, {});
  });
});

describe('Tool registration', () => {
  it('should register all 5 tools', () => {
    const tools = getTools();
    assert.equal(tools.size, 5);
  });

  it('should have the correct tool names', () => {
    const tools = getTools();
    const expectedNames = [
      'loki/start-project',
      'loki/project-status',
      'loki/agent-metrics',
      'loki/checkpoint-restore',
      'loki/quality-report'
    ];
    for (const name of expectedNames) {
      assert.ok(tools.has(name), 'Missing tool: ' + name);
    }
  });

  it('should list all tools via tools/list', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 3
    });
    assert.equal(response.id, 3);
    assert.equal(response.result.tools.length, 5);
    const names = response.result.tools.map((t) => t.name);
    assert.ok(names.includes('loki/start-project'));
    assert.ok(names.includes('loki/quality-report'));
  });

  it('should have valid inputSchema on all tools', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 4
    });
    for (const tool of response.result.tools) {
      assert.ok(tool.name, 'Tool missing name');
      assert.ok(tool.description, 'Tool missing description: ' + tool.name);
      assert.ok(tool.inputSchema, 'Tool missing inputSchema: ' + tool.name);
      assert.equal(tool.inputSchema.type, 'object', 'inputSchema.type should be object: ' + tool.name);
    }
  });
});

describe('Resource registration', () => {
  it('should register both resources', () => {
    const resources = getResources();
    assert.equal(resources.size, 2);
  });

  it('should list resources via resources/list', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'resources/list',
      id: 5
    });
    assert.equal(response.result.resources.length, 2);
    const uris = response.result.resources.map((r) => r.uri);
    assert.ok(uris.includes('loki://state/continuity'));
    assert.ok(uris.includes('loki://memory/learning'));
  });
});

describe('JSON-RPC 2.0 error handling', () => {
  it('should reject invalid JSON-RPC version', () => {
    const response = handleRequest({
      jsonrpc: '1.0',
      method: 'ping',
      id: 10
    });
    assert.ok(response.error);
    assert.equal(response.error.code, -32600);
  });

  it('should reject missing method', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      id: 11
    });
    assert.ok(response.error);
    assert.equal(response.error.code, -32600);
  });

  it('should return method not found for unknown methods', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'nonexistent/method',
      id: 12
    });
    assert.ok(response.error);
    assert.equal(response.error.code, -32601);
  });

  it('should reject null request', () => {
    const response = handleRequest(null);
    assert.ok(response.error);
    assert.equal(response.error.code, -32600);
  });

  it('should handle unknown tool call gracefully', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'nonexistent/tool', arguments: {} },
      id: 13
    });
    assert.ok(response.result);
    assert.ok(response.result.isError);
    assert.ok(response.result.content[0].text.includes('Unknown tool'));
  });

  it('should handle missing tool name', () => {
    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {},
      id: 14
    });
    assert.ok(response.result.isError);
  });
});

describe('Server info', () => {
  it('should return server name and version without a nested protocol version', () => {
    const info = getServerInfo();
    assert.equal(info.name, 'loki-mode');
    assert.equal(info.protocolVersion, undefined);
    assert.ok(info.version);
  });
});

describe('Async tool execution', () => {
  it('should correctly handle a tool that returns a Promise', async () => {
    // Inject a temporary async tool to verify Promise propagation
    const tools = getTools();
    const fakeName = 'loki/async-test-tool';
    tools.set(fakeName, {
      TOOL_NAME: fakeName,
      schema: { name: fakeName, description: 'test', inputSchema: { type: 'object', properties: {}, required: [] } },
      execute: () => Promise.resolve({ asyncValue: 42 })
    });

    const response = handleRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: fakeName, arguments: {} },
      id: 100
    });

    // handleRequest may return a Promise when the tool is async
    const resolved = await Promise.resolve(response);
    assert.ok(resolved, 'Expected a response');
    assert.ok(resolved.result, 'Expected result');
    const parsed = JSON.parse(resolved.result.content[0].text);
    assert.equal(parsed.asyncValue, 42);

    // Clean up injected tool
    tools.delete(fakeName);
  });
});
