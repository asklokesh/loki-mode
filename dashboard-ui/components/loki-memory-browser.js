/**
 * @fileoverview Loki Memory Browser Component - tabbed browser for the
 * Loki Mode memory system covering episodic, semantic, and procedural
 * memory layers. Includes summary view, detail panels, token economics,
 * and memory consolidation controls.
 *
 * @example
 * <loki-memory-browser api-url="http://localhost:57374" theme="dark" tab="summary"></loki-memory-browser>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Array<{id: string, label: string, icon: string}>} Tab definitions with SVG path data */
const TABS = [
  { id: 'summary', label: 'Summary', icon: 'M4 6h16M4 12h16M4 18h16' },
  { id: 'episodes', label: 'Episodes', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'patterns', label: 'Patterns', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { id: 'skills', label: 'Skills', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
];

/**
 * @class LokiMemoryBrowser
 * @extends LokiElement
 * @fires episode-select - When an episode item is clicked
 * @fires pattern-select - When a pattern item is clicked
 * @fires skill-select - When a skill item is clicked
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 * @property {string} tab - Initial active tab ('summary'|'episodes'|'patterns'|'skills')
 */
export class LokiMemoryBrowser extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme', 'tab'];
  }

  constructor() {
    super();
    this._activeTab = 'summary';
    this._loading = false;
    this._error = null;
    this._api = null;

    // Data
    this._summary = null;
    this._episodes = [];
    this._patterns = [];
    this._skills = [];
    this._tokenEconomics = null;
    this._selectedItem = null;
    this._lastFocusedElement = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._activeTab = this.getAttribute('tab') || 'summary';
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
      case 'tab':
        this._setTab(newValue);
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
      // Load summary first
      this._summary = await this._api.getMemorySummary().catch(() => null);
      this._tokenEconomics = await this._api.getTokenEconomics().catch(() => null);

      // Load tab-specific data
      await this._loadTabData();
    } catch (error) {
      this._error = error.message || 'Failed to load memory data';
    }

    this._loading = false;
    this.render();
  }

  async _loadTabData() {
    switch (this._activeTab) {
      case 'episodes':
        this._episodes = await this._api.listEpisodes({ limit: 50 }).catch(() => []);
        break;
      case 'patterns':
        this._patterns = await this._api.listPatterns().catch(() => []);
        break;
      case 'skills':
        this._skills = await this._api.listSkills().catch(() => []);
        break;
    }
  }

  _setTab(tab) {
    if (this._activeTab === tab) return;

    this._activeTab = tab;
    this._selectedItem = null;
    this._loadTabData().then(() => this.render());
  }

  async _selectEpisode(episodeId) {
    try {
      this._lastFocusedElement = this.shadowRoot.activeElement;
      this._selectedItem = await this._api.getEpisode(episodeId);
      this.dispatchEvent(new CustomEvent('episode-select', { detail: this._selectedItem }));
      this.render();
      this._focusDetailPanel();
    } catch (error) {
      console.error('Failed to load episode:', error);
    }
  }

  async _selectPattern(patternId) {
    try {
      this._lastFocusedElement = this.shadowRoot.activeElement;
      this._selectedItem = await this._api.getPattern(patternId);
      this.dispatchEvent(new CustomEvent('pattern-select', { detail: this._selectedItem }));
      this.render();
      this._focusDetailPanel();
    } catch (error) {
      console.error('Failed to load pattern:', error);
    }
  }

  async _selectSkill(skillId) {
    try {
      this._lastFocusedElement = this.shadowRoot.activeElement;
      this._selectedItem = await this._api.getSkill(skillId);
      this.dispatchEvent(new CustomEvent('skill-select', { detail: this._selectedItem }));
      this.render();
      this._focusDetailPanel();
    } catch (error) {
      console.error('Failed to load skill:', error);
    }
  }

  _focusDetailPanel() {
    requestAnimationFrame(() => {
      const closeBtn = this.shadowRoot.getElementById('close-detail');
      if (closeBtn) {
        closeBtn.focus();
      }
    });
  }

  _closeDetail() {
    this._selectedItem = null;
    this.render();
    // Return focus to last focused element
    if (this._lastFocusedElement) {
      requestAnimationFrame(() => {
        this._lastFocusedElement.focus();
        this._lastFocusedElement = null;
      });
    }
  }

  async _triggerConsolidation() {
    try {
      const result = await this._api.consolidateMemory(24);
      alert(`Consolidation complete:\n- Patterns created: ${result.patternsCreated}\n- Patterns merged: ${result.patternsMerged}\n- Episodes processed: ${result.episodesProcessed}`);
      this._loadData();
    } catch (error) {
      alert('Consolidation failed: ' + error.message);
    }
  }

  _renderSummary() {
    if (!this._summary) {
      return '<div class="empty-state">No memory data available</div>';
    }

    const { episodic, semantic, procedural, tokenEconomics } = this._summary;

    return `
      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Episodic Memory</span>
            <span class="summary-card-count">${episodic?.count || 0}</span>
          </div>
          <div class="summary-card-detail">
            Specific interaction traces and outcomes
          </div>
          ${episodic?.latestDate ? `<div class="summary-card-meta">Latest: ${new Date(episodic.latestDate).toLocaleDateString()}</div>` : ''}
          <div class="memory-bar">
            <div class="memory-bar-fill episodic" style="width: ${Math.min((episodic?.count || 0) / 100 * 100, 100)}%"></div>
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Semantic Memory</span>
            <span class="summary-card-count">${semantic?.patterns || 0}</span>
          </div>
          <div class="summary-card-detail">
            Generalized patterns and anti-patterns
          </div>
          <div class="summary-card-meta">Anti-patterns: ${semantic?.antiPatterns || 0}</div>
          <div class="memory-bar">
            <div class="memory-bar-fill semantic" style="width: ${Math.min((semantic?.patterns || 0) / 100 * 100, 100)}%"></div>
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-card-header">
            <span class="summary-card-title">Procedural Memory</span>
            <span class="summary-card-count">${procedural?.skills || 0}</span>
          </div>
          <div class="summary-card-detail">
            Learned skills and procedures
          </div>
          <div class="memory-bar">
            <div class="memory-bar-fill procedural" style="width: ${Math.min((procedural?.skills || 0) / 100 * 100, 100)}%"></div>
          </div>
        </div>

        ${this._tokenEconomics ? `
          <div class="summary-card token-economics">
            <div class="summary-card-header">
              <span class="summary-card-title">Token Economics</span>
            </div>
            <div class="economics-stats">
              <div class="econ-stat">
                <span class="econ-label">Discovery</span>
                <span class="econ-value">${this._tokenEconomics.discoveryTokens?.toLocaleString() || 0}</span>
              </div>
              <div class="econ-stat">
                <span class="econ-label">Read</span>
                <span class="econ-value">${this._tokenEconomics.readTokens?.toLocaleString() || 0}</span>
              </div>
              <div class="econ-stat">
                <span class="econ-label">Savings</span>
                <span class="econ-value savings">${(this._tokenEconomics.savingsPercent || 0).toFixed(1)}%</span>
              </div>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="summary-actions">
        <button class="btn btn-secondary" id="consolidate-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          Consolidate Memory
        </button>
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

  _renderEpisodes() {
    if (this._episodes.length === 0) {
      return '<div class="empty-state">No episodes recorded yet</div>';
    }

    return `
      <div class="item-list" role="list" aria-label="Episodes list">
        ${this._episodes.map(ep => `
          <div class="item-card" data-id="${ep.id}" data-type="episode" tabindex="0" role="listitem" aria-label="Episode ${ep.id}: ${this._escapeHtml(ep.taskId || 'Task')}, outcome ${ep.outcome || 'unknown'}">
            <div class="item-header">
              <span class="item-id mono">${ep.id}</span>
              <span class="item-outcome ${ep.outcome?.toLowerCase()}">${ep.outcome || 'unknown'}</span>
            </div>
            <div class="item-title">${this._escapeHtml(ep.taskId || 'Task')}</div>
            <div class="item-meta">
              <span>${ep.agent || 'unknown agent'}</span>
              <span>${ep.phase || 'unknown phase'}</span>
              <span>${new Date(ep.timestamp).toLocaleString()}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  _renderPatterns() {
    if (this._patterns.length === 0) {
      return '<div class="empty-state">No patterns discovered yet</div>';
    }

    return `
      <div class="item-list" role="list" aria-label="Patterns list">
        ${this._patterns.map(pat => `
          <div class="item-card" data-id="${pat.id}" data-type="pattern" tabindex="0" role="listitem" aria-label="Pattern: ${this._escapeHtml(pat.pattern)}, ${(pat.confidence * 100).toFixed(0)} percent confidence">
            <div class="item-header">
              <span class="item-category">${pat.category || 'general'}</span>
              <span class="confidence-badge">${(pat.confidence * 100).toFixed(0)}%</span>
            </div>
            <div class="item-title">${this._escapeHtml(pat.pattern)}</div>
            <div class="item-meta">
              <span>Used ${pat.usageCount || 0} times</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  _renderSkills() {
    if (this._skills.length === 0) {
      return '<div class="empty-state">No skills learned yet</div>';
    }

    return `
      <div class="item-list" role="list" aria-label="Skills list">
        ${this._skills.map(skill => `
          <div class="item-card" data-id="${skill.id}" data-type="skill" tabindex="0" role="listitem" aria-label="Skill: ${this._escapeHtml(skill.name)}">
            <div class="item-header">
              <span class="item-id mono">${skill.id}</span>
            </div>
            <div class="item-title">${this._escapeHtml(skill.name)}</div>
            <div class="item-description">${this._escapeHtml(skill.description || '')}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  _renderDetail() {
    if (!this._selectedItem) return '';

    const item = this._selectedItem;

    // Determine type and render accordingly
    if (item.actionLog !== undefined) {
      // Episode detail
      return `
        <div class="detail-panel">
          <div class="detail-header">
            <h3>Episode: ${item.id}</h3>
            <button class="close-btn" id="close-detail">&times;</button>
          </div>
          <div class="detail-body">
            <div class="detail-row">
              <span class="detail-label">Task</span>
              <span class="detail-value">${item.taskId || '--'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Agent</span>
              <span class="detail-value">${item.agent || '--'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Phase</span>
              <span class="detail-value">${item.phase || '--'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Outcome</span>
              <span class="detail-value outcome ${item.outcome?.toLowerCase()}">${item.outcome || '--'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Duration</span>
              <span class="detail-value">${item.durationSeconds || 0}s</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Tokens Used</span>
              <span class="detail-value">${item.tokensUsed?.toLocaleString() || 0}</span>
            </div>
            ${item.goal ? `
              <div class="detail-section">
                <div class="detail-label">Goal</div>
                <div class="detail-content">${this._escapeHtml(item.goal)}</div>
              </div>
            ` : ''}
            ${item.actionLog?.length ? `
              <div class="detail-section">
                <div class="detail-label">Action Log (${item.actionLog.length})</div>
                <div class="action-log">
                  ${item.actionLog.map(a => `
                    <div class="action-entry">
                      <span class="action-time">+${a.t}s</span>
                      <span class="action-type">${a.action}</span>
                      <span class="action-target">${this._escapeHtml(a.target)}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    } else if (item.conditions !== undefined) {
      // Pattern detail
      return `
        <div class="detail-panel">
          <div class="detail-header">
            <h3>Pattern: ${item.id}</h3>
            <button class="close-btn" id="close-detail">&times;</button>
          </div>
          <div class="detail-body">
            <div class="detail-row">
              <span class="detail-label">Category</span>
              <span class="detail-value">${item.category || 'general'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Confidence</span>
              <span class="detail-value">${(item.confidence * 100).toFixed(0)}%</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Usage Count</span>
              <span class="detail-value">${item.usageCount || 0}</span>
            </div>
            <div class="detail-section">
              <div class="detail-label">Pattern</div>
              <div class="detail-content">${this._escapeHtml(item.pattern)}</div>
            </div>
            ${item.conditions?.length ? `
              <div class="detail-section">
                <div class="detail-label">Conditions</div>
                <ul class="detail-list">
                  ${item.conditions.map(c => `<li>${this._escapeHtml(c)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${item.correctApproach ? `
              <div class="detail-section">
                <div class="detail-label">Correct Approach</div>
                <div class="detail-content success">${this._escapeHtml(item.correctApproach)}</div>
              </div>
            ` : ''}
            ${item.incorrectApproach ? `
              <div class="detail-section">
                <div class="detail-label">Incorrect Approach</div>
                <div class="detail-content error">${this._escapeHtml(item.incorrectApproach)}</div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    } else if (item.steps !== undefined) {
      // Skill detail
      return `
        <div class="detail-panel">
          <div class="detail-header">
            <h3>Skill: ${item.name}</h3>
            <button class="close-btn" id="close-detail">&times;</button>
          </div>
          <div class="detail-body">
            <div class="detail-section">
              <div class="detail-label">Description</div>
              <div class="detail-content">${this._escapeHtml(item.description)}</div>
            </div>
            ${item.prerequisites?.length ? `
              <div class="detail-section">
                <div class="detail-label">Prerequisites</div>
                <ul class="detail-list">
                  ${item.prerequisites.map(p => `<li>${this._escapeHtml(p)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${item.steps?.length ? `
              <div class="detail-section">
                <div class="detail-label">Steps</div>
                <ol class="detail-list numbered">
                  ${item.steps.map(s => `<li>${this._escapeHtml(s)}</li>`).join('')}
                </ol>
              </div>
            ` : ''}
            ${item.exitCriteria?.length ? `
              <div class="detail-section">
                <div class="detail-label">Exit Criteria</div>
                <ul class="detail-list">
                  ${item.exitCriteria.map(e => `<li>${this._escapeHtml(e)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }

    return '';
  }

  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  render() {
    const styles = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .memory-browser {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          overflow: hidden;
        }

        .browser-header {
          padding: 12px 16px;
          border-bottom: 1px solid var(--loki-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .browser-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .tabs {
          display: flex;
          gap: 4px;
          padding: 4px;
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          border: 1px solid var(--loki-border);
        }

        .tab {
          padding: 7px 14px;
          font-size: 12px;
          font-weight: 500;
          color: var(--loki-text-secondary);
          cursor: pointer;
          border: none;
          background: none;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: all var(--loki-transition);
          border-radius: 4px;
        }

        .tab:hover {
          color: var(--loki-text-primary);
          background: var(--loki-bg-hover);
        }

        .tab.active {
          color: white;
          background: var(--loki-accent);
        }

        .tab svg {
          width: 14px;
          height: 14px;
          stroke: currentColor;
          stroke-width: 2;
          fill: none;
        }

        .browser-content {
          padding: 16px;
          min-height: 300px;
          max-height: 500px;
          overflow-y: auto;
          display: flex;
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

        /* Summary styles */
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
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
          margin-bottom: 8px;
        }

        .summary-card-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .summary-card-count {
          font-size: 18px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
        }

        .summary-card-detail {
          font-size: 11px;
          color: var(--loki-text-muted);
          margin-bottom: 8px;
        }

        .summary-card-meta {
          font-size: 10px;
          color: var(--loki-text-secondary);
          margin-bottom: 8px;
        }

        .memory-bar {
          height: 4px;
          background: var(--loki-bg-tertiary);
          border-radius: 2px;
          overflow: hidden;
        }

        .memory-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.3s ease;
        }

        .memory-bar-fill.episodic { background: var(--loki-blue); }
        .memory-bar-fill.semantic { background: var(--loki-purple); }
        .memory-bar-fill.procedural { background: var(--loki-green); }

        .token-economics .economics-stats {
          display: flex;
          gap: 16px;
          margin-top: 8px;
        }

        .econ-stat {
          text-align: center;
        }

        .econ-label {
          font-size: 10px;
          color: var(--loki-text-muted);
          display: block;
        }

        .econ-value {
          font-size: 14px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-primary);
        }

        .econ-value.savings {
          color: var(--loki-green);
        }

        .summary-actions {
          display: flex;
          gap: 8px;
          margin-top: 16px;
        }

        /* Item list styles */
        .item-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .item-card {
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 12px;
          cursor: pointer;
          transition: all var(--loki-transition);
        }

        .item-card:hover {
          border-color: var(--loki-border-light);
          transform: translateX(2px);
        }

        .item-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .item-id {
          font-size: 10px;
          color: var(--loki-accent);
        }

        .item-category {
          font-size: 10px;
          padding: 2px 6px;
          background: var(--loki-bg-tertiary);
          border-radius: 3px;
          color: var(--loki-text-secondary);
        }

        .item-outcome {
          font-size: 9px;
          padding: 2px 6px;
          border-radius: 3px;
          text-transform: uppercase;
          font-weight: 500;
        }

        .item-outcome.success { background: var(--loki-green-muted); color: var(--loki-green); }
        .item-outcome.failure { background: var(--loki-red-muted); color: var(--loki-red); }
        .item-outcome.partial { background: var(--loki-yellow-muted); color: var(--loki-yellow); }

        .confidence-badge {
          font-size: 10px;
          font-weight: 500;
          color: var(--loki-blue);
        }

        .item-title {
          font-size: 12px;
          font-weight: 500;
          color: var(--loki-text-primary);
          margin-bottom: 4px;
        }

        .item-description {
          font-size: 11px;
          color: var(--loki-text-secondary);
          margin-bottom: 4px;
        }

        .item-meta {
          display: flex;
          gap: 12px;
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        /* Detail panel */
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
          padding: 6px 0;
          border-bottom: 1px solid var(--loki-border);
          font-size: 12px;
        }

        .detail-label {
          color: var(--loki-text-secondary);
          font-weight: 500;
          font-size: 11px;
          margin-bottom: 6px;
        }

        .detail-value {
          color: var(--loki-text-primary);
        }

        .detail-value.outcome.success { color: var(--loki-green); }
        .detail-value.outcome.failure { color: var(--loki-red); }

        .detail-section {
          margin-top: 16px;
        }

        .detail-content {
          background: var(--loki-bg-tertiary);
          padding: 10px;
          border-radius: 4px;
          font-size: 12px;
          color: var(--loki-text-primary);
        }

        .detail-content.success {
          border-left: 3px solid var(--loki-green);
        }

        .detail-content.error {
          border-left: 3px solid var(--loki-red);
        }

        .detail-list {
          padding-left: 20px;
          font-size: 12px;
          color: var(--loki-text-primary);
        }

        .detail-list li {
          margin-bottom: 4px;
        }

        .action-log {
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          padding: 8px;
          max-height: 200px;
          overflow-y: auto;
        }

        .action-entry {
          display: flex;
          gap: 8px;
          font-size: 11px;
          padding: 4px 0;
          border-bottom: 1px solid var(--loki-border);
        }

        .action-entry:last-child {
          border-bottom: none;
        }

        .action-time {
          color: var(--loki-text-muted);
          font-family: 'JetBrains Mono', monospace;
        }

        .action-type {
          color: var(--loki-blue);
          font-weight: 500;
        }

        .action-target {
          color: var(--loki-text-secondary);
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
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
      content = '<div class="loading">Loading memory data...</div>';
    } else if (this._error) {
      content = `<div class="error-state">Error: ${this._escapeHtml(this._error)}</div>`;
    } else {
      let tabContent;
      switch (this._activeTab) {
        case 'summary':
          tabContent = this._renderSummary();
          break;
        case 'episodes':
          tabContent = this._renderEpisodes();
          break;
        case 'patterns':
          tabContent = this._renderPatterns();
          break;
        case 'skills':
          tabContent = this._renderSkills();
          break;
        default:
          tabContent = this._renderSummary();
      }

      content = `
        <div class="content-main">${tabContent}</div>
        ${this._renderDetail()}
      `;
    }

    this.shadowRoot.innerHTML = `
      ${styles}
      <div class="memory-browser">
        <div class="browser-header">
          <span class="browser-title">Memory System</span>
        </div>
        <div class="tabs" role="tablist" aria-label="Memory browser sections">
          ${TABS.map((tab, index) => `
            <button class="tab ${this._activeTab === tab.id ? 'active' : ''}"
                    data-tab="${tab.id}"
                    role="tab"
                    id="tab-${tab.id}"
                    aria-selected="${this._activeTab === tab.id}"
                    aria-controls="tabpanel-${tab.id}"
                    tabindex="${this._activeTab === tab.id ? '0' : '-1'}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${tab.icon}"/></svg>
              ${tab.label}
            </button>
          `).join('')}
        </div>
        <div class="browser-content" role="tabpanel" id="tabpanel-${this._activeTab}" aria-labelledby="tab-${this._activeTab}">
          ${content}
        </div>
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    // Tab buttons with keyboard navigation
    const tabs = this.shadowRoot.querySelectorAll('.tab');
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => this._setTab(tab.dataset.tab));
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const tabsArray = Array.from(tabs);
          const targetIndex = e.key === 'ArrowRight'
            ? (index + 1) % tabsArray.length
            : (index - 1 + tabsArray.length) % tabsArray.length;
          tabsArray[targetIndex].focus();
          this._setTab(tabsArray[targetIndex].dataset.tab);
        }
      });
    });

    // Item cards with keyboard navigation
    this.shadowRoot.querySelectorAll('.item-card').forEach(card => {
      card.addEventListener('click', () => this._handleItemClick(card));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._handleItemClick(card);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._navigateItemCards(card, e.key === 'ArrowDown' ? 'next' : 'prev');
        }
      });
    });

    // Close detail button
    const closeBtn = this.shadowRoot.getElementById('close-detail');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeDetail());
    }

    // Consolidate button
    const consolidateBtn = this.shadowRoot.getElementById('consolidate-btn');
    if (consolidateBtn) {
      consolidateBtn.addEventListener('click', () => this._triggerConsolidation());
    }

    // Refresh button
    const refreshBtn = this.shadowRoot.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._loadData());
    }
  }

  _handleItemClick(card) {
    const id = card.dataset.id;
    const type = card.dataset.type;

    switch (type) {
      case 'episode':
        this._selectEpisode(id);
        break;
      case 'pattern':
        this._selectPattern(id);
        break;
      case 'skill':
        this._selectSkill(id);
        break;
    }
  }

  _navigateItemCards(currentCard, direction) {
    const cards = Array.from(this.shadowRoot.querySelectorAll('.item-card'));
    const currentIndex = cards.indexOf(currentCard);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
    if (targetIndex >= 0 && targetIndex < cards.length) {
      cards[targetIndex].focus();
    }
  }
}

// Register the component
if (!customElements.get('loki-memory-browser')) {
  customElements.define('loki-memory-browser', LokiMemoryBrowser);
}

export default LokiMemoryBrowser;
