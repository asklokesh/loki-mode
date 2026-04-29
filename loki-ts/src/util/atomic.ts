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

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
