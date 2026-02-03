/**
 * Loki Mode Event Bus - TypeScript Implementation
 *
 * Cross-process event propagation using file-based pub/sub.
 * Compatible with the Python implementation.
 */

import * as fs from "fs";
import * as path from "path";

// Event types
export type EventType =
  | "state"
  | "memory"
  | "task"
  | "metric"
  | "error"
  | "session"
  | "command"
  | "user";

// Event sources
export type EventSource =
  | "cli"
  | "api"
  | "vscode"
  | "mcp"
  | "skill"
  | "hook"
  | "dashboard"
  | "memory"
  | "runner";

/**
 * Loki Mode Event
 */
export interface LokiEvent {
  id: string;
  type: EventType;
  source: EventSource;
  timestamp: string;
  payload: Record<string, unknown>;
  version: string;
}

/**
 * Event subscription callback
 */
export type EventCallback = (event: LokiEvent) => void;

/**
 * Disposable subscription
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Generate a short unique ID
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Get current ISO timestamp
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * File-based Event Bus
 */
export class EventBus {
  private lokiDir: string;
  private eventsDir: string;
  private pendingDir: string;
  private archiveDir: string;
  private processedFile: string;
  private processedIds: Set<string>;
  private subscribers: Array<{ types: EventType[] | null; callback: EventCallback }>;
  private running: boolean;
  private pollInterval: NodeJS.Timer | null;

  constructor(lokiDir: string = ".loki") {
    this.lokiDir = lokiDir;
    this.eventsDir = path.join(lokiDir, "events");
    this.pendingDir = path.join(this.eventsDir, "pending");
    this.archiveDir = path.join(this.eventsDir, "archive");
    this.processedFile = path.join(this.eventsDir, "processed.json");
    this.processedIds = new Set();
    this.subscribers = [];
    this.running = false;
    this.pollInterval = null;

    // Ensure directories exist
    this.ensureDirectories();

    // Load processed IDs
    this.loadProcessedIds();
  }

  private ensureDirectories(): void {
    [this.eventsDir, this.pendingDir, this.archiveDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private loadProcessedIds(): void {
    try {
      if (fs.existsSync(this.processedFile)) {
        const data = JSON.parse(fs.readFileSync(this.processedFile, "utf-8"));
        const ids = data.ids || [];
        // Keep only last 1000
        this.processedIds = new Set(ids.slice(-1000));
      }
    } catch {
      this.processedIds = new Set();
    }
  }

  private saveProcessedId(eventId: string): void {
    this.processedIds.add(eventId);

    // Prune to last 1000
    if (this.processedIds.size > 1000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(-1000));
    }

    try {
      fs.writeFileSync(
        this.processedFile,
        JSON.stringify({ ids: Array.from(this.processedIds) })
      );
    } catch {
      // Ignore write errors
    }
  }

  /**
   * Emit an event to the bus
   */
  emit(event: Partial<LokiEvent> & { type: EventType; source: EventSource }): string {
    const fullEvent: LokiEvent = {
      id: event.id || generateId(),
      type: event.type,
      source: event.source,
      timestamp: event.timestamp || getTimestamp(),
      payload: event.payload || {},
      version: event.version || "1.0",
    };

    const filename = `${fullEvent.timestamp.replace(/:/g, "-")}_${fullEvent.id}.json`;
    const filepath = path.join(this.pendingDir, filename);

    try {
      fs.writeFileSync(filepath, JSON.stringify(fullEvent, null, 2));
    } catch (e) {
      throw new Error(`Failed to emit event: ${e}`);
    }

    return fullEvent.id;
  }

  /**
   * Simplified event emission
   */
  emitSimple(
    type: EventType,
    source: EventSource,
    action: string,
    extra: Record<string, unknown> = {}
  ): string {
    return this.emit({
      type,
      source,
      payload: { action, ...extra },
    });
  }

  /**
   * Get pending events
   */
  getPendingEvents(
    types?: EventType[],
    since?: string
  ): LokiEvent[] {
    const events: LokiEvent[] = [];

    try {
      const files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json"));
      files.sort();

      for (const file of files) {
        try {
          const filepath = path.join(this.pendingDir, file);
          const data = JSON.parse(fs.readFileSync(filepath, "utf-8")) as LokiEvent;

          // Filter by type
          if (types && !types.includes(data.type)) {
            continue;
          }

          // Filter by time
          if (since && data.timestamp < since) {
            continue;
          }

          // Skip processed
          if (this.processedIds.has(data.id)) {
            continue;
          }

          events.push(data);
        } catch {
          continue;
        }
      }
    } catch {
      // Directory might not exist
    }

    return events;
  }

  /**
   * Mark an event as processed
   */
  markProcessed(event: LokiEvent, archive: boolean = true): void {
    this.saveProcessedId(event.id);

    if (archive) {
      try {
        const files = fs.readdirSync(this.pendingDir).filter((f) => f.includes(event.id));
        for (const file of files) {
          const src = path.join(this.pendingDir, file);
          const dst = path.join(this.archiveDir, file);
          fs.renameSync(src, dst);
        }
      } catch {
        // Ignore errors
      }
    }
  }

  /**
   * Subscribe to events with a callback
   */
  subscribe(callback: EventCallback, types?: EventType[]): Disposable {
    const sub = { types: types || null, callback };
    this.subscribers.push(sub);

    return {
      dispose: () => {
        const idx = this.subscribers.indexOf(sub);
        if (idx >= 0) {
          this.subscribers.splice(idx, 1);
        }
      },
    };
  }

  /**
   * Start background event processing
   */
  startProcessing(intervalMs: number = 500): void {
    if (this.running) {
      return;
    }

    this.running = true;

    const process = () => {
      if (!this.running) {
        return;
      }

      const events = this.getPendingEvents();
      for (const event of events) {
        for (const sub of this.subscribers) {
          if (sub.types === null || sub.types.includes(event.type)) {
            try {
              sub.callback(event);
            } catch {
              // Don't let one callback break others
            }
          }
        }
        this.markProcessed(event);
      }
    };

    this.pollInterval = setInterval(process, intervalMs);
  }

  /**
   * Stop background processing
   */
  stopProcessing(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get event history from archive
   */
  getHistory(types?: EventType[], limit: number = 100): LokiEvent[] {
    const events: LokiEvent[] = [];

    try {
      const files = fs.readdirSync(this.archiveDir).filter((f) => f.endsWith(".json"));
      files.sort().reverse();

      for (const file of files) {
        if (events.length >= limit) {
          break;
        }

        try {
          const filepath = path.join(this.archiveDir, file);
          const data = JSON.parse(fs.readFileSync(filepath, "utf-8")) as LokiEvent;

          if (types && !types.includes(data.type)) {
            continue;
          }

          events.push(data);
        } catch {
          continue;
        }
      }
    } catch {
      // Directory might not exist
    }

    return events;
  }

  /**
   * Clear all pending events
   */
  clearPending(): number {
    let count = 0;
    try {
      const files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.pendingDir, file));
          count++;
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
    return count;
  }
}

// Convenience functions

/**
 * Emit a session event
 */
export function emitSessionEvent(
  source: EventSource,
  action: string,
  extra: Record<string, unknown> = {}
): string {
  const bus = new EventBus();
  return bus.emitSimple("session", source, action, extra);
}

/**
 * Emit a task event
 */
export function emitTaskEvent(
  source: EventSource,
  action: string,
  taskId: string,
  extra: Record<string, unknown> = {}
): string {
  const bus = new EventBus();
  return bus.emitSimple("task", source, action, { taskId, ...extra });
}

/**
 * Emit a state event
 */
export function emitStateEvent(
  source: EventSource,
  action: string,
  extra: Record<string, unknown> = {}
): string {
  const bus = new EventBus();
  return bus.emitSimple("state", source, action, extra);
}

/**
 * Emit an error event
 */
export function emitErrorEvent(
  source: EventSource,
  error: string,
  extra: Record<string, unknown> = {}
): string {
  const bus = new EventBus();
  return bus.emitSimple("error", source, "error", { error, ...extra });
}
