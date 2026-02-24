/**
 * @fileoverview Loki Prompt Optimizer Component - displays prompt optimization status.
 * Shows current version, last optimization time, failures analyzed, and changes with rationale.
 *
 * Polls /api/prompt-versions every 60 seconds.
 *
 * @example
 * <loki-prompt-optimizer api-url="http://localhost:57374"></loki-prompt-optimizer>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/**
 * @class LokiPromptOptimizer
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 */
export class LokiPromptOptimizer extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._data = null;
    this._error = null;
    this._loading = true;
    this._optimizing = false;
    this._api = null;
    this._pollInterval = null;
    this._expandedChanges = new Set();
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

  async _loadData() {
    try {
      this._data = await this._api._get('/api/prompt-versions');
      this._error = null;
    } catch (err) {
      this._error = err.message;
      this._data = null;
    }
    this._loading = false;
    this.render();
  }

  async _triggerOptimize() {
    if (this._optimizing) return;
    this._optimizing = true;
    this.render();
    try {
      await this._api._post('/api/prompt-optimize?dry_run=false', {});
      await this._loadData();
    } catch (err) {
      this._error = err.message;
    }
    this._optimizing = false;
    this.render();
  }

  _startPolling() {
    this._pollInterval = setInterval(() => this._loadData(), 60000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _formatTime(timestamp) {
    if (!timestamp) return '--';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now - date;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return '--';
    }
  }

  _toggleChange(index) {
    if (this._expandedChanges.has(index)) {
      this._expandedChanges.delete(index);
    } else {
      this._expandedChanges.add(index);
    }
    this.render();
  }

  render() {
    const styles = `
      ${this.getBaseStyles()}

      :host {
        display: block;
      }

      .optimizer-container {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-glass-border);
        border-radius: 5px;
        padding: 16px;
        transition: all var(--loki-transition);
      }

      .optimizer-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
      }

      .optimizer-header svg {
        width: 16px;
        height: 16px;
        color: var(--loki-text-muted);
        flex-shrink: 0;
      }

      .optimizer-title {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
      }

      .optimize-btn {
        margin-left: auto;
        padding: 4px 12px;
        background: var(--loki-accent);
        color: #fff;
        border: none;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--loki-transition);
        font-family: inherit;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .optimize-btn:hover:not(:disabled) {
        background: var(--loki-accent-hover);
      }

      .optimize-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .info-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin-bottom: 14px;
      }

      .info-item {
        background: var(--loki-bg-secondary);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 10px 12px;
        text-align: center;
      }

      .info-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        margin-bottom: 4px;
      }

      .info-value {
        font-size: 16px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-accent);
      }

      .info-value.muted {
        font-size: 12px;
        color: var(--loki-text-secondary);
      }

      .changes-section {
        margin-top: 14px;
      }

      .section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        margin-bottom: 8px;
      }

      .change-item {
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        margin-bottom: 6px;
        overflow: hidden;
      }

      .change-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        cursor: pointer;
        background: var(--loki-bg-secondary);
        font-size: 12px;
        font-weight: 500;
        color: var(--loki-text-primary);
        transition: background var(--loki-transition);
        border: none;
        width: 100%;
        text-align: left;
        font-family: inherit;
      }

      .change-header:hover {
        background: var(--loki-bg-hover);
      }

      .change-arrow {
        font-size: 10px;
        color: var(--loki-text-muted);
        transition: transform 0.15s ease;
      }

      .change-arrow.expanded {
        transform: rotate(90deg);
      }

      .change-rationale {
        padding: 8px 12px;
        font-size: 11px;
        color: var(--loki-text-secondary);
        border-top: 1px solid var(--loki-border);
        line-height: 1.5;
      }

      .empty-state {
        text-align: center;
        padding: 20px;
        color: var(--loki-text-muted);
        font-size: 12px;
      }

      .loading-state {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        gap: 8px;
        color: var(--loki-text-muted);
        font-size: 12px;
      }

      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--loki-border);
        border-top-color: var(--loki-accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      .spinner-sm {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;

    if (this._loading) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="optimizer-container">
          <div class="loading-state"><div class="spinner"></div> Loading prompt data...</div>
        </div>
      `;
      return;
    }

    if (this._error && !this._data) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="optimizer-container">
          <div class="optimizer-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span class="optimizer-title">Prompt Optimizer</span>
          </div>
          <div class="empty-state">No prompt optimization data available</div>
        </div>
      `;
      return;
    }

    const d = this._data || {};
    const version = d.version != null ? d.version : '--';
    const lastOptimized = this._formatTime(d.last_optimized);
    const failuresAnalyzed = d.failures_analyzed != null ? d.failures_analyzed : '--';
    const changes = d.changes || [];

    let changesHtml = '';
    if (changes.length > 0) {
      changesHtml = `
        <div class="changes-section">
          <div class="section-label">Changes</div>
          ${changes.map((ch, i) => {
            const isExpanded = this._expandedChanges.has(i);
            return `
              <div class="change-item">
                <button class="change-header" data-index="${i}">
                  <span class="change-arrow ${isExpanded ? 'expanded' : ''}">&#9654;</span>
                  ${this._escapeHtml(ch.description || ch.title || 'Change')}
                </button>
                ${isExpanded ? `<div class="change-rationale">${this._escapeHtml(ch.rationale || ch.reasoning || 'No rationale provided')}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div class="optimizer-container">
        <div class="optimizer-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <span class="optimizer-title">Prompt Optimizer</span>
          <button class="optimize-btn" id="optimize-btn" ${this._optimizing ? 'disabled' : ''}>
            ${this._optimizing ? '<div class="spinner-sm"></div> Optimizing...' : 'Optimize Now'}
          </button>
        </div>

        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Version</div>
            <div class="info-value">v${this._escapeHtml(String(version))}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Last Optimized</div>
            <div class="info-value muted">${this._escapeHtml(lastOptimized)}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Failures Analyzed</div>
            <div class="info-value">${failuresAnalyzed}</div>
          </div>
        </div>

        ${changesHtml}
      </div>
    `;

    // Attach button listener
    const optimizeBtn = this.shadowRoot.getElementById('optimize-btn');
    if (optimizeBtn) {
      optimizeBtn.addEventListener('click', () => this._triggerOptimize());
    }

    // Attach change toggle listeners
    this.shadowRoot.querySelectorAll('.change-header').forEach(btn => {
      btn.addEventListener('click', () => {
        this._toggleChange(parseInt(btn.dataset.index));
      });
    });
  }
}

if (!customElements.get('loki-prompt-optimizer')) {
  customElements.define('loki-prompt-optimizer', LokiPromptOptimizer);
}

export default LokiPromptOptimizer;
