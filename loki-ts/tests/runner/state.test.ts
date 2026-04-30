// Tests for src/runner/state.ts.
// Source-of-truth: autonomy/run.sh:8731-8818 (save_state / load_state).
//
// Hermetic: each test creates a fresh tmpdir and passes it via lokiDirOverride.
// We do NOT mutate process.env so tests can run in parallel.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  saveState,
  loadState,
  readOrchestratorState,
  writeOrchestratorState,
  readProviderName,
  updateStatusTxt,
  atomicWriteFileSync,
  type AutonomyState,
  type SaveStateContext,
} from "../../src/runner/state.ts";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-state-test-"));
  dir = join(tmp, ".loki");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseCtx(over: Partial<SaveStateContext> = {}): SaveStateContext {
  return {
    retryCount: 0,
    iterationCount: 0,
    status: "running",
    exitCode: 0,
    prdPath: "",
    pid: 12345,
    maxRetries: 5,
    baseWait: 30,
    now: new Date("2026-04-25T12:34:56.789Z"),
    lokiDirOverride: dir,
    ...over,
  };
}

describe("saveState: round-trip & schema", () => {
  it("writes every field and load returns them verbatim", () => {
    const ctx = baseCtx({
      retryCount: 3,
      iterationCount: 17,
      status: "running",
      exitCode: 42,
      prdPath: "/tmp/my prd.md",
      pid: 9999,
      maxRetries: 10,
      baseWait: 60,
    });
    saveState(ctx);

    const loaded = loadState({ lokiDirOverride: dir });
    expect(loaded.state).not.toBeNull();
    const s = loaded.state as AutonomyState;
    expect(s.retryCount).toBe(3);
    expect(s.iterationCount).toBe(17);
    expect(s.status).toBe("running");
    expect(s.lastExitCode).toBe(42);
    expect(s.prdPath).toBe("/tmp/my prd.md");
    expect(s.pid).toBe(9999);
    expect(s.maxRetries).toBe(10);
    expect(s.baseWait).toBe(60);
    expect(s.lastRun).toBe("2026-04-25T12:34:56Z"); // bash second-precision
  });

  it("escapes prdPath containing quotes and backslashes", () => {
    saveState(baseCtx({ prdPath: 'a"b\\c' }));
    const loaded = loadState({ lokiDirOverride: dir });
    expect(loaded.state?.prdPath).toBe('a"b\\c');
  });

  it("creates .loki dir if missing (defensive parity with run.sh:8737)", () => {
    expect(existsSync(dir)).toBe(false);
    saveState(baseCtx());
    expect(existsSync(join(dir, "autonomy-state.json"))).toBe(true);
  });

  it("output uses 4-space indent matching the bash heredoc", () => {
    saveState(baseCtx());
    const raw = readFileSync(join(dir, "autonomy-state.json"), "utf8");
    expect(raw.startsWith("{\n    \"retryCount\":")).toBe(true);
    expect(raw.endsWith("}\n")).toBe(true);
  });
});

describe("saveState: atomic write semantics", () => {
  it("never leaves a partial file under target name (rename is atomic)", () => {
    saveState(baseCtx({ status: "first" }));
    saveState(baseCtx({ status: "second" }));
    saveState(baseCtx({ status: "third" }));
    const loaded = loadState({ lokiDirOverride: dir });
    expect(loaded.state?.status).toBe("third");
  });

  it("removes the .tmp.<pid> file on successful rename", () => {
    saveState(baseCtx());
    const remaining = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(remaining).toHaveLength(0);
  });

  it("interleaved writes from same pid only race the rename, not the body", () => {
    // Simulate a concurrent writer by manually creating an old tmp file -- the
    // next saveState should still complete and the orphan should be cleaned by
    // the load_state sweep (older than 5 min).
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, "autonomy-state.json.tmp.999999");
    writeFileSync(orphan, "stale");
    const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(orphan, tenMinAgo, tenMinAgo);

    saveState(baseCtx());
    loadState({ lokiDirOverride: dir });
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("loadState: missing / fresh", () => {
  it("returns zeros and null state when file is absent", () => {
    const r = loadState({ lokiDirOverride: dir });
    expect(r.retryCount).toBe(0);
    expect(r.iterationCount).toBe(0);
    expect(r.state).toBeNull();
    expect(r.corrupted).toBe(false);
  });
});

describe("loadState: corrupt JSON -> backup + zero counters", () => {
  it("backs up unparseable JSON with .corrupt.<epoch> suffix", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "autonomy-state.json"), "{not json");
    const now = new Date("2026-04-25T12:00:00Z");
    const r = loadState({ lokiDirOverride: dir, now });
    expect(r.corrupted).toBe(true);
    expect(r.retryCount).toBe(0);
    expect(r.iterationCount).toBe(0);
    const epoch = Math.floor(now.getTime() / 1000);
    expect(existsSync(join(dir, `autonomy-state.json.corrupt.${epoch}`))).toBe(true);
    expect(existsSync(join(dir, "autonomy-state.json"))).toBe(false);
  });

  it("backs up structurally-invalid JSON (negative retryCount)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "autonomy-state.json"),
      JSON.stringify({ retryCount: -1, iterationCount: 0 }),
    );
    const r = loadState({ lokiDirOverride: dir });
    expect(r.corrupted).toBe(true);
  });

  it("backs up when type is wrong (string retryCount)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "autonomy-state.json"),
      JSON.stringify({ retryCount: "0", iterationCount: 0 }),
    );
    const r = loadState({ lokiDirOverride: dir });
    expect(r.corrupted).toBe(true);
  });
});

describe("loadState: terminal-status reset", () => {
  for (const term of ["failed", "max_iterations_reached", "max_retries_exceeded", "exited"]) {
    it(`resets counters when previous status was '${term}'`, () => {
      saveState(baseCtx({ retryCount: 9, iterationCount: 99, status: term }));
      const r = loadState({ lokiDirOverride: dir });
      expect(r.resetForNewSession).toBe(true);
      expect(r.retryCount).toBe(0);
      expect(r.iterationCount).toBe(0);
      // Underlying state still readable for diagnostics.
      expect(r.state?.status).toBe(term);
    });
  }

  it("does not reset for non-terminal statuses", () => {
    saveState(baseCtx({ retryCount: 4, iterationCount: 11, status: "running" }));
    const r = loadState({ lokiDirOverride: dir });
    expect(r.resetForNewSession).toBe(false);
    expect(r.retryCount).toBe(4);
    expect(r.iterationCount).toBe(11);
  });
});

describe("loadState: orphan tmp cleanup", () => {
  it("deletes *.tmp.* files older than 5 minutes in .loki/", () => {
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "autonomy-state.json.tmp.111");
    writeFileSync(old, "x");
    const sixMinAgo = (Date.now() - 6 * 60 * 1000) / 1000;
    utimesSync(old, sixMinAgo, sixMinAgo);

    loadState({ lokiDirOverride: dir });
    expect(existsSync(old)).toBe(false);
  });

  it("keeps recent *.tmp.* files (in-flight writes)", () => {
    mkdirSync(dir, { recursive: true });
    const fresh = join(dir, "autonomy-state.json.tmp.222");
    writeFileSync(fresh, "x");
    loadState({ lokiDirOverride: dir });
    expect(existsSync(fresh)).toBe(true);
  });

  it("also sweeps .loki/state/*.tmp.*", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    const old = join(dir, "state", "orchestrator.json.tmp.333");
    writeFileSync(old, "x");
    const sixMinAgo = (Date.now() - 6 * 60 * 1000) / 1000;
    utimesSync(old, sixMinAgo, sixMinAgo);
    loadState({ lokiDirOverride: dir });
    expect(existsSync(old)).toBe(false);
  });
});

describe("orchestrator.json", () => {
  it("write -> read preserves dashboard-critical fields", () => {
    writeOrchestratorState(
      {
        version: "7.3.0",
        currentPhase: "DESIGN",
        iteration: 4,
        complexity: "standard",
        startedAt: "2026-04-25T00:00:00Z",
        agents: {},
        metrics: { tasksCompleted: 5, tasksFailed: 1, retries: 0 },
      },
      { lokiDirOverride: dir },
    );
    const got = readOrchestratorState({ lokiDirOverride: dir });
    expect(got).not.toBeNull();
    expect(got?.currentPhase).toBe("DESIGN");
    expect(got?.iteration).toBe(4);
    expect(got?.complexity).toBe("standard");
    expect(got?.metrics?.tasksCompleted).toBe(5);
    expect(got?.metrics?.tasksFailed).toBe(1);
  });

  it("preserves unknown forward-compat fields", () => {
    writeOrchestratorState(
      // Cast through unknown to attach an extra field; readOrchestratorState
      // returns the raw record so future dashboard fields survive a round-trip.
      { currentPhase: "BUILD", customField: 42 } as unknown as Parameters<typeof writeOrchestratorState>[0],
      { lokiDirOverride: dir },
    );
    const got = readOrchestratorState({ lokiDirOverride: dir }) as Record<string, unknown>;
    expect(got["customField"]).toBe(42);
  });

  it("returns null when file is missing", () => {
    expect(readOrchestratorState({ lokiDirOverride: dir })).toBeNull();
  });

  it("returns null when JSON parses but currentPhase is missing", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "orchestrator.json"), JSON.stringify({ iteration: 1 }));
    expect(readOrchestratorState({ lokiDirOverride: dir })).toBeNull();
  });

  it("returns null on unparseable JSON (does not throw)", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "orchestrator.json"), "not json");
    expect(readOrchestratorState({ lokiDirOverride: dir })).toBeNull();
  });

  it("write is atomic: no .tmp.<pid> remains on success", () => {
    writeOrchestratorState({ currentPhase: "BOOTSTRAP" }, { lokiDirOverride: dir });
    const remaining = readdirSync(join(dir, "state")).filter((f) => f.includes(".tmp."));
    expect(remaining).toHaveLength(0);
  });
});

describe("readProviderName", () => {
  it("returns trimmed value", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "provider"), "claude\n");
    expect(readProviderName({ lokiDirOverride: dir })).toBe("claude");
  });

  it("returns null on missing file", () => {
    expect(readProviderName({ lokiDirOverride: dir })).toBeNull();
  });

  it("returns null on whitespace-only file", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "provider"), "   \n");
    expect(readProviderName({ lokiDirOverride: dir })).toBeNull();
  });
});

describe("updateStatusTxt", () => {
  it("writes contents and ensures trailing newline", () => {
    updateStatusTxt("Phase: implementation\nIteration: 7", { lokiDirOverride: dir });
    const raw = readFileSync(join(dir, "STATUS.txt"), "utf8");
    expect(raw).toBe("Phase: implementation\nIteration: 7\n");
  });

  it("does not double trailing newline if already present", () => {
    updateStatusTxt("hi\n", { lokiDirOverride: dir });
    const raw = readFileSync(join(dir, "STATUS.txt"), "utf8");
    expect(raw).toBe("hi\n");
  });

  it("creates .loki dir if missing", () => {
    expect(existsSync(dir)).toBe(false);
    updateStatusTxt("hi", { lokiDirOverride: dir });
    expect(existsSync(join(dir, "STATUS.txt"))).toBe(true);
  });
});

describe("atomicWriteFileSync (lower-level)", () => {
  it("creates a tmp file scoped to the current pid then renames", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "x.json");
    atomicWriteFileSync(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
    const tmps = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(tmps).toHaveLength(0);
  });
});

describe("saveState: in-process concurrent persists (L5 BUG-3 regression)", () => {
  // v7.5.10: with the inline 120s mtime-only lock from <=v7.5.9 a slow
  // legitimate writer could be displaced via the TOCTOU window between
  // statSync(lockPath) and unlinkSync(lockPath). We now delegate to
  // util/atomic.ts withFileLockSync which probes the holder pid via
  // process.kill(pid, 0). This regression test fires 10 concurrent
  // saveStates and verifies the surviving file is one valid JSON document
  // matching exactly one of the candidate writes -- no torn writes, no
  // truncation, no leftover tmp/lock sentinels.
  it("Promise.all of 10 concurrent saveState calls leaves one valid file", async () => {
    mkdirSync(dir, { recursive: true });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() =>
          saveState(
            baseCtx({
              retryCount: i,
              iterationCount: i * 100,
              status: `concurrent-${i}`,
              prdPath: `/tmp/prd-${i}.md`,
            }),
          ),
        ),
      ),
    );

    // All 10 calls returned the same target path (no rename to alt names).
    const target = results[0] as string;
    expect(target).toBeTruthy();
    expect(results.every((p) => p === target)).toBe(true);
    expect(existsSync(target)).toBe(true);

    // Surviving file must parse as valid JSON (no torn write).
    const raw = readFileSync(target, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();

    // Surviving file must equal exactly one of the 10 candidate writes.
    const loaded = loadState({ lokiDirOverride: dir });
    expect(loaded.state).not.toBeNull();
    const status = loaded.state?.status ?? "";
    expect(status).toMatch(/^concurrent-\d$/);
    const winner = Number.parseInt(status.replace("concurrent-", ""), 10);
    expect(loaded.state?.retryCount).toBe(winner);
    expect(loaded.state?.iterationCount).toBe(winner * 100);
    expect(loaded.state?.prdPath).toBe(`/tmp/prd-${winner}.md`);

    // No leftover tmp files (every winner's tmp got renamed; every loser
    // was serialized behind the lock so its tmp also renamed cleanly).
    const tmps = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(tmps).toEqual([]);

    // No leftover lockfile (every writer released in finally).
    const locks = readdirSync(dir).filter((f) => f.endsWith(".lock"));
    expect(locks).toEqual([]);
  });
});
