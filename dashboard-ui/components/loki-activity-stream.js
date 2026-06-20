/**
 * @fileoverview Real-Time Activity Stream - flowing feed of system activity
 * with severity filtering, auto-scroll, and animated item entry. Shows
 * timestamps, severity color bands, and activity messages. Caps at 100 items.
 *
 * @example
 * <loki-activity-stream api-url="http://localhost:57374" theme="dark"></loki-activity-stream>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/** @type {Object<string, {color: string, label: string, icon: string}>} */
const SEVERITY_CONFIG = {
  info:    { color: 'var(--loki-blue, #2F71E3)',   label: 'INFO',    icon: 'i' },
  success: { color: 'var(--loki-green, #1FC5A8)',  label: 'OK',      icon: '+' },
  warning: { color: 'var(--loki-yellow, #D4A03C)', label: 'WARN',    icon: '!' },
  error:   { color: 'var(--loki-red, #C45B5B)',    label: 'ERR',     icon: 'x' },
};

const MAX_ITEMS = 100;

/**
 * @class LokiActivityStream
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - Theme name (default: auto-detect)
 */
export class LokiActivityStream extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._items = [];
    this._filter = 'all';
    this._api = null;
    this._pollInterval = null;
    this._paused = false;
    this._lastTimestamp = null;
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
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, replacing the per-component
    // visibilitychange handler. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
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
    try {
      const data = await this._api._get('/api/v2/activity');
      const events = data.events || data.activities || [];
      if (events.length > 0) {
        const newItems = events
          .filter(e => !this._lastTimestamp || new Date(e.timestamp) > new Date(this._lastTimestamp))
          .map(e => ({
            id: e.id || crypto.randomUUID(),
            timestamp: e.timestamp || new Date().toISOString(),
            message: e.message || e.description || '',
            severity: e.severity || e.level || 'info',
            source: e.source || e.component || '',
            isNew: true,
          }));

        if (newItems.length > 0) {
          this._items = [...newItems, ...this._items].slice(0, MAX_ITEMS);
          this._lastTimestamp = newItems[0].timestamp;
          // Clear "new" flag after animation
          setTimeout(() => {
            this._items.forEach(i => i.isNew = false);
          }, 600);
        }
      }
    } catch {
      // Generate demo data on first load if API unavailable
      if (this._items.length === 0) {
        this._items = this._getDemoItems();
      }
    }
    this.render();
  }

  _getDemoItems() {
    const now = Date.now();
    return [
      { id: '1', timestamp: new Date(now - 2000).toISOString(), message: 'Build iteration #12 started', severity: 'info', source: 'runner' },
      { id: '2', timestamp: new Date(now - 5000).toISOString(), message: 'Code review passed (3/3 reviewers)', severity: 'success', source: 'review' },
      { id: '3', timestamp: new Date(now - 8000).toISOString(), message: 'Context window at 78% capacity', severity: 'warning', source: 'context' },
      { id: '4', timestamp: new Date(now - 12000).toISOString(), message: 'Test suite completed: 42/42 passed', severity: 'success', source: 'testing' },
      { id: '5', timestamp: new Date(now - 15000).toISOString(), message: 'RARV cycle: Verify phase complete', severity: 'info', source: 'rarv' },
    ];
  }

  _formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
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

  _getFilteredItems() {
    if (this._filter === 'all') return this._items;
    return this._items.filter(i => i.severity === this._filter);
  }

  _setFilter(filter) {
    this._filter = filter;
    this.render();
  }

  _bindEvents() {
    const root = this.shadowRoot;

    // Filter buttons
    root.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setFilter(btn.dataset.filter);
      });
    });

    // Pause on hover
    const feed = root.querySelector('.activity-feed');
    if (feed) {
      feed.addEventListener('mouseenter', () => { this._paused = true; });
      feed.addEventListener('mouseleave', () => { this._paused = false; });
    }
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .stream-container {
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .title {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
      }

      .filter-bar {
        display: flex;
        gap: 4px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        border-radius: 5px;
        padding: 2px;
      }

      .filter-btn {
        padding: 4px 10px;
        border: none;
        background: none;
        color: var(--loki-text-muted, #939084);
        cursor: pointer;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.2s;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      .filter-btn:hover {
        color: var(--loki-text-secondary, #36342E);
      }

      .filter-btn.active {
        background: var(--loki-accent, #553DE9);
        color: white;
      }

      .activity-feed {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        max-height: 400px;
        overflow-y: auto;
        overflow-x: hidden;
      }

      .activity-item {
        display: flex;
        align-items: stretch;
        gap: 0;
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        transition: background 0.2s, opacity 0.3s;
        animation: slideIn 0.3s ease-out;
      }

      .activity-item:last-child {
        border-bottom: none;
      }

      .activity-item:hover {
        background: var(--loki-bg-hover, #F3EFE9);
      }

      .activity-item.new-item {
        animation: slideInFromRight 0.4s ease-out;
      }

      @keyframes slideInFromRight {
        from {
          transform: translateX(30px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }

      @keyframes slideIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .severity-band {
        width: 4px;
        flex-shrink: 0;
      }

      .item-content {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        flex: 1;
        min-width: 0;
      }

      .severity-icon {
        width: 22px;
        height: 22px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: white;
        flex-shrink: 0;
        font-family: 'JetBrains Mono', monospace;
      }

      .item-time {
        font-size: 11px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-muted, #939084);
        white-space: nowrap;
        min-width: 70px;
      }

      .item-message {
        flex: 1;
        font-size: 13px;
        color: var(--loki-text-primary, #201515);
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-source {
        font-size: 10px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-muted, #939084);
        background: var(--loki-bg-tertiary, #ECEAE3);
        padding: 2px 8px;
        border-radius: 5px;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .empty-state {
        text-align: center;
        padding: 32px 16px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }

      .count-badge {
        font-size: 11px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-muted, #939084);
        margin-left: 4px;
      }

      .pause-indicator {
        font-size: 10px;
        color: var(--loki-text-muted, #939084);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 2px 8px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        border-radius: 4px;
      }

      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: var(--loki-bg-primary, #FFFEFB); }
      ::-webkit-scrollbar-thumb { background: var(--loki-border, #ECEAE3); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--loki-border-light, #C5C0B1); }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const filtered = this._getFilteredItems();
    const severities = ['all', 'info', 'success', 'warning', 'error'];

    const filterButtons = severities.map(sev => {
      const isActive = this._filter === sev;
      const label = sev === 'all' ? 'All' : (SEVERITY_CONFIG[sev]?.label || sev);
      return `<button class="filter-btn ${isActive ? 'active' : ''}" data-filter="${sev}">${label}</button>`;
    }).join('');

    let feedContent;
    if (filtered.length === 0) {
      feedContent = '<div class="empty-state">No activity to display</div>';
    } else {
      feedContent = filtered.map(item => {
        const cfg = SEVERITY_CONFIG[item.severity] || SEVERITY_CONFIG.info;
        return `
          <div class="activity-item ${item.isNew ? 'new-item' : ''}">
            <div class="severity-band" style="background: ${cfg.color};"></div>
            <div class="item-content">
              <div class="severity-icon" style="background: ${cfg.color};">${cfg.icon}</div>
              <span class="item-time">${this._formatTime(item.timestamp)}</span>
              <span class="item-message">${this._escapeHtml(item.message)}</span>
              ${item.source ? `<span class="item-source">${this._escapeHtml(item.source)}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="stream-container">
        <div class="header">
          <h3 class="title">Activity Stream <span class="count-badge">${this._items.length}</span></h3>
          <div class="filter-bar">${filterButtons}</div>
        </div>
        <div class="activity-feed">
          ${feedContent}
        </div>
      </div>
    `;

    this._bindEvents();

    // Auto-scroll to top (newest items) unless paused
    if (!this._paused) {
      const feed = s.querySelector('.activity-feed');
      if (feed) feed.scrollTop = 0;
    }
  }
}

if (!customElements.get('loki-activity-stream')) {
  customElements.define('loki-activity-stream', LokiActivityStream);
}

export default LokiActivityStream;
