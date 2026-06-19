/**
 * @fileoverview Fleet - a single pane over EVERY registered Loki Mode build on
 * this machine. Aggregates the shared metadata store (the machine-global
 * registry + each project's .loki/ state) into one table: per-build status,
 * phase, iteration, cost, and duration, plus fleet-wide totals and a per-build
 * Cancel control.
 *
 * HONEST SCOPE (v1): this polls the shared metadata store via /api/fleet/*.
 * There is NO controller, CRD, or Kubernetes Job-watcher behind it; a real
 * operator watching Jobs is future work. Cancel reuses the per-project Stop
 * teardown; Retry is a documented follow-up (not exposed).
 *
 * @example
 * <loki-fleet api-url="http://localhost:57374" theme="dark"></loki-fleet>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Object<string, {color: string, bg: string, label: string}>} */
const FLEET_STATUS_CONFIG = {
  running:   { color: 'var(--loki-green, #22c55e)',  bg: 'var(--loki-green-muted, rgba(34, 197, 94, 0.15))',  label: 'Running' },
  stopped:   { color: 'var(--loki-yellow, #eab308)', bg: 'var(--loki-yellow-muted, rgba(234, 179, 8, 0.15))', label: 'Stopped' },
  active:    { color: 'var(--loki-blue, #3b82f6)',   bg: 'var(--loki-blue-muted, rgba(59, 130, 246, 0.15))',  label: 'Idle' },
  missing:   { color: 'var(--loki-red, #ef4444)',    bg: 'var(--loki-red-muted, rgba(239, 68, 68, 0.15))',    label: 'Missing' },
  unknown:   { color: 'var(--loki-text-muted, #939084)', bg: 'var(--loki-bg-tertiary, #ECEAE3)',              label: 'Unknown' },
};

/**
 * Format a duration in whole seconds into a compact human string.
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatFleetDuration(seconds) {
  if (seconds == null || seconds < 0) return '--';
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (min < 60) return `${min}m ${remainSec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

/**
 * Format a USD cost for display.
 * @param {number|null} cost
 * @returns {string}
 */
export function formatFleetCost(cost) {
  if (cost == null || isNaN(cost)) return '$0.00';
  return `$${Number(cost).toFixed(2)}`;
}

/**
 * @class LokiFleet
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiFleet extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = true;
    this._error = null;
    this._api = null;
    this._runs = [];
    this._summary = null;
    this._pollInterval = null;
    this._lastDataHash = null;
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
    this._pollInterval = setInterval(() => this._loadData(), 5000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) {
          clearInterval(this._pollInterval);
          this._pollInterval = null;
        }
      } else if (!this._pollInterval) {
        this._loadData();
        this._pollInterval = setInterval(() => this._loadData(), 5000);
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
      const [runsResp, summaryResp] = await Promise.all([
        this._api._get('/api/fleet/runs'),
        this._api._get('/api/fleet/summary'),
      ]);
      const runs = Array.isArray(runsResp) ? runsResp : (runsResp?.runs || []);
      const dataHash = JSON.stringify({ runs, summaryResp });
      if (dataHash === this._lastDataHash) return;
      this._lastDataHash = dataHash;
      this._runs = Array.isArray(runs) ? runs : [];
      this._summary = summaryResp || null;
      this._error = null;
    } catch (err) {
      if (!this._error) {
        this._error = `Failed to load fleet: ${err.message}`;
      }
    } finally {
      this._loading = false;
    }
    this.render();
  }

  async _cancelRun(identifier) {
    if (!identifier) return;
    // Cancel is destructive (SIGTERM -> SIGKILL of the build). Confirm first so a
    // single misclick cannot kill a running build.
    if (typeof confirm === 'function' &&
        !confirm(`Cancel build "${identifier}"? This stops the running build.`)) {
      return;
    }
    try {
      await this._api._post(`/api/fleet/runs/${encodeURIComponent(identifier)}/cancel`);
      // Force a refresh by clearing the dedupe hash.
      this._lastDataHash = null;
      await this._loadData();
    } catch (err) {
      this._error = `Cancel failed: ${err.message}`;
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
      :host { display: block; }

      .fleet {
        padding: 16px;
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .title { font-size: 18px; font-weight: 600; margin: 0; }

      .summary-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }

      .summary-card {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 8px;
        padding: 12px 14px;
      }

      .summary-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
        margin-bottom: 4px;
      }

      .summary-value {
        font-size: 22px;
        font-weight: 700;
        color: var(--loki-text-primary, #201515);
      }

      .scope-note {
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
        margin-bottom: 12px;
        line-height: 1.4;
      }

      .btn {
        padding: 4px 10px;
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        color: var(--loki-text-primary, #201515);
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--loki-bg-hover, #1f1f23);
        border-color: var(--loki-border-light, #C5C0B1);
      }

      .btn-cancel {
        border-color: var(--loki-red, #ef4444);
        color: var(--loki-red, #ef4444);
      }

      .btn-cancel:hover { background: var(--loki-red-muted, rgba(239, 68, 68, 0.15)); }

      .btn-refresh { padding: 6px 14px; font-size: 12px; }

      .runs-table-wrapper {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        overflow: auto;
      }

      table { width: 100%; border-collapse: collapse; font-size: 12px; }

      th {
        text-align: left;
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        background: var(--loki-bg-tertiary, #ECEAE3);
        white-space: nowrap;
      }

      td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        white-space: nowrap;
      }

      tr:last-child td { border-bottom: none; }
      tr:hover td { background: var(--loki-bg-hover, #1f1f23); }

      .project-name { font-weight: 600; color: var(--loki-text-primary, #201515); }

      .project-path {
        font-size: 10px;
        color: var(--loki-text-muted, #939084);
        font-family: 'JetBrains Mono', monospace;
      }

      .status-badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 5px;
        text-transform: uppercase;
      }

      .cost-cell { font-family: 'JetBrains Mono', monospace; }

      .empty-state {
        text-align: center;
        padding: 40px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }

      .error-banner {
        margin-top: 12px;
        padding: 8px 12px;
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
        border-radius: 4px;
        font-size: 12px;
      }

      .loading {
        text-align: center;
        padding: 24px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }
    `;
  }

  _renderSummary() {
    const s = this._summary;
    if (!s) return '';
    return `
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-label">Builds</div>
          <div class="summary-value">${Number(s.total_runs || 0)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Running</div>
          <div class="summary-value">${Number(s.running_runs || 0)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Stopped</div>
          <div class="summary-value">${Number(s.stopped_runs || 0)}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">Total Cost</div>
          <div class="summary-value">${formatFleetCost(s.total_cost_usd)}</div>
        </div>
      </div>
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const runs = this._runs;

    let content;
    if (this._loading && runs.length === 0) {
      content = '<div class="loading">Loading fleet...</div>';
    } else if (runs.length === 0) {
      content = '<div class="empty-state">No registered builds. Run <code>loki start</code> in a project to populate the fleet.</div>';
    } else {
      const rows = runs.map(run => {
        const status = (run.status || 'unknown').toLowerCase();
        const cfg = FLEET_STATUS_CONFIG[status] || FLEET_STATUS_CONFIG.unknown;
        const canCancel = run.running === true;
        const duration = formatFleetDuration(run.duration_seconds);
        const iter = (run.iteration != null) ? run.iteration : 0;
        const phase = run.phase ? this._escapeHtml(run.phase) : '--';

        return `
          <tr>
            <td>
              <div class="project-name">${this._escapeHtml(run.name || 'project')}</div>
              <div class="project-path">${this._escapeHtml(run.path || '')}</div>
            </td>
            <td><span class="status-badge" style="background: ${cfg.bg}; color: ${cfg.color};">${cfg.label}</span></td>
            <td>${phase}</td>
            <td>${iter}</td>
            <td class="cost-cell">${formatFleetCost(run.cost_usd)}</td>
            <td>${duration}</td>
            <td>
              ${canCancel ? `<button class="btn btn-cancel" data-action="cancel" data-id="${this._escapeHtml(run.id || run.path || '')}">Cancel</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');

      content = `
        ${this._renderSummary()}
        <div class="runs-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Status</th>
                <th>Phase</th>
                <th>Iteration</th>
                <th>Cost</th>
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
      <div class="fleet">
        <div class="header">
          <h2 class="title">Fleet</h2>
          <button class="btn btn-refresh" id="refresh-btn">Refresh</button>
        </div>
        <div class="scope-note">
          Fleet view aggregates every registered build on this machine (the
          shared registry plus each project's local state). v1 polls that
          shared metadata store; it is not a controller. A Kubernetes
          Job-watcher is future work.
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
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this._lastDataHash = null;
        this._loadData();
      });
    }

    s.querySelectorAll('[data-action="cancel"]').forEach(btn => {
      btn.addEventListener('click', () => this._cancelRun(btn.dataset.id));
    });
  }
}

if (!customElements.get('loki-fleet')) {
  customElements.define('loki-fleet', LokiFleet);
}

export default LokiFleet;
