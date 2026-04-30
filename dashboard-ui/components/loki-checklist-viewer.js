/**
 * @fileoverview Loki PRD Checklist Viewer - displays PRD requirement
 * tracking with verification status, progress bars, and category
 * accordions. Polls /api/checklist every 5 seconds with visibility-aware
 * pause/resume.
 *
 * @example
 * <loki-checklist-viewer api-url="http://localhost:57374" theme="dark"></loki-checklist-viewer>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

const PRIORITY_ORDER = { critical: 0, major: 1, minor: 2 };
const PRIORITY_COLORS = {
  critical: 'var(--loki-status-error, #ef4444)',
  major: 'var(--loki-status-warning, #f59e0b)',
  minor: 'var(--loki-text-muted, #71717a)',
};

/**
 * @class LokiChecklistViewer
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiChecklistViewer extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._pollInterval = null;
    this._checklist = null;
    this._waivers = [];
    this._expandedCategories = new Set();
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
      const [data, waiverData] = await Promise.all([
        this._api.getChecklist(),
        this._api.getChecklistWaivers().catch(() => null),
      ]);
      const waiverHash = JSON.stringify(waiverData);
      const dataHash = JSON.stringify(data) + waiverHash;
      if (dataHash === this._lastDataHash) return;
      this._lastDataHash = dataHash;
      this._checklist = data;
      this._waivers = (waiverData && waiverData.waivers) ? waiverData.waivers.filter(w => w.active) : [];
      this._error = null;
      this.render();
    } catch (err) {
      this._error = `Failed to load checklist: ${err.message}`;
      this.render();
    }
  }

  _isItemWaived(itemId) {
    return this._waivers.some(w => w.item_id === itemId);
  }

  _getWaiverForItem(itemId) {
    return this._waivers.find(w => w.item_id === itemId) || null;
  }

  async _waiveItem(itemId) {
    const reason = window.prompt('Enter reason for waiving this item:');
    if (!reason) return;
    try {
      await this._api.addChecklistWaiver(itemId, reason);
      this._lastDataHash = null;
      await this._loadData();
    } catch (err) {
      this._error = `Failed to add waiver: ${err.message}`;
      this.render();
    }
  }

  async _unwaiveItem(itemId) {
    try {
      await this._api.removeChecklistWaiver(itemId);
      this._lastDataHash = null;
      await this._loadData();
    } catch (err) {
      this._error = `Failed to remove waiver: ${err.message}`;
      this.render();
    }
  }

  _toggleCategory(name) {
    if (this._expandedCategories.has(name)) {
      this._expandedCategories.delete(name);
    } else {
      this._expandedCategories.add(name);
    }
    this.render();
  }

  _getStyles() {
    return `
      .checklist-viewer {
        padding: 16px;
        font-family: var(--loki-font-family, system-ui, -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }
      .checklist-header {
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
      .summary-badges {
        display: flex;
        gap: 8px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
      }
      .badge-verified {
        background: color-mix(in srgb, var(--loki-status-success, #22c55e) 15%, transparent);
        color: var(--loki-status-success, #22c55e);
      }
      .badge-failing {
        background: color-mix(in srgb, var(--loki-status-error, #ef4444) 15%, transparent);
        color: var(--loki-status-error, #ef4444);
      }
      .badge-pending {
        background: color-mix(in srgb, var(--loki-text-muted, #71717a) 15%, transparent);
        color: var(--loki-text-muted, #71717a);
      }

      /* Progress bar */
      .progress-container {
        margin-bottom: 20px;
      }
      .progress-bar {
        height: 8px;
        background: var(--loki-bg-tertiary, #e4e4e7);
        border-radius: 4px;
        overflow: hidden;
        display: flex;
      }
      .progress-verified {
        background: var(--loki-status-success, #22c55e);
        transition: width 0.3s ease;
      }
      .progress-failing {
        background: var(--loki-status-error, #ef4444);
        transition: width 0.3s ease;
      }
      .progress-label {
        display: flex;
        justify-content: space-between;
        margin-top: 4px;
        font-size: 12px;
        color: var(--loki-text-secondary, #52525b);
      }

      /* Category accordions */
      .category {
        border: 1px solid var(--loki-border, #e4e4e7);
        border-radius: 5px;
        margin-bottom: 8px;
        overflow: hidden;
      }
      .category-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        cursor: pointer;
        background: var(--loki-bg-secondary, #f4f4f5);
        user-select: none;
        transition: background 0.15s;
      }
      .category-header:hover {
        background: var(--loki-bg-hover, #f0f0f3);
      }
      .category-name {
        font-weight: 600;
        font-size: 14px;
      }
      .category-stats {
        font-size: 12px;
        color: var(--loki-text-secondary, #52525b);
      }
      .category-arrow {
        font-size: 12px;
        transition: transform 0.2s;
      }
      .category-arrow.expanded {
        transform: rotate(90deg);
      }
      .category-body {
        padding: 0;
      }

      /* Checklist items */
      .item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-top: 1px solid var(--loki-border, #e4e4e7);
        font-size: 13px;
      }
      .item-status {
        width: 12px;
        height: 6px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .status-verified {
        background: var(--loki-status-success, #22c55e);
      }
      .status-failing {
        background: var(--loki-status-error, #ef4444);
      }
      .status-pending {
        background: var(--loki-text-muted, #a1a1aa);
      }
      .item-title {
        flex: 1;
        min-width: 0;
      }
      .item-priority {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 1px 6px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .verification-dots {
        display: flex;
        gap: 3px;
        flex-shrink: 0;
      }
      .v-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .v-dot-pass { background: var(--loki-status-success, #22c55e); }
      .v-dot-fail { background: var(--loki-status-error, #ef4444); }
      .v-dot-pending { background: var(--loki-text-muted, #a1a1aa); }

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

      /* Waiver badge */
      .badge-waived {
        background: #92400e;
        color: #fbbf24;
      }
      .item-waived-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: #92400e;
        color: #fbbf24;
        flex-shrink: 0;
        cursor: default;
      }

      /* Waive/Unwaive buttons */
      .waiver-btn {
        padding: 2px 8px;
        border: 1px solid var(--loki-border, #e4e4e7);
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
        cursor: pointer;
        background: transparent;
        color: var(--loki-text-secondary, #52525b);
        flex-shrink: 0;
        transition: background 0.15s, color 0.15s;
      }
      .waiver-btn:hover {
        background: var(--loki-bg-hover, #f0f0f3);
        color: var(--loki-text-primary, #201515);
      }
      .waiver-btn-unwaive {
        border-color: #92400e;
        color: #fbbf24;
      }
      .waiver-btn-unwaive:hover {
        background: #92400e;
        color: #fbbf24;
      }

      /* Council gate banner */
      .gate-banner {
        padding: 10px 14px;
        margin-bottom: 16px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 600;
      }
      .gate-blocked {
        background: rgba(239, 68, 68, 0.1);
        border-left: 3px solid #ef4444;
        color: #fca5a5;
      }
      .gate-passed {
        background: rgba(34, 197, 94, 0.1);
        border-left: 3px solid #22c55e;
        color: #86efac;
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

  _getUnwaivedCriticalFailures() {
    if (!this._checklist?.categories) return [];
    const failures = [];
    for (const cat of this._checklist.categories) {
      for (const item of (cat.items || [])) {
        if (item.status === 'failing' && item.priority === 'critical' && !this._isItemWaived(item.id)) {
          failures.push(item);
        }
      }
    }
    return failures;
  }

  _renderGateBanner() {
    const unwaivedCritical = this._getUnwaivedCriticalFailures();
    if (unwaivedCritical.length > 0) {
      return `<div class="gate-banner gate-blocked">COUNCIL GATE: BLOCKED - ${unwaivedCritical.length} critical item${unwaivedCritical.length !== 1 ? 's' : ''} must be verified or waived before completion</div>`;
    }
    return '<div class="gate-banner gate-passed">COUNCIL GATE: PASSED - No blocking critical failures</div>';
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const cl = this._checklist;
    const isInit = cl && cl.status !== 'not_initialized' && cl.categories?.length > 0;

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="checklist-viewer">
        <div class="checklist-header">
          <h2 class="title">Spec Checklist</h2>
          ${isInit ? this._renderBadges(cl.summary) : ''}
        </div>
        ${isInit ? this._renderGateBanner() : ''}
        ${isInit ? this._renderProgress(cl.summary) : ''}
        ${isInit ? this._renderCategories(cl.categories) : this._renderEmpty()}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _renderBadges(summary) {
    if (!summary) return '';
    const waivedCount = this._waivers.length;
    return `
      <div class="summary-badges">
        ${summary.verified ? `<span class="badge badge-verified">${summary.verified} verified</span>` : ''}
        ${summary.failing ? `<span class="badge badge-failing">${summary.failing} failing</span>` : ''}
        ${waivedCount ? `<span class="badge badge-waived">${waivedCount} waived</span>` : ''}
        ${summary.pending ? `<span class="badge badge-pending">${summary.pending} pending</span>` : ''}
      </div>
    `;
  }

  _renderProgress(summary) {
    if (!summary || !summary.total) return '';
    const pctVerified = (summary.verified / summary.total) * 100;
    const pctFailing = (summary.failing / summary.total) * 100;
    return `
      <div class="progress-container">
        <div class="progress-bar">
          <div class="progress-verified" style="width: ${pctVerified}%"></div>
          <div class="progress-failing" style="width: ${pctFailing}%"></div>
        </div>
        <div class="progress-label">
          <span>${summary.verified}/${summary.total} verified | ${summary.failing || 0} failing | ${this._waivers.length} waived | ${summary.pending || 0} pending</span>
          <span>${Math.round(pctVerified)}%</span>
        </div>
      </div>
    `;
  }

  _renderCategories(categories) {
    if (!categories?.length) return this._renderEmpty();
    return categories.map(cat => {
      const expanded = this._expandedCategories.has(cat.name);
      const items = cat.items || [];
      const catVerified = items.filter(i => i.status === 'verified').length;
      const catFailing = items.filter(i => i.status === 'failing').length;
      return `
        <div class="category">
          <div class="category-header" data-category="${this._escapeHtml(cat.name)}">
            <div>
              <span class="category-name">${this._escapeHtml(cat.name)}</span>
              <span class="category-stats">${catVerified}/${items.length} verified${catFailing ? `, ${catFailing} failing` : ''}</span>
            </div>
            <span class="category-arrow ${expanded ? 'expanded' : ''}">&#9654;</span>
          </div>
          ${expanded ? `<div class="category-body">${this._renderItems(items)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  _renderItems(items) {
    if (!items?.length) return '<div class="item" style="color:var(--loki-text-muted)">No items</div>';
    // Sort by priority
    const sorted = [...items].sort((a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
    );
    return sorted.map(item => {
      const statusClass = item.status === 'verified' ? 'status-verified'
        : item.status === 'failing' ? 'status-failing' : 'status-pending';
      // Validate priority against known enum to prevent style injection
      const validPriority = ['critical', 'major', 'minor'].includes(item.priority) ? item.priority : 'minor';
      const priorityColor = PRIORITY_COLORS[validPriority];
      const checks = item.verification || [];
      const waiver = this._getWaiverForItem(item.id);
      const isWaived = !!waiver;
      const showWaiverAction = item.status === 'failing' && (validPriority === 'critical' || validPriority === 'major');
      const waivedBadge = isWaived
        ? `<span class="item-waived-badge" title="${this._escapeHtml(waiver.reason || 'No reason provided')}">WAIVED</span>`
        : '';
      let waiverButton = '';
      if (showWaiverAction) {
        if (isWaived) {
          waiverButton = `<button class="waiver-btn waiver-btn-unwaive" data-unwaive-id="${this._escapeHtml(item.id)}">Unwaive</button>`;
        } else {
          waiverButton = `<button class="waiver-btn" data-waive-id="${this._escapeHtml(item.id)}">Waive</button>`;
        }
      }
      return `
        <div class="item">
          <div class="item-status ${statusClass}"></div>
          <div class="item-title">${this._escapeHtml(item.title || item.id || '?')}</div>
          <span class="item-priority" style="color:${priorityColor};border:1px solid ${priorityColor}">${validPriority}</span>
          ${waivedBadge}
          ${waiverButton}
          <div class="verification-dots">
            ${checks.map(c => {
              const cls = c.passed === true ? 'v-dot-pass' : c.passed === false ? 'v-dot-fail' : 'v-dot-pending';
              return `<div class="v-dot ${cls}" title="${this._escapeHtml(c.type || '')}"></div>`;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  _renderEmpty() {
    return `
      <div class="empty-state">
        <p><strong>No checklist data yet.</strong></p>
        <p class="hint">The spec checklist is generated during the first iteration. Start a session with <code>loki start ./spec.md</code> (PRD files also accepted) -- groups and items will appear here as the session progresses and can be expanded for details.</p>
      </div>
    `;
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelectorAll('.category-header[data-category]').forEach(el => {
      el.addEventListener('click', () => this._toggleCategory(el.dataset.category));
    });
    s.querySelectorAll('button[data-waive-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._waiveItem(el.dataset.waiveId);
      });
    });
    s.querySelectorAll('button[data-unwaive-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._unwaiveItem(el.dataset.unwaiveId);
      });
    });
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

customElements.define('loki-checklist-viewer', LokiChecklistViewer);
