/**
 * @fileoverview Loki Notification Center Component - enhanced notification
 * system with bell icon, unread count badge, notification categories
 * (Build, Quality, System, Security), time grouping, mark as read/unread,
 * action buttons, and trigger configuration.
 *
 * @example
 * <loki-notification-center api-url="http://localhost:57374" theme="dark"></loki-notification-center>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/**
 * Severity color mapping used for dots and badges.
 * @type {Object<string, string>}
 */
const SEVERITY_COLORS = {
  critical: 'var(--loki-red, #ef4444)',
  warning:  'var(--loki-yellow, #eab308)',
  info:     'var(--loki-blue, #3b82f6)',
  success:  'var(--loki-green, #1FC5A8)',
};

/**
 * Notification categories with icons and labels.
 * @type {Object<string, {label: string, icon: string}>}
 */
const CATEGORIES = {
  build:    { label: 'Build',    icon: 'B' },
  quality:  { label: 'Quality',  icon: 'Q' },
  system:   { label: 'System',   icon: 'S' },
  security: { label: 'Security', icon: '!' },
};

/**
 * @class LokiNotificationCenter
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiNotificationCenter extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._notifications = [];
    this._triggers = [];
    this._summary = {};
    this._connected = false;
    this._activeTab = 'feed';
    this._categoryFilter = 'all';
    this._panelOpen = true;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadNotifications();
    this._loadTriggers();
    this._startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url') {
      this._loadNotifications();
      this._loadTriggers();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  // -- Data fetching --

  async _loadNotifications() {
    try {
      const apiUrl = this.getAttribute('api-url') || window.location.origin;
      const resp = await fetch(apiUrl + '/api/notifications');
      if (resp.ok) {
        const data = await resp.json();
        this._notifications = data.notifications || [];
        this._summary = data.summary || {};
        this._connected = true;
      }
    } catch {
      this._connected = false;
    }
    this.render();
  }

  async _loadTriggers() {
    try {
      const apiUrl = this.getAttribute('api-url') || window.location.origin;
      const resp = await fetch(apiUrl + '/api/notifications/triggers');
      if (resp.ok) {
        const data = await resp.json();
        this._triggers = data.triggers || [];
      }
    } catch {
      // Keep existing triggers
    }
  }

  async _acknowledgeNotification(id) {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    try {
      await fetch(apiUrl + '/api/notifications/' + encodeURIComponent(id) + '/acknowledge', { method: 'POST' });
    } catch {
      // Network/abort failure on acknowledge is non-fatal; the reload below
      // (also guarded) reflects the true server state. Swallow so it does not
      // surface as an unhandled promise rejection in the console.
    }
    this._loadNotifications();
  }

  async _unacknowledgeNotification(id) {
    // Mark as unread by toggling acknowledge state
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    await fetch(apiUrl + '/api/notifications/' + encodeURIComponent(id) + '/unacknowledge', { method: 'POST' });
    this._loadNotifications();
  }

  async _acknowledgeAll() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    const unacked = this._notifications.filter(n => !n.acknowledged);
    for (const n of unacked) {
      await fetch(apiUrl + '/api/notifications/' + encodeURIComponent(n.id) + '/acknowledge', { method: 'POST' });
    }
    this._loadNotifications();
  }

  async _toggleTrigger(triggerId, enabled) {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    const triggers = this._triggers.map(t => t.id === triggerId ? { ...t, enabled } : t);
    await fetch(apiUrl + '/api/notifications/triggers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggers }),
    });
    this._triggers = triggers;
    this.render();
  }

  // -- Polling --

  _startPolling() {
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, so a hidden tab or background
    // section does not fetch. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => {
        this._loadNotifications();
        this._loadTriggers();
      },
      intervalMs: 5000,
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

  // -- Helpers --

  _formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now - date;
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHr = Math.floor(diffMin / 60);
      const diffDay = Math.floor(diffHr / 24);

      if (diffSec < 60) return diffSec + 's ago';
      if (diffMin < 60) return diffMin + 'm ago';
      if (diffHr < 24) return diffHr + 'h ago';
      if (diffDay < 7) return diffDay + 'd ago';
      return date.toLocaleDateString();
    } catch {
      return String(timestamp);
    }
  }

  _getTimeGroup(timestamp) {
    if (!timestamp) return 'Other';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      if (date >= today) return 'Today';
      if (date >= yesterday) return 'Yesterday';
      if (date >= weekAgo) return 'This Week';
      return 'Earlier';
    } catch {
      return 'Other';
    }
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _getSeverityColor(severity) {
    return SEVERITY_COLORS[severity] || SEVERITY_COLORS.info;
  }

  _getCategory(notification) {
    return notification.category || notification.type || 'system';
  }

  // -- Tab switching --

  _switchTab(tab) {
    this._activeTab = tab;
    this.render();
  }

  _setCategoryFilter(cat) {
    this._categoryFilter = cat;
    this.render();
  }

  _togglePanel() {
    this._panelOpen = !this._panelOpen;
    this.render();
  }

  // -- Event binding --

  _bindEvents() {
    const root = this.shadowRoot;

    // Tab buttons
    root.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this._switchTab(btn.dataset.tab);
      });
    });

    // Category filter buttons
    root.querySelectorAll('.cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setCategoryFilter(btn.dataset.cat);
      });
    });

    // Acknowledge buttons
    root.querySelectorAll('.ack-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._acknowledgeNotification(btn.dataset.id);
      });
    });

    // Mark as unread buttons
    root.querySelectorAll('.unread-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._unacknowledgeNotification(btn.dataset.id);
      });
    });

    // Acknowledge All / Mark all as read button
    const ackAllBtn = root.querySelector('.ack-all-btn');
    if (ackAllBtn) {
      ackAllBtn.addEventListener('click', () => {
        this._acknowledgeAll();
      });
    }

    // Bell icon toggle
    const bellBtn = root.querySelector('.bell-icon');
    if (bellBtn) {
      bellBtn.addEventListener('click', () => {
        this._togglePanel();
      });
    }

    // Toggle switches
    root.querySelectorAll('.toggle input').forEach(input => {
      input.addEventListener('change', () => {
        this._toggleTrigger(input.dataset.triggerId, input.checked);
      });
    });

    // Dismiss buttons
    root.querySelectorAll('.dismiss-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._acknowledgeNotification(btn.dataset.id);
      });
    });
  }

  // -- Render helpers --

  _renderBellIcon() {
    const unread = this._summary.unacknowledged || 0;
    return `
      <div class="bell-container">
        <button class="bell-icon" title="${unread} unread notifications">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          ${unread > 0 ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </button>
      </div>
    `;
  }

  _renderSummaryBar() {
    const total = this._summary.total || 0;
    const unack = this._summary.unacknowledged || 0;
    const critical = this._summary.critical || 0;

    return `
      <div class="summary-row">
        <div class="summary-grid">
          <div class="summary-card">
            <div class="card-label">Total</div>
            <div class="card-value">${total}</div>
          </div>
          <div class="summary-card">
            <div class="card-label">Unread</div>
            <div class="card-value">${unack}</div>
          </div>
          <div class="summary-card">
            <div class="card-label">Critical</div>
            <div class="card-value" style="color: ${SEVERITY_COLORS.critical}">${critical}</div>
          </div>
        </div>
        ${unack > 0 ? `
          <button class="ack-all-btn">Mark All as Read</button>
        ` : ''}
      </div>
    `;
  }

  _renderCategoryFilter() {
    const cats = ['all', 'build', 'quality', 'system', 'security'];
    return `
      <div class="category-bar">
        ${cats.map(cat => {
          const isActive = this._categoryFilter === cat;
          const label = cat === 'all' ? 'All' : (CATEGORIES[cat]?.label || cat);
          return `<button class="cat-btn ${isActive ? 'active' : ''}" data-cat="${cat}">${label}</button>`;
        }).join('')}
      </div>
    `;
  }

  _renderNotificationList() {
    let filtered = [...this._notifications].sort((a, b) => {
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    if (this._categoryFilter !== 'all') {
      filtered = filtered.filter(n => this._getCategory(n) === this._categoryFilter);
    }

    if (filtered.length === 0) {
      return '<div class="empty-state">No notifications</div>';
    }

    // Group by time
    const groups = {};
    for (const n of filtered) {
      const group = this._getTimeGroup(n.timestamp);
      if (!groups[group]) groups[group] = [];
      groups[group].push(n);
    }

    const groupOrder = ['Today', 'Yesterday', 'This Week', 'Earlier', 'Other'];
    let html = '';

    for (const group of groupOrder) {
      if (!groups[group] || groups[group].length === 0) continue;
      html += `<div class="time-group-label">${group}</div>`;
      html += groups[group].map(n => {
        const acked = n.acknowledged;
        const severityColor = this._getSeverityColor(n.severity);
        const category = this._getCategory(n);
        const catCfg = CATEGORIES[category] || { label: category, icon: '?' };

        return `
          <div class="notif-row ${acked ? 'acknowledged' : ''}">
            <span class="severity-dot" style="background: ${severityColor};" title="${this._escapeHTML(n.severity)}"></span>
            <span class="cat-icon" title="${this._escapeHTML(catCfg.label)}">${catCfg.icon}</span>
            <span class="notif-time">${this._formatTime(n.timestamp)}</span>
            <span class="notif-message">${this._escapeHTML(n.message)}</span>
            ${n.iteration != null ? `<span class="notif-iteration">iter ${n.iteration}</span>` : ''}
            <span class="notif-actions">
              ${!acked
                ? `<button class="ack-btn" data-id="${this._escapeHTML(n.id)}" title="Mark as read">Read</button>`
                : `<button class="unread-btn" data-id="${this._escapeHTML(n.id)}" title="Mark as unread">Unread</button>`}
              <button class="dismiss-btn" data-id="${this._escapeHTML(n.id)}" title="Dismiss">&#10005;</button>
            </span>
          </div>
        `;
      }).join('');
    }

    return html;
  }

  _renderTriggerList() {
    if (this._triggers.length === 0) {
      return '<div class="empty-state">No triggers configured</div>';
    }

    return this._triggers.map(t => {
      const severityColor = this._getSeverityColor(t.severity);
      const thresholdInfo = t.threshold_pct != null
        ? `Threshold: ${t.threshold_pct}%`
        : (t.pattern || '');

      return `
        <div class="trigger-row">
          <label class="toggle">
            <input type="checkbox" data-trigger-id="${this._escapeHTML(t.id)}" ${t.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span class="trigger-name">${this._escapeHTML(t.id)}</span>
          <span class="trigger-badge type-badge">${this._escapeHTML(t.type || 'custom')}</span>
          <span class="trigger-badge severity-badge" style="background: ${severityColor}; color: #fff;">${this._escapeHTML(t.severity || 'info')}</span>
          ${thresholdInfo ? `<span class="trigger-info">${this._escapeHTML(thresholdInfo)}</span>` : ''}
        </div>
      `;
    }).join('');
  }

  // -- Main render --

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .notif-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Bell icon */
        .bell-container {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 8px;
        }

        .bell-icon {
          position: relative;
          background: none;
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          padding: 8px 10px;
          cursor: pointer;
          color: var(--loki-text-secondary);
          display: flex;
          align-items: center;
          gap: 6px;
          transition: all 0.2s;
          font-family: inherit;
        }

        .bell-icon:hover {
          border-color: var(--loki-accent);
          color: var(--loki-accent);
        }

        .badge {
          position: absolute;
          top: -6px;
          right: -6px;
          background: var(--loki-red, #C45B5B);
          color: white;
          font-size: 10px;
          font-weight: 700;
          min-width: 18px;
          height: 18px;
          border-radius: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 4px;
          font-family: 'JetBrains Mono', monospace;
        }

        /* Tabs */
        .tabs {
          display: flex;
          gap: 2px;
          margin-bottom: 12px;
          background: var(--loki-bg-tertiary);
          border-radius: 5px;
          padding: 2px;
        }

        .tab {
          flex: 1;
          padding: 8px 12px;
          border: none;
          background: none;
          color: var(--loki-text-muted);
          cursor: pointer;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          transition: all 0.2s;
          font-family: inherit;
        }

        .tab:hover {
          color: var(--loki-text-secondary);
        }

        .tab.active {
          background: var(--loki-accent);
          color: white;
        }

        /* Category filter bar */
        .category-bar {
          display: flex;
          gap: 4px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }

        .cat-btn {
          padding: 4px 10px;
          border: 1px solid var(--loki-border);
          background: none;
          color: var(--loki-text-muted);
          cursor: pointer;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 500;
          transition: all 0.2s;
          font-family: inherit;
        }

        .cat-btn:hover {
          border-color: var(--loki-border-light);
          color: var(--loki-text-secondary);
        }

        .cat-btn.active {
          background: var(--loki-accent-muted);
          border-color: var(--loki-accent);
          color: var(--loki-accent);
        }

        /* Summary bar */
        .summary-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          justify-content: space-between;
        }

        .summary-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          flex: 1;
        }

        .summary-card {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          padding: 14px 16px;
          transition: all var(--loki-transition);
        }

        .summary-card:hover {
          border-color: var(--loki-border-light);
        }

        .card-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
          margin-bottom: 6px;
        }

        .card-value {
          font-size: 22px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
          line-height: 1.2;
        }

        /* Mark All as Read button */
        .ack-all-btn {
          padding: 8px 16px;
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          color: var(--loki-text-primary);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s;
          font-family: inherit;
          align-self: center;
        }

        .ack-all-btn:hover {
          border-color: var(--loki-accent);
          color: var(--loki-accent);
        }

        /* Time group labels */
        .time-group-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
          padding: 10px 14px 4px;
          background: var(--loki-bg-secondary);
        }

        /* Notification list */
        .notif-list {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          overflow: hidden;
        }

        .notif-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-bottom: 1px solid var(--loki-border);
          transition: all 0.2s;
        }

        .notif-row:last-child {
          border-bottom: none;
        }

        .notif-row:hover {
          background: var(--loki-bg-hover);
        }

        .notif-row.acknowledged {
          opacity: 0.5;
        }

        .severity-dot {
          width: 12px;
          height: 6px;
          border-radius: 2px;
          flex-shrink: 0;
        }

        .cat-icon {
          width: 22px;
          height: 22px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 700;
          background: var(--loki-bg-tertiary);
          color: var(--loki-text-secondary);
          flex-shrink: 0;
          font-family: 'JetBrains Mono', monospace;
        }

        .notif-time {
          font-size: 11px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-muted);
          white-space: nowrap;
          min-width: 56px;
        }

        .notif-message {
          flex: 1;
          font-size: 13px;
          color: var(--loki-text-primary);
          line-height: 1.4;
        }

        .notif-iteration {
          font-size: 10px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-muted);
          background: var(--loki-bg-tertiary);
          padding: 2px 8px;
          border-radius: 5px;
          white-space: nowrap;
        }

        .notif-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }

        .ack-btn, .unread-btn, .dismiss-btn {
          padding: 4px 10px;
          background: none;
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          color: var(--loki-text-secondary);
          font-size: 11px;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s;
          font-family: inherit;
        }

        .ack-btn:hover, .unread-btn:hover {
          border-color: var(--loki-accent);
          color: var(--loki-accent);
        }

        .dismiss-btn {
          padding: 4px 6px;
          font-size: 12px;
        }

        .dismiss-btn:hover {
          border-color: var(--loki-red);
          color: var(--loki-red);
        }

        /* Trigger list */
        .trigger-list {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          overflow: hidden;
        }

        .trigger-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--loki-border);
        }

        .trigger-row:last-child {
          border-bottom: none;
        }

        .trigger-row:hover {
          background: var(--loki-bg-hover);
        }

        .trigger-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--loki-text-primary);
          min-width: 100px;
        }

        .trigger-badge {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          padding: 3px 8px;
          border-radius: 5px;
          white-space: nowrap;
        }

        .type-badge {
          background: var(--loki-bg-tertiary);
          color: var(--loki-text-secondary);
        }

        .severity-badge {
          color: #fff;
        }

        .trigger-info {
          font-size: 11px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-muted);
          margin-left: auto;
        }

        /* Toggle switch */
        .toggle {
          position: relative;
          width: 36px;
          height: 20px;
          flex-shrink: 0;
        }

        .toggle input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          inset: 0;
          background: var(--loki-bg-tertiary);
          border-radius: 5px;
          cursor: pointer;
          transition: 0.2s;
        }

        .toggle-slider:before {
          content: '';
          position: absolute;
          width: 16px;
          height: 16px;
          left: 2px;
          bottom: 2px;
          background: var(--loki-text-muted);
          border-radius: 50%;
          transition: 0.2s;
        }

        .toggle input:checked + .toggle-slider {
          background: var(--loki-accent);
        }

        .toggle input:checked + .toggle-slider:before {
          transform: translateX(16px);
          background: white;
        }

        /* Empty state */
        .empty-state {
          text-align: center;
          padding: 32px 16px;
          color: var(--loki-text-muted);
          font-size: 13px;
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
        }

        /* Offline notice */
        .offline-notice {
          text-align: center;
          padding: 20px;
          color: var(--loki-text-muted);
          font-size: 12px;
        }
      </style>

      <div class="notif-container">
        ${this._renderBellIcon()}

        ${!this._connected ? '<div class="offline-notice">Connecting to notifications API...</div>' : ''}

        ${this._panelOpen ? `
          <!-- Tabs -->
          <div class="tabs">
            <button class="tab ${this._activeTab === 'feed' ? 'active' : ''}" data-tab="feed">Feed</button>
            <button class="tab ${this._activeTab === 'triggers' ? 'active' : ''}" data-tab="triggers">Triggers</button>
          </div>

          <!-- Feed Tab -->
          ${this._activeTab === 'feed' ? `
            ${this._renderSummaryBar()}
            ${this._renderCategoryFilter()}
            <div class="notif-list">
              ${this._renderNotificationList()}
            </div>
          ` : ''}

          <!-- Triggers Tab -->
          ${this._activeTab === 'triggers' ? `
            <div class="trigger-list">
              ${this._renderTriggerList()}
            </div>
          ` : ''}
        ` : ''}
      </div>
    `;

    this._bindEvents();
  }
}

// Register the component
if (!customElements.get('loki-notification-center')) {
  customElements.define('loki-notification-center', LokiNotificationCenter);
}

export default LokiNotificationCenter;
