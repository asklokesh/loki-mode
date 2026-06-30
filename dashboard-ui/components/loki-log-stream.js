/**
 * @fileoverview Loki Log Stream Component - real-time log viewer with level
 * filtering, text search, auto-scroll, and download capabilities. Supports
 * both API polling and file-based log sources. Styled as a terminal emulator
 * with monospace font and colored log levels.
 *
 * @example
 * <loki-log-stream api-url="http://localhost:57374" max-lines="500" auto-scroll theme="dark"></loki-log-stream>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/** @type {Object<string, {color: string, label: string}>} Log level display configuration */
const LOG_LEVELS = {
  info: { color: 'var(--loki-blue)', label: 'INFO' },
  success: { color: 'var(--loki-green)', label: 'SUCCESS' },
  warning: { color: 'var(--loki-yellow)', label: 'WARN' },
  error: { color: 'var(--loki-red)', label: 'ERROR' },
  step: { color: 'var(--loki-purple)', label: 'STEP' },
  agent: { color: 'var(--loki-accent)', label: 'AGENT' },
  debug: { color: 'var(--loki-text-muted)', label: 'DEBUG' },
};

/**
 * @class LokiLogStream
 * @extends LokiElement
 * @fires log-received - When a new log message arrives
 * @fires logs-cleared - When the log buffer is cleared
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {number} max-lines - Maximum log lines to retain (default: 500)
 * @property {boolean} auto-scroll - Auto-scroll to bottom on new messages
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 * @property {string} log-file - Path to log file for file-based polling
 */
export class LokiLogStream extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'max-lines', 'auto-scroll', 'theme', 'log-file'];
  }

  constructor() {
    super();
    this._logs = [];
    this._maxLines = 500;
    this._autoScroll = true;
    this._filter = '';
    this._levelFilter = 'all';
    this._api = null;
    this._pollInterval = null;
    this._logMessageHandler = null;
    // Heavy-logs duplicate suppression: track how many lines we have already
    // ingested and a lightweight signature of the last response so an unchanged
    // 200-line log does not get re-processed every cycle. The poll itself is
    // gated to the active + visible Insights section by the central registry.
    this._apiLastCount = 0;
    this._apiLastSig = null;
    this._fileLastSize = 0;
    this._fileLastSig = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._maxLines = parseInt(this.getAttribute('max-lines')) || 500;
    this._autoScroll = this.hasAttribute('auto-scroll');
    this._setupApi();
    this._startLogPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopLogPolling();
    this._teardownApiListeners();
  }

  _teardownApiListeners() {
    if (this._api && this._logMessageHandler) {
      this._api.removeEventListener(ApiEvents.LOG_MESSAGE, this._logMessageHandler);
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    switch (name) {
      case 'api-url':
        if (this._api) {
          // Adopt the correct per-URL client instead of mutating the cached
          // singleton's baseUrl (which leaks one project's logs into another).
          // Detach our LOG_MESSAGE listener from the old instance, swap, and
          // re-subscribe. Reset the accumulated log buffer so the switched
          // project starts clean rather than appending to the prior project.
          this._teardownApiListeners();
          this._logs = [];
          this._apiLastCount = 0;
          this._apiLastSig = null;
          this._setupApi();
          this.render();
        }
        break;
      case 'max-lines':
        this._maxLines = parseInt(newValue) || 500;
        this._trimLogs();
        this.render();
        break;
      case 'auto-scroll':
        this._autoScroll = this.hasAttribute('auto-scroll');
        this.render();
        break;
      case 'theme':
        this._applyTheme();
        break;
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });

    this._logMessageHandler = (e) => this._addLog(e.detail);
    this._api.addEventListener(ApiEvents.LOG_MESSAGE, this._logMessageHandler);
  }

  _startLogPolling() {
    const logFile = this.getAttribute('log-file');
    if (logFile) {
      this._pollLogFile(logFile);
    } else {
      // Poll /api/logs endpoint as fallback when no log-file attribute
      this._pollApiLogs();
    }
    // WebSocket-based logs are handled via event listener
  }

  async _pollApiLogs() {
    // Run once now, then register the recurring poll on the central registry so
    // the heavy /api/logs?lines=200 endpoint only fetches when the Logs view
    // (Insights section) is active AND the tab is visible. The interval is
    // deliberately LONGER than the light status polls (5s vs the 2s it used to
    // run at on every page) because logs are heavy and the WebSocket push path
    // delivers live lines in real time when connected.
    await this._apiLogPollTick();
    this._poll = registerPoll({
      loadFn: () => this._apiLogPollTick(),
      intervalMs: 5000,
      element: this,
      immediate: false,
    });
  }

  async _apiLogPollTick() {
    try {
      const entries = await this._api.getLogs(200);
      if (!Array.isArray(entries)) return;
      // Duplicate-suppression: skip all work if the response is identical to
      // the last one (same count + same last-line signature). This avoids
      // re-walking and re-rendering an unchanged 200-line log every cycle.
      const sig = entries.length
        ? `${entries.length}:${entries[entries.length - 1]?.timestamp || ''}:${entries[entries.length - 1]?.message || ''}`
        : '0';
      if (sig === this._apiLastSig) return;
      this._apiLastSig = sig;
      if (entries.length > this._apiLastCount) {
        const newEntries = entries.slice(this._apiLastCount);
        for (const entry of newEntries) {
          if (entry.message && entry.message.trim()) {
            this._addLog({
              message: entry.message,
              level: entry.level || 'info',
              timestamp: entry.timestamp || new Date().toLocaleTimeString(),
            });
          }
        }
      } else if (entries.length < this._apiLastCount) {
        // Log rotated/truncated: reset and ingest from the top next cycle.
        this._apiLastCount = 0;
      }
      this._apiLastCount = entries.length;
    } catch (error) {
      // API not available, will retry on next poll
    }
  }

  async _pollLogFile(logFile) {
    // Run once now, then register the recurring file poll on the central
    // registry (active + visible section only). Kept at 1s for file tails since
    // a static file read is cheap, but still gated so a hidden tab or a
    // background section does no I/O.
    await this._fileLogPollTick(logFile);
    this._poll = registerPoll({
      loadFn: () => this._fileLogPollTick(logFile),
      intervalMs: 1000,
      element: this,
      immediate: false,
    });
  }

  async _fileLogPollTick(logFile) {
    try {
      const response = await fetch(`${logFile}?t=${Date.now()}`, { credentials: 'include' });
      if (!response.ok) return;

      const text = await response.text();
      // Duplicate-suppression: identical file content -> no work.
      const sig = `${text.length}`;
      if (sig === this._fileLastSig) return;
      this._fileLastSig = sig;
      const lines = text.split('\n');

      // Only process new lines
      if (lines.length > this._fileLastSize) {
        const newLines = lines.slice(this._fileLastSize);
        for (const line of newLines) {
          if (line.trim()) {
            this._addLog(this._parseLine(line));
          }
        }
      } else if (lines.length < this._fileLastSize) {
        this._fileLastSize = 0;
      }
      this._fileLastSize = lines.length;
    } catch (error) {
      // Silently ignore file read errors
    }
  }

  _stopLogPolling() {
    if (this._poll) {
      this._poll.stop();
      this._poll = null;
    }
  }

  _parseLine(line) {
    // Try to parse structured log format: [TIMESTAMP] [LEVEL] message
    const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      return {
        timestamp: match[1],
        level: match[2].toLowerCase(),
        message: match[3],
      };
    }

    // Try simpler format: TIMESTAMP LEVEL message
    const simpleMatch = line.match(/^(\d{2}:\d{2}:\d{2})\s+(\w+)\s+(.+)$/);
    if (simpleMatch) {
      return {
        timestamp: simpleMatch[1],
        level: simpleMatch[2].toLowerCase(),
        message: simpleMatch[3],
      };
    }

    // Default: treat as info message
    return {
      timestamp: new Date().toLocaleTimeString(),
      level: 'info',
      message: line,
    };
  }

  _addLog(log) {
    if (!log) return;

    const entry = {
      id: Date.now() + Math.random(),
      timestamp: log.timestamp || new Date().toLocaleTimeString(),
      level: (log.level || 'info').toLowerCase(),
      message: log.message || log,
    };

    this._logs.push(entry);
    this._trimLogs();

    this.dispatchEvent(new CustomEvent('log-received', { detail: entry }));

    this._renderLogs();

    if (this._autoScroll) {
      this._scrollToBottom();
    }
  }

  _trimLogs() {
    if (this._logs.length > this._maxLines) {
      this._logs = this._logs.slice(-this._maxLines);
    }
  }

  _clearLogs() {
    this._logs = [];
    this.dispatchEvent(new CustomEvent('logs-cleared'));
    this._renderLogs();
  }

  _toggleAutoScroll() {
    this._autoScroll = !this._autoScroll;
    this.render();
    if (this._autoScroll) {
      this._scrollToBottom();
    }
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      const output = this.shadowRoot.getElementById('log-output');
      if (output) {
        output.scrollTop = output.scrollHeight;
      }
    });
  }

  _downloadLogs() {
    const content = this._logs
      .map(log => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`)
      .join('\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loki-logs-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _setFilter(filter) {
    this._filter = filter.toLowerCase();
    this._renderLogs();
  }

  _setLevelFilter(level) {
    this._levelFilter = level;
    this._renderLogs();
  }

  _getFilteredLogs() {
    return this._logs.filter(log => {
      // Level filter
      if (this._levelFilter !== 'all' && log.level !== this._levelFilter) {
        return false;
      }

      // Text filter
      if (this._filter && !log.message.toLowerCase().includes(this._filter)) {
        return false;
      }

      return true;
    });
  }

  _renderLogs() {
    const output = this.shadowRoot.getElementById('log-output');
    if (!output) return;

    const filteredLogs = this._getFilteredLogs();

    if (filteredLogs.length === 0) {
      output.innerHTML = '<div class="log-empty">No log output yet. Terminal will update when Loki Mode is running.</div>';
      return;
    }

    output.innerHTML = filteredLogs.map(log => {
      const levelConfig = LOG_LEVELS[log.level] || LOG_LEVELS.info;
      return `
        <div class="log-line">
          <span class="timestamp">${this._escapeHtml(log.timestamp)}</span>
          <span class="level" style="color: ${levelConfig.color}">[${this._escapeHtml(levelConfig.label)}]</span>
          <span class="message">${this._escapeHtml(log.message)}</span>
        </div>
      `;
    }).join('');

    if (this._autoScroll) {
      this._scrollToBottom();
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  render() {
    const styles = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .terminal-container {
          background: #1A0F2E;
          border: 1px solid #2A1F3E;
          border-radius: 5px;
          overflow: hidden;
        }

        .terminal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 14px;
          background: #140B24;
          border-bottom: 1px solid #2A1F3E;
        }

        .terminal-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          font-weight: 600;
          color: #C0B8D0;
        }

        .terminal-dots {
          display: flex;
          gap: 6px;
        }

        .terminal-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }

        .terminal-dot.red { background: #ff5f56; }
        .terminal-dot.yellow { background: #ffbd2e; }
        .terminal-dot.green { background: #27c93f; }

        .terminal-controls {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .terminal-btn {
          padding: 4px 10px;
          background: #2A1F4A;
          border: 1px solid #3D3060;
          border-radius: 4px;
          color: #C0B8D0;
          font-size: 11px;
          cursor: pointer;
          transition: all var(--loki-transition);
        }

        .terminal-btn:hover {
          background: #3D3060;
          color: #F0ECF8;
        }

        .terminal-btn.active {
          background: #7B6BF0;
          border-color: #7B6BF0;
          color: white;
        }

        .filter-input {
          padding: 4px 10px;
          background: #2A1F4A;
          border: 1px solid #3D3060;
          border-radius: 4px;
          color: #F0ECF8;
          font-size: 11px;
          width: 120px;
        }

        .filter-input:focus {
          outline: none;
          border-color: #7B6BF0;
        }

        .filter-input::placeholder {
          color: #8B7FA8;
        }

        .level-select {
          padding: 4px 10px;
          background: #2A1F4A;
          border: 1px solid #3D3060;
          border-radius: 4px;
          color: #C0B8D0;
          font-size: 11px;
          cursor: pointer;
        }

        .log-output {
          padding: 14px;
          max-height: 350px;
          overflow-y: auto;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          line-height: 1.6;
          color: #F0ECF8;
          background: #1A0F2E;
        }

        .log-line {
          display: flex;
          gap: 10px;
          white-space: pre-wrap;
          word-break: break-all;
        }

        .log-line .timestamp {
          color: var(--loki-text-muted);
          flex-shrink: 0;
        }

        .log-line .level {
          flex-shrink: 0;
          font-weight: 500;
        }

        .log-line .message {
          flex: 1;
        }

        .log-empty {
          color: var(--loki-text-muted);
          text-align: center;
          padding: 40px;
        }

        .log-count {
          font-size: 10px;
          color: var(--loki-text-muted);
          padding: 4px 14px;
          border-top: 1px solid var(--loki-border);
          background: var(--loki-bg-secondary);
        }

        /* Scrollbar */
        .log-output::-webkit-scrollbar { width: 6px; }
        .log-output::-webkit-scrollbar-track { background: var(--loki-bg-secondary); }
        .log-output::-webkit-scrollbar-thumb { background: var(--loki-border-light); border-radius: 3px; }
        .log-output::-webkit-scrollbar-thumb:hover { background: var(--loki-text-muted); }
      </style>
    `;

    this.shadowRoot.innerHTML = `
      ${styles}
      <div class="terminal-container">
        <div class="terminal-header">
          <div class="terminal-title">
            <div class="terminal-dots">
              <span class="terminal-dot red"></span>
              <span class="terminal-dot yellow"></span>
              <span class="terminal-dot green"></span>
            </div>
            loki-mode -- agent output
          </div>
          <div class="terminal-controls">
            <input type="text" class="filter-input" id="filter-input" placeholder="Filter logs...">
            <select class="level-select" id="level-select">
              <option value="all">All Levels</option>
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="step">Step</option>
              <option value="agent">Agent</option>
              <option value="debug">Debug</option>
            </select>
            <button class="terminal-btn ${this._autoScroll ? 'active' : ''}" id="auto-scroll-btn" aria-label="Toggle auto-scroll" aria-pressed="${this._autoScroll}">Auto-scroll</button>
            <button class="terminal-btn" id="clear-btn" aria-label="Clear all logs">Clear</button>
            <button class="terminal-btn" id="download-btn" aria-label="Download logs as text file">Download</button>
          </div>
        </div>
        <div class="log-output" id="log-output" role="log" aria-live="polite" aria-label="Log output">
          <div class="log-empty">No log output yet. Terminal will update when Loki Mode is running.</div>
        </div>
        <div class="log-count">
          ${this._logs.length} lines (${this._getFilteredLogs().length} shown)
        </div>
      </div>
    `;

    this._attachEventListeners();
    this._renderLogs();
  }

  _attachEventListeners() {
    const filterInput = this.shadowRoot.getElementById('filter-input');
    const levelSelect = this.shadowRoot.getElementById('level-select');
    const autoScrollBtn = this.shadowRoot.getElementById('auto-scroll-btn');
    const clearBtn = this.shadowRoot.getElementById('clear-btn');
    const downloadBtn = this.shadowRoot.getElementById('download-btn');

    if (filterInput) {
      filterInput.value = this._filter;
      filterInput.addEventListener('input', (e) => this._setFilter(e.target.value));
    }

    if (levelSelect) {
      levelSelect.value = this._levelFilter;
      levelSelect.addEventListener('change', (e) => this._setLevelFilter(e.target.value));
    }

    if (autoScrollBtn) {
      autoScrollBtn.addEventListener('click', () => this._toggleAutoScroll());
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clearLogs());
    }

    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => this._downloadLogs());
    }
  }

  /**
   * Public API to add a log entry programmatically
   */
  addLog(message, level = 'info') {
    this._addLog({ message, level, timestamp: new Date().toLocaleTimeString() });
  }

  /**
   * Public API to clear all logs
   */
  clear() {
    this._clearLogs();
  }
}

// Register the component
if (!customElements.get('loki-log-stream')) {
  customElements.define('loki-log-stream', LokiLogStream);
}

export default LokiLogStream;
