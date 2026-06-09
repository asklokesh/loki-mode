/**
 * @fileoverview Loki Live App Preview - surfaces the app Loki built and
 * started locally so the user can see it run and try it. Embeds the running
 * local app in an iframe, shows a truthful status badge mapped 1:1 to the
 * real app-runner state, a toolbar (refresh, open-in-browser, restart), and a
 * collapsible error banner (with a Technical details disclosure) when the app
 * crashed or failed to start.
 *
 * Honesty constraints (non-negotiable):
 * - The app is a real local build served from localhost on the user's machine.
 *   It is NOT hosted, deployed, or simulated. The transport line
 *   "Running locally - localhost:PORT" is shown whenever the app is running.
 * - The error banner is fed exclusively by the server-side
 *   /api/app-runner/errors endpoint (the running app is cross-origin to the
 *   dashboard, so the browser cannot read errors out of the iframe).
 * - No emojis, no em dashes (plain hyphens only).
 *
 * The iframe src is only (re)loaded on a real state transition (e.g.
 * not-running -> running) or an explicit Refresh, never on every poll, so the
 * preview does not flicker or reset the user's interaction.
 *
 * @example
 * <loki-app-preview api-url="http://localhost:57374" theme="dark"></loki-app-preview>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';

const STATUS_CONFIG = {
  not_initialized: { color: 'var(--loki-text-muted, #71717a)', label: 'No app yet', pulse: false },
  starting:        { color: 'var(--loki-yellow, #ca8a04)',     label: 'Starting',   pulse: true  },
  running:         { color: 'var(--loki-green, #16a34a)',       label: 'Running',    pulse: true  },
  stale:           { color: 'var(--loki-yellow, #ca8a04)',      label: 'Stale',      pulse: false },
  completed:       { color: 'var(--loki-text-muted, #a1a1aa)',  label: 'Completed',  pulse: false },
  failed:          { color: 'var(--loki-red, #dc2626)',         label: 'Could not start', pulse: false },
  crashed:         { color: 'var(--loki-red, #dc2626)',         label: 'Crashed',    pulse: false },
  stopped:         { color: 'var(--loki-text-muted, #a1a1aa)',  label: 'Stopped',    pulse: false },
  error:           { color: 'var(--loki-text-muted, #71717a)',  label: 'Status unavailable', pulse: false },
  unknown:         { color: 'var(--loki-text-muted, #71717a)',  label: 'Unknown',    pulse: false },
};

export class LokiAppPreview extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._api = null;
    this._pollInterval = null;
    this._visibilityHandler = null;
    this._status = null;
    this._errors = null;
    this._error = null;
    this._lastDataHash = null;
    this._detailsOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this.render();
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
    this._pollInterval = setInterval(() => this._loadData(), 3000);
    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this._pollInterval) {
          clearInterval(this._pollInterval);
          this._pollInterval = null;
        }
      } else if (!this._pollInterval) {
        this._loadData();
        this._pollInterval = setInterval(() => this._loadData(), 3000);
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
    try {
      const status = await this._api.getAppRunnerStatus();
      const st = status?.status || 'not_initialized';
      // Only fetch errors when something is wrong, to keep the panel quiet
      // during a healthy run.
      let errors = null;
      if (st === 'crashed' || st === 'failed') {
        try {
          errors = await this._api.getAppRunnerErrors(50);
        } catch {
          errors = null;
        }
      }
      const dataHash = JSON.stringify({
        status: st,
        port: status?.port,
        url: status?.url,
        crash: status?.crash_count,
        errLen: errors?.lines?.length || 0,
        // Include the healthcheck signal so the panel re-renders (and the
        // iframe reloads) when the app transitions from container-up to
        // actually-serving. Without this, an iframe that loaded during the
        // boot window (connection refused) stayed blank forever because
        // status was already "running" and nothing else in the hash changed.
        // Observed on a real compose stack: docker compose up -d returns
        // seconds before the web service answers HTTP.
        healthOk: status?.last_health?.ok === true,
      });
      // A prior poll may have set a transient read error. Clear it on any
      // successful read, even when the data itself is unchanged, so a recovered
      // read never leaves a false error banner on screen (honesty constraint).
      const hadError = this._error !== null;
      if (dataHash === this._lastDataHash && !hadError) return;
      this._lastDataHash = dataHash;
      this._status = status;
      this._errors = errors;
      this._error = null;
      this.render();
    } catch (err) {
      if (!this._error) {
        this._error = `Could not read app status: ${err.message}`;
        this.render();
      }
    }
  }

  _isValidUrl(str) {
    if (!str) return false;
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async _handleRestart() {
    try {
      await this._api.restartApp();
      this._loadData();
    } catch (err) {
      this._error = `Restart failed: ${err.message}`;
      this.render();
    }
  }

  _handleRefresh() {
    // Force the iframe to reload from the live URL with a cache-bust.
    const s = this.shadowRoot;
    if (!s) return;
    const frame = s.querySelector('iframe.preview-frame');
    const st = this._status;
    if (frame && st && this._isValidUrl(st.url)) {
      const bust = (st.url.includes('?') ? '&' : '?') + '_t=' + Date.now();
      frame.src = st.url + bust;
    }
  }

  _handleOpenExternal() {
    const st = this._status;
    if (st && this._isValidUrl(st.url)) {
      window.open(st.url, '_blank', 'noopener');
    }
  }

  _toggleDetails() {
    this._detailsOpen = !this._detailsOpen;
    this.render();
  }

  _getStyles() {
    return `
      .preview { padding: 16px; font-family: var(--loki-font-family, system-ui, -apple-system, sans-serif); color: var(--loki-text-primary, #201515); }
      .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 12px; flex-wrap: wrap; }
      .header-left { display: flex; align-items: center; gap: 10px; }
      .title { font-size: 18px; font-weight: 600; margin: 0; }
      .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
      .status-dot.pulse { animation: dot-pulse 1.5s ease-in-out infinite; }
      @keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 4px; font-size: 12px; font-weight: 500; }
      .transport { font-size: 12px; color: var(--loki-text-muted, #71717a); margin: 0 0 12px 0; }
      .transport a { color: var(--loki-accent, #2563eb); text-decoration: none; }
      .transport a:hover { text-decoration: underline; }
      .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
      .btn { padding: 6px 12px; font-size: 13px; border-radius: 6px; border: 1px solid var(--loki-border, #e4e4e7); background: var(--loki-bg-subtle, #f4f4f5); color: var(--loki-text-primary, #201515); cursor: pointer; }
      .btn:hover:not(:disabled) { background: var(--loki-bg-hover, #e4e4e7); }
      .btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .btn-primary { background: var(--loki-accent, #2563eb); color: #fff; border-color: var(--loki-accent, #2563eb); }
      .frame-wrap { margin-top: 12px; border: 1px solid var(--loki-border, #e4e4e7); border-radius: 8px; overflow: hidden; background: #fff; }
      .preview-frame { width: 100%; height: 480px; border: 0; display: block; background: #fff; }
      .state-block { margin-top: 12px; padding: 32px 16px; text-align: center; border: 1px dashed var(--loki-border, #e4e4e7); border-radius: 8px; color: var(--loki-text-muted, #71717a); }
      .state-block h3 { margin: 0 0 6px 0; font-size: 15px; font-weight: 600; color: var(--loki-text-primary, #201515); }
      .state-block p { margin: 0; font-size: 13px; }
      .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid var(--loki-border, #e4e4e7); border-top-color: var(--loki-accent, #2563eb); border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 8px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .err-banner { margin-top: 12px; border: 1px solid var(--loki-red, #dc2626); border-radius: 8px; background: color-mix(in srgb, var(--loki-red, #dc2626) 8%, transparent); padding: 12px 14px; }
      .err-head { font-weight: 600; color: var(--loki-red, #dc2626); margin: 0 0 4px 0; font-size: 14px; }
      .err-body { font-size: 13px; margin: 0 0 10px 0; }
      .err-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .details-toggle { margin-top: 10px; font-size: 12px; color: var(--loki-text-muted, #71717a); cursor: pointer; user-select: none; background: none; border: none; padding: 0; }
      .details-toggle:hover { text-decoration: underline; }
      .details-body { margin-top: 8px; background: var(--loki-bg-code, #1e1e1e); color: #d4d4d4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 10px; border-radius: 6px; max-height: 200px; overflow: auto; white-space: pre-wrap; }
      .error-banner { margin-top: 12px; padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, var(--loki-red, #dc2626) 10%, transparent); color: var(--loki-red, #dc2626); font-size: 13px; }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const st = this._status;
    const status = st?.status || 'not_initialized';
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.not_initialized;
    const port = st?.port ? this._escapeHtml(String(st.port)) : '?';
    const urlValid = this._isValidUrl(st?.url);

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="preview">
        <div class="header">
          <div class="header-left">
            <h2 class="title">Live App</h2>
            <span class="status-badge" style="background: color-mix(in srgb, ${cfg.color} 15%, transparent); color: ${cfg.color}">
              <span class="status-dot ${cfg.pulse ? 'pulse' : ''}" style="background: ${cfg.color}"></span>
              ${this._escapeHtml(cfg.label)}
            </span>
          </div>
          ${this._renderToolbar(status, urlValid)}
        </div>
        ${status === 'running' && urlValid ? `
          <p class="transport">Running locally - <a href="${this._escapeHtml(st.url)}" target="_blank" rel="noopener noreferrer">${this._escapeHtml(st.url)}</a></p>
        ` : ''}
        ${this._renderSurface(status, urlValid)}
        ${this._renderErrorBanner(status)}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _renderToolbar(status, urlValid) {
    const running = status === 'running' && urlValid;
    const canRestart = status === 'running' || status === 'crashed' || status === 'stopped' || status === 'failed';
    return `
      <div class="toolbar">
        <button class="btn" data-action="refresh" ${running ? '' : 'disabled'}>Refresh</button>
        <button class="btn btn-primary" data-action="open-external" ${running ? '' : 'disabled'}>Open in browser</button>
        <button class="btn" data-action="restart" ${canRestart ? '' : 'disabled'}>Restart</button>
      </div>
    `;
  }

  _renderSurface(status, urlValid) {
    if (status === 'running' && urlValid) {
      const st = this._status;
      return `
        <div class="frame-wrap">
          <iframe
            class="preview-frame"
            src="${this._escapeHtml(st.url)}"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            referrerpolicy="no-referrer"
            title="Live preview of the running app"></iframe>
        </div>
        <p class="transport" style="margin-top: 8px;">Not rendering? Some apps block being embedded. Use "Open in browser" above.</p>
      `;
    }
    if (status === 'starting') {
      return `
        <div class="state-block">
          <div class="spinner"></div>
          <h3>Starting your app...</h3>
          <p>Waiting for the app to respond. This usually takes a few seconds.</p>
        </div>
      `;
    }
    if (status === 'stopped') {
      return `
        <div class="state-block">
          <h3>App is stopped</h3>
          <p>Your app is not running right now. Use Restart to start it again.</p>
        </div>
      `;
    }
    if (status === 'crashed' || status === 'failed') {
      // The error banner carries the detail; keep the surface minimal here.
      return '';
    }
    if (status === 'error') {
      return `
        <div class="state-block">
          <h3>Status unavailable</h3>
          <p>Could not read the app status. Try refreshing.</p>
        </div>
      `;
    }
    // not_initialized / unknown / completed
    return `
      <div class="state-block">
        <h3>No app running yet</h3>
        <p>Loki has not started your app yet. It will appear here automatically once the build is running.</p>
      </div>
    `;
  }

  _renderErrorBanner(status) {
    if (status !== 'crashed' && status !== 'failed') return '';
    const heading = status === 'crashed'
      ? 'Your app stopped after an error'
      : 'Loki could not start your app';
    const body = status === 'crashed'
      ? 'Loki detected a crash in the running app.'
      : 'The app did not start.';
    const lines = (this._errors && Array.isArray(this._errors.lines)) ? this._errors.lines : [];
    const detailText = lines.length > 0
      ? lines.map(l => this._escapeHtml(l)).join('\n')
      : 'No error output captured yet.';
    return `
      <div class="err-banner">
        <p class="err-head">${this._escapeHtml(heading)}</p>
        <p class="err-body">${this._escapeHtml(body)}</p>
        <div class="err-actions">
          <button class="btn" data-action="restart">Restart</button>
        </div>
        <button class="details-toggle" data-action="toggle-details">
          ${this._detailsOpen ? 'Hide technical details' : 'Technical details'}
        </button>
        ${this._detailsOpen ? `<div class="details-body">${detailText}</div>` : ''}
      </div>
    `;
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;
    const bind = (sel, fn) => {
      const el = s.querySelector(sel);
      if (el) el.addEventListener('click', fn);
    };
    // restart may appear in toolbar AND banner; bind all.
    s.querySelectorAll('[data-action="restart"]').forEach(el =>
      el.addEventListener('click', () => this._handleRestart()));
    bind('[data-action="refresh"]', () => this._handleRefresh());
    bind('[data-action="open-external"]', () => this._handleOpenExternal());
    bind('[data-action="toggle-details"]', () => this._toggleDetails());
  }

  _escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

customElements.define('loki-app-preview', LokiAppPreview);
