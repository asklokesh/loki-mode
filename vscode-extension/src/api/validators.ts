/**
 * Runtime type validators for API responses
 * Provides type guards to safely validate API response shapes
 */

import { Provider, TaskStatus, Phase, SessionState } from './types';

/**
 * Valid provider values
 */
const VALID_PROVIDERS: Provider[] = ['claude', 'codex', 'gemini'];

/**
 * Valid task status values
 */
const VALID_TASK_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];

/**
 * Valid phase values
 */
const VALID_PHASES: Phase[] = [
    'idle', 'initializing', 'planning', 'implementing',
    'testing', 'reviewing', 'deploying', 'completed', 'failed', 'paused'
];

/**
 * Valid session state values (includes 'stopping' from dashboard server)
 */
const VALID_SESSION_STATES: SessionState[] = ['running', 'paused', 'stopping', 'stopped', 'completed', 'failed'];

/**
 * Check if a value is a valid Provider
 */
export function isValidProvider(value: unknown): value is Provider {
    return typeof value === 'string' && VALID_PROVIDERS.includes(value as Provider);
}

/**
 * Check if a value is a valid TaskStatus
 */
export function isValidTaskStatus(value: unknown): value is TaskStatus {
    return typeof value === 'string' && VALID_TASK_STATUSES.includes(value as TaskStatus);
}

/**
 * Check if a value is a valid Phase
 */
export function isValidPhase(value: unknown): value is Phase {
    return typeof value === 'string' && VALID_PHASES.includes(value as Phase);
}

/**
 * Check if a value is a valid SessionState
 */
export function isValidSessionState(value: unknown): value is SessionState {
    return typeof value === 'string' && VALID_SESSION_STATES.includes(value as SessionState);
}

/**
 * Status response shape from /api/status endpoint (matches dashboard/server.py)
 * Server returns: { state, pid, statusText, currentPhase, currentTask, pendingTasks, provider, version, lokiDir, timestamp }
 */
export interface StatusApiResponse {
    state?: 'running' | 'paused' | 'stopping' | 'stopped';
    pid?: number | null;
    statusText?: string;
    currentPhase?: string;
    currentTask?: string;
    pendingTasks?: number;
    provider?: string;
    version?: string;
    lokiDir?: string;
    timestamp?: string;
    // Legacy fields for backward compatibility
    running?: boolean;
    paused?: boolean;
    status?: string;
}

/**
 * Validate and parse status response
 */
export function parseStatusResponse(data: unknown): StatusApiResponse {
    if (typeof data !== 'object' || data === null) {
        return {};
    }

    const obj = data as Record<string, unknown>;
    const result: StatusApiResponse = {};

    // New format fields (dashboard/server.py)
    if (typeof obj.state === 'string') {
        result.state = obj.state as StatusApiResponse['state'];
        // Derive legacy boolean fields for backward compatibility
        result.running = obj.state === 'running';
        result.paused = obj.state === 'paused';
    }
    if (typeof obj.pid === 'number' || obj.pid === null) {
        result.pid = obj.pid as number | null;
    }
    if (typeof obj.statusText === 'string') {
        result.statusText = obj.statusText;
        result.status = obj.statusText; // Legacy field
    }
    if (typeof obj.currentPhase === 'string') {
        result.currentPhase = obj.currentPhase;
    }
    if (typeof obj.currentTask === 'string') {
        result.currentTask = obj.currentTask;
    }
    if (typeof obj.pendingTasks === 'number') {
        result.pendingTasks = obj.pendingTasks;
    }
    if (typeof obj.provider === 'string') {
        result.provider = obj.provider;
    }
    if (typeof obj.version === 'string') {
        result.version = obj.version;
    }
    if (typeof obj.lokiDir === 'string') {
        result.lokiDir = obj.lokiDir;
    }
    if (typeof obj.timestamp === 'string') {
        result.timestamp = obj.timestamp;
    }

    // Legacy format fields (for backward compatibility)
    if (result.running === undefined && typeof obj.running === 'boolean') {
        result.running = obj.running;
    }
    if (result.paused === undefined && typeof obj.paused === 'boolean') {
        result.paused = obj.paused;
    }
    if (result.status === undefined && typeof obj.status === 'string') {
        result.status = obj.status;
    }

    return result;
}

/**
 * Health response shape from /health endpoint
 */
export interface HealthApiResponse {
    status?: string;
    version?: string;
    uptime?: number;
}

/**
 * Validate and parse health response
 */
export function parseHealthResponse(data: unknown): HealthApiResponse {
    if (typeof data !== 'object' || data === null) {
        return {};
    }

    const obj = data as Record<string, unknown>;
    return {
        status: typeof obj.status === 'string' ? obj.status : undefined,
        version: typeof obj.version === 'string' ? obj.version : undefined,
        uptime: typeof obj.uptime === 'number' ? obj.uptime : undefined
    };
}

/**
 * Tasks response shape from /tasks endpoint
 */
export interface TasksApiResponse {
    tasks?: Array<{
        id: string;
        title: string;
        description: string;
        status: TaskStatus;
        startedAt?: string;
        completedAt?: string;
    }>;
}

/**
 * Validate and parse tasks response
 */
export function parseTasksResponse(data: unknown): TasksApiResponse {
    if (typeof data !== 'object' || data === null) {
        return { tasks: [] };
    }

    const obj = data as Record<string, unknown>;

    if (!Array.isArray(obj.tasks)) {
        return { tasks: [] };
    }

    return {
        tasks: obj.tasks
            .filter((task): task is Record<string, unknown> =>
                typeof task === 'object' && task !== null
            )
            .map(task => ({
                id: typeof task.id === 'string' ? task.id : '',
                title: typeof task.title === 'string' ? task.title : '',
                description: typeof task.description === 'string' ? task.description : '',
                status: isValidTaskStatus(task.status) ? task.status : 'pending',
                startedAt: typeof task.startedAt === 'string' ? task.startedAt : undefined,
                completedAt: typeof task.completedAt === 'string' ? task.completedAt : undefined
            }))
            .filter(task => task.id && task.title)
    };
}

/**
 * Session response shape from /session endpoint
 */
export interface SessionApiResponse {
    active?: boolean;
    prdPath?: string;
    prdName?: string;
    provider?: Provider;
    phase?: string;
    startedAt?: string;
    pausedAt?: string;
    status?: SessionState | 'idle' | 'error';
    errorMessage?: string;
    currentTask?: string;
    completedTasks?: number;
    totalTasks?: number;
}

/**
 * Validate and parse session response
 */
export function parseSessionResponse(data: unknown): SessionApiResponse {
    if (typeof data !== 'object' || data === null) {
        return {};
    }

    const obj = data as Record<string, unknown>;
    const result: SessionApiResponse = {};

    // Boolean fields
    if (typeof obj.active === 'boolean') {
        result.active = obj.active;
    }

    // String fields
    if (typeof obj.prdPath === 'string') {
        result.prdPath = obj.prdPath;
    }
    if (typeof obj.prdName === 'string') {
        result.prdName = obj.prdName;
    }
    if (typeof obj.phase === 'string') {
        result.phase = obj.phase;
    }
    if (typeof obj.startedAt === 'string') {
        result.startedAt = obj.startedAt;
    }
    if (typeof obj.pausedAt === 'string') {
        result.pausedAt = obj.pausedAt;
    }
    if (typeof obj.errorMessage === 'string') {
        result.errorMessage = obj.errorMessage;
    }
    if (typeof obj.currentTask === 'string') {
        result.currentTask = obj.currentTask;
    }

    // Validated enum fields
    if (isValidProvider(obj.provider)) {
        result.provider = obj.provider;
    }
    if (typeof obj.status === 'string') {
        // Accept extended status values
        const validStatuses = [...VALID_SESSION_STATES, 'idle', 'error'];
        if (validStatuses.includes(obj.status)) {
            result.status = obj.status as SessionApiResponse['status'];
        }
    }

    // Number fields
    if (typeof obj.completedTasks === 'number') {
        result.completedTasks = obj.completedTasks;
    }
    if (typeof obj.totalTasks === 'number') {
        result.totalTasks = obj.totalTasks;
    }

    return result;
}
