/**
 * @fileoverview Loki Analytics Dashboard - cross-provider analytics with
 * activity heatmap, tool usage breakdown, velocity metrics, and provider
 * comparison. Uses existing API endpoints with client-side aggregation.
 * No chart libraries - pure CSS visualizations.
 *
 * @example
 * <loki-analytics api-url="http://localhost:57374"></loki-analytics>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** Map model name fragments to provider */
const MODEL_TO_PROVIDER = {
  opus: 'claude', sonnet: 'claude', haiku: 'claude', claude: 'claude',
  'gpt': 'codex', codex: 'codex',
  gemini: 'gemini',
};

function classifyProvider(modelName) {
  const lower = (modelName || '').toLowerCase();
  for (const [key, provider] of Object.entries(MODEL_TO_PROVIDER)) {
    if (lower.includes(key)) return provider;
  }
  return 'unknown';
}

/**
 * @class LokiAnalytics
 * @extends LokiElement
 */
export class LokiAnalytics extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._api = null;
    this._pollInterval = null;
    this._activeTab = 'heatmap';
    this._activity = [];
    this._tools = [];
    this._cost = {};
    this._context = {};
    this._trends = [];
    this._toolTimeRange = '7d';
    this._connected = false;
    this._loading = false;
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
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _fetchActivity() {
    const baseUrl = this._api.baseUrl || window.location.origin;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(`${baseUrl}/api/activity?limit=1000`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`Activity API ${resp.status}`);
      return resp.json();
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  async _loadData() {
    if (!this.isConnected || this._loading) return;
    this._loading = true;

    try {
      const results = await Promise.allSettled([
        this._fetchActivity(),
        this._api.getToolEfficiency(50),
        this._api.getCost(),
        this._api.getContext(),
        this._api.getLearningTrends({ timeRange: this._toolTimeRange }),
      ]);

      if (results[0].status === 'fulfilled') this._activity = results[0].value || [];
      if (results[1].status === 'fulfilled') this._tools = results[1].value || [];
      if (results[2].status === 'fulfilled') this._cost = results[2].value || {};
      if (results[3].status === 'fulfilled') this._context = results[3].value || {};
      if (results[4].status === 'fulfilled') {
        const trendsRaw = results[4].value || {};
        this._trends = Array.isArray(trendsRaw) ? trendsRaw : (trendsRaw.dataPoints || []);
      }

      this._connected = results.some(r => r.status === 'fulfilled');
      this.render();
    } finally {
      this._loading = false;
    }
  }

  _startPolling() {
    this._pollInterval = setInterval(() => this._loadData(), 30000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
      } else if (!this._pollInterval) {
        this._loadData();
        this._pollInterval = setInterval(() => this._loadData(), 30000);
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  _stopPolling() {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  // --- Heatmap computation ---

  _computeHeatmap() {
    const counts = {};
    const items = Array.isArray(this._activity) ? this._activity : [];

    for (const entry of items) {
      const ts = entry.timestamp || entry.ts || entry.created_at;
      if (!ts) continue;
      const d = new Date(ts);
      if (isNaN(d.getTime())) continue;
      const key = this._localDateKey(d);
      counts[key] = (counts[key] || 0) + 1;
    }

    // Build 52-week grid ending today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay(); // 0=Sun
    const endDate = new Date(today);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

    const cells = [];
    const current = new Date(startDate);
    let maxCount = 0;
    while (current <= endDate) {
      const key = this._localDateKey(current);
      const count = counts[key] || 0;
      if (count > maxCount) maxCount = count;
      cells.push({ date: key, count, day: current.getDay() });
      current.setDate(current.getDate() + 1);
    }

    return { cells, maxCount };
  }

  _getHeatmapLevel(count, maxCount) {
    if (count === 0 || maxCount === 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.50) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  _renderHeatmap() {
    const { cells, maxCount } = this._computeHeatmap();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

    // Compute month label positions (place at the week containing month's first day)
    const monthPositions = [];
    let lastMonth = -1;
    let weekCol = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].day === 0) weekCol++;
      const month = new Date(cells[i].date).getMonth();
      if (month !== lastMonth) {
        monthPositions.push({ month: months[month], col: Math.max(weekCol, 1) });
        lastMonth = month;
      }
    }

    const monthLabelsHTML = monthPositions.map(m =>
      `<span class="heatmap-month" style="grid-column: ${m.col}">${m.month}</span>`
    ).join('');

    const cellsHTML = cells.map(c => {
      const level = this._getHeatmapLevel(c.count, maxCount);
      return `<div class="heatmap-cell level-${level}" title="${c.date}: ${c.count} activities"></div>`;
    }).join('');

    const dayLabelsHTML = dayLabels.map(d =>
      `<span class="heatmap-day-label">${d}</span>`
    ).join('');

    return `
      <div class="heatmap-container">
        <div class="heatmap-months">${monthLabelsHTML}</div>
        <div class="heatmap-body">
          <div class="heatmap-day-labels">${dayLabelsHTML}</div>
          <div class="heatmap-grid">${cellsHTML}</div>
        </div>
        <div class="heatmap-legend">
          <span class="heatmap-legend-label">Less</span>
          <div class="heatmap-cell level-0"></div>
          <div class="heatmap-cell level-1"></div>
          <div class="heatmap-cell level-2"></div>
          <div class="heatmap-cell level-3"></div>
          <div class="heatmap-cell level-4"></div>
          <span class="heatmap-legend-label">More</span>
        </div>
      </div>
    `;
  }

  // --- Tool usage computation ---

  _computeToolUsage() {
    const tools = Array.isArray(this._tools) ? this._tools : [];
    // Aggregate by tool name
    const byName = {};
    for (const t of tools) {
      const name = t.tool || t.name || t.tool_name || (t.data && t.data.tool_name) || 'unknown';
      const count = t.count ?? t.calls ?? t.frequency ?? (t.data && t.data.count) ?? 1;
      byName[name] = (byName[name] || 0) + count;
    }

    return Object.entries(byName)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
  }

  _renderToolUsage() {
    const tools = this._computeToolUsage();
    const maxCount = tools.length > 0 ? tools[0][1] : 0;

    if (tools.length === 0) {
      return '<div class="empty-state">No tool usage data available</div>';
    }

    const barsHTML = tools.map(([name, count]) => {
      const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
      return `
        <div class="tool-row">
          <span class="tool-name" title="${this._esc(name)}">${this._esc(name)}</span>
          <div class="tool-bar-track">
            <div class="tool-bar-fill" style="width: ${pct.toFixed(1)}%"></div>
          </div>
          <span class="tool-count">${count}</span>
        </div>
      `;
    }).join('');

    return '<div class="tool-bars">' + barsHTML + '</div>';
  }

  // --- Velocity computation ---

  _computeVelocity() {
    const ctx = this._context || {};
    const iterations = ctx.per_iteration || ctx.iterations || [];
    const totalIterations = Array.isArray(iterations) && iterations.length > 0
      ? iterations.length
      : ((ctx.totals && ctx.totals.iterations_tracked) || ctx.total_iterations || 0);

    // Calculate iterations/hour from timestamps
    let iterPerHour = 0;
    if (Array.isArray(iterations) && iterations.length >= 2) {
      const timestamps = iterations
        .map(it => new Date(it.timestamp || it.started_at || it.ts).getTime())
        .filter(t => !isNaN(t))
        .sort((a, b) => a - b);

      if (timestamps.length >= 2) {
        const spanHours = (timestamps[timestamps.length - 1] - timestamps[0]) / 3600000;
        if (spanHours > 0) {
          iterPerHour = Math.max(timestamps.length - 1, 1) / spanHours;
        }
      }
    }

    // Build hourly sparkline from trends or iterations
    const hourlyBuckets = [];
    const trendData = Array.isArray(this._trends) ? this._trends : [];

    if (trendData.length > 0) {
      for (const bucket of trendData.slice(-24)) {
        hourlyBuckets.push(bucket.count ?? bucket.value ?? 0);
      }
    } else if (Array.isArray(iterations) && iterations.length > 0) {
      // Bucket by hour
      const bucketMap = {};
      for (const it of iterations) {
        const ts = it.timestamp || it.started_at || it.ts;
        if (!ts) continue;
        const d = new Date(ts);
        const hourKey = d.toISOString().slice(0, 13);
        bucketMap[hourKey] = (bucketMap[hourKey] || 0) + 1;
      }
      const keys = Object.keys(bucketMap).sort().slice(-24);
      for (const k of keys) hourlyBuckets.push(bucketMap[k]);
    }

    return { iterPerHour, totalIterations, hourlyBuckets };
  }

  _renderVelocity() {
    const { iterPerHour, totalIterations, hourlyBuckets } = this._computeVelocity();

    const maxBucket = Math.max(1, ...hourlyBuckets);
    const sparkBars = hourlyBuckets.length > 0
      ? hourlyBuckets.map(v => {
          const pct = (v / maxBucket) * 100;
          return `<div class="spark-bar" style="height: ${Math.max(2, pct)}%" title="${v}"></div>`;
        }).join('')
      : '<div class="empty-state" style="padding: 12px">No trend data</div>';

    const trendFilterHTML = `
      <div class="tool-filter">
        <select class="tool-time-select" id="tool-time-range">
          <option value="1h" ${this._toolTimeRange === '1h' ? 'selected' : ''}>Trend: Last hour</option>
          <option value="24h" ${this._toolTimeRange === '24h' ? 'selected' : ''}>Trend: Last 24h</option>
          <option value="7d" ${this._toolTimeRange === '7d' ? 'selected' : ''}>Trend: Last 7 days</option>
          <option value="30d" ${this._toolTimeRange === '30d' ? 'selected' : ''}>Trend: Last 30 days</option>
        </select>
      </div>
    `;

    return `
      ${trendFilterHTML}
      <div class="velocity-cards">
        <div class="velocity-card">
          <div class="velocity-label">Iterations / Hour</div>
          <div class="velocity-value">${iterPerHour.toFixed(1)}</div>
        </div>
        <div class="velocity-card">
          <div class="velocity-label">Total Iterations</div>
          <div class="velocity-value">${totalIterations}</div>
        </div>
      </div>
      <div class="sparkline-container">
        <div class="sparkline-label">Activity Trend (hourly)</div>
        <div class="sparkline">${sparkBars}</div>
      </div>
    `;
  }

  // --- Provider comparison ---

  _computeProviders() {
    const byModel = this._cost.by_model || {};
    const providers = {};

    for (const [model, data] of Object.entries(byModel)) {
      const prov = classifyProvider(model);
      if (!providers[prov]) {
        providers[prov] = { cost: 0, tokens: 0, iterations: 0, models: [] };
      }
      const cost = data.cost_usd || 0;
      const tokens = (data.input_tokens || 0) + (data.output_tokens || 0);
      providers[prov].cost += cost;
      providers[prov].tokens += tokens;
      providers[prov].models.push(model);
    }

    // Estimate iterations from context
    const totals = this._context.totals || {};
    const totalIter = totals.iterations_tracked || this._context.total_iterations || this._context.iteration || 0;
    const totalCost = this._cost.estimated_cost_usd || 0;

    for (const prov of Object.values(providers)) {
      if (totalCost > 0 && totalIter > 0) {
        const costShare = prov.cost / totalCost;
        prov.iterations = Math.round(costShare * totalIter);
      }
    }

    return providers;
  }

  _renderProviders() {
    const providers = this._computeProviders();
    const providerConfig = {
      claude: { label: 'Claude', color: 'var(--loki-accent)' },
      codex: { label: 'Codex', color: 'var(--loki-success)' },
      gemini: { label: 'Gemini', color: 'var(--loki-info)' },
      unknown: { label: 'Other', color: 'var(--loki-text-muted)' },
    };

    const entries = Object.entries(providers);
    if (entries.length === 0) {
      return '<div class="empty-state">No provider data available. Start a session to see cross-provider comparison.</div>';
    }

    return `
      <div class="provider-grid">
        ${entries.map(([key, data]) => {
          const cfg = providerConfig[key] || providerConfig.unknown;
          const costPerIter = data.iterations > 0 ? (data.cost / data.iterations).toFixed(4) : '--';
          const tokensPerIter = data.iterations > 0 ? Math.round(data.tokens / data.iterations).toLocaleString() : '--';

          return `
            <div class="provider-card">
              <div class="provider-accent" style="background: ${cfg.color}"></div>
              <div class="provider-body">
                <div class="provider-name">${cfg.label}</div>
                <div class="provider-stat">
                  <span class="provider-stat-label">Total Cost</span>
                  <span class="provider-stat-value">${data.cost > 0 ? '$' + data.cost.toFixed(2) : '$0.00'}</span>
                </div>
                <div class="provider-stat">
                  <span class="provider-stat-label">Cost / Iteration</span>
                  <span class="provider-stat-value">${costPerIter !== '--' ? '$' + costPerIter : costPerIter}</span>
                </div>
                <div class="provider-stat">
                  <span class="provider-stat-label">Tokens / Iteration</span>
                  <span class="provider-stat-value">${tokensPerIter}</span>
                </div>
                <div class="provider-stat">
                  <span class="provider-stat-label">Total Tokens</span>
                  <span class="provider-stat-value">${data.tokens.toLocaleString()}</span>
                </div>
                <div class="provider-models">${data.models.map(m => this._esc(m)).join(', ')}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  _localDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _handleTabClick(e) {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    this._activeTab = tab.dataset.tab;
    this.render();
  }

  _handleTimeRangeChange(e) {
    this._toolTimeRange = e.target.value;
    this._loadData();
  }

  render() {
    const tabs = [
      { id: 'heatmap', label: 'Activity', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
      { id: 'tools', label: 'Tools', icon: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>' },
      { id: 'velocity', label: 'Velocity', icon: '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' },
      { id: 'providers', label: 'Providers', icon: '<svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' },
    ];

    let content = '';
    switch (this._activeTab) {
      case 'heatmap': content = this._renderHeatmap(); break;
      case 'tools': content = this._renderToolUsage(); break;
      case 'velocity': content = this._renderVelocity(); break;
      case 'providers': content = this._renderProviders(); break;
    }

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host { display: block; }

        .analytics-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Tab bar */
        .tab-bar {
          display: flex;
          gap: 2px;
          background: var(--loki-bg-secondary);
          border-radius: 8px;
          padding: 3px;
        }

        .tab-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--loki-text-muted);
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .tab-btn:hover {
          color: var(--loki-text-primary);
          background: var(--loki-bg-hover);
        }

        .tab-btn.active {
          color: var(--loki-accent);
          background: var(--loki-bg-card);
          box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }

        .tab-btn svg {
          width: 14px;
          height: 14px;
          stroke: currentColor;
          stroke-width: 2;
          fill: none;
          flex-shrink: 0;
        }

        .tab-content {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 8px;
          padding: 20px;
          min-height: 200px;
        }

        .empty-state {
          text-align: center;
          padding: 32px 16px;
          color: var(--loki-text-muted);
          font-size: 13px;
        }

        .offline-notice {
          text-align: center;
          padding: 20px;
          color: var(--loki-text-muted);
          font-size: 12px;
        }

        /* ---------- Heatmap ---------- */
        .heatmap-container {
          overflow-x: auto;
        }

        .heatmap-months {
          display: grid;
          grid-auto-flow: column;
          grid-auto-columns: 14px;
          gap: 2px;
          margin-left: 34px;
          margin-bottom: 4px;
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .heatmap-body {
          display: flex;
          gap: 4px;
        }

        .heatmap-day-labels {
          display: grid;
          grid-template-rows: repeat(7, 14px);
          gap: 2px;
          font-size: 10px;
          color: var(--loki-text-muted);
          line-height: 14px;
          text-align: right;
          width: 30px;
          flex-shrink: 0;
        }

        .heatmap-grid {
          display: grid;
          grid-template-rows: repeat(7, 14px);
          grid-auto-flow: column;
          grid-auto-columns: 14px;
          gap: 2px;
        }

        .heatmap-cell {
          width: 12px;
          height: 12px;
          border-radius: 2px;
          transition: opacity 0.15s;
        }

        .heatmap-cell.level-0 { background: var(--loki-bg-tertiary); }
        .heatmap-cell.level-1 { background: var(--loki-accent); opacity: 0.25; }
        .heatmap-cell.level-2 { background: var(--loki-accent); opacity: 0.50; }
        .heatmap-cell.level-3 { background: var(--loki-accent); opacity: 0.75; }
        .heatmap-cell.level-4 { background: var(--loki-accent); opacity: 1.0; }

        .heatmap-legend {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-top: 10px;
          margin-left: 34px;
        }

        .heatmap-legend .heatmap-cell {
          width: 12px;
          height: 12px;
        }

        .heatmap-legend-label {
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        /* ---------- Tool Usage ---------- */
        .tool-filter {
          margin-bottom: 12px;
        }

        .tool-time-select {
          padding: 5px 10px;
          background: var(--loki-bg-tertiary);
          border: 1px solid var(--loki-border);
          border-radius: 6px;
          font-size: 12px;
          font-family: inherit;
          color: var(--loki-text-primary);
          cursor: pointer;
        }

        .tool-bars {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .tool-row {
          display: grid;
          grid-template-columns: 140px 1fr 50px;
          align-items: center;
          gap: 10px;
        }

        .tool-name {
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tool-bar-track {
          height: 8px;
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          overflow: hidden;
        }

        .tool-bar-fill {
          height: 100%;
          background: var(--loki-accent);
          border-radius: 4px;
          transition: width 0.3s ease;
        }

        .tool-count {
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-muted);
          text-align: right;
        }

        /* ---------- Velocity ---------- */
        .velocity-cards {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
          margin-bottom: 16px;
        }

        .velocity-card {
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border-light);
          border-radius: 6px;
          padding: 16px;
        }

        .velocity-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
          margin-bottom: 6px;
        }

        .velocity-value {
          font-size: 28px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
          line-height: 1.2;
        }

        .sparkline-container {
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border-light);
          border-radius: 6px;
          padding: 16px;
        }

        .sparkline-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
          margin-bottom: 10px;
        }

        .sparkline {
          display: flex;
          align-items: flex-end;
          gap: 2px;
          height: 60px;
        }

        .spark-bar {
          flex: 1;
          min-width: 4px;
          background: var(--loki-accent);
          border-radius: 2px 2px 0 0;
          opacity: 0.7;
          transition: opacity 0.15s;
        }

        .spark-bar:hover {
          opacity: 1;
        }

        /* ---------- Provider Comparison ---------- */
        .provider-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
        }

        .provider-card {
          background: var(--loki-glass-bg);
          backdrop-filter: blur(12px) saturate(1.3);
          -webkit-backdrop-filter: blur(12px) saturate(1.3);
          border: 1px solid var(--loki-glass-border);
          border-radius: 8px;
          overflow: hidden;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }

        .provider-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--loki-glass-shadow, 0 4px 24px rgba(0, 0, 0, 0.15));
        }

        .provider-accent {
          height: 3px;
          width: 100%;
        }

        .provider-body {
          padding: 16px;
        }

        .provider-name {
          font-size: 16px;
          font-weight: 600;
          color: var(--loki-text-primary);
          margin-bottom: 12px;
        }

        .provider-stat {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 4px 0;
        }

        .provider-stat-label {
          font-size: 11px;
          color: var(--loki-text-muted);
        }

        .provider-stat-value {
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
          font-weight: 500;
          color: var(--loki-text-primary);
        }

        .provider-models {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid var(--loki-border-light);
          font-size: 10px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-muted);
        }

        @media (max-width: 600px) {
          .tool-row {
            grid-template-columns: 100px 1fr 40px;
          }
          .velocity-cards {
            grid-template-columns: 1fr;
          }
          .tab-btn span { display: none; }
        }
      </style>

      <div class="analytics-container">
        ${!this._connected ? '<div class="offline-notice">Connecting to analytics API...</div>' : ''}

        <div class="tab-bar">
          ${tabs.map(t => `
            <button class="tab-btn ${this._activeTab === t.id ? 'active' : ''}" data-tab="${t.id}" aria-label="${t.label}">
              ${t.icon}<span>${t.label}</span>
            </button>
          `).join('')}
        </div>

        <div class="tab-content">
          ${content}
        </div>
      </div>
    `;

    // Bind event listeners
    this.shadowRoot.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', (e) => this._handleTabClick(e));
    });

    const timeSelect = this.shadowRoot.getElementById('tool-time-range');
    if (timeSelect) {
      timeSelect.addEventListener('change', (e) => this._handleTimeRangeChange(e));
    }
  }
}

if (!customElements.get('loki-analytics')) {
  customElements.define('loki-analytics', LokiAnalytics);
}

export default LokiAnalytics;
