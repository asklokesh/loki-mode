/**
 * Loki Mode API Type Definitions
 *
 * Core types for the HTTP/SSE API layer
 */

// Session types
export interface Session {
  id: string;
  prdPath: string | null;
  provider: "claude" | "opencode";
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  pid: number | null;
  currentPhase: Phase | null;
  taskCount: number;
  completedTasks: number;
}

export type SessionStatus =
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed"
  | "completed";

export type Phase =
  | "bootstrap"
  | "planning"
  | "development"
  | "testing"
  | "deployment"
  | "monitoring";

// Task types
export interface Task {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  agent: string | null;
  output: string | null;
  error: string | null;
}

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

// API Request/Response types
export interface StartSessionRequest {
  prdPath?: string;
  provider?: "claude" | "opencode";
  options?: {
    dryRun?: boolean;
    verbose?: boolean;
    timeout?: number;
  };
}

export interface StartSessionResponse {
  sessionId: string;
  status: SessionStatus;
  message: string;
}

export interface SessionStatusResponse {
  session: Session;
  tasks: TaskSummary;
  agents: AgentSummary;
}

export interface TaskSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface AgentSummary {
  active: number;
  spawned: number;
  completed: number;
}

export interface InjectInputRequest {
  sessionId: string;
  input: string;
  context?: string;
}

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

// Health check
export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  providers: {
    claude: boolean;
    opencode: boolean;
  };
  activeSession: string | null;
}
