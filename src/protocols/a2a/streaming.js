'use strict';

var EventEmitter = require('events');

/**
 * SSE (Server-Sent Events) stream for A2A task progress.
 */
class SSEStream extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.res] - HTTP response object to write to
   * @param {number} [opts.maxBufferSize] - Max buffered events before dropping oldest (default 1000)
   */
  constructor(opts) {
    super();
    opts = opts || {};
    this._res = opts.res || null;
    this._closed = false;
    this._buffer = [];
    this._maxBufferSize = opts.maxBufferSize || 1000;
  }

  /**
   * Initialize SSE headers on an HTTP response.
   */
  initResponse(res) {
    this._res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Flush buffered events
    for (var i = 0; i < this._buffer.length; i++) {
      this._writeRaw(this._buffer[i]);
    }
    this._buffer = [];
  }

  /**
   * Send a typed SSE event.
   * @param {string} event - Event type
   * @param {*} data - Event data (will be JSON-stringified if object)
   */
  sendEvent(event, data) {
    if (this._closed) return;
    var payload = typeof data === 'string' ? data : JSON.stringify(data);
    var msg = 'event: ' + event + '\ndata: ' + payload + '\n\n';
    this._writeOrBuffer(msg);
    this.emit('event', { event: event, data: data });
  }

  /**
   * Send task progress update.
   */
  sendProgress(taskId, message, progress) {
    this.sendEvent('progress', {
      taskId: taskId,
      message: message,
      progress: progress || null,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send an artifact.
   */
  sendArtifact(taskId, artifact) {
    this.sendEvent('artifact', {
      taskId: taskId,
      artifact: artifact,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send state change notification.
   */
  sendStateChange(taskId, oldState, newState) {
    this.sendEvent('state', {
      taskId: taskId,
      from: oldState,
      to: newState,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Close the stream.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._res) {
      try { this._res.end(); } catch (_) {}
    }
    this.emit('close');
  }

  isClosed() { return this._closed; }

  getBuffer() { return this._buffer.slice(); }

  _writeOrBuffer(msg) {
    if (this._res) {
      this._writeRaw(msg);
    } else {
      this._buffer.push(msg);
      while (this._buffer.length > this._maxBufferSize) {
        this._buffer.shift();
      }
    }
  }

  _writeRaw(msg) {
    try { this._res.write(msg); } catch (_) { this._closed = true; }
  }
}

module.exports = { SSEStream };
