'use strict';

var https = require('https');
var http = require('http');
var EventEmitter = require('events');
var url = require('url');

/**
 * A2A Client - discovers and communicates with external A2A agents.
 */
class A2AClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.authToken] - Bearer token for authentication
   * @param {number} [opts.timeoutMs] - Request timeout in ms (default 30000)
   * @param {number} [opts.maxResponseSize] - Max response body size in bytes (default 10MB)
   */
  constructor(opts) {
    opts = opts || {};
    this._authToken = opts.authToken || null;
    this._timeoutMs = opts.timeoutMs || 30000;
    this._maxResponseSize = opts.maxResponseSize || 10 * 1024 * 1024;
  }

  /**
   * Discover an A2A agent by fetching its agent card.
   * @param {string} agentUrl - Base URL of the agent
   * @returns {Promise<object>} Agent card JSON
   */
  discover(agentUrl) {
    var cardUrl = agentUrl.replace(/\/+$/, '') + '/.well-known/agent.json';
    return this._request('GET', cardUrl);
  }

  /**
   * Submit a task to a remote A2A agent.
   * @param {string} agentUrl - Base URL of the agent
   * @param {object} taskParams - { skill, input, metadata }
   * @returns {Promise<object>} Created task
   */
  submitTask(agentUrl, taskParams) {
    var taskUrl = agentUrl.replace(/\/+$/, '') + '/tasks';
    return this._request('POST', taskUrl, taskParams);
  }

  /**
   * Get task status from a remote agent.
   */
  getTaskStatus(agentUrl, taskId) {
    var statusUrl = agentUrl.replace(/\/+$/, '') + '/tasks/' + encodeURIComponent(taskId);
    return this._request('GET', statusUrl);
  }

  /**
   * Cancel a task on a remote agent.
   */
  cancelTask(agentUrl, taskId) {
    var cancelUrl = agentUrl.replace(/\/+$/, '') + '/tasks/' + encodeURIComponent(taskId) + '/cancel';
    return this._request('POST', cancelUrl);
  }

  /**
   * Stream task updates via SSE.
   * @param {string} agentUrl
   * @param {string} taskId
   * @returns {EventEmitter} Emits 'event', 'error', 'end'
   */
  streamTask(agentUrl, taskId) {
    var streamUrl = agentUrl.replace(/\/+$/, '') + '/tasks/' + encodeURIComponent(taskId) + '/stream';
    var emitter = new EventEmitter();
    var parsed = new url.URL(streamUrl);
    var mod = parsed.protocol === 'https:' ? https : http;
    var headers = { 'Accept': 'text/event-stream' };
    if (this._authToken) headers['Authorization'] = 'Bearer ' + this._authToken;

    var req = mod.get(streamUrl, { headers: headers, timeout: this._timeoutMs }, function (res) {
      if (res.statusCode !== 200) {
        emitter.emit('error', new Error('Stream failed with status ' + res.statusCode));
        return;
      }
      var buffer = '';
      res.on('data', function (chunk) {
        buffer += chunk.toString();
        var parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var event = _parseSSE(parts[i]);
          if (event) emitter.emit('event', event);
        }
      });
      res.on('end', function () { emitter.emit('end'); });
      res.on('error', function (err) { emitter.emit('error', err); });
    });
    req.on('error', function (err) { emitter.emit('error', err); });
    emitter.abort = function () { req.destroy(); };
    return emitter;
  }

  _request(method, reqUrl, body) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var parsed = new url.URL(reqUrl);
      var mod = parsed.protocol === 'https:' ? https : http;
      var headers = { 'Accept': 'application/json' };
      if (self._authToken) headers['Authorization'] = 'Bearer ' + self._authToken;
      var bodyStr = null;
      if (body) {
        bodyStr = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      var opts = {
        method: method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: headers,
        timeout: self._timeoutMs,
      };
      var maxSize = self._maxResponseSize;
      var req = mod.request(opts, function (res) {
        var chunks = [];
        var totalSize = 0;
        res.on('data', function (c) {
          totalSize += c.length;
          if (totalSize > maxSize) {
            req.destroy();
            reject(new Error('Response exceeded maxResponseSize (' + maxSize + ' bytes)'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', function () {
          var raw = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            var err = new Error('HTTP ' + res.statusCode + ': ' + raw.slice(0, 200));
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          try { resolve(JSON.parse(raw)); }
          catch (_) { resolve(raw); }
        });
      });
      req.on('error', reject);
      req.on('timeout', function () { req.destroy(); reject(new Error('Request timeout')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

function _parseSSE(text) {
  var event = null;
  var data = null;
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('event: ') === 0) event = line.slice(7);
    else if (line.indexOf('data: ') === 0) data = line.slice(6);
  }
  if (!data) return null;
  try { data = JSON.parse(data); } catch (_) {}
  return { event: event, data: data };
}

module.exports = { A2AClient };
