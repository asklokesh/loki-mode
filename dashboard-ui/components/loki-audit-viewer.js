/**
 * @fileoverview Audit Log Browser with Chain Verification - displays audit
 * entries in a filterable table with date range, action type, and resource
 * type filters. Includes an integrity verification button that calls the
 * audit verify endpoint.
 *
 * @example
 * <loki-audit-viewer api-url="http://localhost:57374" limit="100" theme="dark"></loki-audit-viewer>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/**
 * Format a timestamp to a locale-appropriate display string.
 * @param {string|null} timestamp - ISO timestamp
 * @returns {string}
 */
export function formatAuditTimestamp(timestamp) {
  if (!timestamp) return '--';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

/**
 * Build query string from filter params (excludes empty values).
 * @param {Object} filters - Filter key/value pairs
 * @returns {string} Query string (with leading ?)
 */
export function buildAuditQuery(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && value !== '') {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * @class LokiAuditViewer
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {number} limit - Max entries to fetch (default: 50)
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiAuditViewer extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'limit', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._entries = [];
    this._verifyResult = null;
    this._verifying = false;

    // Filter state
    this._filters = {
      action: '',
      resource: '',
      dateFrom: '',
      dateTo: '',
    };
  }

  get limit() {
    const val = this.getAttribute('limit');
    return val ? parseInt(val, 10) : 50;
  }

  set limit(val) {
    this.setAttribute('limit', String(val));
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadData();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._loadData();
    }
    if (name === 'limit') {
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

  async _loadData() {
    try {
      this._loading = true;
      this.render();

      const queryFilters = {
        limit: this.limit,
        action: this._filters.action,
        resource: this._filters.resource,
        date_from: this._filters.dateFrom,
        date_to: this._filters.dateTo,
      };

      const query = buildAuditQuery(queryFilters);
      const data = await this._api._get(`/api/v2/audit${query}`);
      this._entries = data?.entries || data || [];
      this._error = null;
    } catch (err) {
      this._error = `Failed to load audit log: ${err.message}`;
    } finally {
      this._loading = false;
    }

    this.render();
  }

  async _verifyIntegrity() {
    try {
      this._verifying = true;
      this._verifyResult = null;
      this.render();

      const result = await this._api._get('/api/v2/audit/verify');
      this._verifyResult = result;
    } catch (err) {
      this._verifyResult = { valid: false, error: err.message };
    } finally {
      this._verifying = false;
    }

    this.render();
  }

  _onFilterChange(field, value) {
    this._filters[field] = value;
    this._loadData();
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

      .audit-viewer {
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

      .header-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .btn {
        padding: 6px 14px;
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 6px;
        background: var(--loki-bg-tertiary, #111114);
        color: var(--loki-text-primary, #fafafa);
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--loki-accent, #8b5cf6);
        border-color: var(--loki-accent, #8b5cf6);
        color: white;
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--loki-accent, #8b5cf6);
        border-color: var(--loki-accent, #8b5cf6);
        color: white;
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 16px;
        padding: 12px;
        background: var(--loki-bg-card, #18181b);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 8px;
      }

      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .filter-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--loki-text-muted, #52525b);
      }

      .filter-input {
        padding: 5px 10px;
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 4px;
        background: var(--loki-bg-tertiary, #111114);
        color: var(--loki-text-primary, #fafafa);
        font-size: 12px;
        min-width: 140px;
      }

      .filter-input:focus {
        outline: none;
        border-color: var(--loki-accent, #8b5cf6);
      }

      .verify-result {
        margin-bottom: 12px;
        padding: 10px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .verify-valid {
        background: var(--loki-green-muted, rgba(34, 197, 94, 0.15));
        color: var(--loki-green, #22c55e);
        border: 1px solid var(--loki-green-muted, rgba(34, 197, 94, 0.15));
      }

      .verify-invalid {
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
        border: 1px solid var(--loki-red-muted, rgba(239, 68, 68, 0.15));
      }

      .audit-table-wrapper {
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

      .status-badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
      }

      .status-success {
        background: var(--loki-green-muted, rgba(34, 197, 94, 0.15));
        color: var(--loki-green, #22c55e);
      }

      .status-failure {
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
      }

      .status-warning {
        background: var(--loki-yellow-muted, rgba(234, 179, 8, 0.15));
        color: var(--loki-yellow, #eab308);
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

      .entry-count {
        font-size: 12px;
        color: var(--loki-text-muted, #52525b);
        margin-bottom: 8px;
      }
    `;
  }

  _getStatusClass(status) {
    if (!status) return 'status-warning';
    const s = status.toLowerCase();
    if (s === 'success' || s === 'ok' || s === 'pass') return 'status-success';
    if (s === 'failure' || s === 'error' || s === 'fail') return 'status-failure';
    return 'status-warning';
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const entries = this._entries;

    let verifyHtml = '';
    if (this._verifyResult) {
      const isValid = this._verifyResult.valid !== false;
      verifyHtml = `
        <div class="verify-result ${isValid ? 'verify-valid' : 'verify-invalid'}">
          ${isValid ? '[VALID] Audit chain integrity verified.' : `[TAMPERED] ${this._escapeHtml(this._verifyResult.error || 'Integrity check failed.')}`}
        </div>
      `;
    }

    let content;
    if (this._loading && entries.length === 0) {
      content = '<div class="loading">Loading audit log...</div>';
    } else if (entries.length === 0) {
      content = '<div class="empty-state">No audit entries found matching filters.</div>';
    } else {
      const rows = entries.map(entry => `
        <tr>
          <td>${formatAuditTimestamp(entry.timestamp)}</td>
          <td>${this._escapeHtml(entry.action || '--')}</td>
          <td>${this._escapeHtml(entry.resource || entry.resource_type || '--')}</td>
          <td>${this._escapeHtml(entry.user || entry.actor || '--')}</td>
          <td><span class="status-badge ${this._getStatusClass(entry.status)}">${this._escapeHtml(entry.status || 'unknown')}</span></td>
        </tr>
      `).join('');

      content = `
        <div class="entry-count">${entries.length} entries</div>
        <div class="audit-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Resource</th>
                <th>User</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="audit-viewer">
        <div class="header">
          <h2 class="title">Audit Log</h2>
          <div class="header-actions">
            <button class="btn" id="verify-btn" ${this._verifying ? 'disabled' : ''}>
              ${this._verifying ? 'Verifying...' : 'Verify Integrity'}
            </button>
            <button class="btn" id="refresh-btn">Refresh</button>
          </div>
        </div>

        <div class="filters">
          <div class="filter-group">
            <label class="filter-label">Action Type</label>
            <input type="text" class="filter-input" id="filter-action"
                   placeholder="e.g. create, delete"
                   value="${this._escapeHtml(this._filters.action)}">
          </div>
          <div class="filter-group">
            <label class="filter-label">Resource Type</label>
            <input type="text" class="filter-input" id="filter-resource"
                   placeholder="e.g. run, project"
                   value="${this._escapeHtml(this._filters.resource)}">
          </div>
          <div class="filter-group">
            <label class="filter-label">Date From</label>
            <input type="date" class="filter-input" id="filter-date-from"
                   value="${this._filters.dateFrom}">
          </div>
          <div class="filter-group">
            <label class="filter-label">Date To</label>
            <input type="date" class="filter-input" id="filter-date-to"
                   value="${this._filters.dateTo}">
          </div>
        </div>

        ${verifyHtml}
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    const verifyBtn = s.getElementById('verify-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', () => this._verifyIntegrity());

    const refreshBtn = s.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this._loadData());

    const actionInput = s.getElementById('filter-action');
    if (actionInput) actionInput.addEventListener('change', (e) => this._onFilterChange('action', e.target.value));

    const resourceInput = s.getElementById('filter-resource');
    if (resourceInput) resourceInput.addEventListener('change', (e) => this._onFilterChange('resource', e.target.value));

    const dateFromInput = s.getElementById('filter-date-from');
    if (dateFromInput) dateFromInput.addEventListener('change', (e) => this._onFilterChange('dateFrom', e.target.value));

    const dateToInput = s.getElementById('filter-date-to');
    if (dateToInput) dateToInput.addEventListener('change', (e) => this._onFilterChange('dateTo', e.target.value));
  }
}

if (!customElements.get('loki-audit-viewer')) {
  customElements.define('loki-audit-viewer', LokiAuditViewer);
}

export default LokiAuditViewer;
