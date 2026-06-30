/**
 * @fileoverview Loki Spec Panel - shows WHAT Loki is building from.
 * Surfaces the active run's spec source (PRD file, GitHub issue, one-line
 * brief, generated/OpenAPI spec, or codebase analysis) prominently so a user
 * always knows what is being built, plus a collapsible history of past specs
 * for this codebase. Data comes from GET /api/spec and GET /api/spec/history,
 * which the backend resolves honestly from real .loki state + Evidence
 * Receipts; this component never fabricates a spec.
 *
 * @example
 * <loki-spec-panel api-url="http://localhost:57374" theme="dark"></loki-spec-panel>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { renderMarkdown, MARKDOWN_STYLES } from '../core/loki-markdown.js';

/** Human labels + short descriptions for each honest spec type. */
const TYPE_LABELS = {
  prd: 'PRD file',
  spec: 'Generated spec',
  issue: 'GitHub issue',
  brief: 'One-line brief',
  'codebase-analysis': 'Codebase analysis',
  none: 'No spec yet',
  unknown: 'Unknown spec',
};

/**
 * @class LokiSpecPanel
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - 'light' or 'dark'
 */
export class LokiSpecPanel extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._api = null;
    this._spec = null; // GET /api/spec
    this._history = null; // GET /api/spec/history -> array
    this._loading = false;
    this._error = null;
    this._historyError = null;
    this._historyOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._load();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'api-url' && this._api) {
      this._api = getApiClient({ baseUrl: newValue });
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _load() {
    // Drop a stale response if the api-url switched mid-flight.
    const api = this._api;
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const spec = await api._get('/api/spec');
      if (api !== this._api) return;
      this._spec = spec;
    } catch (e) {
      if (api !== this._api) return;
      this._error = (e && e.message) ? e.message : 'Failed to load spec';
    } finally {
      // Skip the stale render if the api swapped mid-flight (a return inside
      // try/catch still runs this finally, so guard it here instead).
      if (api === this._api) {
        this._loading = false;
        this.render();
      }
    }
    // History loads in the background; its failure must not block the active
    // spec (the prominent surface), so it has its own error channel.
    try {
      const data = await api._get('/api/spec/history');
      if (api !== this._api) return;
      this._history = (data && Array.isArray(data.history)) ? data.history : [];
    } catch (e) {
      if (api !== this._api) return;
      this._historyError = (e && e.message) ? e.message : 'Failed to load history';
      this._history = [];
    }
    this.render();
  }

  /** Escape untrusted text for safe insertion into HTML. */
  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Format an ISO timestamp into a short, locale-aware label (honest fallback). */
  _when(iso) {
    if (!iso) return 'unknown time';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return this._esc(iso);
    try {
      return d.toLocaleString();
    } catch (e) {
      return this._esc(iso);
    }
  }

  _typeLabel(type) {
    return TYPE_LABELS[type] || TYPE_LABELS.unknown;
  }

  /** Small pill showing the spec type. */
  _typeBadge(type) {
    return `<span class="badge badge-${this._esc(type)}">${this._esc(this._typeLabel(type))}</span>`;
  }

  /** The prominent active-spec block. */
  _renderActive() {
    if (this._loading) {
      return `<div class="es-loading"><span class="es-spinner"></span> Loading active spec...</div>`;
    }
    if (this._error) {
      return this._renderError(this._error);
    }
    const s = this._spec;
    if (!s || !s.type || s.type === 'none') {
      return this._renderEmpty();
    }

    const badge = this._typeBadge(s.type);
    let meta = '';
    let body = '';

    if (s.type === 'prd' || s.type === 'spec') {
      if (s.path) meta = `<code class="src">${this._esc(s.path)}</code>`;
      const content = s.content || '';
      if (content.trim()) {
        // Render the spec as a formatted document, not a raw markdown dump.
        // renderMarkdown escapes its input first, so a spec containing <script>
        // is shown as text and cannot inject.
        body = `<div class="body md-body">${renderMarkdown(content)}</div>`
          + (s.truncated ? `<p class="dim">Preview truncated -- see the full file on disk.</p>` : '');
      } else {
        body = `<p class="dim">No content available.</p>`;
      }
    } else if (s.type === 'issue') {
      const ref = s.ref ? `<code class="src">${this._esc(s.ref)}</code>` : '';
      meta = ref;
      const title = s.title ? `<p class="issue-title">${this._esc(s.title)}</p>` : '';
      const issueBody = (s.body || '').trim()
        ? `<div class="body md-body">${renderMarkdown(s.body)}</div>`
          + (s.truncated ? `<p class="dim">Preview truncated.</p>` : '')
        : '';
      body = `${title}${issueBody}`;
    } else if (s.type === 'brief') {
      const text = (s.text || '').trim();
      body = text
        ? `<pre class="body brief">${this._esc(text)}</pre>`
          + (s.truncated ? `<p class="dim">Preview truncated.</p>` : '')
        : `<p class="dim">No brief recorded.</p>`;
    } else if (s.type === 'codebase-analysis') {
      body = `<p class="dim">No explicit spec. Loki is building from an analysis of the existing codebase.</p>`;
    } else {
      body = `<p class="dim">The spec source could not be resolved.</p>`;
    }

    return `<div class="active">
      <div class="active-head">
        <span class="active-label">Building from</span>
        ${badge}
      </div>
      ${meta ? `<div class="active-meta">${meta}</div>` : ''}
      ${body}
    </div>`;
  }

  /** Collapsible history of past specs. */
  _renderHistory() {
    const list = this._history || [];
    const count = list.length;
    const caret = this._historyOpen ? 'open' : '';
    let inner = '';
    if (this._historyOpen) {
      if (this._historyError) {
        inner = `<div class="es-inline-error">${this._esc(this._historyError)}</div>`;
      } else if (count === 0) {
        inner = `<p class="dim hist-empty">No past specs yet. Each completed run records its spec here.</p>`;
      } else {
        const rows = list.map((h) => `
          <li class="hist-row">
            <span class="hist-when">${this._when(h.when)}</span>
            ${this._typeBadge(h.type)}
            <span class="hist-summary">${this._esc(h.summary || '')}</span>
          </li>`).join('');
        inner = `<ul class="hist-list">${rows}</ul>`;
      }
    }
    return `<div class="history">
      <button class="hist-toggle ${caret}" id="hist-toggle" aria-expanded="${this._historyOpen}">
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        Spec history${count ? ` <span class="dim">(${count})</span>` : ''}
      </button>
      ${inner}
    </div>`;
  }

  /** Honest empty state when no run has produced a spec yet. */
  _renderEmpty() {
    const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    return `<div class="es">
      <div class="es-icon">${fileIcon}</div>
      <div class="es-title">No spec yet</div>
      <div class="es-desc">When a run starts, the spec it builds from (a PRD, GitHub issue, one-line brief, or codebase analysis) appears here.</div>
    </div>`;
  }

  /** Branded error state with a retry button. */
  _renderError(message) {
    const alertIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    return `<div class="es">
      <div class="es-icon es-icon-error">${alertIcon}</div>
      <div class="es-title">Couldn't load the spec</div>
      <div class="es-desc">${this._esc(message)}</div>
      <button class="es-cta" id="spec-retry-btn">Retry</button>
    </div>`;
  }

  render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}
        ${MARKDOWN_STYLES}
        :host { display: block; }
        .active { background: var(--loki-bg-secondary); border: 1px solid var(--loki-border);
          border-radius: var(--loki-radius-lg, 5px); padding: 16px; }
        .active-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .active-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
          color: var(--loki-text-muted); }
        .active-meta { margin-bottom: 10px; }
        .issue-title { font-size: 14px; font-weight: 600; color: var(--loki-text-primary);
          margin: 0 0 8px; }
        .badge { display: inline-block; padding: 2px 9px; border-radius: var(--loki-radius-full, 9999px);
          font-size: 11px; font-weight: 600; background: var(--loki-accent-muted); color: var(--loki-accent); }
        .badge-codebase-analysis { background: var(--loki-bg-tertiary); color: var(--loki-text-secondary); }
        .badge-none, .badge-unknown { background: var(--loki-bg-tertiary); color: var(--loki-text-muted); }
        .src { font-family: var(--loki-font-mono, monospace); font-size: 12px;
          background: var(--loki-bg-tertiary); color: var(--loki-text-secondary);
          padding: 2px 7px; border-radius: 3px; word-break: break-all; }
        /* Scroll chrome for the rendered spec/issue document. The markdown
           itself is styled by MARKDOWN_STYLES (.md-body), injected below. */
        .body { word-break: break-word;
          max-height: 320px; overflow: auto;
          background: var(--loki-bg-tertiary);
          padding: 12px; border-radius: var(--loki-radius-md, 4px);
          border: 1px solid var(--loki-border); margin: 0; }
        /* The brief is a one-line plain-text spec, kept as a preformatted block. */
        .body.brief { white-space: pre-wrap;
          font-family: var(--loki-font-mono, monospace); font-size: 12px;
          line-height: 1.6; color: var(--loki-text-primary); }
        .dim { color: var(--loki-text-muted); font-size: 12px; }

        /* History */
        .history { margin-top: 16px; }
        .hist-toggle { display: flex; align-items: center; gap: 6px; width: 100%;
          background: none; border: none; cursor: pointer; padding: 8px 0;
          font-size: 13px; font-weight: 600; font-family: inherit;
          color: var(--loki-text-primary); text-align: left; }
        .hist-toggle .caret { width: 14px; height: 14px; transition: transform 0.15s ease; }
        .hist-toggle.open .caret { transform: rotate(90deg); }
        .hist-list { list-style: none; margin: 4px 0 0; padding: 0;
          border-top: 1px solid var(--loki-border); }
        .hist-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
          padding: 9px 2px; border-bottom: 1px solid var(--loki-border); font-size: 12px; }
        .hist-when { color: var(--loki-text-muted); min-width: 130px; }
        .hist-summary { color: var(--loki-text-secondary); flex: 1; word-break: break-word; }
        .hist-empty { padding: 8px 2px; }

        /* Branded empty / loading / error states */
        .es { display: flex; flex-direction: column; align-items: center;
          text-align: center; padding: 40px 24px; gap: 4px; }
        .es-icon { width: 44px; height: 44px; display: flex; align-items: center;
          justify-content: center; border-radius: var(--loki-radius-full, 9999px);
          background: var(--loki-accent-muted); color: var(--loki-accent); margin-bottom: 14px; }
        .es-icon-error { background: var(--loki-error-muted); color: var(--loki-error); }
        .es-icon svg { width: 22px; height: 22px; }
        .es-title { font-size: 15px; font-weight: 600; color: var(--loki-text-primary); }
        .es-desc { font-size: 13px; color: var(--loki-text-muted); line-height: 1.55; max-width: 400px; }
        .es-cta { margin-top: 16px; padding: 9px 18px; background: var(--loki-accent);
          color: var(--loki-text-inverse); border: none; border-radius: var(--loki-radius-md, 4px);
          font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer; }
        .es-cta:hover { background: var(--loki-accent-hover); }
        .es-loading { display: flex; align-items: center; justify-content: center; gap: 8px;
          padding: 40px 16px; color: var(--loki-text-muted); font-size: 13px; }
        .es-spinner { width: 14px; height: 14px; border: 2px solid var(--loki-border);
          border-top-color: var(--loki-accent); border-radius: 50%;
          animation: es-spin 0.8s linear infinite; }
        .es-inline-error { margin: 8px 0; padding: 10px 12px; font-size: 12px;
          color: var(--loki-error); background: var(--loki-error-muted);
          border-radius: var(--loki-radius-md, 4px); }
        @keyframes es-spin { to { transform: rotate(360deg); } }
      </style>
      <div class="active-wrap">${this._renderActive()}</div>
      ${(this._error || (this._spec && this._spec.type === 'none')) ? '' : this._renderHistory()}
    `;

    const retryBtn = this.shadowRoot.getElementById('spec-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this._load());
    }
    const toggle = this.shadowRoot.getElementById('hist-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        this._historyOpen = !this._historyOpen;
        this.render();
      });
    }
  }
}

if (!customElements.get('loki-spec-panel')) {
  customElements.define('loki-spec-panel', LokiSpecPanel);
}

export default LokiSpecPanel;
