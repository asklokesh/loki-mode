/**
 * @fileoverview Build Pipeline Visualizer - horizontal pipeline showing
 * build stages with status indicators, animated flow dots for active
 * connections, and pulsing animation for the current stage.
 *
 * Stages: Planning -> Scaffolding -> Implementation -> Testing -> Review -> Deploy
 *
 * @example
 * <loki-pipeline-view api-url="http://localhost:57374" theme="dark"></loki-pipeline-view>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/** @type {Array<{id: string, label: string, icon: string}>} */
const PIPELINE_STAGES = [
  { id: 'planning',       label: 'Planning',       icon: 'P' },
  { id: 'scaffolding',    label: 'Scaffolding',    icon: 'S' },
  { id: 'implementation', label: 'Implementation', icon: 'I' },
  { id: 'testing',        label: 'Testing',        icon: 'T' },
  { id: 'review',         label: 'Review',         icon: 'R' },
  { id: 'deploy',         label: 'Deploy',         icon: 'D' },
];

const STAGE_STATUS = {
  waiting:  { color: 'var(--loki-text-muted, #939084)',  bgColor: 'var(--loki-bg-tertiary, #ECEAE3)', label: 'Waiting' },
  active:   { color: 'var(--loki-accent, #553DE9)',      bgColor: 'var(--loki-accent-muted, rgba(85, 61, 233, 0.10))', label: 'Active' },
  complete: { color: 'var(--loki-green, #1FC5A8)',       bgColor: 'var(--loki-green-muted, rgba(31, 197, 168, 0.12))', label: 'Complete' },
  failed:   { color: 'var(--loki-red, #C45B5B)',         bgColor: 'var(--loki-red-muted, rgba(196, 91, 91, 0.12))', label: 'Failed' },
};

/**
 * @class LokiPipelineView
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - Theme name (default: auto-detect)
 */
export class LokiPipelineView extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._stages = [];
    this._api = null;
    this._pollInterval = null;
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
      intervalMs: 5000,
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
    // Capture the api instance so a mid-flight api-url switch can be detected.
    const api = this._api;
    try {
      const data = await api._get('/api/v2/pipeline/status');
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._stages = data.stages || [];
    } catch {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      // Use demo data if API unavailable
      if (this._stages.length === 0) {
        this._stages = this._getDemoData();
      }
    }
    this.render();
  }

  _getDemoData() {
    return [
      { id: 'planning',       status: 'complete', errors: 0, duration_ms: 12500 },
      { id: 'scaffolding',    status: 'complete', errors: 0, duration_ms: 8300 },
      { id: 'implementation', status: 'active',   errors: 0, duration_ms: 45000 },
      { id: 'testing',        status: 'waiting',  errors: 0, duration_ms: null },
      { id: 'review',         status: 'waiting',  errors: 0, duration_ms: null },
      { id: 'deploy',         status: 'waiting',  errors: 0, duration_ms: null },
    ];
  }

  _getStageData(stageId) {
    return this._stages.find(s => s.id === stageId) || { id: stageId, status: 'waiting', errors: 0 };
  }

  _formatDuration(ms) {
    if (ms == null || ms < 0) return '';
    if (ms < 1000) return ms + 'ms';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    const remainSec = sec % 60;
    return min + 'm ' + remainSec + 's';
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .pipeline-container {
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

      .pipeline-track {
        display: flex;
        align-items: center;
        gap: 0;
        padding: 20px 12px;
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        overflow-x: auto;
      }

      .stage-node {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        min-width: 90px;
        flex-shrink: 0;
      }

      .stage-circle {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: 700;
        transition: all 0.3s;
        position: relative;
      }

      .stage-circle.active {
        animation: stagePulse 2s ease-in-out infinite;
      }

      @keyframes stagePulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(85, 61, 233, 0.3); }
        50% { box-shadow: 0 0 0 10px rgba(85, 61, 233, 0); }
      }

      .stage-check {
        font-size: 18px;
        line-height: 1;
      }

      .stage-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--loki-text-secondary, #36342E);
        text-align: center;
        max-width: 90px;
      }

      .stage-duration {
        font-size: 10px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-muted, #939084);
      }

      .stage-error-count {
        font-size: 10px;
        font-weight: 600;
        color: var(--loki-red, #C45B5B);
        background: var(--loki-red-muted, rgba(196, 91, 91, 0.12));
        padding: 1px 6px;
        border-radius: 4px;
      }

      .connector {
        flex: 1;
        height: 3px;
        min-width: 24px;
        position: relative;
        overflow: hidden;
        margin: 0 -2px;
        align-self: center;
        margin-bottom: 36px;
      }

      .connector-line {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        border-radius: 2px;
      }

      .connector-line.completed {
        background: var(--loki-green, #1FC5A8);
      }

      .connector-line.pending {
        background: var(--loki-border, #ECEAE3);
      }

      .connector-line.active {
        background: var(--loki-border, #ECEAE3);
      }

      .flow-dot {
        position: absolute;
        top: -1px;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--loki-accent, #553DE9);
        animation: flowDot 1.5s linear infinite;
      }

      @keyframes flowDot {
        0% { left: 0; opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { left: 100%; opacity: 0; }
      }

      .status-legend {
        display: flex;
        gap: 16px;
        margin-top: 14px;
        flex-wrap: wrap;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
      }

      .legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const stageNodes = PIPELINE_STAGES.map((stage, idx) => {
      const data = this._getStageData(stage.id);
      const statusCfg = STAGE_STATUS[data.status] || STAGE_STATUS.waiting;
      const isComplete = data.status === 'complete';
      const isActive = data.status === 'active';
      const isFailed = data.status === 'failed';

      const circleContent = isComplete
        ? '<span class="stage-check">&#10003;</span>'
        : (isFailed ? '<span class="stage-check">&#10007;</span>' : stage.icon);

      const stageHtml = `
        <div class="stage-node">
          <div class="stage-circle ${isActive ? 'active' : ''}"
               style="background: ${statusCfg.bgColor}; color: ${statusCfg.color}; border: 2px solid ${statusCfg.color};">
            ${circleContent}
          </div>
          <span class="stage-label">${stage.label}</span>
          ${data.duration_ms ? `<span class="stage-duration">${this._formatDuration(data.duration_ms)}</span>` : ''}
          ${data.errors > 0 ? `<span class="stage-error-count">${data.errors} error${data.errors > 1 ? 's' : ''}</span>` : ''}
        </div>
      `;

      // Add connector after each stage except the last
      if (idx < PIPELINE_STAGES.length - 1) {
        const nextData = this._getStageData(PIPELINE_STAGES[idx + 1].id);
        const isConnectorCompleted = isComplete;
        const isConnectorActive = isActive || (isComplete && (nextData.status === 'active' || nextData.status === 'waiting'));

        const connectorClass = isConnectorCompleted ? 'completed' : (isActive ? 'active' : 'pending');
        const flowDot = isActive ? '<div class="flow-dot"></div>' : '';

        return stageHtml + `
          <div class="connector">
            <div class="connector-line ${connectorClass}"></div>
            ${flowDot}
          </div>
        `;
      }

      return stageHtml;
    }).join('');

    const legendItems = Object.entries(STAGE_STATUS).map(([key, cfg]) => {
      return `<div class="legend-item">
        <div class="legend-dot" style="background: ${cfg.color};"></div>
        <span>${cfg.label}</span>
      </div>`;
    }).join('');

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="pipeline-container">
        <div class="header">
          <h3 class="title">Build Pipeline</h3>
        </div>
        <div class="pipeline-track">
          ${stageNodes}
        </div>
        <div class="status-legend">
          ${legendItems}
        </div>
      </div>
    `;
  }
}

if (!customElements.get('loki-pipeline-view')) {
  customElements.define('loki-pipeline-view', LokiPipelineView);
}

export default LokiPipelineView;
