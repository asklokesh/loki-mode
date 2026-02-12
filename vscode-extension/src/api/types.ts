/**
 * Loki Mode API Types
 * TypeScript interfaces for the HTTP API and SSE events
 */

// =============================================================================
// Core Domain Types
// =============================================================================

/**
 * Execution phase in the Loki workflow
 */
export type Phase =
    | 'idle'
    | 'initializing'
    | 'planning'
    | 'implementing'
    | 'testing'
    | 'reviewing'
    | 'deploying'
    | 'completed'
    | 'failed'
    | 'paused';

/**
 * Task status within a session
 */
export type TaskStatus =
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'skipped';

/**
 * Session state (matches dashboard/server.py)
 */
export type SessionState =
    | 'running'
    | 'paused'
    | 'stopping'
    | 'stopped'
    | 'completed'
    | 'failed';

/**
 * Provider type for multi-provider support
 */
export type Provider = 'claude' | 'codex' | 'gemini';

/**
 * A task within the Loki workflow
 */
export interface Task {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    phase: Phase;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    output?: string;
    subtasks?: Task[];
}

/**
 * Current session status (matches server response format)
 * Server returns: { state, pid, statusText, currentPhase, currentTask, pendingTasks, provider, version, lokiDir, timestamp }
 */
export interface SessionStatus {
    state: 'running' | 'paused' | 'stopping' | 'stopped';
    pid: number | null;
    statusText: string;
    currentPhase: string;
    currentTask: string;
    pendingTasks: number;
    provider: Provider;
    version: string;
    lokiDir: string;
    timestamp: string;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Base API response
 */
export interface ApiResponse {
    success: boolean;
    message?: string;
    error?: string;
}

/**
 * Health check response (matches dashboard/server.py /api/health endpoint)
 * Server returns: { status: 'ok', version: '...' }
 */
export interface HealthResponse {
    status: 'ok' | 'error';
    version: string;
}

/**
 * Status endpoint response (flat format from server)
 * Note: Server returns SessionStatus directly, not wrapped in ApiResponse
 */
export type StatusResponse = SessionStatus;

/**
 * Start session response (flat format from server)
 * Server returns: { started: true, pid, provider, args }
 */
export interface StartResponse {
    started: boolean;
    pid: number;
    provider: Provider;
    args: string[];
    error?: string;
}

/**
 * Stop session response (flat format from server)
 * Server returns: { stopped: true }
 */
export interface StopResponse {
    stopped: boolean;
    error?: string;
}

/**
 * Pause session response (flat format from server)
 * Server returns: { paused: true }
 */
export interface PauseResponse {
    paused: boolean;
    error?: string;
}

/**
 * Resume session response (flat format from server)
 * Server returns: { resumed: true }
 */
export interface ResumeResponse {
    resumed: boolean;
    error?: string;
}

/**
 * Input injection response (PLANNED - endpoint not yet implemented)
 * @deprecated The /input endpoint is not yet implemented in dashboard/server.py
 */
export interface InputResponse {
    received: boolean;
    queuePosition?: number;
    error?: string;
}

// =============================================================================
// API Request Types
// =============================================================================

/**
 * Start session request body
 */
export interface StartRequest {
    prd: string;
    provider?: Provider;
    options?: StartOptions;
}

/**
 * Options for starting a session
 */
export interface StartOptions {
    dryRun?: boolean;
    verbose?: boolean;
    skipTests?: boolean;
    skipDeploy?: boolean;
    parallel?: boolean;
    maxAgents?: number;
}

/**
 * Input injection request body
 */
export interface InputRequest {
    input: string;
    targetTask?: string;
}

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * Base SSE event
 */
export interface BaseEvent {
    type: string;
    timestamp: string;
    sessionId: string;
}

/**
 * Session started event
 */
export interface SessionStartedEvent extends BaseEvent {
    type: 'session:started';
    data: {
        provider: Provider;
        prdPath: string;
    };
}

/**
 * Session stopped event
 */
export interface SessionStoppedEvent extends BaseEvent {
    type: 'session:stopped';
    data: {
        reason: 'user' | 'completed' | 'error';
        tasksCompleted: number;
        totalTasks: number;
    };
}

/**
 * Session paused event
 */
export interface SessionPausedEvent extends BaseEvent {
    type: 'session:paused';
    data: {
        phase: Phase;
    };
}

/**
 * Session resumed event
 */
export interface SessionResumedEvent extends BaseEvent {
    type: 'session:resumed';
    data: {
        phase: Phase;
    };
}

/**
 * Phase started event
 */
export interface PhaseStartedEvent extends BaseEvent {
    type: 'phase:started';
    data: {
        phase: Phase;
        previousPhase: Phase;
    };
}

/**
 * Phase completed event
 */
export interface PhaseCompletedEvent extends BaseEvent {
    type: 'phase:completed';
    data: {
        phase: Phase;
        duration: number;
        tasksCompleted: number;
    };
}

/**
 * Task started event
 */
export interface TaskStartedEvent extends BaseEvent {
    type: 'task:started';
    data: {
        task: Task;
    };
}

/**
 * Task progress event
 */
export interface TaskProgressEvent extends BaseEvent {
    type: 'task:progress';
    data: {
        taskId: string;
        progress: number;
        message: string;
    };
}

/**
 * Task completed event
 */
export interface TaskCompletedEvent extends BaseEvent {
    type: 'task:completed';
    data: {
        task: Task;
        duration: number;
    };
}

/**
 * Task failed event
 */
export interface TaskFailedEvent extends BaseEvent {
    type: 'task:failed';
    data: {
        task: Task;
        error: string;
        recoverable: boolean;
    };
}

/**
 * Log event for real-time output
 */
export interface LogEvent extends BaseEvent {
    type: 'log';
    data: {
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        source?: string;
    };
}

/**
 * Error event
 */
export interface ErrorEvent extends BaseEvent {
    type: 'error';
    data: {
        code: string;
        message: string;
        fatal: boolean;
    };
}

/**
 * Heartbeat event for connection health
 */
export interface HeartbeatEvent extends BaseEvent {
    type: 'heartbeat';
    data: {
        uptime: number;
        memoryUsage: number;
    };
}

/**
 * Status poll event (used by VS Code extension polling)
 */
export interface StatusPollEvent {
    type: 'status';
    timestamp: string;
    data: SessionStatus;
}

/**
 * Connection error event (used by VS Code extension polling)
 */
export interface ConnectionErrorEvent {
    type: 'connection:error';
    timestamp: string;
    data: {
        message: string;
        code: string;
    };
}

/**
 * Union type of all SSE events
 */
export type LokiEvent =
    | SessionStartedEvent
    | SessionStoppedEvent
    | SessionPausedEvent
    | SessionResumedEvent
    | PhaseStartedEvent
    | PhaseCompletedEvent
    | TaskStartedEvent
    | TaskProgressEvent
    | TaskCompletedEvent
    | TaskFailedEvent
    | LogEvent
    | ErrorEvent
    | HeartbeatEvent
    | StatusPollEvent
    | ConnectionErrorEvent;

/**
 * Event type string literals
 */
export type LokiEventType = LokiEvent['type'];

/**
 * Callback for SSE event handling
 */
export type EventCallback = (event: LokiEvent) => void;

/**
 * Typed event callbacks for specific event types
 */
export interface EventCallbacks {
    'session:started'?: (event: SessionStartedEvent) => void;
    'session:stopped'?: (event: SessionStoppedEvent) => void;
    'session:paused'?: (event: SessionPausedEvent) => void;
    'session:resumed'?: (event: SessionResumedEvent) => void;
    'phase:started'?: (event: PhaseStartedEvent) => void;
    'phase:completed'?: (event: PhaseCompletedEvent) => void;
    'task:started'?: (event: TaskStartedEvent) => void;
    'task:progress'?: (event: TaskProgressEvent) => void;
    'task:completed'?: (event: TaskCompletedEvent) => void;
    'task:failed'?: (event: TaskFailedEvent) => void;
    'log'?: (event: LogEvent) => void;
    'error'?: (event: ErrorEvent) => void;
    'heartbeat'?: (event: HeartbeatEvent) => void;
    'status'?: (event: StatusPollEvent) => void;
    'connection:error'?: (event: ConnectionErrorEvent) => void;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Disposable interface for cleanup
 */
export interface Disposable {
    dispose(): void;
}

/**
 * API client configuration
 */
export interface ApiClientConfig {
    baseUrl: string;
    timeout?: number;
    retryAttempts?: number;
    retryDelay?: number;
    pollingInterval?: number;
}

/**
 * Error types from the API
 */
export interface ApiError extends Error {
    code: string;
    statusCode?: number;
    response?: unknown;
}
