/**
 * @fileoverview Agent Performance Leaderboard - ranked list of agents by
 * performance metrics including tasks completed, average quality score,
 * and speed. Highlights top 3 with gold/silver/bronze indicators and
 * shows rank change arrows.
 *
 * @example
 * <loki-agent-leaderboard api-url="http://localhost:57374" theme="dark"></loki-agent-leaderboard>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

const RANK_COLORS = {
  1: { bg: 'rgba(212, 160, 60, 0.15)', border: '#D4A03C', label: '1st' },
  2: { bg: 'rgba(147, 144, 132, 0.15)', border: '#939084', label: '2nd' },
  3: { bg: 'rgba(196, 130, 91, 0.15)', border: '#C4825B', label: '3rd' },
};

/**
 * @class LokiAgentLeaderboard
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - Theme name (default: auto-detect)
 */
export class LokiAgentLeaderboard extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._agents = [];
    this._expandedAgent = null;
    this._api = null;
    this._pollInterval = null;
    this._previousRanks = {};
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
      this._api = getApiClient({ baseUrl: newValue });
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
    // active + visible section in ONE place, so a hidden tab or background
    // section does not fetch. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadData(),
      intervalMs: 10000,
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
    const api = this._api;
    try {
      const data = await api._get('/api/v2/agents/leaderboard');
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      const agents = data.agents || [];
      // Track rank changes
      const newRanks = {};
      agents.forEach((a, i) => {
        newRanks[a.type || a.name] = i + 1;
      });
      this._previousRanks = { ...this._currentRanks || {} };
      this._currentRanks = newRanks;
      this._agents = agents;
    } catch {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      if (this._agents.length === 0) {
        this._agents = this._getDemoData();
        this._currentRanks = {};
        this._agents.forEach((a, i) => {
          this._currentRanks[a.type] = i + 1;
        });
        this._previousRanks = {};
      }
    }
    this.render();
  }

  _getDemoData() {
    return [
      { type: 'code-generator',    name: 'Code Generator',     tasks: 24, quality: 9.2, speed: 'fast',   cost_usd: 2.40 },
      { type: 'test-writer',       name: 'Test Writer',        tasks: 18, quality: 9.0, speed: 'fast',   cost_usd: 1.20 },
      { type: 'code-reviewer',     name: 'Code Reviewer',      tasks: 15, quality: 8.8, speed: 'medium', cost_usd: 1.80 },
      { type: 'architect',         name: 'Architect',          tasks: 8,  quality: 9.5, speed: 'slow',   cost_usd: 3.10 },
      { type: 'debugger',          name: 'Debugger',           tasks: 12, quality: 8.5, speed: 'fast',   cost_usd: 0.95 },
      { type: 'doc-writer',        name: 'Documentation',      tasks: 10, quality: 8.3, speed: 'fast',   cost_usd: 0.60 },
    ];
  }

  _getRankChange(agentType) {
    const current = this._currentRanks?.[agentType];
    const prev = this._previousRanks?.[agentType];
    if (current == null || prev == null) return 0;
    return prev - current; // positive = moved up
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _toggleAgent(agentType) {
    this._expandedAgent = this._expandedAgent === agentType ? null : agentType;
    this.render();
  }

  _bindEvents() {
    const root = this.shadowRoot;
    root.querySelectorAll('.agent-row').forEach(row => {
      row.addEventListener('click', () => {
        this._toggleAgent(row.dataset.agent);
      });
    });
  }

  _getQualityColor(score) {
    if (score >= 9) return 'var(--loki-green, #1FC5A8)';
    if (score >= 8) return 'var(--loki-blue, #2F71E3)';
    if (score >= 7) return 'var(--loki-yellow, #D4A03C)';
    return 'var(--loki-red, #C45B5B)';
  }

  _getSpeedLabel(speed) {
    if (speed === 'fast') return { label: 'Fast', color: 'var(--loki-green, #1FC5A8)' };
    if (speed === 'medium') return { label: 'Medium', color: 'var(--loki-yellow, #D4A03C)' };
    return { label: 'Slow', color: 'var(--loki-red, #C45B5B)' };
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .leaderboard-container {
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .title {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
      }

      .agent-count {
        font-size: 12px;
        color: var(--loki-text-muted, #939084);
      }

      .leaderboard-table {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        overflow: hidden;
      }

      .table-header {
        display: grid;
        grid-template-columns: 48px 1fr 80px 80px 80px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        background: var(--loki-bg-secondary, #F8F4F0);
      }

      .table-header span {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
      }

      .agent-row {
        display: grid;
        grid-template-columns: 48px 1fr 80px 80px 80px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        cursor: pointer;
        transition: all 0.2s;
        align-items: center;
      }

      .agent-row:last-child {
        border-bottom: none;
      }

      .agent-row:hover {
        background: var(--loki-bg-hover, #F3EFE9);
      }

      .agent-row.top-3 {
        border-left: 3px solid transparent;
      }

      .rank-cell {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .rank-number {
        font-size: 15px;
        font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        min-width: 20px;
      }

      .rank-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-size: 12px;
        font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
      }

      .rank-change {
        font-size: 10px;
        font-weight: 600;
      }

      .rank-up {
        color: var(--loki-green, #1FC5A8);
      }

      .rank-down {
        color: var(--loki-red, #C45B5B);
      }

      .agent-name-cell {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .agent-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--loki-text-primary, #201515);
      }

      .agent-type {
        font-size: 10px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-muted, #939084);
      }

      .metric-cell {
        font-size: 13px;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 600;
      }

      .quality-score {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .quality-bar {
        width: 40px;
        height: 4px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        border-radius: 2px;
        overflow: hidden;
      }

      .quality-fill {
        height: 100%;
        border-radius: 2px;
      }

      .speed-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 4px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      .agent-detail {
        grid-column: 1 / -1;
        padding: 12px 14px;
        background: var(--loki-bg-secondary, #F8F4F0);
        border-top: 1px solid var(--loki-border, #ECEAE3);
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
        animation: expandDetail 0.2s ease-out;
      }

      @keyframes expandDetail {
        from { opacity: 0; max-height: 0; }
        to { opacity: 1; max-height: 100px; }
      }

      .detail-metric {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .detail-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
      }

      .detail-value {
        font-size: 13px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-primary, #201515);
      }

      .empty-state {
        text-align: center;
        padding: 32px 16px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    if (this._agents.length === 0) {
      s.innerHTML = `
        <style>${this.getBaseStyles()}${this._getStyles()}</style>
        <div class="leaderboard-container">
          <div class="header">
            <h3 class="title">Agent Leaderboard</h3>
          </div>
          <div class="empty-state">No agent performance data available</div>
        </div>
      `;
      return;
    }

    const rows = this._agents.map((agent, idx) => {
      const rank = idx + 1;
      const rankCfg = RANK_COLORS[rank];
      const agentKey = agent.type || agent.name;
      const rankChange = this._getRankChange(agentKey);
      const isExpanded = this._expandedAgent === agentKey;
      const qualityColor = this._getQualityColor(agent.quality);
      const speedCfg = this._getSpeedLabel(agent.speed);
      const qualityPct = ((agent.quality || 0) / 10) * 100;

      let rankHtml;
      if (rankCfg) {
        rankHtml = `<div class="rank-badge" style="background: ${rankCfg.bg}; color: ${rankCfg.border};">${rank}</div>`;
      } else {
        rankHtml = `<span class="rank-number" style="color: var(--loki-text-muted);">${rank}</span>`;
      }

      let rankChangeHtml = '';
      if (rankChange > 0) {
        rankChangeHtml = `<span class="rank-change rank-up">+${rankChange}</span>`;
      } else if (rankChange < 0) {
        rankChangeHtml = `<span class="rank-change rank-down">${rankChange}</span>`;
      }

      const detailHtml = isExpanded ? `
        <div class="agent-detail">
          <div class="detail-metric">
            <span class="detail-label">Total Cost</span>
            <span class="detail-value">$${(agent.cost_usd || 0).toFixed(2)}</span>
          </div>
          <div class="detail-metric">
            <span class="detail-label">Avg Time/Task</span>
            <span class="detail-value">${agent.avg_time || '--'}</span>
          </div>
          <div class="detail-metric">
            <span class="detail-label">Success Rate</span>
            <span class="detail-value">${agent.success_rate != null ? agent.success_rate + '%' : '--'}</span>
          </div>
        </div>
      ` : '';

      return `
        <div class="agent-row ${rank <= 3 ? 'top-3' : ''}" data-agent="${this._escapeHtml(agentKey)}"
             style="${rankCfg ? 'border-left-color: ' + rankCfg.border + ';' : ''}">
          <div class="rank-cell">${rankHtml}${rankChangeHtml}</div>
          <div class="agent-name-cell">
            <span class="agent-name">${this._escapeHtml(agent.name || agent.type)}</span>
            <span class="agent-type">${this._escapeHtml(agent.type || '')}</span>
          </div>
          <div class="metric-cell">${agent.tasks || 0}</div>
          <div class="metric-cell">
            <div class="quality-score">
              <span style="color: ${qualityColor};">${(agent.quality || 0).toFixed(1)}</span>
              <div class="quality-bar"><div class="quality-fill" style="width: ${qualityPct}%; background: ${qualityColor};"></div></div>
            </div>
          </div>
          <div class="metric-cell">
            <span class="speed-badge" style="background: ${speedCfg.color}15; color: ${speedCfg.color};">${speedCfg.label}</span>
          </div>
        </div>
        ${detailHtml}
      `;
    }).join('');

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="leaderboard-container">
        <div class="header">
          <h3 class="title">Agent Leaderboard</h3>
          <span class="agent-count">${this._agents.length} agents</span>
        </div>
        <div class="leaderboard-table">
          <div class="table-header">
            <span>Rank</span>
            <span>Agent</span>
            <span>Tasks</span>
            <span>Quality</span>
            <span>Speed</span>
          </div>
          ${rows}
        </div>
      </div>
    `;

    this._bindEvents();
  }
}

if (!customElements.get('loki-agent-leaderboard')) {
  customElements.define('loki-agent-leaderboard', LokiAgentLeaderboard);
}

export default LokiAgentLeaderboard;
