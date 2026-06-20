/**
 * @fileoverview Memory Network Graph - visual network showing relationships
 * between memory entries (episodes, patterns, skills). SVG-based with
 * CSS-positioned nodes. Nodes are shaped by type: circles for episodes,
 * squares for patterns, diamonds for skills. Click to view details.
 *
 * @example
 * <loki-memory-graph api-url="http://localhost:57374" theme="dark"></loki-memory-graph>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient } from '../core/loki-api-client.js';
import { registerPoll } from '../core/loki-poll-registry.js';

/** @type {Object<string, {color: string, shape: string, label: string}>} */
const NODE_TYPES = {
  episode: { color: 'var(--loki-blue, #2F71E3)',   shape: 'circle',  label: 'Episode' },
  pattern: { color: 'var(--loki-green, #1FC5A8)',   shape: 'square',  label: 'Pattern' },
  skill:   { color: 'var(--loki-purple, #553DE9)',  shape: 'diamond', label: 'Skill' },
};

/**
 * Simple force-layout positioning for nodes.
 * Places nodes in a circular layout with some offset for variety.
 */
function layoutNodes(nodes, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) * 0.65;
  const count = nodes.length;

  return nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    // Add some jitter based on node importance
    const importance = node.importance || 0.5;
    const r = radius * (0.5 + importance * 0.5);
    return {
      ...node,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });
}

/**
 * @class LokiMemoryGraph
 * @extends LokiElement
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} theme - Theme name (default: auto-detect)
 */
export class LokiMemoryGraph extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'theme'];
  }

  constructor() {
    super();
    this._nodes = [];
    this._edges = [];
    this._selectedNode = null;
    this._api = null;
    this._pollInterval = null;
    this._graphWidth = 600;
    this._graphHeight = 400;
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
    // Central registry (core/loki-poll-registry.js) gates this poll to the
    // active + visible section in ONE place, so a hidden tab or background
    // section does not fetch. connectedCallback already did the first load,
    // so immediate is disabled to avoid a duplicate fetch.
    this._poll = registerPoll({
      loadFn: () => this._loadData(),
      intervalMs: 15000,
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
    try {
      const data = await this._api._get('/api/v2/memory/graph');
      this._nodes = data.nodes || [];
      this._edges = data.edges || [];
    } catch {
      if (this._nodes.length === 0) {
        const demo = this._getDemoData();
        this._nodes = demo.nodes;
        this._edges = demo.edges;
      }
    }
    this.render();
  }

  _getDemoData() {
    return {
      nodes: [
        { id: 'ep1', type: 'episode', label: 'Build iteration #12', importance: 0.8, details: 'Completed scaffolding and initial implementation' },
        { id: 'ep2', type: 'episode', label: 'Code review #5',     importance: 0.6, details: 'Quality gate passed with 3/3 approval' },
        { id: 'ep3', type: 'episode', label: 'Test failure #3',     importance: 0.7, details: 'Integration test timeout resolved' },
        { id: 'pt1', type: 'pattern', label: 'Error recovery',      importance: 0.9, details: 'Retry with exponential backoff pattern' },
        { id: 'pt2', type: 'pattern', label: 'API design',          importance: 0.7, details: 'REST endpoint naming conventions' },
        { id: 'pt3', type: 'pattern', label: 'Test structure',      importance: 0.5, details: 'Arrange-Act-Assert with setup helpers' },
        { id: 'sk1', type: 'skill',   label: 'Playwright E2E',      importance: 0.85, details: 'Browser automation test writing' },
        { id: 'sk2', type: 'skill',   label: 'FastAPI routing',     importance: 0.6, details: 'Python API server development' },
      ],
      edges: [
        { source: 'ep1', target: 'pt1', strength: 0.8 },
        { source: 'ep1', target: 'sk1', strength: 0.6 },
        { source: 'ep2', target: 'pt2', strength: 0.9 },
        { source: 'ep3', target: 'pt1', strength: 0.7 },
        { source: 'ep3', target: 'pt3', strength: 0.5 },
        { source: 'pt1', target: 'sk2', strength: 0.4 },
        { source: 'pt2', target: 'sk2', strength: 0.7 },
        { source: 'pt3', target: 'sk1', strength: 0.6 },
      ],
    };
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _selectNode(nodeId) {
    this._selectedNode = this._selectedNode === nodeId ? null : nodeId;
    this.render();
  }

  _bindEvents() {
    const root = this.shadowRoot;
    root.querySelectorAll('.graph-node').forEach(el => {
      el.addEventListener('click', () => {
        this._selectNode(el.dataset.nodeId);
      });
    });
    root.querySelectorAll('.close-detail').forEach(btn => {
      btn.addEventListener('click', () => {
        this._selectedNode = null;
        this.render();
      });
    });
  }

  _renderNodeShape(node, x, y) {
    const cfg = NODE_TYPES[node.type] || NODE_TYPES.episode;
    const size = 10 + (node.importance || 0.5) * 16;
    const isSelected = this._selectedNode === node.id;
    const stroke = isSelected ? 'var(--loki-accent, #553DE9)' : cfg.color;
    const strokeWidth = isSelected ? 3 : 1.5;
    const opacity = this._selectedNode && !isSelected ? 0.4 : 1;

    let shape;
    switch (cfg.shape) {
      case 'square':
        shape = `<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"
                  rx="3" fill="${cfg.color}" fill-opacity="0.2" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" />`;
        break;
      case 'diamond': {
        const half = size / 2;
        shape = `<polygon points="${x},${y - half} ${x + half},${y} ${x},${y + half} ${x - half},${y}"
                  fill="${cfg.color}" fill-opacity="0.2" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" />`;
        break;
      }
      default: // circle
        shape = `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${cfg.color}" fill-opacity="0.2"
                  stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" />`;
    }

    // Label
    const label = `<text x="${x}" y="${y + size / 2 + 14}" text-anchor="middle" font-size="10"
                    font-family="Inter, sans-serif" fill="var(--loki-text-secondary, #36342E)" opacity="${opacity}">${this._escapeHtml(node.label)}</text>`;

    return `<g class="graph-node" data-node-id="${this._escapeHtml(node.id)}" style="cursor: pointer;">
      ${shape}${label}
    </g>`;
  }

  _renderEdge(edge, positionedNodes) {
    const sourceNode = positionedNodes.find(n => n.id === edge.source);
    const targetNode = positionedNodes.find(n => n.id === edge.target);
    if (!sourceNode || !targetNode) return '';

    const isDotted = (edge.strength || 1) < 0.6;
    const opacity = this._selectedNode
      ? (edge.source === this._selectedNode || edge.target === this._selectedNode ? 0.8 : 0.15)
      : 0.4;
    const dashArray = isDotted ? 'stroke-dasharray="4 4"' : '';

    return `<line x1="${sourceNode.x}" y1="${sourceNode.y}" x2="${targetNode.x}" y2="${targetNode.y}"
      stroke="var(--loki-border-light, #C5C0B1)" stroke-width="1.5" opacity="${opacity}" ${dashArray} />`;
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }

      .graph-container {
        font-family: var(--loki-font-family, 'Inter', -apple-system, sans-serif);
        color: var(--loki-text-primary, #201515);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .title {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
      }

      .graph-wrap {
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        overflow: hidden;
        position: relative;
      }

      .graph-svg {
        display: block;
        width: 100%;
        height: 400px;
      }

      .legend {
        display: flex;
        gap: 16px;
        margin-top: 12px;
        flex-wrap: wrap;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--loki-text-muted, #939084);
      }

      .legend-shape {
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .legend-circle {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid;
      }

      .legend-square {
        width: 12px;
        height: 12px;
        border-radius: 2px;
        border: 2px solid;
      }

      .legend-diamond {
        width: 10px;
        height: 10px;
        border: 2px solid;
        transform: rotate(45deg);
      }

      .detail-panel {
        position: absolute;
        bottom: 12px;
        left: 12px;
        right: 12px;
        background: var(--loki-bg-card, #ffffff);
        border: 1px solid var(--loki-border, #ECEAE3);
        border-radius: 5px;
        padding: 14px;
        box-shadow: var(--loki-shadow-md, 0 4px 6px rgba(32, 21, 21, 0.06));
        animation: slideUp 0.2s ease-out;
      }

      @keyframes slideUp {
        from { transform: translateY(10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }

      .detail-title {
        font-size: 14px;
        font-weight: 600;
      }

      .detail-type {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 2px 8px;
        border-radius: 4px;
      }

      .close-detail {
        background: none;
        border: none;
        font-size: 16px;
        color: var(--loki-text-muted, #939084);
        cursor: pointer;
        padding: 0 4px;
        font-family: inherit;
      }

      .close-detail:hover {
        color: var(--loki-text-primary, #201515);
      }

      .detail-body {
        font-size: 13px;
        color: var(--loki-text-secondary, #36342E);
        line-height: 1.5;
      }

      .empty-state {
        text-align: center;
        padding: 32px 16px;
        color: var(--loki-text-muted, #939084);
        font-size: 13px;
      }
    `;
  }

  render() {
    const s = this.shadowRoot;
    if (!s) return;

    if (this._nodes.length === 0) {
      s.innerHTML = `
        <style>${this.getBaseStyles()}${this._getStyles()}</style>
        <div class="graph-container">
          <div class="header">
            <h3 class="title">Memory Network</h3>
          </div>
          <div class="empty-state">No memory entries to visualize</div>
        </div>
      `;
      return;
    }

    const w = this._graphWidth;
    const h = this._graphHeight;
    const positionedNodes = layoutNodes(this._nodes, w, h);

    // Render edges first (behind nodes)
    const edgesSvg = this._edges.map(e => this._renderEdge(e, positionedNodes)).join('');
    const nodesSvg = positionedNodes.map(n => this._renderNodeShape(n, n.x, n.y)).join('');

    // Detail panel
    let detailPanel = '';
    if (this._selectedNode) {
      const node = this._nodes.find(n => n.id === this._selectedNode);
      if (node) {
        const cfg = NODE_TYPES[node.type] || NODE_TYPES.episode;
        detailPanel = `
          <div class="detail-panel">
            <div class="detail-header">
              <span class="detail-title">${this._escapeHtml(node.label)}</span>
              <span class="detail-type" style="background: ${cfg.color}; color: white;">${cfg.label}</span>
              <button class="close-detail" title="Close">&#10005;</button>
            </div>
            <div class="detail-body">${this._escapeHtml(node.details || 'No details available')}</div>
          </div>
        `;
      }
    }

    // Legend
    const legendItems = Object.entries(NODE_TYPES).map(([, cfg]) => {
      let shapeEl;
      if (cfg.shape === 'circle') shapeEl = `<div class="legend-circle" style="border-color: ${cfg.color};"></div>`;
      else if (cfg.shape === 'square') shapeEl = `<div class="legend-square" style="border-color: ${cfg.color};"></div>`;
      else shapeEl = `<div class="legend-diamond" style="border-color: ${cfg.color};"></div>`;

      return `<div class="legend-item">
        <div class="legend-shape">${shapeEl}</div>
        <span>${cfg.label}</span>
      </div>`;
    }).join('');

    s.innerHTML = `
      <style>${this.getBaseStyles()}${this._getStyles()}</style>
      <div class="graph-container">
        <div class="header">
          <h3 class="title">Memory Network</h3>
        </div>
        <div class="graph-wrap">
          <svg class="graph-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
            ${edgesSvg}
            ${nodesSvg}
          </svg>
          ${detailPanel}
        </div>
        <div class="legend">${legendItems}</div>
      </div>
    `;

    this._bindEvents();
  }
}

if (!customElements.get('loki-memory-graph')) {
  customElements.define('loki-memory-graph', LokiMemoryGraph);
}

export default LokiMemoryGraph;
