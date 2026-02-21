'use strict';

var crypto = require('crypto');
var EventEmitter = require('events');

var VALID_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'];
var TERMINAL_STATES = ['completed', 'failed', 'canceled'];
var MAX_TASKS = 1000;
var DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

var VALID_TRANSITIONS = {
  'submitted': ['working', 'failed', 'canceled'],
  'working': ['input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'failed', 'canceled'],
};

/**
 * A2A Task Manager - manages task lifecycle per A2A spec.
 *
 * Note: Authentication and authorization are the integrator's responsibility.
 * This module provides the A2A protocol primitives (task lifecycle, state
 * management, event emission) but does not include an auth layer. Integrators
 * should add middleware or guards at the transport/HTTP layer before invoking
 * TaskManager methods.
 */
class TaskManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTasks] - Maximum concurrent tasks
   * @param {number} [opts.expiryMs] - Task expiry in ms
   * @param {number} [opts.maxInputSize] - Max combined input+metadata size in bytes (default 1MB)
   */
  constructor(opts) {
    super();
    opts = opts || {};
    this._tasks = new Map();
    this._maxTasks = opts.maxTasks || MAX_TASKS;
    this._expiryMs = opts.expiryMs || DEFAULT_EXPIRY_MS;
    this._maxInputSize = opts.maxInputSize || 1 * 1024 * 1024;
  }

  /**
   * Create a new task.
   * @param {object} params - Task parameters
   * @param {string} params.skill - Skill ID to invoke
   * @param {object} [params.input] - Task input data
   * @param {object} [params.metadata] - Arbitrary metadata
   * @returns {object} Created task
   */
  createTask(params) {
    if (!params || !params.skill) {
      throw new Error('Task requires a skill parameter');
    }
    var inputStr = params.input ? JSON.stringify(params.input) : '';
    var metaStr = params.metadata ? JSON.stringify(params.metadata) : '';
    var combinedSize = Buffer.byteLength(inputStr) + Buffer.byteLength(metaStr);
    if (combinedSize > this._maxInputSize) {
      throw new Error('Input size (' + combinedSize + ' bytes) exceeds maxInputSize (' + this._maxInputSize + ' bytes)');
    }
    this._pruneExpired();
    if (this._tasks.size >= this._maxTasks) {
      throw new Error('Maximum task limit reached: ' + this._maxTasks);
    }
    var task = {
      id: crypto.randomUUID(),
      skill: String(params.skill),
      state: 'submitted',
      input: params.input || null,
      output: null,
      artifacts: [],
      metadata: params.metadata || {},
      history: [{ state: 'submitted', timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._tasks.set(task.id, task);
    this.emit('task:created', task);
    return this._copyTask(task);
  }

  /**
   * Update a task's state and/or output.
   * @param {string} taskId
   * @param {object} update - { state, output, artifacts }
   * @returns {object} Updated task
   */
  updateTask(taskId, update) {
    var task = this._tasks.get(taskId);
    if (!task) throw new Error('Task not found: ' + taskId);
    if (TERMINAL_STATES.indexOf(task.state) !== -1) {
      throw new Error('Cannot update task in terminal state: ' + task.state);
    }
    if (update.state) {
      var allowed = VALID_TRANSITIONS[task.state];
      if (!allowed || allowed.indexOf(update.state) === -1) {
        throw new Error('Invalid transition from ' + task.state + ' to ' + update.state);
      }
      var oldState = task.state;
      task.state = update.state;
      task.history.push({ state: update.state, timestamp: new Date().toISOString() });
      this.emit('task:stateChange', { taskId: taskId, from: oldState, to: update.state });
    }
    if (update.output !== undefined) task.output = update.output;
    if (update.artifacts && Array.isArray(update.artifacts)) {
      task.artifacts = task.artifacts.concat(update.artifacts);
    }
    if (update.message) task.message = update.message;
    task.updatedAt = new Date().toISOString();
    this.emit('task:updated', this._copyTask(task));
    return this._copyTask(task);
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId) {
    var task = this._tasks.get(taskId);
    if (!task) return null;
    return this._copyTask(task);
  }

  /**
   * Cancel a task.
   */
  cancelTask(taskId) {
    var task = this._tasks.get(taskId);
    if (!task) throw new Error('Task not found: ' + taskId);
    if (TERMINAL_STATES.indexOf(task.state) !== -1) {
      throw new Error('Cannot cancel task in terminal state: ' + task.state);
    }
    var oldState = task.state;
    task.state = 'canceled';
    task.updatedAt = new Date().toISOString();
    task.history.push({ state: 'canceled', timestamp: new Date().toISOString() });
    this.emit('task:stateChange', { taskId: taskId, from: oldState, to: 'canceled' });
    return this._copyTask(task);
  }

  /**
   * List tasks with optional filter.
   * @param {object} [filter] - { state, skill }
   */
  listTasks(filter) {
    var tasks = [];
    this._tasks.forEach(function (task) {
      if (filter) {
        if (filter.state && task.state !== filter.state) return;
        if (filter.skill && task.skill !== filter.skill) return;
      }
      tasks.push(this._copyTask(task));
    }.bind(this));
    return tasks;
  }

  /**
   * Get task count.
   */
  size() { return this._tasks.size; }

  /**
   * Destroy all tasks.
   */
  destroy() {
    this._tasks.clear();
    this.removeAllListeners();
  }

  _pruneExpired() {
    var now = Date.now();
    var expiryMs = this._expiryMs;
    this._tasks.forEach(function (task, id, map) {
      if (now - new Date(task.createdAt).getTime() > expiryMs) {
        map.delete(id);
      }
    });
  }

  _copyTask(task) {
    return JSON.parse(JSON.stringify(task));
  }
}

module.exports = { TaskManager, VALID_STATES, TERMINAL_STATES, VALID_TRANSITIONS, MAX_TASKS };
