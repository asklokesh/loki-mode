'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

/**
 * MCP Client
 *
 * Connects to a single MCP server via stdio (subprocess) or HTTP (JSON-RPC POST).
 * Implements the client side of the MCP protocol (JSON-RPC 2.0):
 *   - initialize handshake
 *   - tools/list discovery
 *   - tools/call invocation
 *   - graceful shutdown
 *
 * Security notes:
 *   - config.command is validated: shell interpreters are rejected.
 *   - stdio stdout is capped at MAX_BUFFER_BYTES (10 MB).
 *   - HTTP response bodies are capped at MAX_RESPONSE_BYTES (50 MB).
 *   - url must be the complete endpoint URL; no automatic path mutation.
 *
 * Concurrency: concurrent connect() calls share a single in-flight promise.
 */

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const BLOCKED_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'wscript', 'cscript', 'perl', 'ruby'
]);

function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    throw new Error('MCPClient: command must be a non-empty string');
  }
  const base = command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  const raw = command.toLowerCase().replace(/\.exe$/, '');
  if (BLOCKED_COMMANDS.has(base) || BLOCKED_COMMANDS.has(raw)) {
    throw new Error(
      'MCPClient: command "' + command + '" is a blocked shell interpreter. ' +
      'Specify the MCP server executable directly (e.g. "node", "npx", "python3").'
    );
  }
}

class MCPClient extends EventEmitter {
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

    if (this._command) {
      validateCommand(this._command);
    }

    this._transport = this._url ? 'http' : 'stdio';
    this._process = null;
    this._connected = false;
    this._connectingPromise = null;
    this._serverInfo = null;
    this._protocolVersion = null;
    this._serverCapabilities = null;
    this._tools = null;

    this._buffer = '';
    this._pendingRequests = new Map();
    this._nextId = 1;

    // Default no-op error listener so process 'error' events do not crash the host.
    this.on('error', function() {});
  }

  get name() { return this._name; }
  get connected() { return this._connected; }
  get serverInfo() { return this._serverInfo; }
  get protocolVersion() { return this._protocolVersion; }
  get tools() { return this._tools; }

  async connect() {
    if (this._connected) return this._tools;
    if (this._connectingPromise) return this._connectingPromise;
    this._connectingPromise = this._doConnect().finally(() => {
      this._connectingPromise = null;
    });
    return this._connectingPromise;
  }

  async _doConnect() {
    if (this._transport === 'stdio') {
      await this._connectStdio();
    }

    const initResult = await this._sendRequest('initialize', {
      clientInfo: { name: 'loki-mode-client', version: '1.0.0' },
      protocolVersion: '2025-11-25'
    });

    this._serverInfo = initResult.serverInfo || null;
    this._protocolVersion = initResult.protocolVersion || null;
    this._serverCapabilities = initResult.capabilities || null;

    this._sendNotification('notifications/initialized', {});

    const toolsResult = await this._sendRequest('tools/list', {});
    this._tools = toolsResult.tools || [];
    this._connected = true;

    this.emit('connected', { name: this._name, tools: this._tools });
    return this._tools;
  }

  async callTool(toolName, args) {
    if (!this._connected) {
      throw new Error('MCPClient [' + this._name + '] is not connected. Call connect() first.');
    }
    return this._sendRequest('tools/call', { name: toolName, arguments: args || {} });
  }

  async refreshTools() {
    if (!this._connected) {
      throw new Error('MCPClient [' + this._name + '] is not connected.');
    }
    const toolsResult = await this._sendRequest('tools/list', {});
    this._tools = toolsResult.tools || [];
    return this._tools;
  }

  async shutdown() {
    if (!this._connected && !this._process) return;

    try { this._sendNotification('shutdown', {}); } catch (_) {}

    this._connected = false;
    this._tools = null;
    this._serverInfo = null;
    this._protocolVersion = null;

    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client shutting down'));
    }
    this._pendingRequests.clear();

    if (this._process) {
      try { this._process.stdin.end(); } catch (_) {}
      const proc = this._process;
      this._process = null;
      setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }, 500).unref();
    }

    this.emit('disconnected', { name: this._name });
  }

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

      // Race the error event against setImmediate.
      // If spawn fails (ENOENT etc.) the error fires before setImmediate,
      // so we reject immediately with the real error rather than resolving
      // and then timing out 30 seconds later.
      var settled = false;

      this._process.once('error', (err) => {
        if (!settled) {
          settled = true;
          this._process.on('error', (postErr) => { this.emit('error', postErr); });
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this._process.on('exit', (code, signal) => {
        this._connected = false;
        this.emit('exit', { name: this._name, code: code, signal: signal });
      });

      setImmediate(function() {
        if (!settled) { settled = true; resolve(); }
      });
    });
  }

  _onStdioData(chunk) {
    this._buffer += chunk;

    // Enforce max buffer size to prevent memory exhaustion from misbehaving server.
    if (this._buffer.length > MAX_BUFFER_BYTES) {
      var err = new Error(
        'MCPClient [' + this._name + ']: stdio buffer overflow (' +
        MAX_BUFFER_BYTES + ' bytes). Disconnecting.'
      );
      this.emit('error', err);
      this.shutdown();
      return;
    }

    var idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      var line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line.length > 0) this._handleStdioLine(line);
    }
  }

  _handleStdioLine(line) {
    var response;
    try { response = JSON.parse(line); } catch (_) { return; }

    if (response && response.id !== undefined && response.id !== null) {
      var pending = this._pendingRequests.get(response.id);
      if (pending) {
        this._pendingRequests.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) {
          var err = new Error(response.error.message || 'RPC error');
          err.code = response.error.code;
          err.data = response.error.data;
          pending.reject(err);
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }

  _sendRequest(method, params) {
    var self = this;
    var id = this._nextId++;
    var message = { jsonrpc: '2.0', method: method, params: params || {}, id: id };

    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        self._pendingRequests.delete(id);
        var e = new Error('Timeout waiting for response to ' + method + ' (id=' + id + ')');
        e.code = 'TIMEOUT';
        reject(e);
      }, self._timeout);

      if (timer.unref) timer.unref();

      self._pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });

      if (self._transport === 'stdio') {
        try {
          self._writeStdio(message);
        } catch (writeErr) {
          self._pendingRequests.delete(id);
          clearTimeout(timer);
          reject(writeErr);
        }
      } else {
        self._writeHttp(message).then(function(result) {
          var p = self._pendingRequests.get(id);
          if (p) {
            self._pendingRequests.delete(id);
            clearTimeout(p.timer);
            if (result.error) {
              var re = new Error(result.error.message || 'RPC error');
              re.code = result.error.code;
              re.data = result.error.data;
              p.reject(re);
            } else {
              p.resolve(result.result);
            }
          }
        }).catch(function(e) {
          var p = self._pendingRequests.get(id);
          if (p) {
            self._pendingRequests.delete(id);
            clearTimeout(p.timer);
            p.reject(e);
          }
        });
      }
    });
  }

  _sendNotification(method, params) {
    var message = { jsonrpc: '2.0', method: method, params: params || {} };
    if (this._transport === 'stdio') {
      this._writeStdio(message);
    } else {
      this._writeHttp(message).catch(function() {});
    }
  }

  _writeStdio(message) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('MCPClient [' + this._name + ']: stdio not writable');
    }
    this._process.stdin.write(JSON.stringify(message) + '\n');
  }

  /**
   * Send a JSON-RPC message over HTTP POST.
   * The url config field must be the complete endpoint URL.
   * Response body accumulation is capped at MAX_RESPONSE_BYTES.
   */
  _writeHttp(message) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var urlObj = new URL(self._url);
      var isHttps = urlObj.protocol === 'https:';
      var transport = isHttps ? https : http;

      var headers = { 'Content-Type': 'application/json' };

      if (self._authType === 'bearer' && self._tokenEnv) {
        var token = process.env[self._tokenEnv];
        if (token) headers['Authorization'] = 'Bearer ' + token;
      }

      var body = JSON.stringify(message);
      headers['Content-Length'] = Buffer.byteLength(body);

      var options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + (urlObj.search || ''),
        method: 'POST',
        headers: headers
      };

      var req = transport.request(options, function(res) {
        var data = '';
        var dataBytes = 0;
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
          dataBytes += Buffer.byteLength(chunk);
          if (dataBytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(
              'MCPClient [' + self._name + ']: HTTP response too large (>' +
              MAX_RESPONSE_BYTES + ' bytes).'
            ));
            return;
          }
          data += chunk;
        });
        res.on('end', function() {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response from ' + self._name + ': ' + data.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { MCPClient, MAX_BUFFER_BYTES, MAX_RESPONSE_BYTES, BLOCKED_COMMANDS, validateCommand };
