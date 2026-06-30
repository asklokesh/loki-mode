/**
 * @fileoverview Loki Escalations - lists handoff/escalation documents
 * written under .loki/escalations/ by the runner. Surfaces the existing
 * /api/escalations server endpoint that previously had no UI entry.
 *
 * Each entry shows filename, size, and last-modified time. Clicking an
 * entry fetches the markdown body via /api/escalations/{filename} and
 * renders it inline as a preformatted block.
 *
 * Added in v7.5.15 to close UAT gap #3 from v7.5.12 testing
 * (Escalations feature existed server-side but had no sidebar entry).
 *
 * @example
 * <loki-escalations api-url="http://localhost:57374"></loki-escalations>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';
import { renderMarkdown, MARKDOWN_STYLES } from '../core/loki-markdown.js';

export class LokiEscalations extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._items = [];
    this._loading = false;
    this._error = null;
    this._activeFile = null;
    this._activeBody = null;
    this._activeBodyError = null;
    this._api = null;
    this._pollInterval = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._ensureMarkdownStyles();
    this._setupApi();
    this._loadList();
    // Central registry gates this poll to the active + visible section in ONE
    // place; the initial load above runs eagerly, so immediate is disabled to
    // avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadList(),
      intervalMs: 10000,
      element: this,
      immediate: false,
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._poll) {
      this._poll.stop();
      this._poll = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'api-url' && this._api) {
      this._api = getApiClient({ baseUrl: newValue });
      this._loadList();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || (typeof window !== 'undefined' ? window.location.origin : '');
    this._api = getApiClient({ baseUrl: apiUrl });
  }

  async _loadList() {
    // Capture the api instance so a mid-flight api-url switch can be detected.
    const api = this._api;
    this._loading = true;
    this._error = null;
    try {
      const data = await api.get('/api/escalations');
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._items = Array.isArray(data && data.escalations) ? data.escalations : [];
    } catch (err) {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._error = (err && err.message) ? err.message : String(err);
      this._items = [];
    } finally {
      this._loading = false;
      this.render();
    }
  }

  async _openFile(filename) {
    // Capture the api instance so a mid-flight api-url switch can be detected.
    const api = this._api;
    this._activeFile = filename;
    this._activeBody = null;
    this._activeBodyError = null;
    this.render();
    try {
      const url = (api.baseUrl || '') + '/api/escalations/' + encodeURIComponent(filename);
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._activeBody = text;
    } catch (err) {
      // Drop a stale response if the api-url switched mid-flight.
      if (api !== this._api) return;
      this._activeBodyError = (err && err.message) ? err.message : String(err);
    }
    this.render();
  }

  _closeFile() {
    this._activeFile = null;
    this._activeBody = null;
    this._activeBodyError = null;
    this.render();
  }

  _formatSize(bytes) {
    if (typeof bytes !== 'number') return '--';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  _formatDate(iso) {
    if (!iso) return '--';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  /**
   * Inject the shared MARKDOWN_STYLES into document.head exactly once. This
   * component renders to the light DOM (no shadow root), so the .md-body styles
   * for the rendered handoff document must live at document scope. A sentinel id
   * makes this idempotent across re-renders and multiple instances.
   */
  _ensureMarkdownStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('loki-markdown-styles')) return;
    const style = document.createElement('style');
    style.id = 'loki-markdown-styles';
    style.textContent = MARKDOWN_STYLES;
    document.head.appendChild(style);
  }

  _escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  render() {
    const root = this.shadowRoot || this;
    if (!root) return;

    const styleBlock = `
      <style>
        :host { display: block; }
        .esc-wrapper {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          color: var(--text-primary, #201515);
        }
        .esc-explain {
          color: var(--text-muted, #939084);
          font-size: 0.875rem;
          margin-bottom: 12px;
        }
        .esc-empty {
          padding: 16px;
          background: var(--bg-card, #ffffff);
          border: 1px dashed var(--border, #ECEAE3);
          border-radius: 6px;
          color: var(--text-muted, #939084);
          font-size: 0.875rem;
        }
        .esc-list { display: flex; flex-direction: column; gap: 6px; }
        .esc-item {
          display: flex; justify-content: space-between; align-items: center;
          padding: 10px 12px;
          background: var(--bg-card, #ffffff);
          border: 1px solid var(--border, #ECEAE3);
          border-radius: 6px;
          cursor: pointer;
        }
        .esc-item:hover { background: var(--bg-hover, #F3EFE9); }
        .esc-name { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
        .esc-meta { font-size: 0.75rem; color: var(--text-muted, #939084); }
        .esc-error {
          padding: 10px 12px;
          background: var(--bg-card, #ffffff);
          border: 1px solid var(--error, #C45B5B);
          border-radius: 6px;
          color: var(--error, #C45B5B);
          font-size: 0.85rem;
        }
        .esc-viewer {
          margin-top: 16px;
          padding: 12px;
          background: var(--bg-card, #ffffff);
          border: 1px solid var(--border, #ECEAE3);
          border-radius: 6px;
        }
        .esc-viewer-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 8px;
        }
        .esc-close-btn {
          padding: 4px 10px; cursor: pointer;
          border: 1px solid var(--border, #ECEAE3);
          background: transparent; border-radius: 4px;
          color: var(--text-secondary, #36342E);
          font-size: 0.75rem;
        }
        /* Scroll chrome for the handoff viewer. The rendered markdown is styled
           by MARKDOWN_STYLES (.md-body), injected once into document.head. The
           monospace/pre-wrap below only applies to the plain-text loading line
           (a bare .esc-body without .md-body). */
        .esc-body {
          word-wrap: break-word;
          max-height: 480px;
          overflow: auto;
          background: var(--bg-secondary, #F8F4F0);
          padding: 10px;
          border-radius: 4px;
        }
        .esc-body:not(.md-body) {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.78rem;
          white-space: pre-wrap;
        }
      </style>
    `;

    let body = '';
    if (this._loading && this._items.length === 0) {
      body = '<div class="esc-empty">Loading escalations...</div>';
    } else if (this._error) {
      body = '<div class="esc-error">Failed to load escalations: ' + this._escapeHtml(this._error) + '</div>';
    } else if (!this._items || this._items.length === 0) {
      body = '<div class="esc-empty">No handoff notes yet. If a build needs your attention, its notes will appear here.</div>';
    } else {
      const rows = this._items.map((it) => {
        const fname = this._escapeHtml(it.filename || '');
        const size = this._escapeHtml(this._formatSize(it.size_bytes));
        const mod = this._escapeHtml(this._formatDate(it.modified_at));
        return (
          '<div class="esc-item" data-filename="' + fname + '">' +
            '<span class="esc-name">' + fname + '</span>' +
            '<span class="esc-meta">' + size + ' &middot; ' + mod + '</span>' +
          '</div>'
        );
      }).join('');
      body = '<div class="esc-list">' + rows + '</div>';
    }

    let viewer = '';
    if (this._activeFile) {
      const fname = this._escapeHtml(this._activeFile);
      let inner;
      if (this._activeBodyError) {
        inner = '<div class="esc-error">Failed to load: ' + this._escapeHtml(this._activeBodyError) + '</div>';
      } else if (this._activeBody === null) {
        inner = '<div class="esc-body">Loading ' + fname + '...</div>';
      } else {
        // Render the handoff/escalation markdown as a formatted document.
        // renderMarkdown escapes its input first, so a doc containing <script>
        // is shown as text and cannot inject.
        inner = '<div class="esc-body md-body">' + renderMarkdown(this._activeBody) + '</div>';
      }
      viewer = (
        '<div class="esc-viewer">' +
          '<div class="esc-viewer-header">' +
            '<span class="esc-name">' + fname + '</span>' +
            '<button class="esc-close-btn" data-action="close">Close</button>' +
          '</div>' +
          inner +
        '</div>'
      );
    }

    root.innerHTML = (
      styleBlock +
      '<div class="esc-wrapper">' +
        '<div class="esc-explain">Handoff/escalation documents written under .loki/escalations/. Click an entry to view its contents.</div>' +
        body +
        viewer +
      '</div>'
    );

    // Wire up click handlers (no shadow DOM, so use root.querySelectorAll directly)
    const items = root.querySelectorAll('.esc-item');
    items.forEach((el) => {
      el.addEventListener('click', () => {
        const fname = el.getAttribute('data-filename');
        if (fname) this._openFile(fname);
      });
    });
    const closeBtn = root.querySelector('.esc-close-btn[data-action="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeFile());
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('loki-escalations')) {
  customElements.define('loki-escalations', LokiEscalations);
}
