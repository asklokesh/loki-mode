/**
 * @fileoverview Loki Session Diff Component - displays what changed since last session.
 * Shows period covered, summary counts, highlights, and collapsible decisions.
 *
 * Polls /api/session-diff every 30 seconds.
 *
 * @example
 * <loki-session-diff api-url="http://localhost:57374"></loki-session-diff>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/**
 * @class LokiSessionDiff
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 */
export class LokiSessionDiff extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._data = null;
    this._error = null;
    this._loading = true;
    this._api = null;
    this._pollInterval = null;
    this._expandedDecisions = new Set();
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
      this._data = await this._api._get('/api/session-diff');
      this._error = null;
    } catch (err) {
      this._error = err.message;
      this._data = null;
    }
    this._loading = false;
    this.render();
  }

  _startPolling() {
    this._pollInterval = setInterval(() => this._loadData(), 30000);
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

  _toggleDecision(index) {
    if (this._expandedDecisions.has(index)) {
      this._expandedDecisions.delete(index);
    } else {
      this._expandedDecisions.add(index);
    }
    this.render();
  }

  render() {
    const styles = `
      ${this.getBaseStyles()}

      :host {
        display: block;
      }

      .diff-container {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-glass-border);
        border-radius: 5px;
        padding: 16px;
        margin-top: 16px;
        transition: all var(--loki-transition);
      }

      .diff-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
      }

      .diff-header svg {
        width: 16px;
        height: 16px;
        color: var(--loki-text-muted);
        flex-shrink: 0;
      }

      .diff-title {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
      }

      .diff-period {
        font-size: 11px;
        color: var(--loki-text-muted);
        margin-left: auto;
        font-family: 'JetBrains Mono', monospace;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
        gap: 8px;
        margin-bottom: 14px;
      }

      .summary-item {
        background: var(--loki-bg-secondary);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 10px 12px;
        text-align: center;
      }

      .summary-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        margin-bottom: 4px;
      }

      .summary-value {
        font-size: 18px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-accent);
      }

      .summary-value.error-count {
        color: var(--loki-red);
      }

      .highlights-section {
        margin-bottom: 14px;
      }

      .section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        margin-bottom: 8px;
      }

      .highlight-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .highlight-item {
        font-size: 12px;
        color: var(--loki-text-secondary);
        padding: 6px 10px;
        background: var(--loki-bg-secondary);
        border-radius: 4px;
        border-left: 3px solid var(--loki-accent);
      }

      .decisions-section {
        margin-top: 14px;
      }

      .decision-item {
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        margin-bottom: 6px;
        overflow: hidden;
      }

      .decision-header {
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

      .decision-header:hover {
        background: var(--loki-bg-hover);
      }

      .decision-arrow {
        font-size: 10px;
        color: var(--loki-text-muted);
        transition: transform 0.15s ease;
      }

      .decision-arrow.expanded {
        transform: rotate(90deg);
      }

      .decision-reasoning {
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

      .error-state {
        text-align: center;
        padding: 16px;
        color: var(--loki-red);
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

      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;

    if (this._loading) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="diff-container">
          <div class="loading-state"><div class="spinner"></div> Loading session diff...</div>
        </div>
      `;
      return;
    }

    if (this._error) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="diff-container">
          <div class="diff-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            <span class="diff-title">Session Resume</span>
          </div>
          <div class="empty-state">No session diff available</div>
        </div>
      `;
      return;
    }

    const d = this._data || {};
    const period = this._escapeHtml(d.period || '--');
    const counts = d.counts || {};
    const highlights = d.highlights || [];
    const decisions = d.decisions || [];

    let highlightsHtml = '';
    if (highlights.length > 0) {
      highlightsHtml = `
        <div class="highlights-section">
          <div class="section-label">Highlights</div>
          <ul class="highlight-list">
            ${highlights.map(h => `<li class="highlight-item">${this._escapeHtml(h)}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    let decisionsHtml = '';
    if (decisions.length > 0) {
      decisionsHtml = `
        <div class="decisions-section">
          <div class="section-label">Decisions</div>
          ${decisions.map((dec, i) => {
            const isExpanded = this._expandedDecisions.has(i);
            return `
              <div class="decision-item">
                <button class="decision-header" data-index="${i}">
                  <span class="decision-arrow ${isExpanded ? 'expanded' : ''}">&#9654;</span>
                  ${this._escapeHtml(dec.title || dec.decision || 'Decision')}
                </button>
                ${isExpanded ? `<div class="decision-reasoning">${this._escapeHtml(dec.reasoning || dec.rationale || 'No reasoning provided')}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div class="diff-container">
        <div class="diff-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span class="diff-title">Session Resume</span>
          <span class="diff-period">${period}</span>
        </div>

        <div class="summary-grid">
          <div class="summary-item">
            <div class="summary-label">Created</div>
            <div class="summary-value">${counts.tasks_created != null ? counts.tasks_created : '--'}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Completed</div>
            <div class="summary-value">${counts.tasks_completed != null ? counts.tasks_completed : '--'}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Blocked</div>
            <div class="summary-value">${counts.tasks_blocked != null ? counts.tasks_blocked : '--'}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Errors</div>
            <div class="summary-value ${(counts.errors || 0) > 0 ? 'error-count' : ''}">${counts.errors != null ? counts.errors : '--'}</div>
          </div>
        </div>

        ${highlightsHtml}
        ${decisionsHtml}
      </div>
    `;

    // Attach decision toggle listeners
    this.shadowRoot.querySelectorAll('.decision-header').forEach(btn => {
      btn.addEventListener('click', () => {
        this._toggleDecision(parseInt(btn.dataset.index));
      });
    });
  }
}

if (!customElements.get('loki-session-diff')) {
  customElements.define('loki-session-diff', LokiSessionDiff);
}

export default LokiSessionDiff;
