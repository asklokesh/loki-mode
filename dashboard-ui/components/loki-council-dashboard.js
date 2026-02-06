/**
 * Loki Completion Council Dashboard Component
 *
 * Displays council state, vote history, convergence tracking, agent management,
 * and decision logs for the Completion Council system.
 *
 * Usage:
 *   <loki-council-dashboard
 *     api-url="http://localhost:57374"
 *     theme="dark"
 *   ></loki-council-dashboard>
 *
 * Attributes:
 *   - api-url: API base URL (default: auto-detected from window.location.origin)
 *   - theme: 'light' or 'dark' (default: auto-detect)
 *
 * Events:
 *   - council-action: Fired when a council action is taken (force-review, kill agent, etc.)
 *
 * @version 1.0.0
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

const COUNCIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'decisions', label: 'Decision Log' },
  { id: 'convergence', label: 'Convergence' },
  { id: 'agents', label: 'Agents' },
];

export class LokiCouncilDashboard extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._activeTab = 'overview';
    this._pollInterval = null;

    // Data
    this._councilState = null;
    this._verdicts = [];
    this._convergence = [];
    this._agents = [];
    this._selectedAgent = null;
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
    this._pollInterval = setInterval(() => this._loadData(), 3000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async _loadData() {
    try {
      const [councilState, verdicts, convergence, agents] = await Promise.allSettled([
        this._api.get('/api/council/state'),
        this._api.get('/api/council/verdicts'),
        this._api.get('/api/council/convergence'),
        this._api.get('/api/agents'),
      ]);

      if (councilState.status === 'fulfilled') this._councilState = councilState.value;
      if (verdicts.status === 'fulfilled') {
        this._verdicts = verdicts.value.verdicts || [];
      }
      if (convergence.status === 'fulfilled') {
        this._convergence = convergence.value.dataPoints || [];
      }
      if (agents.status === 'fulfilled') {
        this._agents = Array.isArray(agents.value) ? agents.value : [];
      }

      this._error = null;
    } catch (err) {
      this._error = err.message;
    }

    this.render();
  }

  async _forceReview() {
    try {
      await this._api.post('/api/council/force-review');
      this.dispatchEvent(new CustomEvent('council-action', {
        detail: { action: 'force-review' },
        bubbles: true,
      }));
    } catch (err) {
      this._error = `Failed to force review: ${err.message}`;
      this.render();
    }
  }

  async _killAgent(agentId) {
    if (!confirm(`Kill agent ${agentId}?`)) return;
    try {
      await this._api.post(`/api/agents/${agentId}/kill`);
      this.dispatchEvent(new CustomEvent('council-action', {
        detail: { action: 'kill-agent', agentId },
        bubbles: true,
      }));
      await this._loadData();
    } catch (err) {
      this._error = `Failed to kill agent: ${err.message}`;
      this.render();
    }
  }

  async _pauseAgent(agentId) {
    try {
      await this._api.post(`/api/agents/${agentId}/pause`);
      await this._loadData();
    } catch (err) {
      this._error = `Failed to pause agent: ${err.message}`;
      this.render();
    }
  }

  async _resumeAgent(agentId) {
    try {
      await this._api.post(`/api/agents/${agentId}/resume`);
      await this._loadData();
    } catch (err) {
      this._error = `Failed to resume agent: ${err.message}`;
      this.render();
    }
  }

  _setTab(tabId) {
    this._activeTab = tabId;
    this.render();
  }

  _selectAgent(agent) {
    this._selectedAgent = this._selectedAgent?.id === agent.id ? null : agent;
    this.render();
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    s.innerHTML = `
      <style>${this._getStyles()}</style>
      <div class="council-dashboard">
        <div class="council-header">
          <div class="header-left">
            <h2 class="title">Completion Council</h2>
            ${this._councilState?.enabled !== false
              ? `<span class="badge badge-active">Active</span>`
              : `<span class="badge badge-inactive">Disabled</span>`
            }
          </div>
          <button class="btn btn-primary" onclick="this.getRootNode().host._forceReview()">
            Force Review
          </button>
        </div>

        <div class="tabs">
          ${COUNCIL_TABS.map(tab => `
            <button
              class="tab ${this._activeTab === tab.id ? 'active' : ''}"
              onclick="this.getRootNode().host._setTab('${tab.id}')"
            >${tab.label}</button>
          `).join('')}
        </div>

        <div class="tab-content">
          ${this._renderTabContent()}
        </div>

        ${this._error ? `<div class="error-banner">${this._error}</div>` : ''}
      </div>
    `;
  }

  _renderTabContent() {
    switch (this._activeTab) {
      case 'overview': return this._renderOverview();
      case 'decisions': return this._renderDecisions();
      case 'convergence': return this._renderConvergence();
      case 'agents': return this._renderAgents();
      default: return '';
    }
  }

  _renderOverview() {
    const state = this._councilState || {};
    const noChange = state.consecutive_no_change || 0;
    const doneSignals = state.done_signals || 0;
    const totalVotes = state.total_votes || 0;
    const approveVotes = state.approve_votes || 0;
    const lastVerdict = this._verdicts.length > 0 ? this._verdicts[this._verdicts.length - 1] : null;
    const agentCount = this._agents.filter(a => a.alive).length;

    return `
      <div class="overview-grid">
        <div class="stat-card">
          <div class="stat-label">Council Status</div>
          <div class="stat-value ${state.enabled !== false ? 'text-green' : 'text-muted'}">
            ${state.enabled !== false ? 'Monitoring' : 'Disabled'}
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Votes Cast</div>
          <div class="stat-value">${totalVotes}</div>
          <div class="stat-sub">${approveVotes} approved</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Stagnation Streak</div>
          <div class="stat-value ${noChange >= 3 ? 'text-warn' : ''}">${noChange}</div>
          <div class="stat-sub">consecutive no-change</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Done Signals</div>
          <div class="stat-value ${doneSignals >= 2 ? 'text-green' : ''}">${doneSignals}</div>
          <div class="stat-sub">from agent output</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Agents</div>
          <div class="stat-value">${agentCount}</div>
          <div class="stat-sub">of ${this._agents.length} total</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Last Verdict</div>
          <div class="stat-value ${lastVerdict?.result === 'APPROVED' ? 'text-green' : 'text-muted'}">
            ${lastVerdict ? lastVerdict.result : 'None'}
          </div>
          ${lastVerdict ? `<div class="stat-sub">iteration ${lastVerdict.iteration}</div>` : ''}
        </div>
      </div>

      ${this._convergence.length > 0 ? `
        <div class="section">
          <h3 class="section-title">Convergence Trend</h3>
          <div class="convergence-mini">
            ${this._renderConvergenceBar()}
          </div>
        </div>
      ` : ''}
    `;
  }

  _renderConvergenceBar() {
    const points = this._convergence.slice(-20);
    if (points.length === 0) return '<span class="text-muted">No data</span>';

    const maxFiles = Math.max(...points.map(p => p.files_changed), 1);
    return `
      <div class="bar-chart">
        ${points.map(p => {
          const height = Math.max(4, (p.files_changed / maxFiles) * 60);
          const isStagnant = p.no_change_streak > 0;
          return `
            <div class="bar-wrapper" title="Iter ${p.iteration}: ${p.files_changed} files changed">
              <div class="bar ${isStagnant ? 'bar-stagnant' : 'bar-active'}" style="height: ${height}px"></div>
              <div class="bar-label">${p.iteration}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  _renderDecisions() {
    if (this._verdicts.length === 0) {
      return `<div class="empty-state">No council decisions yet. The council convenes every ${this._councilState?.check_interval || 5} iterations.</div>`;
    }

    return `
      <div class="decision-list">
        ${this._verdicts.slice().reverse().map(v => `
          <div class="decision-card ${v.result === 'APPROVED' ? 'decision-approved' : 'decision-rejected'}">
            <div class="decision-header">
              <span class="decision-result ${v.result === 'APPROVED' ? 'text-green' : 'text-warn'}">
                ${v.result}
              </span>
              <span class="decision-iter">Iteration ${v.iteration}</span>
              <span class="decision-time">${this._formatTime(v.timestamp)}</span>
            </div>
            <div class="decision-votes">
              <span class="vote-approve">${v.approve} Approve</span>
              <span class="vote-reject">${v.reject} Reject</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  _renderConvergence() {
    if (this._convergence.length === 0) {
      return '<div class="empty-state">No convergence data available yet.</div>';
    }

    return `
      <div class="section">
        <h3 class="section-title">Files Changed Per Iteration</h3>
        <div class="convergence-chart">
          ${this._renderConvergenceBar()}
        </div>
      </div>

      <div class="section">
        <h3 class="section-title">Convergence Log</h3>
        <div class="convergence-table">
          <table>
            <thead>
              <tr>
                <th>Iteration</th>
                <th>Files Changed</th>
                <th>No-Change Streak</th>
                <th>Done Signals</th>
              </tr>
            </thead>
            <tbody>
              ${this._convergence.slice().reverse().map(p => `
                <tr class="${p.no_change_streak >= 3 ? 'row-warn' : ''}">
                  <td>${p.iteration}</td>
                  <td>${p.files_changed}</td>
                  <td>${p.no_change_streak}</td>
                  <td>${p.done_signals}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  _renderAgents() {
    if (this._agents.length === 0) {
      return '<div class="empty-state">No agents registered.</div>';
    }

    return `
      <div class="agents-list">
        ${this._agents.map(agent => `
          <div class="agent-card ${this._selectedAgent?.id === agent.id ? 'agent-selected' : ''}"
               onclick="this.getRootNode().host._selectAgent(${JSON.stringify(agent).replace(/"/g, '&quot;')})">
            <div class="agent-header">
              <span class="agent-name">${agent.name || agent.id || 'Unknown'}</span>
              <span class="agent-status ${agent.alive ? 'status-alive' : 'status-dead'}">
                ${agent.alive ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div class="agent-meta">
              ${agent.type ? `<span class="agent-type">${agent.type}</span>` : ''}
              ${agent.pid ? `<span class="agent-pid">PID: ${agent.pid}</span>` : ''}
              ${agent.task ? `<span class="agent-task">Task: ${agent.task}</span>` : ''}
            </div>
            ${this._selectedAgent?.id === agent.id ? `
              <div class="agent-actions">
                ${agent.alive ? `
                  <button class="btn btn-sm btn-warn" onclick="event.stopPropagation(); this.getRootNode().host._pauseAgent('${agent.id || agent.name}')">
                    Pause
                  </button>
                  <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); this.getRootNode().host._killAgent('${agent.id || agent.name}')">
                    Kill
                  </button>
                ` : `
                  <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); this.getRootNode().host._resumeAgent('${agent.id || agent.name}')">
                    Resume
                  </button>
                `}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  _formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return timestamp;
    }
  }

  _getStyles() {
    return `
      :host {
        display: block;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--text-primary, #f5f5f5);
      }

      .council-dashboard {
        padding: 16px;
      }

      .council-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .title {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }

      .badge {
        font-size: 11px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .badge-active {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        border: 1px solid rgba(34, 197, 94, 0.3);
      }

      .badge-inactive {
        background: rgba(107, 114, 128, 0.15);
        color: #9ca3af;
        border: 1px solid rgba(107, 114, 128, 0.3);
      }

      .tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border, #2d2d30);
        margin-bottom: 16px;
      }

      .tab {
        padding: 8px 16px;
        background: none;
        border: none;
        color: var(--text-muted, #6b6b70);
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        border-bottom: 2px solid transparent;
        transition: all 0.15s ease;
      }

      .tab:hover {
        color: var(--text-primary, #f5f5f5);
      }

      .tab.active {
        color: var(--accent, #d97757);
        border-bottom-color: var(--accent, #d97757);
      }

      .btn {
        padding: 6px 14px;
        border: 1px solid var(--border, #2d2d30);
        border-radius: 6px;
        background: var(--bg-tertiary, #232325);
        color: var(--text-primary, #f5f5f5);
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--accent, #d97757);
        border-color: var(--accent, #d97757);
        color: white;
      }

      .btn-primary {
        background: var(--accent, #d97757);
        border-color: var(--accent, #d97757);
        color: white;
      }

      .btn-primary:hover {
        background: var(--accent-light, #e8956f);
      }

      .btn-sm {
        padding: 4px 10px;
        font-size: 11px;
      }

      .btn-warn {
        background: rgba(234, 179, 8, 0.15);
        border-color: rgba(234, 179, 8, 0.3);
        color: #eab308;
      }

      .btn-warn:hover {
        background: rgba(234, 179, 8, 0.3);
      }

      .btn-danger {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.3);
        color: #ef4444;
      }

      .btn-danger:hover {
        background: rgba(239, 68, 68, 0.3);
      }

      /* Overview Grid */
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 20px;
      }

      .stat-card {
        background: var(--bg-card, #1e1e20);
        border: 1px solid var(--border, #2d2d30);
        border-radius: 8px;
        padding: 14px;
      }

      .stat-label {
        font-size: 11px;
        font-weight: 500;
        color: var(--text-muted, #6b6b70);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }

      .stat-value {
        font-size: 24px;
        font-weight: 600;
        line-height: 1.2;
      }

      .stat-sub {
        font-size: 11px;
        color: var(--text-muted, #6b6b70);
        margin-top: 2px;
      }

      .text-green { color: #22c55e; }
      .text-warn { color: #eab308; }
      .text-muted { color: var(--text-muted, #6b6b70); }

      /* Section */
      .section {
        margin-bottom: 20px;
      }

      .section-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 12px;
        color: var(--text-secondary, #a1a1a6);
      }

      /* Bar Chart */
      .bar-chart {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 80px;
        padding: 8px;
        background: var(--bg-card, #1e1e20);
        border: 1px solid var(--border, #2d2d30);
        border-radius: 8px;
      }

      .bar-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        flex: 1;
        min-width: 0;
      }

      .bar {
        width: 100%;
        max-width: 24px;
        border-radius: 3px 3px 0 0;
        transition: height 0.3s ease;
      }

      .bar-active {
        background: var(--accent, #d97757);
      }

      .bar-stagnant {
        background: rgba(234, 179, 8, 0.4);
      }

      .bar-label {
        font-size: 9px;
        color: var(--text-muted, #6b6b70);
        margin-top: 4px;
      }

      /* Decision List */
      .decision-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .decision-card {
        background: var(--bg-card, #1e1e20);
        border: 1px solid var(--border, #2d2d30);
        border-radius: 8px;
        padding: 12px 16px;
        border-left: 3px solid transparent;
      }

      .decision-approved {
        border-left-color: #22c55e;
      }

      .decision-rejected {
        border-left-color: #ef4444;
      }

      .decision-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 6px;
      }

      .decision-result {
        font-weight: 600;
        font-size: 13px;
      }

      .decision-iter {
        font-size: 12px;
        color: var(--text-secondary, #a1a1a6);
      }

      .decision-time {
        font-size: 11px;
        color: var(--text-muted, #6b6b70);
        margin-left: auto;
      }

      .decision-votes {
        display: flex;
        gap: 16px;
        font-size: 12px;
      }

      .vote-approve {
        color: #22c55e;
      }

      .vote-reject {
        color: #ef4444;
      }

      /* Convergence Table */
      .convergence-table {
        background: var(--bg-card, #1e1e20);
        border: 1px solid var(--border, #2d2d30);
        border-radius: 8px;
        overflow: hidden;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      th {
        text-align: left;
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted, #6b6b70);
        border-bottom: 1px solid var(--border, #2d2d30);
        background: var(--bg-tertiary, #232325);
      }

      td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--border, #2d2d30);
      }

      tr:last-child td {
        border-bottom: none;
      }

      .row-warn {
        background: rgba(234, 179, 8, 0.05);
      }

      /* Agent List */
      .agents-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .agent-card {
        background: var(--bg-card, #1e1e20);
        border: 1px solid var(--border, #2d2d30);
        border-radius: 8px;
        padding: 12px 16px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .agent-card:hover {
        border-color: var(--accent, #d97757);
      }

      .agent-selected {
        border-color: var(--accent, #d97757);
        background: rgba(217, 119, 87, 0.05);
      }

      .agent-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }

      .agent-name {
        font-weight: 600;
        font-size: 13px;
      }

      .agent-status {
        font-size: 11px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 10px;
      }

      .status-alive {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      .status-dead {
        background: rgba(107, 114, 128, 0.15);
        color: #9ca3af;
      }

      .agent-meta {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--text-muted, #6b6b70);
      }

      .agent-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--border, #2d2d30);
      }

      /* Empty State */
      .empty-state {
        padding: 40px;
        text-align: center;
        color: var(--text-muted, #6b6b70);
        font-size: 13px;
      }

      /* Error Banner */
      .error-banner {
        margin-top: 12px;
        padding: 10px 14px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 6px;
        color: #ef4444;
        font-size: 12px;
      }
    `;
  }
}

// Register the custom element
if (!customElements.get('loki-council-dashboard')) {
  customElements.define('loki-council-dashboard', LokiCouncilDashboard);
}
