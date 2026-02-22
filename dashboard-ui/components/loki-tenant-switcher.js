/**
 * @fileoverview Multi-Tenant Context Switcher - dropdown component for
 * switching between tenants. Dispatches a 'tenant-changed' custom event
 * when the user selects a different tenant. Includes an "All tenants"
 * option for unfiltered views.
 *
 * @example
 * <loki-tenant-switcher api-url="http://localhost:57374" theme="dark"></loki-tenant-switcher>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

/**
 * Format a tenant for display.
 * @param {Object} tenant - Tenant object with name and slug
 * @returns {string} Display string
 */
export function formatTenantLabel(tenant) {
  if (!tenant) return 'Unknown';
  if (tenant.slug && tenant.name) {
    return `${tenant.name} (${tenant.slug})`;
  }
  return tenant.name || tenant.slug || 'Unknown';
}

/**
 * @class LokiTenantSwitcher
 * @extends LokiElement
 * @fires tenant-changed - When the user selects a different tenant
 * @property {string} api-url - API base URL
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiTenantSwitcher extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._tenants = [];
    this._selectedTenantId = null;
    this._dropdownOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadData();

    // Close dropdown on outside click
    this._outsideClickHandler = (e) => {
      if (this._dropdownOpen && !this.contains(e.target)) {
        this._dropdownOpen = false;
        this.render();
      }
    };
    document.addEventListener('click', this._outsideClickHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler);
      this._outsideClickHandler = null;
    }
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

  async _loadData() {
    try {
      this._loading = true;
      const data = await this._api._get('/api/v2/tenants');
      this._tenants = Array.isArray(data) ? data : (data?.tenants || []);
      this._error = null;
    } catch (err) {
      this._error = `Failed to load tenants: ${err.message}`;
    } finally {
      this._loading = false;
    }

    this.render();
  }

  _toggleDropdown() {
    this._dropdownOpen = !this._dropdownOpen;
    this.render();
  }

  _selectTenant(tenantId, tenantName) {
    this._selectedTenantId = tenantId;
    this._dropdownOpen = false;
    this.render();

    this.dispatchEvent(new CustomEvent('tenant-changed', {
      detail: { tenantId, tenantName },
      bubbles: true,
      composed: true,
    }));
  }

  _getSelectedTenant() {
    if (this._selectedTenantId == null) return null;
    return this._tenants.find(t => (t.id || t.slug) === this._selectedTenantId) || null;
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _getStyles() {
    return `
      :host {
        display: inline-block;
        position: relative;
      }

      .tenant-switcher {
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #fafafa);
        position: relative;
      }

      .trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: var(--loki-bg-card, #18181b);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        color: var(--loki-text-primary, #fafafa);
        transition: all 0.15s ease;
        min-width: 180px;
        justify-content: space-between;
      }

      .trigger:hover {
        border-color: var(--loki-border-light, rgba(255, 255, 255, 0.1));
      }

      .trigger.open {
        border-color: var(--loki-accent, #8b5cf6);
      }

      .trigger-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .trigger-icon {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--loki-text-muted, #52525b);
        transition: transform 0.15s ease;
      }

      .trigger-icon.open {
        transform: rotate(180deg);
      }

      .dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        min-width: 220px;
        background: var(--loki-bg-card, #18181b);
        border: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        z-index: 100;
        overflow: hidden;
      }

      .dropdown-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.1s ease;
        color: var(--loki-text-primary, #fafafa);
        border: none;
        background: none;
        width: 100%;
        text-align: left;
      }

      .dropdown-item:hover {
        background: var(--loki-bg-hover, #1f1f23);
      }

      .dropdown-item.selected {
        background: var(--loki-accent-muted, rgba(139, 92, 246, 0.15));
        color: var(--loki-accent, #8b5cf6);
      }

      .dropdown-item.all-tenants {
        border-bottom: 1px solid var(--loki-border, rgba(255, 255, 255, 0.06));
        font-weight: 500;
      }

      .tenant-slug {
        font-size: 11px;
        color: var(--loki-text-muted, #52525b);
        font-family: 'JetBrains Mono', monospace;
      }

      .tenant-info {
        display: flex;
        flex-direction: column;
        gap: 1px;
        overflow: hidden;
      }

      .tenant-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .check-mark {
        margin-left: auto;
        color: var(--loki-accent, #8b5cf6);
        font-size: 14px;
        flex-shrink: 0;
      }

      .error-text {
        padding: 8px 14px;
        color: var(--loki-red, #ef4444);
        font-size: 12px;
      }

      .loading-text {
        padding: 8px 14px;
        color: var(--loki-text-muted, #52525b);
        font-size: 12px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const selected = this._getSelectedTenant();
    const triggerText = selected ? formatTenantLabel(selected) : 'All Tenants';
    const isOpen = this._dropdownOpen;

    let dropdownHtml = '';
    if (isOpen) {
      let itemsHtml;
      if (this._loading) {
        itemsHtml = '<div class="loading-text">Loading tenants...</div>';
      } else if (this._error) {
        itemsHtml = `<div class="error-text">${this._escapeHtml(this._error)}</div>`;
      } else {
        const allSelected = this._selectedTenantId == null;
        itemsHtml = `
          <button class="dropdown-item all-tenants ${allSelected ? 'selected' : ''}" data-tenant-id="">
            <span class="tenant-name">All Tenants</span>
            ${allSelected ? '<span class="check-mark">*</span>' : ''}
          </button>
          ${this._tenants.map(t => {
            const id = t.id || t.slug;
            const isSelected = this._selectedTenantId === id;
            return `
              <button class="dropdown-item ${isSelected ? 'selected' : ''}"
                      data-tenant-id="${this._escapeHtml(String(id))}"
                      data-tenant-name="${this._escapeHtml(t.name || '')}">
                <div class="tenant-info">
                  <span class="tenant-name">${this._escapeHtml(t.name || 'Unnamed')}</span>
                  ${t.slug ? `<span class="tenant-slug">${this._escapeHtml(t.slug)}</span>` : ''}
                </div>
                ${isSelected ? '<span class="check-mark">*</span>' : ''}
              </button>
            `;
          }).join('')}
        `;
      }

      dropdownHtml = `<div class="dropdown">${itemsHtml}</div>`;
    }

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="tenant-switcher">
        <button class="trigger ${isOpen ? 'open' : ''}" id="trigger-btn">
          <span class="trigger-label">${this._escapeHtml(triggerText)}</span>
          <span class="trigger-icon ${isOpen ? 'open' : ''}">&#9660;</span>
        </button>
        ${dropdownHtml}
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    const triggerBtn = s.getElementById('trigger-btn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleDropdown();
      });
    }

    s.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const tenantId = item.dataset.tenantId || null;
        const tenantName = item.dataset.tenantName || null;
        this._selectTenant(tenantId || null, tenantName || 'All Tenants');
      });
    });
  }
}

if (!customElements.get('loki-tenant-switcher')) {
  customElements.define('loki-tenant-switcher', LokiTenantSwitcher);
}

export default LokiTenantSwitcher;
