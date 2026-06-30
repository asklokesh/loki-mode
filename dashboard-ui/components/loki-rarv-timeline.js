/**
 * @fileoverview Interactive RARV Cycle Timeline Visualization - displays a
 * horizontal timeline of RARV phases (Reason, Act, Reflect, Verify) with
 * click-to-inspect detail panels showing time spent, tokens used, quality
 * metrics, and cycle history. Current phase glows and pulses.
 *
 * @example
 * <loki-rarv-timeline run-id="42" api-url="http://localhost:57374" theme="dark"></loki-rarv-timeline>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/** @type {Object<string, {color: string, label: string, description: string}>} */
const PHASE_CONFIG = {
  reason:  { color: 'var(--loki-blue, #3b82f6)',   label: 'Reason',  description: 'Analyzing requirements and planning approach' },
  act:     { color: 'var(--loki-green, #22c55e)',   label: 'Act',     description: 'Implementing changes and executing tasks' },
  reflect: { color: 'var(--loki-purple, #a78bfa)',  label: 'Reflect', description: 'Reviewing results and evaluating quality' },
  verify:  { color: 'var(--loki-yellow, #eab308)',  label: 'Verify',  description: 'Running tests and validating correctness' },
};

const PHASE_ORDER = ['reason', 'act', 'reflect', 'verify'];

/**
 * Format a duration in milliseconds to a human-readable string.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
export function formatDuration(ms) {
  if (ms == null || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}m ${remainSec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

/**
 * Compute the percentage width for each phase segment.
 * @param {Array} phases - Array of phase objects with duration_ms
 * @returns {Array<{phase: string, pct: number, duration: number}>}
 */
export function computePhaseWidths(phases) {
  if (!phases || phases.length === 0) return [];
  const totalMs = phases.reduce((sum, p) => sum + (p.duration_ms || 0), 0);
  if (totalMs === 0) {
    return phases.map(p => ({ phase: p.phase, pct: 100 / phases.length, duration: 0 }));
  }
  return phases.map(p => ({
    phase: p.phase,
    pct: ((p.duration_ms || 0) / totalMs) * 100,
    duration: p.duration_ms || 0,
  }));
}

/**
 * Format token count to compact display.
 * @param {number} n - Token count
 * @returns {string} Formatted count
 */
function formatTokens(n) {
  if (n == null) return '--';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/**
 * @class LokiRarvTimeline
 * @extends LokiElement
 * @property {string} run-id - The run ID to fetch timeline for
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 */
export class LokiRarvTimeline extends LokiElement {
  static get observedAttributes() {
    return ['run-id', 'api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._timeline = null;
    this._pollInterval = null;
    this._selectedPhase = null;
    this._cycleHistory = [];
  }

  get runId() {
    const val = this.getAttribute('run-id');
    return val ? parseInt(val, 10) : null;
  }

  set runId(val) {
    if (val != null) {
      this.setAttribute('run-id', String(val));
    } else {
      this.removeAttribute('run-id');
    }
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
    if (name === 'run-id') {
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
    const runId = this.runId;
    if (runId == null) {
      this._timeline = null;
      this.render();
      return;
    }

    // Drop a stale response if the api-url switched mid-flight.
    const api = this._api;
    try {
      this._loading = true;
      const data = await api._get(`/api/v2/runs/${runId}/timeline`);
      if (api !== this._api) return;
      this._timeline = data;
      this._cycleHistory = data.history || [];
      this._error = null;
    } catch (err) {
      if (api !== this._api) return;
      // 404 means run not found -- not a real error, just no data yet
      if (err.message && (err.message.includes('404') || err.message.includes('Not Found'))) {
        this._timeline = null;
        this._error = null;
      } else {
        this._error = `Failed to load timeline: ${err.message}`;
      }
    } finally {
      this._loading = false;
    }

    this.render();
  }

  _selectPhase(phase) {
    this._selectedPhase = this._selectedPhase === phase ? null : phase;
    this.render();
  }

  _bindEvents() {
    const root = this.shadowRoot;

    // Clickable phase segments
    root.querySelectorAll('.phase-segment-interactive').forEach(seg => {
      seg.addEventListener('click', () => {
        this._selectPhase(seg.dataset.phase);
      });
    });

    // Legend items are also clickable
    root.querySelectorAll('.legend-item-interactive').forEach(item => {
      item.addEventListener('click', () => {
        this._selectPhase(item.dataset.phase);
      });
    });

    // Close detail panel
    root.querySelectorAll('.close-detail').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectedPhase = null;
        this.render();
      });
    });
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .timeline-container {
        padding: 16px;
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

      .run-label {
        font-size: 12px;
        color: var(--loki-text-muted, #939084);
        font-family: 'JetBrains Mono', monospace;
      }

      .timeline-bar {
        display: flex;
        width: 100%;
        height: 40px;
        border-radius: 5px;
        overflow: hidden;
        background: var(--loki-bg-tertiary, #ECEAE3);
        margin-bottom: 12px;
      }

      .phase-segment-interactive {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 600;
        color: white;
        transition: all 0.3s ease;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 6px;
        cursor: pointer;
        position: relative;
      }

      .phase-segment-interactive:hover {
        filter: brightness(1.15);
      }

      .phase-segment-interactive.selected {
        filter: brightness(1.2);
        outline: 2px solid white;
        outline-offset: -2px;
      }

      .phase-segment-interactive.current {
        animation: phase-glow 2s ease-in-out infinite;
      }

      @keyframes phase-glow {
        0%, 100% { opacity: 1; filter: brightness(1); }
        50% { opacity: 0.85; filter: brightness(1.2); }
      }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: 8px;
      }

      .legend-item-interactive {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: background 0.2s;
      }

      .legend-item-interactive:hover {
        background: var(--loki-bg-hover, #F3EFE9);
      }

      .legend-item-interactive.selected {
        background: var(--loki-bg-tertiary, #ECEAE3);
      }

      .legend-dot {
        width: 10px;
        height: 10px;
        border-radius: 3px;
        flex-shrink: 0;
      }

      .legend-label {
        font-weight: 500;
        color: var(--loki-text-secondary, #36342E);
      }

      .legend-duration {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
      }

      .phase-current-tag {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 3px;
        background: var(--loki-accent-muted, rgba(139, 92, 246, 0.15));
        color: var(--loki-accent, #553DE9);
        font-weight: 500;
        margin-left: 4px;
      }

      /* Phase detail panel */
      .phase-detail {
        margin-top: 12px;
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        padding: 16px;
        animation: detailSlideIn 0.2s ease-out;
      }

      @keyframes detailSlideIn {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .detail-title {
        font-size: 14px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .detail-title-dot {
        width: 12px;
        height: 12px;
        border-radius: 3px;
      }

      .detail-description {
        font-size: 12px;
        color: var(--loki-text-muted, #939084);
        margin-bottom: 14px;
      }

      .close-detail {
        background: none;
        border: none;
        font-size: 14px;
        color: var(--loki-text-muted, #939084);
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 3px;
        font-family: inherit;
      }

      .close-detail:hover {
        background: var(--loki-bg-hover, #F3EFE9);
        color: var(--loki-text-primary, #201515);
      }

      .detail-metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }

      .detail-metric {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .detail-metric-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
      }

      .detail-metric-value {
        font-size: 16px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-primary, #201515);
      }

      /* Cycle history */
      .cycle-history {
        margin-top: 16px;
        padding-top: 14px;
        border-top: 1px solid var(--loki-border, #ECEAE3);
      }

      .history-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
        margin-bottom: 10px;
      }

      .history-cycles {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
      }

      .history-cycle {
        display: flex;
        gap: 2px;
      }

      .history-dot {
        width: 14px;
        height: 14px;
        border-radius: 3px;
        opacity: 0.6;
        transition: opacity 0.2s;
      }

      .history-dot:hover {
        opacity: 1;
      }

      .history-separator {
        width: 1px;
        height: 14px;
        background: var(--loki-border, #ECEAE3);
        margin: 0 4px;
        align-self: center;
      }

      .empty-state {
        text-align: center;
        padding: 32px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }

      .error-banner {
        margin-top: 12px;
        padding: 8px 12px;
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
        border-radius: 4px;
        font-size: 12px;
      }

      .loading {
        text-align: center;
        padding: 24px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }
    `;
  }

  _renderPlaceholderTimeline() {
    const segments = PHASE_ORDER.map(phase => {
      const cfg = PHASE_CONFIG[phase];
      return `<div class="phase-segment-interactive"
                   data-phase="${phase}"
                   style="width: 25%; background: ${cfg.color}; opacity: 0.3;"
                   title="${cfg.label}: awaiting data">
                ${cfg.label}
              </div>`;
    }).join('');

    const legendItems = PHASE_ORDER.map(phase => {
      const cfg = PHASE_CONFIG[phase];
      return `<div class="legend-item-interactive" data-phase="${phase}">
                <span class="legend-dot" style="background: ${cfg.color}; opacity: 0.4;"></span>
                <span class="legend-label">${cfg.label}</span>
                <span class="legend-duration">--</span>
              </div>`;
    }).join('');

    return `
      <div class="empty-state" style="padding: 0; text-align: left;">
        <div class="timeline-bar" style="opacity: 0.5;">${segments}</div>
        <div class="legend">${legendItems}</div>
        <div style="text-align: center; margin-top: 12px; font-size: 12px; color: var(--loki-text-muted, #939084);">
          Each step fills in as your build progresses
        </div>
      </div>
    `;
  }

  _renderPhaseDetail(phase) {
    const cfg = PHASE_CONFIG[phase];
    if (!cfg) return '';

    const phases = this._timeline?.phases || [];
    const phaseData = phases.find(p => p.phase === phase);

    return `
      <div class="phase-detail">
        <div class="detail-header">
          <div class="detail-title">
            <div class="detail-title-dot" style="background: ${cfg.color};"></div>
            ${cfg.label} Phase
          </div>
          <button class="close-detail" title="Close">&#10005;</button>
        </div>
        <div class="detail-description">${cfg.description}</div>
        <div class="detail-metrics">
          <div class="detail-metric">
            <span class="detail-metric-label">Time Spent</span>
            <span class="detail-metric-value">${formatDuration(phaseData?.duration_ms)}</span>
          </div>
          <div class="detail-metric">
            <span class="detail-metric-label">Tokens Used</span>
            <span class="detail-metric-value">${formatTokens(phaseData?.tokens_used)}</span>
          </div>
          <div class="detail-metric">
            <span class="detail-metric-label">Quality</span>
            <span class="detail-metric-value">${phaseData?.quality_score != null ? phaseData.quality_score.toFixed(1) : '--'}</span>
          </div>
          <div class="detail-metric">
            <span class="detail-metric-label">Actions</span>
            <span class="detail-metric-value">${phaseData?.action_count != null ? phaseData.action_count : '--'}</span>
          </div>
        </div>
      </div>
    `;
  }

  _renderCycleHistory() {
    if (this._cycleHistory.length === 0) return '';

    const cycles = this._cycleHistory.slice(-8); // Show last 8 cycles
    const cycleHtml = cycles.map((cycle, idx) => {
      const dots = PHASE_ORDER.map(phase => {
        const phaseData = cycle.phases?.find(p => p.phase === phase);
        const cfg = PHASE_CONFIG[phase];
        const status = phaseData?.status || 'pending';
        const opacity = status === 'complete' ? '0.8' : (status === 'active' ? '1' : '0.3');
        return `<div class="history-dot" style="background: ${cfg.color}; opacity: ${opacity};"
                  title="Cycle ${idx + 1}: ${cfg.label} - ${formatDuration(phaseData?.duration_ms)}"></div>`;
      }).join('');

      return `<div class="history-cycle">${dots}</div>`;
    }).join('<div class="history-separator"></div>');

    return `
      <div class="cycle-history">
        <div class="history-label">Past Cycles (${this._cycleHistory.length} total)</div>
        <div class="history-cycles">${cycleHtml}</div>
      </div>
    `;
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const runId = this.runId;
    const timeline = this._timeline;
    const phases = timeline?.phases || [];
    const currentPhase = timeline?.current_phase || null;
    const phaseWidths = computePhaseWidths(phases);

    let content;
    if (this._loading && !timeline) {
      content = '<div class="loading">Loading timeline...</div>';
    } else if (runId == null) {
      content = this._renderPlaceholderTimeline();
    } else if (phases.length === 0) {
      content = this._renderPlaceholderTimeline();
    } else {
      const barSegments = phaseWidths.map(pw => {
        const cfg = PHASE_CONFIG[pw.phase] || { color: 'var(--loki-text-muted)', label: pw.phase };
        const isCurrent = currentPhase === pw.phase;
        const isSelected = this._selectedPhase === pw.phase;
        return `<div class="phase-segment-interactive ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}"
                     data-phase="${pw.phase}"
                     style="width: ${Math.max(pw.pct, 2)}%; background: ${cfg.color};"
                     title="${cfg.label}: ${formatDuration(pw.duration)}">
                  ${pw.pct > 12 ? cfg.label : ''}
                </div>`;
      }).join('');

      const legendItems = phases.map(p => {
        const cfg = PHASE_CONFIG[p.phase] || { color: 'var(--loki-text-muted)', label: p.phase };
        const isCurrent = currentPhase === p.phase;
        const isSelected = this._selectedPhase === p.phase;
        return `<div class="legend-item-interactive ${isSelected ? 'selected' : ''}" data-phase="${p.phase}">
                  <span class="legend-dot" style="background: ${cfg.color}"></span>
                  <span class="legend-label">${cfg.label}</span>
                  <span class="legend-duration">${formatDuration(p.duration_ms)}</span>
                  ${isCurrent ? '<span class="phase-current-tag">ACTIVE</span>' : ''}
                </div>`;
      }).join('');

      const detailPanel = this._selectedPhase ? this._renderPhaseDetail(this._selectedPhase) : '';
      const historyPanel = this._renderCycleHistory();

      content = `
        <div class="timeline-bar">${barSegments}</div>
        <div class="legend">${legendItems}</div>
        ${detailPanel}
        ${historyPanel}
      `;
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="timeline-container">
        <div class="header">
          <h3 class="title">RARV Timeline</h3>
          ${runId != null ? `<span class="run-label">Run #${runId}</span>` : ''}
        </div>
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._bindEvents();
  }
}

if (!customElements.get('loki-rarv-timeline')) {
  customElements.define('loki-rarv-timeline', LokiRarvTimeline);
}

export default LokiRarvTimeline;
