/**
 * @fileoverview Loki Context Tracker Component - displays context window
 * utilization as a gauge, per-iteration timeline, and token type breakdown.
 * Polls /api/context every 5 seconds. Shows compaction events and tracks
 * input/output/cache token distribution across iterations.
 *
 * @example
 * <loki-context-tracker api-url="http://localhost:57374" theme="dark"></loki-context-tracker>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/**
 * @class LokiContextTracker
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiContextTracker extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._data = null;
    this._connected = false;
    this._activeTab = 'gauge';
    this._api = null;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadContext();
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
      this._loadContext();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _loadContext() {
    try {
      const apiUrl = this.getAttribute('api-url') || window.location.origin;
      const resp = await fetch(apiUrl + '/api/context');
      if (resp.ok) {
        this._data = await resp.json();
        this._connected = true;
      }
    } catch {
      this._connected = false;
    }
    this.render();
  }

  _startPolling() {
    this._pollInterval = setInterval(() => {
      this._loadContext();
    }, 5000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  _setTab(tab) {
    this._activeTab = tab;
    this.render();
  }

  _formatTokens(count) {
    if (!count || count === 0) return '0';
    if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + 'M';
    if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K';
    return String(count);
  }

  _formatUSD(amount) {
    if (!amount || amount === 0) return '$0.00';
    if (amount < 0.01) return '<$0.01';
    return '$' + amount.toFixed(2);
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _getGaugeColor(pct) {
    if (pct > 80) return 'var(--loki-red)';
    if (pct >= 60) return 'var(--loki-yellow)';
    return 'var(--loki-green)';
  }

  _getGaugeColorClass(pct) {
    if (pct > 80) return 'gauge-red';
    if (pct >= 60) return 'gauge-yellow';
    return 'gauge-green';
  }

  _renderGaugeTab() {
    const current = this._data?.current || {};
    const totals = this._data?.totals || {};
    const pct = current.context_window_pct || 0;
    const gaugeColor = this._getGaugeColor(pct);
    const colorClass = this._getGaugeColorClass(pct);

    // SVG circular gauge parameters
    const radius = 70;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference - (pct / 100) * circumference;

    return `
      <div class="gauge-tab">
        <div class="gauge-container">
          <svg class="gauge-svg" viewBox="0 0 180 180" aria-label="Context window usage: ${pct.toFixed(1)}%">
            <circle
              class="gauge-bg"
              cx="90" cy="90" r="${radius}"
              fill="none"
              stroke="var(--loki-bg-tertiary)"
              stroke-width="12"
            />
            <circle
              class="gauge-ring ${colorClass}"
              cx="90" cy="90" r="${radius}"
              fill="none"
              stroke="${gaugeColor}"
              stroke-width="12"
              stroke-linecap="round"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${dashOffset}"
              transform="rotate(-90 90 90)"
            />
            <text class="gauge-pct" x="90" y="85" text-anchor="middle"
                  fill="var(--loki-text-primary)" font-size="28" font-weight="600"
                  font-family="'JetBrains Mono', monospace">
              ${pct.toFixed(1)}%
            </text>
            <text class="gauge-label" x="90" y="108" text-anchor="middle"
                  fill="var(--loki-text-muted)" font-size="11">
              Context Used
            </text>
          </svg>
        </div>

        <div class="summary-grid">
          <div class="summary-card">
            <div class="card-label">Total Tokens</div>
            <div class="card-value">${this._formatTokens(current.total_tokens)}</div>
            <div class="card-sub">${this._formatTokens(current.input_tokens)} in / ${this._formatTokens(current.output_tokens)} out</div>
          </div>
          <div class="summary-card">
            <div class="card-label">Estimated Cost</div>
            <div class="card-value accent">${this._formatUSD(current.estimated_cost_usd)}</div>
          </div>
          <div class="summary-card">
            <div class="card-label">Compactions</div>
            <div class="card-value">${totals.compaction_count || 0}</div>
          </div>
          <div class="summary-card">
            <div class="card-label">Iterations Tracked</div>
            <div class="card-value">${totals.iterations_tracked || 0}</div>
          </div>
        </div>

        <div class="cache-info">
          <div class="section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span class="section-title">Cache Tokens</span>
          </div>
          <div class="cache-grid">
            <div class="cache-item">
              <span class="cache-label">Cache Read</span>
              <span class="cache-value">${this._formatTokens(current.cache_read_tokens)}</span>
            </div>
            <div class="cache-item">
              <span class="cache-label">Cache Creation</span>
              <span class="cache-value">${this._formatTokens(current.cache_creation_tokens)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _renderTimelineTab() {
    const iterations = this._data?.per_iteration || [];
    const compactions = this._data?.compactions || [];

    if (iterations.length === 0) {
      return '<div class="empty-state">No iteration data yet</div>';
    }

    // Find max tokens for bar scaling
    const maxTokens = Math.max(
      ...iterations.map(it => (it.input_tokens || 0) + (it.output_tokens || 0) + (it.cache_read_tokens || 0) + (it.cache_creation_tokens || 0))
    );

    // Build a set of compaction iteration numbers for separator display
    const compactionIterations = new Set(compactions.map(c => c.at_iteration));

    let rows = '';
    for (const it of iterations) {
      const totalIt = (it.input_tokens || 0) + (it.output_tokens || 0) + (it.cache_read_tokens || 0) + (it.cache_creation_tokens || 0);
      const widthPct = maxTokens > 0 ? (totalIt / maxTokens) * 100 : 0;
      const isCompacted = it.compacted === true;

      // Insert compaction separator before this iteration if applicable
      if (compactionIterations.has(it.iteration)) {
        rows += `
          <div class="timeline-compaction-row">
            <div class="compaction-line"></div>
            <span class="compaction-label">Context Compacted</span>
            <div class="compaction-line"></div>
          </div>
        `;
      }

      rows += `
        <div class="timeline-row ${isCompacted ? 'compacted' : ''}">
          <div class="timeline-iter">#${it.iteration}</div>
          <div class="timeline-bar-container">
            <div class="timeline-bar" style="width: ${widthPct.toFixed(1)}%"></div>
          </div>
          <div class="timeline-tokens">${this._formatTokens(totalIt)}</div>
          <div class="timeline-cost">${this._formatUSD(it.cost_usd)}</div>
        </div>
      `;
    }

    return `
      <div class="timeline-tab">
        <div class="section-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span class="section-title">Per-Iteration Token Usage</span>
        </div>
        <div class="timeline-header-row">
          <div class="timeline-iter">Iter</div>
          <div class="timeline-bar-container">Tokens</div>
          <div class="timeline-tokens">Count</div>
          <div class="timeline-cost">Cost</div>
        </div>
        ${rows}
      </div>
    `;
  }

  _renderBreakdownTab() {
    const iterations = this._data?.per_iteration || [];

    if (iterations.length === 0) {
      return '<div class="empty-state">No iteration data yet</div>';
    }

    // Find max total for scaling
    const maxTokens = Math.max(
      ...iterations.map(it => (it.input_tokens || 0) + (it.output_tokens || 0) + (it.cache_read_tokens || 0) + (it.cache_creation_tokens || 0))
    );

    const legend = `
      <div class="breakdown-legend">
        <div class="legend-item"><span class="legend-swatch swatch-input"></span> Input</div>
        <div class="legend-item"><span class="legend-swatch swatch-output"></span> Output</div>
        <div class="legend-item"><span class="legend-swatch swatch-cache-read"></span> Cache Read</div>
        <div class="legend-item"><span class="legend-swatch swatch-cache-create"></span> Cache Creation</div>
      </div>
    `;

    let rows = '';
    for (const it of iterations) {
      const input = it.input_tokens || 0;
      const output = it.output_tokens || 0;
      const cacheRead = it.cache_read_tokens || 0;
      const cacheCreate = it.cache_creation_tokens || 0;
      const total = input + output + cacheRead + cacheCreate;

      const inputPct = maxTokens > 0 ? (input / maxTokens) * 100 : 0;
      const outputPct = maxTokens > 0 ? (output / maxTokens) * 100 : 0;
      const cacheReadPct = maxTokens > 0 ? (cacheRead / maxTokens) * 100 : 0;
      const cacheCreatePct = maxTokens > 0 ? (cacheCreate / maxTokens) * 100 : 0;

      rows += `
        <div class="breakdown-row">
          <div class="breakdown-iter">#${it.iteration}</div>
          <div class="breakdown-bar-container">
            <div class="breakdown-bar bar-input" style="width: ${inputPct.toFixed(1)}%"></div>
            <div class="breakdown-bar bar-output" style="width: ${outputPct.toFixed(1)}%"></div>
            <div class="breakdown-bar bar-cache-read" style="width: ${cacheReadPct.toFixed(1)}%"></div>
            <div class="breakdown-bar bar-cache-create" style="width: ${cacheCreatePct.toFixed(1)}%"></div>
          </div>
          <div class="breakdown-cost">${this._formatUSD(it.cost_usd)}</div>
        </div>
      `;
    }

    return `
      <div class="breakdown-tab">
        <div class="section-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <span class="section-title">Token Type Breakdown</span>
        </div>
        ${legend}
        ${rows}
      </div>
    `;
  }

  render() {
    const tabContent = this._activeTab === 'gauge'
      ? this._renderGaugeTab()
      : this._activeTab === 'timeline'
        ? this._renderTimelineTab()
        : this._renderBreakdownTab();

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .context-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Tabs */
        .tabs {
          display: flex;
          gap: 2px;
          margin-bottom: 16px;
          background: var(--loki-bg-tertiary);
          border-radius: 8px;
          padding: 2px;
        }

        .tab {
          flex: 1;
          padding: 8px 12px;
          border: none;
          background: none;
          color: var(--loki-text-muted);
          cursor: pointer;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          transition: all 0.2s;
          font-family: inherit;
        }

        .tab:hover {
          color: var(--loki-text-secondary);
        }

        .tab.active {
          background: var(--loki-bg-card);
          color: var(--loki-text-primary);
          box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }

        /* Summary Cards */
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px;
        }

        .summary-card {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 10px;
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
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
          margin-bottom: 6px;
        }

        .card-value {
          font-size: 22px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-primary);
          line-height: 1.2;
        }

        .card-value.accent {
          color: var(--loki-accent);
        }

        .card-sub {
          font-size: 11px;
          color: var(--loki-text-muted);
          margin-top: 4px;
          font-family: 'JetBrains Mono', monospace;
        }

        /* Section Headers */
        .section-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
        }

        .section-header svg {
          width: 16px;
          height: 16px;
          color: var(--loki-text-muted);
          flex-shrink: 0;
        }

        .section-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
        }

        /* Gauge Tab */
        .gauge-tab {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .gauge-container {
          display: flex;
          justify-content: center;
          padding: 16px 0;
        }

        .gauge-svg {
          width: 180px;
          height: 180px;
        }

        .gauge-ring {
          transition: stroke-dashoffset 0.6s ease;
        }

        .cache-info {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 10px;
          padding: 16px;
        }

        .cache-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .cache-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .cache-label {
          font-size: 12px;
          color: var(--loki-text-muted);
        }

        .cache-value {
          font-size: 14px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-primary);
        }

        /* Timeline Tab */
        .timeline-tab {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .timeline-header-row {
          display: grid;
          grid-template-columns: 48px 1fr 72px 72px;
          gap: 8px;
          align-items: center;
          padding: 6px 8px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
          border-bottom: 1px solid var(--loki-border);
          margin-bottom: 4px;
        }

        .timeline-row {
          display: grid;
          grid-template-columns: 48px 1fr 72px 72px;
          gap: 8px;
          align-items: center;
          padding: 6px 8px;
          border-radius: 6px;
          transition: background 0.15s;
        }

        .timeline-row:hover {
          background: var(--loki-bg-hover);
        }

        .timeline-row.compacted {
          border: 1px dashed var(--loki-yellow);
          background: rgba(234, 179, 8, 0.04);
        }

        .timeline-iter {
          font-size: 12px;
          font-weight: 500;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-secondary);
        }

        .timeline-bar-container {
          height: 16px;
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          overflow: hidden;
        }

        .timeline-bar {
          height: 100%;
          background: var(--loki-accent);
          border-radius: 4px;
          min-width: 2px;
          transition: width 0.3s ease;
        }

        .timeline-tokens {
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-primary);
          text-align: right;
        }

        .timeline-cost {
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
          text-align: right;
        }

        .timeline-compaction-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 0;
          margin: 4px 0;
        }

        .compaction-line {
          flex: 1;
          height: 1px;
          background: var(--loki-yellow);
          opacity: 0.5;
        }

        .compaction-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-yellow);
          white-space: nowrap;
        }

        /* Breakdown Tab */
        .breakdown-tab {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .breakdown-legend {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 8px;
          padding: 10px 12px;
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 8px;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--loki-text-secondary);
        }

        .legend-swatch {
          width: 12px;
          height: 12px;
          border-radius: 3px;
          flex-shrink: 0;
        }

        .swatch-input { background: var(--loki-accent); }
        .swatch-output { background: var(--loki-green); }
        .swatch-cache-read { background: var(--loki-blue, #3b82f6); }
        .swatch-cache-create { background: var(--loki-yellow); }

        .breakdown-row {
          display: grid;
          grid-template-columns: 48px 1fr 72px;
          gap: 8px;
          align-items: center;
          padding: 6px 8px;
          border-radius: 6px;
          transition: background 0.15s;
        }

        .breakdown-row:hover {
          background: var(--loki-bg-hover);
        }

        .breakdown-iter {
          font-size: 12px;
          font-weight: 500;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-secondary);
        }

        .breakdown-bar-container {
          display: flex;
          height: 16px;
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          overflow: hidden;
        }

        .breakdown-bar {
          height: 100%;
          min-width: 0;
          transition: width 0.3s ease;
        }

        .bar-input { background: var(--loki-accent); }
        .bar-output { background: var(--loki-green); }
        .bar-cache-read { background: var(--loki-blue, #3b82f6); }
        .bar-cache-create { background: var(--loki-yellow); }

        .breakdown-cost {
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
          text-align: right;
        }

        /* Empty / Offline states */
        .empty-state {
          text-align: center;
          padding: 32px 20px;
          color: var(--loki-text-muted);
          font-size: 13px;
          font-style: italic;
        }

        .offline-notice {
          text-align: center;
          padding: 20px;
          color: var(--loki-text-muted);
          font-size: 12px;
        }
      </style>

      <div class="context-container">
        ${!this._connected ? `
          <div class="offline-notice">Connecting to context API...</div>
        ` : ''}

        <div class="tabs">
          <button class="tab ${this._activeTab === 'gauge' ? 'active' : ''}" data-tab="gauge">Gauge</button>
          <button class="tab ${this._activeTab === 'timeline' ? 'active' : ''}" data-tab="timeline">Timeline</button>
          <button class="tab ${this._activeTab === 'breakdown' ? 'active' : ''}" data-tab="breakdown">Breakdown</button>
        </div>

        ${tabContent}
      </div>
    `;

    // Attach tab click listeners
    this.shadowRoot.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setTab(btn.dataset.tab);
      });
    });
  }
}

// Register the component
if (!customElements.get('loki-context-tracker')) {
  customElements.define('loki-context-tracker', LokiContextTracker);
}

export default LokiContextTracker;
