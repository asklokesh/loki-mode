/**
 * @fileoverview Loki Learning Dashboard Component - visualizes learning
 * metrics from the cross-tool learning system. Displays signal summaries,
 * trend charts, pattern/preference/tool-efficiency lists, and recent signal
 * activity. Supports time-range, signal-type, and source filtering.
 *
 * @example
 * <loki-learning-dashboard api-url="http://localhost:57374" theme="dark" time-range="7d"></loki-learning-dashboard>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Array<{id: string, label: string, hours: number}>} Available time range filter options */
const TIME_RANGES = [
  { id: '1h', label: '1 Hour', hours: 1 },
  { id: '24h', label: '24 Hours', hours: 24 },
  { id: '7d', label: '7 Days', hours: 168 },
  { id: '30d', label: '30 Days', hours: 720 },
];

const SIGNAL_TYPES = [
  { id: 'all', label: 'All Signals' },
  { id: 'user_preference', label: 'User Preferences' },
  { id: 'error_pattern', label: 'Error Patterns' },
  { id: 'success_pattern', label: 'Success Patterns' },
  { id: 'tool_efficiency', label: 'Tool Efficiency' },
  { id: 'context_relevance', label: 'Context Relevance' },
];

const SIGNAL_SOURCES = [
  { id: 'all', label: 'All Sources' },
  { id: 'cli', label: 'CLI' },
  { id: 'api', label: 'API' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'mcp', label: 'MCP' },
  { id: 'dashboard', label: 'Dashboard' },
];

/**
 * @class LokiLearningDashboard
 * @extends LokiElement
 * @fires metric-select - When a metric list item is clicked
 * @fires filter-change - When any filter dropdown value changes
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 * @property {string} time-range - Time range filter ('1h'|'24h'|'7d'|'30d', default: '7d')
 * @property {string} signal-type - Signal type filter (default: 'all')
 * @property {string} source - Signal source filter (default: 'all')
 */
export class LokiLearningDashboard extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme', 'time-range', 'signal-type', 'source'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;

    // Filters
    this._timeRange = '7d';
    this._signalType = 'all';
    this._source = 'all';

    // Data
    this._metrics = null;
    this._trends = null;
    this._signals = [];
    this._selectedMetric = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._timeRange = this.getAttribute('time-range') || '7d';
    this._signalType = this.getAttribute('signal-type') || 'all';
    this._source = this.getAttribute('source') || 'all';
    this._setupApi();
    this._loadData();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    switch (name) {
      case 'api-url':
        if (this._api) {
          this._api.baseUrl = newValue;
          this._loadData();
        }
        break;
      case 'theme':
        this._applyTheme();
        break;
      case 'time-range':
        this._timeRange = newValue;
        this._loadData();
        break;
      case 'signal-type':
        this._signalType = newValue;
        this._loadData();
        break;
      case 'source':
        this._source = newValue;
        this._loadData();
        break;
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _loadData() {
    this._loading = true;
    this._error = null;
    this.render();

    try {
      const params = {
        timeRange: this._timeRange,
        signalType: this._signalType !== 'all' ? this._signalType : undefined,
        source: this._source !== 'all' ? this._source : undefined,
      };

      // Load metrics and trends in parallel
      const [metricsRes, trendsRes, signalsRes] = await Promise.all([
        this._api.getLearningMetrics(params).catch(() => null),
        this._api.getLearningTrends(params).catch(() => null),
        this._api.getLearningSignals({ ...params, limit: 50 }).catch(() => []),
      ]);

      this._metrics = metricsRes;
      this._trends = trendsRes;
      this._signals = signalsRes || [];
    } catch (error) {
      this._error = error.message || 'Failed to load learning data';
    }

    this._loading = false;
    this.render();
  }

  _setFilter(filterType, value) {
    switch (filterType) {
      case 'timeRange':
        this._timeRange = value;
        this.setAttribute('time-range', value);
        break;
      case 'signalType':
        this._signalType = value;
        this.setAttribute('signal-type', value);
        break;
      case 'source':
        this._source = value;
        this.setAttribute('source', value);
        break;
    }

    this.dispatchEvent(new CustomEvent('filter-change', {
      detail: {
        timeRange: this._timeRange,
        signalType: this._signalType,
        source: this._source,
      },
    }));

    this._loadData();
  }

  _selectMetric(type, item) {
    this._selectedMetric = { type, item };
    this.dispatchEvent(new CustomEvent('metric-select', { detail: { type, item } }));
    this.render();
  }

  _closeDetail() {
    this._selectedMetric = null;
    this.render();
  }

  _formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num?.toString() || '0';
  }

  _formatPercent(num) {
    return (num * 100).toFixed(1) + '%';
  }

  _formatDuration(seconds) {
    if (seconds < 60) return seconds.toFixed(0) + 's';
    if (seconds < 3600) return (seconds / 60).toFixed(1) + 'm';
    return (seconds / 3600).toFixed(1) + 'h';
  }

  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _renderFilters() {
    return `
      <div class="filters">
        <div class="filter-group">
          <label>Time Range</label>
          <select id="time-range-select" class="filter-select">
            ${TIME_RANGES.map(t => `
              <option value="${t.id}" ${this._timeRange === t.id ? 'selected' : ''}>${t.label}</option>
            `).join('')}
          </select>
        </div>
        <div class="filter-group">
          <label>Signal Type</label>
          <select id="signal-type-select" class="filter-select">
            ${SIGNAL_TYPES.map(t => `
              <option value="${t.id}" ${this._signalType === t.id ? 'selected' : ''}>${t.label}</option>
            `).join('')}
          </select>
        </div>
        <div class="filter-group">
          <label>Source</label>
          <select id="source-select" class="filter-select">
            ${SIGNAL_SOURCES.map(s => `
              <option value="${s.id}" ${this._source === s.id ? 'selected' : ''}>${s.label}</option>
            `).join('')}
          </select>
        </div>
        <button class="btn btn-secondary" id="refresh-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg>
          Refresh
        </button>
      </div>
    `;
  }

  _renderSummaryCards() {
    if (!this._metrics) {
      return '<div class="empty-state">No metrics available</div>';
    }

    const { totalSignals, signalsByType, signalsBySource, aggregation } = this._metrics;

    return `
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Total Signals</span>
            <span class="summary-card-count">${this._formatNumber(totalSignals || 0)}</span>
          </div>
          <div class="summary-card-detail">Learning signals collected</div>
          <div class="signal-breakdown">
            ${Object.entries(signalsByType || {}).map(([type, count]) => `
              <div class="breakdown-item">
                <span class="breakdown-label">${type.replace('_', ' ')}</span>
                <span class="breakdown-value">${this._formatNumber(count)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Sources</span>
            <span class="summary-card-count">${Object.keys(signalsBySource || {}).length}</span>
          </div>
          <div class="summary-card-detail">Signal sources active</div>
          <div class="signal-breakdown">
            ${Object.entries(signalsBySource || {}).map(([source, count]) => `
              <div class="breakdown-item">
                <span class="breakdown-label source-badge ${source}">${source}</span>
                <span class="breakdown-value">${this._formatNumber(count)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Patterns Found</span>
            <span class="summary-card-count">${this._formatNumber(
              (aggregation?.preferences?.length || 0) +
              (aggregation?.error_patterns?.length || 0) +
              (aggregation?.success_patterns?.length || 0)
            )}</span>
          </div>
          <div class="summary-card-detail">Aggregated learnings</div>
          <div class="pattern-counts">
            <div class="pattern-count">
              <span class="pattern-icon preferences">P</span>
              <span>${aggregation?.preferences?.length || 0} Preferences</span>
            </div>
            <div class="pattern-count">
              <span class="pattern-icon errors">E</span>
              <span>${aggregation?.error_patterns?.length || 0} Errors</span>
            </div>
            <div class="pattern-count">
              <span class="pattern-icon success">S</span>
              <span>${aggregation?.success_patterns?.length || 0} Success</span>
            </div>
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Avg Confidence</span>
            <span class="summary-card-count confidence-high">
              ${this._formatPercent(this._metrics.avgConfidence || 0)}
            </span>
          </div>
          <div class="summary-card-detail">Signal reliability</div>
          <div class="confidence-bar">
            <div class="confidence-fill" style="width: ${(this._metrics.avgConfidence || 0) * 100}%"></div>
          </div>
        </div>
      </div>
    `;
  }

  _renderTrendChart() {
    if (!this._trends || !this._trends.dataPoints || this._trends.dataPoints.length === 0) {
      return '<div class="chart-empty">No trend data available</div>';
    }

    const { dataPoints, maxValue } = this._trends;
    const chartHeight = 120;
    const chartWidth = 400;
    const padding = 20;

    // Create SVG path for the trend line
    const points = dataPoints.map((point, i) => {
      const x = padding + (i / (dataPoints.length - 1 || 1)) * (chartWidth - padding * 2);
      const y = chartHeight - padding - ((point.count / (maxValue || 1)) * (chartHeight - padding * 2));
      return `${x},${y}`;
    }).join(' ');

    // Create area fill
    const areaPoints = `${padding},${chartHeight - padding} ${points} ${chartWidth - padding},${chartHeight - padding}`;

    return `
      <div class="trend-chart">
        <div class="chart-header">
          <span class="chart-title">Signal Volume Over Time</span>
          <span class="chart-subtitle">${this._trends.period}</span>
        </div>
        <svg class="chart-svg" viewBox="0 0 ${chartWidth} ${chartHeight}">
          <!-- Grid lines -->
          <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${chartHeight - padding}" stroke="var(--loki-border)" stroke-width="1"/>
          <line x1="${padding}" y1="${chartHeight - padding}" x2="${chartWidth - padding}" y2="${chartHeight - padding}" stroke="var(--loki-border)" stroke-width="1"/>

          <!-- Area fill -->
          <polygon points="${areaPoints}" fill="var(--loki-accent-muted)" />

          <!-- Trend line -->
          <polyline points="${points}" fill="none" stroke="var(--loki-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>

          <!-- Data points -->
          ${dataPoints.map((point, i) => {
            const x = padding + (i / (dataPoints.length - 1 || 1)) * (chartWidth - padding * 2);
            const y = chartHeight - padding - ((point.count / (maxValue || 1)) * (chartHeight - padding * 2));
            return `<circle cx="${x}" cy="${y}" r="3" fill="var(--loki-accent)" />`;
          }).join('')}
        </svg>
        <div class="chart-labels">
          ${dataPoints.length > 0 ? `
            <span class="chart-label-start">${dataPoints[0].label}</span>
            <span class="chart-label-end">${dataPoints[dataPoints.length - 1].label}</span>
          ` : ''}
        </div>
      </div>
    `;
  }

  _renderTopLists() {
    if (!this._metrics?.aggregation) {
      return '';
    }

    const { preferences, error_patterns, success_patterns, tool_efficiencies } = this._metrics.aggregation;

    return `
      <div class="top-lists">
        <!-- User Preferences -->
        <div class="top-list">
          <div class="list-header">
            <span class="list-title">Top User Preferences</span>
            <span class="list-count">${preferences?.length || 0}</span>
          </div>
          <div class="list-items" role="list">
            ${(preferences || []).slice(0, 5).map(p => `
              <div class="list-item" data-type="preference" data-id="${p.preference_key}" tabindex="0" role="listitem">
                <div class="item-main">
                  <span class="item-key">${this._escapeHtml(p.preference_key)}</span>
                  <span class="item-value">${this._escapeHtml(String(p.preferred_value))}</span>
                </div>
                <div class="item-meta">
                  <span class="item-freq">${p.frequency}x</span>
                  <span class="item-conf">${this._formatPercent(p.confidence)}</span>
                </div>
              </div>
            `).join('') || '<div class="list-empty">No preferences found</div>'}
          </div>
        </div>

        <!-- Error Patterns -->
        <div class="top-list">
          <div class="list-header">
            <span class="list-title">Common Error Patterns</span>
            <span class="list-count">${error_patterns?.length || 0}</span>
          </div>
          <div class="list-items" role="list">
            ${(error_patterns || []).slice(0, 5).map(e => `
              <div class="list-item error-item" data-type="error_pattern" data-id="${e.error_type}" tabindex="0" role="listitem">
                <div class="item-main">
                  <span class="item-key">${this._escapeHtml(e.error_type)}</span>
                  <span class="resolution-rate ${e.resolution_rate > 0.5 ? 'good' : 'poor'}">${this._formatPercent(e.resolution_rate)} resolved</span>
                </div>
                <div class="item-meta">
                  <span class="item-freq">${e.frequency}x</span>
                  <span class="item-conf">${this._formatPercent(e.confidence)}</span>
                </div>
              </div>
            `).join('') || '<div class="list-empty">No error patterns found</div>'}
          </div>
        </div>

        <!-- Success Patterns -->
        <div class="top-list">
          <div class="list-header">
            <span class="list-title">Success Patterns</span>
            <span class="list-count">${success_patterns?.length || 0}</span>
          </div>
          <div class="list-items" role="list">
            ${(success_patterns || []).slice(0, 5).map(s => `
              <div class="list-item success-item" data-type="success_pattern" data-id="${s.pattern_name}" tabindex="0" role="listitem">
                <div class="item-main">
                  <span class="item-key">${this._escapeHtml(s.pattern_name)}</span>
                  <span class="item-duration">${this._formatDuration(s.avg_duration_seconds)}</span>
                </div>
                <div class="item-meta">
                  <span class="item-freq">${s.frequency}x</span>
                  <span class="item-conf">${this._formatPercent(s.confidence)}</span>
                </div>
              </div>
            `).join('') || '<div class="list-empty">No success patterns found</div>'}
          </div>
        </div>

        <!-- Tool Efficiency -->
        <div class="top-list">
          <div class="list-header">
            <span class="list-title">Tool Efficiency Rankings</span>
            <span class="list-count">${tool_efficiencies?.length || 0}</span>
          </div>
          <div class="list-items" role="list">
            ${(tool_efficiencies || []).slice(0, 5).map((t, i) => `
              <div class="list-item tool-item" data-type="tool_efficiency" data-id="${t.tool_name}" tabindex="0" role="listitem">
                <div class="item-rank">#${i + 1}</div>
                <div class="item-main">
                  <span class="item-key">${this._escapeHtml(t.tool_name)}</span>
                  <span class="efficiency-score">${(t.efficiency_score * 100).toFixed(0)}</span>
                </div>
                <div class="item-meta">
                  <span class="success-rate ${t.success_rate > 0.8 ? 'good' : ''}">${this._formatPercent(t.success_rate)}</span>
                  <span class="item-time">${Number(t.avg_execution_time_ms ?? 0).toFixed(0)}ms</span>
                </div>
              </div>
            `).join('') || '<div class="list-empty">No tool data found</div>'}
          </div>
        </div>
      </div>
    `;
  }

  _renderRecentSignals() {
    if (!this._signals || this._signals.length === 0) {
      return '<div class="signals-empty">No recent signals</div>';
    }

    return `
      <div class="recent-signals">
        <div class="signals-header">
          <span class="signals-title">Recent Signals</span>
          <span class="signals-count">${this._signals.length}</span>
        </div>
        <div class="signals-list">
          ${this._signals.slice(0, 10).map(s => {
            const data = s.data || {};
            const type = s.type || 'unknown';
            const action = data.action || s.action || type;
            const source = data.source || s.source || '-';
            const outcome = data.outcome || s.outcome || '-';
            const ts = s.timestamp ? new Date(s.timestamp).toLocaleTimeString() : '-';
            return `
            <div class="signal-item">
              <div class="signal-type ${type}">${type.replace('_', ' ')}</div>
              <div class="signal-content">
                <span class="signal-action">${this._escapeHtml(action)}</span>
                <span class="signal-source">${source}</span>
              </div>
              <div class="signal-meta">
                <span class="signal-outcome ${outcome}">${outcome}</span>
                <span class="signal-time">${ts}</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  _renderDetailPanel() {
    if (!this._selectedMetric) return '';

    const { type, item } = this._selectedMetric;
    let content = '';

    switch (type) {
      case 'preference':
        content = `
          <div class="detail-row">
            <span class="detail-label">Preference Key</span>
            <span class="detail-value">${this._escapeHtml(item.preference_key)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Preferred Value</span>
            <span class="detail-value">${this._escapeHtml(String(item.preferred_value))}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Frequency</span>
            <span class="detail-value">${item.frequency} occurrences</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Confidence</span>
            <span class="detail-value">${this._formatPercent(item.confidence)}</span>
          </div>
          ${item.alternatives_rejected?.length ? `
            <div class="detail-section">
              <div class="detail-label">Alternatives Rejected</div>
              <ul class="detail-list">
                ${item.alternatives_rejected.map(a => `<li>${this._escapeHtml(a)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        `;
        break;

      case 'error_pattern':
        content = `
          <div class="detail-row">
            <span class="detail-label">Error Type</span>
            <span class="detail-value">${this._escapeHtml(item.error_type)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Resolution Rate</span>
            <span class="detail-value">${this._formatPercent(item.resolution_rate)}</span>
          </div>
          ${item.common_messages?.length ? `
            <div class="detail-section">
              <div class="detail-label">Common Messages</div>
              <ul class="detail-list">
                ${item.common_messages.map(m => `<li>${this._escapeHtml(m)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
          ${item.resolutions?.length ? `
            <div class="detail-section">
              <div class="detail-label">Known Resolutions</div>
              <ul class="detail-list success">
                ${item.resolutions.map(r => `<li>${this._escapeHtml(r)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        `;
        break;

      case 'success_pattern':
        content = `
          <div class="detail-row">
            <span class="detail-label">Pattern Name</span>
            <span class="detail-value">${this._escapeHtml(item.pattern_name)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Avg Duration</span>
            <span class="detail-value">${this._formatDuration(item.avg_duration_seconds)}</span>
          </div>
          ${item.common_actions?.length ? `
            <div class="detail-section">
              <div class="detail-label">Common Actions</div>
              <ol class="detail-list numbered">
                ${item.common_actions.map(a => `<li>${this._escapeHtml(a)}</li>`).join('')}
              </ol>
            </div>
          ` : ''}
        `;
        break;

      case 'tool_efficiency':
        content = `
          <div class="detail-row">
            <span class="detail-label">Tool Name</span>
            <span class="detail-value">${this._escapeHtml(item.tool_name)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Usage Count</span>
            <span class="detail-value">${item.usage_count}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Success Rate</span>
            <span class="detail-value">${this._formatPercent(item.success_rate)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Avg Execution Time</span>
            <span class="detail-value">${Number(item.avg_execution_time_ms ?? 0).toFixed(0)}ms</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Total Tokens</span>
            <span class="detail-value">${this._formatNumber(item.total_tokens_used)}</span>
          </div>
          ${item.alternative_tools?.length ? `
            <div class="detail-section">
              <div class="detail-label">Alternative Tools</div>
              <div class="tag-list">
                ${item.alternative_tools.map(t => `<span class="tag">${this._escapeHtml(t)}</span>`).join('')}
              </div>
            </div>
          ` : ''}
        `;
        break;
    }

    return `
      <div class="detail-panel">
        <div class="detail-header">
          <h3>${type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}</h3>
          <button class="close-btn" id="close-detail">&times;</button>
        </div>
        <div class="detail-body">
          ${content}
          <div class="detail-row">
            <span class="detail-label">Sources</span>
            <div class="source-tags">
              ${(item.sources || []).map(s => `<span class="source-badge ${s}">${s}</span>`).join('')}
            </div>
          </div>
          <div class="detail-row">
            <span class="detail-label">First Seen</span>
            <span class="detail-value">${item.first_seen ? new Date(item.first_seen).toLocaleDateString() : '--'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Last Seen</span>
            <span class="detail-value">${item.last_seen ? new Date(item.last_seen).toLocaleDateString() : '--'}</span>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    const styles = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .learning-dashboard {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          overflow: hidden;
        }

        .dashboard-header {
          padding: 12px 16px;
          border-bottom: 1px solid var(--loki-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .dashboard-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--loki-text-primary);
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .dashboard-title svg {
          color: var(--loki-accent);
        }

        /* Filters */
        .filters {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 12px 16px;
          background: var(--loki-bg-secondary);
          border-bottom: 1px solid var(--loki-border);
          flex-wrap: wrap;
        }

        .filter-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .filter-group label {
          font-size: 10px;
          font-weight: 500;
          color: var(--loki-text-muted);
          text-transform: uppercase;
        }

        .filter-select {
          padding: 6px 10px;
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          font-size: 12px;
          color: var(--loki-text-primary);
          cursor: pointer;
        }

        .filter-select:focus {
          outline: none;
          border-color: var(--loki-accent);
        }

        /* Dashboard Content */
        .dashboard-content {
          padding: 16px;
          display: flex;
          gap: 16px;
          min-height: 400px;
        }

        .content-main {
          flex: 1;
          min-width: 0;
        }

        .loading, .error-state {
          text-align: center;
          padding: 40px;
          color: var(--loki-text-muted);
        }

        .error-state {
          color: var(--loki-red);
        }

        /* Summary Cards */
        .summary-cards {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
          margin-bottom: 20px;
        }

        .summary-card {
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          padding: 14px;
        }

        .summary-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .summary-card-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .summary-card-count {
          font-size: 20px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
        }

        .summary-card-count.confidence-high {
          color: var(--loki-green);
        }

        .summary-card-detail {
          font-size: 11px;
          color: var(--loki-text-muted);
          margin-bottom: 10px;
        }

        .signal-breakdown {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .breakdown-item {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
        }

        .breakdown-label {
          color: var(--loki-text-secondary);
          text-transform: capitalize;
        }

        .breakdown-value {
          color: var(--loki-text-primary);
          font-family: 'JetBrains Mono', monospace;
        }

        .source-badge {
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 9px;
          text-transform: uppercase;
          font-weight: 500;
        }

        .source-badge.cli { background: var(--loki-blue-muted); color: var(--loki-blue); }
        .source-badge.api { background: var(--loki-green-muted); color: var(--loki-green); }
        .source-badge.vscode { background: var(--loki-purple-muted); color: var(--loki-purple); }
        .source-badge.mcp { background: var(--loki-yellow-muted); color: var(--loki-yellow); }
        .source-badge.dashboard { background: var(--loki-accent-muted); color: var(--loki-accent); }

        .pattern-counts {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .pattern-count {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: var(--loki-text-secondary);
        }

        .pattern-icon {
          width: 18px;
          height: 18px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 600;
        }

        .pattern-icon.preferences { background: var(--loki-blue-muted); color: var(--loki-blue); }
        .pattern-icon.errors { background: var(--loki-red-muted); color: var(--loki-red); }
        .pattern-icon.success { background: var(--loki-green-muted); color: var(--loki-green); }

        .confidence-bar {
          height: 4px;
          background: var(--loki-bg-tertiary);
          border-radius: 2px;
          overflow: hidden;
        }

        .confidence-fill {
          height: 100%;
          background: var(--loki-green);
          border-radius: 2px;
          transition: width 0.3s ease;
        }

        /* Trend Chart */
        .trend-chart {
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          padding: 14px;
          margin-bottom: 20px;
        }

        .chart-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .chart-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .chart-subtitle {
          font-size: 11px;
          color: var(--loki-text-muted);
        }

        .chart-svg {
          width: 100%;
          height: 120px;
        }

        .chart-labels {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: var(--loki-text-muted);
          margin-top: 4px;
        }

        .chart-empty {
          text-align: center;
          padding: 40px;
          color: var(--loki-text-muted);
          font-size: 12px;
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          margin-bottom: 20px;
        }

        /* Top Lists */
        .top-lists {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 12px;
          margin-bottom: 20px;
        }

        .top-list {
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          overflow: hidden;
        }

        .list-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          background: var(--loki-bg-tertiary);
        }

        .list-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .list-count {
          font-size: 10px;
          padding: 2px 6px;
          background: var(--loki-bg-card);
          border-radius: 5px;
          color: var(--loki-text-muted);
        }

        .list-items {
          max-height: 200px;
          overflow-y: auto;
        }

        .list-item {
          padding: 10px 12px;
          border-bottom: 1px solid var(--loki-border);
          cursor: pointer;
          transition: background var(--loki-transition);
        }

        .list-item:hover {
          background: var(--loki-bg-hover);
        }

        .list-item:last-child {
          border-bottom: none;
        }

        .item-main {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }

        .item-key {
          font-size: 12px;
          font-weight: 500;
          color: var(--loki-text-primary);
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .item-value {
          font-size: 11px;
          color: var(--loki-accent);
          margin-left: 8px;
        }

        .item-meta {
          display: flex;
          gap: 12px;
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .item-freq {
          color: var(--loki-blue);
        }

        .item-conf {
          color: var(--loki-green);
        }

        .item-rank {
          font-size: 11px;
          font-weight: 600;
          color: var(--loki-accent);
          margin-right: 8px;
        }

        .efficiency-score {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          font-weight: 600;
          color: var(--loki-green);
        }

        .success-rate.good {
          color: var(--loki-green);
        }

        .resolution-rate {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 3px;
        }

        .resolution-rate.good {
          background: var(--loki-green-muted);
          color: var(--loki-green);
        }

        .resolution-rate.poor {
          background: var(--loki-red-muted);
          color: var(--loki-red);
        }

        .item-duration {
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .list-empty {
          padding: 20px;
          text-align: center;
          font-size: 11px;
          color: var(--loki-text-muted);
        }

        /* Recent Signals */
        .recent-signals {
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          overflow: hidden;
        }

        .signals-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          background: var(--loki-bg-tertiary);
        }

        .signals-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .signals-count {
          font-size: 10px;
          padding: 2px 6px;
          background: var(--loki-bg-card);
          border-radius: 5px;
          color: var(--loki-text-muted);
        }

        .signals-list {
          max-height: 300px;
          overflow-y: auto;
        }

        .signal-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--loki-border);
        }

        .signal-item:last-child {
          border-bottom: none;
        }

        .signal-type {
          font-size: 9px;
          padding: 3px 6px;
          border-radius: 3px;
          text-transform: uppercase;
          font-weight: 500;
          white-space: nowrap;
        }

        .signal-type.user_preference { background: var(--loki-blue-muted); color: var(--loki-blue); }
        .signal-type.error_pattern { background: var(--loki-red-muted); color: var(--loki-red); }
        .signal-type.success_pattern { background: var(--loki-green-muted); color: var(--loki-green); }
        .signal-type.tool_efficiency { background: var(--loki-purple-muted); color: var(--loki-purple); }
        .signal-type.context_relevance { background: var(--loki-yellow-muted); color: var(--loki-yellow); }

        .signal-content {
          flex: 1;
          min-width: 0;
        }

        .signal-action {
          font-size: 12px;
          color: var(--loki-text-primary);
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .signal-source {
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .signal-meta {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 2px;
        }

        .signal-outcome {
          font-size: 9px;
          padding: 2px 5px;
          border-radius: 3px;
          text-transform: uppercase;
        }

        .signal-outcome.success { background: var(--loki-green-muted); color: var(--loki-green); }
        .signal-outcome.failure { background: var(--loki-red-muted); color: var(--loki-red); }
        .signal-outcome.partial { background: var(--loki-yellow-muted); color: var(--loki-yellow); }
        .signal-outcome.unknown { background: var(--loki-bg-tertiary); color: var(--loki-text-muted); }

        .signal-time {
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .signals-empty {
          padding: 30px;
          text-align: center;
          font-size: 12px;
          color: var(--loki-text-muted);
        }

        /* Detail Panel */
        .detail-panel {
          width: 300px;
          min-width: 300px;
          background: var(--loki-bg-secondary);
          border-left: 1px solid var(--loki-border);
          margin: -16px -16px -16px 16px;
          padding: 16px;
          overflow-y: auto;
        }

        .detail-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .detail-header h3 {
          font-size: 14px;
          font-weight: 600;
          color: var(--loki-text-primary);
          text-transform: capitalize;
        }

        .close-btn {
          background: none;
          border: none;
          font-size: 20px;
          color: var(--loki-text-muted);
          cursor: pointer;
          padding: 0;
          line-height: 1;
        }

        .close-btn:hover {
          color: var(--loki-text-primary);
        }

        .detail-row {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid var(--loki-border);
          font-size: 12px;
        }

        .detail-label {
          color: var(--loki-text-secondary);
          font-weight: 500;
        }

        .detail-value {
          color: var(--loki-text-primary);
        }

        .detail-section {
          margin-top: 12px;
        }

        .detail-list {
          padding-left: 18px;
          margin-top: 6px;
          font-size: 11px;
          color: var(--loki-text-primary);
        }

        .detail-list li {
          margin-bottom: 4px;
        }

        .detail-list.success li {
          color: var(--loki-green);
        }

        .source-tags {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }

        .tag-list {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          margin-top: 6px;
        }

        .tag {
          font-size: 10px;
          padding: 3px 8px;
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          color: var(--loki-text-secondary);
        }

        .empty-state {
          text-align: center;
          padding: 40px;
          color: var(--loki-text-muted);
          font-size: 12px;
        }
      </style>
    `;

    let content;
    if (this._loading) {
      content = '<div class="loading">Loading learning metrics...</div>';
    } else if (this._error) {
      content = `<div class="error-state">Error: ${this._error}</div>`;
    } else {
      content = `
        <div class="content-main">
          ${this._renderSummaryCards()}
          ${this._renderTrendChart()}
          ${this._renderTopLists()}
          ${this._renderRecentSignals()}
        </div>
        ${this._renderDetailPanel()}
      `;
    }

    this.shadowRoot.innerHTML = `
      ${styles}
      <div class="learning-dashboard">
        <div class="dashboard-header">
          <span class="dashboard-title">
            <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
              <path d="M12 20V10"/>
              <path d="M18 20V4"/>
              <path d="M6 20v-4"/>
            </svg>
            Learning Metrics Dashboard
          </span>
        </div>
        ${this._renderFilters()}
        <div class="dashboard-content">
          ${content}
        </div>
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    // Filter selects
    const timeRangeSelect = this.shadowRoot.getElementById('time-range-select');
    if (timeRangeSelect) {
      timeRangeSelect.addEventListener('change', (e) => this._setFilter('timeRange', e.target.value));
    }

    const signalTypeSelect = this.shadowRoot.getElementById('signal-type-select');
    if (signalTypeSelect) {
      signalTypeSelect.addEventListener('change', (e) => this._setFilter('signalType', e.target.value));
    }

    const sourceSelect = this.shadowRoot.getElementById('source-select');
    if (sourceSelect) {
      sourceSelect.addEventListener('change', (e) => this._setFilter('source', e.target.value));
    }

    // Refresh button
    const refreshBtn = this.shadowRoot.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._loadData());
    }

    // Close detail button
    const closeBtn = this.shadowRoot.getElementById('close-detail');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeDetail());
    }

    // List items
    this.shadowRoot.querySelectorAll('.list-item').forEach(item => {
      item.addEventListener('click', () => {
        const type = item.dataset.type;
        const id = item.dataset.id;
        const itemData = this._findItemData(type, id);
        if (itemData) {
          this._selectMetric(type, itemData);
        }
      });

      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
      });
    });
  }

  _findItemData(type, id) {
    if (!this._metrics?.aggregation) return null;

    switch (type) {
      case 'preference':
        return this._metrics.aggregation.preferences?.find(p => p.preference_key === id);
      case 'error_pattern':
        return this._metrics.aggregation.error_patterns?.find(e => e.error_type === id);
      case 'success_pattern':
        return this._metrics.aggregation.success_patterns?.find(s => s.pattern_name === id);
      case 'tool_efficiency':
        return this._metrics.aggregation.tool_efficiencies?.find(t => t.tool_name === id);
      default:
        return null;
    }
  }
}

// Register the component
if (!customElements.get('loki-learning-dashboard')) {
  customElements.define('loki-learning-dashboard', LokiLearningDashboard);
}

export default LokiLearningDashboard;
