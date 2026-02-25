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

/** @type {Object<string, string>} Maps priority level to CSS color variable */
const PRIORITY_COLORS = {
  critical: 'var(--loki-red)',
  high: 'var(--loki-red)',
  medium: 'var(--loki-yellow)',
  low: 'var(--loki-green)',
};

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
    return this._tasks.filter(t => {
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

  _openAddTaskModal(status = 'pending') {
    this.dispatchEvent(new CustomEvent('add-task', { detail: { status } }));
  }

  _openTaskDetail(task) {
    this.dispatchEvent(new CustomEvent('task-click', { detail: { task } }));
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
          transition: all var(--loki-transition);
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
          opacity: 0.5;
          cursor: grabbing;
        }

        .task-card.local {
          border-left: 3px solid var(--loki-accent);
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

      content = `
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
                  ${tasks.map(task => `
                    <div class="task-card ${!readonly && !task.fromServer ? 'draggable' : ''} ${task.isLocal ? 'local' : ''}"
                         data-task-id="${task.id}"
                         tabindex="0"
                         role="button"
                         aria-label="Task: ${this._escapeHtml(task.title || 'Untitled')}, ${task.priority || 'medium'} priority"
                         ${!readonly && !task.fromServer ? 'draggable="true"' : ''}>
                      <div class="task-card-header">
                        <span class="task-id">${task.isLocal ? 'LOCAL' : '#' + task.id}</span>
                        <span class="task-priority ${(task.priority || 'medium').toLowerCase()}">${task.priority || 'medium'}</span>
                      </div>
                      <div class="task-title">${this._escapeHtml(task.title || 'Untitled')}</div>
                      <div class="task-meta">
                        <span class="task-type">${task.type || 'task'}</span>
                        ${task.assigned_agent_id ? `<span>Agent #${task.assigned_agent_id}</span>` : ''}
                      </div>
                    </div>
                  `).join('')}
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
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    // Refresh button
    const refreshBtn = this.shadowRoot.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this._loadTasks());
    }

    // Add task buttons
    this.shadowRoot.querySelectorAll('.add-task-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._openAddTaskModal(btn.dataset.status);
      });
    });

    // Task cards
    this.shadowRoot.querySelectorAll('.task-card').forEach(card => {
      const taskId = card.dataset.taskId;
      const task = this._tasks.find(t => t.id.toString() === taskId);

      if (!task) return;

      card.addEventListener('click', () => this._openTaskDetail(task));

      // Keyboard navigation support
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._openTaskDetail(task);
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
