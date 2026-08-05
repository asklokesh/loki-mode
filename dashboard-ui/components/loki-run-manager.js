/**
 * @fileoverview Run Manager - displays a table of runs with cancel and replay
 * controls. Shows run ID, project, status, trigger, start time, and duration.
 * Running runs can be cancelled, completed/failed runs can be replayed.
 *
 * @example
 * <loki-run-manager api-url="http://localhost:57374" project-id="5" theme="dark"></loki-run-manager>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';
import { dataFreshness, freshnessText, freshestRowS } from '../core/loki-freshness.js';

/** @type {Object<string, {color: string, bg: string, label: string}>} */
const RUN_STATUS_CONFIG = {
  running:   { color: 'var(--loki-green, #22c55e)',      bg: 'var(--loki-green-muted, rgba(34, 197, 94, 0.15))',  label: 'Running' },
  completed: { color: 'var(--loki-blue, #3b82f6)',       bg: 'var(--loki-blue-muted, rgba(59, 130, 246, 0.15))',  label: 'Completed' },
  failed:    { color: 'var(--loki-red, #ef4444)',        bg: 'var(--loki-red-muted, rgba(239, 68, 68, 0.15))',    label: 'Failed' },
  cancelled: { color: 'var(--loki-yellow, #eab308)',     bg: 'var(--loki-yellow-muted, rgba(234, 179, 8, 0.15))', label: 'Cancelled' },
  pending:   { color: 'var(--loki-text-muted, #939084)', bg: 'var(--loki-bg-tertiary, #ECEAE3)',                   label: 'Pending' },
  queued:    { color: 'var(--loki-text-muted, #939084)', bg: 'var(--loki-bg-tertiary, #ECEAE3)',                   label: 'Queued' },

  // A THIRD VOCABULARY: the orchestrator's own phases. api_runs._current_status
  // reads .loki/state/orchestrator.json `currentPhase` (the same file the CLI
  // reads at autonomy/loki:4782), so a LIVE run now arrives here as
  // 'building' or 'bootstrap' rather than 'running'. Without these entries the
  // lookup below falls through to `pending`, and a build that is actively
  // running renders the badge "PENDING" -- worse than unknown, because it
  // states something false with confidence.
  building:  { color: 'var(--loki-green, #22c55e)',      bg: 'var(--loki-green-muted, rgba(34, 197, 94, 0.15))',  label: 'Building' },
  bootstrap: { color: 'var(--loki-green, #22c55e)',      bg: 'var(--loki-green-muted, rgba(34, 197, 94, 0.15))',  label: 'Bootstrap' },
  complete:  { color: 'var(--loki-blue, #3b82f6)',       bg: 'var(--loki-blue-muted, rgba(59, 130, 246, 0.15))',  label: 'Completed' },
  stopped:   { color: 'var(--loki-yellow, #eab308)',     bg: 'var(--loki-yellow-muted, rgba(234, 179, 8, 0.15))', label: 'Stopped' },
  paused:    { color: 'var(--loki-yellow, #eab308)',     bg: 'var(--loki-yellow-muted, rgba(234, 179, 8, 0.15))', label: 'Paused' },

  // UNKNOWN IS ITS OWN STATE, not a synonym for pending. api_runs returns
  // "unknown" when no signal was found, and rendering that as "Pending" would
  // claim a run is queued when the truth is that nothing could be read.
  unknown:   { color: 'var(--loki-text-muted, #939084)', bg: 'var(--loki-bg-tertiary, #ECEAE3)',                   label: 'Unknown' },
};

/**
 * Format a duration from milliseconds or compute from start/end timestamps.
 * @param {number|null} durationMs - Duration in ms, or null
 * @param {string|null} startedAt - ISO start timestamp
 * @param {string|null} endedAt - ISO end timestamp
 * @returns {string}
 */
export function formatRunDuration(durationMs, startedAt, endedAt) {
  let ms = durationMs;
  if (ms == null && startedAt) {
    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : Date.now();
    ms = end - start;
  }
  if (ms == null || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}m ${remainSec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

/**
 * Format a timestamp for display in the run table.
 * @param {string|null} timestamp - ISO timestamp
 * @returns {string}
 */
export function formatRunTime(timestamp) {
  if (!timestamp) return '--';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

/**
 * @class LokiRunManager
 * @extends LokiElement
 * @property {string} api-url - API base URL
 * @property {number} project-id - Optional project ID filter
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiRunManager extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'project-id', 'theme'];
  }

  constructor() {
    super();
    this._loading = false;
    this._error = null;
    this._api = null;
    this._runs = [];
    this._pollInterval = null;
    this._lastDataHash = null;
    // An empty result must be able to say WHY. The envelope readers
    // (dashboard/api_runs.py) carry `reason`; without keeping it, "no runs
    // exist" and "the runs could not be read" render identically, which is
    // the single most misleading thing a monitoring panel can do.
    this._emptyReason = null;
    // Which files the answer was read from. An empty panel that cannot say
    // what it looked at cannot be audited.
    this._source = null;
    // Freshness inputs. `_freshPayload` holds whatever the response carried a
    // server-side freshness_s on (the envelope, or the newest run row);
    // `_changedAtMs` is the fallback clock for a payload that carries none.
    // Both stay null until a load actually succeeds, so a component that has
    // never loaded reports UNKNOWN rather than "0s ago".
    this._freshPayload = null;
    this._changedAtMs = null;
  }

  /**
   * Current data age for this component.
   *
   * Prefers the server's freshness_s (the age of the FILE the answer was read
   * from) and falls back to when this data last CHANGED. /api/v2/runs returns
   * a bare list from the SQL store, but its filesystem fallback rows
   * (dashboard/api_runs.py `_row`) each carry freshness_s -- so the
   * authoritative path is live whenever the data came from the filesystem,
   * which is every real `loki start`.
   */
  _freshness() {
    // The AGE is always shown. The STALE MARKER is scoped to a run that claims
    // to be running, and that scoping is the whole point of it.
    //
    // freshness_s grows without bound on an idle workspace, so an unscoped
    // threshold would paint a permanent warning over "the last run finished
    // three days ago" -- which is true, unremarkable, and exactly how you
    // train an operator to stop reading a marker. A run whose status says
    // RUNNING while its files have not been touched in two minutes is the
    // actionable case: something claims to be working and is not writing.
    // Set staleAfterS to Infinity rather than skipping the computation, so
    // `known` and `ageS` keep their meaning and only `isStale` is suppressed.
    //
    // TWO ROUTES, TWO VOCABULARIES, so the predicate accepts either. The SQL
    // store says `running` (the vocabulary this file's own RUN_STATUS_CONFIG
    // and its Cancel button already assume). The filesystem fallback in
    // dashboard/api_runs._row -- which is the ONLY route that carries
    // freshness_s, and therefore the only one where a server-authoritative age
    // exists at all -- passes `.loki/session.json`'s status straight through
    // and additionally marks the live run with `current: true`. Historical
    // rows there are hardcoded "unknown". Keying on `current` as well as the
    // status string means the marker cannot be silently inert on the exact
    // path that has the better age, which is what a status-string-only
    // predicate would risk on any runner that renames its session status.
    const isLive = (r) => {
      if (!r) return false;
      if (r.current === true) return true;
      const s = String(r.status || '').toLowerCase();
      return s === 'running' || s === 'in_progress' || s === 'active';
    };
    return dataFreshness({
      payload: this._freshPayload,
      receivedAtMs: this._changedAtMs,
      staleAfterS: this._runs.some(isLive) ? undefined : Infinity,
    });
  }

  /**
   * Patch the freshness span in place, without rebuilding the shadow DOM.
   * Used on the unchanged-data path so a scrolling table keeps its scroll
   * position while the age keeps ticking.
   */
  _renderFreshness() {
    const el = this.shadowRoot && this.shadowRoot.getElementById('freshness');
    if (!el) return;
    const f = this._freshness();
    el.className = `freshness ${!f.known ? 'is-unknown' : (f.isStale ? 'is-stale' : '')}`;
    el.dataset.source = f.source;
    el.dataset.stale = f.isStale === null ? 'unknown' : String(f.isStale);
    // textContent, not innerHTML: freshnessText is generated, but assigning it
    // as markup would be one refactor away from injecting a server string.
    el.textContent = freshnessText(f);
  }

  get projectId() {
    const val = this.getAttribute('project-id');
    return val ? parseInt(val, 10) : null;
  }

  set projectId(val) {
    if (val != null) {
      this.setAttribute('project-id', String(val));
    } else {
      this.removeAttribute('project-id');
    }
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
    if (name === 'project-id') {
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
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, replacing the per-component
    // visibilitychange handler. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadData(),
      intervalMs: 5000,
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

  async _loadData() {
    const api = this._api;
    try {
      const projectId = this.projectId;
      const query = projectId != null ? `?project_id=${projectId}` : '';
      const data = await api._get(`/api/v2/runs${query}`);
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      const runs = data?.runs || data || [];
      const rows = Array.isArray(runs) ? runs : [];
      // Envelope first (a reader that returns {runs, freshness_s}); otherwise
      // the freshest of the rows, which is where the filesystem adapter in
      // dashboard/api_runs.py puts it.
      this._freshPayload =
        (data && typeof data === 'object' && !Array.isArray(data) && 'freshness_s' in data)
          ? data
          : { freshness_s: freshestRowS(rows) };

      const dataHash = JSON.stringify(runs);
      // `|| this._error` is load-bearing: after a failed fetch the next
      // SUCCESSFUL poll often returns a byte-identical payload, and without
      // this the render is skipped and the stale error banner survives a
      // recovery that already happened.
      const changed = dataHash !== this._lastDataHash || !!this._error;
      if (changed) {
        this._lastDataHash = dataHash;
        this._runs = rows;
        // The client fallback stamps when the data CHANGED, not when the last
        // response arrived. Stamping every poll would measure our own polling
        // cadence -- a 5s loop would report "0s ago" forever, including for a
        // run table that has been frozen since the runner died an hour ago,
        // which is the exact lie this whole feature exists to stop telling.
        this._changedAtMs = Date.now();
      }
      this._emptyReason =
        (data && !Array.isArray(data) && data.reason) || null;
      this._source =
        (data && !Array.isArray(data) && data.source) || null;
      this._error = null;
      this._loading = false;

      // Unchanged data must NOT rebuild the shadow DOM. render() reassigns
      // innerHTML wholesale, and .runs-table-wrapper scrolls -- a full rebuild
      // every 5s would destroy the user's scroll position, text selection and
      // button focus on an idle system. That is what the original dedupe
      // early-return protected, and it stays protected. Only the age keeps
      // moving while the payload does not, so patch that one node in place.
      if (changed) {
        this.render();
      } else {
        this._renderFreshness();
      }
      return;
    } catch (err) {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      if (!this._error) {
        this._error = `Failed to load runs: ${err.message}`;
      }
    } finally {
      this._loading = false;
    }

    this.render();
  }

  async _cancelRun(runId) {
    try {
      await this._api._post(`/api/v2/runs/${runId}/cancel`);
      await this._loadData();
    } catch (err) {
      this._error = `Cancel failed: ${err.message}`;
      this.render();
    }
  }

  async _replayRun(runId) {
    try {
      await this._api._post(`/api/v2/runs/${runId}/replay`);
      await this._loadData();
    } catch (err) {
      this._error = `Replay failed: ${err.message}`;
      this.render();
    }
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
        display: block;
      }

      .run-manager {
        padding: 16px;
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
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }

      .btn {
        padding: 4px 10px;
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        background: var(--loki-bg-tertiary, #ECEAE3);
        color: var(--loki-text-primary, #201515);
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .btn:hover {
        background: var(--loki-bg-hover, #1f1f23);
        border-color: var(--loki-border-light, #C5C0B1);
      }

      .btn-cancel {
        border-color: var(--loki-red, #ef4444);
        color: var(--loki-red, #ef4444);
      }

      .btn-cancel:hover {
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
      }

      .btn-replay {
        border-color: var(--loki-accent, #553DE9);
        color: var(--loki-accent, #553DE9);
      }

      .btn-replay:hover {
        background: var(--loki-accent-muted, rgba(139, 92, 246, 0.15));
      }

      .btn-refresh {
        padding: 6px 14px;
        font-size: 12px;
      }

      .runs-table-wrapper {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        overflow: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      th {
        text-align: left;
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--loki-text-muted, #939084);
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        background: var(--loki-bg-tertiary, #ECEAE3);
        white-space: nowrap;
      }

      td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--loki-border, #ECEAE3);
        white-space: nowrap;
      }

      tr:last-child td {
        border-bottom: none;
      }

      tr:hover td {
        background: var(--loki-bg-hover, #1f1f23);
      }

      .run-id {
        font-family: 'JetBrains Mono', monospace;
        font-weight: 600;
        color: var(--loki-accent, #553DE9);
        font-size: 12px;
      }

      .status-badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 5px;
        text-transform: uppercase;
      }

      .actions-cell {
        display: flex;
        gap: 6px;
      }

      .empty-state {
        text-align: center;
        padding: 40px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }

      .error-banner {
        margin-top: 12px;
        padding: 8px 12px;
        background: var(--loki-red-muted, rgba(239, 68, 68, 0.15));
        color: var(--loki-red, #ef4444);
        border-radius: 4px;
        font-size: 12px;
      }

      .loading {
        text-align: center;
        padding: 24px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }

      .run-count {
        font-size: 12px;
        color: var(--loki-text-muted, #939084);
        margin-bottom: 8px;
      }

      .freshness {
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
        white-space: nowrap;
      }

      .freshness.is-stale {
        color: var(--loki-yellow, #D4A03C);
        font-weight: 600;
      }

      .freshness.is-unknown {
        font-style: italic;
      }

      .header-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    const runs = this._runs;

    let content;
    if (this._loading && runs.length === 0) {
      content = '<div class="loading">Loading runs...</div>';
    } else if (this._error && runs.length === 0) {
      // A FAILED fetch is not an empty result. Rendering "No runs found."
      // here would make a blind panel look like a healthy idle one.
      content =
        // role="status" (polite), NOT role="alert". This panel polls every
        // 5s and render() replaces innerHTML wholesale, so a persistent
        // outage re-creates this node forever; an assertive region would
        // interrupt a screen-reader user every 5 seconds for the whole outage.
        '<div class="empty-state error-state" role="status" aria-live="polite">' +
        'Could not load runs.' +
        `<div class="error-state-detail">${this._escapeHtml(this._error)}</div></div>`;
    } else if (runs.length === 0) {
      const why = this._emptyReason
        ? `<div class="empty-reason">${this._escapeHtml(this._emptyReason)}</div>`
        : '<div class="empty-reason">The server did not state a reason.</div>';
      const src = this._source
        ? `<div class="empty-source">Read from: ${this._escapeHtml(
             Array.isArray(this._source) ? this._source.join(', ') : this._source)}</div>`
        : '';
      content = `<div class="empty-state" role="status" aria-live="polite">No runs found.${why}${src}</div>`;
    } else {
      const rows = runs.map(run => {
        const status = (run.status || 'pending').toLowerCase();
        const cfg = RUN_STATUS_CONFIG[status] || RUN_STATUS_CONFIG.pending;
        const isRunning = status === 'running';
        const canReplay = status === 'completed' || status === 'failed' || status === 'cancelled';
        const duration = formatRunDuration(run.duration_ms, run.started_at, run.ended_at);

        return `
          <tr>
            <td><span class="run-id">#${run.id}</span></td>
            <td>${this._escapeHtml(run.project_name || run.project || (run.project_id ? `Project #${run.project_id}` : '--'))}</td>
            <td><span class="status-badge" style="background: ${cfg.bg}; color: ${cfg.color};">${cfg.label}</span></td>
            <td>${this._escapeHtml(run.trigger || run.trigger_type || '--')}</td>
            <td>${formatRunTime(run.started_at)}</td>
            <td>${duration}</td>
            <td>
              <div class="actions-cell">
                ${isRunning ? `<button class="btn btn-cancel" data-action="cancel" data-run-id="${run.id}">Cancel</button>` : ''}
                ${canReplay ? `<button class="btn btn-replay" data-action="replay" data-run-id="${run.id}">Replay</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');

      content = `
        <div class="run-count">${runs.length} runs</div>
        <div class="runs-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Project</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // Data age. Never rendered as 0 when it was not measured: an unloaded or
    // envelope-less response reads "Data age unknown", which is a different
    // statement from "0s ago".
    const f = this._freshness();
    const freshClass = !f.known ? 'is-unknown' : (f.isStale ? 'is-stale' : '');

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="run-manager">
        <div class="header">
          <h2 class="title">Run Manager</h2>
          <div class="header-right">
            <span class="freshness ${freshClass}" id="freshness" data-source="${f.source}" data-stale="${f.isStale === null ? 'unknown' : String(f.isStale)}">${this._escapeHtml(freshnessText(f))}</span>
            <button class="btn btn-refresh" id="refresh-btn">Refresh</button>
          </div>
        </div>
        ${content}
        ${this._error ? `<div class="error-banner">${this._escapeHtml(this._error)}</div>` : ''}
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const s = this.shadowRoot;
    if (!s) return;

    const refreshBtn = s.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this._loadData());

    s.querySelectorAll('[data-action="cancel"]').forEach(btn => {
      btn.addEventListener('click', () => this._cancelRun(btn.dataset.runId));
    });

    s.querySelectorAll('[data-action="replay"]').forEach(btn => {
      btn.addEventListener('click', () => this._replayRun(btn.dataset.runId));
    });
  }
}

if (!customElements.get('loki-run-manager')) {
  customElements.define('loki-run-manager', LokiRunManager);
}

export default LokiRunManager;
