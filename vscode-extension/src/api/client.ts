/**
 * Loki Mode API Client
 * HTTP client for communicating with the Loki server
 */

import {
    ApiClientConfig,
    ApiError,
    Disposable,
    EventCallback,
    EventCallbacks,
    HealthResponse,
    InputRequest,
    LokiEvent,
    LokiEventType,
    PauseResponse,
    Provider,
    ResumeResponse,
    StartOptions,
    StartResponse,
    StatusResponse,
    StopResponse,
} from './types';
import { DEFAULT_API_BASE_URL, DEFAULT_POLLING_INTERVAL_MS } from '../utils/constants';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<ApiClientConfig> = {
    baseUrl: DEFAULT_API_BASE_URL,
    timeout: 30000,
    retryAttempts: 3,
    retryDelay: 1000,
    pollingInterval: DEFAULT_POLLING_INTERVAL_MS,
};

/**
 * Create an API error with additional context
 */
function createApiError(message: string, code: string, statusCode?: number, response?: unknown): ApiError {
    const error = new Error(message) as ApiError;
    error.code = code;
    error.statusCode = statusCode;
    error.response = response;
    error.name = 'ApiError';
    return error;
}

/**
 * Check if an error is a connection refused error
 */
function isConnectionRefusedError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        // Access cause through the error object (ES2022+)
        const errorWithCause = error as Error & { cause?: unknown };
        const cause = errorWithCause.cause;
        const causeMessage = cause instanceof Error ? cause.message.toLowerCase() : '';
        const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code;

        return (
            message.includes('econnrefused') ||
            message.includes('connection refused') ||
            message.includes('fetch failed') ||
            message.includes('network request failed') ||
            causeMessage.includes('econnrefused') ||
            causeMessage.includes('connection refused') ||
            causeCode === 'ECONNREFUSED'
        );
    }
    return false;
}

/**
 * Create a user-friendly error for connection issues
 */
function createConnectionError(): ApiError {
    return createApiError(
        'Loki Mode dashboard server is not running. Start it with "loki start" or "loki dashboard start" first.',
        'CONNECTION_REFUSED'
    );
}

/**
 * LokiApiClient - HTTP client for the Loki Mode API
 */
export class LokiApiClient {
    private readonly config: Required<ApiClientConfig>;
    private eventCallbacks: Map<string, Set<EventCallback>> = new Map();
    private typedCallbacks: Partial<EventCallbacks> = {};

    /**
     * Create a new API client
     * @param baseUrl - Base URL of the Loki server (default: http://localhost:57374)
     * @param config - Additional configuration options
     */
    constructor(baseUrl?: string, config?: Partial<Omit<ApiClientConfig, 'baseUrl'>>) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
            baseUrl: baseUrl || DEFAULT_CONFIG.baseUrl,
        };
    }

    /**
     * Get the base URL
     */
    get baseUrl(): string {
        return this.config.baseUrl;
    }

    /**
     * Make an HTTP request with retry logic
     */
    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
        options?: { retries?: number }
    ): Promise<T> {
        const url = `${this.config.baseUrl}${path}`;
        const retries = options?.retries ?? this.config.retryAttempts;

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

                const response = await fetch(url, {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorBody = await response.text();
                    let errorData: { error?: string; message?: string; code?: string } = {};
                    try {
                        errorData = JSON.parse(errorBody);
                    } catch {
                        // Response is not JSON
                    }

                    throw createApiError(
                        errorData.message || errorData.error || `HTTP ${response.status}: ${response.statusText}`,
                        errorData.code || 'HTTP_ERROR',
                        response.status,
                        errorData
                    );
                }

                // Handle empty responses
                const contentType = response.headers.get('content-type');
                if (contentType?.includes('application/json')) {
                    return await response.json() as T;
                }

                return {} as T;
            } catch (error) {
                lastError = error as Error;

                // Don't retry on client errors (4xx)
                if ((error as ApiError).statusCode && (error as ApiError).statusCode! >= 400 && (error as ApiError).statusCode! < 500) {
                    throw error;
                }

                // Don't retry on abort
                if ((error as Error).name === 'AbortError') {
                    throw createApiError('Request timeout', 'TIMEOUT', undefined, undefined);
                }

                // Don't retry on connection refused - server is not running
                if (isConnectionRefusedError(error)) {
                    throw createConnectionError();
                }

                // Retry on network errors and server errors
                if (attempt < retries) {
                    await this.delay(this.config.retryDelay * (attempt + 1));
                    continue;
                }
            }
        }

        // Check if final error is connection refused
        if (lastError && isConnectionRefusedError(lastError)) {
            throw createConnectionError();
        }

        throw lastError || createApiError('Unknown error', 'UNKNOWN');
    }

    /**
     * Delay helper for retries
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // =========================================================================
    // Health & Status
    // =========================================================================

    /**
     * Check if the server is healthy
     * @returns true if server is responding, false otherwise
     */
    async health(): Promise<boolean> {
        try {
            const response = await this.request<HealthResponse>('GET', '/health', undefined, { retries: 0 });
            return response.status === 'ok';
        } catch {
            return false;
        }
    }

    /**
     * Get detailed health information
     * @returns Health response with version and uptime
     */
    async getHealthInfo(): Promise<HealthResponse> {
        return this.request<HealthResponse>('GET', '/health');
    }

    /**
     * Get current session status
     * @returns Current session status
     */
    async getStatus(): Promise<StatusResponse> {
        return this.request<StatusResponse>('GET', '/status');
    }

    // =========================================================================
    // Session Control
    // =========================================================================

    /**
     * Start a new Loki session
     * @param prd - Path to PRD file or PRD content
     * @param provider - Provider to use (default: claude)
     * @param options - Additional start options
     * @returns Start response with session ID
     */
    async startSession(
        prd: string,
        provider: Provider = 'claude',
        options?: StartOptions
    ): Promise<StartResponse> {
        return this.request<StartResponse>('POST', '/start', {
            prd,
            provider,
            options,
        });
    }

    /**
     * Stop the current session
     * @returns Stop response with completion stats
     */
    async stopSession(): Promise<StopResponse> {
        return this.request<StopResponse>('POST', '/stop');
    }

    /**
     * Pause the current session
     * @returns Pause response with current phase
     */
    async pauseSession(): Promise<PauseResponse> {
        return this.request<PauseResponse>('POST', '/pause');
    }

    /**
     * Resume a paused session
     * @returns Resume response with current phase
     */
    async resumeSession(): Promise<ResumeResponse> {
        return this.request<ResumeResponse>('POST', '/resume');
    }

    /**
     * Inject input into the running session
     * @param input - Input string to inject
     * @param targetTask - Optional target task ID
     * @deprecated The /input endpoint is not yet implemented in dashboard/server.py
     * Use file-based input via .loki/HUMAN_INPUT.md instead
     */
    async injectInput(input: string, targetTask?: string): Promise<void> {
        console.warn('[LokiApiClient] injectInput() is deprecated - /input endpoint not implemented');
        console.warn('[LokiApiClient] Use file-based input: echo "message" > .loki/HUMAN_INPUT.md');
        const body: InputRequest = { input };
        if (targetTask) {
            body.targetTask = targetTask;
        }
        // This will fail with 404 - endpoint not implemented
        await this.request<void>('POST', '/input', body);
    }

    // =========================================================================
    // Polling-based Event Subscription (VS Code compatible)
    // Note: EventSource is not available in Node.js/VS Code extension context
    // Using polling as a reliable alternative
    // =========================================================================

    private pollingInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Subscribe to events using polling
     * @param callback - Callback function for all events
     * @returns Disposable to unsubscribe
     */
    subscribeToEvents(callback: EventCallback): Disposable {
        // Store callback
        const key = 'all';
        if (!this.eventCallbacks.has(key)) {
            this.eventCallbacks.set(key, new Set());
        }
        this.eventCallbacks.get(key)!.add(callback);

        // Start polling if not already started
        this.startPolling();

        // Return disposable
        return {
            dispose: () => {
                this.eventCallbacks.get(key)?.delete(callback);
                this.cleanupPollingIfEmpty();
            },
        };
    }

    /**
     * Subscribe to specific event types with typed callbacks
     * @param callbacks - Object mapping event types to handlers
     * @returns Disposable to unsubscribe
     */
    subscribeToTypedEvents(callbacks: Partial<EventCallbacks>): Disposable {
        // Merge callbacks
        for (const [type, handler] of Object.entries(callbacks)) {
            if (handler) {
                (this.typedCallbacks as Record<string, unknown>)[type] = handler;
            }
        }

        // Start polling if not already started
        this.startPolling();

        // Return disposable
        return {
            dispose: () => {
                for (const type of Object.keys(callbacks)) {
                    delete (this.typedCallbacks as Record<string, unknown>)[type];
                }
                this.cleanupPollingIfEmpty();
            },
        };
    }

    /**
     * Start polling for status updates
     */
    private startPolling(): void {
        if (this.pollingInterval) {
            return;
        }

        console.log('[LokiApiClient] Starting polling for status updates');

        // Poll immediately
        this.pollForEvents();

        // Then poll at regular intervals
        this.pollingInterval = setInterval(() => {
            this.pollForEvents();
        }, this.config.pollingInterval);
    }

    /**
     * Poll the server for the latest status and dispatch as events
     */
    private async pollForEvents(): Promise<void> {
        try {
            const status = await this.getStatus();

            // Create a synthetic status poll event
            const event: LokiEvent = {
                type: 'status',
                timestamp: new Date().toISOString(),
                data: status
            } as LokiEvent;

            this.dispatchEvent(event);
        } catch (error) {
            // Server might be unavailable - dispatch connection error event
            const errorEvent: LokiEvent = {
                type: 'connection:error',
                timestamp: new Date().toISOString(),
                data: {
                    message: error instanceof Error ? error.message : 'Connection error',
                    code: 'POLL_ERROR'
                }
            } as LokiEvent;
            this.dispatchEvent(errorEvent);
        }
    }

    /**
     * Dispatch an event to all registered callbacks
     */
    private dispatchEvent(event: LokiEvent): void {
        // Dispatch to generic callbacks
        const allCallbacks = this.eventCallbacks.get('all');
        if (allCallbacks) {
            for (const callback of allCallbacks) {
                try {
                    callback(event);
                } catch (error) {
                    console.error('[LokiApiClient] Event callback error:', error);
                }
            }
        }

        // Dispatch to typed callbacks
        const typedHandler = this.typedCallbacks[event.type as LokiEventType];
        if (typedHandler) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (typedHandler as (event: any) => void)(event);
            } catch (error) {
                console.error('[LokiApiClient] Typed event callback error:', error);
            }
        }
    }

    /**
     * Clean up polling if no callbacks remain
     */
    private cleanupPollingIfEmpty(): void {
        const hasGenericCallbacks = (this.eventCallbacks.get('all')?.size ?? 0) > 0;
        const hasTypedCallbacks = Object.keys(this.typedCallbacks).length > 0;

        if (!hasGenericCallbacks && !hasTypedCallbacks) {
            this.stopPolling();
        }
    }

    /**
     * Stop polling
     */
    private stopPolling(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            console.log('[LokiApiClient] Stopped polling');
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * Dispose of the client and clean up resources
     */
    dispose(): void {
        this.stopPolling();
        this.eventCallbacks.clear();
        this.typedCallbacks = {};
    }
}

/**
 * Create a new API client instance
 * @param baseUrl - Base URL of the Loki server
 * @returns New LokiApiClient instance
 */
export function createApiClient(baseUrl?: string): LokiApiClient {
    return new LokiApiClient(baseUrl);
}

/**
 * Default export - singleton instance for convenience
 */
export default LokiApiClient;
