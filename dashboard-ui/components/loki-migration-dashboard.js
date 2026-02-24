/**
 * @fileoverview Loki Migration Dashboard Component - displays migration status,
 * phase progress, feature tracking, seam summary, and migration history.
 *
 * Polls /api/migration/list on load, then /api/migration/{id}/status every 15s
 * for active migrations.
 *
 * @example
 * <loki-migration-dashboard api-url="http://localhost:57374"></loki-migration-dashboard>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

const PHASES = ['understand', 'guardrail', 'migrate', 'verify'];
const PHASE_LABELS = { understand: 'Understand', guardrail: 'Guardrail', migrate: 'Migrate', verify: 'Verify' };
const PHASE_COLORS = { understand: '#5b9bd5', guardrail: '#e8b84a', migrate: '#5bb870', verify: '#5bc8c8' };

/**
 * @class LokiMigrationDashboard
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 */
export class LokiMigrationDashboard extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._migration = null;
    this._migrations = [];
    this._loading = true;
    this._error = null;
    this._api = null;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._fetchMigrations();
    this._pollInterval = setInterval(() => this._fetchData(), 15000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._fetchMigrations();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _fetchMigrations() {
    try {
      const result = await this._api._get('/api/migration/list');
      this._migrations = Array.isArray(result) ? result : (result.migrations || []);
      this._error = null;
      const active = this._migrations.find(m => m.status === 'in_progress' || m.status === 'active');
      if (active) {
        await this._fetchStatus(active.migration_id || active.id);
      } else {
        this._migration = null;
      }
    } catch (err) {
      this._error = err.message;
      this._migrations = [];
      this._migration = null;
    }
    this._loading = false;
    this.render();
  }

  async _fetchStatus(id) {
    try {
      this._migration = await this._api._get(`/api/migration/${encodeURIComponent(id)}/status`);
      this._error = null;
    } catch (err) {
      this._error = err.message;
    }
  }

  async _fetchData() {
    const id = this._migration && (this._migration.migration_id || this._migration.id);
    if (id) {
      await this._fetchStatus(id);
      this.render();
    } else {
      await this._fetchMigrations();
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  _getPhaseIcon(phase, currentPhase, completedPhases) {
    const completed = completedPhases || [];
    if (completed.includes(phase)) return '[x]';
    if (phase === currentPhase) return '[>]';
    return '[ ]';
  }

  _getPhaseIndex(phase) {
    const idx = PHASES.indexOf(phase);
    return idx >= 0 ? idx : 0;
  }

  _renderPhaseBar(currentPhase, completedPhases) {
    const completed = completedPhases || [];
    return PHASES.map(phase => {
      const isDone = completed.includes(phase);
      const isActive = phase === currentPhase;
      const color = PHASE_COLORS[phase];
      const opacity = isDone ? '1' : isActive ? '0.7' : '0.2';
      const icon = this._getPhaseIcon(phase, currentPhase, completedPhases);
      return `
        <div class="phase-segment">
          <div class="phase-bar-fill" style="background:${color};opacity:${opacity};"></div>
          <div class="phase-label">
            <span class="phase-icon">${icon}</span>
            ${PHASE_LABELS[phase]}
          </div>
        </div>
      `;
    }).join('');
  }

  _renderFeatureStats(features) {
    if (!features) return '';
    const passing = features.passing || 0;
    const total = features.total || 0;
    const pct = total > 0 ? Math.round((passing / total) * 100) : 0;
    const barColor = pct >= 80 ? 'var(--loki-success)' : pct >= 50 ? 'var(--loki-warning)' : 'var(--loki-error)';
    return `
      <div class="stat-card">
        <div class="stat-header">Feature Tracking</div>
        <div class="stat-value">${passing} / ${total}</div>
        <div class="stat-pct">${pct}% passing</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%;background:${barColor};"></div>
        </div>
      </div>
    `;
  }

  _renderStepProgress(steps) {
    if (!steps) return '';
    const current = steps.current || 0;
    const total = steps.total || 0;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    return `
      <div class="stat-card">
        <div class="stat-header">Step Progress</div>
        <div class="stat-value">${current} / ${total}</div>
        <div class="stat-pct">${pct}% complete</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%;background:var(--loki-accent);"></div>
        </div>
      </div>
    `;
  }

  _renderSeamSummary(seams) {
    if (!seams) return '';
    const total = seams.total || 0;
    const high = seams.high || 0;
    const medium = seams.medium || 0;
    const low = seams.low || 0;
    return `
      <div class="stat-card">
        <div class="stat-header">Seam Summary</div>
        <div class="stat-value">${total} seams</div>
        <div class="seam-breakdown">
          <span class="seam-badge seam-high">High: ${high}</span>
          <span class="seam-badge seam-medium">Med: ${medium}</span>
          <span class="seam-badge seam-low">Low: ${low}</span>
        </div>
      </div>
    `;
  }

  _renderCheckpoint(checkpoint) {
    if (!checkpoint) return '';
    const ts = checkpoint.timestamp ? new Date(checkpoint.timestamp).toLocaleString() : '--';
    const stepId = this._escapeHtml(checkpoint.step_id || checkpoint.stepId || '--');
    return `
      <div class="checkpoint-section">
        <div class="section-label">Last Checkpoint</div>
        <div class="checkpoint-row">
          <span class="checkpoint-label">Time:</span>
          <span class="checkpoint-value">${this._escapeHtml(ts)}</span>
        </div>
        <div class="checkpoint-row">
          <span class="checkpoint-label">Step:</span>
          <span class="checkpoint-value mono">${stepId}</span>
        </div>
      </div>
    `;
  }

  _renderMigrationList() {
    if (this._migrations.length === 0) {
      return '<div class="empty-state">No migrations found</div>';
    }
    const rows = this._migrations.map(m => {
      const id = this._escapeHtml(m.migration_id || m.id || '--');
      const source = this._escapeHtml(m.source || '--');
      const target = this._escapeHtml(m.target || '--');
      const status = this._escapeHtml(m.status || '--');
      const statusCls = m.status === 'completed' ? 'status-done' : m.status === 'failed' ? 'status-failed' : 'status-pending';
      return `
        <tr>
          <td class="mono">${id}</td>
          <td>${source} -> ${target}</td>
          <td><span class="status-badge ${statusCls}">${status}</span></td>
        </tr>
      `;
    }).join('');
    return `
      <table class="migration-table">
        <thead>
          <tr><th>ID</th><th>Migration</th><th>Status</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  render() {
    const styles = `
      ${this.getBaseStyles()}

      :host { display: block; }

      .migration-container {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-glass-border);
        border-radius: 5px;
        padding: 16px;
        transition: all var(--loki-transition);
      }

      .migration-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
      }

      .migration-header svg {
        width: 16px;
        height: 16px;
        color: var(--loki-text-muted);
        flex-shrink: 0;
      }

      .migration-title {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
      }

      .migration-id {
        margin-left: auto;
        font-size: 11px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-muted);
      }

      .meta-row {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 14px;
        flex-wrap: wrap;
      }

      .meta-item {
        font-size: 12px;
        color: var(--loki-text-secondary);
      }

      .meta-label {
        font-weight: 600;
        color: var(--loki-text-muted);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        display: block;
        margin-bottom: 2px;
      }

      .mono {
        font-family: 'JetBrains Mono', monospace;
      }

      .phase-bar-container {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 4px;
        margin-bottom: 16px;
      }

      .phase-segment {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }

      .phase-bar-fill {
        width: 100%;
        height: 8px;
        border-radius: 4px;
        transition: opacity 0.3s ease;
      }

      .phase-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--loki-text-muted);
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .phase-icon {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9px;
      }

      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }

      .stat-card {
        background: var(--loki-bg-secondary);
        border: 1px solid var(--loki-border);
        border-radius: 5px;
        padding: 10px 12px;
      }

      .stat-header {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        margin-bottom: 6px;
      }

      .stat-value {
        font-size: 20px;
        font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-primary);
        line-height: 1;
        margin-bottom: 4px;
      }

      .stat-pct {
        font-size: 11px;
        color: var(--loki-text-muted);
        margin-bottom: 6px;
      }

      .progress-bar {
        width: 100%;
        height: 6px;
        background: var(--loki-bg-tertiary);
        border-radius: 3px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .seam-breakdown {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        flex-wrap: wrap;
      }

      .seam-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
        font-family: 'JetBrains Mono', monospace;
      }

      .seam-high {
        background: rgba(224, 112, 112, 0.15);
        color: var(--loki-error);
      }

      .seam-medium {
        background: rgba(232, 184, 74, 0.15);
        color: var(--loki-warning);
      }

      .seam-low {
        background: var(--loki-bg-tertiary);
        color: var(--loki-text-muted);
      }

      .checkpoint-section {
        margin-bottom: 14px;
      }

      .section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        margin-bottom: 8px;
      }

      .checkpoint-row {
        display: flex;
        gap: 8px;
        align-items: baseline;
        margin-bottom: 4px;
        font-size: 12px;
      }

      .checkpoint-label {
        color: var(--loki-text-muted);
        min-width: 40px;
      }

      .checkpoint-value {
        color: var(--loki-text-secondary);
      }

      .migration-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      .migration-table th {
        text-align: left;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
        padding: 6px 10px;
        border-bottom: 1px solid var(--loki-border);
      }

      .migration-table td {
        padding: 8px 10px;
        color: var(--loki-text-secondary);
        border-bottom: 1px solid var(--loki-border);
      }

      .migration-table tbody tr:last-child td {
        border-bottom: none;
      }

      .status-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
      }

      .status-done {
        background: rgba(91, 184, 112, 0.15);
        color: var(--loki-success);
      }

      .status-failed {
        background: rgba(224, 112, 112, 0.15);
        color: var(--loki-error);
      }

      .status-pending {
        background: var(--loki-bg-tertiary);
        color: var(--loki-text-muted);
      }

      .empty-state {
        text-align: center;
        padding: 20px;
        color: var(--loki-text-muted);
        font-size: 12px;
      }

      .loading-state {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        gap: 8px;
        color: var(--loki-text-muted);
        font-size: 12px;
      }

      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--loki-border);
        border-top-color: var(--loki-accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;

    const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`;

    if (this._loading) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="migration-container">
          <div class="loading-state"><div class="spinner"></div> Loading migrations...</div>
        </div>
      `;
      return;
    }

    if (this._error && !this._migration && this._migrations.length === 0) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="migration-container">
          <div class="migration-header">
            ${icon}
            <span class="migration-title">Migration Dashboard</span>
          </div>
          <div class="empty-state">No migration data available</div>
        </div>
      `;
      return;
    }

    // Active migration view
    if (this._migration) {
      const m = this._migration;
      const migId = this._escapeHtml(m.migration_id || m.id || '--');
      const source = this._escapeHtml(m.source || '--');
      const target = this._escapeHtml(m.target || '--');
      const currentPhase = m.current_phase || m.phase || 'understand';
      const completedPhases = m.completed_phases || [];

      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="migration-container">
          <div class="migration-header">
            ${icon}
            <span class="migration-title">Migration Dashboard</span>
            <span class="migration-id">${migId}</span>
          </div>

          <div class="meta-row">
            <div class="meta-item">
              <span class="meta-label">Source</span>
              <span class="mono">${source}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">-></span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Target</span>
              <span class="mono">${target}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Phase</span>
              <span>${PHASE_LABELS[currentPhase] || this._escapeHtml(currentPhase)}</span>
            </div>
          </div>

          <div class="section-label">Phase Progress</div>
          <div class="phase-bar-container">
            ${this._renderPhaseBar(currentPhase, completedPhases)}
          </div>

          <div class="stats-grid">
            ${this._renderFeatureStats(m.features)}
            ${this._renderStepProgress(m.steps)}
            ${this._renderSeamSummary(m.seams)}
          </div>

          ${this._renderCheckpoint(m.last_checkpoint || m.checkpoint)}
        </div>
      `;
      return;
    }

    // Migration list view (no active migration)
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div class="migration-container">
        <div class="migration-header">
          ${icon}
          <span class="migration-title">Migration Dashboard</span>
        </div>
        <div class="section-label">Migrations</div>
        ${this._renderMigrationList()}
      </div>
    `;
  }
}

if (!customElements.get('loki-migration-dashboard')) {
  customElements.define('loki-migration-dashboard', LokiMigrationDashboard);
}

export default LokiMigrationDashboard;
