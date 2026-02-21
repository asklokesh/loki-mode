'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

/**
 * MCP Client
 *
 * Connects to a single MCP server via stdio (subprocess) or SSE (HTTP POST).
 * Implements the client side of the MCP protocol (JSON-RPC 2.0):
 *   - initialize handshake
 *   - tools/list discovery
 *   - tools/call invocation
 *   - graceful shutdown
 *
 * Connection pooling: a single client instance maintains one persistent connection
 * that is reused across multiple calls.
 */

class MCPClient extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.name - Server name (for logging/identification)
   * @param {string} [config.command] - Command to spawn for stdio transport
   * @param {string[]} [config.args] - Arguments for the spawned command
   * @param {string} [config.url] - URL for SSE/HTTP transport
   * @param {string} [config.auth] - Auth type ('bearer')
   * @param {string} [config.token_env] - Env var name containing the auth token
   * @param {number} [config.timeout=30000] - Timeout per call in ms
   */
  constructor(config) {
    super();
    if (!config || !config.name) {
      throw new Error('MCPClient requires a config with at least a name');
    }
    this._name = config.name;
    this._command = config.command || null;
    this._args = config.args || [];
    this._url = config.url || null;
    this._authType = config.auth || null;
    this._tokenEnv = config.token_env || null;
    this._timeout = config.timeout || 30000;

    this._transport = this._url ? 'sse' : 'stdio';
    this._process = null;
    this._connected = false;
    this._serverInfo = null;
    this._serverCapabilities = null;
    this._tools = null;

    // For stdio: buffered line reading
    this._buffer = '';
    this._pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this._nextId = 1;
  }

  /** Server name. */
  get name() {
    return this._name;
  }

  /** Whether connected and initialized. */
  get connected() {
    return this._connected;
  }

  /** Server info from initialize response. */
  get serverInfo() {
    return this._serverInfo;
  }

  /** Cached tool list. */
  get tools() {
    return this._tools;
  }

  /**
   * Connect to the MCP server, perform initialize handshake, and discover tools.
   * @returns {Promise<object[]>} List of tool schemas
   */
  async connect() {
    if (this._connected) {
      return this._tools;
    }

    if (this._transport === 'stdio') {
      await this._connectStdio();
    }
    // For SSE transport, no persistent connection needed -- we use HTTP POST per request

    // Initialize handshake
    const initResult = await this._sendRequest('initialize', {
      clientInfo: { name: 'loki-mode-client', version: '1.0.0' },
      protocolVersion: '2024-11-05'
    });

    this._serverInfo = initResult.serverInfo || null;
    this._serverCapabilities = initResult.capabilities || null;

    // Send initialized notification
    this._sendNotification('initialized', {});

    // Discover tools
    const toolsResult = await this._sendRequest('tools/list', {});
    this._tools = toolsResult.tools || [];
    this._connected = true;

    this.emit('connected', { name: this._name, tools: this._tools });
    return this._tools;
  }

  /**
   * Call a tool on the connected server.
   * @param {string} toolName
   * @param {object} [args={}]
   * @returns {Promise<object>} Tool call result
   */
  async callTool(toolName, args) {
    if (!this._connected) {
      throw new Error('MCPClient [' + this._name + '] is not connected. Call connect() first.');
    }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args || {}
    });

    return result;
  }

  /**
   * Refresh the tool list from the server.
   * @returns {Promise<object[]>}
   */
  async refreshTools() {
    if (!this._connected) {
      throw new Error('MCPClient [' + this._name + '] is not connected.');
    }
    const toolsResult = await this._sendRequest('tools/list', {});
    this._tools = toolsResult.tools || [];
    return this._tools;
  }

  /**
   * Graceful shutdown: send shutdown notification and clean up.
   */
  async shutdown() {
    if (!this._connected && !this._process) {
      return;
    }

    try {
      this._sendNotification('shutdown', {});
    } catch (_) {
      // Best-effort
    }

    this._connected = false;
    this._tools = null;
    this._serverInfo = null;

    // Reject pending requests
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client shutting down'));
    }
    this._pendingRequests.clear();

    if (this._process) {
      try {
        this._process.stdin.end();
      } catch (_) {
        // ignore
      }
      // Give it a moment then force kill
      const proc = this._process;
      this._process = null;
      setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      }, 500).unref();
    }

    this.emit('disconnected', { name: this._name });
  }

  // ---------------------------------------------------------------------------
  // Stdio transport
  // ---------------------------------------------------------------------------

  _connectStdio() {
    return new Promise((resolve, reject) => {
      if (!this._command) {
        reject(new Error('MCPClient [' + this._name + ']: stdio transport requires a command'));
        return;
      }

      this._process = spawn(this._command, this._args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env)
      });

      this._process.stdout.setEncoding('utf8');
      this._process.stdout.on('data', (chunk) => this._onStdioData(chunk));

      this._process.stderr.setEncoding('utf8');
      this._process.stderr.on('data', (data) => {
        this.emit('stderr', { name: this._name, data: data });
      });

      this._process.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this._process.on('exit', (code, signal) => {
        this._connected = false;
        this.emit('exit', { name: this._name, code: code, signal: signal });
      });

      // Give the process a moment to start
      // Resolve immediately -- the handshake will validate it actually works
      setImmediate(resolve);
    });
  }

  _onStdioData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line.length > 0) {
        this._handleStdioLine(line);
      }
    }
  }

  _handleStdioLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch (_) {
      // Not valid JSON -- ignore (could be server log output)
      return;
    }

    if (response && response.id !== undefined && response.id !== null) {
      const pending = this._pendingRequests.get(response.id);
      if (pending) {
        this._pendingRequests.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) {
          const err = new Error(response.error.message || 'RPC error');
          err.code = response.error.code;
          err.data = response.error.data;
          pending.reject(err);
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Request sending
  // ---------------------------------------------------------------------------

  _sendRequest(method, params) {
    const id = this._nextId++;
    const message = {
      jsonrpc: '2.0',
      method: method,
      params: params || {},
      id: id
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        const err = new Error('Timeout waiting for response to ' + method + ' (id=' + id + ')');
        err.code = 'TIMEOUT';
        reject(err);
      }, this._timeout);

      if (timer.unref) timer.unref();

      this._pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });

      if (this._transport === 'stdio') {
        this._writeStdio(message);
      } else {
        this._writeHttp(message).then((result) => {
          // Clear the pending entry since HTTP gives us the response directly
          const pending = this._pendingRequests.get(id);
          if (pending) {
            this._pendingRequests.delete(id);
            clearTimeout(pending.timer);
            if (result.error) {
              const err = new Error(result.error.message || 'RPC error');
              err.code = result.error.code;
              err.data = result.error.data;
              pending.reject(err);
            } else {
              pending.resolve(result.result);
            }
          }
        }).catch((err) => {
          const pending = this._pendingRequests.get(id);
          if (pending) {
            this._pendingRequests.delete(id);
            clearTimeout(pending.timer);
            pending.reject(err);
          }
        });
      }
    });
  }

  _sendNotification(method, params) {
    const message = {
      jsonrpc: '2.0',
      method: method,
      params: params || {}
    };

    if (this._transport === 'stdio') {
      this._writeStdio(message);
    } else {
      // Fire and forget for HTTP
      this._writeHttp(message).catch(() => {});
    }
  }

  _writeStdio(message) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('MCPClient [' + this._name + ']: stdio not writable');
    }
    this._process.stdin.write(JSON.stringify(message) + '\n');
  }

  _writeHttp(message) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(this._url.endsWith('/mcp') ? this._url : this._url + '/mcp');
      const isHttps = urlObj.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers = {
        'Content-Type': 'application/json'
      };

      // Auth
      if (this._authType === 'bearer' && this._tokenEnv) {
        const token = process.env[this._tokenEnv];
        if (token) {
          headers['Authorization'] = 'Bearer ' + token;
        }
      }

      const body = JSON.stringify(message);
      headers['Content-Length'] = Buffer.byteLength(body);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: headers,
        timeout: this._timeout
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('Invalid JSON response from ' + this._name + ': ' + data.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP request timeout for ' + this._name));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { MCPClient };
