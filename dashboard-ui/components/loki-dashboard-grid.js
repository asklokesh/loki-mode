/**
 * @fileoverview Loki Dashboard Grid Component - arranges child widgets in a
 * responsive CSS Grid layout with widget headers for collapse/expand and fullscreen.
 *
 * G67: Widget-based dashboard layout
 * G68: Dashboard widget header component
 * G77: Fullscreen mode for any widget
 *
 * @example
 * <loki-dashboard-grid>
 *   <loki-overview slot="widget" data-widget-title="Overview" data-widget-span="2"></loki-overview>
 *   <loki-session-control slot="widget" data-widget-title="Session"></loki-session-control>
 *   <loki-task-board slot="widget" data-widget-title="Task Board" data-widget-span="full"></loki-task-board>
 * </loki-dashboard-grid>
 */

import { LokiElement } from '../core/loki-theme.js';

/**
 * @class LokiDashboardGrid
 * @extends LokiElement
 * @property {string} columns - Number of columns (default: 3)
 */
export class LokiDashboardGrid extends LokiElement {
  static get observedAttributes() {
    return ['columns', 'theme'];
  }

  constructor() {
    super();
    this._collapsedWidgets = new Set();
    this._fullscreenWidget = null;
    this._escHandler = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._observeSlotChanges();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
    }
    // Drop the fullscreen Escape handler so a removed grid never leaves a
    // document-level keydown listener (and its closure over this) behind.
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'theme') {
      this._applyTheme();
    }
    this.render();
  }

  _observeSlotChanges() {
    this._mutationObserver = new MutationObserver(() => this.render());
    this._mutationObserver.observe(this, { childList: true, subtree: false });
  }

  _toggleCollapse(widgetId) {
    if (this._collapsedWidgets.has(widgetId)) {
      this._collapsedWidgets.delete(widgetId);
    } else {
      this._collapsedWidgets.add(widgetId);
    }
    this.render();
  }

  _toggleFullscreen(widgetId) {
    if (this._fullscreenWidget === widgetId) {
      this._fullscreenWidget = null;
    } else {
      this._fullscreenWidget = widgetId;
    }
    this.render();
  }

  /**
   * G76: Export dashboard state as JSON download
   */
  exportDashboard() {
    const children = Array.from(this.children);
    const snapshot = {
      timestamp: new Date().toISOString(),
      dashboard: 'Loki Dashboard',
      widgets: children.map((child, i) => ({
        id: this._getWidgetId(child, i),
        title: child.getAttribute('data-widget-title') || child.tagName.toLowerCase(),
        tag: child.tagName.toLowerCase(),
        collapsed: this._collapsedWidgets.has(this._getWidgetId(child, i)),
      })),
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loki-dashboard-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _getWidgetId(el, index) {
    return el.id || el.getAttribute('data-widget-id') || `widget-${index}`;
  }

  render() {
    const columns = parseInt(this.getAttribute('columns')) || 3;
    const children = Array.from(this.children);

    // Chevron icons
    const chevronDown = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    const chevronUp = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    const maximizeIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const minimizeIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(${columns}, 1fr);
          gap: 16px;
          padding: 16px;
        }

        @media (max-width: 1024px) {
          .dashboard-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 768px) {
          .dashboard-grid {
            grid-template-columns: 1fr;
          }
        }

        .widget-wrapper {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 5px;
          overflow: hidden;
          transition: all var(--loki-transition);
        }

        .widget-wrapper:hover {
          border-color: var(--loki-border-light);
        }

        .widget-wrapper.span-2 {
          grid-column: span 2;
        }

        .widget-wrapper.span-full {
          grid-column: 1 / -1;
        }

        @media (max-width: 768px) {
          .widget-wrapper.span-2,
          .widget-wrapper.span-full {
            grid-column: 1 / -1;
          }
        }

        .widget-wrapper.fullscreen {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1000;
          border-radius: 0;
          grid-column: unset;
          overflow-y: auto;
        }

        .widget-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 14px;
          background: var(--loki-bg-secondary);
          border-bottom: 1px solid var(--loki-border);
          user-select: none;
        }

        .widget-header-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .widget-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          color: var(--loki-text-secondary);
        }

        .widget-actions {
          display: flex;
          gap: 4px;
        }

        .widget-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border: none;
          background: transparent;
          color: var(--loki-text-muted);
          cursor: pointer;
          border-radius: 4px;
          transition: all var(--loki-transition);
        }

        .widget-btn:hover {
          background: var(--loki-bg-hover);
          color: var(--loki-text-primary);
        }

        .widget-body {
          padding: 0;
        }

        .widget-body.collapsed {
          display: none;
        }

        .widget-body ::slotted(*) {
          border: none !important;
          border-radius: 0 !important;
        }

        /* Fullscreen overlay backdrop */
        .fullscreen-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--loki-bg-overlay, rgba(0,0,0,0.5));
          z-index: 999;
        }

        /* G76: Export button */
        .grid-toolbar {
          display: flex;
          justify-content: flex-end;
          padding: 0 16px;
          margin-bottom: -8px;
        }

        .export-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 500;
          border-radius: 4px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-secondary);
          color: var(--loki-text-secondary);
          cursor: pointer;
          transition: all 0.2s;
        }

        .export-btn:hover {
          background: var(--loki-bg-hover);
          border-color: var(--loki-border-light);
        }

        .export-btn svg {
          width: 12px;
          height: 12px;
        }
      </style>

      ${this._fullscreenWidget !== null ? '<div class="fullscreen-backdrop" id="fs-backdrop"></div>' : ''}

      <div class="grid-toolbar">
        <button class="export-btn" id="export-btn" aria-label="Export dashboard">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export
        </button>
      </div>

      <div class="dashboard-grid">
        ${children.map((child, i) => {
          const widgetId = this._getWidgetId(child, i);
          const title = child.getAttribute('data-widget-title') || child.tagName.toLowerCase().replace('loki-', '').replace(/-/g, ' ');
          const span = child.getAttribute('data-widget-span') || '1';
          const isCollapsed = this._collapsedWidgets.has(widgetId);
          const isFullscreen = this._fullscreenWidget === widgetId;
          const spanClass = span === 'full' ? 'span-full' : span === '2' ? 'span-2' : '';
          const fsClass = isFullscreen ? 'fullscreen' : '';

          return `
            <div class="widget-wrapper ${spanClass} ${fsClass}" data-widget="${widgetId}">
              <div class="widget-header">
                <div class="widget-header-left">
                  <span class="widget-title">${this._escapeHtml(title)}</span>
                </div>
                <div class="widget-actions">
                  <button class="widget-btn collapse-btn" data-widget="${widgetId}" title="${isCollapsed ? 'Expand' : 'Collapse'}" aria-label="${isCollapsed ? 'Expand' : 'Collapse'} ${this._escapeHtml(title)}">
                    ${isCollapsed ? chevronDown : chevronUp}
                  </button>
                  <button class="widget-btn fullscreen-btn" data-widget="${widgetId}" title="${isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}" aria-label="${isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} ${this._escapeHtml(title)}">
                    ${isFullscreen ? minimizeIcon : maximizeIcon}
                  </button>
                </div>
              </div>
              <div class="widget-body ${isCollapsed ? 'collapsed' : ''}" id="body-${widgetId}">
                <slot name="widget-${i}"></slot>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Assign slots to children
    children.forEach((child, i) => {
      child.setAttribute('slot', `widget-${i}`);
    });

    // Attach event handlers
    this.shadowRoot.querySelectorAll('.collapse-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleCollapse(btn.dataset.widget);
      });
    });

    this.shadowRoot.querySelectorAll('.fullscreen-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleFullscreen(btn.dataset.widget);
      });
    });

    // Export button
    const exportBtn = this.shadowRoot.getElementById('export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportDashboard());
    }

    const backdrop = this.shadowRoot.getElementById('fs-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => {
        this._fullscreenWidget = null;
        this.render();
      });
    }

    // Escape key exits fullscreen. render() can fire repeatedly (slot
    // MutationObserver, theme changes, toggles), and fullscreen can also be
    // dismissed via the backdrop, so a per-render anonymous handler would stack
    // duplicate document listeners and orphan one whenever the backdrop closes
    // the overlay. Keep a single instance handler: always detach the prior one
    // first, then attach only while a widget is fullscreen.
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    if (this._fullscreenWidget !== null) {
      this._escHandler = (e) => {
        if (e.key === 'Escape') {
          this._fullscreenWidget = null;
          this.render();
        }
      };
      document.addEventListener('keydown', this._escHandler);
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('loki-dashboard-grid')) {
  customElements.define('loki-dashboard-grid', LokiDashboardGrid);
}

export default LokiDashboardGrid;
