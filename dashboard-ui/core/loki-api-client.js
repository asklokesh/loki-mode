/**
 * Loki Mode API Client
 *
 * Unified API client for Loki Mode web components.
 * Supports both REST API and WebSocket connections.
 * Features adaptive polling and VS Code webview integration.
 */

/**
 * Polling interval presets for different contexts
 */
const POLL_INTERVALS = {
  realtime: 1000,      // Active session monitoring
  normal: 2000,        // Default
  background: 5000,    // VS Code sidebar (not visible)
  offline: 10000,      // Connectivity check only
};

/**
 * Default polling intervals by context
 */
const CONTEXT_DEFAULTS = {
  vscode: POLL_INTERVALS.normal,
  browser: POLL_INTERVALS.realtime,
  cli: POLL_INTERVALS.background,
};

/**
 * Default API configuration
 */
const DEFAULT_CONFIG = {
  baseUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:57374',
  wsUrl: typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws` : 'ws://localhost:57374/ws',
  pollInterval: 2000,
  timeout: 10000,
  retryAttempts: 3,
  retryDelay: 1000,
};

/**
 * API Event types
 */
export const ApiEvents = {
  CONNECTED: 'api:connected',
  DISCONNECTED: 'api:disconnected',
  ERROR: 'api:error',
  STATUS_UPDATE: 'api:status-update',
  TASK_CREATED: 'api:task-created',
  TASK_UPDATED: 'api:task-updated',
  TASK_DELETED: 'api:task-deleted',
  PROJECT_CREATED: 'api:project-created',
  PROJECT_UPDATED: 'api:project-updated',
  AGENT_UPDATE: 'api:agent-update',
  LOG_MESSAGE: 'api:log-message',
  MEMORY_UPDATE: 'api:memory-update',
};

/**
 * LokiApiClient - Per-URL API client for Loki Mode
 */
export class LokiApiClient extends EventTarget {
  static _instances = new Map();

  /**
   * Get an instance for a specific URL
   * @param {object} config - Configuration options
   * @returns {LokiApiClient}
   */
  static getInstance(config = {}) {
    const baseUrl = config.baseUrl || DEFAULT_CONFIG.baseUrl;
    if (!LokiApiClient._instances.has(baseUrl)) {
      LokiApiClient._instances.set(baseUrl, new LokiApiClient(config));
    }
    return LokiApiClient._instances.get(baseUrl);
  }

  /**
   * Clear all cached instances (useful for testing)
   */
  static clearInstances() {
    LokiApiClient._instances.forEach(instance => instance.disconnect());
    LokiApiClient._instances.clear();
  }

  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._ws = null;
    this._connected = false;
    this._pollInterval = null;
    this._reconnectTimeout = null;
    this._cache = new Map();
    this._cacheTimeout = 5000; // 5 seconds cache
    this._vscodeApi = null;
    this._context = this._detectContext();
    this._currentPollInterval = CONTEXT_DEFAULTS[this._context] || POLL_INTERVALS.normal;

    // Setup adaptive polling and VS Code bridge
    this._setupAdaptivePolling();
    this._setupVSCodeBridge();
  }

  // ============================================
  // Context Detection and Adaptive Polling
  // ============================================

  /**
   * Detect the current execution context
   * @returns {'vscode'|'browser'|'cli'}
   */
  _detectContext() {
    // Check for VS Code webview environment
    if (typeof acquireVsCodeApi !== 'undefined') return 'vscode';
    // Check for browser environment
    if (typeof window !== 'undefined' && window.location) return 'browser';
    // Default to CLI context (Node.js or similar)
    return 'cli';
  }

  /**
   * Get the current execution context
   */
  get context() {
    return this._context;
  }

  /**
   * Get available polling intervals
   */
  static get POLL_INTERVALS() {
    return POLL_INTERVALS;
  }

  /**
   * Setup adaptive polling based on page visibility
   */
  _setupAdaptivePolling() {
    // Only setup in browser environments with document API
    if (typeof document === 'undefined') return;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._setPollInterval(POLL_INTERVALS.background);
      } else {
        this._setPollInterval(CONTEXT_DEFAULTS[this._context] || POLL_INTERVALS.normal);
      }
    });
  }

  /**
   * Update the polling interval dynamically
   * @param {number} interval - New polling interval in milliseconds
   */
  _setPollInterval(interval) {
    this._currentPollInterval = interval;

    // If actively polling, restart with new interval
    if (this._pollInterval) {
      this.stopPolling();
      this.startPolling(null, interval);
    }
  }

  /**
   * Manually set polling mode
   * @param {'realtime'|'normal'|'background'|'offline'} mode
   */
  setPollMode(mode) {
    const interval = POLL_INTERVALS[mode];
    if (interval) {
      this._setPollInterval(interval);
    }
  }

  // ============================================
  // VS Code Message Bridge
  // ============================================

  /**
   * Setup VS Code webview message bridge
   */
  _setupVSCodeBridge() {
    // Check if running in VS Code webview
    if (typeof acquireVsCodeApi === 'undefined') return;

    try {
      this._vscodeApi = acquireVsCodeApi();
    } catch (e) {
      // acquireVsCodeApi can only be called once, may already be acquired
      console.warn('VS Code API already acquired or unavailable');
      return;
    }

    // Listen for messages from VS Code extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || !message.type) return;

      switch (message.type) {
        case 'updateStatus':
          this._emit(ApiEvents.STATUS_UPDATE, message.data);
          break;
        case 'updateTasks':
          this._emit(ApiEvents.TASK_UPDATED, message.data);
          break;
        case 'taskCreated':
          this._emit(ApiEvents.TASK_CREATED, message.data);
          break;
        case 'taskDeleted':
          this._emit(ApiEvents.TASK_DELETED, message.data);
          break;
        case 'projectCreated':
          this._emit(ApiEvents.PROJECT_CREATED, message.data);
          break;
        case 'projectUpdated':
          this._emit(ApiEvents.PROJECT_UPDATED, message.data);
          break;
        case 'agentUpdate':
          this._emit(ApiEvents.AGENT_UPDATE, message.data);
          break;
        case 'logMessage':
          this._emit(ApiEvents.LOG_MESSAGE, message.data);
          break;
        case 'memoryUpdate':
          this._emit(ApiEvents.MEMORY_UPDATE, message.data);
          break;
        case 'connected':
          this._connected = true;
          this._emit(ApiEvents.CONNECTED, message.data);
          break;
        case 'disconnected':
          this._connected = false;
          this._emit(ApiEvents.DISCONNECTED, message.data);
          break;
        case 'error':
          this._emit(ApiEvents.ERROR, message.data);
          break;
        case 'setPollMode':
          this.setPollMode(message.data.mode);
          break;
        default:
          // Emit unknown message types as custom events
          this._emit(`api:${message.type}`, message.data);
      }
    });
  }

  /**
   * Check if running in VS Code webview
   */
  get isVSCode() {
    return this._context === 'vscode';
  }

  /**
   * Post a message to VS Code extension host
   * @param {string} type - Message type
   * @param {object} data - Message data
   */
  postToVSCode(type, data = {}) {
    if (this._vscodeApi) {
      this._vscodeApi.postMessage({ type, data });
    }
  }

  /**
   * Request data refresh from VS Code extension
   */
  requestRefresh() {
    this.postToVSCode('requestRefresh');
  }

  /**
   * Notify VS Code of user action
   * @param {string} action - Action name
   * @param {object} payload - Action payload
   */
  notifyVSCode(action, payload = {}) {
    this.postToVSCode('userAction', { action, ...payload });
  }

  /**
   * Get the API base URL
   */
  get baseUrl() {
    return this.config.baseUrl;
  }

  /**
   * Set the API base URL
   */
  set baseUrl(url) {
    this.config.baseUrl = url;
    this.config.wsUrl = url.replace(/^http/, 'ws') + '/ws';
  }

  /**
   * Check if connected
   */
  get isConnected() {
    return this._connected;
  }

  // ============================================
  // Connection Management
  // ============================================

  /**
   * Connect to WebSocket for real-time updates
   */
  async connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this.config.wsUrl);

        this._ws.onopen = () => {
          this._connected = true;
          this._emit(ApiEvents.CONNECTED);
          resolve();
        };

        this._ws.onclose = () => {
          this._connected = false;
          this._emit(ApiEvents.DISCONNECTED);
          this._scheduleReconnect();
        };

        this._ws.onerror = (error) => {
          this._emit(ApiEvents.ERROR, { error });
          reject(error);
        };

        this._ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this._handleMessage(message);
          } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    this._connected = false;
  }

  /**
   * Schedule reconnect attempt
   */
  _scheduleReconnect() {
    if (this._reconnectTimeout) return;

    this._reconnectTimeout = setTimeout(() => {
      this._reconnectTimeout = null;
      this.connect().catch(() => {
        // Will retry on next schedule
      });
    }, this.config.retryDelay);
  }

  /**
   * Handle incoming WebSocket message
   */
  _handleMessage(message) {
    const eventMap = {
      'connected': ApiEvents.CONNECTED,
      'status_update': ApiEvents.STATUS_UPDATE,
      'task_created': ApiEvents.TASK_CREATED,
      'task_updated': ApiEvents.TASK_UPDATED,
      'task_deleted': ApiEvents.TASK_DELETED,
      'task_moved': ApiEvents.TASK_UPDATED,
      'project_created': ApiEvents.PROJECT_CREATED,
      'project_updated': ApiEvents.PROJECT_UPDATED,
      'agent_update': ApiEvents.AGENT_UPDATE,
      'log': ApiEvents.LOG_MESSAGE,
    };

    const eventType = eventMap[message.type] || `api:${message.type}`;
    this._emit(eventType, message.data);
  }

  /**
   * Emit an event
   */
  _emit(type, data = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }

  // ============================================
  // HTTP Request Methods
  // ============================================

  /**
   * Make an HTTP request
   */
  async _request(endpoint, options = {}) {
    const url = `${this.config.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(error.detail || `HTTP ${response.status}`);
      }

      if (response.status === 204) {
        return null;
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }

  /**
   * GET request with caching
   */
  async _get(endpoint, useCache = false) {
    if (useCache && this._cache.has(endpoint)) {
      const cached = this._cache.get(endpoint);
      if (Date.now() - cached.timestamp < this._cacheTimeout) {
        return cached.data;
      }
    }

    const data = await this._request(endpoint);

    if (useCache) {
      this._cache.set(endpoint, { data, timestamp: Date.now() });
    }

    return data;
  }

  /**
   * POST request
   */
  async _post(endpoint, body) {
    return this._request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * PUT request
   */
  async _put(endpoint, body) {
    return this._request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE request
   */
  async _delete(endpoint) {
    return this._request(endpoint, { method: 'DELETE' });
  }

  // ============================================
  // Status API
  // ============================================

  /**
   * Get system status
   */
  async getStatus() {
    return this._get('/api/status');
  }

  /**
   * Health check
   */
  async healthCheck() {
    return this._get('/health');
  }

  // ============================================
  // Projects API
  // ============================================

  /**
   * List all projects
   */
  async listProjects(status = null) {
    const query = status ? `?status=${status}` : '';
    return this._get(`/api/projects${query}`);
  }

  /**
   * Get a project by ID
   */
  async getProject(projectId) {
    return this._get(`/api/projects/${projectId}`);
  }

  /**
   * Create a new project
   */
  async createProject(data) {
    return this._post('/api/projects', data);
  }

  /**
   * Update a project
   */
  async updateProject(projectId, data) {
    return this._put(`/api/projects/${projectId}`, data);
  }

  /**
   * Delete a project
   */
  async deleteProject(projectId) {
    return this._delete(`/api/projects/${projectId}`);
  }

  // ============================================
  // Tasks API
  // ============================================

  /**
   * List tasks
   */
  async listTasks(filters = {}) {
    const params = new URLSearchParams();
    if (filters.projectId) params.append('project_id', filters.projectId);
    if (filters.status) params.append('status', filters.status);
    if (filters.priority) params.append('priority', filters.priority);

    const query = params.toString() ? `?${params}` : '';
    return this._get(`/api/tasks${query}`);
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId) {
    return this._get(`/api/tasks/${taskId}`);
  }

  /**
   * Create a new task
   */
  async createTask(data) {
    return this._post('/api/tasks', data);
  }

  /**
   * Update a task
   */
  async updateTask(taskId, data) {
    return this._put(`/api/tasks/${taskId}`, data);
  }

  /**
   * Move a task (Kanban drag-drop)
   */
  async moveTask(taskId, status, position) {
    return this._post(`/api/tasks/${taskId}/move`, { status, position });
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId) {
    return this._delete(`/api/tasks/${taskId}`);
  }

  // ============================================
  // Memory API
  // ============================================

  /**
   * Get memory summary
   */
  async getMemorySummary() {
    return this._get('/api/memory/summary', true);
  }

  /**
   * Get memory index (Layer 1)
   */
  async getMemoryIndex() {
    return this._get('/api/memory/index', true);
  }

  /**
   * Get memory timeline (Layer 2)
   */
  async getMemoryTimeline() {
    return this._get('/api/memory/timeline');
  }

  /**
   * List episodes
   */
  async listEpisodes(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this._get(`/api/memory/episodes${query ? '?' + query : ''}`);
  }

  /**
   * Get episode detail
   */
  async getEpisode(episodeId) {
    return this._get(`/api/memory/episodes/${episodeId}`);
  }

  /**
   * List patterns
   */
  async listPatterns(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this._get(`/api/memory/patterns${query ? '?' + query : ''}`);
  }

  /**
   * Get pattern detail
   */
  async getPattern(patternId) {
    return this._get(`/api/memory/patterns/${patternId}`);
  }

  /**
   * List skills
   */
  async listSkills() {
    return this._get('/api/memory/skills');
  }

  /**
   * Get skill detail
   */
  async getSkill(skillId) {
    return this._get(`/api/memory/skills/${skillId}`);
  }

  /**
   * Retrieve relevant memories
   */
  async retrieveMemories(query, taskType = null, topK = 5) {
    return this._post('/api/memory/retrieve', { query, taskType, topK });
  }

  /**
   * Trigger memory consolidation
   */
  async consolidateMemory(sinceHours = 24) {
    return this._post('/api/memory/consolidate', { sinceHours });
  }

  /**
   * Get token economics
   */
  async getTokenEconomics() {
    return this._get('/api/memory/economics');
  }

  // ============================================
  // Registry API (Cross-project)
  // ============================================

  /**
   * List registered projects
   */
  async listRegisteredProjects(includeInactive = false) {
    return this._get(`/api/registry/projects?include_inactive=${includeInactive}`);
  }

  /**
   * Register a project
   */
  async registerProject(path, name = null, alias = null) {
    return this._post('/api/registry/projects', { path, name, alias });
  }

  /**
   * Discover projects
   */
  async discoverProjects(maxDepth = 3) {
    return this._get(`/api/registry/discover?max_depth=${maxDepth}`);
  }

  /**
   * Sync registry with discovered projects
   */
  async syncRegistry() {
    return this._post('/api/registry/sync', {});
  }

  /**
   * Get cross-project tasks
   */
  async getCrossProjectTasks(projectIds = null) {
    const query = projectIds ? `?project_ids=${projectIds.join(',')}` : '';
    return this._get(`/api/registry/tasks${query}`);
  }

  // ============================================
  // Learning API
  // ============================================

  /**
   * Get learning metrics and aggregations
   * @param {object} params - Query parameters
   * @param {string} params.timeRange - Time range ('1h', '24h', '7d', '30d')
   * @param {string} params.signalType - Filter by signal type
   * @param {string} params.source - Filter by source
   */
  async getLearningMetrics(params = {}) {
    const query = new URLSearchParams();
    if (params.timeRange) query.append('timeRange', params.timeRange);
    if (params.signalType) query.append('signalType', params.signalType);
    if (params.source) query.append('source', params.source);
    const queryStr = query.toString() ? `?${query}` : '';
    return this._get(`/api/learning/metrics${queryStr}`);
  }

  /**
   * Get learning signal trends over time
   * @param {object} params - Query parameters
   */
  async getLearningTrends(params = {}) {
    const query = new URLSearchParams();
    if (params.timeRange) query.append('timeRange', params.timeRange);
    if (params.signalType) query.append('signalType', params.signalType);
    if (params.source) query.append('source', params.source);
    const queryStr = query.toString() ? `?${query}` : '';
    return this._get(`/api/learning/trends${queryStr}`);
  }

  /**
   * Get recent learning signals
   * @param {object} params - Query parameters
   * @param {number} params.limit - Max signals to return
   * @param {number} params.offset - Pagination offset
   */
  async getLearningSignals(params = {}) {
    const query = new URLSearchParams();
    if (params.timeRange) query.append('timeRange', params.timeRange);
    if (params.signalType) query.append('signalType', params.signalType);
    if (params.source) query.append('source', params.source);
    if (params.limit) query.append('limit', String(params.limit));
    if (params.offset) query.append('offset', String(params.offset));
    const queryStr = query.toString() ? `?${query}` : '';
    return this._get(`/api/learning/signals${queryStr}`);
  }

  /**
   * Get latest aggregation result
   */
  async getLatestAggregation() {
    return this._get('/api/learning/aggregation');
  }

  /**
   * Trigger a new aggregation
   * @param {object} params - Aggregation parameters
   */
  async triggerAggregation(params = {}) {
    return this._post('/api/learning/aggregate', params);
  }

  /**
   * Get aggregated user preferences
   * @param {number} limit - Max preferences to return
   */
  async getAggregatedPreferences(limit = 20) {
    return this._get(`/api/learning/preferences?limit=${limit}`);
  }

  /**
   * Get aggregated error patterns
   * @param {number} limit - Max patterns to return
   */
  async getAggregatedErrors(limit = 20) {
    return this._get(`/api/learning/errors?limit=${limit}`);
  }

  /**
   * Get aggregated success patterns
   * @param {number} limit - Max patterns to return
   */
  async getAggregatedSuccessPatterns(limit = 20) {
    return this._get(`/api/learning/success?limit=${limit}`);
  }

  /**
   * Get tool efficiency rankings
   * @param {number} limit - Max tools to return
   */
  async getToolEfficiency(limit = 20) {
    return this._get(`/api/learning/tools?limit=${limit}`);
  }

  // ============================================
  // Cost API
  // ============================================

  /**
   * Get cost visibility data (tokens, estimated USD, budget)
   */
  async getCost() {
    return this._get('/api/cost');
  }

  /**
   * Get current model pricing (from .loki/pricing.json or static defaults)
   */
  async getPricing() {
    return this._get('/api/pricing');
  }

  // ============================================
  // Context Window Tracking API (v5.40.0)
  // ============================================

  /**
   * Get context window tracking data
   */
  async getContext() {
    return this._get('/api/context');
  }

  // ============================================
  // Notification Trigger API (v5.40.0)
  // ============================================

  /**
   * Get notification list
   * @param {string} [severity] - Filter by severity (critical, warning, info)
   * @param {boolean} [unreadOnly] - Only show unread notifications
   */
  async getNotifications(severity, unreadOnly) {
    const params = new URLSearchParams();
    if (severity) params.set('severity', severity);
    if (unreadOnly) params.set('unread_only', 'true');
    const query = params.toString();
    return this._get('/api/notifications' + (query ? '?' + query : ''));
  }

  /**
   * Get notification trigger configuration
   */
  async getNotificationTriggers() {
    return this._get('/api/notifications/triggers');
  }

  /**
   * Update notification trigger configuration
   * @param {Array} triggers - Array of trigger objects
   */
  async updateNotificationTriggers(triggers) {
    return this._put('/api/notifications/triggers', { triggers });
  }

  /**
   * Acknowledge a notification
   * @param {string} id - Notification ID
   */
  async acknowledgeNotification(id) {
    return this._post('/api/notifications/' + encodeURIComponent(id) + '/acknowledge', {});
  }

  // ============================================
  // Session Control API
  // ============================================

  /**
   * Pause the current session
   */
  async pauseSession() {
    return this._post('/api/control/pause', {});
  }

  /**
   * Resume a paused session
   */
  async resumeSession() {
    return this._post('/api/control/resume', {});
  }

  /**
   * Stop the current session
   */
  async stopSession() {
    return this._post('/api/control/stop', {});
  }

  // ============================================
  // Logs API
  // ============================================

  /**
   * Get recent log entries
   * @param {number} lines - Max lines to return
   */
  async getLogs(lines = 100) {
    return this._get(`/api/logs?lines=${lines}`);
  }

  // ============================================
  // Polling Mode (Fallback)
  // ============================================

  /**
   * Start polling for updates
   * Uses adaptive polling interval based on context and visibility
   */
  startPolling(callback, interval = null) {
    if (this._pollInterval) return;

    // Store callback for use when restarting polling with new interval
    this._pollCallback = callback;

    const pollFn = async () => {
      try {
        const status = await this.getStatus();
        this._connected = true;
        if (this._pollCallback) this._pollCallback(status);
        this._emit(ApiEvents.STATUS_UPDATE, status);

        // Notify VS Code of successful poll if in that context
        if (this._vscodeApi) {
          this.postToVSCode('pollSuccess', { timestamp: Date.now() });
        }
      } catch (error) {
        this._connected = false;
        this._emit(ApiEvents.ERROR, { error });

        // Notify VS Code of poll failure
        if (this._vscodeApi) {
          this.postToVSCode('pollError', { error: error.message });
        }
      }
    };

    pollFn(); // Initial poll
    // Use provided interval, current adaptive interval, or config default
    const effectiveInterval = interval || this._currentPollInterval || this.config.pollInterval;
    this._pollInterval = setInterval(pollFn, effectiveInterval);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }
}

/**
 * Create a new API client instance
 * @param {object} config - Configuration options
 * @returns {LokiApiClient}
 */
export function createApiClient(config = {}) {
  return new LokiApiClient(config);
}

/**
 * Get the default API client instance
 * @param {object} config - Configuration options
 * @returns {LokiApiClient}
 */
export function getApiClient(config = {}) {
  return LokiApiClient.getInstance(config);
}

// Export polling intervals for external configuration
export { POLL_INTERVALS, CONTEXT_DEFAULTS };

export default LokiApiClient;
