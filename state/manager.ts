/**
 * Centralized State Manager for Loki Mode - TypeScript Implementation
 *
 * Provides unified state management with:
 * - File-based caching with chokidar for change detection
 * - Thread-safe operations with file locking
 * - Event bus integration for broadcasting changes
 * - Subscription system for reactive updates
 * - Version history with rollback capability (SYN-015)
 */

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

// Minimal surface of chokidar this module uses. Declared locally so the file
// typechecks without the optional dependency installed.
interface FileWatcher {
  on(event: "change" | "add", listener: (filePath: string) => void): FileWatcher;
  close(): unknown;
}
interface ChokidarLike {
  watch(
    paths: string,
    options: { persistent: boolean; ignoreInitial: boolean; ignored: RegExp[]; depth: number },
  ): FileWatcher;
}

// Try to import chokidar for file watching
let chokidar: ChokidarLike | null = null;
try {
  chokidar = require("chokidar");
} catch {
  // chokidar not available
}

// Try to import event bus
let EventBus: typeof import("../events/bus").EventBus | null = null;
try {
  const eventBusModule = require("../events/bus");
  EventBus = eventBusModule.EventBus;
} catch {
  // Event bus not available
}

/**
 * Managed state files
 */
export const ManagedFile = {
  ORCHESTRATOR: "state/orchestrator.json",
  AUTONOMY: "autonomy-state.json",
  QUEUE_PENDING: "queue/pending.json",
  QUEUE_IN_PROGRESS: "queue/in-progress.json",
  QUEUE_COMPLETED: "queue/completed.json",
  QUEUE_FAILED: "queue/failed.json",
  QUEUE_CURRENT: "queue/current-task.json",
  MEMORY_INDEX: "memory/index.json",
  MEMORY_TIMELINE: "memory/timeline.json",
  DASHBOARD: "dashboard-state.json",
  AGENTS: "state/agents.json",
  RESOURCES: "state/resources.json",
} as const;

export type ManagedFileType = (typeof ManagedFile)[keyof typeof ManagedFile];

/**
 * State change event
 */
export interface StateChange {
  filePath: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown>;
  timestamp: string;
  changeType: "create" | "update" | "delete";
  source: string;
}

/**
 * State change callback type
 */
export type StateCallback = (change: StateChange) => void;

/**
 * Disposable subscription
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Cache entry type
 */
interface CacheEntry {
  data: Record<string, unknown>;
  hash: string;
  mtime: number;
}

/**
 * Default version retention limit (SYN-015)
 */
export const DEFAULT_VERSION_RETENTION = 10;

/**
 * State version data (SYN-015)
 */
export interface StateVersion {
  version: number;
  timestamp: string;
  data: Record<string, unknown>;
  source: string;
  changeType: string;
}

/**
 * Version info summary (without full data) (SYN-015)
 */
export interface VersionInfo {
  version: number;
  timestamp: string;
  source: string;
  changeType: string;
  dataHash: string;
}

/**
 * Subscription filter for selective notifications (SYN-016)
 */
export interface SubscriptionFilter {
  files?: (string | ManagedFileType)[];
  changeTypes?: ("create" | "update" | "delete")[];
}

/**
 * Notification channel interface (SYN-016)
 */
export interface NotificationChannel {
  notify(change: StateChange): void;
  close(): void;
}

/**
 * File-based notification channel for CLI/scripts
 */
export class FileNotificationChannel implements NotificationChannel {
  private notificationFile: string;

  constructor(notificationFile: string) {
    this.notificationFile = notificationFile;
    const dir = path.dirname(notificationFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  notify(change: StateChange): void {
    try {
      const notification = {
        timestamp: change.timestamp,
        filePath: change.filePath,
        changeType: change.changeType,
        source: change.source,
        diff: getStateDiff(change.oldValue, change.newValue),
      };
      fs.appendFileSync(this.notificationFile, JSON.stringify(notification) + "\n");
    } catch {
      // File notification errors shouldn't break state management
    }
  }

  close(): void {
    // No cleanup needed for file channel
  }
}

/**
 * In-memory notification channel for testing
 */
export class InMemoryNotificationChannel implements NotificationChannel {
  public notifications: Array<{
    timestamp: string;
    filePath: string;
    changeType: string;
    source: string;
    oldValue: Record<string, unknown> | null;
    newValue: Record<string, unknown>;
    diff: ReturnType<typeof getStateDiff>;
  }> = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  notify(change: StateChange): void {
    const notification = {
      timestamp: change.timestamp,
      filePath: change.filePath,
      changeType: change.changeType,
      source: change.source,
      oldValue: change.oldValue,
      newValue: change.newValue,
      diff: getStateDiff(change.oldValue, change.newValue),
    };
    this.notifications.push(notification);
    if (this.notifications.length > this.maxSize) {
      this.notifications = this.notifications.slice(-this.maxSize);
    }
  }

  getNotifications(): typeof this.notifications {
    return [...this.notifications];
  }

  clear(): void {
    this.notifications = [];
  }

  close(): void {
    this.notifications = [];
  }
}

/**
 * Filtered subscriber entry
 */
interface FilteredSubscriber {
  callback: StateCallback;
  filter: SubscriptionFilter;
}

// -------------------------------------------------------------------------
// Optimistic Updates Types (SYN-014)
// -------------------------------------------------------------------------

/**
 * Conflict resolution strategies for optimistic updates
 */
export enum ConflictStrategy {
  LAST_WRITE_WINS = "last_write_wins",  // Default: latest write overwrites
  MERGE = "merge",                       // Merge compatible changes
  REJECT = "reject",                     // Reject and notify caller
}

/**
 * Version vector for tracking state versions per source
 */
export class VersionVector {
  private versions: Map<string, number>;

  constructor(data?: Record<string, number>) {
    this.versions = new Map(Object.entries(data || {}));
  }

  /**
   * Increment version for a source
   */
  increment(source: string): void {
    this.versions.set(source, (this.versions.get(source) || 0) + 1);
  }

  /**
   * Get version for a source
   */
  get(source: string): number {
    return this.versions.get(source) || 0;
  }

  /**
   * Merge two version vectors (take max of each)
   */
  merge(other: VersionVector): VersionVector {
    const merged = new VersionVector();
    const allSources = new Set([...this.versions.keys(), ...other.versions.keys()]);
    for (const source of allSources) {
      merged.versions.set(source, Math.max(this.get(source), other.get(source)));
    }
    return merged;
  }

  /**
   * Check if this vector dominates (is causally after) another
   */
  dominates(other: VersionVector): boolean {
    // Check if any source in other has a greater version
    for (const [source, version] of other.versions) {
      if (this.get(source) < version) {
        return false;
      }
    }
    // Must have at least one greater version
    for (const [source, version] of this.versions) {
      if (version > other.get(source)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if two vectors are concurrent (neither dominates)
   */
  concurrentWith(other: VersionVector): boolean {
    return !this.dominates(other) && !other.dominates(this);
  }

  /**
   * Convert to plain object
   */
  toDict(): Record<string, number> {
    return Object.fromEntries(this.versions);
  }

  /**
   * Create from plain object
   */
  static fromDict(data: Record<string, number>): VersionVector {
    return new VersionVector(data);
  }
}

/**
 * Pending optimistic update
 */
export interface PendingUpdate {
  id: string;
  key: string;
  value: unknown;
  source: string;
  timestamp: string;
  versionVector: VersionVector;
  status: "pending" | "committed" | "rejected";
}

/**
 * Information about a detected conflict
 */
export interface ConflictInfo {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
  localSource: string;
  remoteSource: string;
  localVersion: VersionVector;
  remoteVersion: VersionVector;
  resolution?: string;
  resolvedValue?: unknown;
}

/**
 * Compute MD5-like hash of data
 */
function computeHash(data: Record<string, unknown>): string {
  const content = JSON.stringify(data, Object.keys(data).sort());
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Get diff between old and new values
 */
export function getStateDiff(
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown>
): { added: Record<string, unknown>; removed: Record<string, unknown>; changed: Record<string, unknown> } {
  if (oldValue === null) {
    return { added: newValue, removed: {}, changed: {} };
  }

  const diff: { added: Record<string, unknown>; removed: Record<string, unknown>; changed: Record<string, unknown> } = {
    added: {},
    removed: {},
    changed: {},
  };

  const oldKeys = new Set(Object.keys(oldValue));
  const newKeys = new Set(Object.keys(newValue));

  // Added keys
  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      diff.added[key] = newValue[key];
    }
  }

  // Removed keys
  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      diff.removed[key] = oldValue[key];
    }
  }

  // Changed keys
  for (const key of oldKeys) {
    if (newKeys.has(key) && JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key])) {
      diff.changed[key] = {
        old: oldValue[key],
        new: newValue[key],
      };
    }
  }

  return diff;
}

/**
 * Centralized State Manager
 */
export class StateManager extends EventEmitter {
  private lokiDir: string;
  private cache: Map<string, CacheEntry>;
  private subscribers: Set<StateCallback>;
  private filteredSubscribers: FilteredSubscriber[];
  private notificationChannels: NotificationChannel[];
  private watcher: FileWatcher | null;
  private eventBus: InstanceType<typeof import("../events/bus.ts").EventBus> | null;
  private enableWatch: boolean;
  private enableEvents: boolean;

  // Optimistic updates tracking (SYN-014)
  private pendingUpdates: Map<string, PendingUpdate[]>;
  private versionVectors: Map<string, VersionVector>;
  private conflictStrategy: ConflictStrategy;

  // State versioning (SYN-015)
  private enableVersioning: boolean;
  private versionRetention: number;
  private versionCounters: Map<string, number>;

  constructor(options: {
    lokiDir?: string;
    enableWatch?: boolean;
    enableEvents?: boolean;
    enableVersioning?: boolean;
    versionRetention?: number;
  } = {}) {
    super();

    this.lokiDir = options.lokiDir || ".loki";
    this.enableWatch = options.enableWatch !== false && chokidar !== null;
    this.enableEvents = options.enableEvents !== false && EventBus !== null;
    this.enableVersioning = options.enableVersioning !== false;
    this.versionRetention = options.versionRetention ?? DEFAULT_VERSION_RETENTION;
    this.cache = new Map();
    this.subscribers = new Set();
    this.filteredSubscribers = [];
    this.notificationChannels = [];
    this.watcher = null;
    this.eventBus = null;

    // Initialize optimistic update tracking (SYN-014)
    this.pendingUpdates = new Map();
    this.versionVectors = new Map();
    this.conflictStrategy = ConflictStrategy.LAST_WRITE_WINS;

    // Initialize version counters (SYN-015)
    this.versionCounters = new Map();

    // Ensure directories exist
    this.ensureDirectories();

    // Start file watching
    if (this.enableWatch) {
      this.startWatching();
    }

    // Initialize event bus
    if (this.enableEvents && EventBus) {
      this.eventBus = new EventBus(this.lokiDir);
    }
  }

  /**
   * Ensure all required directories exist
   */
  private ensureDirectories(): void {
    const directories = [
      this.lokiDir,
      path.join(this.lokiDir, "state"),
      path.join(this.lokiDir, "state", "history"),  // Version history (SYN-015)
      path.join(this.lokiDir, "queue"),
      path.join(this.lokiDir, "memory"),
      path.join(this.lokiDir, "events"),
    ];

    for (const dir of directories) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Start file system watcher
   */
  private startWatching(): void {
    if (!chokidar) {
      return;
    }

    this.watcher = chokidar.watch(this.lokiDir, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        /(^|[/\\])\../, // dot files
        /\.lock$/,       // lock files
        /\.tmp_/,        // temp files
      ],
      depth: 3,
    });

    this.watcher.on("change", (filePath: string) => {
      this.onFileChanged(filePath);
    });

    this.watcher.on("add", (filePath: string) => {
      this.onFileChanged(filePath);
    });
  }

  /**
   * Stop the state manager
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.cache.clear();
    this.subscribers.clear();
    this.filteredSubscribers = [];

    // Close all notification channels
    for (const channel of this.notificationChannels) {
      try {
        channel.close();
      } catch {
        // Ignore close errors
      }
    }
    this.notificationChannels = [];

    this.removeAllListeners();
  }

  /**
   * Resolve file reference to absolute path
   */
  private resolvePath(fileRef: string | ManagedFileType): string {
    return path.join(this.lokiDir, fileRef);
  }

  /**
   * Read JSON file
   */
  private readFile(filePath: string): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch (err) {
      // Log error for debugging (corrupted JSON, empty files, etc.)
      console.error(`[StateManager] Error reading file ${filePath}:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Write JSON file atomically
   */
  private writeFile(filePath: string, data: Record<string, unknown>): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to temp file first
    const tempPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);

    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
      // Atomic rename
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      // Clean up temp file on error
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw err;
    }
  }

  /**
   * Get from cache if valid
   */
  private getFromCache(filePath: string): Record<string, unknown> | null {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return null;
    }

    // Check if file still exists and mtime matches
    try {
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs === entry.mtime) {
        return entry.data;
      }
    } catch {
      // File doesn't exist
    }

    return null;
  }

  /**
   * Put in cache
   */
  private putInCache(filePath: string, data: Record<string, unknown>): void {
    try {
      const stats = fs.statSync(filePath);
      this.cache.set(filePath, {
        data,
        hash: computeHash(data),
        mtime: stats.mtimeMs,
      });
    } catch {
      // Can't cache without stats
    }
  }

  /**
   * Invalidate cache entry
   */
  private invalidateCache(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Get state from a managed file
   */
  getState(
    fileRef: string | ManagedFileType,
    defaultValue: Record<string, unknown> | null = null
  ): Record<string, unknown> | null {
    const filePath = this.resolvePath(fileRef);

    // Try cache first
    const cached = this.getFromCache(filePath);
    if (cached !== null) {
      return cached;
    }

    // Read from file
    const data = this.readFile(filePath);
    if (data === null) {
      return defaultValue;
    }

    // Update cache
    this.putInCache(filePath, data);

    return data;
  }

  /**
   * Set state in a managed file
   */
  setState(
    fileRef: string | ManagedFileType,
    data: Record<string, unknown>,
    source: string = "state-manager",
    saveVersion: boolean = true
  ): StateChange {
    const filePath = this.resolvePath(fileRef);
    const relPath = typeof fileRef === "string" ? fileRef : fileRef;

    // Get old value for change tracking
    const oldValue = this.getState(fileRef);

    // Determine change type
    const changeType = oldValue === null ? "create" : "update";

    // Save version before writing new data (SYN-015)
    if (this.enableVersioning && saveVersion && oldValue !== null) {
      this.saveVersion(fileRef, oldValue, source, changeType);
    }

    // Write to file
    this.writeFile(filePath, data);

    // Update cache
    this.putInCache(filePath, data);

    // Create change object
    const change: StateChange = {
      filePath: relPath,
      oldValue,
      newValue: data,
      timestamp: new Date().toISOString(),
      changeType,
      source,
    };

    // Broadcast change
    this.broadcast(change);

    return change;
  }

  /**
   * Merge updates into existing state
   */
  updateState(
    fileRef: string | ManagedFileType,
    updates: Record<string, unknown>,
    source: string = "state-manager"
  ): StateChange {
    const current = this.getState(fileRef, {});
    const merged = { ...current, ...updates };
    return this.setState(fileRef, merged, source);
  }

  /**
   * Acquire a simple file lock using a lock file
   */
  private acquireLock(filePath: string): { release: () => void } {
    const lockPath = `${filePath}.lock`;
    const lockDir = path.dirname(lockPath);

    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    // Simple lock implementation using exclusive file creation
    let fd: number;
    const maxRetries = 50;
    const retryDelayMs = 100;

    for (let i = 0; i < maxRetries; i++) {
      try {
        fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);

        return {
          release: () => {
            try {
              fs.unlinkSync(lockPath);
            } catch {
              // Lock file may already be removed
            }
          },
        };
      } catch {
        // Lock exists, wait and retry
        if (i < maxRetries - 1) {
          const start = Date.now();
          while (Date.now() - start < retryDelayMs) {
            // Busy wait for a short time
          }
        }
      }
    }

    // Timeout - force acquire lock by removing stale lock
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }

    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);

    return {
      release: () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lock file may already be removed
        }
      },
    };
  }

  /**
   * Delete a managed state file
   */
  deleteState(
    fileRef: string | ManagedFileType,
    source: string = "state-manager"
  ): StateChange | null {
    const filePath = this.resolvePath(fileRef);
    const relPath = typeof fileRef === "string" ? fileRef : fileRef;

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const oldValue = this.getState(fileRef);

    // Acquire lock before deletion
    const lock = this.acquireLock(filePath);
    try {
      fs.unlinkSync(filePath);
    } finally {
      lock.release();
    }

    // Invalidate cache
    this.invalidateCache(filePath);

    // Create change object
    const change: StateChange = {
      filePath: relPath,
      oldValue,
      newValue: {},
      timestamp: new Date().toISOString(),
      changeType: "delete",
      source,
    };

    // Broadcast change
    this.broadcast(change);

    return change;
  }

  /**
   * Subscribe to state changes with optional filtering
   */
  subscribe(
    callback: StateCallback,
    fileFilter?: (string | ManagedFileType)[],
    changeTypes?: ("create" | "update" | "delete")[]
  ): Disposable {
    // If any filter is specified, use filtered subscribers
    if (fileFilter || changeTypes) {
      const filter: SubscriptionFilter = {
        files: fileFilter,
        changeTypes: changeTypes,
      };
      this.filteredSubscribers.push({ callback, filter });

      return {
        dispose: () => {
          this.filteredSubscribers = this.filteredSubscribers.filter(
            (sub) => sub.callback !== callback
          );
        },
      };
    }

    // No filter, use simple subscriber set
    this.subscribers.add(callback);

    return {
      dispose: () => {
        this.subscribers.delete(callback);
      },
    };
  }

  /**
   * Subscribe with a SubscriptionFilter object
   */
  subscribeFiltered(callback: StateCallback, filter: SubscriptionFilter): Disposable {
    this.filteredSubscribers.push({ callback, filter });

    return {
      dispose: () => {
        this.filteredSubscribers = this.filteredSubscribers.filter(
          (sub) => sub.callback !== callback
        );
      },
    };
  }

  /**
   * Add a notification channel for state changes
   */
  addNotificationChannel(channel: NotificationChannel): Disposable {
    this.notificationChannels.push(channel);

    return {
      dispose: () => {
        const index = this.notificationChannels.indexOf(channel);
        if (index >= 0) {
          this.notificationChannels.splice(index, 1);
          channel.close();
        }
      },
    };
  }

  /**
   * Check if a change matches a subscription filter
   */
  private matchesFilter(change: StateChange, filter: SubscriptionFilter): boolean {
    // Check file filter
    if (filter.files && filter.files.length > 0) {
      const filterPaths = new Set(filter.files);
      if (!filterPaths.has(change.filePath)) {
        return false;
      }
    }

    // Check change type filter
    if (filter.changeTypes && filter.changeTypes.length > 0) {
      if (!filter.changeTypes.includes(change.changeType)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Notify all internal subscribers
   */
  private notifySubscribers(change: StateChange): void {
    // Notify simple subscribers (no filter)
    for (const callback of this.subscribers) {
      try {
        callback(change);
      } catch {
        // Don't let one callback break others
      }
    }

    // Notify filtered subscribers
    for (const { callback, filter } of this.filteredSubscribers) {
      try {
        if (this.matchesFilter(change, filter)) {
          callback(change);
        }
      } catch {
        // Don't let one callback break others
      }
    }
  }

  /**
   * Emit state change event to the event bus
   */
  private emitStateEvent(change: StateChange): void {
    if (!this.eventBus || !this.enableEvents) {
      return;
    }

    try {
      this.eventBus.emitSimple("state", "runner", "state_changed", {
        filePath: change.filePath,
        changeType: change.changeType,
        sourceComponent: change.source,
        timestamp: change.timestamp,
        diff: getStateDiff(change.oldValue, change.newValue),
      });
    } catch {
      // Event bus errors shouldn't break state management
    }
  }

  /**
   * Notify all notification channels
   */
  private notifyChannels(change: StateChange): void {
    for (const channel of this.notificationChannels) {
      try {
        channel.notify(change);
      } catch {
        // Channel errors shouldn't break state management
      }
    }
  }

  /**
   * Broadcast a state change to all subscribers and channels
   *
   * This is the main notification method that:
   * 1. Notifies internal callback subscribers
   * 2. Emits events to the event bus
   * 3. Emits "change" event (EventEmitter)
   * 4. Sends notifications to all registered channels
   */
  private broadcast(change: StateChange): void {
    // 1. Notify internal subscribers
    this.notifySubscribers(change);

    // 2. Emit to event bus
    this.emitStateEvent(change);

    // 3. Emit EventEmitter event
    this.emit("change", change);

    // 4. Notify notification channels
    this.notifyChannels(change);
  }

  /**
   * Handle file change detected by watcher
   */
  private onFileChanged(filePath: string): void {
    // Only handle JSON files
    if (!filePath.endsWith(".json")) {
      return;
    }

    // Ignore lock files and temp files
    if (filePath.includes(".lock") || filePath.includes(".tmp_")) {
      return;
    }

    // Invalidate cache
    this.invalidateCache(filePath);

    // Read new value
    let newValue: Record<string, unknown> | null;
    try {
      newValue = this.readFile(filePath);
    } catch {
      return;
    }

    if (newValue === null) {
      return;
    }

    // Get old value from cache (if available)
    const oldEntry = this.cache.get(filePath);
    const oldValue = oldEntry ? oldEntry.data : null;

    // Update cache
    this.putInCache(filePath, newValue);

    // Create relative path
    let relPath: string;
    try {
      relPath = path.relative(this.lokiDir, filePath);
    } catch {
      relPath = filePath;
    }

    // Create and broadcast change
    const change: StateChange = {
      filePath: relPath,
      oldValue,
      newValue,
      timestamp: new Date().toISOString(),
      changeType: "update",
      source: "external",
    };

    this.broadcast(change);
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Get orchestrator state
   */
  getOrchestratorState(): Record<string, unknown> | null {
    return this.getState(ManagedFile.ORCHESTRATOR);
  }

  /**
   * Get autonomy state
   */
  getAutonomyState(): Record<string, unknown> | null {
    return this.getState(ManagedFile.AUTONOMY);
  }

  /**
   * Get queue state by type
   */
  getQueueState(queueType: string = "pending"): Record<string, unknown> | null {
    const queueMap: Record<string, ManagedFileType> = {
      pending: ManagedFile.QUEUE_PENDING,
      "in-progress": ManagedFile.QUEUE_IN_PROGRESS,
      completed: ManagedFile.QUEUE_COMPLETED,
      failed: ManagedFile.QUEUE_FAILED,
      current: ManagedFile.QUEUE_CURRENT,
    };
    const fileRef = queueMap[queueType] || ManagedFile.QUEUE_PENDING;
    return this.getState(fileRef);
  }

  /**
   * Get memory index
   */
  getMemoryIndex(): Record<string, unknown> | null {
    return this.getState(ManagedFile.MEMORY_INDEX);
  }

  /**
   * Set orchestrator state
   */
  setOrchestratorState(
    state: Record<string, unknown>,
    source: string = "orchestrator"
  ): StateChange {
    return this.setState(ManagedFile.ORCHESTRATOR, state, source);
  }

  /**
   * Set autonomy state
   */
  setAutonomyState(
    state: Record<string, unknown>,
    source: string = "autonomy"
  ): StateChange {
    return this.setState(ManagedFile.AUTONOMY, state, source);
  }

  /**
   * Update orchestrator phase
   */
  updateOrchestratorPhase(phase: string, source: string = "orchestrator"): StateChange {
    return this.updateState(
      ManagedFile.ORCHESTRATOR,
      { currentPhase: phase, lastUpdated: new Date().toISOString() },
      source
    );
  }

  /**
   * Update autonomy status
   */
  updateAutonomyStatus(status: string, source: string = "autonomy"): StateChange {
    return this.updateState(
      ManagedFile.AUTONOMY,
      { status, lastRun: new Date().toISOString() },
      source
    );
  }

  /**
   * Get all managed states
   */
  getAllStates(): Record<string, Record<string, unknown>> {
    const states: Record<string, Record<string, unknown>> = {};

    for (const [name, fileRef] of Object.entries(ManagedFile)) {
      const state = this.getState(fileRef);
      if (state !== null) {
        states[name] = state;
      }
    }

    return states;
  }

  /**
   * Refresh all cached entries from disk
   */
  refreshCache(): void {
    for (const [filePath] of this.cache) {
      if (fs.existsSync(filePath)) {
        const data = this.readFile(filePath);
        if (data) {
          this.putInCache(filePath, data);
        }
      } else {
        this.cache.delete(filePath);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Optimistic Updates (SYN-014)
  // -------------------------------------------------------------------------

  /**
   * Set the default conflict resolution strategy
   */
  setConflictStrategy(strategy: ConflictStrategy): void {
    this.conflictStrategy = strategy;
  }

  /**
   * Get the current version vector for a file
   */
  getVersionVector(fileRef: string | ManagedFileType): VersionVector {
    const filePath = this.resolvePath(fileRef);

    if (!this.versionVectors.has(filePath)) {
      // Try to load from file metadata
      const state = this.getState(fileRef);
      if (state && state._version_vector) {
        this.versionVectors.set(
          filePath,
          VersionVector.fromDict(state._version_vector as Record<string, number>)
        );
      } else {
        this.versionVectors.set(filePath, new VersionVector());
      }
    }

    return this.versionVectors.get(filePath)!;
  }

  /**
   * Apply an optimistic update immediately and queue for verification
   *
   * The update is applied to local state immediately but tracked as pending
   * until verified against the canonical state. If conflicts are detected
   * during verification, they are resolved using the configured strategy.
   */
  optimisticUpdate(
    fileRef: string | ManagedFileType,
    key: string,
    value: unknown,
    source: string = "state-manager"
  ): PendingUpdate {
    const filePath = this.resolvePath(fileRef);

    // Get current version vector and increment for this source
    const versionVector = this.getVersionVector(fileRef);
    versionVector.increment(source);

    // Create pending update
    const pending: PendingUpdate = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      key,
      value,
      source,
      timestamp: new Date().toISOString(),
      versionVector: VersionVector.fromDict(versionVector.toDict()),
      status: "pending",
    };

    // Track pending update
    if (!this.pendingUpdates.has(filePath)) {
      this.pendingUpdates.set(filePath, []);
    }
    this.pendingUpdates.get(filePath)!.push(pending);

    // Apply optimistically to local state
    const currentState = this.getState(fileRef, {}) || {};
    currentState[key] = value;
    currentState._version_vector = versionVector.toDict();
    currentState._last_source = source;
    currentState._last_updated = pending.timestamp;

    // Write state with version tracking
    this.writeFile(filePath, currentState);
    this.putInCache(filePath, currentState);

    return pending;
  }

  /**
   * Get all pending updates for a file
   */
  getPendingUpdates(fileRef: string | ManagedFileType): PendingUpdate[] {
    const filePath = this.resolvePath(fileRef);
    return this.pendingUpdates.get(filePath) || [];
  }

  /**
   * Detect conflicts between local pending updates and remote state
   */
  detectConflicts(
    fileRef: string | ManagedFileType,
    remoteState: Record<string, unknown>,
    remoteSource: string
  ): ConflictInfo[] {
    const filePath = this.resolvePath(fileRef);
    const conflicts: ConflictInfo[] = [];
    const pending = this.pendingUpdates.get(filePath) || [];

    if (pending.length === 0) {
      return conflicts;
    }

    // Get remote version vector
    let remoteVv = new VersionVector();
    if (remoteState._version_vector) {
      remoteVv = VersionVector.fromDict(remoteState._version_vector as Record<string, number>);
    }

    const localState = this.getState(fileRef, {}) || {};

    // Check each pending update for conflicts
    for (const update of pending) {
      if (update.status !== "pending") {
        continue;
      }

      const key = update.key;

      // Check if same key was modified in remote state
      if (key in remoteState && key in localState) {
        const localVal = localState[key];
        const remoteVal = remoteState[key];

        // Only conflict if values differ and versions are concurrent
        if (JSON.stringify(localVal) !== JSON.stringify(remoteVal)) {
          if (update.versionVector.concurrentWith(remoteVv)) {
            conflicts.push({
              key,
              localValue: localVal,
              remoteValue: remoteVal,
              localSource: update.source,
              remoteSource,
              localVersion: update.versionVector,
              remoteVersion: remoteVv,
            });
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Resolve conflicts using the specified strategy
   */
  resolveConflicts(
    fileRef: string | ManagedFileType,
    conflicts: ConflictInfo[],
    strategy?: ConflictStrategy
  ): Record<string, unknown> {
    const resolveStrategy = strategy || this.conflictStrategy;
    const filePath = this.resolvePath(fileRef);

    const localState = this.getState(fileRef, {}) || {};
    const resolvedState = { ...localState };

    for (const conflict of conflicts) {
      if (resolveStrategy === ConflictStrategy.LAST_WRITE_WINS) {
        // Use remote value (assuming remote is more recent)
        resolvedState[conflict.key] = conflict.remoteValue;
        conflict.resolution = "last_write_wins";
        conflict.resolvedValue = conflict.remoteValue;
      } else if (resolveStrategy === ConflictStrategy.MERGE) {
        // Attempt to merge values
        const merged = this.mergeValues(
          conflict.localValue,
          conflict.remoteValue
        );
        resolvedState[conflict.key] = merged;
        conflict.resolution = "merged";
        conflict.resolvedValue = merged;
      } else if (resolveStrategy === ConflictStrategy.REJECT) {
        // Keep local value, mark conflict as rejected
        conflict.resolution = "rejected";
        conflict.resolvedValue = conflict.localValue;
        // Mark pending updates for this key as rejected
        const pending = this.pendingUpdates.get(filePath) || [];
        for (const update of pending) {
          if (update.key === conflict.key && update.status === "pending") {
            update.status = "rejected";
          }
        }
      }
    }

    // Merge version vectors
    let localVv = this.getVersionVector(fileRef);
    for (const conflict of conflicts) {
      localVv = localVv.merge(conflict.remoteVersion);
    }

    resolvedState._version_vector = localVv.toDict();
    this.versionVectors.set(filePath, localVv);

    return resolvedState;
  }

  /**
   * Attempt to merge two values
   *
   * For objects, performs a deep merge.
   * For arrays, concatenates and deduplicates.
   * For other types, prefers remote value.
   */
  private mergeValues(local: unknown, remote: unknown): unknown {
    if (
      typeof local === "object" &&
      typeof remote === "object" &&
      local !== null &&
      remote !== null &&
      !Array.isArray(local) &&
      !Array.isArray(remote)
    ) {
      const merged: Record<string, unknown> = { ...(local as Record<string, unknown>) };
      for (const [key, value] of Object.entries(remote as Record<string, unknown>)) {
        if (key in merged) {
          merged[key] = this.mergeValues(merged[key], value);
        } else {
          merged[key] = value;
        }
      }
      return merged;
    }

    if (Array.isArray(local) && Array.isArray(remote)) {
      // Concatenate and deduplicate (preserving order)
      const seen = new Set<string>();
      const merged: unknown[] = [];
      for (const item of [...local, ...remote]) {
        const itemKey = JSON.stringify(item);
        if (!seen.has(itemKey)) {
          seen.add(itemKey);
          merged.push(item);
        }
      }
      return merged;
    }

    // For scalars, prefer remote
    return remote;
  }

  /**
   * Commit all pending updates for a file
   */
  commitPendingUpdates(fileRef: string | ManagedFileType): number {
    const filePath = this.resolvePath(fileRef);
    const pending = this.pendingUpdates.get(filePath) || [];
    let committed = 0;

    for (const update of pending) {
      if (update.status === "pending") {
        update.status = "committed";
        committed++;
      }
    }

    // Clear committed updates
    this.pendingUpdates.set(
      filePath,
      pending.filter((u) => u.status !== "committed")
    );

    return committed;
  }

  /**
   * Rollback pending updates and restore original state
   */
  rollbackPendingUpdates(
    fileRef: string | ManagedFileType,
    originalState: Record<string, unknown>
  ): number {
    const filePath = this.resolvePath(fileRef);
    const pending = this.pendingUpdates.get(filePath) || [];
    let rolledBack = 0;

    for (const update of pending) {
      if (update.status === "pending") {
        update.status = "rejected";
        rolledBack++;
      }
    }

    // Restore original state
    this.setState(fileRef, originalState, "rollback");

    // Clear pending updates
    this.pendingUpdates.set(filePath, []);

    return rolledBack;
  }

  /**
   * Synchronize local state with remote state, resolving conflicts
   *
   * This is a high-level operation that:
   * 1. Detects conflicts between local pending updates and remote state
   * 2. Resolves conflicts using the specified strategy
   * 3. Commits or rejects pending updates accordingly
   * 4. Returns the final synchronized state
   */
  syncWithRemote(
    fileRef: string | ManagedFileType,
    remoteState: Record<string, unknown>,
    remoteSource: string,
    strategy?: ConflictStrategy
  ): {
    resolvedState: Record<string, unknown>;
    conflicts: ConflictInfo[];
    committed: number;
  } {
    // Detect conflicts
    const conflicts = this.detectConflicts(fileRef, remoteState, remoteSource);

    // Resolve conflicts
    const resolvedState = this.resolveConflicts(fileRef, conflicts, strategy);

    // Apply resolved state
    this.setState(fileRef, resolvedState, "sync");

    // Commit pending updates (non-rejected ones)
    const committed = this.commitPendingUpdates(fileRef);

    return { resolvedState, conflicts, committed };
  }

  // -------------------------------------------------------------------------
  // State Versioning (SYN-015)
  // -------------------------------------------------------------------------

  /**
   * Get a safe key for the file reference (used in history paths)
   */
  private getFileKey(fileRef: string | ManagedFileType): string {
    const relPath = typeof fileRef === "string" ? fileRef : fileRef;
    return relPath.replace(/\//g, "_").replace(/\\/g, "_").replace(".json", "");
  }

  /**
   * Get the history directory for a file reference
   */
  private getHistoryDir(fileRef: string | ManagedFileType): string {
    const fileKey = this.getFileKey(fileRef);
    return path.join(this.lokiDir, "state", "history", fileKey);
  }

  /**
   * Get the next version number for a file
   */
  private getNextVersion(fileRef: string | ManagedFileType): number {
    const fileKey = this.getFileKey(fileRef);
    if (!this.versionCounters.has(fileKey)) {
      // Initialize from existing versions on disk
      const historyDir = this.getHistoryDir(fileRef);
      if (fs.existsSync(historyDir)) {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith(".json"));
        if (files.length > 0) {
          let maxVersion = 0;
          for (const f of files) {
            const version = parseInt(path.basename(f, ".json"), 10);
            if (!isNaN(version) && version > maxVersion) {
              maxVersion = version;
            }
          }
          this.versionCounters.set(fileKey, maxVersion);
        } else {
          this.versionCounters.set(fileKey, 0);
        }
      } else {
        this.versionCounters.set(fileKey, 0);
      }
    }
    const current = this.versionCounters.get(fileKey) || 0;
    this.versionCounters.set(fileKey, current + 1);
    return current + 1;
  }

  /**
   * Save a version of the state to history
   */
  private saveVersion(
    fileRef: string | ManagedFileType,
    data: Record<string, unknown>,
    source: string,
    changeType: string
  ): number {
    const historyDir = this.getHistoryDir(fileRef);
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    const version = this.getNextVersion(fileRef);
    const timestamp = new Date().toISOString();

    const versionData: StateVersion = {
      version,
      timestamp,
      data,
      source,
      changeType,
    };

    const versionPath = path.join(historyDir, `${version}.json`);
    this.writeFile(versionPath, versionData as unknown as Record<string, unknown>);

    // Clean up old versions
    this.cleanupOldVersions(fileRef);

    return version;
  }

  /**
   * Remove versions beyond the retention limit
   */
  private cleanupOldVersions(fileRef: string | ManagedFileType): void {
    const historyDir = this.getHistoryDir(fileRef);
    if (!fs.existsSync(historyDir)) {
      return;
    }

    const files = fs.readdirSync(historyDir).filter(f => f.endsWith(".json"));
    if (files.length <= this.versionRetention) {
      return;
    }

    // Sort by version number and remove oldest
    const versionFiles = files
      .map(f => ({ file: f, version: parseInt(path.basename(f, ".json"), 10) }))
      .filter(v => !isNaN(v.version))
      .sort((a, b) => a.version - b.version);

    const toRemove = versionFiles.slice(0, versionFiles.length - this.versionRetention);
    for (const { file } of toRemove) {
      try {
        fs.unlinkSync(path.join(historyDir, file));
      } catch {
        // Ignore removal errors
      }
    }
  }

  /**
   * Get version history for a state file
   */
  getVersionHistory(fileRef: string | ManagedFileType): VersionInfo[] {
    const historyDir = this.getHistoryDir(fileRef);
    if (!fs.existsSync(historyDir)) {
      return [];
    }

    const versions: VersionInfo[] = [];
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith(".json"));

    for (const file of files) {
      try {
        const versionNum = parseInt(path.basename(file, ".json"), 10);
        if (isNaN(versionNum)) continue;

        const versionPath = path.join(historyDir, file);
        const data = this.readFile(versionPath);
        if (data) {
          const versionEntry = data as unknown as StateVersion;
          versions.push({
            version: versionNum,
            timestamp: versionEntry.timestamp || "",
            source: versionEntry.source || "unknown",
            changeType: versionEntry.changeType || "update",
            dataHash: computeHash(versionEntry.data || {}),
          });
        }
      } catch {
        // Skip invalid version files
      }
    }

    // Sort by version descending (newest first)
    versions.sort((a, b) => b.version - a.version);
    return versions;
  }

  /**
   * Get state data at a specific version without restoring
   */
  getStateAtVersion(
    fileRef: string | ManagedFileType,
    version: number
  ): Record<string, unknown> | null {
    const historyDir = this.getHistoryDir(fileRef);
    const versionPath = path.join(historyDir, `${version}.json`);

    if (!fs.existsSync(versionPath)) {
      return null;
    }

    const versionData = this.readFile(versionPath);
    if (versionData) {
      const versionEntry = versionData as unknown as StateVersion;
      return versionEntry.data || null;
    }
    return null;
  }

  /**
   * Restore state to a specific version
   */
  rollback(
    fileRef: string | ManagedFileType,
    version: number,
    source: string = "rollback"
  ): StateChange | null {
    const data = this.getStateAtVersion(fileRef, version);
    if (data === null) {
      return null;
    }

    // Save current state as a version before rollback
    const current = this.getState(fileRef);
    if (current !== null && this.enableVersioning) {
      this.saveVersion(fileRef, current, source, "pre_rollback");
    }

    // Set the restored state (saveVersion=false since we already saved)
    return this.setState(fileRef, data, source, false);
  }

  /**
   * Get the number of versions stored for a file
   */
  getVersionCount(fileRef: string | ManagedFileType): number {
    const historyDir = this.getHistoryDir(fileRef);
    if (!fs.existsSync(historyDir)) {
      return 0;
    }
    return fs.readdirSync(historyDir).filter(f => f.endsWith(".json")).length;
  }

  /**
   * Clear all version history for a file
   */
  clearVersionHistory(fileRef: string | ManagedFileType): number {
    const historyDir = this.getHistoryDir(fileRef);
    if (!fs.existsSync(historyDir)) {
      return 0;
    }

    const files = fs.readdirSync(historyDir).filter(f => f.endsWith(".json"));
    let count = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(historyDir, file));
        count++;
      } catch {
        // Ignore removal errors
      }
    }

    // Reset version counter
    const fileKey = this.getFileKey(fileRef);
    this.versionCounters.delete(fileKey);

    return count;
  }

  /**
   * Update the version retention limit
   */
  setVersionRetention(retention: number): void {
    if (retention < 1) {
      throw new Error("Version retention must be at least 1");
    }
    this.versionRetention = retention;
  }
}

// Managers are cached per .loki directory, keyed by that directory's (st_dev, st_ino) rather than its path
// string, so two spellings of one directory (symlink, or case on a case-insensitive volume) share one manager
// and a second root never receives the first root's manager. The cache holds at most LOKI_STATE_MANAGER_MAX
// (default 8) managers; the least recently used one past the cap is stop()ped and dropped, which closes its
// watcher. A caller still holding an evicted manager holds a stopped one; asking again returns a fresh one.
// The Python manager (state/manager.py) is to follow the same rule. Options other than lokiDir apply only to
// the call that creates the manager for a root.
const DEFAULT_MAX_STATE_MANAGERS = 8;
const managers = new Map<string, StateManager>();

function maxStateManagers(): number {
  const n = Number.parseInt(process.env["LOKI_STATE_MANAGER_MAX"] ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_STATE_MANAGERS;
}

function stateRootKey(lokiDir: string): string {
  const abs = path.resolve(lokiDir);
  fs.mkdirSync(abs, { recursive: true });
  const st = fs.statSync(abs);
  return `${st.dev}:${st.ino}`;
}

/**
 * Get the state manager for a .loki directory (default ".loki" under the current directory).
 */
export function getStateManager(options?: {
  lokiDir?: string;
  enableWatch?: boolean;
  enableEvents?: boolean;
  enableVersioning?: boolean;
  versionRetention?: number;
}): StateManager {
  const key = stateRootKey(options?.lokiDir || ".loki");
  const existing = managers.get(key);
  if (existing) {
    managers.delete(key); // re-insert to mark most recently used
    managers.set(key, existing);
    return existing;
  }
  const created = new StateManager(options);
  managers.set(key, created);
  const cap = maxStateManagers();
  while (managers.size > cap) {
    const oldest = managers.keys().next().value as string;
    const evicted = managers.get(oldest);
    managers.delete(oldest);
    evicted?.stop();
  }
  return created;
}

/**
 * Reset every cached state manager (for testing)
 */
export function resetStateManager(): void {
  for (const m of managers.values()) m.stop();
  managers.clear();
}
