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
import { registerPoll } from '../core/loki-poll-registry.js';

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
    this._evidence = { blocked: false };
    this._pollInterval = null;
    this._lastDataHash = null;
    this._scanning = false;
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
      this._api = getApiClient({ baseUrl: newValue });
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
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, replacing the per-component
    // visibilitychange handler. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadData(),
      intervalMs: 30000,
      element: this,
      immediate: false,
    });
  }

  _stopPolling() {
    if (this._poll) {
      this._poll.stop();
      this._poll = null;
    }
  }

  async _loadData() {
    // Capture the api instance so a mid-flight api-url switch can be detected.
    const api = this._api;
    try {
      this._loading = true;
      const data = await api._get('/api/council/gate');
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      const gates = data?.gates || data || [];
      // Verified-completion evidence gate (v7.19.1): surfaced alongside the
      // quality gates so a blocked completion shows WHY (empty diff / red
      // tests) instead of the run silently refusing to stop.
      const evidence = data?.evidence || { blocked: false };
      const dataHash = JSON.stringify({ gates, evidence });
      if (dataHash === this._lastDataHash) return;
      this._lastDataHash = dataHash;
      this._gates = Array.isArray(gates) ? gates : [];
      this._evidence = evidence;
      this._error = null;
    } catch (err) {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      if (!this._error) {
        this._error = `Failed to load quality gates: ${err.message}`;
      }
    } finally {
      this._loading = false;
    }

    this.render();
  }

  async _triggerScan() {
    if (this._scanning) return;
    // Capture the api instance so a mid-flight api-url switch can be detected.
    const api = this._api;
    this._scanning = true;
    this.render();
    try {
      // A quality scan is the one-click action that produces gate results from
      // the dashboard. Full-codebase audit can exceed the default client
      // timeout, so allow a generous 300s budget.
      await api._post('/api/quality-scan', {}, { timeout: 300000 });
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._lastDataHash = null; // force re-render with fresh data
      await this._loadData();
    } catch (err) {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._error = `Quality scan failed: ${err.message}`;
    } finally {
      this._scanning = false;
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

      .quality-gates {
        padding: 16px;
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }

      .evidence-banner {
        border: 1px solid var(--loki-red, #ef4444);
        background: var(--loki-red-bg, rgba(239, 68, 68, 0.08));
        border-radius: 8px;
        padding: 12px 14px;
        margin-bottom: 16px;
      }

      .evidence-title {
        font-weight: 600;
        font-size: 14px;
        color: var(--loki-red, #ef4444);
        margin-bottom: 4px;
      }

      .evidence-reason {
        font-size: 13px;
        margin-bottom: 6px;
      }

      .evidence-failures {
        margin: 6px 0;
        padding-left: 18px;
        font-size: 12px;
      }

      .evidence-hint {
        font-size: 11px;
        opacity: 0.75;
      }

      .evidence-hint code {
        font-family: var(--loki-font-mono, monospace);
        background: var(--loki-code-bg, rgba(0, 0, 0, 0.06));
        padding: 1px 4px;
        border-radius: 3px;
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
        width: 12px;
        height: 6px;
        border-radius: 2px;
      }

      .gates-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 12px;
      }

      .gate-card {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        padding: 14px;
        border-left: 3px solid transparent;
        transition: all 0.15s ease;
      }

      .gate-card:hover {
        border-color: var(--loki-border-light, #C5C0B1);
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
        border-radius: 5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        flex-shrink: 0;
      }

      .gate-meta {
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
      }

      .gate-description {
        font-size: 12px;
        color: var(--loki-text-secondary, #36342E);
        margin-top: 6px;
        line-height: 1.4;
      }

      .empty-state {
        text-align: center;
        padding: 40px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }

      /* Branded empty / error states */
      .es {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 48px 24px;
        gap: 4px;
      }

      .es-icon {
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--loki-radius-full, 9999px);
        background: var(--loki-accent-muted, rgba(85, 61, 233, 0.10));
        color: var(--loki-accent, #553DE9);
        margin-bottom: 14px;
      }

      .es-icon svg {
        width: 22px;
        height: 22px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .es-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--loki-text-primary, #201515);
      }

      .es-desc {
        font-size: 13px;
        color: var(--loki-text-muted, #939084);
        line-height: 1.55;
        max-width: 380px;
      }

      .es-desc code {
        font-family: var(--loki-font-mono, monospace);
        font-size: 12px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        color: var(--loki-text-secondary, #36342E);
        padding: 1px 5px;
        border-radius: 3px;
      }

      .es-cta {
        margin-top: 16px;
        padding: 9px 18px;
        background: var(--loki-accent, #553DE9);
        color: var(--loki-text-inverse, #fff);
        border: none;
        border-radius: var(--loki-radius-md, 4px);
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: background 0.15s ease;
      }

      .es-cta:hover:not(:disabled) {
        background: var(--loki-accent-hover, #4432c4);
      }

      .es-cta:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .es-spinner {
        width: 13px;
        height: 13px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: es-spin 0.8s linear infinite;
      }

      @keyframes es-spin { to { transform: rotate(360deg); } }

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

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const gates = this._gates;
    const summary = summarizeGates(gates);

    const gateIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

    let content;
    if (this._loading && gates.length === 0) {
      content = '<div class="loading">Loading quality gates...</div>';
    } else if (gates.length === 0) {
      content = `
        <div class="es">
          <div class="es-icon">${gateIcon}</div>
          <div class="es-title">No gate results yet</div>
          <div class="es-desc">Quality gates run automatically during each build step. Run a scan now, or start a session with <code>loki start ./prd.md</code>.</div>
          <button class="es-cta" id="gates-scan-btn" ${this._scanning ? 'disabled' : ''}>
            ${this._scanning ? '<span class="es-spinner"></span> Scanning...' : 'Run quality scan'}
          </button>
        </div>`;
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

    // Verified-completion evidence gate banner. Shown only when blocking, so
    // the user sees exactly why a "done" was rejected (no diff / red tests).
    let evidenceHtml = '';
    const ev = this._evidence || {};
    if (ev.blocked) {
      const reasonLabels = {
        empty_diff: 'No changes were shipped (empty diff vs run start).',
        tests_red: 'Tests ran and were red.',
        empty_diff_and_tests_red: 'No changes shipped and tests were red.',
        no_evidence_of_completion: 'No evidence of completion.',
      };
      const reasonText = ev.error
        ? this._escapeHtml(ev.error)
        : (reasonLabels[ev.reason] || this._escapeHtml(ev.reason || 'Completion blocked.'));
      const failures = Array.isArray(ev.failures) ? ev.failures : [];
      const failuresHtml = failures.length
        ? `<ul class="evidence-failures">${failures.map(f => `<li>${this._escapeHtml(f)}</li>`).join('')}</ul>`
        : '';
      evidenceHtml = `
        <div class="evidence-banner">
          <div class="evidence-title">Verified completion blocked</div>
          <div class="evidence-reason">${reasonText}</div>
          ${failuresHtml}
          <div class="evidence-hint">The run will keep iterating until there is real evidence of completion. Set <code>LOKI_EVIDENCE_GATE=0</code> to opt out.</div>
        </div>
      `;
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
        ${evidenceHtml}
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    const scanBtn = s.getElementById('gates-scan-btn');
    if (scanBtn) {
      scanBtn.addEventListener('click', () => this._triggerScan());
    }
  }
}

if (!customElements.get('loki-quality-gates')) {
  customElements.define('loki-quality-gates', LokiQualityGates);
}

export default LokiQualityGates;
