/**
 * @fileoverview Loki Checkpoint Viewer Component - displays checkpoint
 * history, allows creating new checkpoints, and supports rollback with
 * confirmation. Polls GET /api/checkpoints every 3 seconds with
 * visibility-aware pause/resume.
 *
 * @example
 * <loki-checkpoint-viewer api-url="http://localhost:57374" theme="dark"></loki-checkpoint-viewer>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/**
 * @class LokiCheckpointViewer
 * @extends LokiElement
 * @fires checkpoint-action - When a checkpoint action is taken (create, rollback)
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiCheckpointViewer extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._checkpoints = [];
    this._pollInterval = null;
    this._lastDataHash = null;
    this._showCreateForm = false;
    this._creating = false;
    this._rollingBack = false;
    this._rollbackTarget = null;
    this._notice = null;
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
    // so immediate is disabled to avoid a duplicate fetch; the registry fires a
    // catch-up load whenever this section becomes active+visible again.
    this._poll = registerPoll({
      loadFn: () => this._loadData(),
      intervalMs: 3000,
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
    // Drop a stale response if the api-url switched mid-flight.
    const api = this._api;
    try {
      const [checkpointsResult] = await Promise.allSettled([
        api._get('/api/checkpoints?limit=50'),
      ]);
      if (api !== this._api) return;

      if (checkpointsResult.status === 'fulfilled') {
        this._checkpoints = Array.isArray(checkpointsResult.value)
          ? checkpointsResult.value
          : (checkpointsResult.value?.checkpoints || []);
      }

      this._error = null;
    } catch (err) {
      if (api !== this._api) return;
      this._error = err.message;
    }

    const dataHash = JSON.stringify({
      c: this._checkpoints,
      e: this._error,
    });
    if (dataHash === this._lastDataHash) return;
    this._lastDataHash = dataHash;

    this.render();
  }

  async _createCheckpoint() {
    const input = this.shadowRoot.getElementById('checkpoint-message');
    const message = input ? input.value.trim() : '';
    if (!message) return;

    this._creating = true;
    this.render();

    try {
      await this._api._post('/api/checkpoints', { message });
      this._showCreateForm = false;
      this._creating = false;
      this.dispatchEvent(new CustomEvent('checkpoint-action', {
        detail: { action: 'create', message },
        bubbles: true,
      }));
      this._lastDataHash = null;
      await this._loadData();
    } catch (err) {
      this._creating = false;
      this._error = `Failed to create checkpoint: ${err.message}`;
      this.render();
    }
  }

  async _rollbackCheckpoint(checkpointId) {
    if (this._rollingBack) return;
    this._rollingBack = true;
    this._notice = null;
    this.render();
    try {
      const resp = await this._api._post(`/api/checkpoints/${checkpointId}/rollback`);
      this._rollbackTarget = null;
      // R6 re-undoability: the API captures a forced pre-rollback snapshot of the
      // current state and returns its id. Surface it so the user can undo the undo.
      const undoId = resp && resp.pre_rollback_snapshot;
      this._notice = undoId
        ? `Rolled back to ${checkpointId}. Undo this with checkpoint ${undoId}`
        : `Rolled back to ${checkpointId}.`;
      this.dispatchEvent(new CustomEvent('checkpoint-action', {
        detail: { action: 'rollback', checkpointId, preRollbackSnapshot: undoId || null },
        bubbles: true,
      }));
      this._lastDataHash = null;
      await this._loadData();
    } catch (err) {
      this._rollbackTarget = null;
      this._error = `Failed to rollback: ${err.message}`;
    } finally {
      this._rollingBack = false;
      this.render();
    }
  }

  _toggleCreateForm() {
    this._showCreateForm = !this._showCreateForm;
    this._rollbackTarget = null;
    this._notice = null;
    this.render();
  }

  _confirmRollback(checkpointId) {
    this._rollbackTarget = checkpointId;
    this.render();
  }

  _cancelRollback() {
    this._rollbackTarget = null;
    this._notice = null;
    this.render();
  }

  _formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    try {
      const now = Date.now();
      const t = new Date(timestamp).getTime();
      const diff = Math.floor((now - t) / 1000);

      if (diff < 60) return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    } catch {
      return this._escapeHTML(timestamp);
    }
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const count = this._checkpoints.length;

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="checkpoint-viewer">
        <div class="checkpoint-header">
          <div class="header-left">
            <h2 class="title">Checkpoints</h2>
            <span class="count-badge">${count}</span>
          </div>
          <button class="btn btn-primary" id="create-btn">
            ${this._showCreateForm ? 'Cancel' : 'Create Checkpoint'}
          </button>
        </div>

        ${this._showCreateForm ? this._renderCreateForm() : ''}

        <div class="checkpoint-list">
          ${this._loading ? '<div class="loading-state">Loading checkpoints...</div>' : ''}
          ${!this._loading && count === 0 ? '<div class="empty-state">No checkpoints yet. Create one to save the current state.</div>' : ''}
          ${this._checkpoints.map(cp => this._renderCheckpointCard(cp)).join('')}
        </div>

        ${this._notice ? `<div class="notice-banner">${this._escapeHTML(this._notice)}</div>` : ''}
        ${this._error ? `<div class="error-banner">${this._escapeHTML(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _renderCreateForm() {
    return `
      <div class="create-form">
        <input
          type="text"
          id="checkpoint-message"
          class="form-input"
          placeholder="Checkpoint message (e.g., before refactoring auth module)"
          maxlength="200"
          ${this._creating ? 'disabled' : ''}
        />
        <button class="btn btn-primary" id="submit-create-btn" ${this._creating ? 'disabled' : ''}>
          ${this._creating ? 'Creating...' : 'Save'}
        </button>
      </div>
    `;
  }

  _renderCheckpointCard(cp) {
    const sha = cp.git_sha ? cp.git_sha.substring(0, 7) : '';
    const filesCount = cp.files_count || (Array.isArray(cp.files) ? cp.files.length : 0);
    const isRollbackTarget = this._rollbackTarget === cp.id;
    const iteration = cp.iteration != null ? `Iter ${cp.iteration}` : '';
    const provider = cp.provider || '';
    const phase = cp.phase || '';
    const branch = cp.git_branch || '';

    // Build tag list from available metadata
    const tags = [iteration, provider, phase].filter(Boolean);

    return `
      <div class="checkpoint-card" data-checkpoint-id="${this._escapeHTML(cp.id)}">
        <div class="card-header">
          <div class="header-tags">
            ${sha ? `<span class="checkpoint-sha mono">${this._escapeHTML(sha)}</span>` : ''}
            ${tags.map(t => `<span class="checkpoint-tag">${this._escapeHTML(t)}</span>`).join('')}
          </div>
          <span class="checkpoint-time">${this._formatRelativeTime(cp.created_at)}</span>
        </div>
        <div class="card-body">
          <p class="checkpoint-message">${this._escapeHTML(cp.message || 'Checkpoint')}</p>
          <div class="card-meta">
            ${filesCount > 0 ? `<span class="meta-item">${filesCount} file${filesCount !== 1 ? 's' : ''}</span>` : ''}
            ${branch ? `<span class="meta-item mono">${this._escapeHTML(branch)}</span>` : ''}
            <span class="meta-item mono">${this._escapeHTML(cp.id)}</span>
          </div>
        </div>
        <div class="card-actions">
          ${isRollbackTarget ? `
            <span class="rollback-confirm-text">Rollback to this checkpoint?</span>
            <button class="btn btn-sm btn-danger" data-action="confirm-rollback" data-id="${this._escapeHTML(cp.id)}">Confirm</button>
            <button class="btn btn-sm" data-action="cancel-rollback">Cancel</button>
          ` : `
            <button class="btn btn-sm" data-action="rollback" data-id="${this._escapeHTML(cp.id)}">Rollback</button>
          `}
        </div>
      </div>
    `;
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    // Create button (toggle form)
    const createBtn = s.getElementById('create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => this._toggleCreateForm());
    }

    // Submit create
    const submitBtn = s.getElementById('submit-create-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this._createCheckpoint());
    }

    // Enter key in message input
    const msgInput = s.getElementById('checkpoint-message');
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !this._creating) {
          e.preventDefault();
          this._createCheckpoint();
        }
      });
      // Auto-focus the input when form is shown
      requestAnimationFrame(() => msgInput.focus());
    }

    // Checkpoint card actions
    s.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'rollback') this._confirmRollback(id);
        else if (action === 'confirm-rollback') this._rollbackCheckpoint(id);
        else if (action === 'cancel-rollback') this._cancelRollback();
      });
    });
  }

  _getStyles() {
    return `
      :host {
        display: block;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--loki-text-primary);
      }

      .checkpoint-viewer {
        padding: 16px;
      }

      .checkpoint-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
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

      .count-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 5px;
        background: var(--loki-accent-muted);
        color: var(--loki-accent);
      }

      .btn {
        padding: 6px 14px;
        border: 1px solid var(--loki-border);
        border-radius: 4px;
        background: var(--loki-bg-tertiary);
        color: var(--loki-text-primary);
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--loki-bg-hover);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--loki-accent);
        border-color: var(--loki-accent);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--loki-accent-light);
      }

      .btn-sm {
        padding: 4px 10px;
        font-size: 11px;
      }

      .btn-danger {
        background: var(--loki-red-muted);
        border-color: var(--loki-red-muted);
        color: var(--loki-red);
      }

      .btn-danger:hover {
        opacity: 0.85;
      }

      /* Create Form */
      .create-form {
        display: flex;
        gap: 8px;
        margin-bottom: 16px;
        padding: 12px;
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
      }

      .form-input {
        flex: 1;
        padding: 8px 12px;
        background: var(--loki-bg-primary);
        border: 1px solid var(--loki-border);
        border-radius: 4px;
        color: var(--loki-text-primary);
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s ease;
      }

      .form-input:focus {
        border-color: var(--loki-accent);
      }

      .form-input::placeholder {
        color: var(--loki-text-muted);
      }

      .form-input:disabled {
        opacity: 0.5;
      }

      /* Checkpoint List */
      .checkpoint-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .checkpoint-card {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 12px 16px;
        transition: all 0.15s ease;
      }

      .checkpoint-card:hover {
        border-color: var(--loki-border-light);
      }

      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }

      .header-tags {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .checkpoint-tag {
        font-size: 10px;
        font-weight: 500;
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--loki-bg-tertiary);
        color: var(--loki-text-secondary);
        text-transform: capitalize;
      }

      .checkpoint-sha {
        font-size: 12px;
        font-weight: 600;
        color: var(--loki-accent);
        background: var(--loki-accent-muted);
        padding: 2px 6px;
        border-radius: 4px;
      }

      .checkpoint-time {
        font-size: 11px;
        color: var(--loki-text-muted);
      }

      .card-body {
        margin-bottom: 8px;
      }

      .checkpoint-message {
        margin: 0 0 6px 0;
        font-size: 13px;
        color: var(--loki-text-primary);
        line-height: 1.4;
      }

      .card-meta {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--loki-text-muted);
      }

      .meta-item {
        display: inline-flex;
        align-items: center;
      }

      .mono {
        font-family: 'JetBrains Mono', monospace;
      }

      .card-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--loki-border);
      }

      .rollback-confirm-text {
        font-size: 12px;
        color: var(--loki-red);
        font-weight: 500;
        margin-right: auto;
      }

      /* States */
      .loading-state {
        padding: 40px;
        text-align: center;
        color: var(--loki-text-muted);
        font-size: 13px;
      }

      .empty-state {
        padding: 40px;
        text-align: center;
        color: var(--loki-text-muted);
        font-size: 13px;
      }

      .error-banner {
        margin-top: 12px;
        padding: 10px 14px;
        background: var(--loki-red-muted);
        border: 1px solid var(--loki-red-muted);
        border-radius: 4px;
        color: var(--loki-red);
        font-size: 12px;
      }

      .notice-banner {
        margin-top: 12px;
        padding: 10px 14px;
        background: var(--loki-green-muted, rgba(34, 197, 94, 0.12));
        border: 1px solid var(--loki-green-muted, rgba(34, 197, 94, 0.3));
        border-radius: 4px;
        color: var(--loki-green, #22c55e);
        font-size: 12px;
      }
    `;
  }
}

// Register the custom element
if (!customElements.get('loki-checkpoint-viewer')) {
  customElements.define('loki-checkpoint-viewer', LokiCheckpointViewer);
}
