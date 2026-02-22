/**
 * @fileoverview Run Manager - displays a table of runs with cancel and replay
 * controls. Shows run ID, project, status, trigger, start time, and duration.
 * Running runs can be cancelled, completed/failed runs can be replayed.
 *
 * @example
 * <loki-run-manager api-url="http://localhost:57374" project-id="5" theme="dark"></loki-run-manager>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Object<string, {color: string, bg: string, label: string}>} */
const RUN_STATUS_CONFIG = {
  running:   { color: 'var(--loki-green, #22c55e)',      bg: 'var(--loki-green-muted, rgba(34, 197, 94, 0.15))',  label: 'Running' },
  completed: { color: 'var(--loki-blue, #3b82f6)',       bg: 'var(--loki-blue-muted, rgba(59, 130, 246, 0.15))',  label: 'Completed' },
  failed:    { color: 'var(--loki-red, #ef4444)',        bg: 'var(--loki-red-muted, rgba(239, 68, 68, 0.15))',    label: 'Failed' },
  cancelled: { color: 'var(--loki-yellow, #eab308)',     bg: 'var(--loki-yellow-muted, rgba(234, 179, 8, 0.15))', label: 'Cancelled' },
  pending:   { color: 'var(--loki-text-muted, #52525b)', bg: 'var(--loki-bg-tertiary, #111114)',                   label: 'Pending' },
  queued:    { color: 'var(--loki-text-muted, #52525b)', bg: 'var(--loki-bg-tertiary, #111114)',                   label: 'Queued' },
};

/**
 * Format a duration from milliseconds or compute from start/end timestamps.
 * @param {number|null} durationMs - Duration in ms, or null
 * @param {string|null} startedAt - ISO start timestamp
 * @param {string|null} endedAt - ISO end timestamp
 * @returns {string}
 */
export function formatRunDuration(durationMs, startedAt, endedAt) {
  let ms = durationMs;
  if (ms == null && startedAt) {
    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : Date.now();
    ms = end - start;
  }
  if (ms == null || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}m ${remainSec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

/**
 * Format a timestamp for display in the run table.
 * @param {string|null} timestamp - ISO timestamp
 * @returns {string}
 */
export function formatRunTime(timestamp) {
  if (!timestamp) return '--';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

/**
 * @class LokiRunManager
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {number} project-id - Optional project ID filter
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiRunManager extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'project-id', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._runs = [];
    this._pollInterval = null;
    this._lastDataHash = null;
  }

  get projectId() {
    const val = this.getAttribute('project-id');
    return val ? parseInt(val, 10) : null;
  }

  set projectId(val) {
    if (val != null) {
      this.setAttribute('project-id', String(val));
    } else {
      this.removeAttribute('project-id');
    }
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
    if (name === 'project-id') {
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
    this._pollInterval = setInterval(() => this._loadData(), 5000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) {
          clearInterval(this._pollInterval);
          this._pollInterval = null;
        }
      } else {
        if (!this._pollInterval) {
          this._loadData();
          this._pollInterval = setInterval(() => this._loadData(), 5000);
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
      const projectId = this.projectId;
      const query = projectId != null ? `?project_id=${projectId}` : '';
      const data = await this._api._get(`/api/v2/runs${query}`);
      const runs = data?.runs || data || [];
      const dataHash = JSON.stringify(runs);
      if (dataHash === this._lastDataHash) return;
      this._lastDataHash = dataHash;
      this._runs = Array.isArray(runs) ? runs : [];
      this._error = null;
    } catch (err) {
      if (!this._error) {
        this._error = `Failed to load runs: ${err.message}`;
      }
    } finally {
      this._loading = false;
    }

    this.render();
  }

  async _cancelRun(runId) {
    try {
      await this._api._post(`/api/v2/runs/${runId}/cancel`);
      await this._loadData();
    } catch (err) {
      this._error = `Cancel failed: ${err.message}`;
      this.render();
    }
  }

  async _replayRun(runId) {
    try {
      await this._api._post(`/api/v2/runs/${runId}/replay`);
      await this._loadData();
    } catch (err) {
      this._error = `Replay failed: ${err.message}`;
      this.render();
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .run-manager {
        padding: 16px;
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #fafafa);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .title {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }

      .btn {
        padding: 4px 10px;
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 5px;
        background: var(--loki-bg-tertiary, #111114);
        color: var(--loki-text-primary, #fafafa);
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--loki-bg-hover, #1f1f23);
        border-color: var(--loki-border-light, rgba(255, 255, 255, 0.1));
      }

      .btn-cancel {
        border-color: var(--loki-red, #ef4444);
        color: var(--loki-red, #ef4444);
      }

      .btn-cancel:hover {
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
      }

      .btn-replay {
        border-color: var(--loki-accent, #8b5cf6);
        color: var(--loki-accent, #8b5cf6);
      }

      .btn-replay:hover {
        background: var(--loki-accent-muted, rgba(139, 92, 246, 0.15));
      }

      .btn-refresh {
        padding: 6px 14px;
        font-size: 12px;
      }

      .runs-table-wrapper {
        background: var(--loki-bg-card, #18181b);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 8px;
        overflow: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      th {
        text-align: left;
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--loki-text-muted, #52525b);
        border-bottom: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        background: var(--loki-bg-tertiary, #111114);
        white-space: nowrap;
      }

      td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        white-space: nowrap;
      }

      tr:last-child td {
        border-bottom: none;
      }

      tr:hover td {
        background: var(--loki-bg-hover, #1f1f23);
      }

      .run-id {
        font-family: 'JetBrains Mono', monospace;
        font-weight: 600;
        color: var(--loki-accent, #8b5cf6);
        font-size: 12px;
      }

      .status-badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
      }

      .actions-cell {
        display: flex;
        gap: 6px;
      }

      .empty-state {
        text-align: center;
        padding: 40px;
        color: var(--loki-text-muted, #52525b);
        font-size: 13px;
      }

      .error-banner {
        margin-top: 12px;
        padding: 8px 12px;
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
        border-radius: 6px;
        font-size: 12px;
      }

      .loading {
        text-align: center;
        padding: 24px;
        color: var(--loki-text-muted, #52525b);
        font-size: 13px;
      }

      .run-count {
        font-size: 12px;
        color: var(--loki-text-muted, #52525b);
        margin-bottom: 8px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const runs = this._runs;

    let content;
    if (this._loading && runs.length === 0) {
      content = '<div class="loading">Loading runs...</div>';
    } else if (runs.length === 0) {
      content = '<div class="empty-state">No runs found.</div>';
    } else {
      const rows = runs.map(run => {
        const status = (run.status || 'pending').toLowerCase();
        const cfg = RUN_STATUS_CONFIG[status] || RUN_STATUS_CONFIG.pending;
        const isRunning = status === 'running';
        const canReplay = status === 'completed' || status === 'failed' || status === 'cancelled';
        const duration = formatRunDuration(run.duration_ms, run.started_at, run.ended_at);

        return `
          <tr>
            <td><span class="run-id">#${run.id}</span></td>
            <td>${this._escapeHtml(run.project_name || run.project || (run.project_id ? `Project #${run.project_id}` : '--'))}</td>
            <td><span class="status-badge" style="background: ${cfg.bg}; color: ${cfg.color};">${cfg.label}</span></td>
            <td>${this._escapeHtml(run.trigger || run.trigger_type || '--')}</td>
            <td>${formatRunTime(run.started_at)}</td>
            <td>${duration}</td>
            <td>
              <div class="actions-cell">
                ${isRunning ? `<button class="btn btn-cancel" data-action="cancel" data-run-id="${run.id}">Cancel</button>` : ''}
                ${canReplay ? `<button class="btn btn-replay" data-action="replay" data-run-id="${run.id}">Replay</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');

      content = `
        <div class="run-count">${runs.length} runs</div>
        <div class="runs-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Project</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="run-manager">
        <div class="header">
          <h2 class="title">Run Manager</h2>
          <button class="btn btn-refresh" id="refresh-btn">Refresh</button>
        </div>
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    const refreshBtn = s.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this._loadData());

    s.querySelectorAll('[data-action="cancel"]').forEach(btn => {
      btn.addEventListener('click', () => this._cancelRun(btn.dataset.runId));
    });

    s.querySelectorAll('[data-action="replay"]').forEach(btn => {
      btn.addEventListener('click', () => this._replayRun(btn.dataset.runId));
    });
  }
}

if (!customElements.get('loki-run-manager')) {
  customElements.define('loki-run-manager', LokiRunManager);
}

export default LokiRunManager;
