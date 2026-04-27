/**
 * @fileoverview Loki Task Board Component - a Kanban-style task board for
 * displaying and managing tasks across four columns: Pending, In Progress,
 * In Review, and Completed. Supports drag-and-drop reordering and
 * keyboard navigation.
 *
 * @example
 * <loki-task-board api-url="http://localhost:57374" project-id="1" theme="dark"></loki-task-board>
 */

import { LokiElement } from '../core/loki-theme.js';
import { getApiClient, ApiEvents } from '../core/loki-api-client.js';
import { getState } from '../core/loki-state.js';

/** @type {Array<{id: string, label: string, status: string, color: string}>} */
const COLUMNS = [
  { id: 'pending', label: 'Pending', status: 'pending', color: 'var(--loki-text-muted)' },
  { id: 'in_progress', label: 'In Progress', status: 'in_progress', color: 'var(--loki-blue)' },
  { id: 'review', label: 'In Review', status: 'review', color: 'var(--loki-purple)' },
  { id: 'done', label: 'Completed', status: 'done', color: 'var(--loki-green)' },
];

/**
 * @class LokiTaskBoard
 * @extends LokiElement
 * @fires task-moved - When a task is dragged to a new column
 * @fires add-task - When the add task button is clicked
 * @fires task-click - When a task card is clicked
 * @property {string} api-url - API base URL (default: window.location.origin)
 * @property {string} project-id - Filter tasks by project ID
 * @property {string} theme - 'light' or 'dark' (default: auto-detect)
 * @property {boolean} readonly - Disables drag-drop and editing when present
 */
export class LokiTaskBoard extends LokiElement {
  static get observedAttributes() {
    return ['api-url', 'project-id', 'theme', 'readonly'];
  }

  constructor() {
    super();
    this._tasks = [];
    this._loading = true;
    this._error = null;
    this._draggedTask = null;
    this._selectedTask = null;
    this._expandedCards = new Set();
    this._selectedTasks = new Set();
    this._bulkMode = false;
    this._activeFilter = 'all';
    this._api = null;
    this._state = getState();
  }

  connectedCallback() {
    super.connectedCallback();
    this._setupApi();
    this._loadTasks();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._api) {
      this._api.removeEventListener(ApiEvents.TASK_CREATED, this._onTaskEvent);
      this._api.removeEventListener(ApiEvents.TASK_UPDATED, this._onTaskEvent);
      this._api.removeEventListener(ApiEvents.TASK_DELETED, this._onTaskEvent);
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'api-url' && this._api) {
      this._api.baseUrl = newValue;
      this._loadTasks();
    }
    if (name === 'project-id') {
      this._loadTasks();
    }
    if (name === 'theme') {
      this._applyTheme();
    }
  }

  _setupApi() {
    const apiUrl = this.getAttribute('api-url') || window.location.origin;
    this._api = getApiClient({ baseUrl: apiUrl });

    // Remove old listeners before adding new ones to prevent leaks
    if (this._onTaskEvent) {
      this._api.removeEventListener(ApiEvents.TASK_CREATED, this._onTaskEvent);
      this._api.removeEventListener(ApiEvents.TASK_UPDATED, this._onTaskEvent);
      this._api.removeEventListener(ApiEvents.TASK_DELETED, this._onTaskEvent);
    }

    this._onTaskEvent = () => this._loadTasks();
    this._api.addEventListener(ApiEvents.TASK_CREATED, this._onTaskEvent);
    this._api.addEventListener(ApiEvents.TASK_UPDATED, this._onTaskEvent);
    this._api.addEventListener(ApiEvents.TASK_DELETED, this._onTaskEvent);
  }

  async _loadTasks() {
    this._loading = true;
    this._error = null;
    this.render();

    try {
      const projectId = this.getAttribute('project-id');
      const filters = projectId ? { projectId: parseInt(projectId) } : {};
      this._tasks = await this._api.listTasks(filters);

      // Merge with local tasks
      const localTasks = this._state.get('localTasks') || [];
      if (localTasks.length > 0) {
        this._tasks = [...this._tasks, ...localTasks.map(t => ({ ...t, isLocal: true }))];
      }

      this._state.update({ 'cache.tasks': this._tasks }, false);
    } catch (error) {
      this._error = error.message;
      // Fall back to local tasks only
      this._tasks = (this._state.get('localTasks') || []).map(t => ({ ...t, isLocal: true }));
    }

    this._loading = false;
    this.render();
  }

  _getTasksByStatus(status) {
    const tasks = this._getFilteredTasks();
    return tasks.filter(t => {
      const taskStatus = t.status?.toLowerCase().replace(/-/g, '_');
      return taskStatus === status;
    });
  }

  _handleDragStart(e, task) {
    if (this.hasAttribute('readonly')) return;

    this._draggedTask = task;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id.toString());
  }

  _handleDragEnd(e) {
    e.target.classList.remove('dragging');
    this._draggedTask = null;
    this.shadowRoot.querySelectorAll('.kanban-tasks').forEach(el => {
      el.classList.remove('drag-over');
    });
  }

  _handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  _handleDragEnter(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
  }

  _handleDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      e.currentTarget.classList.remove('drag-over');
    }
  }

  async _handleDrop(e, newStatus) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    if (!this._draggedTask || this.hasAttribute('readonly')) return;

    const taskId = this._draggedTask.id;
    const task = this._tasks.find(t => t.id === taskId);
    if (!task) return;

    const oldStatus = task.status;
    if (oldStatus === newStatus) return;

    // Optimistic update
    task.status = newStatus;
    this.render();

    try {
      if (task.isLocal) {
        this._state.moveLocalTask(taskId, newStatus);
      } else {
        await this._api.moveTask(taskId, newStatus, 0);
      }

      this.dispatchEvent(new CustomEvent('task-moved', {
        detail: { taskId, oldStatus, newStatus }
      }));
    } catch (error) {
      // Revert on error
      task.status = oldStatus;
      this.render();
      console.error('Failed to move task:', error);
    }
  }

  _toggleCardExpand(taskId) {
    if (this._expandedCards.has(taskId)) {
      this._expandedCards.delete(taskId);
    } else {
      this._expandedCards.add(taskId);
    }
    this.render();
  }

  _toggleTaskSelection(taskId, event) {
    if (event) event.stopPropagation();
    if (this._selectedTasks.has(taskId)) {
      this._selectedTasks.delete(taskId);
    } else {
      this._selectedTasks.add(taskId);
    }
    this.render();
  }

  _toggleBulkMode() {
    this._bulkMode = !this._bulkMode;
    if (!this._bulkMode) {
      this._selectedTasks.clear();
    }
    this.render();
  }

  async _bulkMove(newStatus) {
    const taskIds = [...this._selectedTasks];
    for (const taskId of taskIds) {
      const task = this._tasks.find(t => String(t.id) === String(taskId));
      if (task && task.status !== newStatus) {
        try {
          if (task.isLocal) {
            this._state.moveLocalTask(taskId, newStatus);
          } else {
            await this._api.moveTask(taskId, newStatus, 0);
          }
          task.status = newStatus;
        } catch (error) {
          console.error('Failed to bulk move task:', taskId, error);
        }
      }
    }
    this._selectedTasks.clear();
    this._bulkMode = false;
    this.render();
    this._loadTasks();
  }

  async _bulkDelete() {
    const taskIds = [...this._selectedTasks];
    for (const taskId of taskIds) {
      try {
        await this._api.deleteTask(taskId);
      } catch (error) {
        console.error('Failed to delete task:', taskId, error);
      }
    }
    this._selectedTasks.clear();
    this._bulkMode = false;
    this._loadTasks();
  }

  _setFilter(filter) {
    this._activeFilter = filter;
    this.render();
  }

  _getFilteredTasks() {
    let filtered = [...this._tasks];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    switch (this._activeFilter) {
      case 'today':
        filtered = filtered.filter(t => {
          const created = t.created_at ? new Date(t.created_at) : null;
          return created && created >= today;
        });
        break;
      case 'this-week':
        filtered = filtered.filter(t => {
          const created = t.created_at ? new Date(t.created_at) : null;
          return created && created >= weekAgo;
        });
        break;
      case 'running':
        filtered = filtered.filter(t => t.status === 'in_progress');
        break;
      case 'failed':
        filtered = filtered.filter(t => t.status === 'failed' || t.status === 'error');
        break;
      default:
        break;
    }

    return filtered;
  }

  _openAddTaskModal(status = 'pending') {
    this.dispatchEvent(new CustomEvent('add-task', { detail: { status } }));
  }

  _openTaskDetail(task) {
    this._selectedTask = task;
    this.render();
    this.dispatchEvent(new CustomEvent('task-click', { detail: { task } }));
  }

  _closeTaskDetail() {
    this._selectedTask = null;
    this.render();
  }

  _renderTaskDetailModal(task) {
    if (!task) return '';

    const priority = (task.priority || 'medium').toLowerCase();
    const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);
    const status = task.status || 'pending';
    const statusLabel = status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const meta = task.metadata || {};
    const criteria = task.acceptance_criteria || [];
    const contextFiles = task.context_files || [];
    const spec = task.specification || task.description || '';
    const fullContent = task.full_content || '';

    return `
      <div class="modal-overlay" id="task-detail-overlay">
        <div class="modal-container">
          <div class="modal-header">
            <div class="modal-header-left">
              <span class="task-id">${task.isLocal ? 'LOCAL' : '#' + this._escapeHtml(String(task.id))}</span>
              <span class="task-priority ${priority}">${priorityLabel}</span>
              <span class="task-status-badge ${status}">${statusLabel}</span>
            </div>
            <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
          </div>
          <h2 class="modal-title">${this._escapeHtml(task.title || 'Untitled')}</h2>

          ${Object.keys(meta).length > 0 ? `
            <div class="modal-section">
              <h3 class="modal-section-title">Metadata</h3>
              <div class="meta-grid">
                ${Object.entries(meta).map(([k, v]) => `
                  <div class="meta-cell">
                    <span class="meta-label">${this._escapeHtml(k.replace(/_/g, ' '))}</span>
                    <span class="meta-value">${this._escapeHtml(String(v))}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${spec ? `
            <div class="modal-section">
              <h3 class="modal-section-title">Specification</h3>
              <div class="modal-prose">${this._escapeHtml(spec)}</div>
            </div>
          ` : ''}

          ${criteria.length > 0 ? `
            <div class="modal-section">
              <h3 class="modal-section-title">Acceptance Criteria</h3>
              <ol class="criteria-list">
                ${criteria.map(c => `<li>${this._escapeHtml(c)}</li>`).join('')}
              </ol>
            </div>
          ` : ''}

          ${contextFiles.length > 0 ? `
            <div class="modal-section">
              <h3 class="modal-section-title">Context Files</h3>
              <ul class="context-files-list">
                ${contextFiles.map(f => `<li class="mono">${this._escapeHtml(f)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}

          ${fullContent && !spec ? `
            <div class="modal-section">
              <h3 class="modal-section-title">Full Content</h3>
              <pre class="modal-pre">${this._escapeHtml(fullContent)}</pre>
            </div>
          ` : ''}

          ${task.user_story ? `
            <div class="modal-section">
              <h3 class="modal-section-title">User Story</h3>
              <div class="modal-prose">${this._escapeHtml(task.user_story)}</div>
            </div>
          ` : ''}

          ${task.source ? `
            <div class="modal-section">
              <h3 class="modal-section-title">Source</h3>
              <div class="modal-prose"><code>${this._escapeHtml(task.source)}</code></div>
            </div>
          ` : ''}

          ${task.type ? `
            <div class="modal-footer">
              <span class="task-type">${this._escapeHtml(task.type)}</span>
              ${task.assigned_agent_id ? `<span class="meta-value">Agent #${task.assigned_agent_id}</span>` : ''}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  render() {
    const styles = `
      <style>
        ${this.getBaseStyles()}

        :host {
          display: block;
        }

        .board-container {
          width: 100%;
        }

        .board-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .board-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--loki-text-primary);
        }

        .board-actions {
          display: flex;
          gap: 8px;
        }

        .loading, .error {
          padding: 40px;
          text-align: center;
          color: var(--loki-text-muted);
        }

        .error {
          color: var(--loki-red);
        }

        .kanban-board {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
          min-height: 350px;
        }

        @media (max-width: 1200px) {
          .kanban-board { grid-template-columns: repeat(2, 1fr); }
        }

        @media (max-width: 768px) {
          .kanban-board { grid-template-columns: 1fr; }
        }

        .kanban-column {
          background: var(--loki-bg-secondary);
          border-radius: 5px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          transition: background var(--loki-transition);
        }

        .kanban-column-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 10px;
          border-bottom: 2px solid var(--loki-border);
        }

        .kanban-column[data-status="pending"] .kanban-column-header { border-color: var(--loki-text-muted); }
        .kanban-column[data-status="in_progress"] .kanban-column-header { border-color: var(--loki-blue); }
        .kanban-column[data-status="review"] .kanban-column-header { border-color: var(--loki-purple); }
        .kanban-column[data-status="done"] .kanban-column-header { border-color: var(--loki-green); }

        .kanban-column-title {
          font-size: 13px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--loki-text-primary);
        }

        .kanban-column-count {
          background: var(--loki-bg-tertiary);
          padding: 2px 8px;
          border-radius: 5px;
          font-size: 11px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-text-secondary);
        }

        .kanban-tasks {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 80px;
          transition: background var(--loki-transition);
          border-radius: 4px;
          padding: 4px;
        }

        .kanban-tasks.drag-over {
          background: var(--loki-bg-hover);
        }

        .task-card {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 10px;
          cursor: pointer;
          transition: transform 0.3s ease, opacity 0.3s ease, box-shadow 0.3s ease, border-color 0.2s ease;
          animation: cardFadeIn 0.3s ease;
        }

        @keyframes cardFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .task-card:hover {
          border-color: var(--loki-border-light);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        .task-card.draggable {
          cursor: grab;
        }

        .task-card.dragging {
          opacity: 0.4;
          transform: scale(0.95);
          cursor: grabbing;
        }

        .task-card.local {
          border-left: 3px solid var(--loki-accent);
        }

        .task-card.selected {
          border-color: var(--loki-accent);
          box-shadow: 0 0 0 2px var(--loki-accent-muted);
        }

        .task-card.expanded {
          background: var(--loki-bg-secondary);
        }

        .task-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 6px;
        }

        .task-id {
          font-size: 11px;
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
        }

        .task-priority {
          font-size: 9px;
          padding: 2px 5px;
          border-radius: 3px;
          font-weight: 500;
          text-transform: uppercase;
        }

        .task-priority.high, .task-priority.critical {
          background: var(--loki-red-muted);
          color: var(--loki-red);
        }

        .task-priority.medium {
          background: var(--loki-yellow-muted);
          color: var(--loki-yellow);
        }

        .task-priority.low {
          background: var(--loki-green-muted);
          color: var(--loki-green);
        }

        .task-title {
          font-size: 12px;
          font-weight: 500;
          margin-bottom: 6px;
          line-height: 1.4;
          color: var(--loki-text-primary);
        }

        .task-desc {
          font-size: 11px;
          color: var(--loki-text-muted);
          line-height: 1.4;
          margin-bottom: 6px;
        }

        .task-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .task-type {
          background: var(--loki-bg-tertiary);
          padding: 2px 6px;
          border-radius: 3px;
        }

        .add-task-btn {
          background: transparent;
          border: 1px dashed var(--loki-border);
          border-radius: 4px;
          padding: 10px;
          color: var(--loki-text-muted);
          font-size: 12px;
          cursor: pointer;
          transition: all var(--loki-transition);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          margin-top: 8px;
        }

        .add-task-btn:hover {
          border-color: var(--loki-accent);
          color: var(--loki-accent);
          background: var(--loki-accent-muted);
        }

        .empty-column {
          text-align: center;
          padding: 20px;
          color: var(--loki-text-muted);
          font-size: 12px;
        }

        /* Column icons */
        .column-icon {
          width: 14px;
          height: 14px;
          stroke: currentColor;
          stroke-width: 2;
          fill: none;
        }

        /* Task Detail Modal */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }

        .modal-container {
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 8px;
          width: 100%;
          max-width: 640px;
          max-height: 80vh;
          overflow-y: auto;
          padding: 24px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.2);
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .modal-header-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .modal-close {
          background: none;
          border: none;
          font-size: 22px;
          color: var(--loki-text-muted);
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 4px;
          line-height: 1;
        }

        .modal-close:hover {
          background: var(--loki-bg-hover);
          color: var(--loki-text-primary);
        }

        .modal-title {
          font-size: 18px;
          font-weight: 600;
          color: var(--loki-text-primary);
          margin: 0 0 16px 0;
          line-height: 1.3;
        }

        .task-status-badge {
          font-size: 10px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 3px;
          text-transform: capitalize;
          background: var(--loki-bg-tertiary);
          color: var(--loki-text-secondary);
        }

        .task-status-badge.in_progress { background: var(--loki-blue-muted, rgba(47,113,227,0.15)); color: var(--loki-blue); }
        .task-status-badge.review { background: var(--loki-purple-muted, rgba(123,107,240,0.15)); color: var(--loki-purple); }
        .task-status-badge.done { background: var(--loki-green-muted, rgba(31,197,168,0.15)); color: var(--loki-green); }

        .modal-section {
          margin-bottom: 16px;
          padding-top: 12px;
          border-top: 1px solid var(--loki-border);
        }

        .modal-section-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--loki-text-muted);
          margin: 0 0 8px 0;
        }

        .modal-prose {
          font-size: 13px;
          line-height: 1.6;
          color: var(--loki-text-primary);
          white-space: pre-wrap;
          word-wrap: break-word;
        }

        .meta-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 8px;
        }

        .meta-cell {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .meta-label {
          font-size: 10px;
          font-weight: 500;
          text-transform: capitalize;
          color: var(--loki-text-muted);
        }

        .meta-value {
          font-size: 12px;
          color: var(--loki-text-primary);
        }

        .criteria-list {
          margin: 0;
          padding-left: 20px;
          font-size: 13px;
          line-height: 1.6;
          color: var(--loki-text-primary);
        }

        .criteria-list li {
          margin-bottom: 4px;
        }

        .context-files-list {
          margin: 0;
          padding-left: 16px;
          font-size: 12px;
          line-height: 1.8;
          color: var(--loki-text-secondary);
          list-style: disc;
        }

        .mono {
          font-family: 'JetBrains Mono', monospace;
        }

        .modal-pre {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          line-height: 1.5;
          background: var(--loki-bg-secondary);
          border: 1px solid var(--loki-border);
          border-radius: 4px;
          padding: 12px;
          overflow-x: auto;
          white-space: pre-wrap;
          word-wrap: break-word;
          max-height: 300px;
          overflow-y: auto;
          color: var(--loki-text-primary);
        }

        .modal-footer {
          display: flex;
          align-items: center;
          gap: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--loki-border);
          font-size: 11px;
          color: var(--loki-text-muted);
        }

        /* G72: Smooth transition when cards move */
        .kanban-tasks {
          position: relative;
        }

        /* G73: Expanded card content */
        .card-expanded-content {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--loki-border);
          animation: expandIn 0.25s ease;
        }

        @keyframes expandIn {
          from { opacity: 0; max-height: 0; }
          to { opacity: 1; max-height: 400px; }
        }

        .card-expanded-desc {
          font-size: 11px;
          line-height: 1.6;
          color: var(--loki-text-secondary);
          margin-bottom: 6px;
          white-space: pre-wrap;
          word-wrap: break-word;
        }

        .card-expanded-meta {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 4px;
          font-size: 10px;
          color: var(--loki-text-muted);
        }

        .card-expanded-meta dt {
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .card-expanded-meta dd {
          margin: 0;
          color: var(--loki-text-secondary);
          font-family: 'JetBrains Mono', monospace;
        }

        .expand-toggle {
          display: flex;
          align-items: center;
          gap: 2px;
          font-size: 10px;
          color: var(--loki-text-muted);
          cursor: pointer;
          padding: 2px 0;
        }

        .expand-toggle:hover {
          color: var(--loki-accent);
        }

        .expand-toggle svg {
          width: 12px;
          height: 12px;
        }

        /* G74: Bulk selection checkbox */
        .task-checkbox {
          width: 14px;
          height: 14px;
          border-radius: 3px;
          border: 1.5px solid var(--loki-border-light);
          background: var(--loki-bg-card);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: all var(--loki-transition);
        }

        .task-checkbox:hover {
          border-color: var(--loki-accent);
        }

        .task-checkbox.checked {
          background: var(--loki-accent);
          border-color: var(--loki-accent);
        }

        .task-checkbox.checked::after {
          content: '';
          width: 8px;
          height: 8px;
          background: white;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
          -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
          mask-size: contain;
          -webkit-mask-size: contain;
        }

        .bulk-actions-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: var(--loki-accent-muted);
          border: 1px solid var(--loki-accent);
          border-radius: 4px;
          margin-bottom: 12px;
          font-size: 12px;
          color: var(--loki-text-primary);
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .bulk-count {
          font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          color: var(--loki-accent);
        }

        .bulk-btn {
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 500;
          border-radius: 3px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-card);
          color: var(--loki-text-secondary);
          cursor: pointer;
          transition: all var(--loki-transition);
        }

        .bulk-btn:hover {
          background: var(--loki-bg-hover);
          border-color: var(--loki-border-light);
        }

        .bulk-btn.danger {
          color: var(--loki-red);
          border-color: var(--loki-red-muted);
        }

        .bulk-btn.danger:hover {
          background: var(--loki-red-muted);
        }

        /* G75: Quick filter dropdown */
        .filter-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 12px;
        }

        .filter-label {
          font-size: 11px;
          color: var(--loki-text-muted);
          font-weight: 500;
        }

        .filter-pill {
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 500;
          border-radius: 9999px;
          border: 1px solid var(--loki-border);
          background: var(--loki-bg-secondary);
          color: var(--loki-text-secondary);
          cursor: pointer;
          transition: all var(--loki-transition);
        }

        .filter-pill:hover {
          border-color: var(--loki-border-light);
          background: var(--loki-bg-hover);
        }

        .filter-pill.active {
          background: var(--loki-accent);
          border-color: var(--loki-accent);
          color: white;
        }

        /* G71: Agent Avatars */
        .agent-avatar {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 8px;
          font-weight: 700;
          color: white;
          flex-shrink: 0;
          position: relative;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .agent-avatar.architect { background: var(--loki-blue); }
        .agent-avatar.developer { background: var(--loki-purple); }
        .agent-avatar.tester { background: var(--loki-green); }
        .agent-avatar.reviewer { background: var(--loki-yellow); }
        .agent-avatar.default { background: var(--loki-text-muted); }

        .agent-status-dot {
          position: absolute;
          bottom: -1px;
          right: -1px;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          border: 1.5px solid var(--loki-bg-card);
        }

        .agent-status-dot.active { background: var(--loki-green); }
        .agent-status-dot.idle { background: var(--loki-text-muted); }
        .agent-status-dot.failed { background: var(--loki-red); }

        .agent-tooltip {
          display: none;
          position: absolute;
          bottom: 100%;
          left: 50%;
          transform: translateX(-50%);
          margin-bottom: 6px;
          padding: 4px 8px;
          background: var(--loki-bg-card);
          border: 1px solid var(--loki-border);
          border-radius: 3px;
          font-size: 10px;
          color: var(--loki-text-primary);
          white-space: nowrap;
          z-index: 10;
          box-shadow: var(--loki-shadow-md);
        }

        .agent-avatar:hover .agent-tooltip {
          display: block;
        }
      </style>
    `;

    const columnIcon = (status) => {
      switch (status) {
        case 'pending':
          return '<circle cx="12" cy="12" r="10"/>';
        case 'in_progress':
          return '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>';
        case 'review':
          return '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
        case 'done':
          return '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
        default:
          return '<circle cx="12" cy="12" r="10"/>';
      }
    };

    let content;
    if (this._loading) {
      content = '<div class="loading">Loading tasks...</div>';
    } else if (this._error && this._tasks.length === 0) {
      content = `<div class="error">Error: ${this._escapeHtml(this._error)}</div>`;
    } else {
      const readonly = this.hasAttribute('readonly');
      const filters = [
        { id: 'all', label: 'All' },
        { id: 'today', label: 'Today' },
        { id: 'this-week', label: 'This Week' },
        { id: 'running', label: 'Running' },
        { id: 'failed', label: 'Failed' },
      ];

      const getAgentAvatar = (task) => {
        if (!task.assigned_agent_id && !task.agent_type) return '';
        const agentType = (task.agent_type || '').toLowerCase();
        let initials = 'AG';
        let cssClass = 'default';
        let statusClass = 'idle';
        let tooltipText = `Agent #${task.assigned_agent_id || '?'}`;

        if (agentType.includes('architect') || agentType === 'ar') {
          initials = 'AR'; cssClass = 'architect'; tooltipText = 'Architect';
        } else if (agentType.includes('develop') || agentType === 'dv') {
          initials = 'DV'; cssClass = 'developer'; tooltipText = 'Developer';
        } else if (agentType.includes('test') || agentType === 'ts') {
          initials = 'TS'; cssClass = 'tester'; tooltipText = 'Tester';
        } else if (agentType.includes('review') || agentType === 'rv') {
          initials = 'RV'; cssClass = 'reviewer'; tooltipText = 'Reviewer';
        }

        if (task.status === 'in_progress') statusClass = 'active';
        if (task.status === 'failed' || task.status === 'error') statusClass = 'failed';

        return `
          <div class="agent-avatar ${cssClass}">
            ${initials}
            <span class="agent-status-dot ${statusClass}"></span>
            <span class="agent-tooltip">${this._escapeHtml(tooltipText)}</span>
          </div>
        `;
      };

      content = `
        <div class="filter-bar">
          <span class="filter-label">Filter:</span>
          ${filters.map(f => `
            <button class="filter-pill ${this._activeFilter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>
          `).join('')}
        </div>

        ${this._bulkMode && this._selectedTasks.size > 0 ? `
          <div class="bulk-actions-bar">
            <span class="bulk-count">${this._selectedTasks.size}</span> selected
            <button class="bulk-btn" data-bulk-action="in_progress">Move to In Progress</button>
            <button class="bulk-btn" data-bulk-action="done">Mark Done</button>
            <button class="bulk-btn danger" data-bulk-action="delete">Delete</button>
          </div>
        ` : ''}

        <div class="kanban-board">
          ${COLUMNS.map(col => {
            const tasks = this._getTasksByStatus(col.status);
            return `
              <div class="kanban-column" data-status="${col.status}">
                <div class="kanban-column-header">
                  <span class="kanban-column-title">
                    <svg class="column-icon" viewBox="0 0 24 24" style="color: ${col.color}">
                      ${columnIcon(col.status)}
                    </svg>
                    ${col.label}
                  </span>
                  <span class="kanban-column-count">${tasks.length}</span>
                </div>
                <div class="kanban-tasks" data-status="${col.status}">
                  ${tasks.length === 0 ? `<div class="empty-column">No tasks</div>` : ''}
                  ${tasks.map(task => {
                    const taskIdStr = String(task.id || '');
                    const isExpanded = this._expandedCards.has(taskIdStr);
                    const isSelected = this._selectedTasks.has(taskIdStr);
                    return `
                    <div class="task-card ${!readonly && !task.fromServer ? 'draggable' : ''} ${task.isLocal ? 'local' : ''} ${isExpanded ? 'expanded' : ''} ${isSelected ? 'selected' : ''}"
                         data-task-id="${this._escapeHtml(taskIdStr)}"
                         tabindex="0"
                         role="button"
                         aria-label="Task: ${this._escapeHtml(task.title || 'Untitled')}, ${this._escapeHtml(String(task.priority || 'medium'))} priority"
                         ${!readonly && !task.fromServer ? 'draggable="true"' : ''}>
                      <div class="task-card-header">
                        <div style="display:flex;align-items:center;gap:6px;">
                          ${this._bulkMode ? `<div class="task-checkbox ${isSelected ? 'checked' : ''}" data-check-id="${this._escapeHtml(taskIdStr)}"></div>` : ''}
                          <span class="task-id">${task.isLocal ? 'LOCAL' : '#' + this._escapeHtml(taskIdStr)}</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;">
                          ${getAgentAvatar(task)}
                          <span class="task-priority ${this._escapeHtml(String(task.priority || 'medium').toLowerCase())}">${this._escapeHtml(String(task.priority || 'medium'))}</span>
                        </div>
                      </div>
                      <div class="task-title">${this._escapeHtml(task.title || 'Untitled')}</div>
                      ${!isExpanded && task.description ? `<div class="task-desc">${this._escapeHtml(task.description.substring(0, 80))}${task.description.length > 80 ? '...' : ''}</div>` : ''}
                      <div class="task-meta">
                        <span class="task-type">${this._escapeHtml(String(task.type || 'task'))}</span>
                        <span class="expand-toggle" data-expand-id="${this._escapeHtml(taskIdStr)}">
                          ${isExpanded ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg> Less' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> More'}
                        </span>
                      </div>
                      ${isExpanded ? `
                        <div class="card-expanded-content">
                          ${task.description ? `<div class="card-expanded-desc">${this._escapeHtml(task.description)}</div>` : ''}
                          <dl class="card-expanded-meta">
                            ${task.assigned_agent_id ? `<dt>Agent</dt><dd>#${this._escapeHtml(String(task.assigned_agent_id))}</dd>` : ''}
                            ${task.created_at ? `<dt>Created</dt><dd>${this._escapeHtml(new Date(task.created_at).toLocaleString())}</dd>` : ''}
                            ${task.updated_at ? `<dt>Updated</dt><dd>${this._escapeHtml(new Date(task.updated_at).toLocaleString())}</dd>` : ''}
                            ${task.acceptance_criteria?.length ? `<dt>Criteria</dt><dd>${task.acceptance_criteria.length} items</dd>` : ''}
                          </dl>
                        </div>
                      ` : ''}
                    </div>
                  `;}).join('')}
                </div>
                ${!readonly && col.status === 'pending' ? `
                  <button class="add-task-btn" data-status="${col.status}" aria-label="Add new task to ${col.label}">+ Add Task</button>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      ${styles}
      <div class="board-container">
        <div class="board-header">
          <h2 class="board-title">Task Queue</h2>
          <div class="board-actions">
            <button class="btn btn-secondary" id="bulk-toggle-btn" aria-label="Toggle bulk selection">
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true">
                <polyline points="9 11 12 14 22 4"/>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              ${this._bulkMode ? 'Cancel' : 'Select'}
            </button>
            <button class="btn btn-secondary" id="refresh-btn" aria-label="Refresh task board">
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
              Refresh
            </button>
          </div>
        </div>
        ${content}
      </div>
      ${this._selectedTask ? this._renderTaskDetailModal(this._selectedTask) : ''}
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    // Refresh button
    const refreshBtn = this.shadowRoot.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._loadTasks());
    }

    // Bulk mode toggle
    const bulkToggle = this.shadowRoot.getElementById('bulk-toggle-btn');
    if (bulkToggle) {
      bulkToggle.addEventListener('click', () => this._toggleBulkMode());
    }

    // Filter pills
    this.shadowRoot.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', () => this._setFilter(pill.dataset.filter));
    });

    // Bulk action buttons
    this.shadowRoot.querySelectorAll('.bulk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.bulkAction;
        if (action === 'delete') {
          this._bulkDelete();
        } else {
          this._bulkMove(action);
        }
      });
    });

    // Add task buttons
    this.shadowRoot.querySelectorAll('.add-task-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._openAddTaskModal(btn.dataset.status);
      });
    });

    // Task checkboxes (bulk mode)
    this.shadowRoot.querySelectorAll('.task-checkbox').forEach(cb => {
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleTaskSelection(cb.dataset.checkId, e);
      });
    });

    // Expand toggles
    this.shadowRoot.querySelectorAll('.expand-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleCardExpand(toggle.dataset.expandId);
      });
    });

    // Task cards
    this.shadowRoot.querySelectorAll('.task-card').forEach(card => {
      const taskId = card.dataset.taskId;
      const task = this._tasks.find(t => t.id.toString() === taskId);

      if (!task) return;

      card.addEventListener('click', (e) => {
        // In bulk mode, clicking the card toggles selection
        if (this._bulkMode) {
          this._toggleTaskSelection(taskId, e);
          return;
        }
        this._openTaskDetail(task);
      });

      // Keyboard navigation support
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (this._bulkMode) {
            this._toggleTaskSelection(taskId, e);
          } else {
            this._openTaskDetail(task);
          }
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._navigateTaskCards(card, e.key === 'ArrowDown' ? 'next' : 'prev');
        }
      });

      if (card.classList.contains('draggable')) {
        card.addEventListener('dragstart', (e) => this._handleDragStart(e, task));
        card.addEventListener('dragend', (e) => this._handleDragEnd(e));
      }
    });

    // Drop zones
    this.shadowRoot.querySelectorAll('.kanban-tasks').forEach(zone => {
      zone.addEventListener('dragover', (e) => this._handleDragOver(e));
      zone.addEventListener('dragenter', (e) => this._handleDragEnter(e));
      zone.addEventListener('dragleave', (e) => this._handleDragLeave(e));
      zone.addEventListener('drop', (e) => this._handleDrop(e, zone.dataset.status));
    });

    // Modal close
    const closeBtn = this.shadowRoot.getElementById('modal-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeTaskDetail());
    }
    const overlay = this.shadowRoot.getElementById('task-detail-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeTaskDetail();
      });
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _navigateTaskCards(currentCard, direction) {
    const cards = Array.from(this.shadowRoot.querySelectorAll('.task-card'));
    const currentIndex = cards.indexOf(currentCard);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
    if (targetIndex >= 0 && targetIndex < cards.length) {
      cards[targetIndex].focus();
    }
  }
}

// Register the component
if (!customElements.get('loki-task-board')) {
  customElements.define('loki-task-board', LokiTaskBoard);
}

export default LokiTaskBoard;
