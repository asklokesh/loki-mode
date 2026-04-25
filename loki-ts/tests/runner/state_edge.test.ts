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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadState, saveState } from "../../src/runner/state.ts";

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
  // TODO: implement EXDEV fallback in state.ts atomicWriteFileSync.
  // Required behavior:
  //   1. catch err in renameSync; if err.code === 'EXDEV', copyFileSync
  //      (tmpPath, targetPath) then unlinkSync(tmpPath).
  //   2. all other errors continue to re-throw with the current cleanup.
  //   3. refactor to accept an injectable fs adapter so this test can run
  //      without process-wide module mocking.
  // Tracker: state.ts:117-134.
  it.skip(
    "TODO: implement EXDEV fallback in state.ts atomicWriteFileSync " +
      "(currently re-throws EXDEV with no copyFileSync+unlink fallback; " +
      "destructured `renameSync` import precludes runtime monkey-patching)",
    () => {
      // Spec when implemented:
      //   - simulate renameSync throwing { code: 'EXDEV' } once
      //   - assert atomicWriteFileSync completes successfully
      //   - assert target file contains the written payload
      //   - assert no .tmp.<pid> file is left behind
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "x.json");
      // Placeholder assertion -- real implementation requires an injectable
      // fs adapter. See comment block above.
      expect(existsSync(target)).toBe(false);
    },
  );
});

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
    saveState({
      retryCount: 0,
      iterationCount: 1,
      status: "running",
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
    expect(reread.state?.status).toBe("running");
  });
});
