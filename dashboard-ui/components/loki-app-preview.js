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
    // Iframe load-failure detection. The running app is cross-origin, so the
    // browser cannot read its errors; the only honest in-page signal we have is
    // "did the iframe ever fire load within a few seconds". When it does not we
    // surface a reachable failure state instead of a silent blank frame.
    this._iframeFailed = false;
    this._iframeLoadTimer = null;
    this._IFRAME_LOAD_TIMEOUT_MS = 6000;
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
    this._clearIframeLoadTimer();
  }

  _clearIframeLoadTimer() {
    if (this._iframeLoadTimer) {
      clearTimeout(this._iframeLoadTimer);
      this._iframeLoadTimer = null;
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
        //
        // Capture the health signal as a tri-state (true / false / unknown),
        // not just "=== true". The amber "running but not responding yet" state
        // (last_health.ok === false) must trigger a re-render too, otherwise a
        // run that comes up unhealthy would keep showing the previous surface.
        healthOk: status?.last_health?.ok === true
          ? 'ok'
          : status?.last_health?.ok === false
            ? 'down'
            : 'unknown',
      });
      // A prior poll may have set a transient read error. Clear it on any
      // successful read, even when the data itself is unchanged, so a recovered
      // read never leaves a false error banner on screen (honesty constraint).
      const hadError = this._error !== null;
      if (dataHash === this._lastDataHash && !hadError) return;
      // A real state transition (url/status/health change) means the iframe is
      // about to be re-rendered with a fresh src, so clear any prior load
      // failure -- the previous failure no longer describes the new attempt.
      this._iframeFailed = false;
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
      this._iframeFailed = false;
      this._clearIframeLoadTimer();
      const bust = (st.url.includes('?') ? '&' : '?') + '_t=' + Date.now();
      frame.src = st.url + bust;
      this._armIframeLoadDetection();
    }
  }

  _handleRetryFrame() {
    // Clear the failure flag, force a fresh status read, and re-render. If the
    // app is now reachable the iframe path renders again; if not, the load
    // detection re-arms and we fall back to the honest failure surface.
    this._iframeFailed = false;
    this._lastDataHash = null;
    this.render();
    this._loadData();
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

  /**
   * Map the raw app-runner status plus the truthful last_health.ok signal to
   * the badge/surface the panel should actually show. This keeps the green
   * "Running" badge honest: a process that is up but not yet answering HTTP
   * (last_health.ok === false) is shown as amber "Starting / not responding
   * yet", not green, and the embed iframe is withheld until health is ok.
   *
   * Returns { view, healthOk } where view is the effective status key into
   * STATUS_CONFIG and healthOk is the tri-state (true | false | null/unknown).
   */
  _effectiveView(status, urlValid) {
    const st = this._status;
    const health = st?.last_health;
    const healthOk = (health && typeof health.ok === 'boolean') ? health.ok : null;

    if (status === 'running' && urlValid) {
      if (healthOk === false) {
        // Up but not responding yet: amber, no iframe, no embed-blame hint.
        return { view: 'starting', healthOk };
      }
      if (healthOk === true) {
        return { view: 'running', healthOk };
      }
      // Health unknown during the boot grace window: treat as running so the
      // iframe gets a chance to load (rare in practice -- the runner writes
      // {"ok": false} by default -- but avoids a false amber on first paint).
      const startedAt = st?.started_at ? Date.parse(st.started_at) : NaN;
      const withinGrace = Number.isFinite(startedAt) && (Date.now() - startedAt) < 15000;
      return { view: withinGrace ? 'running' : 'starting', healthOk };
    }
    return { view: status, healthOk };
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;
    // Clear any in-flight load timer before re-rendering so a stale timer can
    // never fire against an iframe that no longer exists (or a surface we have
    // since switched away from). It is re-armed below only on the iframe path.
    this._clearIframeLoadTimer();

    const st = this._status;
    const rawStatus = st?.status || 'not_initialized';
    const urlValid = this._isValidUrl(st?.url);
    const { view, healthOk } = this._effectiveView(rawStatus, urlValid);
    const cfg = STATUS_CONFIG[view] || STATUS_CONFIG.not_initialized;
    // Honest amber label when up-but-unreachable (overrides the generic
    // "Starting" copy so the user knows the process is up but not answering).
    const label = (rawStatus === 'running' && healthOk === false)
      ? 'Starting / not responding yet'
      : cfg.label;

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="preview">
        <div class="header">
          <div class="header-left">
            <h2 class="title">Live App</h2>
            <span class="status-badge" style="background: color-mix(in srgb, ${cfg.color} 15%, transparent); color: ${cfg.color}">
              <span class="status-dot ${cfg.pulse ? 'pulse' : ''}" style="background: ${cfg.color}"></span>
              ${this._escapeHtml(label)}
            </span>
          </div>
          ${this._renderToolbar(view, urlValid)}
        </div>
        ${view === 'running' && urlValid ? `
          <p class="transport">Running locally - <a href="${this._escapeHtml(st.url)}" target="_blank" rel="noopener noreferrer">${this._escapeHtml(st.url)}</a></p>
        ` : ''}
        ${this._renderSurface(view, urlValid, healthOk)}
        ${this._renderErrorBanner(rawStatus)}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
    this._armIframeLoadDetection();
  }

  /**
   * When the iframe is on screen, wire its load/error events and start a
   * timeout. If the iframe neither loads nor errors within the window we flip
   * to an honest "not reachable yet" surface (Retry + Open in browser) rather
   * than leaving a silent blank frame.
   */
  _armIframeLoadDetection() {
    const s = this.shadowRoot;
    if (!s) return;
    const frame = s.querySelector('iframe.preview-frame');
    if (!frame) return;
    const onLoaded = () => {
      this._clearIframeLoadTimer();
    };
    frame.addEventListener('load', onLoaded);
    frame.addEventListener('error', () => {
      this._clearIframeLoadTimer();
      if (!this._iframeFailed) {
        this._iframeFailed = true;
        this.render();
      }
    });
    this._iframeLoadTimer = setTimeout(() => {
      this._iframeLoadTimer = null;
      if (!this._iframeFailed) {
        this._iframeFailed = true;
        this.render();
      }
    }, this._IFRAME_LOAD_TIMEOUT_MS);
  }

  _renderToolbar(status, urlValid) {
    // Refresh / Open-in-browser are useful whenever we have a valid URL and the
    // app is meant to be up (running, or amber starting, or stale), so the user
    // can poke an unreachable app without waiting for the next poll.
    const hasLiveUrl = urlValid && (status === 'running' || status === 'starting' || status === 'stale');
    const canRestart = status === 'running' || status === 'starting' || status === 'stale'
      || status === 'crashed' || status === 'stopped' || status === 'failed';
    return `
      <div class="toolbar">
        <button class="btn" data-action="refresh" ${hasLiveUrl ? '' : 'disabled'}>Refresh</button>
        <button class="btn btn-primary" data-action="open-external" ${hasLiveUrl ? '' : 'disabled'}>Open in browser</button>
        <button class="btn" data-action="restart" ${canRestart ? '' : 'disabled'}>Restart</button>
      </div>
    `;
  }

  _renderSurface(status, urlValid, healthOk) {
    if (status === 'running' && urlValid) {
      const st = this._status;
      if (this._iframeFailed) {
        // Health is ok (we only reach the running view when last_health.ok is
        // true or unknown-in-grace) but the iframe still did not render. The
        // most likely cause is the app refusing to be embedded, so the
        // embed-blame copy belongs HERE, not on a healthy frame.
        return `
          <div class="state-block">
            <h3>Could not show the app here</h3>
            <p>The app started but did not render in this preview. Some apps block being embedded in a frame. Open it in your browser to use it.</p>
            <div class="err-actions" style="justify-content: center; margin-top: 12px;">
              <button class="btn btn-primary" data-action="open-external">Open in browser</button>
              <button class="btn" data-action="retry-frame">Retry</button>
            </div>
          </div>
        `;
      }
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
      // Covers both the genuine startup window and the "process up but not
      // answering HTTP yet" case (last_health.ok === false on a running pid).
      const notResponding = healthOk === false;
      const heading = notResponding ? 'App is up but not responding yet' : 'Starting your app...';
      const body = notResponding
        ? 'The process started but is not answering requests yet. This can take a few seconds, or it may mean the app is still booting or failing to bind its port.'
        : 'Waiting for the app to respond. This usually takes a few seconds.';
      const actions = urlValid ? `
        <div class="err-actions" style="justify-content: center; margin-top: 12px;">
          <button class="btn" data-action="open-external">Open in browser</button>
          <button class="btn" data-action="retry-frame">Retry</button>
        </div>
      ` : '';
      return `
        <div class="state-block">
          <div class="spinner"></div>
          <h3>${this._escapeHtml(heading)}</h3>
          <p>${this._escapeHtml(body)}</p>
          ${actions}
        </div>
      `;
    }
    if (status === 'stale') {
      const actions = `
        <div class="err-actions" style="justify-content: center; margin-top: 12px;">
          <button class="btn" data-action="restart">Restart</button>
          ${urlValid ? '<button class="btn" data-action="open-external">Open in browser</button>' : ''}
        </div>
      `;
      return `
        <div class="state-block">
          <h3>App may no longer be running</h3>
          <p>Loki has not had a fresh health signal from this app recently and could not confirm it is still alive. Restart it, or open it in your browser to check.</p>
          ${actions}
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
    // restart and open-external can each appear in BOTH the toolbar AND a
    // surface/banner (e.g. the iframe-failed surface uses Open-in-browser as its
    // primary CTA), so bind every instance, not just the first match.
    s.querySelectorAll('[data-action="restart"]').forEach(el =>
      el.addEventListener('click', () => this._handleRestart()));
    s.querySelectorAll('[data-action="open-external"]').forEach(el =>
      el.addEventListener('click', () => this._handleOpenExternal()));
    s.querySelectorAll('[data-action="retry-frame"]').forEach(el =>
      el.addEventListener('click', () => this._handleRetryFrame()));
    bind('[data-action="refresh"]', () => this._handleRefresh());
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
