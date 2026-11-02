/**
 * CLI Bridge Service
 *
 * Bridges HTTP API to existing bash CLI infrastructure.
 * Spawns loki commands and captures output for streaming.
 * Uses StateManager for centralized state access.
 */

import type { Session, SessionStatus, Task, TaskStatus } from "../types/api.ts";
import {
  eventBus,
  emitSessionEvent,
  emitPhaseEvent,
  emitTaskEvent,
  emitAgentEvent,
  emitLogEvent,
} from "./event-bus.ts";
import { StateManager, ManagedFile, type StateChange } from "../../state/manager.ts";

interface RunningProcess {
  process: Deno.ChildProcess;
  sessionId: string;
  startedAt: Date;
}

class CLIBridge {
  private lokiPath: string;
  private lokiDir: string;
  private runningProcesses: Map<string, RunningProcess> = new Map();
  private sessions: Map<string, Session> = new Map();
  private stateManager: StateManager;

  constructor() {
    // Determine loki script location
    this.lokiDir = Deno.env.get("LOKI_DIR") ||
      new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    this.lokiPath = `${this.lokiDir}/autonomy/run.sh`;
    // Initialize StateManager for state file access
    this.stateManager = new StateManager({
      lokiDir: `${this.lokiDir}/.loki`,
      enableWatch: false, // CLI bridge doesn't need watching
      enableEvents: false,
    });
  }

  /**
   * Start a new loki session
   */
  async startSession(
    prdPath?: string,
    provider: "claude" | "opencode" = "claude",
    options: { dryRun?: boolean; verbose?: boolean } = {}
  ): Promise<Session> {
    const sessionId = `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    // Build command arguments
    const args = ["start"];
    if (provider !== "claude") {
      args.push("--provider", provider);
    }
    if (options.dryRun) {
      args.push("--dry-run");
    }
    if (options.verbose) {
      args.push("--verbose");
    }
    if (prdPath) {
      args.push(prdPath);
    }

    // Create session record
    const session: Session = {
      id: sessionId,
      prdPath: prdPath || null,
      provider,
      status: "starting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: null,
      currentPhase: null,
      taskCount: 0,
      completedTasks: 0,
    };
    this.sessions.set(sessionId, session);

    // Spawn the process
    const command = new Deno.Command(this.lokiPath, {
      args,
      cwd: this.lokiDir,
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        LOKI_SESSION_ID: sessionId,
        LOKI_API_MODE: "true",
      },
    });

    const process = command.spawn();
    session.pid = process.pid;
    session.status = "running";
    session.updatedAt = new Date().toISOString();

    this.runningProcesses.set(sessionId, {
      process,
      sessionId,
      startedAt: new Date(),
    });

    // Start output streaming
    this.streamOutput(sessionId, process);

    emitSessionEvent("session:started", sessionId, {
      status: "running",
      message: `Session started with provider: ${provider}`,
    });

    return session;
  }

  /**
   * Stop a running session
   */
  async stopSession(sessionId: string): Promise<boolean> {
    const running = this.runningProcesses.get(sessionId);
    if (!running) {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "stopping";
      session.updatedAt = new Date().toISOString();
    }

    emitSessionEvent("session:stopped", sessionId, {
      status: "stopping",
      message: "Stop requested",
    });

    // Send SIGTERM to the process
    try {
      running.process.kill("SIGTERM");

      // Wait a bit, then force kill if needed
      await new Promise((resolve) => setTimeout(resolve, 5000));

      if (this.runningProcesses.has(sessionId)) {
        running.process.kill("SIGKILL");
      }
    } catch (err) {
      console.error(`Error stopping session ${sessionId}:`, err);
      return false;
    }

    if (session) {
      session.status = "stopped";
      session.updatedAt = new Date().toISOString();
    }

    this.runningProcesses.delete(sessionId);
    return true;
  }

  /**
   * Get session status
   */
  async getSession(sessionId: string): Promise<Session | null> {
    // Try memory first
    let session = this.sessions.get(sessionId);

    // Fall back to file system
    if (!session) {
      session = await this.loadSessionFromFile(sessionId);
    }

    return session || null;
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<Session[]> {
    // Combine in-memory and file-based sessions
    const sessions = new Map(this.sessions);

    // Load from .loki/sessions if exists
    try {
      const sessionsDir = `${this.lokiDir}/.loki/sessions`;
      for await (const entry of Deno.readDir(sessionsDir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          const sessionId = entry.name.replace(".json", "");
          if (!sessions.has(sessionId)) {
            const session = await this.loadSessionFromFile(sessionId);
            if (session) {
              sessions.set(sessionId, session);
            }
          }
        }
      }
    } catch {
      // Directory may not exist yet
    }

    return Array.from(sessions.values());
  }

  /**
   * Get tasks for a session
   */
  async getTasks(sessionId: string): Promise<Task[]> {
    const tasks: Task[] = [];

    try {
      // Use StateManager to read tasks file
      const data = this.stateManager.getState(`sessions/${sessionId}/tasks.json`);

      if (data && Array.isArray(data.tasks)) {
        for (const t of data.tasks as Array<Record<string, unknown>>) {
          tasks.push({
            id: (t.id as string) || `task_${tasks.length}`,
            sessionId,
            title: (t.title as string) || (t.subject as string) || "Untitled",
            description: (t.description as string) || "",
            status: this.mapTaskStatus(t.status as string),
            priority: (t.priority as number) || 0,
            createdAt: (t.createdAt as string) || new Date().toISOString(),
            startedAt: (t.startedAt as string) || null,
            completedAt: (t.completedAt as string) || null,
            agent: (t.agent as string) || null,
            output: (t.output as string) || null,
            error: (t.error as string) || null,
          });
        }
      }
    } catch {
      // Tasks file may not exist
    }

    return tasks;
  }

  /**
   * Inject human input into a running session
   */
  async injectInput(sessionId: string, input: string): Promise<boolean> {
    const running = this.runningProcesses.get(sessionId);
    if (!running) {
      return false;
    }

    // Write to input FIFO if it exists
    const inputFifo = `${this.lokiDir}/.loki/sessions/${sessionId}/input.fifo`;

    try {
      await Deno.writeTextFile(inputFifo, input + "\n");
      emitLogEvent("info", sessionId, `Human input injected: ${input.slice(0, 50)}...`);
      return true;
    } catch {
      // Try alternative: write to stdin pipe
      // Note: This requires the process to be started with stdin: "piped"
      emitLogEvent("warn", sessionId, "Input FIFO not available");
      return false;
    }
  }

  /**
   * Execute a CLI command and return output
   */
  async executeCommand(
    args: string[],
    timeout = 30000
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const command = new Deno.Command(this.lokiPath, {
      args,
      cwd: this.lokiDir,
      stdout: "piped",
      stderr: "piped",
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const output = await command.output();
      clearTimeout(timeoutId);

      return {
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
        code: output.code,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Stream process output and emit events
   */
  private async streamOutput(
    sessionId: string,
    process: Deno.ChildProcess
  ): Promise<void> {
    const session = this.sessions.get(sessionId);

    // Stream stdout
    const stdoutReader = process.stdout.getReader();
    const stderrReader = process.stderr.getReader();

    const processStream = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      isError: boolean
    ) => {
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.processOutputLine(sessionId, line, isError);
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        this.processOutputLine(sessionId, buffer, isError);
      }
    };

    // Process both streams concurrently
    Promise.all([
      processStream(stdoutReader, false),
      processStream(stderrReader, true),
    ]).then(async () => {
      // Wait for process to complete
      const status = await process.status;

      if (session) {
        session.status = status.success ? "completed" : "failed";
        session.updatedAt = new Date().toISOString();
      }

      this.runningProcesses.delete(sessionId);

      emitSessionEvent(
        status.success ? "session:completed" : "session:failed",
        sessionId,
        {
          status: status.success ? "completed" : "failed",
          exitCode: status.code,
          message: status.success ? "Session completed successfully" : "Session failed",
        }
      );
    });
  }

  /**
   * Process a single line of output and emit appropriate events
   */
  private processOutputLine(
    sessionId: string,
    line: string,
    isError: boolean
  ): void {
    // Try to parse as JSON event
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const event = JSON.parse(line);
        this.processJsonEvent(sessionId, event);
        return;
      } catch {
        // Not valid JSON, treat as log line
      }
    }

    // Parse structured log lines
    // Format: [LEVEL] [SOURCE] message
    const logMatch = line.match(/^\[(\w+)\]\s*(?:\[([^\]]+)\])?\s*(.*)$/);
    if (logMatch) {
      const [, level, source, message] = logMatch;
      const logLevel = level.toLowerCase() as "info" | "warn" | "error" | "debug";
      emitLogEvent(
        isError ? "error" : logLevel,
        sessionId,
        message,
        source
      );
      return;
    }

    // Detect phase changes
    const phaseMatch = line.match(/(?:Starting|Entering|Beginning)\s+(\w+)\s+phase/i);
    if (phaseMatch) {
      const phase = phaseMatch[1].toLowerCase();
      const session = this.sessions.get(sessionId);
      const previousPhase = session?.currentPhase;

      if (session) {
        session.currentPhase = phase as Session["currentPhase"];
        session.updatedAt = new Date().toISOString();
      }

      emitPhaseEvent("phase:started", sessionId, {
        phase,
        previousPhase: previousPhase || undefined,
      });
      return;
    }

    // Detect agent spawns
    const agentMatch = line.match(/Spawning\s+(\w+)\s+agent/i);
    if (agentMatch) {
      emitAgentEvent("agent:spawned", sessionId, {
        agentId: `agent_${Date.now()}`,
        type: agentMatch[1],
      });
      return;
    }

    // Default: emit as log
    emitLogEvent(
      isError ? "error" : "info",
      sessionId,
      line
    );
  }

  /**
   * Process structured JSON events from the CLI
   */
  private processJsonEvent(
    sessionId: string,
    event: Record<string, unknown>
  ): void {
    const type = event.type as string;
    const data = event.data || event;

    switch (type) {
      case "phase":
        emitPhaseEvent("phase:started", sessionId, data as {
          phase: string;
          previousPhase?: string;
        });
        break;

      case "task":
        emitTaskEvent(
          `task:${(data as { status: string }).status === "completed" ? "completed" : "started"}`,
          sessionId,
          data as { taskId: string; title: string; status: string }
        );
        break;

      case "agent":
        emitAgentEvent("agent:spawned", sessionId, data as {
          agentId: string;
          type: string;
        });
        break;

      default:
        // Emit as generic log
        emitLogEvent("info", sessionId, JSON.stringify(data));
    }
  }

  /**
   * Load session from file system
   */
  private async loadSessionFromFile(sessionId: string): Promise<Session | null> {
    try {
      // Use StateManager to read session file
      const data = this.stateManager.getState(`sessions/${sessionId}/session.json`);
      return data as Session | null;
    } catch {
      return null;
    }
  }

  /**
   * Map task status strings to TaskStatus
   */
  private mapTaskStatus(status: string): TaskStatus {
    const statusMap: Record<string, TaskStatus> = {
      pending: "pending",
      queued: "queued",
      "in progress": "running",
      "in_progress": "running",
      running: "running",
      done: "completed",
      completed: "completed",
      failed: "failed",
      skipped: "skipped",
    };
    return statusMap[status.toLowerCase()] || "pending";
  }
}

// Singleton instance
export const cliBridge = new CLIBridge();
