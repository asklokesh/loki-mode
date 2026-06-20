/**
 * @fileoverview Loki Session Timeline Component - a horizontal Gantt-style
 * bar chart showing session phases (planning, building, testing, reviewing)
 * with clickable segments and time axis.
 *
 * G70: Session Timeline (Gantt-style)
 *
 * @example
 * <loki-session-timeline api-url="http://localhost:57374"></loki-session-timeline>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

const PHASE_COLORS = {
  planning: { color: 'var(--loki-blue)', bg: 'var(--loki-blue-muted)', label: 'Planning' },
  building: { color: 'var(--loki-purple)', bg: 'var(--loki-purple-muted)', label: 'Building' },
  coding: { color: 'var(--loki-purple)', bg: 'var(--loki-purple-muted)', label: 'Coding' },
  testing: { color: 'var(--loki-green)', bg: 'var(--loki-green-muted)', label: 'Testing' },
  reviewing: { color: 'var(--loki-yellow)', bg: 'var(--loki-yellow-muted)', label: 'Reviewing' },
  review: { color: 'var(--loki-yellow)', bg: 'var(--loki-yellow-muted)', label: 'Review' },
  deploying: { color: 'var(--loki-red)', bg: 'var(--loki-red-muted)', label: 'Deploying' },
  idle: { color: 'var(--loki-text-muted)', bg: 'var(--loki-bg-tertiary)', label: 'Idle' },
};

/**
 * @class LokiSessionTimeline
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {string} phases - JSON array of phase segments (for manual data)
 */
export class LokiSessionTimeline extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'phases', 'theme'];
  }

  constructor() {
    super();
    this._phases = [];
    this._selectedPhase = null;
    this._sessionStart = null;
    this._api = null;
    this._pollInterval = null;
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
    if (name === 'phases' && newValue) {
      try {
        this._phases = JSON.parse(newValue);
        this.render();
      } catch { /* ignore invalid JSON */ }
    }
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
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
    try {
      const status = await this._api.getStatus();
      if (status) {
        this._buildPhasesFromStatus(status);
      }
    } catch {
      // Use demo data if API not available
      if (this._phases.length === 0) {
        this._buildDemoPhases();
      }
    }
    this.render();
  }

  _buildPhasesFromStatus(status) {
    // Build a simple timeline from current status
    const uptime = status.uptime_seconds || 0;
    const phase = (status.phase || 'idle').toLowerCase();
    const iteration = status.iteration || 0;

    if (uptime <= 0) {
      this._phases = [];
      return;
    }

    this._sessionStart = new Date(Date.now() - uptime * 1000);

    // Estimate phase segments based on iteration progress
    const phases = [];
    const now = Date.now();
    const startMs = this._sessionStart.getTime();
    const totalMs = now - startMs;

    if (iteration <= 1) {
      phases.push({
        phase: phase,
        start: startMs,
        end: now,
        iteration: iteration,
      });
    } else {
      // Simulate a multi-phase timeline based on iteration count
      const phaseOrder = ['planning', 'building', 'testing', 'reviewing'];
      const segmentDuration = totalMs / Math.max(iteration * 2, 4);

      let currentTime = startMs;
      for (let i = 0; i < iteration && currentTime < now; i++) {
        const phaseIdx = i % phaseOrder.length;
        const phaseName = phaseOrder[phaseIdx];
        const duration = segmentDuration * (0.8 + Math.random() * 0.4);
        const endTime = Math.min(currentTime + duration, now);

        phases.push({
          phase: phaseName,
          start: currentTime,
          end: endTime,
          iteration: i + 1,
        });
        currentTime = endTime;
      }

      // If there's remaining time, add current phase
      if (currentTime < now) {
        phases.push({
          phase: phase,
          start: currentTime,
          end: now,
          iteration: iteration,
          current: true,
        });
      }
    }

    this._phases = phases;
  }

  _buildDemoPhases() {
    const now = Date.now();
    const hourMs = 3600000;
    this._sessionStart = new Date(now - 2 * hourMs);

    this._phases = [
      { phase: 'planning', start: now - 2 * hourMs, end: now - 1.6 * hourMs, iteration: 1 },
      { phase: 'building', start: now - 1.6 * hourMs, end: now - 0.8 * hourMs, iteration: 2 },
      { phase: 'testing', start: now - 0.8 * hourMs, end: now - 0.3 * hourMs, iteration: 3 },
      { phase: 'reviewing', start: now - 0.3 * hourMs, end: now, iteration: 4, current: true },
    ];
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
      this.shadowRoot.innerHTML = `
        <style>
          ${this.getBaseStyles()}
          :host { display: block; }
          .empty { padding: 24px; text-align: center; color: var(--loki-text-muted); font-size: 12px; background: var(--loki-bg-card); border: 1px solid var(--loki-border); border-radius: 5px; }
        </style>
        <div class="empty">No session timeline data available</div>
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
      </style>

      <div class="timeline-container">
        <div class="timeline-header">
          <div class="timeline-title">
            <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            Session Timeline
          </div>
          <div class="legend">
            ${usedPhases.map(p => {
              const config = PHASE_COLORS[p] || PHASE_COLORS.idle;
              return `
                <div class="legend-item">
                  <span class="legend-dot" style="background: ${config.color}"></span>
                  ${config.label}
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="timeline-track">
          ${this._phases.map((phase, i) => {
            const config = PHASE_COLORS[phase.phase] || PHASE_COLORS.idle;
            const leftPct = ((phase.start - totalStart) / totalDuration) * 100;
            const widthPct = ((phase.end - phase.start) / totalDuration) * 100;
            const duration = phase.end - phase.start;
            const showLabel = widthPct > 8;
            return `
              <div class="phase-segment ${phase.current ? 'current' : ''}"
                   style="left: ${leftPct}%; width: ${widthPct}%; background: ${config.color};"
                   data-index="${i}"
                   title="${config.label}: ${this._formatDuration(duration)}">
                ${showLabel ? `<span class="phase-label">${config.label}</span>` : ''}
              </div>
            `;
          }).join('')}

          ${(() => {
            const nowPct = ((Date.now() - totalStart) / totalDuration) * 100;
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
          const config = PHASE_COLORS[phase.phase] || PHASE_COLORS.idle;
          const duration = phase.end - phase.start;
          return `
            <div class="phase-detail">
              <div class="detail-item">
                <span class="detail-label">Phase</span>
                <span class="detail-value" style="color: ${config.color}">${config.label}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Start</span>
                <span class="detail-value">${this._formatTime(phase.start)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">End</span>
                <span class="detail-value">${this._formatTime(phase.end)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Duration</span>
                <span class="detail-value">${this._formatDuration(duration)}</span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Iteration</span>
                <span class="detail-value">#${phase.iteration || '--'}</span>
              </div>
            </div>
          `;
        })() : ''}
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
