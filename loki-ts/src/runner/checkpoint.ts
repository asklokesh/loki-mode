// Checkpoint subsystem -- byte-identical port of bash create_checkpoint().
// Source of truth: autonomy/run.sh:6899-6997 (create_checkpoint),
// autonomy/run.sh:6999-7052 (rollback_to_checkpoint),
// spec: loki-ts/docs/phase4-research/checkpoint_budget.md sections 1-5.
//
// On-disk layout (must match bash exactly):
//   .loki/state/checkpoints/
//     index.jsonl                         -- append-only, 5-field summary
//     cp-{iteration}-{epoch}/
//       metadata.json                     -- 9-field metadata
//       state/orchestrator.json           -- copied from .loki/
//       autonomy-state.json               -- copied from .loki/
//       queue/{pending,completed,in-progress,current-task}.json  -- copied
//
// NO file locks; bash relies on single-threaded execution. We provide an
// in-process mutex so concurrent calls within one Bun process serialize
// correctly (test suite exercises this). Cross-process safety is no worse
// than bash; index rebuild uses tmp+rename which is atomic on POSIX.

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { run } from "../util/shell.ts";

// Schema mirrors metadata.json exactly. Field names and types are load-bearing
// (consumed by rollback_to_checkpoint and the dashboard). Do not rename.
export type CheckpointMetadata = {
  id: string;
  timestamp: string;
  iteration: number;
  task_id: string;
  task_description: string;
  git_sha: string;
  git_branch: string;
  provider: string;
  phase: string;
};

// Schema mirrors index.jsonl line format (5 fields, abbreviated names).
export type CheckpointIndexEntry = {
  id: string;
  ts: string;
  iter: number;
  task: string;
  sha: string;
};

export type CreateCheckpointOpts = {
  taskDescription: string;
  taskId?: string;
  // ITERATION_COUNT env var equivalent. Defaults to env or 0.
  iteration?: number;
  // PROVIDER_NAME env var equivalent. Defaults to env or "claude".
  provider?: string;
  // Test seam: override base .loki dir (default = lokiDir()).
  lokiDirOverride?: string;
  // Test seam: skip the "no uncommitted changes" guard.
  // Defaults to false (bash behavior).
  forceCreate?: boolean;
  // Test seam: override the epoch used in the id (for deterministic tests).
  epochOverride?: number;
};

export type CreateCheckpointResult =
  | { created: true; id: string; metadata: CheckpointMetadata; dir: string }
  | { created: false; reason: string };

// Bash sources at autonomy/run.sh:6905. Max checkpoints per session before
// retention prunes oldest. Keep in lockstep with bash.
const RETENTION_LIMIT = 50;

// Truncation matches bash autonomy/run.sh:6945 (`${task_desc:0:200}`).
const TASK_DESC_MAX = 200;

// In-process serialization for concurrent createCheckpoint() calls. The bash
// implementation is single-threaded; this mutex preserves that invariant
// inside one Bun process so the index.jsonl append and the rebuild step do
// not race.
let _chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = _chain.then(fn, fn);
  // Swallow rejections in the chain so one failure does not poison subsequent
  // calls. Each caller still receives its own error via `next`.
  _chain = next.catch(() => undefined);
  return next;
}

function checkpointsRoot(base: string): string {
  return join(base, "state", "checkpoints");
}

function indexPath(base: string): string {
  return join(checkpointsRoot(base), "index.jsonl");
}

// Mirror bash autonomy/run.sh:6917 -- `git rev-parse HEAD || echo no-git`.
async function gitSha(cwd: string): Promise<string> {
  const r = await run(["git", "rev-parse", "HEAD"], { cwd, timeoutMs: 5000 });
  if (r.exitCode !== 0) return "no-git";
  return r.stdout.trim() || "no-git";
}

// Mirror bash autonomy/run.sh:6919 -- `git branch --show-current || echo unknown`.
async function gitBranch(cwd: string): Promise<string> {
  const r = await run(["git", "branch", "--show-current"], { cwd, timeoutMs: 5000 });
  if (r.exitCode !== 0) return "unknown";
  return r.stdout.trim() || "unknown";
}

// Mirror bash autonomy/run.sh:6910-6913 -- skip if no uncommitted changes.
// Returns true if there is at least one uncommitted (worktree or staged) change.
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  // `git diff --quiet` exits 1 if there are unstaged changes, 0 otherwise.
  const wt = await run(["git", "diff", "--quiet"], { cwd, timeoutMs: 5000 });
  const idx = await run(["git", "diff", "--cached", "--quiet"], { cwd, timeoutMs: 5000 });
  // If git itself errored (not a repo), bash treats that as "no changes" via
  // `2>/dev/null && ...`. Match that behavior: only changes when both probes
  // ran cleanly (exit 0 or 1) and at least one returned 1.
  const wtChanged = wt.exitCode === 1;
  const idxChanged = idx.exitCode === 1;
  return wtChanged || idxChanged;
}

// Read currentPhase from .loki/state/orchestrator.json (autonomy/run.sh:6941).
function readPhase(base: string): string {
  const p = join(base, "state", "orchestrator.json");
  if (!existsSync(p)) return "unknown";
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    const v = parsed["currentPhase"];
    return typeof v === "string" && v.length > 0 ? v : "unknown";
  } catch {
    return "unknown";
  }
}

// Files copied into the checkpoint directory (autonomy/run.sh:6931).
const COPIED_FILES: readonly string[] = [
  "state/orchestrator.json",
  "autonomy-state.json",
  "queue/pending.json",
  "queue/completed.json",
  "queue/in-progress.json",
  "queue/current-task.json",
] as const;

function copyStateFiles(base: string, cpDir: string): void {
  for (const rel of COPIED_FILES) {
    const src = join(base, rel);
    if (!existsSync(src)) continue;
    const dst = join(cpDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try {
      copyFileSync(src, dst);
    } catch {
      // Bash uses `|| true`; mirror that tolerance.
    }
  }
}

// Atomic write via tmp + rename. POSIX rename(2) is atomic within a directory.
// Use process pid + a counter to avoid tmp collisions across concurrent calls.
let _tmpCounter = 0;
function atomicWriteFile(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${++_tmpCounter}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, target);
}

// metadata.json must match bash json.dump(indent=2) output exactly so cross-
// runtime checkpoints are byte-identical (autonomy/run.sh:6961-6962).
// Python's json.dump(indent=2) uses ", " item separator and ": " key
// separator -- JSON.stringify(obj, null, 2) produces identical output for
// flat objects of strings/numbers, which is what metadata.json is.
function serializeMetadata(m: CheckpointMetadata): string {
  return JSON.stringify(m, null, 2);
}

// index.jsonl line format must match bash json.dumps() (no spaces, compact).
// JSON.stringify(obj) with no indent produces the same output Python emits
// with default separators (", ", ": ") -- BUT Python default is actually
// (", ", ": ") with spaces. We need to match the bash code at line 6967
// which uses default json.dumps -> spaces. Verify: `json.dumps({"a":1,"b":2})`
// produces `{"a": 1, "b": 2}`. JSON.stringify produces `{"a":1,"b":2}`.
// To match bash exactly, we hand-format with the Python default separators.
function serializeIndexLine(e: CheckpointIndexEntry): string {
  // Python's json.dumps default separators: (", ", ": "). Reproduce them.
  const parts: string[] = [
    `"id": ${JSON.stringify(e.id)}`,
    `"ts": ${JSON.stringify(e.ts)}`,
    `"iter": ${JSON.stringify(e.iter)}`,
    `"task": ${JSON.stringify(e.task)}`,
    `"sha": ${JSON.stringify(e.sha)}`,
  ];
  return `{${parts.join(", ")}}`;
}

// Public: create a checkpoint. Mirrors create_checkpoint() in bash.
export async function createCheckpoint(
  opts: CreateCheckpointOpts,
): Promise<CreateCheckpointResult> {
  return serialize(() => _createCheckpointImpl(opts));
}

async function _createCheckpointImpl(
  opts: CreateCheckpointOpts,
): Promise<CreateCheckpointResult> {
  const base = opts.lokiDirOverride ?? lokiDir();
  const cwd = process.cwd();
  const root = checkpointsRoot(base);
  mkdirSync(root, { recursive: true });

  if (!opts.forceCreate) {
    const dirty = await hasUncommittedChanges(cwd);
    if (!dirty) {
      return { created: false, reason: "no uncommitted changes" };
    }
  }

  const sha = await gitSha(cwd);
  const branch = await gitBranch(cwd);

  const iteration =
    opts.iteration ?? Number.parseInt(process.env["ITERATION_COUNT"] ?? "0", 10);
  const epoch = opts.epochOverride ?? Math.floor(Date.now() / 1000);
  const id = `cp-${iteration}-${epoch}`;
  const cpDir = join(root, id);
  mkdirSync(cpDir, { recursive: true });

  copyStateFiles(base, cpDir);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const desc = (opts.taskDescription ?? "task completed").slice(0, TASK_DESC_MAX);
  const provider = opts.provider ?? process.env["PROVIDER_NAME"] ?? "claude";

  const metadata: CheckpointMetadata = {
    id,
    timestamp,
    iteration,
    task_id: opts.taskId ?? "unknown",
    task_description: desc,
    git_sha: sha,
    git_branch: branch,
    provider,
    phase: readPhase(base),
  };

  // Write metadata.json atomically. If this fails, the index is not touched
  // (matches bash: index append only happens after metadata write succeeds).
  atomicWriteFile(join(cpDir, "metadata.json"), serializeMetadata(metadata));

  // Append to index.jsonl. Single appendFileSync writes are atomic for small
  // payloads on POSIX (PIPE_BUF = 4096+ bytes); index lines are well under
  // that. The serialize() chain prevents in-process interleaving as well.
  const idxLine: CheckpointIndexEntry = {
    id: metadata.id,
    ts: metadata.timestamp,
    iter: metadata.iteration,
    task: metadata.task_description,
    sha: metadata.git_sha,
  };
  appendFileSync(indexPath(base), `${serializeIndexLine(idxLine)}\n`);

  // Retention: prune oldest above RETENTION_LIMIT, then rebuild index atomically.
  enforceRetention(base);

  return { created: true, id, metadata, dir: cpDir };
}

function listCheckpointDirs(base: string): readonly string[] {
  const root = checkpointsRoot(base);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith("cp-"))
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
}

// Sort cp-{iter}-{epoch} by epoch (numeric, ascending). Mirrors bash:
// `sort -t'-' -k3 -n` (autonomy/run.sh:6978).
function sortByEpoch(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const ea = parseEpoch(a);
    const eb = parseEpoch(b);
    return ea - eb;
  });
}

function parseEpoch(id: string): number {
  // cp-{iter}-{epoch}; field 3 after splitting by `-` (1-indexed).
  const parts = id.split("-");
  if (parts.length < 3) return 0;
  const last = parts[parts.length - 1];
  const n = Number.parseInt(last ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function enforceRetention(base: string): void {
  const dirs = listCheckpointDirs(base);
  if (dirs.length <= RETENTION_LIMIT) return;

  const sorted = sortByEpoch(dirs);
  const toRemove = sorted.slice(0, sorted.length - RETENTION_LIMIT);
  for (const oldId of toRemove) {
    try {
      rmSync(join(checkpointsRoot(base), oldId), { recursive: true, force: true });
    } catch {
      // Match bash `|| true`.
    }
  }

  // Rebuild index atomically from remaining metadata files.
  rebuildIndex(base);
}

function rebuildIndex(base: string): void {
  const remaining = sortByEpoch(listCheckpointDirs(base));
  const lines: string[] = [];
  for (const id of remaining) {
    const metaPath = join(checkpointsRoot(base), id, "metadata.json");
    if (!existsSync(metaPath)) continue;
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf-8")) as CheckpointMetadata;
      lines.push(
        serializeIndexLine({
          id: m.id,
          ts: m.timestamp,
          iter: m.iteration,
          task: m.task_description ?? "",
          sha: m.git_sha,
        }),
      );
    } catch {
      // Skip corrupt metadata, mirror bash `|| true`.
    }
  }
  const target = indexPath(base);
  const contents = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  atomicWriteFile(target, contents);
}

// Public: list checkpoints by reading metadata.json for each cp-* directory.
// Returned in chronological order (oldest first by epoch).
export function listCheckpoints(lokiDirOverride?: string): CheckpointMetadata[] {
  const base = lokiDirOverride ?? lokiDir();
  const ids = sortByEpoch(listCheckpointDirs(base));
  const out: CheckpointMetadata[] = [];
  for (const id of ids) {
    const m = readCheckpointSafe(base, id);
    if (m) out.push(m);
  }
  return out;
}

function readCheckpointSafe(base: string, id: string): CheckpointMetadata | null {
  const metaPath = join(checkpointsRoot(base), id, "metadata.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as CheckpointMetadata;
  } catch {
    return null;
  }
}

// Validation: matches bash autonomy/run.sh:7006 regex.
const CHECKPOINT_ID_RE = /^[a-zA-Z0-9_-]+$/;

export class CheckpointNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Checkpoint not found: ${id}`);
    this.name = "CheckpointNotFoundError";
  }
}

export class InvalidCheckpointIdError extends Error {
  constructor(public readonly id: string) {
    super(
      `Invalid checkpoint ID: must be alphanumeric, hyphens, underscores only (got: ${id})`,
    );
    this.name = "InvalidCheckpointIdError";
  }
}

// Public: read a checkpoint's metadata.json. Throws on missing or invalid id.
export function readCheckpoint(
  id: string,
  lokiDirOverride?: string,
): CheckpointMetadata {
  if (!CHECKPOINT_ID_RE.test(id)) {
    throw new InvalidCheckpointIdError(id);
  }
  const base = lokiDirOverride ?? lokiDir();
  const cpDir = join(checkpointsRoot(base), id);
  if (!existsSync(cpDir)) {
    throw new CheckpointNotFoundError(id);
  }
  const m = readCheckpointSafe(base, id);
  if (!m) {
    throw new CheckpointNotFoundError(id);
  }
  return m;
}

// Restore plan: list of (src in checkpoint, dst in .loki) file pairs that the
// caller should copy to perform the rollback. Matches autonomy/run.sh:7028-7034.
// We return a plan rather than performing the copy so that the caller can
// orchestrate any extra steps (event emission, pre-rollback snapshot, audit
// log). The bash function calls create_checkpoint("pre-rollback snapshot",
// "rollback") before restoring; the caller is expected to do the same.
export type RestorePlanEntry = { from: string; to: string };

export type RollbackPlan = {
  id: string;
  metadata: CheckpointMetadata;
  // Files to copy from checkpoint dir back into .loki/.
  restore: readonly RestorePlanEntry[];
};

// Files restored on rollback (autonomy/run.sh:7028 -- note: omits
// autonomy-state.json, matching bash exactly).
const RESTORE_FILES: readonly string[] = [
  "state/orchestrator.json",
  "queue/pending.json",
  "queue/completed.json",
  "queue/in-progress.json",
  "queue/current-task.json",
] as const;

export function rollbackToCheckpoint(
  id: string,
  lokiDirOverride?: string,
): RollbackPlan {
  // Validation + existence check + metadata read all live in readCheckpoint.
  const metadata = readCheckpoint(id, lokiDirOverride);
  const base = lokiDirOverride ?? lokiDir();
  const cpDir = join(checkpointsRoot(base), id);
  const plan: RestorePlanEntry[] = [];
  for (const rel of RESTORE_FILES) {
    const from = join(cpDir, rel);
    if (!existsSync(from)) continue;
    plan.push({ from, to: join(base, rel) });
  }
  return { id, metadata, restore: plan };
}

// v7.4.3 (BUG-21): execute a rollback plan. Previously the planner returned
// `restore` entries but never copied them; callers had to do it themselves.
// This now actually performs the restore, atomically per file (tmp + rename).
export function executeRollback(plan: RollbackPlan): { restored: number; errors: string[] } {
  const errors: string[] = [];
  let restored = 0;
  for (const entry of plan.restore) {
    try {
      const tmp = `${entry.to}.tmp.${process.pid}.${++_tmpCounter}`;
      copyFileSync(entry.from, tmp);
      renameSync(tmp, entry.to);
      restored += 1;
    } catch (err) {
      errors.push(`${entry.from} -> ${entry.to}: ${(err as Error).message}`);
    }
  }
  return { restored, errors };
}

// Test/debug helper: read the index.jsonl and parse each line.
//
// v7.4.3 (BUG-11): wrap the readFileSync in try/catch to close the TOCTOU
// race -- if the file is deleted between existsSync and readFileSync, the
// previous code would throw synchronously into the caller. Now we treat
// "file disappeared" as "no entries".
export function readIndex(lokiDirOverride?: string): CheckpointIndexEntry[] {
  const base = lokiDirOverride ?? lokiDir();
  const path = indexPath(base);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: CheckpointIndexEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CheckpointIndexEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}
