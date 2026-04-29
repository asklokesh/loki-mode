// v7.5.3: shared atomic-write + per-target append serialization util.
//
// Extracted from loki-ts/src/runner/learnings_writer.ts so the same
// proven primitive is available to other call sites that suffer from
// concurrent read-mutate-write races on .loki/ JSON files (notably
// quality_gates.ts gate-failure-count.json updates from parallel
// worktrees -- bug-hunt H2 / honest-audit gap #5).
//
// Provides:
//   - atomicWriteJson(target, data): tmp+rename. Per-process counter
//     suffix on tmp paths so concurrent writes within one process do
//     not collide.
//   - withAppendLock(target, fn): per-target async mutex that
//     serializes read-mutate-write sequences. Absorbs upstream
//     rejections so a poisoned predecessor does not block successors
//     (council R1 fix B4 carried forward).

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

let _tmpCounter = 0;

export function atomicWriteJson(target: string, data: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${++_tmpCounter}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, target);
}

export function atomicWriteText(target: string, body: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${++_tmpCounter}`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
}

const _appendChains = new Map<string, Promise<void>>();

export async function withAppendLock<T>(
  target: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = _appendChains.get(target) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Capture the chained promise so the GC equality check actually matches,
  // and absorb any rejection in `prev` so a single failed append does not
  // poison the whole chain for this target.
  const chained = prev.catch(() => {}).then(() => next);
  _appendChains.set(target, chained);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (_appendChains.get(target) === chained) {
      _appendChains.delete(target);
    }
  }
}

// Test-only: reset internal state so per-target locks from one test do
// not leak across afterEach boundaries. Exposed for the unit tests.
export function _resetAtomicForTests(): void {
  _appendChains.clear();
  _tmpCounter = 0;
}

// --- Cross-process advisory lock ------------------------------------------
//
// withAppendLock above only serializes within one Bun process. Parallel
// worktrees / `loki internal phase1-hooks` invocations / dashboard writers
// can race on the same on-disk JSON file from separate processes. Plan
// item #201: add a POSIX advisory file lock using O_CREAT|O_EXCL on a
// `<target>.lock` sentinel file. Cross-process safe; stale-lock detection
// breaks deadlocks if a holder crashed.
//
// Why not flock(2)? Bun does not expose fcntl bindings; spawning flock(1)
// would add a per-call subprocess. The exclusive-create + stale-detect
// pattern is the same approach proper-lockfile uses on POSIX and is
// adequate for the low-frequency, low-contention gate-failure counter.

interface FileLockOptions {
  // Total wait budget before giving up. Default 10s.
  timeoutMs?: number;
  // Poll interval while waiting. Default 25ms with light backoff.
  pollMs?: number;
  // Stale-lock threshold. If the existing lock file is older than this
  // and its pid is gone, take it over. Default 30s.
  staleMs?: number;
}

function lockFilePath(target: string): string {
  return `${target}.lock`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // ESRCH = no such process. EPERM = exists but we can't signal it
    // (still alive, treat as held).
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

function tryAcquire(lockFile: string): number | null {
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
    const fd = openSync(lockFile, "wx");
    writeSync(fd, `${process.pid}\n`);
    return fd;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return null;
    throw err;
  }
}

function reapStaleLock(lockFile: string, staleMs: number): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(lockFile);
  } catch {
    return true;
  }
  const age = Date.now() - st.mtimeMs;
  if (age < staleMs) return false;
  // Try to read pid; if process is gone or unreadable, take over.
  let pid = NaN;
  try {
    const body = readFileSync(lockFile, "utf-8");
    pid = Number.parseInt(body.trim(), 10);
  } catch {
    // unreadable -> stale
  }
  if (!Number.isFinite(pid) || !isProcessAlive(pid)) {
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // ignore -- another process may have just reaped it
    }
    return true;
  }
  return false;
}

export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T> | T,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 25;
  const staleMs = opts.staleMs ?? 30_000;
  const lockFile = lockFilePath(target);
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  let attempt = 0;
  while (fd === null) {
    fd = tryAcquire(lockFile);
    if (fd !== null) break;
    if (Date.now() > deadline) {
      throw new Error(
        `withFileLock: timed out after ${timeoutMs}ms acquiring ${lockFile}`,
      );
    }
    if (reapStaleLock(lockFile, staleMs)) continue;
    const wait = Math.min(pollMs * 2 ** Math.min(attempt, 4), 200);
    attempt += 1;
    await new Promise((r) => setTimeout(r, wait));
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // ignore -- best-effort cleanup
    }
  }
}

// Synchronous variant -- needed for code paths that cannot easily be made
// async (e.g. trackGateFailure is called from a sync gate-runner stack).
// Same semantics, busy-wait with setTimeout-equivalent pause via Atomics.
export function withFileLockSync<T>(
  target: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 25;
  const staleMs = opts.staleMs ?? 30_000;
  const lockFile = lockFilePath(target);
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  let attempt = 0;
  // Sync busy-wait via Atomics.wait on a throwaway SharedArrayBuffer.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (fd === null) {
    fd = tryAcquire(lockFile);
    if (fd !== null) break;
    if (Date.now() > deadline) {
      throw new Error(
        `withFileLockSync: timed out after ${timeoutMs}ms acquiring ${lockFile}`,
      );
    }
    if (reapStaleLock(lockFile, staleMs)) continue;
    const wait = Math.min(pollMs * 2 ** Math.min(attempt, 4), 200);
    attempt += 1;
    Atomics.wait(sab, 0, 0, wait);
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // ignore
    }
  }
}
