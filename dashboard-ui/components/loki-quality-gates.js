/**
 * @fileoverview Quality Gate Status Dashboard - displays the status of all 9
 * quality gates as color-coded cards. Auto-refreshes every 30 seconds.
 * Green = pass, red = fail, yellow = pending.
 *
 * @example
 * <loki-quality-gates api-url="http://localhost:57374" theme="dark"></loki-quality-gates>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Object<string, {color: string, bg: string, label: string}>} */
const GATE_STATUS_CONFIG = {
  pass:    { color: 'var(--loki-green, #22c55e)',  bg: 'var(--loki-green-muted, rgba(34, 197, 94, 0.15))',  label: 'PASS' },
  fail:    { color: 'var(--loki-red, #ef4444)',    bg: 'var(--loki-red-muted, rgba(239, 68, 68, 0.15))',    label: 'FAIL' },
  pending: { color: 'var(--loki-yellow, #eab308)', bg: 'var(--loki-yellow-muted, rgba(234, 179, 8, 0.15))', label: 'PENDING' },
};

/**
 * Format a timestamp to a short human-readable string.
 * @param {string|null} timestamp - ISO timestamp
 * @returns {string} Formatted time
 */
export function formatGateTime(timestamp) {
  if (!timestamp) return 'Never';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown';
  }
}

/**
 * Summarize gate statuses into counts.
 * @param {Array} gates - Array of gate objects with status field
 * @returns {{pass: number, fail: number, pending: number, total: number}}
 */
export function summarizeGates(gates) {
  if (!gates || gates.length === 0) return { pass: 0, fail: 0, pending: 0, total: 0 };
  const result = { pass: 0, fail: 0, pending: 0, total: gates.length };
  for (const gate of gates) {
    const status = (gate.status || 'pending').toLowerCase();
    if (status === 'pass') result.pass++;
    else if (status === 'fail') result.fail++;
    else result.pending++;
  }
  return result;
}

/**
 * @class LokiQualityGates
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiQualityGates extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._gates = [];
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
    this._pollInterval = setInterval(() => this._loadData(), 30000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) {
          clearInterval(this._pollInterval);
          this._pollInterval = null;
        }
      } else {
        if (!this._pollInterval) {
          this._loadData();
          this._pollInterval = setInterval(() => this._loadData(), 30000);
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
      this._loading = true;
      const data = await this._api._get('/api/council/gate');
      const gates = data?.gates || data || [];
      const dataHash = JSON.stringify(gates);
      if (dataHash === this._lastDataHash) return;
      this._lastDataHash = dataHash;
      this._gates = Array.isArray(gates) ? gates : [];
      this._error = null;
    } catch (err) {
      if (!this._error) {
        this._error = `Failed to load quality gates: ${err.message}`;
      }
    } finally {
      this._loading = false;
    }

    this.render();
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

      .quality-gates {
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

      .summary {
        display: flex;
        gap: 12px;
        font-size: 12px;
      }

      .summary-item {
        display: flex;
        align-items: center;
        gap: 4px;
        font-weight: 500;
      }

      .summary-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }

      .gates-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 12px;
      }

      .gate-card {
        background: var(--loki-bg-card, #18181b);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 8px;
        padding: 14px;
        border-left: 3px solid transparent;
        transition: all 0.15s ease;
      }

      .gate-card:hover {
        border-color: var(--loki-border-light, rgba(255, 255, 255, 0.1));
      }

      .gate-card.status-pass {
        border-left-color: var(--loki-green, #22c55e);
      }

      .gate-card.status-fail {
        border-left-color: var(--loki-red, #ef4444);
      }

      .gate-card.status-pending {
        border-left-color: var(--loki-yellow, #eab308);
      }

      .gate-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 8px;
      }

      .gate-name {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.3;
      }

      .gate-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        flex-shrink: 0;
      }

      .gate-meta {
        font-size: 11px;
        color: var(--loki-text-muted, #52525b);
      }

      .gate-description {
        font-size: 12px;
        color: var(--loki-text-secondary, #a1a1aa);
        margin-top: 6px;
        line-height: 1.4;
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
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const gates = this._gates;
    const summary = summarizeGates(gates);

    let content;
    if (this._loading && gates.length === 0) {
      content = '<div class="loading">Loading quality gates...</div>';
    } else if (gates.length === 0) {
      content = '<div class="empty-state">No quality gates configured.</div>';
    } else {
      const cards = gates.map(gate => {
        const status = (gate.status || 'pending').toLowerCase();
        const cfg = GATE_STATUS_CONFIG[status] || GATE_STATUS_CONFIG.pending;
        return `
          <div class="gate-card status-${status}">
            <div class="gate-header">
              <span class="gate-name">${this._escapeHtml(gate.name || 'Unnamed Gate')}</span>
              <span class="gate-badge" style="background: ${cfg.bg}; color: ${cfg.color};">${cfg.label}</span>
            </div>
            ${gate.description ? `<div class="gate-description">${this._escapeHtml(gate.description)}</div>` : ''}
            <div class="gate-meta">Last checked: ${formatGateTime(gate.last_checked || gate.lastChecked)}</div>
          </div>
        `;
      }).join('');

      content = `<div class="gates-grid">${cards}</div>`;
    }

    const summaryHtml = summary.total > 0 ? `
      <div class="summary">
        <span class="summary-item">
          <span class="summary-dot" style="background: var(--loki-green, #22c55e)"></span>
          ${summary.pass} Pass
        </span>
        <span class="summary-item">
          <span class="summary-dot" style="background: var(--loki-red, #ef4444)"></span>
          ${summary.fail} Fail
        </span>
        <span class="summary-item">
          <span class="summary-dot" style="background: var(--loki-yellow, #eab308)"></span>
          ${summary.pending} Pending
        </span>
      </div>
    ` : '';

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="quality-gates">
        <div class="header">
          <h2 class="title">Quality Gates</h2>
          ${summaryHtml}
        </div>
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;
  }
}

if (!customElements.get('loki-quality-gates')) {
  customElements.define('loki-quality-gates', LokiQualityGates);
}

export default LokiQualityGates;
