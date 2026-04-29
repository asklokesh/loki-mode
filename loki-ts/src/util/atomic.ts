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
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
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

// v7.5.6 (council R1 #1): if writeSync throws (ENOSPC, EIO, EBADF), the fd
// would leak AND the sentinel would persist on disk, blocking every future
// acquirer until staleMs elapses. Wrap in try/catch and clean both up
// before propagating.
function tryAcquire(lockFile: string): number | null {
  let fd: number | null = null;
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
    fd = openSync(lockFile, "wx");
    writeSync(fd, `${process.pid}\n`);
    return fd;
  } catch (err: unknown) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        unlinkSync(lockFile);
      } catch {
        // ignore
      }
    }
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return null;
    throw err;
  }
}

// v7.5.6 (council R1 #2 + R4 #1): close the TOCTOU window between mtime
// check and pid read by opening the file once and using fstat on the open
// fd, so a same-inode swap by another process cannot fool us. Use lstat
// first to refuse a symlinked sentinel -- a malicious local user with
// write access to .loki/quality/ could otherwise plant a symlink to make
// the lock look stale and steal it.
function reapStaleLock(lockFile: string, staleMs: number): boolean {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(lockFile);
  } catch {
    // gone -> caller will retry tryAcquire and either succeed or race
    return true;
  }
  if (lst.isSymbolicLink()) {
    // Refuse to interpret a symlinked sentinel. Remove the symlink
    // (rmSync of a symlink removes the link, not the target) so the next
    // tryAcquire has a chance to create a real sentinel; if removal
    // fails (read-only parent), report not-stale so we keep waiting.
    try {
      unlinkSync(lockFile);
      return true;
    } catch {
      return false;
    }
  }
  let fd: number;
  try {
    fd = openSync(lockFile, "r");
  } catch {
    // raced with the holder releasing the file; treat as gone
    return true;
  }
  try {
    const fst = fstatSync(fd);
    const age = Date.now() - fst.mtimeMs;
    if (age < staleMs) return false;
    let pid = NaN;
    try {
      const buf = Buffer.alloc(64);
      const bytes = readSync(fd, buf, 0, 64, 0);
      pid = Number.parseInt(buf.subarray(0, bytes).toString("utf-8").trim(), 10);
    } catch {
      // unreadable -> stale
    }
    if (Number.isFinite(pid) && isProcessAlive(pid)) return false;
    // Holder is dead or pid was garbage. Re-stat by path; if mtime is
    // newer than what we read via fstat, a fresh holder took over
    // between our open and our stat -- back off without removing.
    try {
      const pathStat = statSync(lockFile);
      if (pathStat.mtimeMs > fst.mtimeMs) return false;
    } catch {
      return true;
    }
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // another process may have just reaped it
    }
    return true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
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
