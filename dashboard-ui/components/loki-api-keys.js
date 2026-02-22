/**
 * @fileoverview API Key Management UI - table of API keys with create, rotate,
 * and delete controls. Shows the raw token only once after creation via an
 * inline reveal section. Supports key rotation with a grace period input.
 *
 * @example
 * <loki-api-keys api-url="http://localhost:57374" theme="dark"></loki-api-keys>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/**
 * Format a timestamp for display.
 * @param {string|null} timestamp
 * @returns {string}
 */
export function formatKeyTime(timestamp) {
  if (!timestamp) return 'Never';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

/**
 * Mask a token string, showing only first and last 4 characters.
 * @param {string} token
 * @returns {string}
 */
export function maskToken(token) {
  if (!token || token.length < 12) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

/**
 * @class LokiApiKeys
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiApiKeys extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._keys = [];
    this._showCreateForm = false;
    this._newToken = null; // Token shown once after creation
    this._confirmDeleteId = null;
    this._rotateKeyId = null;
    this._rotateGracePeriod = '24';

    // Create form fields
    this._createName = '';
    this._createRole = 'read';
    this._createExpiration = '';
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

      const data = await this._api._get('/api/v2/api-keys');
      this._keys = Array.isArray(data) ? data : (data?.keys || []);
      this._error = null;
    } catch (err) {
      this._error = `Failed to load API keys: ${err.message}`;
    } finally {
      this._loading = false;
    }

    this.render();
  }

  async _createKey() {
    if (!this._createName.trim()) {
      this._error = 'Key name is required.';
      this.render();
      return;
    }

    try {
      const payload = {
        name: this._createName.trim(),
        role: this._createRole,
      };
      if (this._createExpiration) {
        payload.expiration = this._createExpiration;
      }

      const result = await this._api._post('/api/v2/api-keys', payload);
      this._newToken = result?.token || result?.key || null;
      this._showCreateForm = false;
      this._createName = '';
      this._createRole = 'read';
      this._createExpiration = '';
      this._error = null;
      await this._loadData();
    } catch (err) {
      this._error = `Create failed: ${err.message}`;
      this.render();
    }
  }

  async _rotateKey(keyId) {
    try {
      const payload = {
        grace_period_hours: parseInt(this._rotateGracePeriod, 10) || 24,
      };
      const result = await this._api._post(`/api/v2/api-keys/${keyId}/rotate`, payload);
      this._newToken = result?.token || result?.key || null;
      this._rotateKeyId = null;
      this._error = null;
      await this._loadData();
    } catch (err) {
      this._error = `Rotate failed: ${err.message}`;
      this.render();
    }
  }

  async _deleteKey(keyId) {
    try {
      await this._api._delete(`/api/v2/api-keys/${keyId}`);
      this._confirmDeleteId = null;
      this._error = null;
      await this._loadData();
    } catch (err) {
      this._error = `Delete failed: ${err.message}`;
      this._confirmDeleteId = null;
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

      .api-keys {
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
        background: var(--loki-bg-hover, #1f1f23);
        border-color: var(--loki-border-light, rgba(255, 255, 255, 0.1));
      }

      .btn-sm {
        padding: 4px 10px;
        font-size: 11px;
      }

      .btn-primary {
        background: var(--loki-accent, #8b5cf6);
        border-color: var(--loki-accent, #8b5cf6);
        color: white;
      }

      .btn-primary:hover {
        opacity: 0.9;
      }

      .btn-danger {
        border-color: var(--loki-red, #ef4444);
        color: var(--loki-red, #ef4444);
      }

      .btn-danger:hover {
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
      }

      .btn-warn {
        border-color: var(--loki-yellow, #eab308);
        color: var(--loki-yellow, #eab308);
      }

      .btn-warn:hover {
        background: var(--loki-yellow-muted, rgba(234, 179, 8, 0.15));
      }

      /* New token reveal */
      .new-token-banner {
        margin-bottom: 16px;
        padding: 14px;
        background: var(--loki-green-muted, rgba(34, 197, 94, 0.15));
        border: 1px solid var(--loki-green, #22c55e);
        border-radius: 8px;
      }

      .new-token-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--loki-green, #22c55e);
        margin-bottom: 8px;
      }

      .new-token-warning {
        font-size: 11px;
        color: var(--loki-text-secondary, #a1a1aa);
        margin-bottom: 8px;
      }

      .new-token-value {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        padding: 8px 12px;
        background: var(--loki-bg-tertiary, #111114);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 4px;
        word-break: break-all;
        user-select: all;
        margin-bottom: 8px;
      }

      .new-token-dismiss {
        font-size: 11px;
        cursor: pointer;
        color: var(--loki-text-muted, #52525b);
        background: none;
        border: none;
        text-decoration: underline;
      }

      /* Create form */
      .create-form {
        margin-bottom: 16px;
        padding: 14px;
        background: var(--loki-bg-card, #18181b);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 8px;
      }

      .form-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 12px;
      }

      .form-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 12px;
      }

      .form-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 140px;
      }

      .form-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--loki-text-muted, #52525b);
      }

      .form-input, .form-select {
        padding: 6px 10px;
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 4px;
        background: var(--loki-bg-tertiary, #111114);
        color: var(--loki-text-primary, #fafafa);
        font-size: 12px;
      }

      .form-input:focus, .form-select:focus {
        outline: none;
        border-color: var(--loki-accent, #8b5cf6);
      }

      .form-actions {
        display: flex;
        gap: 8px;
      }

      /* Rotate inline */
      .rotate-inline {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
      }

      .rotate-input {
        width: 60px;
        padding: 3px 6px;
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 4px;
        background: var(--loki-bg-tertiary, #111114);
        color: var(--loki-text-primary, #fafafa);
        font-size: 11px;
      }

      .rotate-label {
        font-size: 11px;
        color: var(--loki-text-muted, #52525b);
      }

      /* Table */
      .keys-table-wrapper {
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
        vertical-align: top;
      }

      tr:last-child td {
        border-bottom: none;
      }

      tr:hover td {
        background: var(--loki-bg-hover, #1f1f23);
      }

      .key-name {
        font-weight: 600;
      }

      .key-role {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
        background: var(--loki-accent-muted, rgba(139, 92, 246, 0.15));
        color: var(--loki-accent, #8b5cf6);
      }

      .key-status-active {
        color: var(--loki-green, #22c55e);
      }

      .key-status-expired {
        color: var(--loki-red, #ef4444);
      }

      .key-status-revoked {
        color: var(--loki-text-muted, #52525b);
      }

      .actions-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .action-row {
        display: flex;
        gap: 6px;
      }

      .confirm-delete {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--loki-red, #ef4444);
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

    const keys = this._keys;

    // New token banner
    let tokenBanner = '';
    if (this._newToken) {
      tokenBanner = `
        <div class="new-token-banner">
          <div class="new-token-label">API Key Created</div>
          <div class="new-token-warning">Copy this token now. It will not be shown again.</div>
          <div class="new-token-value">${this._escapeHtml(this._newToken)}</div>
          <button class="new-token-dismiss" id="dismiss-token">Dismiss</button>
        </div>
      `;
    }

    // Create form
    let createForm = '';
    if (this._showCreateForm) {
      createForm = `
        <div class="create-form">
          <div class="form-title">Create New API Key</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Name</label>
              <input type="text" class="form-input" id="create-name"
                     placeholder="e.g. CI/CD Pipeline"
                     value="${this._escapeHtml(this._createName)}">
            </div>
            <div class="form-group">
              <label class="form-label">Role</label>
              <select class="form-select" id="create-role">
                <option value="read" ${this._createRole === 'read' ? 'selected' : ''}>Read</option>
                <option value="write" ${this._createRole === 'write' ? 'selected' : ''}>Write</option>
                <option value="admin" ${this._createRole === 'admin' ? 'selected' : ''}>Admin</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Expiration (optional)</label>
              <input type="date" class="form-input" id="create-expiration"
                     value="${this._createExpiration}">
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" id="submit-create">Create Key</button>
            <button class="btn" id="cancel-create">Cancel</button>
          </div>
        </div>
      `;
    }

    // Table
    let content;
    if (this._loading && keys.length === 0) {
      content = '<div class="loading">Loading API keys...</div>';
    } else if (keys.length === 0) {
      content = '<div class="empty-state">No API keys configured. Create one to get started.</div>';
    } else {
      const rows = keys.map(key => {
        const keyId = key.id || key.key_id;
        const status = (key.status || 'active').toLowerCase();
        const statusClass = status === 'active' ? 'key-status-active'
          : status === 'expired' ? 'key-status-expired'
          : 'key-status-revoked';
        const isConfirmingDelete = this._confirmDeleteId === keyId;
        const isRotating = this._rotateKeyId === keyId;

        let actionsHtml;
        if (isConfirmingDelete) {
          actionsHtml = `
            <div class="confirm-delete">
              <span>Delete this key?</span>
              <button class="btn btn-sm btn-danger" data-action="confirm-delete" data-key-id="${keyId}">Yes</button>
              <button class="btn btn-sm" data-action="cancel-delete">No</button>
            </div>
          `;
        } else {
          actionsHtml = `
            <div class="action-row">
              <button class="btn btn-sm btn-warn" data-action="rotate" data-key-id="${keyId}">Rotate</button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-key-id="${keyId}">Delete</button>
            </div>
            ${isRotating ? `
              <div class="rotate-inline">
                <span class="rotate-label">Grace period:</span>
                <input type="number" class="rotate-input" id="rotate-grace-${keyId}" value="${this._rotateGracePeriod}" min="0">
                <span class="rotate-label">hrs</span>
                <button class="btn btn-sm btn-primary" data-action="confirm-rotate" data-key-id="${keyId}">Go</button>
                <button class="btn btn-sm" data-action="cancel-rotate">Cancel</button>
              </div>
            ` : ''}
          `;
        }

        return `
          <tr>
            <td><span class="key-name">${this._escapeHtml(key.name || 'Unnamed')}</span></td>
            <td><span class="key-role">${this._escapeHtml(key.role || key.scopes || '--')}</span></td>
            <td>${formatKeyTime(key.created_at || key.created)}</td>
            <td>${formatKeyTime(key.last_used_at || key.last_used)}</td>
            <td><span class="${statusClass}">${this._escapeHtml(status)}</span></td>
            <td><div class="actions-cell">${actionsHtml}</div></td>
          </tr>
        `;
      }).join('');

      content = `
        <div class="keys-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Status</th>
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
      <div class="api-keys">
        <div class="header">
          <h2 class="title">API Keys</h2>
          ${!this._showCreateForm ? '<button class="btn btn-primary" id="show-create">Create Key</button>' : ''}
        </div>
        ${tokenBanner}
        ${createForm}
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    // Show create form
    const showCreateBtn = s.getElementById('show-create');
    if (showCreateBtn) {
      showCreateBtn.addEventListener('click', () => {
        this._showCreateForm = true;
        this.render();
      });
    }

    // Dismiss new token
    const dismissBtn = s.getElementById('dismiss-token');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        this._newToken = null;
        this.render();
      });
    }

    // Create form handlers
    const submitCreate = s.getElementById('submit-create');
    if (submitCreate) {
      submitCreate.addEventListener('click', () => {
        const nameInput = s.getElementById('create-name');
        const roleSelect = s.getElementById('create-role');
        const expInput = s.getElementById('create-expiration');
        this._createName = nameInput?.value || '';
        this._createRole = roleSelect?.value || 'read';
        this._createExpiration = expInput?.value || '';
        this._createKey();
      });
    }

    const cancelCreate = s.getElementById('cancel-create');
    if (cancelCreate) {
      cancelCreate.addEventListener('click', () => {
        this._showCreateForm = false;
        this.render();
      });
    }

    // Action buttons
    s.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._confirmDeleteId = btn.dataset.keyId;
        this.render();
      });
    });

    s.querySelectorAll('[data-action="confirm-delete"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._deleteKey(btn.dataset.keyId);
      });
    });

    s.querySelectorAll('[data-action="cancel-delete"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._confirmDeleteId = null;
        this.render();
      });
    });

    s.querySelectorAll('[data-action="rotate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._rotateKeyId = btn.dataset.keyId;
        this.render();
      });
    });

    s.querySelectorAll('[data-action="confirm-rotate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const graceInput = s.getElementById(`rotate-grace-${btn.dataset.keyId}`);
        this._rotateGracePeriod = graceInput?.value || '24';
        this._rotateKey(btn.dataset.keyId);
      });
    });

    s.querySelectorAll('[data-action="cancel-rotate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._rotateKeyId = null;
        this.render();
      });
    });
  }
}

if (!customElements.get('loki-api-keys')) {
  customElements.define('loki-api-keys', LokiApiKeys);
}

export default LokiApiKeys;
