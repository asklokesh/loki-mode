/**
 * Loki Cost Dashboard Component
 *
 * Displays cost visibility metrics including token usage,
 * estimated USD cost by model, cost per phase, and budget tracking.
 *
 * Usage:
 *   <loki-cost-dashboard
 *     api-url="(auto-detected from window.location.origin)"
 *     theme="dark"
 *   ></loki-cost-dashboard>
 *
 * Attributes:
 *   - api-url: API base URL (default: auto-detected from window.location.origin)
 *   - theme: 'light' or 'dark' (default: auto-detect)
 *
 * Data source:
 *   Polls /api/cost every 5 seconds for token usage and cost data.
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';

// Static fallback pricing per million tokens (USD) - updated 2026-02-07
// At runtime, these are overridden by /api/pricing (which reads .loki/pricing.json)
const DEFAULT_PRICING = {
  // Claude (Anthropic)
  opus:   { input: 5.00,   output: 25.00,  label: 'Opus 4.6',       provider: 'claude' },
  sonnet: { input: 3.00,   output: 15.00,  label: 'Sonnet 4.5',     provider: 'claude' },
  haiku:  { input: 1.00,   output: 5.00,   label: 'Haiku 4.5',      provider: 'claude' },
  // OpenAI Codex
  'gpt-5.3-codex': { input: 1.50, output: 12.00, label: 'GPT-5.3 Codex', provider: 'codex' },
  // Google Gemini
  'gemini-3-pro':  { input: 1.25, output: 10.00, label: 'Gemini 3 Pro',   provider: 'gemini' },
  'gemini-3-flash': { input: 0.10, output: 0.40, label: 'Gemini 3 Flash', provider: 'gemini' },
};

// Active pricing - starts with defaults, updated from API
let MODEL_PRICING = { ...DEFAULT_PRICING };

export class LokiCostDashboard extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._data = {
      total_input_tokens: 0,
      total_output_tokens: 0,
      estimated_cost_usd: 0,
      by_phase: {},
      by_model: {},
      budget_limit: null,
      budget_used: 0,
      budget_remaining: null,
      connected: false,
    };
    this._api = null;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadPricing();
    this._loadCost();
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
      this._loadCost();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _loadPricing() {
    try {
      const pricing = await this._api.getPricing();
      if (pricing && pricing.models) {
        const updated = {};
        for (const [key, m] of Object.entries(pricing.models)) {
          updated[key] = {
            input: m.input,
            output: m.output,
            label: m.label || key,
            provider: m.provider || 'unknown',
          };
        }
        MODEL_PRICING = updated;
        this._pricingSource = pricing.source || 'api';
        this._pricingDate = pricing.updated || '';
        this._activeProvider = pricing.provider || 'claude';
        this.render();
      }
    } catch {
      // Keep static defaults
    }
  }

  async _loadCost() {
    try {
      const cost = await this._api.getCost();
      this._updateFromCost(cost);
    } catch (error) {
      this._data.connected = false;
      this.render();
    }
  }

  _updateFromCost(cost) {
    if (!cost) return;

    this._data = {
      ...this._data,
      connected: true,
      total_input_tokens: cost.total_input_tokens || 0,
      total_output_tokens: cost.total_output_tokens || 0,
      estimated_cost_usd: cost.estimated_cost_usd || 0,
      by_phase: cost.by_phase || {},
      by_model: cost.by_model || {},
      budget_limit: cost.budget_limit,
      budget_used: cost.budget_used || 0,
      budget_remaining: cost.budget_remaining,
    };

    this.render();
  }

  _startPolling() {
    this._pollInterval = setInterval(async () => {
      try {
        const cost = await this._api.getCost();
        this._updateFromCost(cost);
      } catch (error) {
        this._data.connected = false;
        this.render();
      }
    }, 5000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  _formatTokens(count) {
    if (!count || count === 0) return '0';
    if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + 'M';
    if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K';
    return String(count);
  }

  _formatUSD(amount) {
    if (!amount || amount === 0) return '$0.00';
    if (amount < 0.01) return '<$0.01';
    return '$' + amount.toFixed(2);
  }

  _getBudgetPercent() {
    if (!this._data.budget_limit || this._data.budget_limit <= 0) return 0;
    return Math.min(100, (this._data.budget_used / this._data.budget_limit) * 100);
  }

  _getBudgetStatusClass() {
    const pct = this._getBudgetPercent();
    if (pct >= 90) return 'critical';
    if (pct >= 70) return 'warning';
    return 'ok';
  }

  _renderPhaseRows() {
    const phases = this._data.by_phase;
    if (!phases || Object.keys(phases).length === 0) {
      return '<tr><td colspan="4" class="empty-cell">No phase data yet</td></tr>';
    }

    return Object.entries(phases).map(([phase, data]) => {
      const input = data.input_tokens || 0;
      const output = data.output_tokens || 0;
      const cost = data.cost_usd || 0;
      return `
        <tr>
          <td class="phase-name">${this._escapeHTML(phase)}</td>
          <td class="mono-cell">${this._formatTokens(input)}</td>
          <td class="mono-cell">${this._formatTokens(output)}</td>
          <td class="mono-cell cost-cell">${this._formatUSD(cost)}</td>
        </tr>
      `;
    }).join('');
  }

  _renderModelRows() {
    const models = this._data.by_model;
    if (!models || Object.keys(models).length === 0) {
      return '<tr><td colspan="4" class="empty-cell">No model data yet</td></tr>';
    }

    return Object.entries(models).map(([model, data]) => {
      const input = data.input_tokens || 0;
      const output = data.output_tokens || 0;
      const cost = data.cost_usd || 0;
      return `
        <tr>
          <td class="model-name">${this._escapeHTML(model)}</td>
          <td class="mono-cell">${this._formatTokens(input)}</td>
          <td class="mono-cell">${this._formatTokens(output)}</td>
          <td class="mono-cell cost-cell">${this._formatUSD(cost)}</td>
        </tr>
      `;
    }).join('');
  }

  _renderBudgetSection() {
    if (this._data.budget_limit === null || this._data.budget_limit === undefined) {
      return `
        <div class="budget-section">
          <div class="section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
            <span class="section-title">Budget</span>
          </div>
          <div class="budget-not-set">No budget configured</div>
        </div>
      `;
    }

    const pct = this._getBudgetPercent();
    const statusClass = this._getBudgetStatusClass();
    const remaining = this._data.budget_remaining != null
      ? this._formatUSD(this._data.budget_remaining)
      : this._formatUSD(this._data.budget_limit - this._data.budget_used);

    return `
      <div class="budget-section">
        <div class="section-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
          </svg>
          <span class="section-title">Budget</span>
        </div>
        <div class="budget-bar-container">
          <div class="budget-bar ${statusClass}" style="width: ${pct.toFixed(1)}%"></div>
        </div>
        <div class="budget-details">
          <span class="budget-used">${this._formatUSD(this._data.budget_used)} used</span>
          <span class="budget-remaining">${remaining} remaining</span>
          <span class="budget-limit">of ${this._formatUSD(this._data.budget_limit)}</span>
        </div>
      </div>
    `;
  }

  _getPricingColorClass(key, model) {
    // Map model keys to CSS color classes
    if (key === 'opus' || key.includes('opus')) return 'opus';
    if (key === 'sonnet' || key.includes('sonnet')) return 'sonnet';
    if (key === 'haiku' || key.includes('haiku')) return 'haiku';
    if (model.provider === 'codex') return 'codex';
    if (model.provider === 'gemini') return 'gemini';
    return '';
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  render() {
    const totalTokens = this._data.total_input_tokens + this._data.total_output_tokens;

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .cost-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Summary Cards */
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px;
        }

        .summary-card {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 10px;
          padding: 14px 16px;
          transition: all var(--loki-transition);
        }

        .summary-card:hover {
          border-color: var(--loki-border-light);
        }

        .card-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
          margin-bottom: 6px;
        }

        .card-value {
          font-size: 22px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-primary);
          line-height: 1.2;
        }

        .card-value.accent {
          color: var(--loki-accent);
        }

        .card-sub {
          font-size: 11px;
          color: var(--loki-text-muted);
          margin-top: 4px;
          font-family: 'JetBrains Mono', monospace;
        }

        /* Section Headers */
        .section-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
        }

        .section-header svg {
          width: 16px;
          height: 16px;
          color: var(--loki-text-muted);
          flex-shrink: 0;
        }

        .section-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
        }

        /* Tables */
        .data-table-container {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 10px;
          padding: 16px;
          overflow-x: auto;
        }

        .data-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .data-table th {
          text-align: left;
          padding: 8px 12px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
          border-bottom: 1px solid var(--loki-border);
        }

        .data-table td {
          padding: 8px 12px;
          color: var(--loki-text-secondary);
          border-bottom: 1px solid var(--loki-border);
        }

        .data-table tr:last-child td {
          border-bottom: none;
        }

        .data-table tr:hover td {
          background: var(--loki-bg-hover);
        }

        .phase-name, .model-name {
          font-weight: 500;
          color: var(--loki-text-primary);
          text-transform: capitalize;
        }

        .mono-cell {
          font-family: 'JetBrains Mono', monospace;
          text-align: right;
        }

        .cost-cell {
          color: var(--loki-accent);
          font-weight: 500;
        }

        .empty-cell {
          text-align: center;
          color: var(--loki-text-muted);
          font-style: italic;
          padding: 16px 12px;
        }

        /* Budget Section */
        .budget-section {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 10px;
          padding: 16px;
        }

        .budget-bar-container {
          width: 100%;
          height: 8px;
          background: var(--loki-bg-tertiary);
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 10px;
        }

        .budget-bar {
          height: 100%;
          border-radius: 4px;
          transition: width 0.5s ease;
        }

        .budget-bar.ok {
          background: var(--loki-green);
        }

        .budget-bar.warning {
          background: var(--loki-yellow);
        }

        .budget-bar.critical {
          background: var(--loki-red);
        }

        .budget-details {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
        }

        .budget-used {
          color: var(--loki-text-primary);
          font-weight: 500;
        }

        .budget-remaining {
          color: var(--loki-text-secondary);
        }

        .budget-limit {
          color: var(--loki-text-muted);
        }

        .budget-not-set {
          color: var(--loki-text-muted);
          font-size: 12px;
          font-style: italic;
        }

        /* Pricing Reference */
        .pricing-ref {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 10px;
          padding: 16px;
        }

        .pricing-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 8px;
          margin-top: 8px;
        }

        .pricing-item {
          background: var(--loki-bg-tertiary);
          border-radius: 8px;
          padding: 10px 12px;
        }

        .pricing-model {
          font-size: 12px;
          font-weight: 600;
          color: var(--loki-text-primary);
          margin-bottom: 4px;
        }

        .pricing-model.opus { color: var(--loki-opus); }
        .pricing-model.sonnet { color: var(--loki-sonnet); }
        .pricing-model.haiku { color: var(--loki-haiku); }
        .pricing-model.codex { color: var(--loki-blue); }
        .pricing-model.gemini { color: var(--loki-green); }

        .pricing-meta {
          font-size: 10px;
          color: var(--loki-text-muted);
          margin-left: auto;
          font-family: 'JetBrains Mono', monospace;
        }

        .pricing-rates {
          font-size: 11px;
          color: var(--loki-text-muted);
          font-family: 'JetBrains Mono', monospace;
          line-height: 1.5;
        }

        /* Offline state */
        .offline-notice {
          text-align: center;
          padding: 20px;
          color: var(--loki-text-muted);
          font-size: 12px;
        }
      </style>

      <div class="cost-container">
        ${!this._data.connected ? `
          <div class="offline-notice">Connecting to cost API...</div>
        ` : ''}

        <!-- Summary Cards -->
        <div class="summary-grid">
          <div class="summary-card">
            <div class="card-label">Total Tokens</div>
            <div class="card-value">${this._formatTokens(totalTokens)}</div>
            <div class="card-sub">${this._formatTokens(this._data.total_input_tokens)} in / ${this._formatTokens(this._data.total_output_tokens)} out</div>
          </div>

          <div class="summary-card">
            <div class="card-label">Input Tokens</div>
            <div class="card-value">${this._formatTokens(this._data.total_input_tokens)}</div>
          </div>

          <div class="summary-card">
            <div class="card-label">Output Tokens</div>
            <div class="card-value">${this._formatTokens(this._data.total_output_tokens)}</div>
          </div>

          <div class="summary-card">
            <div class="card-label">Estimated Cost</div>
            <div class="card-value accent">${this._formatUSD(this._data.estimated_cost_usd)}</div>
          </div>
        </div>

        <!-- Budget -->
        ${this._renderBudgetSection()}

        <!-- Cost by Model -->
        <div class="data-table-container">
          <div class="section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            <span class="section-title">Cost by Model</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th style="text-align:right">Input</th>
                <th style="text-align:right">Output</th>
                <th style="text-align:right">Cost</th>
              </tr>
            </thead>
            <tbody>
              ${this._renderModelRows()}
            </tbody>
          </table>
        </div>

        <!-- Cost by Phase -->
        <div class="data-table-container">
          <div class="section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span class="section-title">Cost by Phase</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th style="text-align:right">Input</th>
                <th style="text-align:right">Output</th>
                <th style="text-align:right">Cost</th>
              </tr>
            </thead>
            <tbody>
              ${this._renderPhaseRows()}
            </tbody>
          </table>
        </div>

        <!-- Pricing Reference -->
        <div class="pricing-ref">
          <div class="section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span class="section-title">API Pricing Reference (per 1M tokens)</span>
            ${this._pricingDate ? `<span class="pricing-meta">Updated: ${this._escapeHTML(this._pricingDate)}</span>` : ''}
          </div>
          <div class="pricing-grid">
            ${Object.entries(MODEL_PRICING).map(([key, m]) => `
            <div class="pricing-item">
              <div class="pricing-model ${this._getPricingColorClass(key, m)}">${m.label || key}</div>
              <div class="pricing-rates">In: $${m.input.toFixed(2)} / Out: $${m.output.toFixed(2)}</div>
            </div>`).join('')}
          </div>
        </div>
      </div>
    `;
  }
}

// Register the component
if (!customElements.get('loki-cost-dashboard')) {
  customElements.define('loki-cost-dashboard', LokiCostDashboard);
}

export default LokiCostDashboard;
