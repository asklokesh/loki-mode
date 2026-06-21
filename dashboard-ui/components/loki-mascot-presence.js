/**
 * @fileoverview <loki-mascot-presence> - a small, honest Loki presence for the
 * dashboard chrome. Renders the brand mascot (<loki-mascot>) and picks his
 * expression from the live run state, so the engine's own dashboard shows the
 * same character that appears everywhere else the engine is used.
 *
 * Honesty: the top-level /api/status only distinguishes idle / running /
 * autonomous / paused / stopped. It carries NO verified/failed signal, so this
 * component deliberately maps ONLY to states it can prove:
 *   - idle / stopped / offline        -> Loki "idle"     (resting, claims nothing)
 *   - running / autonomous            -> Loki "building" (focused work)
 *   - paused                          -> Loki "sleeping" (paused; not done, not failed)
 * It never shows "celebrating" (a VERIFIED result) or "concerned" (a failure),
 * because neither is reachable from this surface without real proof plumbing.
 * Mapping reference: packages/loki-mascot/CHARACTER.md (build-state mapping).
 *
 * It reuses the shared API client's STATUS_UPDATE stream (the same one the rest
 * of the dashboard listens to) rather than starting its own poll.
 *
 * @example
 * <loki-mascot-presence api-url="http://localhost:57374" size="34"></loki-mascot-presence>
 */

import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';
// Side-effect import: registers the <loki-mascot> custom element. Vendored from
// autonomi-saas (see components/vendor/loki-mascot/PROVENANCE.md).
import './vendor/loki-mascot/loki-mascot.js';

/** Map a top-level run status to an honest Loki emotion. */
function emotionForStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'running':
    case 'autonomous':
      return 'building';
    case 'paused':
      return 'sleeping';
    // idle, stopped, offline, '' and anything unknown -> calm, claims nothing.
    default:
      return 'idle';
  }
}

export class LokiMascotPresence extends HTMLElement {
  static get observedAttributes() {
    return ['api-url', 'size'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._status = 'idle';
    this._api = null;
    this._statusHandler = null;
    this._discHandler = null;
    this._poll = null;
  }

  connectedCallback() {
    this._setupApi();
    this._loadStatus();
    this._startPolling();
    this.render();
  }

  disconnectedCallback() {
    if (this._poll) {
      this._poll.stop();
      this._poll = null;
    }
    if (this._api) {
      if (this._statusHandler) this._api.removeEventListener(ApiEvents.STATUS_UPDATE, this._statusHandler);
      if (this._discHandler) this._api.removeEventListener(ApiEvents.DISCONNECTED, this._discHandler);
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._loadStatus();
    }
    if (name === 'size') {
      this.render();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });

    this._statusHandler = (e) => this._updateFromStatus(e.detail);
    // A dropped connection means we cannot prove a run is happening: rest.
    this._discHandler = () => { this._status = 'offline'; this.render(); };

    this._api.addEventListener(ApiEvents.STATUS_UPDATE, this._statusHandler);
    this._api.addEventListener(ApiEvents.DISCONNECTED, this._discHandler);
  }

  _startPolling() {
    // Header chrome (always visible, not inside a section page), so it opts OUT
    // of section gating (sectionId: null) and polls on tab visibility only. The
    // STATUS_UPDATE subscription gives instant updates when the shared WS is
    // connected; this poll guarantees the expression still tracks a run that
    // starts later even if no other component has opened the WS. connectedCallback
    // already did the first load, so immediate is disabled (no duplicate fetch).
    this._poll = registerPoll({
      loadFn: () => this._loadStatus(),
      intervalMs: 10000,
      sectionId: null,
      immediate: false,
    });
  }

  async _loadStatus() {
    try {
      const status = await this._api.getStatus();
      this._updateFromStatus(status);
    } catch {
      this._status = 'offline';
      this.render();
    }
  }

  _updateFromStatus(status) {
    if (!status) return;
    const next = status.status || 'idle';
    if (next !== this._status) {
      this._status = next;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;
    const size = this.getAttribute('size') || '34';
    const emotion = emotionForStatus(this._status);

    // The mascot is self-contained (Shadow DOM, brand-exact, a11y, reduced
    // motion). We only host it and size it; its own aria-label names the state.
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-flex; align-items: center; line-height: 0; }
        loki-mascot { display: inline-block; }
      </style>
      <loki-mascot emotion="${emotion}" size="${size}"></loki-mascot>
    `;
  }
}

if (!customElements.get('loki-mascot-presence')) {
  customElements.define('loki-mascot-presence', LokiMascotPresence);
}

export default LokiMascotPresence;
