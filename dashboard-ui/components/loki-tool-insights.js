/**
 * @fileoverview Loki Tool Insights Component - displays tool token usage
 * per origin (native, MCP, custom). Inspired by Kiro CLI /tools command
 * that shows estimated token counts for each tool and totals per origin.
 *
 * Shows:
 * - Token cost per tool definition (schema size)
 * - Per-origin totals (native tools, MCP servers)
 * - Tool call frequency and success rates
 * - Warnings for tools with large descriptions (>10K chars)
 *
 * @example
 * <loki-tool-insights api-url="http://localhost:57374" theme="dark"></loki-tool-insights>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

export class LokiToolInsights extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._data = null;
    this._api = null;
    this._pollInterval = null;
    this._activeView = 'overview';
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
    this._pollInterval = setInterval(() => this._loadData(), 30000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async _loadData() {
    try {
      const [toolsRes, metricsRes] = await Promise.allSettled([
        this._api.get('/api/tools'),
        this._api.get('/api/metrics/tools'),
      ]);

      this._data = {
        tools: toolsRes.status === 'fulfilled' ? toolsRes.value : null,
        metrics: metricsRes.status === 'fulfilled' ? metricsRes.value : null,
      };
      this._render();
    } catch (e) {
      this._data = null;
      this._render();
    }
  }

  _estimateTokens(tool) {
    // Rough estimate: 1 token per 4 characters of schema/description
    const descLen = (tool.description || '').length;
    const schemaLen = JSON.stringify(tool.input_schema || tool.schema || {}).length;
    return Math.ceil((descLen + schemaLen) / 4);
  }

  _render() {
    const data = this._data;
    const v = this._themeVars || {};

    if (!data || !data.tools) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; font-family: var(--font-mono, monospace); }
          .container { padding: 16px; color: ${v.textColor || '#c9d1d9'}; background: ${v.bgColor || '#0d1117'}; border-radius: 8px; }
          .muted { color: ${v.mutedColor || '#8b949e'}; }
        </style>
        <div class="container">
          <h3>Tool Insights</h3>
          <p class="muted">Loading tool data...</p>
        </div>
      `;
      return;
    }

    const tools = Array.isArray(data.tools) ? data.tools : (data.tools.tools || []);
    const metrics = data.metrics || {};

    // Group by origin
    const grouped = {};
    let totalTokens = 0;
    const warnings = [];

    for (const tool of tools) {
      const origin = tool.origin || tool.source || 'native';
      if (!grouped[origin]) grouped[origin] = { tools: [], tokens: 0 };
      const tokens = this._estimateTokens(tool);
      totalTokens += tokens;
      grouped[origin].tools.push({ ...tool, estimatedTokens: tokens });
      grouped[origin].tokens += tokens;

      // Warn for large descriptions (Kiro pattern: >10K chars)
      const totalLen = (tool.description || '').length + JSON.stringify(tool.input_schema || {}).length;
      if (totalLen > 10000) {
        warnings.push(`${tool.name}: description exceeds 10K chars (${totalLen} chars). May impact performance.`);
      }
    }

    // Build origin rows
    let originRows = '';
    for (const [origin, group] of Object.entries(grouped).sort((a, b) => b[1].tokens - a[1].tokens)) {
      const pct = totalTokens > 0 ? Math.round(group.tokens / totalTokens * 100) : 0;
      const barWidth = Math.max(1, Math.round(pct / 2));
      const bar = '='.repeat(barWidth);

      originRows += `
        <div class="origin-row" data-origin="${origin}">
          <div class="origin-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="origin-name">${origin}</span>
            <span class="origin-count">${group.tools.length} tools</span>
            <span class="origin-tokens">${group.tokens.toLocaleString()} tokens</span>
            <span class="origin-bar"><span class="bar-fill" style="width:${pct}%"></span></span>
            <span class="origin-pct">${pct}%</span>
          </div>
          <div class="origin-tools">
            ${group.tools.map(t => `
              <div class="tool-row ${t.estimatedTokens > 2500 ? 'tool-large' : ''}">
                <span class="tool-name">${t.name}</span>
                <span class="tool-tokens">${t.estimatedTokens} tokens</span>
                <span class="tool-desc">${(t.description || '').substring(0, 80)}${(t.description || '').length > 80 ? '...' : ''}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Warnings section
    let warningHtml = '';
    if (warnings.length > 0) {
      warningHtml = `
        <div class="warnings">
          <h4>Warnings</h4>
          ${warnings.map(w => `<div class="warning-item">${w}</div>`).join('')}
        </div>
      `;
    }

    // Tool call metrics (if available)
    let metricsHtml = '';
    const toolMetrics = metrics.tool_calls || metrics.calls || {};
    if (Object.keys(toolMetrics).length > 0) {
      const sorted = Object.entries(toolMetrics).sort((a, b) => (b[1].count || b[1]) - (a[1].count || a[1]));
      metricsHtml = `
        <div class="metrics-section">
          <h4>Tool Call Frequency</h4>
          ${sorted.slice(0, 15).map(([name, data]) => {
            const count = typeof data === 'number' ? data : data.count || 0;
            const success = typeof data === 'object' ? (data.success_rate || data.success || 100) : 100;
            return `
              <div class="metric-row">
                <span class="metric-name">${name}</span>
                <span class="metric-count">${count} calls</span>
                <span class="metric-success" style="color: ${success >= 90 ? '#3fb950' : success >= 70 ? '#d29922' : '#f85149'}">${success}%</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: var(--font-mono, 'SF Mono', monospace); font-size: 13px; }
        .container { padding: 16px; color: ${v.textColor || '#c9d1d9'}; background: ${v.bgColor || '#0d1117'}; border-radius: 8px; border: 1px solid ${v.borderColor || '#30363d'}; }
        h3 { margin: 0 0 12px 0; font-size: 14px; color: ${v.headingColor || '#f0f6fc'}; }
        h4 { margin: 16px 0 8px 0; font-size: 12px; color: ${v.mutedColor || '#8b949e'}; text-transform: uppercase; letter-spacing: 0.5px; }
        .summary { display: flex; gap: 24px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid ${v.borderColor || '#30363d'}; }
        .summary-item { display: flex; flex-direction: column; }
        .summary-label { font-size: 11px; color: ${v.mutedColor || '#8b949e'}; }
        .summary-value { font-size: 18px; font-weight: 600; color: ${v.headingColor || '#f0f6fc'}; }
        .origin-row { margin-bottom: 2px; }
        .origin-header { display: grid; grid-template-columns: 120px 80px 100px 1fr 40px; gap: 8px; align-items: center; padding: 6px 8px; cursor: pointer; border-radius: 4px; transition: background 0.15s; }
        .origin-header:hover { background: ${v.hoverBg || '#161b22'}; }
        .origin-name { font-weight: 600; }
        .origin-count { color: ${v.mutedColor || '#8b949e'}; font-size: 12px; }
        .origin-tokens { text-align: right; }
        .origin-bar { height: 6px; background: ${v.barBg || '#21262d'}; border-radius: 3px; overflow: hidden; }
        .bar-fill { display: block; height: 100%; background: ${v.accentColor || '#58a6ff'}; border-radius: 3px; transition: width 0.3s; }
        .origin-pct { text-align: right; color: ${v.mutedColor || '#8b949e'}; font-size: 12px; }
        .origin-tools { display: none; padding-left: 16px; }
        .origin-row.expanded .origin-tools { display: block; }
        .tool-row { display: grid; grid-template-columns: 180px 80px 1fr; gap: 8px; padding: 3px 8px; font-size: 12px; color: ${v.mutedColor || '#8b949e'}; }
        .tool-row.tool-large .tool-name { color: ${v.warningColor || '#d29922'}; }
        .tool-name { color: ${v.textColor || '#c9d1d9'}; }
        .tool-tokens { text-align: right; }
        .tool-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .warnings { margin-top: 12px; padding: 8px 12px; background: ${v.warningBg || '#2d1b00'}; border: 1px solid ${v.warningBorder || '#bb8009'}; border-radius: 6px; }
        .warning-item { font-size: 12px; color: ${v.warningColor || '#d29922'}; padding: 2px 0; }
        .metrics-section { margin-top: 12px; }
        .metric-row { display: grid; grid-template-columns: 180px 80px 50px; gap: 8px; padding: 3px 8px; font-size: 12px; }
        .metric-name { color: ${v.textColor || '#c9d1d9'}; }
        .metric-count { text-align: right; color: ${v.mutedColor || '#8b949e'}; }
        .metric-success { text-align: right; }
        .muted { color: ${v.mutedColor || '#8b949e'}; font-size: 12px; }
      </style>
      <div class="container">
        <h3>Tool Insights</h3>
        <div class="summary">
          <div class="summary-item">
            <span class="summary-label">Total Tools</span>
            <span class="summary-value">${tools.length}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Token Overhead</span>
            <span class="summary-value">${totalTokens.toLocaleString()}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Origins</span>
            <span class="summary-value">${Object.keys(grouped).length}</span>
          </div>
        </div>
        ${originRows}
        ${warningHtml}
        ${metricsHtml}
        <p class="muted">Token counts are estimates based on schema size. Actual usage varies.</p>
      </div>
    `;
  }
}

customElements.define('loki-tool-insights', LokiToolInsights);
