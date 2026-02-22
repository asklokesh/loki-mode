/**
 * @fileoverview RARV Cycle Timeline Visualization - displays a horizontal
 * timeline of RARV phases (Reason, Act, Reflect, Verify) for a given run.
 * Shows duration for each phase and highlights the current phase for
 * active runs.
 *
 * @example
 * <loki-rarv-timeline run-id="42" api-url="http://localhost:57374" theme="dark"></loki-rarv-timeline>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Object<string, {color: string, label: string}>} */
const PHASE_CONFIG = {
  reason:  { color: 'var(--loki-blue, #3b82f6)',   label: 'Reason' },
  act:     { color: 'var(--loki-green, #22c55e)',   label: 'Act' },
  reflect: { color: 'var(--loki-purple, #a78bfa)',  label: 'Reflect' },
  verify:  { color: 'var(--loki-yellow, #eab308)',  label: 'Verify' },
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
      this._api.baseUrl = newValue;
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
    this._pollInterval = setInterval(() => this._loadData(), 5000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) {
          clearInterval(this._pollInterval);
          this._pollInterval = null;
        }
      } else {
        if (!this._pollInterval) {
          this._loadData();
          this._pollInterval = setInterval(() => this._loadData(), 5000);
        }
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  async _loadData() {
    const runId = this.runId;
    if (runId == null) {
      this._timeline = null;
      this.render();
      return;
    }

    try {
      this._loading = true;
      const data = await this._api._get(`/api/v2/runs/${runId}/timeline`);
      this._timeline = data;
      this._error = null;
    } catch (err) {
      this._error = `Failed to load timeline: ${err.message}`;
    } finally {
      this._loading = false;
    }

    this.render();
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .timeline-container {
        padding: 16px;
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #fafafa);
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
        color: var(--loki-text-muted, #52525b);
        font-family: 'JetBrains Mono', monospace;
      }

      .timeline-bar {
        display: flex;
        width: 100%;
        height: 32px;
        border-radius: 6px;
        overflow: hidden;
        background: var(--loki-bg-tertiary, #111114);
        margin-bottom: 12px;
      }

      .phase-segment {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 600;
        color: white;
        transition: all 0.3s ease;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 4px;
      }

      .phase-segment.current {
        animation: phase-pulse 1.5s ease-in-out infinite;
      }

      @keyframes phase-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: 8px;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }

      .legend-dot {
        width: 10px;
        height: 10px;
        border-radius: 3px;
        flex-shrink: 0;
      }

      .legend-label {
        font-weight: 500;
        color: var(--loki-text-secondary, #a1a1aa);
      }

      .legend-duration {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--loki-text-muted, #52525b);
      }

      .phase-current-tag {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 3px;
        background: var(--loki-accent-muted, rgba(139, 92, 246, 0.15));
        color: var(--loki-accent, #8b5cf6);
        font-weight: 500;
        margin-left: 4px;
      }

      .empty-state {
        text-align: center;
        padding: 32px;
        color: var(--loki-text-muted, #52525b);
        font-size: 13px;
      }

      .error-banner {
        margin-top: 12px;
        padding: 8px 12px;
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
        border-radius: 6px;
        font-size: 12px;
      }

      .loading {
        text-align: center;
        padding: 24px;
        color: var(--loki-text-muted, #52525b);
        font-size: 13px;
      }
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
      content = '<div class="empty-state">No run selected. Set the run-id attribute to view a timeline.</div>';
    } else if (phases.length === 0) {
      content = '<div class="empty-state">No RARV phases recorded for this run yet.</div>';
    } else {
      const barSegments = phaseWidths.map(pw => {
        const cfg = PHASE_CONFIG[pw.phase] || { color: 'var(--loki-text-muted)', label: pw.phase };
        const isCurrent = currentPhase === pw.phase;
        return `<div class="phase-segment ${isCurrent ? 'current' : ''}"
                     style="width: ${Math.max(pw.pct, 2)}%; background: ${cfg.color};"
                     title="${cfg.label}: ${formatDuration(pw.duration)}">
                  ${pw.pct > 12 ? cfg.label : ''}
                </div>`;
      }).join('');

      const legendItems = phases.map(p => {
        const cfg = PHASE_CONFIG[p.phase] || { color: 'var(--loki-text-muted)', label: p.phase };
        const isCurrent = currentPhase === p.phase;
        return `<div class="legend-item">
                  <span class="legend-dot" style="background: ${cfg.color}"></span>
                  <span class="legend-label">${cfg.label}</span>
                  <span class="legend-duration">${formatDuration(p.duration_ms)}</span>
                  ${isCurrent ? '<span class="phase-current-tag">ACTIVE</span>' : ''}
                </div>`;
      }).join('');

      content = `
        <div class="timeline-bar">${barSegments}</div>
        <div class="legend">${legendItems}</div>
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
  }
}

if (!customElements.get('loki-rarv-timeline')) {
  customElements.define('loki-rarv-timeline', LokiRarvTimeline);
}

export default LokiRarvTimeline;
