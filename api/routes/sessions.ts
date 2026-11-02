/**
 * Session Routes
 *
 * REST endpoints for session management.
 *
 * Emits learning signals:
 * - UserPreferenceSignal on provider selection
 * - SuccessPatternSignal on successful session operations
 * - ErrorPatternSignal on session failures
 */

import { cliBridge } from "../services/cli-bridge.ts";
import { learningCollector } from "../services/learning-collector.ts";
import type {
  StartSessionRequest,
  StartSessionResponse,
  SessionStatusResponse,
} from "../types/api.ts";
import {
  LokiApiError,
  ErrorCodes,
  validateBody,
  successResponse,
} from "../middleware/error.ts";

// Restated from loki-ts/src/runner/types.ts (VALID_PROVIDERS, REMOVED_PROVIDERS, removedProviderMessage);
// api/ ships without loki-ts/src, so it cannot import them. Keep the message byte-identical.
const SUPPORTED_PROVIDERS: string[] = ["claude", "opencode"];
const REMOVED_PROVIDERS: string[] = ["codex", "cline", "aider", "gemini"];
const removedProviderMessage = (provider: string): string =>
  `loki: provider '${provider}' is no longer supported. Supported providers: claude (Claude Code CLI, or an Anthropic API key through the Agent SDK) and opencode (any model, including OpenRouter via OPENROUTER_API_KEY). Switch with --provider claude or --provider opencode, or unset LOKI_PROVIDER.`;

/**
 * POST /api/sessions - Start a new session
 */
export async function startSession(req: Request): Promise<Response> {
  const startTime = Date.now();
  const body = await req.json().catch(() => ({}));

  const data = validateBody<StartSessionRequest>(body, [], [
    "prdPath",
    "provider",
    "options",
  ]);

  // Validate provider
  const provider = data.provider || "claude";
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new LokiApiError(
      REMOVED_PROVIDERS.includes(provider)
        ? removedProviderMessage(provider)
        : `Invalid provider: ${provider}. Must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  // Emit user preference signal for provider selection
  learningCollector.emitUserPreference(
    "session_start",
    "provider",
    provider,
    {
      alternativesRejected: SUPPORTED_PROVIDERS.filter((p) => p !== provider),
      context: {
        hasPrd: !!data.prdPath,
        options: data.options,
      },
    }
  );

  // Check for existing running session
  const sessions = await cliBridge.listSessions();
  const running = sessions.find(
    (s) => s.status === "running" || s.status === "starting"
  );

  if (running) {
    learningCollector.emitSessionOperation("start", running.id, false, {
      provider,
      errorMessage: "Session already running",
    });
    throw new LokiApiError(
      `Session already running: ${running.id}`,
      ErrorCodes.SESSION_ALREADY_RUNNING,
      { sessionId: running.id }
    );
  }

  // Start new session
  const session = await cliBridge.startSession(
    data.prdPath,
    provider,
    data.options
  );

  // Emit success signal
  learningCollector.emitSessionOperation("start", session.id, true, {
    provider,
    durationMs: Date.now() - startTime,
    context: {
      prdPath: data.prdPath,
      options: data.options,
    },
  });

  const response: StartSessionResponse = {
    sessionId: session.id,
    status: session.status,
    message: `Session started with provider: ${provider}`,
  };

  return successResponse(response, 201);
}

/**
 * GET /api/sessions - List all sessions
 */
export async function listSessions(_req: Request): Promise<Response> {
  const sessions = await cliBridge.listSessions();

  return successResponse({
    sessions,
    total: sessions.length,
    running: sessions.filter((s) => s.status === "running").length,
  });
}

/**
 * GET /api/sessions/:id - Get session details
 */
export async function getSession(
  _req: Request,
  sessionId: string
): Promise<Response> {
  const session = await cliBridge.getSession(sessionId);

  if (!session) {
    throw new LokiApiError(
      `Session not found: ${sessionId}`,
      ErrorCodes.SESSION_NOT_FOUND
    );
  }

  const tasks = await cliBridge.getTasks(sessionId);

  const response: SessionStatusResponse = {
    session,
    tasks: {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    },
    agents: {
      active: 0, // TODO: Track from state
      spawned: 0,
      completed: 0,
    },
  };

  return successResponse(response);
}

/**
 * POST /api/sessions/:id/stop - Stop a session
 */
export async function stopSession(
  _req: Request,
  sessionId: string
): Promise<Response> {
  const startTime = Date.now();
  const session = await cliBridge.getSession(sessionId);

  if (!session) {
    learningCollector.emitSessionOperation("stop", sessionId, false, {
      errorMessage: "Session not found",
    });
    throw new LokiApiError(
      `Session not found: ${sessionId}`,
      ErrorCodes.SESSION_NOT_FOUND
    );
  }

  if (session.status !== "running" && session.status !== "starting") {
    learningCollector.emitSessionOperation("stop", sessionId, false, {
      errorMessage: `Session is not running: ${session.status}`,
      context: { currentStatus: session.status },
    });
    throw new LokiApiError(
      `Session is not running: ${session.status}`,
      ErrorCodes.CONFLICT
    );
  }

  const stopped = await cliBridge.stopSession(sessionId);

  if (!stopped) {
    learningCollector.emitSessionOperation("stop", sessionId, false, {
      errorMessage: "Failed to stop session",
      durationMs: Date.now() - startTime,
    });
    throw new LokiApiError(
      "Failed to stop session",
      ErrorCodes.INTERNAL_ERROR
    );
  }

  // Emit success signal
  learningCollector.emitSessionOperation("stop", sessionId, true, {
    provider: session.provider,
    durationMs: Date.now() - startTime,
    context: {
      previousStatus: session.status,
    },
  });

  return successResponse({
    sessionId,
    status: "stopping",
    message: "Stop signal sent",
  });
}

/**
 * POST /api/sessions/:id/pause - Pause a session
 */
export async function pauseSession(
  _req: Request,
  sessionId: string
): Promise<Response> {
  // TODO: Implement pause functionality in CLI
  throw new LokiApiError(
    "Pause not yet implemented",
    ErrorCodes.NOT_IMPLEMENTED
  );
}

/**
 * POST /api/sessions/:id/resume - Resume a session
 */
export async function resumeSession(
  _req: Request,
  sessionId: string
): Promise<Response> {
  // TODO: Implement resume functionality in CLI
  throw new LokiApiError(
    "Resume not yet implemented",
    ErrorCodes.NOT_IMPLEMENTED
  );
}

/**
 * POST /api/sessions/:id/input - Inject human input
 */
export async function injectInput(
  req: Request,
  sessionId: string
): Promise<Response> {
  const session = await cliBridge.getSession(sessionId);

  if (!session) {
    throw new LokiApiError(
      `Session not found: ${sessionId}`,
      ErrorCodes.SESSION_NOT_FOUND
    );
  }

  if (session.status !== "running") {
    throw new LokiApiError(
      `Session is not running: ${session.status}`,
      ErrorCodes.CONFLICT
    );
  }

  const body = await req.json();
  const data = validateBody<{ input: string; context?: string }>(
    body,
    ["input"],
    ["context"]
  );

  const injected = await cliBridge.injectInput(sessionId, data.input);

  if (!injected) {
    throw new LokiApiError(
      "Failed to inject input - session may not be accepting input",
      ErrorCodes.CONFLICT
    );
  }

  return successResponse({
    sessionId,
    message: "Input injected successfully",
  });
}

/**
 * DELETE /api/sessions/:id - Delete a session record
 */
export async function deleteSession(
  _req: Request,
  sessionId: string
): Promise<Response> {
  const session = await cliBridge.getSession(sessionId);

  if (!session) {
    throw new LokiApiError(
      `Session not found: ${sessionId}`,
      ErrorCodes.SESSION_NOT_FOUND
    );
  }

  if (session.status === "running" || session.status === "starting") {
    throw new LokiApiError(
      "Cannot delete running session. Stop it first.",
      ErrorCodes.CONFLICT
    );
  }

  // TODO: Implement deletion in CLI bridge
  // For now, just acknowledge
  return successResponse({
    sessionId,
    message: "Session deleted",
  });
}
