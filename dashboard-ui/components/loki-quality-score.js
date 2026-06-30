/**
 * @fileoverview Loki Quality Score Component - displays quality score trends
 * with category breakdown, severity findings, and sparkline visualization.
 *
 * Polls /api/quality-score on load and /api/quality-score/history for trend data.
 *
 * @example
 * <loki-quality-score api-url="http://localhost:57374"></loki-quality-score>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/**
 * @class LokiQualityScore
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 */
export class LokiQualityScore extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._data = null;
    this._history = [];
    this._error = null;
    this._loading = true;
    this._scanning = false;
    this._rigourAvailable = true;
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

  async _loadData() {
    // Drop a stale response if the api-url switched mid-flight.
    const api = this._api;
    try {
      const [scoreResult, historyResult] = await Promise.allSettled([
        api._get('/api/quality-score'),
        api._get('/api/quality-score/history'),
      ]);
      if (api !== this._api) return;

      if (scoreResult.status === 'fulfilled') {
        const data = scoreResult.value;
        if (data && data.error && data.error.includes('not installed')) {
          this._rigourAvailable = false;
          this._data = null;
        } else if (data && data.available === false) {
          // Rigour engine not reachable (e.g. npx unavailable). Honest empty.
          this._rigourAvailable = false;
          this._data = null;
        } else if (data && data.score == null) {
          // Engine is available but no scan has run yet. Keep _data null so the
          // render path shows the branded "Run a scan" empty state rather than a
          // fabricated 0 / grade F. Distinct from the not-installed state.
          this._rigourAvailable = true;
          this._data = null;
        } else {
          this._rigourAvailable = true;
          this._data = data;
        }
        this._error = null;
      } else {
        const errMsg = scoreResult.reason?.message || '';
        if (errMsg.includes('404')) {
          this._rigourAvailable = false;
          this._data = null;
          this._error = null;
        } else {
          this._error = 'Failed to load quality score';
          this._data = null;
        }
      }

      if (historyResult.status === 'fulfilled') {
        const histData = historyResult.value;
        this._history = Array.isArray(histData) ? histData.slice(-10) : (histData.scores || []).slice(-10);
      }
    } catch (err) {
      if (api !== this._api) return;
      this._error = err.message;
      this._data = null;
    }
    this._loading = false;
    this.render();
  }

  async _triggerScan() {
    if (this._scanning) return;
    this._scanning = true;
    this.render();
    try {
      // Full-codebase quality audit (AST parse, complexity, lint); scales with
      // repo size and routinely exceeds the default 10s. 300s client budget so
      // large repos do not abort with a misleading "Request timeout".
      await this._api._post('/api/quality-scan', {}, { timeout: 300000 });
      await this._loadData();
    } catch (err) {
      this._error = err.message;
    }
    this._scanning = false;
    this.render();
  }

  _startPolling() {
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, so a hidden tab or background
    // section does not fetch. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadData(),
      intervalMs: 60000,
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

  _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _getGrade(score) {
    if (score >= 90) return { grade: 'A', color: 'var(--loki-success)' };
    if (score >= 80) return { grade: 'B', color: 'var(--loki-success)' };
    if (score >= 70) return { grade: 'C', color: 'var(--loki-warning)' };
    if (score >= 60) return { grade: 'D', color: 'var(--loki-warning)' };
    return { grade: 'F', color: 'var(--loki-error)' };
  }

  _renderSparkline(scores) {
    if (!scores || scores.length < 2) return '';
    const values = scores.map(s => typeof s === 'number' ? s : (s.score || 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const width = 120;
    const height = 32;
    const padding = 2;

    const points = values.map((v, i) => {
      const x = padding + (i / (values.length - 1)) * (width - padding * 2);
      const y = padding + (1 - (v - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    }).join(' ');

    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="sparkline">
        <polyline points="${points}" fill="none" stroke="var(--loki-accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${points.split(' ').pop().split(',')[0]}" cy="${points.split(' ').pop().split(',')[1]}" r="2.5" fill="var(--loki-accent)"/>
      </svg>
    `;
  }

  render() {
    const styles = `
      ${this.getBaseStyles()}

      :host {
        display: block;
      }

      .quality-container {
        background: var(--loki-bg-card);
        border: 1px solid var(--loki-glass-border);
        border-radius: 5px;
        padding: 16px;
        transition: all var(--loki-transition);
      }

      .quality-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 14px;
      }

      .quality-header svg {
        width: 16px;
        height: 16px;
        color: var(--loki-text-muted);
        flex-shrink: 0;
      }

      .quality-title {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted);
      }

      .scan-btn {
        margin-left: auto;
        padding: 4px 12px;
        background: var(--loki-accent);
        color: #fff;
        border: none;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--loki-transition);
        font-family: inherit;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .scan-btn:hover:not(:disabled) {
        background: var(--loki-accent-hover);
      }

      .scan-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .score-section {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 16px;
      }

      .score-display {
        text-align: center;
        min-width: 80px;
      }

      .score-number {
        font-size: 36px;
        font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        line-height: 1;
        color: var(--loki-text-primary);
      }

      .grade-badge {
        display: inline-block;
        padding: 2px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
        margin-top: 4px;
      }

      .sparkline-container {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }

      .sparkline-label {
        font-size: 10px;
        color: var(--loki-text-muted);
        margin-bottom: 4px;
      }

      .sparkline {
        display: block;
      }

      .categories-section {
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

      .category-item {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 6px;
      }

      .category-name {
        font-size: 11px;
        color: var(--loki-text-secondary);
        min-width: 100px;
        text-transform: capitalize;
      }

      .progress-bar {
        flex: 1;
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

      .category-score {
        font-size: 11px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-secondary);
        min-width: 28px;
        text-align: right;
      }

      .findings-section {
        margin-top: 14px;
      }

      .findings-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .finding-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        font-family: 'JetBrains Mono', monospace;
      }

      .finding-critical {
        background: rgba(224, 112, 112, 0.15);
        color: var(--loki-error);
      }

      .finding-major {
        background: rgba(232, 184, 74, 0.15);
        color: var(--loki-warning);
      }

      .finding-minor {
        background: rgba(232, 184, 74, 0.10);
        color: var(--loki-warning);
      }

      .finding-info {
        background: var(--loki-bg-tertiary);
        color: var(--loki-text-muted);
      }

      .not-installed {
        text-align: center;
        padding: 24px 16px;
        color: var(--loki-text-muted);
        font-size: 12px;
        line-height: 1.6;
      }

      .not-installed-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--loki-text-secondary);
        margin-bottom: 6px;
      }

      .install-cmd {
        display: inline-block;
        padding: 4px 10px;
        background: var(--loki-bg-secondary);
        border: 1px solid var(--loki-border);
        border-radius: 4px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--loki-accent);
        margin-top: 8px;
      }

      .empty-state {
        text-align: center;
        padding: 20px;
        color: var(--loki-text-muted);
        font-size: 12px;
      }

      /* Branded empty / not-installed states */
      .es {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 40px 24px;
        gap: 4px;
      }

      .es-icon {
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--loki-radius-full);
        background: var(--loki-accent-muted);
        color: var(--loki-accent);
        margin-bottom: 12px;
      }

      .es-icon svg {
        width: 20px;
        height: 20px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .es-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--loki-text-primary);
      }

      .es-desc {
        font-size: 12px;
        color: var(--loki-text-muted);
        line-height: 1.5;
        max-width: 320px;
      }

      .es-cta {
        margin-top: 14px;
        padding: 8px 16px;
        background: var(--loki-accent);
        color: var(--loki-text-inverse);
        border: none;
        border-radius: var(--loki-radius-md);
        font-size: 12px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: background var(--loki-transition);
      }

      .es-cta:hover:not(:disabled) {
        background: var(--loki-accent-hover);
      }

      .es-cta:disabled {
        opacity: 0.6;
        cursor: not-allowed;
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

      .spinner-sm {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;

    if (this._loading) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="quality-container">
          <div class="loading-state"><div class="spinner"></div> Loading quality score...</div>
        </div>
      `;
      return;
    }

    const shieldIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

    // Rigour not installed / engine unavailable state
    if (!this._rigourAvailable) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="quality-container">
          <div class="quality-header">
            ${shieldIcon}
            <span class="quality-title">Quality Score</span>
          </div>
          <div class="es">
            <div class="es-icon">${shieldIcon}</div>
            <div class="es-title">Quality engine not available</div>
            <div class="es-desc">Quality scoring runs the Rigour analysis engine via npx, which needs Node.js on PATH. Install Node.js, then reload to run a scan.</div>
            <div class="install-cmd">npx @rigour-labs/cli --version</div>
          </div>
        </div>
      `;
      return;
    }

    // Error loading
    if (this._error && !this._data) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="quality-container">
          <div class="quality-header">
            ${shieldIcon}
            <span class="quality-title">Quality Score</span>
          </div>
          <div class="es">
            <div class="es-icon">${shieldIcon}</div>
            <div class="es-title">Couldn't load quality score</div>
            <div class="es-desc">${this._escapeHtml(this._error)}</div>
            <button class="es-cta" id="retry-btn">Retry</button>
          </div>
        </div>
      `;
      const retryBtn = this.shadowRoot.getElementById('retry-btn');
      if (retryBtn) retryBtn.addEventListener('click', () => { this._loading = true; this.render(); this._loadData(); });
      return;
    }

    // Engine available but no scan has run yet -- branded "run a scan" CTA
    // instead of a fabricated 0 / grade F.
    if (!this._data) {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div class="quality-container">
          <div class="quality-header">
            ${shieldIcon}
            <span class="quality-title">Quality Score</span>
          </div>
          <div class="es">
            <div class="es-icon">${shieldIcon}</div>
            <div class="es-title">No quality scan yet</div>
            <div class="es-desc">Run a scan to see your code-quality score and the 8 gates.</div>
            <button class="es-cta" id="scan-btn" ${this._scanning ? 'disabled' : ''}>
              ${this._scanning ? '<div class="spinner-sm"></div> Scanning...' : 'Run quality scan'}
            </button>
          </div>
        </div>
      `;
      const scanBtn = this.shadowRoot.getElementById('scan-btn');
      if (scanBtn) scanBtn.addEventListener('click', () => this._triggerScan());
      return;
    }

    const d = this._data || {};
    const score = d.score != null ? Math.round(d.score) : 0;
    const { grade, color: gradeColor } = this._getGrade(score);
    const categories = d.categories || {};
    const findings = d.findings || {};

    const categoryNames = ['security', 'code_quality', 'compliance', 'best_practices'];
    const categoryLabels = {
      security: 'Security',
      code_quality: 'Code Quality',
      compliance: 'Compliance',
      best_practices: 'Best Practices',
    };

    const categoriesHtml = categoryNames.map(name => {
      const val = categories[name] != null ? Math.round(categories[name]) : 0;
      const barColor = val >= 80 ? 'var(--loki-success)' : val >= 60 ? 'var(--loki-warning)' : 'var(--loki-error)';
      return `
        <div class="category-item">
          <span class="category-name">${categoryLabels[name] || name}</span>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${val}%;background:${barColor};"></div>
          </div>
          <span class="category-score">${val}</span>
        </div>
      `;
    }).join('');

    const severities = [
      { key: 'critical', cls: 'finding-critical', label: 'Critical' },
      { key: 'major', cls: 'finding-major', label: 'Major' },
      { key: 'minor', cls: 'finding-minor', label: 'Minor' },
      { key: 'info', cls: 'finding-info', label: 'Info' },
    ];

    const findingsHtml = severities
      .filter(s => (findings[s.key] || 0) > 0)
      .map(s => `<span class="finding-badge ${s.cls}">${s.label}: ${findings[s.key]}</span>`)
      .join('');

    const sparklineHtml = this._renderSparkline(this._history);

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div class="quality-container">
        <div class="quality-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span class="quality-title">Quality Score</span>
          <button class="scan-btn" id="scan-btn" ${this._scanning ? 'disabled' : ''}>
            ${this._scanning ? '<div class="spinner-sm"></div> Scanning...' : 'Run Scan'}
          </button>
        </div>

        <div class="score-section">
          <div class="score-display">
            <div class="score-number">${score}</div>
            <span class="grade-badge" style="background:${gradeColor};color:#fff;">${grade}</span>
          </div>
          ${sparklineHtml ? `
            <div class="sparkline-container">
              <span class="sparkline-label">Trend (last ${this._history.length})</span>
              ${sparklineHtml}
            </div>
          ` : ''}
        </div>

        <div class="categories-section">
          <div class="section-label">Categories</div>
          ${categoriesHtml}
        </div>

        ${findingsHtml ? `
          <div class="findings-section">
            <div class="section-label">Findings</div>
            <div class="findings-row">${findingsHtml}</div>
          </div>
        ` : ''}
      </div>
    `;

    // Attach scan button listener
    const scanBtn = this.shadowRoot.getElementById('scan-btn');
    if (scanBtn) {
      scanBtn.addEventListener('click', () => this._triggerScan());
    }
  }
}

if (!customElements.get('loki-quality-score')) {
  customElements.define('loki-quality-score', LokiQualityScore);
}

export default LokiQualityScore;
