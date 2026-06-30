/**
 * @fileoverview Loki Completion Council Dashboard Component - displays
 * council state, vote history, convergence tracking, and agent management
 * across four tabs: Overview, Decision Log, Convergence, and Agents.
 * Polls council and agent APIs every 3 seconds with visibility-aware
 * pause/resume to avoid unnecessary requests when hidden.
 *
 * @example
 * <loki-council-dashboard api-url="http://localhost:57374" theme="dark"></loki-council-dashboard>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/** @type {Array<{id: string, label: string}>} Council dashboard tab definitions */
const COUNCIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'decisions', label: 'Decision Log' },
  { id: 'convergence', label: 'Convergence' },
  { id: 'agents', label: 'Agents' },
];

/**
 * @class LokiCouncilDashboard
 * @extends LokiElement
 * @fires council-action - When a council action is taken (force-review, kill/pause/resume agent)
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
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
    if (this._pendingRaf) {
      cancelAnimationFrame(this._pendingRaf);
      this._pendingRaf = null;
    }
  }

  async _loadData() {
    // Drop a stale response if the api-url switched mid-flight.
    const api = this._api;
    try {
      const [councilState, verdicts, convergence, agents] = await Promise.allSettled([
        api._get('/api/council/state'),
        api._get('/api/council/verdicts'),
        api._get('/api/council/convergence'),
        api._get('/api/agents'),
      ]);
      if (api !== this._api) return;

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
      if (api !== this._api) return;
      this._error = err.message;
    }

    // Skip full re-render if data hasn't changed (avoids disrupting user interaction)
    const dataHash = JSON.stringify({
      s: this._councilState,
      v: this._verdicts,
      c: this._convergence,
      a: this._agents,
      e: this._error,
    });
    if (dataHash === this._lastDataHash) return;
    this._lastDataHash = dataHash;

    this.render();
  }

  async _forceReview() {
    try {
      await this._api._post('/api/council/force-review');
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
      await this._api._post(`/api/agents/${agentId}/kill`);
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
      await this._api._post(`/api/agents/${agentId}/pause`);
      await this._loadData();
    } catch (err) {
      this._error = `Failed to pause agent: ${err.message}`;
      this.render();
    }
  }

  async _resumeAgent(agentId) {
    try {
      await this._api._post(`/api/agents/${agentId}/resume`);
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

    // Cancel any pending deferred event binding from _renderAgents
    if (this._pendingRaf) {
      cancelAnimationFrame(this._pendingRaf);
      this._pendingRaf = null;
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="council-dashboard">
        <div class="council-header">
          <div class="header-left">
            <h2 class="title">Completion Council</h2>
            ${this._councilState?.enabled !== false
              ? `<span class="badge badge-active">Active</span>`
              : `<span class="badge badge-inactive">Disabled</span>`
            }
          </div>
          <button class="btn btn-primary" id="force-review-btn">
            Force Review
          </button>
        </div>

        <div class="tabs">
          ${COUNCIL_TABS.map(tab => `
            <button
              class="tab ${this._activeTab === tab.id ? 'active' : ''}"
              data-tab="${tab.id}"
            >${tab.label}</button>
          `).join('')}
        </div>

        <div class="tab-content">
          ${this._renderTabContent()}
        </div>

        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    // Force Review button
    const forceBtn = s.getElementById('force-review-btn');
    if (forceBtn) {
      forceBtn.addEventListener('click', () => this._forceReview());
    }

    // Tab buttons
    s.querySelectorAll('.tab[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => this._setTab(tab.dataset.tab));
    });

    // Agent cards (bound in _renderAgents via deferred rAF)
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
      return `<div class="empty-state">No review decisions yet. The council checks for completion every ${this._councilState?.check_interval || 5} build steps.</div>`;
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

    const html = `
      <div class="agents-list">
        ${this._agents.map((agent, idx) => `
          <div class="agent-card ${this._selectedAgent?.id === agent.id ? 'agent-selected' : ''}"
               data-agent-index="${idx}">
            <div class="agent-header">
              <span class="agent-name">${this._escapeHtml(agent.name || agent.id || 'Unknown')}</span>
              <span class="agent-status ${agent.alive ? 'status-alive' : 'status-dead'}">
                ${agent.alive ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div class="agent-meta">
              ${agent.type ? `<span class="agent-type">${this._escapeHtml(agent.type)}</span>` : ''}
              ${agent.pid ? `<span class="agent-pid">PID: ${agent.pid}</span>` : ''}
              ${agent.task ? `<span class="agent-task">Task: ${this._escapeHtml(agent.task)}</span>` : ''}
            </div>
            ${this._selectedAgent?.id === agent.id ? `
              <div class="agent-actions">
                ${agent.alive ? `
                  <button class="btn btn-sm btn-warn" data-action="pause" data-agent-id="${this._escapeHtml(agent.id || agent.name)}">
                    Pause
                  </button>
                  <button class="btn btn-sm btn-danger" data-action="kill" data-agent-id="${this._escapeHtml(agent.id || agent.name)}">
                    Kill
                  </button>
                ` : `
                  <button class="btn btn-sm btn-primary" data-action="resume" data-agent-id="${this._escapeHtml(agent.id || agent.name)}">
                    Resume
                  </button>
                `}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;

    // Defer event binding until after render inserts this HTML.
    // Store rAF id so render() can cancel stale callbacks.
    this._pendingRaf = requestAnimationFrame(() => {
      this._pendingRaf = null;
      const s = this.shadowRoot;
      if (!s) return;
      s.querySelectorAll('.agent-card[data-agent-index]').forEach(card => {
        const idx = parseInt(card.dataset.agentIndex, 10);
        const agent = this._agents[idx];
        if (!agent) return;
        card.addEventListener('click', () => this._selectAgent(agent));
        card.querySelectorAll('[data-action]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const agentId = btn.dataset.agentId;
            if (action === 'pause') this._pauseAgent(agentId);
            else if (action === 'kill') this._killAgent(agentId);
            else if (action === 'resume') this._resumeAgent(agentId);
          });
        });
      });
    });

    return html;
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

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _getStyles() {
    return `
      :host {
        display: block;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--loki-text-primary);
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
        border-radius: 4px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .badge-active {
        background: var(--loki-success-muted);
        color: var(--loki-success);
        border: 1px solid var(--loki-success-muted);
      }

      .badge-inactive {
        background: var(--loki-bg-hover);
        color: var(--loki-text-muted);
        border: 1px solid var(--loki-border-light);
      }

      .tabs {
        display: flex;
        gap: 4px;
        padding: 4px;
        background: var(--loki-bg-secondary);
        border-radius: 5px;
        border: 1px solid var(--loki-border);
        margin-bottom: 16px;
      }

      .tab {
        padding: 7px 14px;
        background: none;
        border: none;
        color: var(--loki-text-muted);
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        border-radius: 4px;
        transition: all 0.15s ease;
      }

      .tab:hover {
        color: var(--loki-text-primary);
        background: var(--loki-bg-hover);
      }

      .tab.active {
        color: white;
        background: var(--loki-accent);
      }

      .btn {
        padding: 6px 14px;
        border: 1px solid var(--loki-border);
        border-radius: 4px;
        background: var(--loki-bg-tertiary);
        color: var(--loki-text-primary);
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--loki-accent);
        border-color: var(--loki-accent);
        color: white;
      }

      .btn-primary {
        background: var(--loki-accent);
        border-color: var(--loki-accent);
        color: white;
      }

      .btn-primary:hover {
        background: var(--loki-accent-hover);
      }

      .btn-sm {
        padding: 4px 10px;
        font-size: 11px;
      }

      .btn-warn {
        background: var(--loki-warning-muted);
        border-color: var(--loki-warning-muted);
        color: var(--loki-warning);
      }

      .btn-warn:hover {
        background: var(--loki-warning-muted);
        opacity: 0.85;
      }

      .btn-danger {
        background: var(--loki-error-muted);
        border-color: var(--loki-error-muted);
        color: var(--loki-error);
      }

      .btn-danger:hover {
        background: var(--loki-error-muted);
        opacity: 0.85;
      }

      /* Overview Grid */
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 20px;
      }

      .stat-card {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 14px;
      }

      .stat-label {
        font-size: 11px;
        font-weight: 500;
        color: var(--loki-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 6px;
      }

      .stat-value {
        font-size: 24px;
        font-weight: 600;
        line-height: 1.2;
        color: var(--loki-accent);
        font-family: 'JetBrains Mono', monospace;
      }

      .stat-sub {
        font-size: 11px;
        color: var(--loki-text-muted);
        margin-top: 2px;
      }

      .text-green { color: var(--loki-success); }
      .text-warn { color: var(--loki-warning); }
      .text-muted { color: var(--loki-text-muted); }

      /* Section */
      .section {
        margin-bottom: 20px;
      }

      .section-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 12px;
        color: var(--loki-text-secondary);
      }

      /* Bar Chart */
      .bar-chart {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 80px;
        padding: 8px;
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
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
        background: var(--loki-accent);
      }

      .bar-stagnant {
        background: var(--loki-warning-muted);
      }

      .bar-label {
        font-size: 9px;
        color: var(--loki-text-muted);
        margin-top: 4px;
      }

      /* Decision List */
      .decision-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .decision-card {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 12px 16px;
        border-left: 3px solid transparent;
      }

      .decision-approved {
        border-left-color: var(--loki-success);
      }

      .decision-rejected {
        border-left-color: var(--loki-error);
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
        color: var(--loki-text-secondary);
      }

      .decision-time {
        font-size: 11px;
        color: var(--loki-text-muted);
        margin-left: auto;
      }

      .decision-votes {
        display: flex;
        gap: 16px;
        font-size: 12px;
      }

      .vote-approve {
        color: var(--loki-success);
      }

      .vote-reject {
        color: var(--loki-error);
      }

      /* Convergence Table */
      .convergence-table {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
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
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        border-bottom: 1px solid var(--loki-border);
        background: var(--loki-bg-tertiary);
      }

      td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--loki-border);
      }

      tr:last-child td {
        border-bottom: none;
      }

      .row-warn {
        background: var(--loki-warning-muted);
      }

      /* Agent List */
      .agents-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .agent-card {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 12px 16px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .agent-card:hover {
        border-color: var(--loki-accent);
      }

      .agent-selected {
        border-color: var(--loki-accent);
        background: var(--loki-accent-muted);
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
        border-radius: 5px;
      }

      .status-alive {
        background: var(--loki-success-muted);
        color: var(--loki-success);
      }

      .status-dead {
        background: var(--loki-bg-hover);
        color: var(--loki-text-muted);
      }

      .agent-meta {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--loki-text-muted);
      }

      .agent-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--loki-border);
      }

      /* Empty State */
      .empty-state {
        padding: 40px;
        text-align: center;
        color: var(--loki-text-muted);
        font-size: 13px;
      }

      /* Error Banner */
      .error-banner {
        margin-top: 12px;
        padding: 10px 14px;
        background: var(--loki-error-muted);
        border: 1px solid var(--loki-error-muted);
        border-radius: 4px;
        color: var(--loki-error);
        font-size: 12px;
      }
    `;
  }
}

// Register the custom element
if (!customElements.get('loki-council-dashboard')) {
  customElements.define('loki-council-dashboard', LokiCouncilDashboard);
}
