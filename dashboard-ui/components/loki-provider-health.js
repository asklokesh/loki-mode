/**
 * @fileoverview Provider Health Matrix - grid showing all providers with
 * health status, latency, token usage, and expandable detail cards.
 * Auto-refreshes every 10 seconds. Supports Claude, Codex, and Gemini.
 *
 * @example
 * <loki-provider-health api-url="http://localhost:57374" theme="dark"></loki-provider-health>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/** @type {Object<string, {initial: string, color: string, bgColor: string}>} */
const PROVIDER_ICONS = {
  claude:  { initial: 'C', color: '#553DE9', bgColor: 'rgba(85, 61, 233, 0.12)' },
  codex:   { initial: 'X', color: '#1FC5A8', bgColor: 'rgba(31, 197, 168, 0.12)' },
  gemini:  { initial: 'G', color: '#2F71E3', bgColor: 'rgba(47, 113, 227, 0.12)' },
  cline:   { initial: 'L', color: '#D4A03C', bgColor: 'rgba(212, 160, 60, 0.12)' },
  aider:   { initial: 'A', color: '#C45B5B', bgColor: 'rgba(196, 91, 91, 0.12)' },
};

const STATUS_COLORS = {
  healthy:  'var(--loki-green, #1FC5A8)',
  degraded: 'var(--loki-yellow, #D4A03C)',
  down:     'var(--loki-red, #C45B5B)',
  unknown:  'var(--loki-text-muted, #939084)',
};

/**
 * @class LokiProviderHealth
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - Theme name (default: auto-detect)
 */
export class LokiProviderHealth extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._providers = [];
    this._expandedProvider = null;
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
    this._pollInterval = setInterval(() => this._loadData(), 10000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async _loadData() {
    try {
      const data = await this._api._get('/api/v2/providers/health');
      this._providers = data.providers || [];
    } catch {
      // Use demo data if API unavailable
      if (this._providers.length === 0) {
        this._providers = this._getDemoData();
      }
    }
    this.render();
  }

  _getDemoData() {
    return [
      {
        name: 'claude', status: 'healthy', latency_ms: 245,
        tokens_used: 125400, model: 'claude-opus-4-7',
        api_version: 'v1', rate_limit: { remaining: 45, limit: 50 },
        cost_usd: 3.42,
      },
      {
        name: 'codex', status: 'degraded', latency_ms: 890,
        tokens_used: 45200, model: 'gpt-5.3-codex',
        api_version: 'v1', rate_limit: { remaining: 12, limit: 60 },
        cost_usd: 0.87,
      },
      {
        name: 'gemini', status: 'healthy', latency_ms: 320,
        tokens_used: 78600, model: 'gemini-3-pro',
        api_version: 'v1beta', rate_limit: { remaining: 55, limit: 60 },
        cost_usd: 1.15,
      },
    ];
  }

  _formatTokens(n) {
    if (n == null) return '--';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  _formatLatency(ms) {
    if (ms == null) return '--';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  _formatCost(usd) {
    if (usd == null) return '--';
    return '$' + usd.toFixed(2);
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _toggleExpand(providerName) {
    this._expandedProvider = this._expandedProvider === providerName ? null : providerName;
    this.render();
  }

  _bindEvents() {
    const root = this.shadowRoot;
    root.querySelectorAll('.provider-card').forEach(card => {
      card.addEventListener('click', () => {
        this._toggleExpand(card.dataset.provider);
      });
    });
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .health-container {
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

      .refresh-label {
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
      }

      .provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 12px;
      }

      .provider-card {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        padding: 16px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .provider-card:hover {
        border-color: var(--loki-border-light, #C5C0B1);
      }

      .provider-card.expanded {
        border-color: var(--loki-accent, #553DE9);
      }

      .card-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 14px;
      }

      .provider-icon {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        font-weight: 700;
        flex-shrink: 0;
      }

      .provider-name {
        font-size: 14px;
        font-weight: 600;
        text-transform: capitalize;
        flex: 1;
      }

      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-dot.pulse {
        animation: statusPulse 2s infinite;
      }

      @keyframes statusPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .card-metrics {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }

      .metric {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .metric-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
      }

      .metric-value {
        font-size: 15px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-primary, #201515);
      }

      .expand-details {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--loki-border, #ECEAE3);
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        animation: expandIn 0.2s ease-out;
      }

      @keyframes expandIn {
        from { opacity: 0; max-height: 0; }
        to { opacity: 1; max-height: 200px; }
      }

      .detail-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .detail-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
      }

      .detail-value {
        font-size: 12px;
        font-family: 'JetBrains Mono', monospace;
        color: var(--loki-text-secondary, #36342E);
      }

      .rate-limit-bar {
        width: 100%;
        height: 4px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        border-radius: 2px;
        overflow: hidden;
        margin-top: 4px;
      }

      .rate-limit-fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.3s ease;
      }

      .empty-state {
        text-align: center;
        padding: 32px 16px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    let content;
    if (this._providers.length === 0) {
      content = '<div class="empty-state">No provider data available</div>';
    } else {
      content = `<div class="provider-grid">${this._providers.map(p => {
        const icon = PROVIDER_ICONS[p.name] || { initial: (p.name ?? '?').charAt(0).toUpperCase(), color: '#939084', bgColor: 'rgba(147, 144, 132, 0.12)' };
        const statusColor = STATUS_COLORS[p.status] || STATUS_COLORS.unknown;
        const isExpanded = this._expandedProvider === p.name;
        const rateLimitPct = p.rate_limit ? ((p.rate_limit.remaining / p.rate_limit.limit) * 100) : 100;
        const rateLimitColor = rateLimitPct > 50 ? 'var(--loki-green)' : rateLimitPct > 20 ? 'var(--loki-yellow)' : 'var(--loki-red)';

        return `
          <div class="provider-card ${isExpanded ? 'expanded' : ''}" data-provider="${this._escapeHtml(p.name)}">
            <div class="card-header">
              <div class="provider-icon" style="background: ${icon.bgColor}; color: ${icon.color};">${icon.initial}</div>
              <span class="provider-name">${this._escapeHtml(p.name)}</span>
              <div class="status-dot ${p.status === 'healthy' ? 'pulse' : ''}" style="background: ${statusColor};" title="${this._escapeHtml(p.status)}"></div>
            </div>
            <div class="card-metrics">
              <div class="metric">
                <span class="metric-label">Latency</span>
                <span class="metric-value">${this._formatLatency(p.latency_ms)}</span>
              </div>
              <div class="metric">
                <span class="metric-label">Tokens</span>
                <span class="metric-value">${this._formatTokens(p.tokens_used)}</span>
              </div>
            </div>
            ${isExpanded ? `
              <div class="expand-details">
                <div class="detail-row">
                  <span class="detail-label">Model</span>
                  <span class="detail-value">${this._escapeHtml(p.model || '--')}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">API Version</span>
                  <span class="detail-value">${this._escapeHtml(p.api_version || '--')}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Cost</span>
                  <span class="detail-value">${this._formatCost(p.cost_usd)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Rate Limit</span>
                  <span class="detail-value">${p.rate_limit ? p.rate_limit.remaining + '/' + p.rate_limit.limit : '--'}</span>
                  ${p.rate_limit ? `
                    <div class="rate-limit-bar">
                      <div class="rate-limit-fill" style="width: ${rateLimitPct}%; background: ${rateLimitColor};"></div>
                    </div>
                  ` : ''}
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}</div>`;
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="health-container">
        <div class="header">
          <h3 class="title">Provider Health</h3>
          <span class="refresh-label">Auto-refresh: 10s</span>
        </div>
        ${content}
      </div>
    `;

    this._bindEvents();
  }
}

if (!customElements.get('loki-provider-health')) {
  customElements.define('loki-provider-health', LokiProviderHealth);
}

export default LokiProviderHealth;
