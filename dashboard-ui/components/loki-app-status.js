/**
 * @fileoverview Loki App Runner Status - displays the app runner state
 * including status indicator, detected method, port, URL, restart count,
 * uptime, log viewer, and control buttons. Polls /api/app-runner/status
 * every 3 seconds with visibility-aware pause/resume.
 *
 * @example
 * <loki-app-status api-url="http://localhost:57374" theme="dark"></loki-app-status>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

const STATUS_CONFIG = {
  not_initialized: { color: 'var(--loki-text-muted, #71717a)', label: 'Not Started', pulse: false },
  starting:        { color: 'var(--loki-yellow, #ca8a04)',      label: 'Starting...',  pulse: true },
  running:         { color: 'var(--loki-green, #16a34a)',       label: 'Running',      pulse: true },
  stale:           { color: 'var(--loki-yellow, #ca8a04)',      label: 'Stale',        pulse: false },
  completed:       { color: 'var(--loki-text-muted, #a1a1aa)',  label: 'Completed',    pulse: false },
  failed:          { color: 'var(--loki-red, #dc2626)',         label: 'Failed',       pulse: false },
  crashed:         { color: 'var(--loki-red, #dc2626)',         label: 'Crashed',      pulse: false },
  stopped:         { color: 'var(--loki-text-muted, #a1a1aa)',  label: 'Stopped',      pulse: false },
  unknown:         { color: 'var(--loki-text-muted, #71717a)',  label: 'Unknown',      pulse: false },
};

/**
 * @class LokiAppStatus
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiAppStatus extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._pollInterval = null;
    this._status = null;
    this._logs = [];
    this._lastDataHash = null;
    this._lastLogsHash = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadData();
    this._startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._loadData();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  _startPolling() {
    this._pollInterval = setInterval(() => this._loadData(), 3000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) {
          clearInterval(this._pollInterval);
          this._pollInterval = null;
        }
      } else {
        if (!this._pollInterval) {
          this._loadData();
          this._pollInterval = setInterval(() => this._loadData(), 3000);
        }
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  async _loadData() {
    try {
      const [status, logsData] = await Promise.all([
        this._api.getAppRunnerStatus(),
        this._api.getAppRunnerLogs(),
      ]);
      const dataHash = JSON.stringify({
        status: status?.status,
        port: status?.port,
        restarts: status?.restart_count,
        url: status?.url,
      });
      const logsHash = JSON.stringify(logsData?.lines?.slice(-5) || []);
      const logsChanged = logsHash !== this._lastLogsHash;
      if (dataHash === this._lastDataHash && !logsChanged) return;
      this._lastDataHash = dataHash;
      this._lastLogsHash = logsHash;
      this._status = status;
      this._logs = logsData?.lines || [];
      this._error = null;
      this.render();
      this._scrollLogsToBottom();
    } catch (err) {
      if (!this._error) {
        this._error = `Failed to load app status: ${err.message}`;
        this.render();
      }
    }
  }

  _scrollLogsToBottom() {
    const s = this.shadowRoot;
    if (!s) return;
    const logArea = s.querySelector('.log-area');
    if (logArea) {
      logArea.scrollTop = logArea.scrollHeight;
    }
  }

  async _handleRestart() {
    try {
      await this._api.restartApp();
      this._loadData();
    } catch (err) {
      this._error = `Restart failed: ${err.message}`;
      this.render();
    }
  }

  async _handleStop() {
    try {
      await this._api.stopApp();
      this._loadData();
    } catch (err) {
      this._error = `Stop failed: ${err.message}`;
      this.render();
    }
  }

  _formatUptime(startedAt) {
    if (!startedAt) return '--';
    const start = new Date(startedAt);
    const now = new Date();
    const diffSec = Math.floor((now - start) / 1000);
    if (diffSec < 60) return `${diffSec}s`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`;
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  _isValidUrl(str) {
    if (!str) return false;
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  _getStyles() {
    return `
      .app-status {
        padding: 16px;
        font-family: var(--loki-font-family, system-ui, -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }
      .header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .title {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }

      /* Status indicator */
      .status-dot {
        width: 12px;
        height: 6px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .status-dot.pulse {
        animation: dot-pulse 1.5s ease-in-out infinite;
      }
      @keyframes dot-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
      }

      /* Status card */
      .status-card {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #e4e4e7);
        border-radius: 5px;
        padding: 14px;
        margin-bottom: 12px;
      }
      .status-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 0;
        font-size: 13px;
      }
      .status-label {
        color: var(--loki-text-secondary, #52525b);
      }
      .status-value {
        font-weight: 500;
      }
      .status-value a {
        color: var(--loki-accent, #553DE9);
        text-decoration: none;
      }
      .status-value a:hover {
        text-decoration: underline;
      }

      /* Log viewer */
      .log-section {
        margin-bottom: 12px;
      }
      .log-header {
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 6px;
        color: var(--loki-text-secondary, #52525b);
      }
      .log-area {
        background: var(--loki-bg-tertiary, #1a1a2e);
        border: 1px solid var(--loki-border, #e4e4e7);
        border-radius: 4px;
        padding: 10px;
        max-height: 300px;
        overflow-y: auto;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 11px;
        line-height: 1.5;
        color: var(--loki-text-muted, #a1a1aa);
        white-space: pre-wrap;
        word-break: break-all;
      }
      .log-empty {
        color: var(--loki-text-muted, #71717a);
        font-style: italic;
      }

      /* Action buttons */
      .actions {
        display: flex;
        gap: 8px;
      }
      .btn {
        padding: 5px 14px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid var(--loki-border, #e4e4e7);
        background: var(--loki-bg-secondary, #f4f4f5);
        color: var(--loki-text-primary, #201515);
        transition: background 0.15s;
      }
      .btn:hover {
        background: var(--loki-bg-hover, #f0f0f3);
      }
      .btn-danger {
        border-color: var(--loki-red, #dc2626);
        color: var(--loki-red, #dc2626);
      }
      .btn-danger:hover {
        background: var(--loki-red-muted, rgba(220, 38, 38, 0.12));
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Empty state */
      .empty-state {
        text-align: center;
        padding: 48px 24px;
        color: var(--loki-text-secondary, #52525b);
      }
      .empty-state p {
        margin: 8px 0;
        font-size: 14px;
      }
      .empty-state .hint {
        font-size: 12px;
        color: var(--loki-text-muted, #71717a);
      }

      /* Error */
      .error-banner {
        margin-top: 12px;
        padding: 8px 12px;
        background: color-mix(in srgb, var(--loki-status-error, #ef4444) 10%, transparent);
        color: var(--loki-status-error, #ef4444);
        border-radius: 4px;
        font-size: 12px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const st = this._status;
    const isActive = st && st.status && st.status !== 'not_initialized';

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="app-status">
        <div class="header">
          <div class="header-left">
            <h2 class="title">App Runner</h2>
            ${this._renderStatusBadge(st)}
          </div>
          ${isActive ? this._renderActions(st) : ''}
        </div>
        ${isActive ? this._renderStatusCard(st) : ''}
        ${isActive && this._logs.length > 0 ? this._renderLogs() : ''}
        ${!isActive ? this._renderEmpty() : ''}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _renderStatusBadge(st) {
    const status = st?.status || 'not_initialized';
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.not_initialized;
    return `
      <span class="status-badge" style="background: color-mix(in srgb, ${cfg.color} 15%, transparent); color: ${cfg.color}">
        <span class="status-dot ${cfg.pulse ? 'pulse' : ''}" style="background: ${cfg.color}"></span>
        ${this._escapeHtml(cfg.label)}
      </span>
    `;
  }

  _renderStatusCard(st) {
    const urlValid = this._isValidUrl(st.url);
    const urlHtml = urlValid
      ? `<a href="${this._escapeHtml(st.url)}" target="_blank" rel="noopener noreferrer">${this._escapeHtml(st.url)}</a>`
      : this._escapeHtml(st.url || '--');

    return `
      <div class="status-card">
        <div class="status-row">
          <span class="status-label">Method</span>
          <span class="status-value">${this._escapeHtml(st.method || '--')}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Port</span>
          <span class="status-value">${st.port ? this._escapeHtml(String(st.port)) : '--'}</span>
        </div>
        <div class="status-row">
          <span class="status-label">URL</span>
          <span class="status-value">${urlHtml}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Restarts</span>
          <span class="status-value">${st.restart_count != null ? st.restart_count : '--'}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Uptime</span>
          <span class="status-value">${st.status === 'running' || st.status === 'stale' ? this._formatUptime(st.started_at) : '--'}</span>
        </div>
        ${st.status === 'crashed' && st.error ? `
          <div class="status-row" style="margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--loki-border, #e4e4e7);">
            <span class="status-label" style="color: var(--loki-red, #dc2626)">Error</span>
            <span class="status-value" style="color: var(--loki-red, #dc2626); max-width: 70%; text-align: right;">${this._escapeHtml(st.error)}</span>
          </div>
        ` : ''}
      </div>
    `;
  }

  _renderLogs() {
    const last20 = this._logs.slice(-20);
    return `
      <div class="log-section">
        <div class="log-header">Application Logs</div>
        <div class="log-area">${last20.length > 0
          ? last20.map(line => this._escapeHtml(line)).join('\n')
          : '<span class="log-empty">No log output yet</span>'
        }</div>
      </div>
    `;
  }

  _renderActions(st) {
    const canRestart = st.status === 'running' || st.status === 'crashed' || st.status === 'stopped';
    const canStop = st.status === 'running' || st.status === 'starting';
    return `
      <div class="actions">
        <button class="btn" data-action="restart" ${canRestart ? '' : 'disabled'}>Restart</button>
        <button class="btn btn-danger" data-action="stop" ${canStop ? '' : 'disabled'}>Stop</button>
      </div>
    `;
  }

  _renderEmpty() {
    return `
      <div class="empty-state">
        <p>App runner not started</p>
        <p class="hint">App runner will start after the first successful build iteration.</p>
      </div>
    `;
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;
    const restartBtn = s.querySelector('[data-action="restart"]');
    const stopBtn = s.querySelector('[data-action="stop"]');
    if (restartBtn) restartBtn.addEventListener('click', () => this._handleRestart());
    if (stopBtn) stopBtn.addEventListener('click', () => this._handleStop());
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

customElements.define('loki-app-status', LokiAppStatus);
