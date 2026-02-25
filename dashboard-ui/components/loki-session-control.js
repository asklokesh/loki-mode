/**
 * @fileoverview Loki Session Control Component - control panel for managing
 * the Loki Mode session lifecycle. Provides start, pause, resume, and stop
 * controls with both compact and full layout modes. Displays connection
 * status, version info, agent/task counts, and session metadata.
 *
 * @example
 * <loki-session-control api-url="http://localhost:57374" theme="dark" compact></loki-session-control>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { getState } from '../core/loki-state.js';

/**
 * @class LokiSessionControl
 * @extends LokiElement
 * @fires session-start - When the start button is clicked
 * @fires session-pause - When the pause button is clicked
 * @fires session-resume - When the resume button is clicked
 * @fires session-stop - When the stop button is clicked
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 * @property {boolean} compact - Show compact layout when present
 */
export class LokiSessionControl extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme', 'compact'];
  }

  constructor() {
    super();
    this._status = {
      mode: 'offline',
      phase: null,
      iteration: null,
      complexity: null,
      connected: false,
      version: null,
      uptime: 0,
      activeAgents: 0,
      pendingTasks: 0,
    };
    this._api = null;
    this._state = getState();
    this._statusUpdateHandler = null;
    this._connectedHandler = null;
    this._disconnectedHandler = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadStatus();
    this._startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
    if (this._api) {
      if (this._statusUpdateHandler) this._api.removeEventListener(ApiEvents.STATUS_UPDATE, this._statusUpdateHandler);
      if (this._connectedHandler) this._api.removeEventListener(ApiEvents.CONNECTED, this._connectedHandler);
      if (this._disconnectedHandler) this._api.removeEventListener(ApiEvents.DISCONNECTED, this._disconnectedHandler);
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._loadStatus();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
    if (name === 'compact') {
      this.render();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });

    this._statusUpdateHandler = (e) => this._updateFromStatus(e.detail);
    this._connectedHandler = () => { this._status.connected = true; this.render(); };
    this._disconnectedHandler = () => { this._status.connected = false; this._status.mode = 'offline'; this.render(); };

    this._api.addEventListener(ApiEvents.STATUS_UPDATE, this._statusUpdateHandler);
    this._api.addEventListener(ApiEvents.CONNECTED, this._connectedHandler);
    this._api.addEventListener(ApiEvents.DISCONNECTED, this._disconnectedHandler);
  }

  async _loadStatus() {
    try {
      const status = await this._api.getStatus();
      this._updateFromStatus(status);
    } catch (error) {
      this._status.connected = false;
      this._status.mode = 'offline';
      this.render();
    }
  }

  _updateFromStatus(status) {
    if (!status) return;

    this._status = {
      ...this._status,
      connected: true,
      mode: status.status || 'running',
      version: status.version,
      uptime: status.uptime_seconds || 0,
      activeAgents: status.running_agents || 0,
      pendingTasks: status.pending_tasks || 0,
      phase: status.phase,
      iteration: status.iteration,
      complexity: status.complexity,
    };

    this._state.updateSession({
      connected: true,
      mode: this._status.mode,
      lastSync: new Date().toISOString(),
    });

    this.render();
  }

  _startPolling() {
    this._ownPollInterval = setInterval(async () => {
      try {
        const status = await this._api.getStatus();
        this._updateFromStatus(status);
      } catch (error) {
        this._status.connected = false;
        this._status.mode = 'offline';
        this.render();
      }
    }, 3000);
  }

  _stopPolling() {
    if (this._ownPollInterval) {
      clearInterval(this._ownPollInterval);
      this._ownPollInterval = null;
    }
  }

  _formatUptime(seconds) {
    if (!seconds || seconds < 0) return '--';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  _getStatusClass() {
    switch (this._status.mode) {
      case 'running':
      case 'autonomous':
        return 'active';
      case 'paused':
        return 'paused';
      case 'stopped':
        return 'stopped';
      case 'error':
        return 'error';
      default:
        return 'offline';
    }
  }

  _getStatusLabel() {
    switch (this._status.mode) {
      case 'running':
      case 'autonomous':
        return 'AUTONOMOUS';
      case 'paused':
        return 'PAUSED';
      case 'stopped':
        return 'STOPPED';
      case 'error':
        return 'ERROR';
      default:
        return 'OFFLINE';
    }
  }

  _triggerStart() {
    this.dispatchEvent(new CustomEvent('session-start', { detail: this._status }));
  }

  async _triggerPause() {
    try {
      await this._api.pauseSession();
      this._status.mode = 'paused';
      this.render();
    } catch (err) {
      console.error('Failed to pause session:', err);
    }
    this.dispatchEvent(new CustomEvent('session-pause', { detail: this._status }));
  }

  async _triggerResume() {
    try {
      await this._api.resumeSession();
      this._status.mode = 'running';
      this.render();
    } catch (err) {
      console.error('Failed to resume session:', err);
    }
    this.dispatchEvent(new CustomEvent('session-resume', { detail: this._status }));
  }

  async _triggerStop() {
    try {
      await this._api.stopSession();
      this._status.mode = 'stopped';
      this.render();
    } catch (err) {
      console.error('Failed to stop session:', err);
    }
    this.dispatchEvent(new CustomEvent('session-stop', { detail: this._status }));
  }

  render() {
    const isCompact = this.hasAttribute('compact');
    const statusClass = this._getStatusClass();
    const statusLabel = this._getStatusLabel();
    const isRunning = ['running', 'autonomous'].includes(this._status.mode);
    const isPaused = this._status.mode === 'paused';

    const styles = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .control-panel {
          background: var(--loki-bg-tertiary);
          border-radius: 5px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: background var(--loki-transition);
        }

        .control-panel.compact {
          padding: 10px;
          gap: 8px;
        }

        .panel-title {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
          margin-bottom: 4px;
        }

        .status-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
        }

        .status-label {
          color: var(--loki-text-secondary);
        }

        .status-value {
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--loki-text-primary);
        }

        .status-dot {
          width: 12px;
          height: 6px;
          border-radius: 2px;
        }

        .status-dot.active {
          background: var(--loki-green);
          animation: pulse 2s infinite;
        }
        .status-dot.idle { background: var(--loki-text-muted); }
        .status-dot.paused { background: var(--loki-yellow); }
        .status-dot.stopped { background: var(--loki-red); }
        .status-dot.error { background: var(--loki-red); }
        .status-dot.offline { background: var(--loki-text-muted); }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .control-buttons {
          display: flex;
          gap: 6px;
          margin-top: 6px;
        }

        .control-btn {
          flex: 1;
          padding: 6px 10px;
          border-radius: 4px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-card);
          color: var(--loki-text-secondary);
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all var(--loki-transition);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }

        .control-btn:hover {
          background: var(--loki-bg-hover);
          color: var(--loki-text-primary);
        }

        .control-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .control-btn.start:hover:not(:disabled) {
          background: var(--loki-green-muted);
          color: var(--loki-green);
          border-color: var(--loki-green);
        }

        .control-btn.pause:hover:not(:disabled) {
          background: var(--loki-yellow-muted);
          color: var(--loki-yellow);
          border-color: var(--loki-yellow);
        }

        .control-btn.resume:hover:not(:disabled) {
          background: var(--loki-green-muted);
          color: var(--loki-green);
          border-color: var(--loki-green);
        }

        .control-btn.stop:hover:not(:disabled) {
          background: var(--loki-red-muted);
          color: var(--loki-red);
          border-color: var(--loki-red);
        }

        .control-btn svg {
          width: 10px;
          height: 10px;
          fill: currentColor;
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          font-size: 11px;
          color: var(--loki-text-muted);
          margin-top: 4px;
        }

        .connection-dot {
          width: 10px;
          height: 5px;
          border-radius: 2px;
          background: var(--loki-red);
        }

        .connection-dot.connected {
          background: var(--loki-green);
          animation: pulse 2s infinite;
        }

        .stats-row {
          display: flex;
          justify-content: space-around;
          padding: 8px 0;
          border-top: 1px solid var(--loki-border);
          margin-top: 4px;
        }

        .stat-item {
          text-align: center;
        }

        .stat-value {
          font-size: 16px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
        }

        .stat-label {
          font-size: 10px;
          color: var(--loki-text-muted);
        }
      </style>
    `;

    const compactContent = `
      <div class="control-panel compact">
        <div class="status-row">
          <span class="status-value">
            <span class="status-dot ${statusClass}"></span>
            ${statusLabel}
          </span>
        </div>
        <div class="control-buttons" role="group" aria-label="Session controls">
          ${isPaused ? `
            <button class="control-btn resume" id="resume-btn" aria-label="Resume session">
              <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Resume
            </button>
          ` : `
            <button class="control-btn pause" id="pause-btn" aria-label="Pause session" ${!isRunning ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              Pause
            </button>
          `}
          <button class="control-btn stop" id="stop-btn" aria-label="Stop session" ${!isRunning && !isPaused ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            Stop
          </button>
        </div>
      </div>
    `;

    const fullContent = `
      <div class="control-panel">
        <div class="panel-title">System Status</div>

        <div class="status-row">
          <span class="status-label">Mode</span>
          <span class="status-value">
            <span class="status-dot ${statusClass}"></span>
            ${statusLabel}
          </span>
        </div>

        <div class="status-row">
          <span class="status-label">Phase</span>
          <span class="status-value">${this._escapeHtml(this._status.phase || '--')}</span>
        </div>

        <div class="status-row">
          <span class="status-label">Complexity</span>
          <span class="status-value">${this._escapeHtml(String(this._status.complexity || '--').toUpperCase())}</span>
        </div>

        <div class="status-row">
          <span class="status-label">Iteration</span>
          <span class="status-value">${this._escapeHtml(this._status.iteration || '--')}</span>
        </div>

        <div class="status-row">
          <span class="status-label">Uptime</span>
          <span class="status-value">${this._formatUptime(this._status.uptime)}</span>
        </div>

        <div class="control-buttons" role="group" aria-label="Session controls">
          ${isPaused ? `
            <button class="control-btn resume" id="resume-btn" aria-label="Resume session">
              <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Resume
            </button>
          ` : `
            <button class="control-btn pause" id="pause-btn" aria-label="Pause session" ${!isRunning ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              Pause
            </button>
          `}
          <button class="control-btn stop" id="stop-btn" aria-label="Stop session" ${!isRunning && !isPaused ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            Stop
          </button>
        </div>

        <div class="connection-status">
          <span class="connection-dot ${this._status.connected ? 'connected' : ''}"></span>
          <span>${this._status.connected ? 'Connected' : 'Disconnected'}</span>
          ${this._status.version ? `<span style="margin-left: auto">v${this._status.version}</span>` : ''}
        </div>

        <div class="stats-row">
          <div class="stat-item">
            <div class="stat-value">${this._status.activeAgents}</div>
            <div class="stat-label">Agents</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${this._status.pendingTasks}</div>
            <div class="stat-label">Pending</div>
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.innerHTML = `
      ${styles}
      ${isCompact ? compactContent : fullContent}
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const pauseBtn = this.shadowRoot.getElementById('pause-btn');
    const resumeBtn = this.shadowRoot.getElementById('resume-btn');
    const stopBtn = this.shadowRoot.getElementById('stop-btn');
    const startBtn = this.shadowRoot.getElementById('start-btn');

    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => this._triggerPause());
    }
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => this._triggerResume());
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', () => this._triggerStop());
    }
    if (startBtn) {
      startBtn.addEventListener('click', () => this._triggerStart());
    }
  }
}

// Register the component
if (!customElements.get('loki-session-control')) {
  customElements.define('loki-session-control', LokiSessionControl);
}

export default LokiSessionControl;
