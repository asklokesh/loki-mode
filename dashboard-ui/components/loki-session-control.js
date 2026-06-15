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
    // Mid-flight model switching state.
    this._model = {
      override: null,     // currently-active override alias, or null
      default: 'sonnet',  // tier-mapping fallback
      effective: 'sonnet',// what the next iteration will use
      notice: '',         // inline disclosure shown after a change
    };
    this._modelBusy = false;
    // Browser PRD-input: start a build from a spec.
    this._startBusy = false;
    this._startNotice = '';
    this._specText = '';
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
    this._loadModel();
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

  async _triggerStart() {
    if (this._startBusy) return;
    const spec = (this._specText || '').trim();
    if (!spec) {
      this._startNotice = 'Enter a spec or one-line brief to start a build.';
      this.render();
      return;
    }
    if (!this._api || typeof this._api.startSession !== 'function') {
      this._startNotice = 'Start is not available on this server.';
      this.render();
      return;
    }
    this._startBusy = true;
    this._startNotice = 'Starting build...';
    this.render();
    try {
      const result = await this._api.startSession(spec, {
        provider: this._status.provider || 'claude',
      });
      if (result && result.error) throw new Error(result.error);
      // Transition the UI to monitoring the new run.
      this._startBusy = false;
      this._startNotice = '';
      this._specText = '';
      this._status.mode = 'running';
      this._status.connected = true;
      this.render();
      // Pull fresh status so the panel reflects the live run promptly.
      this._loadStatus();
      this.dispatchEvent(new CustomEvent('session-start', {
        detail: { ...this._status, pid: result && result.pid, spec: result && result.spec },
      }));
    } catch (err) {
      console.error('Failed to start build:', err);
      this._startBusy = false;
      // Honest surfacing of single-flight / validation errors from the API.
      this._startNotice = (err && err.message)
        ? `Could not start: ${err.message}`
        : 'Could not start the build. Try again.';
      this.render();
    }
  }

  _onSpecInput(value) {
    // Store without re-render so typing is not interrupted.
    this._specText = value;
  }

  async _triggerPause() {
    try {
      const result = await this._api.pauseSession();
      if (result && result.error) throw new Error(result.error);
      this._status.mode = 'paused';
      this.render();
      this.dispatchEvent(new CustomEvent('session-pause', { detail: this._status }));
    } catch (err) {
      console.error('Failed to pause session:', err);
      this.render();
    }
  }

  async _triggerResume() {
    try {
      const result = await this._api.resumeSession();
      if (result && result.error) throw new Error(result.error);
      this._status.mode = 'running';
      this.render();
      this.dispatchEvent(new CustomEvent('session-resume', { detail: this._status }));
    } catch (err) {
      console.error('Failed to resume session:', err);
      this.render();
    }
  }

  async _triggerStop() {
    try {
      const result = await this._api.stopSession();
      if (result && result.error) throw new Error(result.error);
      this._status.mode = 'stopped';
      this.render();
      this.dispatchEvent(new CustomEvent('session-stop', { detail: this._status }));
    } catch (err) {
      console.error('Failed to stop session:', err);
      this.render();
    }
  }

  async _loadModel() {
    if (!this._api || typeof this._api.getSessionModel !== 'function') return;
    try {
      const m = await this._api.getSessionModel();
      if (m && !m.error) {
        this._model = {
          ...this._model,
          override: m.override ?? null,
          default: m.default || 'sonnet',
          effective: m.effective || m.default || 'sonnet',
        };
        this.render();
      }
    } catch (err) {
      // Older server without the endpoint, or offline: leave defaults.
    }
  }

  async _onModelChange(value) {
    if (this._modelBusy) return;
    this._modelBusy = true;
    // Empty option means "clear override" (revert to tier mapping).
    const next = value === '' ? null : value;
    try {
      const result = await this._api.setSessionModel(next);
      if (result && result.error) throw new Error(result.error);
      this._model.override = next;
      this._model.notice = next
        ? `Switching to ${next}. Applies from the next iteration, for the current run only.`
        : 'Override cleared. Reverts to the tier mapping from the next iteration.';
      // Refresh effective model from the server (authoritative).
      this._modelBusy = false;
      await this._loadModel();
    } catch (err) {
      console.error('Failed to set session model:', err);
      this._model.notice = 'Could not change the model. Try again.';
      this._modelBusy = false;
      this.render();
    }
  }

  _renderModelControl() {
    // The selected value: the active override if set, else empty (= default/
    // tier mapping). The empty option clears the override.
    const selected = this._model.override || '';
    const opts = [
      { value: '', label: `Default (tier: ${this._escapeHtml(this._model.default)})` },
      { value: 'haiku', label: 'Haiku (fastest, cheapest)' },
      { value: 'sonnet', label: 'Sonnet (balanced)' },
      { value: 'opus', label: 'Opus (top coding)' },
      { value: 'fable', label: 'Fable 5 (2x Opus cost: $10/$50 per MTok)' },
    ];
    const optionsHtml = opts.map((o) => {
      const sel = o.value === selected ? ' selected' : '';
      return `<option value="${this._escapeHtml(o.value)}"${sel}>${this._escapeHtml(o.label)}</option>`;
    }).join('');
    const isFable = this._model.effective === 'fable';
    return `
      <div class="model-control">
        <div class="model-row">
          <label for="model-select">Model</label>
          <select class="model-select" id="model-select" aria-label="Run model"${this._modelBusy ? ' disabled' : ''}>
            ${optionsHtml}
          </select>
        </div>
        ${isFable ? `<div class="model-cost-note">Fable 5 costs 2x Opus per token ($10/$50 per MTok).</div>` : ''}
        <div class="model-disclosure">Model changes apply from the next iteration, for the current run only.</div>
        ${this._model.notice ? `<div class="model-notice">${this._escapeHtml(this._model.notice)}</div>` : ''}
      </div>
    `;
  }

  _renderStartControl() {
    // Browser PRD-input: a spec textarea + Start button, shown when no run is
    // active so a user can kick off a build straight from the dashboard.
    return `
      <div class="start-control">
        <label class="start-label" for="spec-input">Start a build from a spec</label>
        <textarea
          class="spec-input"
          id="spec-input"
          rows="3"
          placeholder="Paste a PRD or type a one-line brief (e.g. 'a CLI todo app in Go with JSON storage')"
          aria-label="Spec or one-line brief"
          ${this._startBusy ? 'disabled' : ''}>${this._escapeHtml(this._specText)}</textarea>
        <button class="control-btn start" id="start-btn" aria-label="Start build" ${this._startBusy ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          ${this._startBusy ? 'Starting...' : 'Start Build'}
        </button>
        ${this._startNotice ? `<div class="start-notice">${this._escapeHtml(this._startNotice)}</div>` : ''}
      </div>
    `;
  }

  render() {
    const isCompact = this.hasAttribute('compact');
    const statusClass = this._getStatusClass();
    const statusLabel = this._getStatusLabel();
    const isRunning = ['running', 'autonomous'].includes(this._status.mode);
    const isPaused = this._status.mode === 'paused';
    // Browser PRD-input: offer Start only when no run is active.
    const canStart = !isRunning && !isPaused;

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

        .model-control {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--loki-border);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .model-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .model-row label {
          font-size: 11px;
          color: var(--loki-text-secondary);
          white-space: nowrap;
        }

        .model-select {
          flex: 1;
          padding: 5px 8px;
          border-radius: 4px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-card);
          color: var(--loki-text-primary);
          font-size: 11px;
          cursor: pointer;
        }

        .model-select:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .model-cost-note {
          font-size: 10px;
          color: var(--loki-yellow);
        }

        .model-disclosure {
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .model-notice {
          font-size: 10px;
          color: var(--loki-accent);
        }

        .start-control {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--loki-border);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .start-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--loki-text-secondary);
        }

        .spec-input {
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
          padding: 6px 8px;
          border-radius: 4px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-card);
          color: var(--loki-text-primary);
          font-size: 11px;
          font-family: inherit;
        }

        .spec-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .start-notice {
          font-size: 10px;
          color: var(--loki-accent);
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
        ${canStart ? this._renderStartControl() : ''}
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

        ${canStart ? this._renderStartControl() : ''}

        ${this._renderModelControl()}

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

    const modelSelect = this.shadowRoot.getElementById('model-select');
    if (modelSelect) {
      modelSelect.addEventListener('change', (e) => this._onModelChange(e.target.value));
    }

    const specInput = this.shadowRoot.getElementById('spec-input');
    if (specInput) {
      specInput.addEventListener('input', (e) => this._onSpecInput(e.target.value));
    }
  }
}

// Register the component
if (!customElements.get('loki-session-control')) {
  customElements.define('loki-session-control', LokiSessionControl);
}

export default LokiSessionControl;
