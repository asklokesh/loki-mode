/**
 * @fileoverview Loki Session Timeline Component - a horizontal Gantt-style
 * bar chart of MEASURED session phases, with clickable segments and a time
 * axis.
 *
 * G70: Session Timeline (Gantt-style)
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. This component had no measured
 * source, so it invented one. _buildPhasesFromStatus() took a scalar status
 * (uptime, current phase, iteration count) and rotated a hardcoded list
 * ['planning','building','testing','reviewing'], giving each fabricated
 * segment a randomized length:
 *
 *     const duration = segmentDuration * (0.8 + Math.random() * 0.4);
 *
 * and _buildDemoPhases() rendered a complete fake 4-phase 2-hour history
 * whenever the fetch FAILED. An operator read plausible phase boundaries, with
 * a NOW marker and per-segment durations, for work that never happened -- and
 * a broken API looked like a healthy build.
 *
 * WHAT IT DOES NOW. It renders GET /api/operator/phases, which derives
 * segments from the real phase_change events the runtime writes to
 * .loki/events.jsonl (autonomy/run.sh:6562). Every segment boundary is an
 * event timestamp. When no phase_change events exist, it says so and draws
 * nothing; it never falls back to a synthetic timeline.
 *
 * THREE THINGS THE RECORD CANNOT TELL US, all rendered as unknown:
 *   - The opening phase's start was never emitted (the emitter only fires on a
 *     CHANGE). It is listed by name, off the axis, not drawn as a segment.
 *   - The final phase is still running; its end is anchored to the server's
 *     checked_at, not to this browser's clock.
 *   - The emitter is a polled monitor loop, so a phase shorter than one poll
 *     interval produced no event. The history is sampled, not exhaustive, and
 *     the footer says so.
 *
 * @example
 * <loki-session-timeline api-url="http://localhost:57374"></loki-session-timeline>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/**
 * Presentation for phase names we recognize. This is a display hint ONLY.
 *
 * The runtime's phase vocabulary is open and UPPERCASE: _advance_current_phase
 * (autonomy/run.sh:2557) writes whatever string its caller passes, and the
 * observed values are BOOTSTRAP, BUILDING, COMPLETED and FAILED. The previous
 * code looked up lowercase keys and fell back to `PHASE_COLORS.idle`, which
 * substituted the LABEL too -- so a real BUILDING phase rendered as "Idle".
 * Never substitute a label. An unrecognized phase keeps its own name; see
 * _phaseStyle().
 */
const PHASE_COLORS = {
  bootstrap: { color: 'var(--loki-text-muted)' },
  planning: { color: 'var(--loki-blue)' },
  reasoning: { color: 'var(--loki-blue)' },
  building: { color: 'var(--loki-purple)' },
  coding: { color: 'var(--loki-purple)' },
  testing: { color: 'var(--loki-green)' },
  verifying: { color: 'var(--loki-green)' },
  reviewing: { color: 'var(--loki-yellow)' },
  review: { color: 'var(--loki-yellow)' },
  deploying: { color: 'var(--loki-red)' },
  failed: { color: 'var(--loki-red)' },
  completed: { color: 'var(--loki-green)' },
  idle: { color: 'var(--loki-text-muted)' },
};

/** Color for a known phase; a neutral swatch for any unrecognized name. */
function _phaseStyle(phase) {
  const known = PHASE_COLORS[String(phase || '').toLowerCase()];
  return {
    color: known ? known.color : 'var(--loki-text-muted)',
    // The phase's OWN name, never a substituted label. Rendering an unknown
    // phase as "Idle" misreports what the engine was doing.
    label: String(phase || 'unknown'),
  };
}

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * @class LokiSessionTimeline
 * @extends LokiElement
 * @property {string} api-url - API base URL
 *
 * THE `phases` ATTRIBUTE IS DELETED ON PURPOSE. It accepted a JSON array
 * "for manual data" and assigned it straight into this._phases, bypassing
 * _applyPhaseHistory -- so caller-supplied segments rendered as measured
 * history on a real time axis, which is the same lie as the simulation with
 * a different author. It also skipped the seconds-to-milliseconds conversion
 * and left _checkedAt null, so injected data silently rendered at 1/1000
 * scale with no NOW marker. Nothing in dashboard-ui, dashboard or web-app
 * ever set it. Phases come from the measured endpoint or they are not shown.
 */
export class LokiSessionTimeline extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._phases = [];
    this._selectedPhase = null;
    this._api = null;
    this._pollInterval = null;
    // Why there are no segments. Distinct strings for "not recorded" and
    // "could not read" -- the project rule is that those must never render
    // identically. Null until a load has actually happened, so the first
    // paint does not claim a reason it has not learned yet.
    this._reason = null;
    this._leadingPhase = null;
    this._sampled = false;
    // Server-supplied instant the history was read at. The ongoing phase is
    // anchored to THIS, not to Date.now(): the browser clock is a different
    // clock from the one that stamped the events.
    this._checkedAt = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadTimeline();
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
      this._loadTimeline();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _loadTimeline() {
    const api = this._api;
    try {
      const data = await api.get('/api/operator/phases');
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._applyPhaseHistory(data);
    } catch (err) {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      // A failed read renders as a failed read. The previous code answered
      // this branch with _buildDemoPhases(), so an unreachable API produced a
      // convincing 2-hour history -- the worst available outcome, because it
      // is the one an operator cannot detect.
      this._phases = [];
      this._leadingPhase = null;
      this._checkedAt = null;
      this._sampled = false;
      this._reason = `could not read phase history: ${err && err.message ? err.message : 'request failed'}`;
    }
    this.render();
  }

  /**
   * Adopt a /api/operator/phases envelope. Segment times arrive as epoch
   * SECONDS (the server's unit) and are converted to milliseconds once, here,
   * so the renderer deals in one unit.
   */
  _applyPhaseHistory(data) {
    if (!data || typeof data !== 'object') {
      this._phases = [];
      this._leadingPhase = null;
      this._checkedAt = null;
      this._sampled = false;
      this._reason = 'could not read phase history: malformed response';
      return;
    }

    const toMs = (v) => (typeof v === 'number' && isFinite(v) ? v * 1000 : null);

    this._checkedAt = toMs(data.checked_at);
    this._sampled = data.sampled === true;
    this._leadingPhase = data.leading_phase
      ? { phase: data.leading_phase.phase, iteration: data.leading_phase.iteration }
      : null;

    const segments = Array.isArray(data.segments) ? data.segments : [];
    // The ongoing phase has end === null by contract. Anchor it to the
    // server's own read instant; fall back to its start (zero width) rather
    // than to Date.now(), which would draw a duration this component measured
    // against a clock that never stamped the events.
    const anchor = this._checkedAt;

    this._phases = segments.map((s) => {
      const start = toMs(s.start);
      let end = toMs(s.end);
      const ongoing = s.ongoing === true || end === null;
      if (end === null) end = anchor !== null && anchor > start ? anchor : start;
      return {
        phase: s.phase,
        start,
        end,
        ongoing,
        // Absent iteration stays null and renders as unknown, never as 0.
        iteration: typeof s.iteration === 'number' ? s.iteration : null,
      };
    }).filter((s) => s.start !== null);

    this._reason = this._phases.length === 0
      ? (data.reason || 'phase history not recorded')
      : null;
  }

  _startPolling() {
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, so a hidden tab or background
    // section does not fetch. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadTimeline(),
      intervalMs: 15000,
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

  _formatTime(ms) {
    const d = new Date(ms);
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  _formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${totalSec}s`;
  }

  render() {
    if (this._phases.length === 0) {
      // Name the reason. "no phase history was recorded" and "the API could
      // not be read" are different operator situations, and a single generic
      // line ("the timeline will appear once a build starts", as this used to
      // say) reports the second as the first.
      const headline = this._reason === null
        ? 'Loading phase history.'
        : 'Phase history not available';
      const detail = this._reason === null ? '' : this._reason;
      this.shadowRoot.innerHTML = `
        <style>
          ${this.getBaseStyles()}
          :host { display: block; }
          .empty { padding: 24px; text-align: center; color: var(--loki-text-muted); font-size: 12px; background: var(--loki-bg-card); border: 1px solid var(--loki-border); border-radius: 5px; }
          .empty-headline { font-weight: 600; color: var(--loki-text-secondary); }
          .empty-reason { margin-top: 6px; font-size: 11px; line-height: 1.5; }
        </style>
        <div class="empty">
          <div class="empty-headline">${_escapeHtml(headline)}</div>
          ${detail ? `<div class="empty-reason">${_escapeHtml(detail)}</div>` : ''}
        </div>
      `;
      return;
    }

    const totalStart = Math.min(...this._phases.map(p => p.start));
    const totalEnd = Math.max(...this._phases.map(p => p.end));
    const totalDuration = totalEnd - totalStart;

    // Build hour markers
    const startHour = new Date(totalStart);
    startHour.setMinutes(0, 0, 0);
    const markers = [];
    let markerTime = startHour.getTime();
    while (markerTime <= totalEnd + 3600000) {
      if (markerTime >= totalStart) {
        const pct = ((markerTime - totalStart) / totalDuration) * 100;
        markers.push({ time: markerTime, pct: Math.min(pct, 100) });
      }
      markerTime += 3600000;
    }

    // If session is short (<1h), use 15-min markers instead
    if (totalDuration < 3600000) {
      markers.length = 0;
      markerTime = startHour.getTime();
      while (markerTime <= totalEnd + 900000) {
        if (markerTime >= totalStart) {
          const pct = ((markerTime - totalStart) / totalDuration) * 100;
          markers.push({ time: markerTime, pct: Math.min(pct, 100) });
        }
        markerTime += 900000;
      }
    }

    // Build legend from used phases
    const usedPhases = [...new Set(this._phases.map(p => p.phase))];

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host { display: block; }

        .timeline-container {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          padding: 16px;
        }

        .timeline-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 14px;
        }

        .timeline-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .timeline-title svg {
          width: 14px;
          height: 14px;
          stroke: var(--loki-text-muted);
          fill: none;
          stroke-width: 2;
        }

        .legend {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 10px;
          color: var(--loki-text-secondary);
        }

        .legend-dot {
          width: 8px;
          height: 8px;
          border-radius: 2px;
          flex-shrink: 0;
        }

        .timeline-track {
          position: relative;
          height: 32px;
          background: var(--loki-bg-secondary);
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 8px;
        }

        .phase-segment {
          position: absolute;
          top: 2px;
          bottom: 2px;
          border-radius: 3px;
          cursor: pointer;
          transition: opacity 0.2s, transform 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          min-width: 4px;
        }

        .phase-segment:hover {
          opacity: 0.85;
          transform: scaleY(1.1);
          z-index: 2;
        }

        .phase-segment.current {
          animation: pulseBorder 2s infinite;
        }

        @keyframes pulseBorder {
          0%, 100% { box-shadow: none; }
          50% { box-shadow: 0 0 0 2px var(--loki-accent); }
        }

        .phase-label {
          font-size: 9px;
          font-weight: 500;
          color: white;
          text-shadow: 0 1px 2px rgba(0,0,0,0.3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          padding: 0 4px;
        }

        .time-axis {
          position: relative;
          height: 20px;
          margin-bottom: 12px;
        }

        .time-marker {
          position: absolute;
          top: 0;
          font-size: 9px;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-muted);
          transform: translateX(-50%);
        }

        .time-marker::before {
          content: '';
          position: absolute;
          top: -10px;
          left: 50%;
          width: 1px;
          height: 6px;
          background: var(--loki-border);
        }

        .now-marker {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--loki-accent);
          z-index: 3;
        }

        .now-marker::after {
          content: 'NOW';
          position: absolute;
          top: -16px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 8px;
          font-weight: 600;
          color: var(--loki-accent);
          letter-spacing: 0.05em;
        }

        .phase-detail {
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 10px 12px;
          margin-top: 8px;
          display: flex;
          gap: 16px;
          font-size: 11px;
          color: var(--loki-text-secondary);
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .detail-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .detail-label {
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--loki-text-muted);
        }

        .detail-value {
          font-weight: 500;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: var(--loki-text-primary);
        }

        .provenance {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid var(--loki-border);
          font-size: 10px;
          line-height: 1.6;
          color: var(--loki-text-muted);
        }
      </style>

      <div class="timeline-container">
        <div class="timeline-header">
          <div class="timeline-title">
            <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            Session Timeline
          </div>
          <div class="legend">
            ${usedPhases.map(p => {
              const config = _phaseStyle(p);
              return `
                <div class="legend-item">
                  <span class="legend-dot" style="background: ${config.color}"></span>
                  ${_escapeHtml(config.label)}
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="timeline-track">
          ${this._phases.map((phase, i) => {
            const config = _phaseStyle(phase.phase);
            const leftPct = ((phase.start - totalStart) / totalDuration) * 100;
            const widthPct = ((phase.end - phase.start) / totalDuration) * 100;
            const duration = phase.end - phase.start;
            const showLabel = widthPct > 8;
            const dur = phase.ongoing
              ? `${this._formatDuration(duration)} so far, still running`
              : this._formatDuration(duration);
            return `
              <div class="phase-segment ${phase.ongoing ? 'current' : ''}"
                   style="left: ${leftPct}%; width: ${widthPct}%; background: ${config.color};"
                   data-index="${i}"
                   title="${_escapeHtml(config.label)}: ${dur}">
                ${showLabel ? `<span class="phase-label">${_escapeHtml(config.label)}</span>` : ''}
              </div>
            `;
          }).join('')}

          ${(() => {
            // Anchored to the server's read instant, matching the segment
            // endpoints. Using Date.now() here would place NOW on a different
            // clock from the events and drift against them.
            if (this._checkedAt === null) return '';
            const nowPct = ((this._checkedAt - totalStart) / totalDuration) * 100;
            return nowPct <= 102 ? `<div class="now-marker" style="left: ${Math.min(nowPct, 100)}%"></div>` : '';
          })()}
        </div>

        <div class="time-axis">
          ${markers.map(m => `
            <span class="time-marker" style="left: ${m.pct}%">${this._formatTime(m.time)}</span>
          `).join('')}
        </div>

        ${this._selectedPhase !== null ? (() => {
          const phase = this._phases[this._selectedPhase];
          if (!phase) return '';
          const config = _phaseStyle(phase.phase);
          const duration = phase.end - phase.start;
          return `
            <div class="phase-detail">
              <div class="detail-item">
                <span class="detail-label">Phase</span>
                <span class="detail-value" style="color: ${config.color}">${_escapeHtml(config.label)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Start</span>
                <span class="detail-value">${this._formatTime(phase.start)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">End</span>
                <span class="detail-value">${phase.ongoing ? 'still running' : this._formatTime(phase.end)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Duration</span>
                <span class="detail-value">${this._formatDuration(duration)}${phase.ongoing ? ' so far' : ''}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Iteration</span>
                <span class="detail-value">${phase.iteration === null ? 'unknown' : `#${phase.iteration}`}</span>
              </div>
            </div>
          `;
        })() : ''}

        ${(this._leadingPhase || this._sampled) ? `
          <div class="provenance">
            ${this._leadingPhase ? `
              <div>Ran before the first recorded change:
                <strong>${_escapeHtml(this._leadingPhase.phase)}</strong>
                (start time not recorded, so it is not drawn above).</div>
            ` : ''}
            ${this._sampled ? `
              <div>Phases are sampled by a polling monitor. A phase shorter than one poll interval leaves no record and is absent here.</div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;

    // Attach click handlers
    this.shadowRoot.querySelectorAll('.phase-segment').forEach(seg => {
      seg.addEventListener('click', () => {
        const idx = parseInt(seg.dataset.index);
        this._selectedPhase = this._selectedPhase === idx ? null : idx;
        this.render();
      });
    });
  }
}

if (!customElements.get('loki-session-timeline')) {
  customElements.define('loki-session-timeline', LokiSessionTimeline);
}

export default LokiSessionTimeline;
