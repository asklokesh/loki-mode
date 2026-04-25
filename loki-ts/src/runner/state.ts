// State persistence for the autonomous runner.
//
// Source-of-truth (bash):
//   save_state()             autonomy/run.sh:8731-8754  (atomic .tmp.$$ + mv)
//   load_state()             autonomy/run.sh:8757-8818  (validation, corrupt-backup,
//                                                       orphan tmp cleanup)
//   orchestrator.json shape  autonomy/run.sh:3079-3092  (initial write)
//   provider state file      autonomy/run.sh:3525-3528  (single-line provider name)
//
// Schema preservation contract: docs/phase4-research/dashboard_schema_contract.md.
// The dashboard reads .loki/state/orchestrator.json (currentPhase, iteration,
// complexity, metrics.{tasksCompleted,tasksFailed}) and .loki/state/provider on
// every refresh -- field renames or type changes here will break it.
//
// This module is library-only. It does NOT mutate process.env, it does NOT
// emit colored output, and it never throws on missing files (load_state in
// bash treats absent state as "fresh start", we mirror that).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lokiDir } from "../util/paths.ts";

// --- public types ----------------------------------------------------------

// Mirrors the JSON written by save_state() in run.sh:8741-8753.
// Fields ordered to match bash output for diff-friendly review (the wire
// representation uses 4-space indent like the bash heredoc).
export interface AutonomyState {
  retryCount: number;
  iterationCount: number;
  status: string;
  lastExitCode: number;
  lastRun: string;        // ISO-8601 UTC, e.g. 2026-04-25T12:34:56Z
  prdPath: string;
  pid: number;
  maxRetries: number;
  baseWait: number;
}

// Caller-supplied context -- fields the bash function reads from globals
// (ITERATION_COUNT, PRD_PATH, MAX_RETRIES, BASE_WAIT, $$). Keeping them in a
// struct lets callers stay pure and lets tests inject deterministic values.
export interface SaveStateContext {
  retryCount: number;
  iterationCount: number;
  status: string;
  exitCode: number;
  prdPath?: string;
  pid?: number;
  maxRetries: number;
  baseWait: number;
  // Override "now" for hermetic tests. Defaults to current UTC.
  now?: Date;
  // Override the .loki dir; defaults to lokiDir() (which honors LOKI_DIR env).
  lokiDirOverride?: string;
}

// Minimal subset of orchestrator.json that the dashboard consumes.
// See dashboard_schema_contract.md (section "orchestrator.json"): unknown
// fields are preserved on round-trip so we don't drop data dashboards may
// add later (defensive forward-compat).
export interface OrchestratorState {
  version?: string;
  currentPhase: string;
  iteration?: number;
  complexity?: string;
  startedAt?: string;
  agents?: Record<string, unknown>;
  metrics?: {
    tasksCompleted?: number;
    tasksFailed?: number;
    retries?: number;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

// --- path helpers ----------------------------------------------------------

function resolveLokiDir(override?: string): string {
  return override ?? lokiDir();
}

function autonomyStatePath(dir: string): string {
  return join(dir, "autonomy-state.json");
}

function orchestratorStatePath(dir: string): string {
  return join(dir, "state", "orchestrator.json");
}

function providerStatePath(dir: string): string {
  return join(dir, "state", "provider");
}

function statusTxtPath(dir: string): string {
  return join(dir, "STATUS.txt");
}

// --- atomic write primitive ------------------------------------------------

// Mirror of bash idiom: write to "<path>.tmp.$$" then `mv -f`. Node's
// renameSync is atomic on POSIX when both paths live on the same filesystem,
// matching `mv -f` behavior. We swallow ENOENT on cleanup so a kill -9 mid-
// write leaves only the tmp file, which load_state's orphan sweep collects.
//
// Source: autonomy/run.sh:8740 ("$$" -> process.pid here).
export function atomicWriteFileSync(targetPath: string, contents: string): void {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  // Node's writeFileSync replaces the file atomically *only* via rename; the
  // initial write to tmp may interleave on crash, which is exactly what
  // load_state's orphan sweep is designed to clean up.
  writeFileSync(tmpPath, contents);
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file if rename fails (e.g. cross-device).
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore -- the orphan sweep will handle it on next load.
    }
    throw err;
  }
}

// --- save_state ------------------------------------------------------------

// Format ISO-8601 UTC with second precision -- matches `date -u
// +%Y-%m-%dT%H:%M:%SZ` (autonomy/run.sh:8747).
function isoUtcSeconds(d: Date): string {
  // toISOString() emits e.g. 2026-04-25T12:34:56.789Z; trim millis to match
  // the bash format byte-for-byte.
  const s = d.toISOString();
  const dot = s.indexOf(".");
  return dot >= 0 ? `${s.slice(0, dot)}Z` : s;
}

// Bash escapes prdPath via `sed 's/\\/\\\\/g; s/"/\\"/g'` (run.sh:8748).
// JSON.stringify handles both backslash and quote escaping correctly, so we
// rely on it for safety while still matching the resulting on-disk content.
function jsonString(value: string): string {
  return JSON.stringify(value);
}

// Mirror save_state(retry_count, status, exit_code) at run.sh:8731.
// Returns the path written (caller may want to log it).
export function saveState(ctx: SaveStateContext): string {
  const dir = resolveLokiDir(ctx.lokiDirOverride);
  // Defensive mkdir -- bash does `mkdir -p .loki 2>/dev/null` on line 8737.
  mkdirSync(dir, { recursive: true });

  const now = ctx.now ?? new Date();
  const prd = ctx.prdPath ?? "";
  const pid = ctx.pid ?? process.pid;

  // Build JSON with 4-space indent to match the bash heredoc layout
  // (run.sh:8741-8753). The dashboard parses this with json.load, so the
  // exact indent doesn't matter for it -- but our parity tests rely on it.
  const body =
    `{\n` +
    `    "retryCount": ${ctx.retryCount},\n` +
    `    "iterationCount": ${ctx.iterationCount},\n` +
    `    "status": ${jsonString(ctx.status)},\n` +
    `    "lastExitCode": ${ctx.exitCode},\n` +
    `    "lastRun": ${jsonString(isoUtcSeconds(now))},\n` +
    `    "prdPath": ${jsonString(prd)},\n` +
    `    "pid": ${pid},\n` +
    `    "maxRetries": ${ctx.maxRetries},\n` +
    `    "baseWait": ${ctx.baseWait}\n` +
    `}\n`;

  const target = autonomyStatePath(dir);
  atomicWriteFileSync(target, body);
  return target;
}

// v7.4.4 (BUG-24): runner-shaped adapter for autonomous.ts persistState.
// autonomous.ts:42 declares saveState(ctx, status, exitCode) but state.ts's
// public saveState takes a single SaveStateContext. Calling the public one
// with extra args silently produced malformed JSON (positional args ignored,
// the `ctx` arg was a RunnerContext lacking SaveStateContext fields). This
// adapter bridges the two shapes and is the marker key autonomous.ts now
// gates on via tryImport.
import type { RunnerContext as LoopRunnerContext } from "./types.ts";

export async function saveStateForRunner(
  ctx: LoopRunnerContext,
  status: string,
  exitCode: number,
): Promise<void> {
  saveState({
    retryCount: ctx.retryCount,
    iterationCount: ctx.iterationCount,
    status,
    exitCode,
    prdPath: ctx.prdPath,
    pid: process.pid,
    maxRetries: ctx.maxRetries,
    baseWait: ctx.baseWaitSeconds,
    lokiDirOverride: ctx.lokiDir,
  });
}

export async function loadStateForRunner(ctx: LoopRunnerContext): Promise<void> {
  // Read the on-disk state and re-hydrate the runner counters. Idempotent:
  // missing file -> no-op; corrupt -> backed-up + counters reset to 0.
  const result = loadState({ lokiDirOverride: ctx.lokiDir });
  ctx.retryCount = result.retryCount;
  ctx.iterationCount = result.iterationCount;
}

// --- load_state ------------------------------------------------------------

// Result mirrors the side-effects bash sets globally
// (RETRY_COUNT, ITERATION_COUNT) plus a status byte for the caller. Bash's
// load_state mutates shell globals; we return them so callers can apply
// them explicitly -- this is a lossless TypeScript translation.
export interface LoadStateResult {
  // Effective values to use on resume. Both default to 0 on missing/corrupt.
  retryCount: number;
  iterationCount: number;
  // The on-disk record (if it parsed). Useful for diagnostics and tests.
  state: AutonomyState | null;
  // True iff the file existed but failed validation (and was backed up).
  corrupted: boolean;
  // True iff the previous status was a terminal one and counters were reset.
  resetForNewSession: boolean;
}

// Heuristic terminal-status set from run.sh:8806-8810.
const TERMINAL_STATUSES = new Set([
  "failed",
  "max_iterations_reached",
  "max_retries_exceeded",
  "exited",
]);

// Validate the parsed JSON the way the inline python at run.sh:8767-8784 does.
function isValidAutonomyState(d: unknown): d is Partial<AutonomyState> {
  if (typeof d !== "object" || d === null) return false;
  const rec = d as Record<string, unknown>;
  const rc = rec["retryCount"];
  const ic = rec["iterationCount"];
  if (rc !== undefined && (typeof rc !== "number" || rc < 0)) return false;
  if (ic !== undefined && (typeof ic !== "number" || ic < 0)) return false;
  return true;
}

// Sweep orphaned `*.tmp.*` files older than 5 minutes (run.sh:8760-8761).
// Bash uses `find -mmin +5`; Node has no native equivalent so we walk
// readdir + statSync. We only look at the two directories the bash version
// scans: `.loki/` (depth 1 only) and `.loki/state/`.
function sweepOrphanTmpFiles(dir: string, now: Date): void {
  const cutoffMs = now.getTime() - 5 * 60 * 1000;
  const targets = [dir, join(dir, "state")];
  for (const t of targets) {
    if (!existsSync(t)) continue;
    let entries: string[];
    try {
      entries = readdirSync(t);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.includes(".tmp.")) continue;
      const full = join(t, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoffMs) unlinkSync(full);
      } catch {
        // Race with another sweep or with the writer rename(); ignore.
      }
    }
  }
}

// Mirror load_state() at run.sh:8757. Pure function -- never mutates
// globals; caller decides what to do with the returned counters.
export function loadState(opts: { lokiDirOverride?: string; now?: Date } = {}): LoadStateResult {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  const now = opts.now ?? new Date();

  sweepOrphanTmpFiles(dir, now);

  const target = autonomyStatePath(dir);
  if (!existsSync(target)) {
    // Bash sets RETRY_COUNT=0 (run.sh:8816). ITERATION_COUNT stays whatever
    // the caller initialized (usually 0). We surface both as 0 for clarity.
    return {
      retryCount: 0,
      iterationCount: 0,
      state: null,
      corrupted: false,
      resetForNewSession: false,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return {
      retryCount: 0,
      iterationCount: 0,
      state: null,
      corrupted: true,
      resetForNewSession: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupCorruptState(target, now);
    return {
      retryCount: 0,
      iterationCount: 0,
      state: null,
      corrupted: true,
      resetForNewSession: false,
    };
  }

  if (!isValidAutonomyState(parsed)) {
    backupCorruptState(target, now);
    return {
      retryCount: 0,
      iterationCount: 0,
      state: null,
      corrupted: true,
      resetForNewSession: false,
    };
  }

  // Coerce to a fully-typed record for the caller's convenience. Missing
  // fields fall back to the same defaults bash uses (retryCount=0,
  // iterationCount=0, status="unknown").
  const rec = parsed as Partial<AutonomyState>;
  const state: AutonomyState = {
    retryCount: typeof rec.retryCount === "number" ? rec.retryCount : 0,
    iterationCount: typeof rec.iterationCount === "number" ? rec.iterationCount : 0,
    status: typeof rec.status === "string" ? rec.status : "unknown",
    lastExitCode: typeof rec.lastExitCode === "number" ? rec.lastExitCode : 0,
    lastRun: typeof rec.lastRun === "string" ? rec.lastRun : "",
    prdPath: typeof rec.prdPath === "string" ? rec.prdPath : "",
    pid: typeof rec.pid === "number" ? rec.pid : 0,
    maxRetries: typeof rec.maxRetries === "number" ? rec.maxRetries : 0,
    baseWait: typeof rec.baseWait === "number" ? rec.baseWait : 0,
  };

  // Apply the terminal-status reset (run.sh:8805-8811).
  let retryCount = state.retryCount;
  let iterationCount = state.iterationCount;
  let resetForNewSession = false;
  if (TERMINAL_STATUSES.has(state.status)) {
    retryCount = 0;
    iterationCount = 0;
    resetForNewSession = true;
  }

  return { retryCount, iterationCount, state, corrupted: false, resetForNewSession };
}

// Bash backs up corrupt state with a unix-epoch suffix
// (run.sh:8792). We match that exactly so log scrapers continue to work.
function backupCorruptState(target: string, now: Date): void {
  const epoch = Math.floor(now.getTime() / 1000);
  const backupPath = `${target}.corrupt.${epoch}`;
  try {
    renameSync(target, backupPath);
  } catch {
    // If the rename fails (e.g. dest already exists from a prior load in the
    // same second), fall back to deletion -- matches `|| true` in bash.
    try {
      unlinkSync(target);
    } catch {
      // Nothing else we can do; next load will see the file again and retry.
    }
  }
}

// --- orchestrator.json -----------------------------------------------------

// Read the dashboard-critical orchestrator state. Returns null on missing
// or unparseable file -- callers are expected to treat that as "fresh".
export function readOrchestratorState(opts: { lokiDirOverride?: string } = {}): OrchestratorState | null {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  const target = orchestratorStatePath(dir);
  if (!existsSync(target)) return null;
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  // Require at least the dashboard-critical key; otherwise treat as invalid.
  if (typeof rec["currentPhase"] !== "string") return null;
  return rec as OrchestratorState;
}

// Atomic write of orchestrator.json. Preserves any extra fields the caller
// passes in (forward-compat with future dashboard fields).
//
// We use 4-space indent to match the existing bash heredoc style at
// run.sh:3080-3091, which keeps `git diff` output stable across runs.
export function writeOrchestratorState(
  state: OrchestratorState,
  opts: { lokiDirOverride?: string } = {},
): string {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  mkdirSync(join(dir, "state"), { recursive: true });
  const target = orchestratorStatePath(dir);
  const body = `${JSON.stringify(state, null, 4)}\n`;
  atomicWriteFileSync(target, body);
  return target;
}

// --- provider --------------------------------------------------------------

// Read the saved provider name (single line, trailing newline trimmed).
// Source: autonomy/run.sh:3525-3528, mirrored by status.ts:96-101.
export function readProviderName(opts: { lokiDirOverride?: string } = {}): string | null {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  const target = providerStatePath(dir);
  if (!existsSync(target)) return null;
  try {
    const v = readFileSync(target, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// --- STATUS.txt ------------------------------------------------------------

// Plain text status marker the user inspects with `cat .loki/STATUS.txt`.
// No schema beyond "free-form text" -- we only guarantee atomic write and
// directory creation.
export function updateStatusTxt(text: string, opts: { lokiDirOverride?: string } = {}): string {
  const dir = resolveLokiDir(opts.lokiDirOverride);
  mkdirSync(dir, { recursive: true });
  const target = statusTxtPath(dir);
  // STATUS.txt is read by humans; ensure trailing newline.
  const body = text.endsWith("\n") ? text : `${text}\n`;
  atomicWriteFileSync(target, body);
  return target;
}
