/**
 * @fileoverview Loki Dashboard Header Component - provides a consistent
 * top-level header bar with logo, connection status, theme toggle, and
 * session info.
 *
 * G78: Dashboard Header
 *
 * @example
 * <loki-dashboard-header api-url="http://localhost:57374"></loki-dashboard-header>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';
import { LokiTheme } from '../core/loki-theme.js';

/**
 * @class LokiDashboardHeader
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {string} project-name - Current project name
 */
export class LokiDashboardHeader extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'project-name', 'theme'];
  }

  constructor() {
    super();
    this._connected = false;
    this._projectName = '';
    this._uptimeSeconds = 0;
    this._status = 'offline';
    this._api = null;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadStatus();
    this._startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
    if (this._api) {
      if (this._statusHandler) this._api.removeEventListener(ApiEvents.STATUS_UPDATE, this._statusHandler);
      if (this._connHandler) this._api.removeEventListener(ApiEvents.CONNECTED, this._connHandler);
      if (this._discHandler) this._api.removeEventListener(ApiEvents.DISCONNECTED, this._discHandler);
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'project-name') {
      this._projectName = newValue || '';
      this.render();
    }
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._loadStatus();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });

    this._statusHandler = (e) => this._updateFromStatus(e.detail);
    this._connHandler = () => { this._connected = true; this.render(); };
    this._discHandler = () => { this._connected = false; this._status = 'offline'; this.render(); };

    this._api.addEventListener(ApiEvents.STATUS_UPDATE, this._statusHandler);
    this._api.addEventListener(ApiEvents.CONNECTED, this._connHandler);
    this._api.addEventListener(ApiEvents.DISCONNECTED, this._discHandler);
  }

  async _loadStatus() {
    try {
      const status = await this._api.getStatus();
      this._updateFromStatus(status);
    } catch {
      this._connected = false;
      this._status = 'offline';
    }
    this.render();
  }

  _updateFromStatus(status) {
    if (!status) return;
    this._connected = true;
    this._status = status.status || 'offline';
    this._uptimeSeconds = status.uptime_seconds || 0;
    if (status.project_name) {
      this._projectName = status.project_name;
    }
  }

  _startPolling() {
    // The header is always-visible chrome (not inside a .section-page), so it
    // opts OUT of section gating (sectionId: null) and is gated on tab
    // visibility ONLY: a hidden tab does not poll, but any active section keeps
    // the header status fresh. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadStatus(),
      intervalMs: 10000,
      sectionId: null,
      immediate: false,
    });
  }

  _stopPolling() {
    if (this._poll) {
      this._poll.stop();
      this._poll = null;
    }
  }

  _formatUptime(seconds) {
    if (!seconds || seconds < 0) return '--';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${Math.floor(seconds)}s`;
  }

  _toggleTheme() {
    LokiTheme.toggle();
  }

  render() {
    const isDark = this._theme && (this._theme.includes('dark') || this._theme === 'high-contrast');
    const connClass = this._connected ? 'connected' : 'disconnected';
    const connLabel = this._connected ? 'Connected' : 'Disconnected';
    const projectName = this._projectName || 'No project';
    const uptime = this._formatUptime(this._uptimeSeconds);

    // Sun icon for light mode toggle, moon icon for dark mode toggle
    const sunIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    const moonIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .header-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px;
          background: var(--loki-bg-card);
          border-bottom: 1px solid var(--loki-border);
          gap: 16px;
        }

        .header-left {
          display: flex;
          align-items: baseline;
          gap: 12px;
          min-width: 0;
        }

        .logo-brand {
          font-family: 'DM Serif Display', Georgia, serif;
          font-size: 18px;
          font-weight: 400;
          color: var(--loki-text-primary);
          letter-spacing: -0.01em;
          white-space: nowrap;
        }

        .logo-subtitle {
          font-size: 11px;
          color: var(--loki-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          white-space: nowrap;
        }

        .header-right {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-shrink: 0;
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--loki-text-muted);
        }

        .conn-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .conn-dot.connected {
          background: var(--loki-green);
          box-shadow: 0 0 6px var(--loki-green);
        }

        .conn-dot.disconnected {
          background: var(--loki-red);
        }

        .session-info {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 11px;
          color: var(--loki-text-secondary);
          padding: 4px 10px;
          background: var(--loki-bg-secondary);
          border-radius: 4px;
          border: 1px solid var(--loki-border);
        }

        .session-info-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .session-info-label {
          color: var(--loki-text-muted);
        }

        .session-info-value {
          font-weight: 500;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
        }

        .session-separator {
          width: 1px;
          height: 14px;
          background: var(--loki-border);
        }

        .theme-toggle-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-secondary);
          color: var(--loki-text-secondary);
          cursor: pointer;
          transition: all var(--loki-transition);
        }

        .theme-toggle-btn:hover {
          background: var(--loki-bg-hover);
          color: var(--loki-text-primary);
          border-color: var(--loki-border-light);
        }

        @media (max-width: 768px) {
          .header-bar {
            flex-wrap: wrap;
            padding: 10px 14px;
          }
          .session-info {
            display: none;
          }
          .logo-subtitle {
            display: none;
          }
        }
      </style>

      <header class="header-bar">
        <div class="header-left">
          <span class="logo-brand">Loki Dashboard</span>
          <span class="logo-subtitle">Autonomi</span>
        </div>

        <div class="header-right">
          <div class="connection-status">
            <span class="conn-dot ${connClass}"></span>
            <span>${connLabel}</span>
          </div>

          <div class="session-info">
            <div class="session-info-item">
              <span class="session-info-label">Project:</span>
              <span class="session-info-value">${this._escapeHtml(projectName)}</span>
            </div>
            <span class="session-separator"></span>
            <div class="session-info-item">
              <span class="session-info-label">Uptime:</span>
              <span class="session-info-value">${this._escapeHtml(uptime)}</span>
            </div>
          </div>

          <button class="theme-toggle-btn" id="theme-btn" title="Toggle theme" aria-label="Toggle dark mode">
            ${isDark ? sunIcon : moonIcon}
          </button>
        </div>
      </header>
    `;

    const themeBtn = this.shadowRoot.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => this._toggleTheme());
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('loki-dashboard-header')) {
  customElements.define('loki-dashboard-header', LokiDashboardHeader);
}

export default LokiDashboardHeader;
