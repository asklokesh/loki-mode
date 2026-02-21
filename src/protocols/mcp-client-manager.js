'use strict';

const fs = require('fs');
const path = require('path');
const { MCPClient } = require('./mcp-client');
const { CircuitBreaker } = require('./mcp-circuit-breaker');

/**
 * MCP Client Manager
 *
 * Manages connections to multiple MCP servers. Reads server configuration from
 * `.loki/config.json` or `.loki/config.yaml` (minimal YAML subset). Routes
 * tool calls to the correct server automatically.
 *
 * Features:
 *   - Multi-server discovery and connection
 *   - Tool-to-server routing
 *   - Circuit breaker per server (auto-open after 3 failures, half-open after 30s)
 *   - No config = no servers = zero overhead
 */

class MCPClientManager {
  /**
   * @param {object} [options]
   * @param {string} [options.configDir='.loki'] - Directory containing config.json/config.yaml
   * @param {number} [options.timeout=30000] - Default timeout per call in ms
   * @param {number} [options.failureThreshold=3] - Circuit breaker failure threshold
   * @param {number} [options.resetTimeout=30000] - Circuit breaker reset timeout in ms
   */
  constructor(options) {
    const opts = options || {};
    this._configDir = opts.configDir || '.loki';
    this._timeout = opts.timeout || 30000;
    this._failureThreshold = opts.failureThreshold || 3;
    this._resetTimeout = opts.resetTimeout || 30000;

    /** @type {Map<string, MCPClient>} */
    this._clients = new Map();

    /** @type {Map<string, CircuitBreaker>} */
    this._breakers = new Map();

    /** @type {Map<string, string>} tool name -> server name */
    this._toolRouting = new Map();

    /** @type {Map<string, object>} tool name -> tool schema */
    this._toolSchemas = new Map();

    this._initialized = false;
  }

  /** Whether the manager has been initialized. */
  get initialized() {
    return this._initialized;
  }

  /** Number of connected servers. */
  get serverCount() {
    return this._clients.size;
  }

  /**
   * Load config, connect to all configured servers, and discover tools.
   * If no config file exists, this is a no-op and returns empty array.
   * @returns {Promise<object[]>} Combined tool list from all servers
   */
  async discoverTools() {
    const config = this._loadConfig();
    if (!config || !config.mcp_servers || config.mcp_servers.length === 0) {
      this._initialized = true;
      return [];
    }

    const allTools = [];

    for (const serverConfig of config.mcp_servers) {
      if (!serverConfig.name) continue;

      const client = new MCPClient({
        name: serverConfig.name,
        command: serverConfig.command || null,
        args: serverConfig.args || [],
        url: serverConfig.url || null,
        auth: serverConfig.auth || null,
        token_env: serverConfig.token_env || null,
        timeout: serverConfig.timeout || this._timeout
      });

      const breaker = new CircuitBreaker({
        failureThreshold: this._failureThreshold,
        resetTimeout: this._resetTimeout
      });

      this._clients.set(serverConfig.name, client);
      this._breakers.set(serverConfig.name, breaker);

      try {
        const tools = await breaker.execute(() => client.connect());
        for (const tool of tools) {
          this._toolRouting.set(tool.name, serverConfig.name);
          this._toolSchemas.set(tool.name, tool);
        }
        allTools.push.apply(allTools, tools);
      } catch (err) {
        // Connection failed -- breaker will track the failure.
        // Log but do not throw; other servers may still work.
        process.stderr.write(
          '[mcp-manager] Failed to connect to server "' + serverConfig.name + '": ' + err.message + '\n'
        );
      }
    }

    this._initialized = true;
    return allTools;
  }

  /**
   * Get tools for a specific server.
   * @param {string} serverName
   * @returns {object[]}
   */
  getToolsByServer(serverName) {
    const client = this._clients.get(serverName);
    if (!client || !client.tools) return [];
    return client.tools.slice();
  }

  /**
   * Get all known tools across all servers.
   * @returns {object[]}
   */
  getAllTools() {
    const tools = [];
    for (const schema of this._toolSchemas.values()) {
      tools.push(schema);
    }
    return tools;
  }

  /**
   * Call a tool, automatically routing to the correct server.
   * @param {string} toolName
   * @param {object} [args={}]
   * @returns {Promise<object>}
   */
  async callTool(toolName, args) {
    const serverName = this._toolRouting.get(toolName);
    if (!serverName) {
      throw new Error('No server found for tool: ' + toolName);
    }

    const client = this._clients.get(serverName);
    if (!client) {
      throw new Error('Client not found for server: ' + serverName);
    }

    const breaker = this._breakers.get(serverName);
    if (!breaker) {
      throw new Error('Circuit breaker not found for server: ' + serverName);
    }

    return breaker.execute(() => client.callTool(toolName, args));
  }

  /**
   * Get circuit breaker state for a server.
   * @param {string} serverName
   * @returns {string|null} State or null if server not found
   */
  getServerState(serverName) {
    const breaker = this._breakers.get(serverName);
    return breaker ? breaker.state : null;
  }

  /**
   * Shut down all connections gracefully.
   */
  async shutdown() {
    const shutdowns = [];
    for (const [, client] of this._clients) {
      shutdowns.push(client.shutdown());
    }
    await Promise.all(shutdowns);

    for (const [, breaker] of this._breakers) {
      breaker.destroy();
    }

    this._clients.clear();
    this._breakers.clear();
    this._toolRouting.clear();
    this._toolSchemas.clear();
    this._initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Config loading
  // ---------------------------------------------------------------------------

  _loadConfig() {
    // Try JSON first, then YAML
    const jsonPath = path.resolve(this._configDir, 'config.json');
    const yamlPath = path.resolve(this._configDir, 'config.yaml');

    if (fs.existsSync(jsonPath)) {
      try {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        return JSON.parse(raw);
      } catch (err) {
        process.stderr.write('[mcp-manager] Failed to parse config.json: ' + err.message + '\n');
        return null;
      }
    }

    if (fs.existsSync(yamlPath)) {
      try {
        const raw = fs.readFileSync(yamlPath, 'utf8');
        return this._parseMinimalYaml(raw);
      } catch (err) {
        process.stderr.write('[mcp-manager] Failed to parse config.yaml: ' + err.message + '\n');
        return null;
      }
    }

    return null;
  }

  /**
   * Minimal YAML parser supporting the config format:
   *
   * mcp_servers:
   *   - name: github
   *     command: npx
   *     args: ["@anthropic-ai/mcp-server-github"]
   *   - name: custom
   *     url: https://mcp.example.com
   *     auth: bearer
   *     token_env: CUSTOM_MCP_TOKEN
   *
   * This is NOT a full YAML parser. It handles:
   *   - Top-level key: value
   *   - List items with "- key: value"
   *   - JSON-style arrays in values
   *   - Quoted and unquoted string values
   */
  _parseMinimalYaml(raw) {
    const result = {};
    const lines = raw.split('\n');
    let currentKey = null;
    let currentList = null;
    let currentItem = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.replace(/\r$/, '');

      // Skip empty lines and comments
      if (/^\s*$/.test(trimmed) || /^\s*#/.test(trimmed)) continue;

      // Top-level key (no leading whitespace)
      const topMatch = trimmed.match(/^(\w+):\s*$/);
      if (topMatch) {
        currentKey = topMatch[1];
        currentList = [];
        result[currentKey] = currentList;
        currentItem = null;
        continue;
      }

      // Top-level key with value
      const topValMatch = trimmed.match(/^(\w+):\s+(.+)$/);
      if (topValMatch && !trimmed.startsWith(' ') && !trimmed.startsWith('\t')) {
        result[topValMatch[1]] = this._parseYamlValue(topValMatch[2]);
        continue;
      }

      if (!currentKey || !currentList) continue;

      // List item start: "  - key: value"
      const listItemMatch = trimmed.match(/^\s+-\s+(\w+):\s+(.+)$/);
      if (listItemMatch) {
        currentItem = {};
        currentItem[listItemMatch[1]] = this._parseYamlValue(listItemMatch[2]);
        currentList.push(currentItem);
        continue;
      }

      // List item continuation: "    key: value"
      const contMatch = trimmed.match(/^\s+(\w+):\s+(.+)$/);
      if (contMatch && currentItem) {
        currentItem[contMatch[1]] = this._parseYamlValue(contMatch[2]);
        continue;
      }
    }

    return result;
  }

  _parseYamlValue(val) {
    val = val.trim();
    // Remove trailing comments
    const commentIdx = val.indexOf(' #');
    if (commentIdx !== -1) {
      val = val.slice(0, commentIdx).trim();
    }

    // JSON array
    if (val.startsWith('[') && val.endsWith(']')) {
      try {
        return JSON.parse(val);
      } catch (_) {
        return val;
      }
    }

    // Quoted string
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }

    // Boolean
    if (val === 'true') return true;
    if (val === 'false') return false;

    // Number
    if (/^-?\d+(\.\d+)?$/.test(val)) {
      return Number(val);
    }

    return val;
  }
}

module.exports = { MCPClientManager };
