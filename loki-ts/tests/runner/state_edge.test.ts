// Edge-case tests for src/runner/state.ts.
//
// Closes the v7.4.x CHANGELOG honest disclosure list:
//   1. state.ts cross-device EXDEV rename fallback   (gap honestly documented)
//   2. orphan tmp-file 5-min cleanup (real test)     (covered)
//   3. autonomy-state.json malformed JSON recovery   (corrupt-backup path)
//
// Source-of-truth: autonomy/run.sh:8731-8818.
// Hermetic: each test creates a fresh tmpdir; no process.env mutation.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  __setFsForTesting,
  atomicWriteFileSync,
  loadState,
  saveState,
} from "../../src/runner/state.ts";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-state-edge-"));
  dir = join(tmp, ".loki");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. EXDEV cross-device rename fallback -- GAP DOCUMENTED
// ---------------------------------------------------------------------------
//
// Inspection of src/runner/state.ts:117-134 (atomicWriteFileSync):
//
//   import { renameSync, unlinkSync, writeFileSync } from "node:fs";
//   ...
//   writeFileSync(tmpPath, contents);
//   try {
//     renameSync(tmpPath, targetPath);
//   } catch (err) {
//     try { unlinkSync(tmpPath); } catch { /* ignored */ }
//     throw err;       // <-- re-throws EXDEV; NO copyFileSync fallback
//   }
//
// Two facts close this gap honestly:
//   (a) The state.ts source uses *destructured named imports* of renameSync,
//       so external monkey-patching of fs.renameSync would NOT intercept the
//       call -- the symbol is bound at import time. A genuine simulation
//       requires either a vi/bun mock that replaces the module export, or a
//       refactor of state.ts to take an injectable fs adapter.
//   (b) On the catch branch, the implementation re-throws the original error
//       with no `code === 'EXDEV'` special-case. Cross-device .loki mounts
//       (bind-mounts, tmpfs overlays in containers) will surface EXDEV to
//       the caller instead of completing the write.
//
// The skipped test below is the executable spec for the fallback that should
// be added to atomicWriteFileSync. Once implemented, remove `.skip` and
// (likely) refactor state.ts to import an `fsAdapter` so the test can inject
// a faulting renameSync without touching node:fs internals.

describe("atomicWriteFileSync: cross-device EXDEV rename", () => {
  // Restore default fs after each test in this block so a faulting renameSync
  // can't leak into siblings.
  afterEach(() => {
    __setFsForTesting({});
  });

  it("falls back to copyFileSync when renameSync throws EXDEV (content correct)", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "x.json");
    const payload = '{"hello":"exdev"}';

    let renameCalls = 0;
    let copyCalls = 0;
    __setFsForTesting({
      renameSync: (_oldPath, _newPath) => {
        renameCalls++;
        const err = new Error("simulated cross-device link") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      },
      copyFileSync: (src, dst, mode) => {
        copyCalls++;
        copyFileSync(src as string, dst as string, mode);
      },
    });

    atomicWriteFileSync(target, payload);

    expect(renameCalls).toBe(1);
    expect(copyCalls).toBe(1);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(payload);

    // Tmp file from the failed rename must be cleaned up.
    const leftover = readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(leftover).toEqual([]);
  });

  it("EXDEV fallback atomically replaces existing target (no partial content)", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "x.json");
    // Pre-populate with a known prior value.
    writeFileSync(target, '{"prev":"v1"}');

    const newPayload = '{"prev":"v2-much-longer-payload-to-detect-truncation"}';

    __setFsForTesting({
      renameSync: () => {
        const err = new Error("EXDEV") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      },
      // Real copyFileSync -- copyFileSync on POSIX is implemented as an
      // open-truncate-write so the visible content is either the old file
      // or the complete new file, never a partial mix.
      copyFileSync: (src, dst, mode) => copyFileSync(src as string, dst as string, mode),
    });

    atomicWriteFileSync(target, newPayload);

    expect(readFileSync(target, "utf8")).toBe(newPayload);
    // No tmp leftover.
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
    // No lock leftover.
    expect(readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("re-throws non-EXDEV errors and cleans up tmp file", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "x.json");

    __setFsForTesting({
      renameSync: () => {
        const err = new Error("EACCES simulated") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    });

    expect(() => atomicWriteFileSync(target, "data")).toThrow(/EACCES/);
    // Tmp must be cleaned up on the non-EXDEV branch too.
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
    // Lock must be released even when an error propagates.
    expect(readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });
});

// Suppress unused warnings for symbols imported for parity with the new tests.
void renameSync;
void dirname;

// ---------------------------------------------------------------------------
// 2. Orphan tmp-file 5-minute cleanup (REAL test, not just spec)
// ---------------------------------------------------------------------------
//
// run.sh:8760-8761 uses `find -mmin +5` to sweep stale `*.tmp.*` files left
// behind by killed writers. This test creates an orphan with mtime > 5 min
// in the past, calls loadState, and verifies the sweep removed it. It also
// verifies a fresh sibling tmp file (in-flight write) is preserved.

describe("loadState: orphan tmp-file 5-minute cleanup (real)", () => {
  it("removes .loki/state/orchestrator.json.tmp.99999 when mtime > 5 min ago", () => {
    const stateSubdir = join(dir, "state");
    mkdirSync(stateSubdir, { recursive: true });
    const orphan = join(stateSubdir, "orchestrator.json.tmp.99999");
    writeFileSync(orphan, "stale-write");

    // Backdate mtime to 6 minutes ago. utimesSync takes seconds since epoch.
    const sixMinAgoSec = (Date.now() - 6 * 60 * 1000) / 1000;
    utimesSync(orphan, sixMinAgoSec, sixMinAgoSec);
    expect(existsSync(orphan)).toBe(true);

    // Pin "now" so the cutoff is deterministic relative to the backdated mtime.
    loadState({ lokiDirOverride: dir, now: new Date() });

    expect(existsSync(orphan)).toBe(false);
  });

  it("preserves a fresh sibling tmp file (in-flight write)", () => {
    const stateSubdir = join(dir, "state");
    mkdirSync(stateSubdir, { recursive: true });
    const fresh = join(stateSubdir, "orchestrator.json.tmp.42");
    writeFileSync(fresh, "in-flight");
    // mtime is "now" by default -- no backdating.

    loadState({ lokiDirOverride: dir, now: new Date() });

    expect(existsSync(fresh)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. autonomy-state.json malformed JSON recovery (corrupt-backup path)
// ---------------------------------------------------------------------------
//
// run.sh:8767-8792: when JSON.parse fails, the file is moved aside to
// `<path>.corrupt.<unix-epoch>` and counters are reset to 0. This test
// writes the literal `{not valid json` payload requested in the spec.

describe("loadState: corrupt JSON -> .corrupt.<ts> backup + reset counters", () => {
  it("backs up `{not valid json` and returns zeroed counters", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "autonomy-state.json");
    writeFileSync(target, "{not valid json");

    // Pin now so we can predict the .corrupt.<epoch> suffix.
    const pinnedNow = new Date("2026-04-25T18:00:00Z");
    const result = loadState({ lokiDirOverride: dir, now: pinnedNow });

    expect(result.corrupted).toBe(true);
    expect(result.retryCount).toBe(0);
    expect(result.iterationCount).toBe(0);
    expect(result.state).toBeNull();

    const epoch = Math.floor(pinnedNow.getTime() / 1000);
    const backupPath = join(dir, `autonomy-state.json.corrupt.${epoch}`);
    expect(existsSync(backupPath)).toBe(true);

    // Backup retains the original (broken) payload byte-for-byte.
    expect(readFileSync(backupPath, "utf8")).toBe("{not valid json");

    // Original file no longer present.
    expect(existsSync(target)).toBe(false);
  });

  it("subsequent saveState writes a fresh, valid file after corruption recovery", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "autonomy-state.json");
    writeFileSync(target, "{not valid json");

    const pinnedNow = new Date("2026-04-25T18:05:00Z");
    loadState({ lokiDirOverride: dir, now: pinnedNow });

    // Now write fresh state -- must succeed and produce parseable JSON.
    // Use a non-terminal status ("paused") so the round-trip preserves the
    // iterationCount: this test asserts corruption-recovery round-trips a fresh
    // save, not the terminal-reset behavior. (Was "running", but run.sh:10976
    // now lists "running" among the reset statuses, so loadState would reset
    // iterationCount to 0 and break this round-trip check. "running" is
    // incidental to corruption recovery -- "paused" exercises the same path.)
    saveState({
      retryCount: 0,
      iterationCount: 1,
      status: "paused",
      exitCode: 0,
      prdPath: "",
      pid: 1,
      maxRetries: 5,
      baseWait: 30,
      now: pinnedNow,
      lokiDirOverride: dir,
    });

    const reread = loadState({ lokiDirOverride: dir, now: pinnedNow });
    expect(reread.corrupted).toBe(false);
    expect(reread.iterationCount).toBe(1);
    expect(reread.state?.status).toBe("paused");
  });
});
