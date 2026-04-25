/**
 * @fileoverview Loki Managed Memory Panel
 *
 * Read-only viewer for the Anthropic Managed Memory beta surface.
 * Polls /api/managed/status on mount; if disabled, renders a
 * disabled-state notice and performs no further network activity.
 * When enabled, lists recent managed-memory events (limit=50) and
 * supports ad-hoc memory-version lookup by ID.
 *
 * Out of scope for v1: write operations, event filtering DSL,
 * websocket streaming, charts.
 *
 * @example
 * <loki-managed-memory-panel api-url="http://localhost:57374" theme="dark"></loki-managed-memory-panel>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

const DEFAULT_EVENT_LIMIT = 50;

/**
 * @class LokiManagedMemoryPanel
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - Theme override (light, dark, high-contrast, etc.)
 */
export class LokiManagedMemoryPanel extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._api = null;

    // Status state
    this._statusLoading = false;
    this._statusError = null;
    this._status = null; // {enabled, parent_flag, child_flags, beta_header, last_fallback_ts}

    // Events state
    this._eventsLoading = false;
    this._eventsError = null;
    this._events = [];
    this._eventsSource = null;
    this._eventsCount = 0;

    // Memory-version lookup state
    this._lookupId = '';
    this._lookupLoading = false;
    this._lookupError = null;
    this._lookupResult = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadStatus();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // No polling/timers in v1; method kept for symmetry with other panels.
    this._stopPolling();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    switch (name) {
      case 'api-url':
        if (this._api) {
          this._api.baseUrl = newValue;
          this._loadStatus();
        }
        break;
      case 'theme':
        this._applyTheme();
        this.render();
        break;
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  _stopPolling() {
    // Reserved for future polling lifecycle; intentionally a no-op in v1.
  }

  async _loadStatus() {
    this._statusLoading = true;
    this._statusError = null;
    this.render();

    try {
      this._status = await this._api.get('/api/managed/status');
    } catch (err) {
      this._statusError = (err && err.message) ? err.message : 'Failed to load managed status';
      this._status = null;
    } finally {
      this._statusLoading = false;
    }

    // Only fan out to events when the surface is actually enabled.
    if (this._status && this._status.enabled) {
      await this._loadEvents();
    } else {
      this.render();
    }
  }

  async _loadEvents(limit = DEFAULT_EVENT_LIMIT) {
    this._eventsLoading = true;
    this._eventsError = null;
    this.render();

    try {
      const data = await this._api.get('/api/managed/events?limit=' + encodeURIComponent(limit));
      // Endpoint shape: {events, count, source}; tolerate plain arrays too.
      if (Array.isArray(data)) {
        this._events = data;
        this._eventsCount = data.length;
        this._eventsSource = null;
      } else if (data && typeof data === 'object') {
        this._events = Array.isArray(data.events) ? data.events : [];
        this._eventsCount = typeof data.count === 'number' ? data.count : this._events.length;
        this._eventsSource = data.source || null;
      } else {
        this._events = [];
        this._eventsCount = 0;
        this._eventsSource = null;
      }
    } catch (err) {
      this._eventsError = (err && err.message) ? err.message : 'Failed to load managed events';
      this._events = [];
      this._eventsCount = 0;
      this._eventsSource = null;
    } finally {
      this._eventsLoading = false;
      this.render();
    }
  }

  async _lookupMemoryVersion() {
    const id = (this._lookupId || '').trim();
    if (!id) {
      this._lookupError = 'Enter a memory ID to look up';
      this._lookupResult = null;
      this.render();
      return;
    }

    this._lookupLoading = true;
    this._lookupError = null;
    this._lookupResult = null;
    this.render();

    try {
      const path = '/api/managed/memory_versions/' + encodeURIComponent(id);
      this._lookupResult = await this._api.get(path);
    } catch (err) {
      this._lookupError = (err && err.message) ? err.message : 'Failed to load memory versions';
      this._lookupResult = null;
    } finally {
      this._lookupLoading = false;
      this.render();
    }
  }

  _onLookupInput(event) {
    this._lookupId = event && event.target ? event.target.value : '';
  }

  _onLookupKeyDown(event) {
    if (event && event.key === 'Enter') {
      event.preventDefault();
      this._lookupMemoryVersion();
    }
  }

  _attachEventHandlers() {
    const root = this.shadowRoot;
    if (!root) return;

    const refreshBtn = root.querySelector('#refresh-status-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._loadStatus());
    }

    const refreshEventsBtn = root.querySelector('#refresh-events-btn');
    if (refreshEventsBtn) {
      refreshEventsBtn.addEventListener('click', () => this._loadEvents());
    }

    const lookupInput = root.querySelector('#lookup-input');
    if (lookupInput) {
      lookupInput.addEventListener('input', (e) => this._onLookupInput(e));
      lookupInput.addEventListener('keydown', (e) => this._onLookupKeyDown(e));
    }

    const lookupBtn = root.querySelector('#lookup-btn');
    if (lookupBtn) {
      lookupBtn.addEventListener('click', () => this._lookupMemoryVersion());
    }
  }

  _escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatTimestamp(ts) {
    if (!ts) return '';
    // Accept seconds, milliseconds, or ISO strings.
    let date;
    if (typeof ts === 'number') {
      date = new Date(ts > 1e12 ? ts : ts * 1000);
    } else {
      date = new Date(ts);
    }
    if (Number.isNaN(date.getTime())) return String(ts);
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }

  _renderStatusSection() {
    if (this._statusLoading) {
      return '<div class="status-row muted">Loading managed memory status...</div>';
    }
    if (this._statusError) {
      return `
        <div class="error-banner" role="alert">
          <strong>Status error:</strong>
          <span>${this._escapeHtml(this._statusError)}</span>
        </div>
      `;
    }
    if (!this._status) {
      return '<div class="status-row muted">No managed memory status available.</div>';
    }

    const enabled = !!this._status.enabled;
    const parent = this._status.parent_flag;
    const child = this._status.child_flags;
    const beta = this._status.beta_header;
    const fallback = this._status.last_fallback_ts;

    const childSummary = child && typeof child === 'object'
      ? Object.entries(child)
          .map(([k, v]) => `${this._escapeHtml(k)}=${this._escapeHtml(v)}`)
          .join(', ')
      : (child === undefined || child === null ? '' : String(child));

    return `
      <div class="status-grid">
        <div class="status-cell">
          <div class="status-label">Enabled</div>
          <div class="status-value ${enabled ? 'on' : 'off'}">${enabled ? 'true' : 'false'}</div>
        </div>
        <div class="status-cell">
          <div class="status-label">Parent flag</div>
          <div class="status-value">${this._escapeHtml(parent === undefined ? '-' : parent)}</div>
        </div>
        <div class="status-cell">
          <div class="status-label">Child flags</div>
          <div class="status-value">${this._escapeHtml(childSummary || '-')}</div>
        </div>
        <div class="status-cell">
          <div class="status-label">Beta header</div>
          <div class="status-value mono">${this._escapeHtml(beta || '-')}</div>
        </div>
        <div class="status-cell">
          <div class="status-label">Last fallback</div>
          <div class="status-value mono">${this._escapeHtml(this._formatTimestamp(fallback) || '-')}</div>
        </div>
      </div>
    `;
  }

  _renderDisabledNotice() {
    return `
      <div class="disabled-notice" role="status">
        <div class="disabled-title">Managed memory is disabled</div>
        <div class="disabled-body">
          The managed memory beta surface is not active for this session.
          Enable it via the parent feature flag and reload to view events
          and memory versions.
        </div>
      </div>
    `;
  }

  _renderEventsSection() {
    if (this._eventsLoading) {
      return '<div class="events-empty muted">Loading events...</div>';
    }
    if (this._eventsError) {
      return `
        <div class="error-banner" role="alert">
          <strong>Events error:</strong>
          <span>${this._escapeHtml(this._eventsError)}</span>
        </div>
      `;
    }
    if (!this._events.length) {
      return '<div class="events-empty muted">No managed memory events recorded yet.</div>';
    }

    const rows = this._events.map((event) => {
      const ts = this._formatTimestamp(event && (event.ts || event.timestamp || event.time));
      const type = event && (event.type || event.event_type || event.kind || 'event');
      const memoryId = event && (event.memory_id || event.memoryId || event.id || '');
      const summaryRaw = event && (event.summary || event.message || event.detail || '');
      const summary = typeof summaryRaw === 'string'
        ? summaryRaw
        : JSON.stringify(summaryRaw);

      return `
        <tr>
          <td class="mono nowrap">${this._escapeHtml(ts)}</td>
          <td><span class="badge">${this._escapeHtml(type)}</span></td>
          <td class="mono">${this._escapeHtml(memoryId)}</td>
          <td>${this._escapeHtml(summary)}</td>
        </tr>
      `;
    }).join('');

    const sourceLabel = this._eventsSource
      ? `<span class="source-tag">source: ${this._escapeHtml(this._eventsSource)}</span>`
      : '';

    return `
      <div class="events-meta">
        <span class="muted">${this._eventsCount} event(s)</span>
        ${sourceLabel}
      </div>
      <div class="events-table-wrap">
        <table class="events-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Memory ID</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _renderLookupSection() {
    let resultBlock = '';
    if (this._lookupLoading) {
      resultBlock = '<div class="lookup-result muted">Loading memory versions...</div>';
    } else if (this._lookupError) {
      resultBlock = `
        <div class="error-banner" role="alert">
          <strong>Lookup error:</strong>
          <span>${this._escapeHtml(this._lookupError)}</span>
        </div>
      `;
    } else if (this._lookupResult !== null && this._lookupResult !== undefined) {
      let pretty;
      try {
        pretty = JSON.stringify(this._lookupResult, null, 2);
      } catch (e) {
        pretty = String(this._lookupResult);
      }
      resultBlock = `<pre class="lookup-result mono">${this._escapeHtml(pretty)}</pre>`;
    }

    const inputValue = this._escapeHtml(this._lookupId || '');

    return `
      <div class="lookup-controls">
        <input
          id="lookup-input"
          type="text"
          class="lookup-input"
          placeholder="Memory ID (e.g. mem_abc123)"
          value="${inputValue}"
          autocomplete="off"
          spellcheck="false"
        />
        <button id="lookup-btn" class="btn btn-primary" type="button">
          Look up versions
        </button>
      </div>
      ${resultBlock}
    `;
  }

  render() {
    if (!this.shadowRoot) return;

    const enabled = !!(this._status && this._status.enabled);
    const showOperational = enabled && !this._statusError;

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
          color: var(--loki-text-primary);
          font-family: var(--loki-font-sans, system-ui, sans-serif);
        }

        .panel {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 6px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .panel-title {
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--loki-text-primary);
          margin: 0;
        }

        .panel-subtitle {
          font-size: 11px;
          color: var(--loki-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        .section {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .section-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--loki-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin: 0;
        }

        .status-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 8px;
        }

        .status-cell {
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .status-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--loki-text-muted);
        }

        .status-value {
          font-size: 13px;
          color: var(--loki-text-primary);
          word-break: break-word;
        }

        .status-value.on { color: var(--loki-green); font-weight: 600; }
        .status-value.off { color: var(--loki-text-muted); }
        .status-value.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; }

        .status-row {
          padding: 12px 0;
        }

        .muted {
          color: var(--loki-text-muted);
          font-size: 12px;
        }

        .btn {
          background: var(--loki-bg-secondary);
          color: var(--loki-text-primary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all var(--loki-transition);
        }

        .btn:hover {
          background: var(--loki-bg-hover);
          border-color: var(--loki-border-light);
        }

        .btn-primary {
          background: var(--loki-accent);
          color: #ffffff;
          border-color: var(--loki-accent);
        }

        .btn-primary:hover {
          background: var(--loki-accent-light);
          border-color: var(--loki-accent-light);
        }

        .disabled-notice {
          background: var(--loki-bg-secondary);
          border: 1px dashed var(--loki-border-light);
          border-radius: 4px;
          padding: 16px;
          text-align: left;
        }

        .disabled-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--loki-text-secondary);
          margin-bottom: 6px;
        }

        .disabled-body {
          font-size: 12px;
          color: var(--loki-text-muted);
          line-height: 1.5;
        }

        .error-banner {
          background: var(--loki-red-muted);
          color: var(--loki-red);
          border: 1px solid var(--loki-red);
          border-radius: 4px;
          padding: 8px 10px;
          font-size: 12px;
          display: flex;
          gap: 6px;
          align-items: baseline;
          flex-wrap: wrap;
        }

        .events-meta {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }

        .source-tag {
          font-size: 11px;
          color: var(--loki-text-muted);
          background: var(--loki-bg-tertiary);
          padding: 2px 6px;
          border-radius: 3px;
        }

        .events-table-wrap {
          overflow-x: auto;
          border: 1px solid var(--loki-border);
          border-radius: 4px;
        }

        .events-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }

        .events-table th,
        .events-table td {
          text-align: left;
          padding: 6px 10px;
          border-bottom: 1px solid var(--loki-border);
          vertical-align: top;
        }

        .events-table th {
          background: var(--loki-bg-secondary);
          color: var(--loki-text-secondary);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .events-table tr:last-child td {
          border-bottom: none;
        }

        .events-empty {
          padding: 16px;
          text-align: center;
          background: var(--loki-bg-secondary);
          border-radius: 4px;
        }

        .badge {
          display: inline-block;
          padding: 1px 6px;
          font-size: 11px;
          background: var(--loki-accent-muted);
          color: var(--loki-accent);
          border-radius: 3px;
          font-weight: 500;
        }

        .mono {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
        }

        .nowrap {
          white-space: nowrap;
        }

        .lookup-controls {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }

        .lookup-input {
          flex: 1 1 240px;
          min-width: 200px;
          padding: 6px 10px;
          font-size: 12px;
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          background: var(--loki-bg-primary);
          color: var(--loki-text-primary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
        }

        .lookup-input:focus {
          outline: none;
          border-color: var(--loki-accent);
          box-shadow: 0 0 0 2px var(--loki-accent-muted);
        }

        .lookup-result {
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 10px;
          font-size: 12px;
          max-height: 320px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--loki-text-primary);
        }
      </style>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Managed Memory</h2>
            <div class="panel-subtitle">Anthropic managed memory beta</div>
          </div>
          <button id="refresh-status-btn" class="btn" type="button">Refresh status</button>
        </div>

        <div class="section">
          <h3 class="section-title">Status</h3>
          ${this._renderStatusSection()}
        </div>

        ${showOperational ? `
          <div class="section">
            <div class="panel-header">
              <h3 class="section-title">Recent events (limit ${DEFAULT_EVENT_LIMIT})</h3>
              <button id="refresh-events-btn" class="btn" type="button">Refresh events</button>
            </div>
            ${this._renderEventsSection()}
          </div>

          <div class="section">
            <h3 class="section-title">Memory version lookup</h3>
            ${this._renderLookupSection()}
          </div>
        ` : (this._statusError ? '' : this._renderDisabledNotice())}
      </div>
    `;

    this._attachEventHandlers();
  }
}

if (!customElements.get('loki-managed-memory-panel')) {
  customElements.define('loki-managed-memory-panel', LokiManagedMemoryPanel);
}

export default LokiManagedMemoryPanel;
