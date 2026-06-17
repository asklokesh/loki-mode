// Tests for src/runner/quality_gates.ts.
//
// Covers:
//   - Failure-count persistence (atomic, JSON round-trip, malformed-file recovery)
//   - clearGateFailure no-op on missing file, reset on existing file
//   - Escalation ladder boundaries: CLEAR_LIMIT, ESCALATE_LIMIT, PAUSE_LIMIT
//   - Orchestrator pass/fail aggregation, gate-failures.txt write+delete,
//     soft-gate path, runner-throws path.
//
// Strategy: each test uses an isolated temp dir; the override is threaded
// through ctx.lokiDir + the override args on track/clear so no production
// state is touched. Env overrides are scrubbed in afterEach.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearGateFailure,
  getGateFailureCount,
  runCodeReview,
  runDocQualityGate,
  runLSPDiagnostics,
  runMagicDebateGate,
  runInvariants,
  runQualityGates,
  runSemanticTests,
  runStaticAnalysis,
  runTestCoverage,
  selectReviewers,
  isHealingActive,
  trackGateFailure,
} from "../../src/runner/quality_gates.ts";
import type { ReviewerFn } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let scratch = "";

const ENV_KEYS = [
  "LOKI_GATE_CLEAR_LIMIT",
  "LOKI_GATE_ESCALATE_LIMIT",
  "LOKI_GATE_PAUSE_LIMIT",
  "LOKI_HARD_GATES",
  "PHASE_STATIC_ANALYSIS",
  "PHASE_UNIT_TESTS",
  "PHASE_CODE_REVIEW",
  "LOKI_GATE_DOC_COVERAGE",
  "LOKI_GATE_MAGIC_DEBATE",
  "LOKI_GATE_MOCK",
  "LOKI_GATE_MUTATION",
  "LOKI_STUB_GATE_STATIC_ANALYSIS",
  "LOKI_STUB_GATE_TEST_COVERAGE",
  "LOKI_STUB_GATE_CODE_REVIEW",
  "LOKI_STUB_GATE_DOC_COVERAGE",
  "LOKI_STUB_GATE_MAGIC_DEBATE",
  "LOKI_GATE_LSP_DIAGNOSTICS",
  "LOKI_STUB_GATE_LSP_DIAGNOSTICS",
  "LOKI_GATE_LSP_WRITER",
  "LOKI_GATE_SEMANTIC_TESTS",
  "LOKI_STUB_GATE_SEMANTIC_TESTS",
  "LOKI_SEMANTIC_DETECTOR",
  "LOKI_GATE_INVARIANTS",
  "LOKI_STUB_GATE_INVARIANTS",
  "LOKI_INVARIANT_DETECTOR",
];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-gates-test-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const k of ENV_KEYS) delete process.env[k];
});

function makeCtx(overrides: Partial<RunnerContext> = {}): RunnerContext {
  const logged: string[] = [];
  const ctx: RunnerContext = {
    cwd: scratch,
    lokiDir: scratch,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 5,
    maxIterations: 10,
    baseWaitSeconds: 1,
    maxWaitSeconds: 60,
    autonomyMode: "single-pass",
    sessionModel: "development",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 1,
    retryCount: 0,
    currentTier: "development",
    log: (line: string) => logged.push(line),
    ...overrides,
  };
  return ctx;
}

function gateFile(): string {
  return join(scratch, "quality", "gate-failure-count.json");
}

// --- Persistence ----------------------------------------------------------

describe("trackGateFailure / clearGateFailure persistence", () => {
  it("creates the file on first track and increments", () => {
    expect(trackGateFailure("static_analysis", scratch)).toBe(1);
    expect(trackGateFailure("static_analysis", scratch)).toBe(2);
    expect(existsSync(gateFile())).toBe(true);
    const parsed = JSON.parse(readFileSync(gateFile(), "utf-8")) as Record<string, number>;
    expect(parsed["static_analysis"]).toBe(2);
  });

  it("tracks distinct gates independently", () => {
    trackGateFailure("static_analysis", scratch);
    trackGateFailure("test_coverage", scratch);
    trackGateFailure("test_coverage", scratch);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(1);
    expect(getGateFailureCount("test_coverage", scratch)).toBe(2);
    expect(getGateFailureCount("code_review", scratch)).toBe(0);
  });

  it("clearGateFailure is a no-op when the file does not exist", () => {
    clearGateFailure("static_analysis", scratch);
    expect(existsSync(gateFile())).toBe(false);
  });

  it("clearGateFailure resets only the named gate", () => {
    trackGateFailure("static_analysis", scratch);
    trackGateFailure("test_coverage", scratch);
    clearGateFailure("static_analysis", scratch);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(0);
    expect(getGateFailureCount("test_coverage", scratch)).toBe(1);
  });

  it("recovers from a malformed JSON file by treating counts as empty", () => {
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(gateFile(), "{not json");
    // Match bash behavior: swallow JSONDecodeError, continue from {}.
    expect(trackGateFailure("static_analysis", scratch)).toBe(1);
  });

  it("ignores non-numeric values in the persisted file", () => {
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(gateFile(), JSON.stringify({ static_analysis: "bogus", test_coverage: 4 }));
    expect(getGateFailureCount("static_analysis", scratch)).toBe(0);
    expect(getGateFailureCount("test_coverage", scratch)).toBe(4);
  });

  // v7.5.7 parity: bash autonomy/run.sh:10966 calls clear_gate_failure() on
  // every passing gate; the TS orchestrator must do the same in the
  // runQualityGates for-loop. Seed the counter at 5 (above CLEAR_LIMIT) and
  // confirm that one passing iteration drops it to 0 on the next read.
  it("runQualityGates resets a prior failure count to 0 when the gate passes", async () => {
    // Seed the on-disk counter to 5 for static_analysis. Five trackGateFailure
    // calls is the same path the production loop uses, so the seed is durable
    // and uses the file's real schema.
    for (let i = 0; i < 5; i++) trackGateFailure("static_analysis", scratch);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(5);

    // Force every gate to pass so runQualityGates exercises the success
    // branch for static_analysis specifically.
    process.env["LOKI_STUB_GATE_STATIC_ANALYSIS"] = "pass";
    process.env["LOKI_STUB_GATE_TEST_COVERAGE"] = "pass";
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "pass";
    process.env["LOKI_STUB_GATE_DOC_COVERAGE"] = "pass";
    process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = "pass";

    const r = await runQualityGates(makeCtx());
    expect(r.failed).toEqual([]);
    expect(r.passed).toContain("static_analysis");
    expect(getGateFailureCount("static_analysis", scratch)).toBe(0);
  });
});

// --- Escalation ladder ----------------------------------------------------

describe("escalation ladder boundaries", () => {
  beforeEach(() => {
    process.env["LOKI_GATE_CLEAR_LIMIT"] = "3";
    process.env["LOKI_GATE_ESCALATE_LIMIT"] = "5";
    process.env["LOKI_GATE_PAUSE_LIMIT"] = "7";
    // Force the static_analysis gate to fail on every run.
    process.env["LOKI_STUB_GATE_STATIC_ANALYSIS"] = "fail";
    // Disable the other gates so we test one ladder at a time.
    process.env["PHASE_UNIT_TESTS"] = "false";
    process.env["PHASE_CODE_REVIEW"] = "false";
    process.env["LOKI_GATE_DOC_COVERAGE"] = "false";
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "false";
    process.env["LOKI_GATE_MOCK"] = "false";
    process.env["LOKI_GATE_MUTATION"] = "false";
  });

  it("counts failures normally below CLEAR_LIMIT (count 1, 2)", async () => {
    const ctx = makeCtx();
    const r1 = await runQualityGates(ctx);
    expect(r1.failed).toEqual(["static_analysis"]);
    expect(r1.passed).toEqual([]);
    expect(r1.blocked).toBe(true);
    expect(r1.escalated).toBe(false);

    const r2 = await runQualityGates(ctx);
    expect(r2.failed).toEqual(["static_analysis"]);
    expect(r2.escalated).toBe(false);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(2);
  });

  it("treats failures at CLEAR_LIMIT as passing (counter still climbs)", async () => {
    const ctx = makeCtx();
    await runQualityGates(ctx); // 1
    await runQualityGates(ctx); // 2
    const r3 = await runQualityGates(ctx); // 3 -- CLEAR_LIMIT
    expect(r3.passed).toEqual(["static_analysis"]);
    expect(r3.failed).toEqual([]);
    expect(r3.blocked).toBe(false);
    expect(r3.escalated).toBe(false);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(3);
  });

  it("escalates at ESCALATE_LIMIT and writes signals/GATE_ESCALATION", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 4; i++) await runQualityGates(ctx); // 1..4
    const r5 = await runQualityGates(ctx); // 5 -- ESCALATE_LIMIT
    expect(r5.escalated).toBe(true);
    expect(r5.failed).toEqual(["static_analysis"]);
    const sig = readFileSync(join(scratch, "signals", "GATE_ESCALATION"), "utf-8");
    expect(sig).toContain("ESCALATE");
    expect(sig).toContain("static_analysis");
    // PAUSE marker must NOT exist yet.
    expect(existsSync(join(scratch, "PAUSE"))).toBe(false);
  });

  it("forces PAUSE at PAUSE_LIMIT and writes the .loki/PAUSE marker", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 6; i++) await runQualityGates(ctx); // 1..6
    const r7 = await runQualityGates(ctx); // 7 -- PAUSE_LIMIT
    expect(r7.escalated).toBe(true);
    expect(existsSync(join(scratch, "PAUSE"))).toBe(true);
    const sig = readFileSync(join(scratch, "signals", "GATE_ESCALATION"), "utf-8");
    expect(sig.startsWith("PAUSE\n")).toBe(true);
    expect(sig).toContain("static_analysis");
    expect(sig).toContain("7 consecutive");
  });

  it("clears the counter on a subsequent passing run", async () => {
    const ctx = makeCtx();
    await runQualityGates(ctx); // count 1
    await runQualityGates(ctx); // count 2
    process.env["LOKI_STUB_GATE_STATIC_ANALYSIS"] = "pass";
    const r = await runQualityGates(ctx);
    expect(r.passed).toEqual(["static_analysis"]);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(0);
  });
});

// --- Orchestrator behavior ------------------------------------------------

describe("runQualityGates orchestration", () => {
  beforeEach(() => {
    // Force the real doc + magic gates into stub mode so this orchestration
    // block stays focused on aggregation logic rather than filesystem state.
    // Individual cases below override these as needed.
    process.env["LOKI_STUB_GATE_DOC_COVERAGE"] = "pass";
    process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = "pass";
  });

  it("returns all gates in passed[] when stubs default to pass", async () => {
    const r = await runQualityGates(makeCtx());
    expect(r.failed).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(r.escalated).toBe(false);
    // All seven gates enabled by default (mock_integrity and
    // mutation_integrity were added default-on; with no findings artifact
    // they pass honestly with a "gate did not run" detail).
    expect(r.passed).toEqual([
      "static_analysis",
      "test_coverage",
      "mock_integrity",
      "mutation_integrity",
      "code_review",
      "doc_coverage",
      "magic_debate",
    ]);
  });

  it("writes gate-failures.txt with comma-trailing list when blocked", async () => {
    process.env["LOKI_STUB_GATE_TEST_COVERAGE"] = "fail";
    process.env["LOKI_STUB_GATE_DOC_COVERAGE"] = "fail";
    const r = await runQualityGates(makeCtx());
    expect(r.failed).toEqual(["test_coverage", "doc_coverage"]);
    const body = readFileSync(join(scratch, "quality", "gate-failures.txt"), "utf-8");
    expect(body).toBe("test_coverage,doc_coverage,\n");
  });

  it("removes gate-failures.txt on a clean iteration", async () => {
    const target = join(scratch, "quality", "gate-failures.txt");
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(target, "stale,\n");
    const r = await runQualityGates(makeCtx());
    expect(r.blocked).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("respects PHASE_* toggles -- disabled gates do not run", async () => {
    process.env["PHASE_STATIC_ANALYSIS"] = "false";
    process.env["PHASE_UNIT_TESTS"] = "false";
    process.env["LOKI_GATE_DOC_COVERAGE"] = "false";
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "false";
    // mock_integrity and mutation_integrity are left default-on; with no
    // findings artifact they run and pass, so they appear in passed[]
    // ahead of code_review (sequence order).
    const r = await runQualityGates(makeCtx());
    expect(r.passed).toEqual(["mock_integrity", "mutation_integrity", "code_review"]);
  });

  it("soft-gate path (LOKI_HARD_GATES=false) only runs code_review and never blocks", async () => {
    process.env["LOKI_HARD_GATES"] = "false";
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "fail";
    const r = await runQualityGates(makeCtx());
    expect(r.failed).toEqual(["code_review"]);
    // Soft path: blocked stays false, escalation never fires.
    expect(r.blocked).toBe(false);
    expect(r.escalated).toBe(false);
    // No persistence in soft mode.
    expect(existsSync(join(scratch, "quality", "gate-failures.txt"))).toBe(false);
  });

  it("stops the pipeline after a PAUSE-level escalation", async () => {
    process.env["LOKI_GATE_CLEAR_LIMIT"] = "1";
    process.env["LOKI_GATE_ESCALATE_LIMIT"] = "2";
    process.env["LOKI_GATE_PAUSE_LIMIT"] = "1";
    process.env["LOKI_STUB_GATE_STATIC_ANALYSIS"] = "fail";
    // Mark test_coverage to fail too -- it must NOT run because static_analysis
    // pauses the pipeline first.
    process.env["LOKI_STUB_GATE_TEST_COVERAGE"] = "fail";
    const r = await runQualityGates(makeCtx());
    expect(r.escalated).toBe(true);
    expect(getGateFailureCount("static_analysis", scratch)).toBe(1);
    expect(getGateFailureCount("test_coverage", scratch)).toBe(0);
  });
});

// --- Real Phase 5 gate runners --------------------------------------------
//
// These exercise the actual subprocess-driven implementations of
// runStaticAnalysis and runTestCoverage. The fixture layout is built under
// `scratch` so the runners scan a hermetic directory tree instead of the
// real loki-mode repo.

describe("runStaticAnalysis (real Phase 5 implementation)", () => {
  // v7.5.12 (triage #12): the gate now derives its file list from
  // `git diff --name-only HEAD~1 HEAD` (with --cached then ls-files
  // fallbacks), instead of the hardcoded `autonomy/*.sh` + `scripts/*.js`
  // layout. Tests build a real git repo so the diff path is exercised.
  // The repo is initialized with two commits: a baseline commit (so
  // HEAD~1 exists), then a commit that introduces the files under test.
  function gitInit(dir: string): void {
    // Use Bun.spawnSync via Node child_process to avoid awaiting in the
    // setup helper (the it-blocks already await runStaticAnalysis).
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const opts = { cwd: dir, stdio: "ignore" as const };
    spawnSync("git", ["init", "-q", "-b", "main"], opts);
    spawnSync("git", ["config", "user.email", "test@loki.dev"], opts);
    spawnSync("git", ["config", "user.name", "Loki Test"], opts);
    spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
    // Baseline empty commit so HEAD~1 resolves after the next commit.
    writeFileSync(join(dir, ".gitkeep"), "");
    spawnSync("git", ["add", ".gitkeep"], opts);
    spawnSync("git", ["commit", "-q", "-m", "baseline"], opts);
  }
  function gitCommitAll(dir: string, msg: string): void {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const opts = { cwd: dir, stdio: "ignore" as const };
    spawnSync("git", ["add", "-A"], opts);
    spawnSync("git", ["commit", "-q", "-m", msg], opts);
  }

  it("flags an invalid .sh file in the diff and leaves the valid one alone", async () => {
    gitInit(scratch);
    mkdirSync(join(scratch, "autonomy"), { recursive: true });
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(join(scratch, "autonomy", "ok.sh"), "#!/bin/bash\necho hello\n");
    writeFileSync(join(scratch, "autonomy", "bad.sh"), "#!/bin/bash\necho \"oops\n");
    writeFileSync(join(scratch, "scripts", "ok.js"), "const x = 1;\n");
    gitCommitAll(scratch, "add fixtures");

    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("bad.sh");
    expect(r.detail ?? "").not.toContain("ok.sh:");
  });

  it("passes when all changed .sh and .js files are syntactically valid", async () => {
    gitInit(scratch);
    mkdirSync(join(scratch, "autonomy"), { recursive: true });
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(join(scratch, "autonomy", "a.sh"), "#!/bin/bash\nls\n");
    writeFileSync(join(scratch, "autonomy", "b.sh"), "true\n");
    writeFileSync(join(scratch, "scripts", "a.js"), "const x = 2;\n");
    gitCommitAll(scratch, "add fixtures");

    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("3 files clean");
  });

  it("returns pass with zero files when no changes touch .sh/.js", async () => {
    gitInit(scratch);
    // Only the baseline .gitkeep is tracked -- diff against HEAD~1 yields
    // nothing matching the filter, ls-files fallback also yields just
    // .gitkeep (no matching suffix). Either way the count is 0.
    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("0 files clean");
  });

  // v7.5.12 (triage #12): the bug. Pre-fix the gate hardcoded
  // `autonomy/*.sh` + `scripts/*.js`, so a USER repo with src/foo.js
  // would scan 0 files and silently report "0 files clean" -- meaning
  // the Bun route had NO static analysis on user code. This test pins
  // the new diff-based contract: a user-style layout (src/foo.js) IS
  // scanned, and the autonomy/*.sh path has no special standing.
  it("scans user-repo files (src/foo.js) via git diff, not just autonomy/scripts/", async () => {
    gitInit(scratch);
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src", "foo.js"), "const greeting = 'hi';\n");
    // Add a syntactically broken sibling to prove the scan is ACTUALLY
    // running (not just claiming "1 file clean" because of a no-op).
    writeFileSync(join(scratch, "src", "broken.js"), "const x = ;\n");
    gitCommitAll(scratch, "add user src");

    const r = await runStaticAnalysis(makeCtx());
    // Must FAIL because broken.js has a syntax error -- proves the
    // diff-based scan reached src/, not just empty autonomy/.
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("broken.js");
    // Must NOT mention autonomy -- it's not a privileged path anymore.
    expect(r.detail ?? "").not.toContain("autonomy/");
  });

  // v7.5.12 (triage #11/#13 sibling): when there is no HEAD~1 (single-
  // commit repo / shallow clone), the gate must fall through to
  // `git ls-files` and still scan tracked files instead of degrading to
  // a silent no-op. Without this fallback every fresh user repo would
  // lose static analysis on iteration 1.
  it("falls back to ls-files when HEAD~1 does not exist (single-commit repo)", async () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const opts = { cwd: scratch, stdio: "ignore" as const };
    spawnSync("git", ["init", "-q", "-b", "main"], opts);
    spawnSync("git", ["config", "user.email", "test@loki.dev"], opts);
    spawnSync("git", ["config", "user.name", "Loki Test"], opts);
    spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
    writeFileSync(join(scratch, "only.js"), "const x = 1;\n");
    spawnSync("git", ["add", "only.js"], opts);
    spawnSync("git", ["commit", "-q", "-m", "first"], opts);
    // No HEAD~1; --cached is empty post-commit; ls-files returns only.js.
    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("1 files clean");
  });

  // v7.5.12 Dev11 (R1 MED): a CLEAN post-commit state (HEAD~1 resolves,
  // diff succeeds with empty output) MUST be treated as "no changes this
  // iteration" -- gate passes with 0 files. Pre-Dev11 the empty-success
  // result fell through to `git ls-files`, scanning the entire repo on
  // every clean iteration. This pin: a populated repo with NO post-commit
  // diff must NOT mention any of the populated files (proving ls-files
  // was not invoked).
  it("treats clean post-commit state (empty diff, populated repo) as 0 files, not full-repo scan", async () => {
    gitInit(scratch);
    // Populate the repo with a syntactically broken file. If the gate
    // erroneously falls back to ls-files, broken.js would be scanned
    // and the gate would FAIL with a broken.js mention. The fix means
    // diff HEAD~1 HEAD is empty (clean) => 0 files => pass.
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src", "broken.js"), "const x = ;\n");
    gitCommitAll(scratch, "add broken file");
    // Second no-op commit so HEAD~1 -> HEAD diff is empty.
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const opts = { cwd: scratch, stdio: "ignore" as const };
    spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "noop"], opts);

    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("0 files clean");
    // Must NOT have scanned broken.js -- proves ls-files fallback did
    // NOT fire on a clean diff.
    expect(r.detail ?? "").not.toContain("broken.js");
  });

  // v7.5.12 carryover guard: a `.tsx` (or `.ts`) file in the diff must
  // NOT be passed to `node --check` -- doing so crashes with
  // ERR_UNKNOWN_FILE_EXTENSION. Same guarantee as pre-v7.5.12, now via
  // the regex skip in the diff loop instead of listFilesBySuffix scope.
  it("does not crash when a .tsx file is part of the diff", async () => {
    gitInit(scratch);
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src", "ok.js"), "const x = 1;\n");
    writeFileSync(
      join(scratch, "src", "foo.tsx"),
      "export const X = () => <div>hi</div>;\n",
    );
    writeFileSync(join(scratch, "guard.sh"), "#!/bin/bash\ntrue\n");
    gitCommitAll(scratch, "add tsx + sh + js");
    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("2 files clean");
  });

  // v7.5.10 parallelization guard preserved across the diff-based
  // refactor: 16 .sh files in the diff must complete in well under
  // sequential worst-case wallclock.
  it("runs many .sh files in parallel (wallclock < N * single-file-time)", async () => {
    gitInit(scratch);
    const FILE_COUNT = 16;
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(scratch, `f${i}.sh`), "#!/bin/bash\ntrue\n");
    }
    gitCommitAll(scratch, "add many sh");

    const tmpSingle = mkdtempSync(join(tmpdir(), "loki-gates-single-"));
    try {
      gitInit(tmpSingle);
      writeFileSync(join(tmpSingle, "only.sh"), "#!/bin/bash\ntrue\n");
      gitCommitAll(tmpSingle, "add one sh");
      const ctxSingle = makeCtx({ cwd: tmpSingle, lokiDir: tmpSingle });
      const t0 = Date.now();
      const rs = await runStaticAnalysis(ctxSingle);
      const singleMs = Date.now() - t0;
      expect(rs.passed).toBe(true);

      const t1 = Date.now();
      const r = await runStaticAnalysis(makeCtx());
      const parallelMs = Date.now() - t1;
      expect(r.passed).toBe(true);
      expect(r.detail ?? "").toContain(`${FILE_COUNT} files clean`);

      // The strict speedup bound (parallel beats ~4x single) is only a valid
      // expectation when there are multiple cores to parallelize across. On a
      // single-core / CPU-starved CI cell, 16 spawns run effectively serially
      // and the strict bound false-fails even though the code is correct. Gate
      // the strict assertion on core count; on low-core runners keep only the
      // always-true guard (parallel must still beat the sequential worst case)
      // plus a generous absolute ceiling so a genuinely-broken serialization
      // still trips it.
      const cores = cpus().length;
      const sequentialEstimate = FILE_COUNT * singleMs;
      if (cores >= 4) {
        const upperBound = Math.max(4 * singleMs, 1500);
        expect(parallelMs).toBeLessThan(upperBound);
      } else {
        // Low-core: only assert we are not pathologically slow. A generous
        // floor (8x single-file time, min 8s) catches a real no-parallelism
        // regression without false-failing on a starved runner.
        const looseBound = Math.max(8 * singleMs, 8000);
        expect(parallelMs).toBeLessThan(looseBound);
      }
      // Always valid regardless of core count: parallel must beat the naive
      // sequential worst-case estimate.
      expect(parallelMs).toBeLessThan(sequentialEstimate);
    } finally {
      rmSync(tmpSingle, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("runTestCoverage (real Phase 5 implementation)", () => {
  it("parses an existing .loki/quality/test-results.json (pass case)", async () => {
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(
      join(scratch, "quality", "test-results.json"),
      JSON.stringify({ pass: true, runner: "vitest", passed: 42, failed: 0 }),
    );
    const r = await runTestCoverage(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("vitest");
    expect(r.detail ?? "").toContain("passed=42");
  });

  it("parses an existing test-results.json (fail case via failed>0)", async () => {
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(
      join(scratch, "quality", "test-results.json"),
      JSON.stringify({ runner: "jest", passed: 10, failed: 3 }),
    );
    const r = await runTestCoverage(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("failed=3");
  });

  it("preserves the LOKI_STUB_GATE_TEST_COVERAGE=fail escape hatch", async () => {
    process.env["LOKI_STUB_GATE_TEST_COVERAGE"] = "fail";
    // Even with a passing artifact present the stub override must win so
    // existing orchestration tests can short-circuit subprocess execution.
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(
      join(scratch, "quality", "test-results.json"),
      JSON.stringify({ pass: true, passed: 1, failed: 0 }),
    );
    const r = await runTestCoverage(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("stub forced fail");
  });

  it("skips cleanly when no artifact and no package.json exist", async () => {
    // Fresh scratch -- no .loki/quality/test-results.json, no package.json.
    const r = await runTestCoverage(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("skipping");
  });
});

// --- Doc quality gate (real Phase 5 implementation) -----------------------

describe("runDocQualityGate (real Phase 5 implementation)", () => {
  // Helper: write the three required top-level docs with a header + body so
  // each case can selectively damage one of them.
  function writeRequiredDocs(
    overrides?: Partial<Record<"README.md" | "CLAUDE.md" | "SKILL.md", string>>,
  ) {
    const def = "# Heading\n\nThis is a long enough body to clear the minimum length threshold easily.\n";
    for (const name of ["README.md", "CLAUDE.md", "SKILL.md"] as const) {
      writeFileSync(join(scratch, name), overrides?.[name] ?? def);
    }
  }

  // v7.5.12 (triage #11): pre-fix the gate hard-required CLAUDE.md and
  // SKILL.md, which BLOCKED every external user's first iteration since
  // those are loki-mode-INTERNAL artifacts. Post-fix, only README.md is
  // required; CLAUDE.md and SKILL.md are recommended-only. This test pins
  // the new contract: a user repo with ONLY README.md (no CLAUDE.md or
  // SKILL.md) MUST pass the doc gate.
  it("passes on a user-style repo with only README.md present", async () => {
    writeFileSync(
      join(scratch, "README.md"),
      "# Project\n\nA real README body padded to clear the minimum length threshold easily.\n",
    );
    // Intentionally omit CLAUDE.md and SKILL.md -- this is the shape of
    // virtually every user repo `loki start` will run against.
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("clean");
  });

  it("still fails when README.md (the only required doc) is missing", async () => {
    // No README -- the one universally-required top-level doc.
    writeFileSync(join(scratch, "CLAUDE.md"), "# C\n\nbody body body body body body body body body.\n");
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("README.md");
    expect(r.detail ?? "").toContain("missing");
  });

  it("passes when all required docs are present and well-formed", async () => {
    writeRequiredDocs();
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("clean");
  });

  it("fails when a markdown link target does not resolve on disk", async () => {
    writeRequiredDocs({
      "README.md": "# R\n\nSee [missing](./does-not-exist.md) for details, body padding here.\n",
    });
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("broken link");
    expect(r.detail ?? "").toContain("does-not-exist.md");
  });

  it("fails when a doc has no markdown header", async () => {
    writeRequiredDocs({
      "SKILL.md": "Just a wall of prose with no header line at all, padded out to clear length minimum.\n",
    });
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("no markdown header");
  });

  it("fails when a doc is below the minimum length threshold", async () => {
    writeRequiredDocs({ "CLAUDE.md": "# x\n" });
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("below minimum length");
  });

  it("ignores external links and in-doc anchors", async () => {
    writeRequiredDocs({
      "README.md":
        "# R\n\n[external](https://example.com) and [anchor](#section) and [mailto](mailto:x@y.z) -- all fine padding.\n",
    });
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(true);
  });

  it("honors the LOKI_STUB_GATE_DOC_COVERAGE escape hatch", async () => {
    process.env["LOKI_STUB_GATE_DOC_COVERAGE"] = "fail";
    // Even with valid docs the stub override must win.
    writeRequiredDocs();
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("stub forced fail");
  });
});

// --- Magic debate gate (real Phase 5 implementation) ----------------------

describe("runMagicDebateGate (real Phase 5 implementation)", () => {
  function writeSpec(name: string, body: string) {
    const dir = join(scratch, ".loki", "magic", "specs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  }

  it("passes (skipped) when LOKI_GATE_MAGIC_DEBATE is not 'true'", async () => {
    // Default off per Phase 5 spec -- env unset means skip.
    writeSpec("comp.md", "# Comp\n\nNo pros or cons but gate must skip when env is off.\n");
    const r = await runMagicDebateGate(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("disabled");
  });

  it("passes when no specs directory exists (opt-in but empty)", async () => {
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "true";
    const r = await runMagicDebateGate(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("no specs dir");
  });

  it("fails when a spec is missing the 'Pros' section", async () => {
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "true";
    writeSpec("comp.md", "# Comp\n\n## Cons\n- one\n- two\n");
    const r = await runMagicDebateGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("Pros");
  });

  it("fails when a spec is missing the 'Cons' section", async () => {
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "true";
    writeSpec("comp.md", "# Comp\n\n## Pros\n- one\n- two\n");
    const r = await runMagicDebateGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("Cons");
  });

  it("passes when each spec has both Pros and Cons sections", async () => {
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "true";
    writeSpec("a.md", "# A\n\n## Pros\n- good\n\n## Cons\n- bad\n");
    writeSpec("b.md", "# B\n\n### PROS\n- great\n\n### cons\n- meh\n");
    const r = await runMagicDebateGate(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("2 spec(s) clean");
  });

  it("honors the LOKI_STUB_GATE_MAGIC_DEBATE escape hatch", async () => {
    process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = "fail";
    // Stub wins even though env-off would otherwise return pass.
    const r = await runMagicDebateGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("stub forced fail");
  });
});

// --- runSemanticTests (P1-3 Bun mirror -- spawns the detector script) -----
//
// The semantic gate SPAWNS tests/detect-semantic-test-problems.sh with
// --block-high and maps the detector's exit code: rc 2 -> BLOCK, everything
// else (0/124/absent/spawn-error/any-other) -> PASS. To keep the test
// deterministic and hermetic we point LOKI_SEMANTIC_DETECTOR at a tiny fixture
// detector under `scratch` that simply exits with a chosen code, instead of
// scanning the real loki-mode tree (whose evolving test files would make the
// verdict non-deterministic). This exercises the EXACT exit-code mapping the
// gate implements without coupling to the detector's heuristics.
describe("runSemanticTests (P1-3 spawn-based gate)", () => {
  // Write a fake detector script that exits with `code`, mark it executable,
  // and return its absolute path. Mirrors how the bash gate invokes the real
  // detector (bash <detector> --block-high) -- the gate calls `bash <path>`,
  // so the script does not even need a +x bit, but we set it anyway.
  function fakeDetector(code: number): string {
    const p = join(scratch, `fake-detector-${code}.sh`);
    writeFileSync(p, `#!/usr/bin/env bash\nexit ${code}\n`, { mode: 0o755 });
    return p;
  }

  it("does not run when the gate is off (default) via runQualityGates", async () => {
    // Default OFF: LOKI_GATE_SEMANTIC_TESTS unset. Even with a detector that
    // would BLOCK (rc 2), the orchestrator must never invoke it.
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(2);
    // Silence the other gates so the orchestration outcome is clean and we are
    // asserting purely on semantic_tests being absent.
    process.env["PHASE_STATIC_ANALYSIS"] = "false";
    process.env["PHASE_UNIT_TESTS"] = "false";
    process.env["LOKI_GATE_MOCK"] = "false";
    process.env["LOKI_GATE_MUTATION"] = "false";
    process.env["PHASE_CODE_REVIEW"] = "false";
    process.env["LOKI_GATE_DOC_COVERAGE"] = "false";
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "false";

    const outcome = await runQualityGates(makeCtx());
    expect(outcome.passed).not.toContain("semantic_tests");
    expect(outcome.failed).not.toContain("semantic_tests");
    expect(outcome.blocked).toBe(false);
  });

  it("runs and BLOCKS when on and the detector reports HIGH (exit 2)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(2);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("CRITICAL/HIGH");
  });

  it("passes when on and the detector is clean (exit 0)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(0);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("no blocking findings");
  });

  it("passes (deny-filter) when on and the detector times out (exit 124)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(124);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("timed out");
  });

  it("passes (deny-filter) when on and the detector exits with any other code", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(1);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("rc 1");
  });

  it("passes when the detector script is absent (never fabricates a verdict)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = join(scratch, "does-not-exist.sh");
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("detector not found");
  });

  it("BLOCKS through runQualityGates when on + HIGH (registered in sequence)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(2);
    // Quiet the other gates so the only failure is semantic_tests.
    process.env["PHASE_STATIC_ANALYSIS"] = "false";
    process.env["PHASE_UNIT_TESTS"] = "false";
    process.env["LOKI_GATE_MOCK"] = "false";
    process.env["LOKI_GATE_MUTATION"] = "false";
    process.env["PHASE_CODE_REVIEW"] = "false";
    process.env["LOKI_GATE_DOC_COVERAGE"] = "false";
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "false";

    const outcome = await runQualityGates(makeCtx());
    expect(outcome.failed).toContain("semantic_tests");
    expect(outcome.blocked).toBe(true);
  });

  it("runs the REAL detector against ctx.cwd and BLOCKS on a HIGH fixture (locks LOKI_SCAN_DIR wiring)", async () => {
    // Integration-flavored: no LOKI_SEMANTIC_DETECTOR override, so the gate
    // spawns the real tests/detect-semantic-test-problems.sh. This proves the
    // load-bearing LOKI_SCAN_DIR=ctx.cwd wiring -- if the gate scanned its own
    // SCRIPT_DIR/.. (loki's tree) instead of ctx.cwd, this hermetic fixture
    // would be invisible and the gate would not block. The fixture is the
    // detector's documented HIGH pattern: a var bound to a literal, asserted to
    // equal the SAME literal, with NO call in between (literal-via-variable echo).
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    const testFile = join(scratch, "fake.test.ts");
    writeFileSync(
      testFile,
      [
        "describe('fake', () => {",
        "  it('verifies nothing', () => {",
        '    const x = "hello";',
        '    expect(x).toBe("hello");',
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    // ctx.cwd === scratch (makeCtx default), which the gate passes as
    // LOKI_SCAN_DIR so the real detector scans this temp dir only.
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("CRITICAL/HIGH");
  });

  it("honors the LOKI_STUB_GATE_SEMANTIC_TESTS escape hatch", async () => {
    process.env["LOKI_STUB_GATE_SEMANTIC_TESTS"] = "fail";
    // Stub wins even with a clean detector.
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(0);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("stub forced fail");
  });

  // --- findings persistence parity (run.sh:8362-8383) --------------------
  //
  // The bash route captures the detector's 2>&1 output and writes the matching
  // severity lines to <lokiDir>/quality/semantic-findings.txt (blocking header
  // on rc 2, advisory header on rc 0 + MED/LOW), and removes the file otherwise
  // (deny-filter). These tests lock the Bun mirror to that byte-shape.

  // Fake detector that echoes the given severity lines then exits `code`.
  // Mirrors how the real detector prints "[HIGH] ..." lines before exiting.
  function fakeDetectorWithOutput(code: number, lines: string[]): string {
    const p = join(scratch, `fake-detector-out-${code}.sh`);
    const echoes = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
    writeFileSync(p, `#!/usr/bin/env bash\n${echoes}\nexit ${code}\n`, { mode: 0o755 });
    return p;
  }

  const findingsFile = () => join(scratch, "quality", "semantic-findings.txt");

  it("persists CRITICAL/HIGH findings with the blocking header on rc 2", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetectorWithOutput(2, [
      "[HIGH] fake.test.ts:4 literal-via-variable echo verifies nothing",
      "[MEDIUM] fake.test.ts:9 mock-return echoed back",
    ]);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(false);
    expect(existsSync(findingsFile())).toBe(true);
    const body = readFileSync(findingsFile(), "utf-8");
    expect(body).toContain("# Semantic test-authenticity findings (CRITICAL/HIGH block this completion)");
    expect(body).toContain("[HIGH] fake.test.ts:4 literal-via-variable echo verifies nothing");
    // All severities captured on a block (matches the bash grep on rc 2).
    expect(body).toContain("[MEDIUM] fake.test.ts:9 mock-return echoed back");
  });

  it("persists MED/LOW advisory findings with the advisory header on a clean pass (rc 0)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetectorWithOutput(0, [
      "[MEDIUM] fake.test.ts:9 mock-return echoed back",
      "[LOW] fake.test.ts:12 deleted assertion",
    ]);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(existsSync(findingsFile())).toBe(true);
    const body = readFileSync(findingsFile(), "utf-8");
    expect(body).toContain("# Semantic test advisory findings (MED/LOW, non-blocking)");
    expect(body).toContain("[MEDIUM] fake.test.ts:9 mock-return echoed back");
    expect(body).toContain("[LOW] fake.test.ts:12 deleted assertion");
  });

  it("does NOT write the findings file on a clean run with no severity lines (rc 0)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetectorWithOutput(0, [
      "Semantic test gate: PASS",
    ]);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(existsSync(findingsFile())).toBe(false);
  });

  it("clears a stale findings file on a clean run (deny-filter)", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    // Seed a stale findings file from a prior block.
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(findingsFile(), "# stale\n[HIGH] old finding\n");
    expect(existsSync(findingsFile())).toBe(true);
    process.env["LOKI_SEMANTIC_DETECTOR"] = fakeDetector(0);
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(existsSync(findingsFile())).toBe(false);
  });

  it("does NOT write the findings file when the detector is absent", async () => {
    process.env["LOKI_GATE_SEMANTIC_TESTS"] = "true";
    process.env["LOKI_SEMANTIC_DETECTOR"] = join(scratch, "does-not-exist.sh");
    const r = await runSemanticTests(makeCtx());
    expect(r.passed).toBe(true);
    expect(existsSync(findingsFile())).toBe(false);
  });
});

// --- runInvariants (P1-4 Bun mirror -- spawns the detector script) --------
//
// The invariant gate SPAWNS tests/detect-invariant-violations.sh with --strict
// and maps the detector's exit code: rc 1 -> BLOCK, everything else
// (0/124/absent/spawn-error/any-other) -> PASS. NOTE the exit-code contract
// DIFFERS from runSemanticTests (which blocks on rc 2 under --block-high): the
// invariant detector's --strict mode exits 1 on CRITICAL/HIGH and 0 otherwise
// (tests/detect-invariant-violations.sh:347-353). To keep the unit tests
// deterministic and hermetic we point LOKI_INVARIANT_DETECTOR at a tiny fixture
// detector under `scratch` that exits with a chosen code, exercising the EXACT
// exit-code mapping without coupling to the detector's heuristics. One
// integration-flavored test runs the REAL detector against a planted secret to
// prove the real script + the mapping fire together (non-vacuity).
describe("runInvariants (P1-4 spawn-based gate)", () => {
  function fakeDetector(code: number): string {
    const p = join(scratch, `fake-invariant-detector-${code}.sh`);
    writeFileSync(p, `#!/usr/bin/env bash\nexit ${code}\n`, { mode: 0o755 });
    return p;
  }

  // Silence every other gate so the orchestration outcome isolates invariants.
  function quietOtherGates(): void {
    process.env["PHASE_STATIC_ANALYSIS"] = "false";
    process.env["PHASE_UNIT_TESTS"] = "false";
    process.env["LOKI_GATE_MOCK"] = "false";
    process.env["LOKI_GATE_MUTATION"] = "false";
    process.env["PHASE_CODE_REVIEW"] = "false";
    process.env["LOKI_GATE_DOC_COVERAGE"] = "false";
    process.env["LOKI_GATE_MAGIC_DEBATE"] = "false";
  }

  it("does not run when the gate is off (default) via runQualityGates", async () => {
    // Default OFF: LOKI_GATE_INVARIANTS unset. Even with a detector that would
    // BLOCK (rc 1), the orchestrator must never invoke it (zero cost).
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(1);
    quietOtherGates();

    const outcome = await runQualityGates(makeCtx());
    expect(outcome.passed).not.toContain("invariants");
    expect(outcome.failed).not.toContain("invariants");
    expect(outcome.blocked).toBe(false);
  });

  it("runs and BLOCKS when on and the detector reports CRITICAL/HIGH (exit 1)", async () => {
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(1);
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("CRITICAL/HIGH");
  });

  it("passes when on and the detector is clean (exit 0)", async () => {
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(0);
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("no blocking violations");
  });

  it("passes (deny-filter) when on and the detector times out (exit 124)", async () => {
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(124);
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("timed out");
  });

  it("passes (deny-filter) when on and the detector exits with any other code", async () => {
    // rc 2 is NOT the invariant block code (it is the semantic gate's). Under
    // the invariant --strict contract only rc 1 blocks; rc 2 deny-filters.
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(2);
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("rc 2");
  });

  it("passes when the detector script is absent (never fabricates a verdict)", async () => {
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    process.env["LOKI_INVARIANT_DETECTOR"] = join(scratch, "does-not-exist.sh");
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("detector not found");
  });

  it("BLOCKS through runQualityGates when on + violation (registered in sequence)", async () => {
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(1);
    quietOtherGates();

    const outcome = await runQualityGates(makeCtx());
    expect(outcome.failed).toContain("invariants");
    expect(outcome.blocked).toBe(true);
  });

  it("runs the REAL detector against ctx.cwd and BLOCKS on a planted secret (locks LOKI_SCAN_DIR + non-vacuity)", async () => {
    // Integration-flavored: no LOKI_INVARIANT_DETECTOR override, so the gate
    // spawns the real tests/detect-invariant-violations.sh. This proves BOTH
    // the load-bearing LOKI_SCAN_DIR=ctx.cwd wiring (if the gate scanned its own
    // SCRIPT_DIR/.. instead of ctx.cwd this fixture would be invisible) AND that
    // the real script + the exit-code mapping fire together (non-vacuity). The
    // fixture is a realistic AWS access key that deliberately dodges the
    // detector's placeholder allowlist (NOT the AKIAIOSFODNN7EXAMPLE key).
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    const srcFile = join(scratch, "config.js");
    writeFileSync(
      srcFile,
      [
        "const aws = {",
        '  region: "us-east-1",',
        '  accessKeyId: "AKIA2J4K7LMNPQ6RSTUV",',
        "};",
        "module.exports = aws;",
        "",
      ].join("\n"),
    );
    // ctx.cwd === scratch (makeCtx default), passed as LOKI_SCAN_DIR so the real
    // detector scans this temp dir only.
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("CRITICAL/HIGH");
  });

  it("runs the REAL detector against a clean ctx.cwd and PASSES (no false fire)", async () => {
    // Non-false-fire proof: the real detector against a clean source tree must
    // NOT block. Mirrors the planted-secret test but with secret-free source.
    process.env["LOKI_GATE_INVARIANTS"] = "true";
    const srcFile = join(scratch, "app.js");
    writeFileSync(
      srcFile,
      [
        "function add(a, b) {",
        "  return a + b;",
        "}",
        "const apiKey = process.env.API_KEY;",
        '  console.log("service started on port", 3000);',
        "module.exports = { add };",
        "",
      ].join("\n"),
    );
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("no blocking violations");
  });

  it("honors the LOKI_STUB_GATE_INVARIANTS escape hatch", async () => {
    process.env["LOKI_STUB_GATE_INVARIANTS"] = "fail";
    // Stub wins even with a clean detector.
    process.env["LOKI_INVARIANT_DETECTOR"] = fakeDetector(0);
    const r = await runInvariants(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("stub forced fail");
  });
});

// --- runCodeReview (real Phase 5 selection + dispatch + aggregation) ------
//
// The reviewer dispatch itself remains stubbed (real provider wiring lands
// in v7.5.0+); these tests verify the SELECTION + AGGREGATION pipeline by
// injecting a deterministic ReviewerFn through opts.reviewer so no Claude /
// Codex / Gemini subprocess is ever spawned.

describe("runCodeReview (Phase 5 selection + dispatch + aggregation)", () => {
  const passReviewer: ReviewerFn = async () => "VERDICT: PASS\nFINDINGS:\n- None";

  function reviewDirs(): string[] {
    const root = join(scratch, "quality", "reviews");
    if (!existsSync(root)) return [];
    return readdirSync(root);
  }

  it("skips when there is no diff to review", async () => {
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "", files: "" },
      reviewer: passReviewer,
    });
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("no diff");
    // No review directory should be created on a no-op skip.
    expect(reviewDirs()).toEqual([]);
  });

  it("keyword scoring picks security-sentinel for security-related diffs", () => {
    const diff =
      "+ const password = req.body.password;\n+ if (auth(token)) {\n+   db.query(`SELECT * FROM u WHERE id=${id}`);\n+ }\n";
    const files = "src/auth/login.ts\n";
    const sel = selectReviewers(diff, files);
    // First reviewer is always architecture-strategist.
    expect(sel.reviewers[0]?.name).toBe("architecture-strategist");
    // Security must outrank others on this diff.
    const names = sel.reviewers.map((r) => r.name);
    expect(names).toContain("security-sentinel");
    expect(names.length).toBe(3);
  });

  it("always selects exactly 3 reviewers (architecture + 2 specialists)", () => {
    // Empty-keyword case still selects 3 (default fallback path).
    const sel = selectReviewers("only whitespace diff", "README.md\n");
    expect(sel.reviewers.length).toBe(3);
    expect(sel.reviewers[0]?.name).toBe("architecture-strategist");
    // Default fallback: security-sentinel + test-coverage-auditor.
    expect(sel.reviewers.slice(1).map((r) => r.name)).toEqual([
      "security-sentinel",
      "test-coverage-auditor",
    ]);
    // v7.4.20: legacy-healing-auditor is excluded from the default pool
    // unless healing mode is active; documented in skills/quality-gates.md.
    expect(sel.pool_size).toBe(4);
  });

  it("excludes legacy-healing-auditor by default even when 'refactor' or 'adapter' appears in diff", () => {
    // agentbudget regression: common tokens like "refactor"/"adapter" used to
    // trigger the auditor on greenfield projects, BLOCKing iterations on
    // missing characterization tests the project never agreed to maintain.
    const diff =
      "+ // refactor: extract the storage adapter\n+ class StorageAdapter { upload() {} }\n";
    const files = "src/storage/adapter.ts\n";
    const sel = selectReviewers(diff, files);
    const names = sel.reviewers.map((r) => r.name);
    expect(names).not.toContain("legacy-healing-auditor");
    expect(sel.pool_size).toBe(4);
  });

  it("includes legacy-healing-auditor when healingActive=true and keywords match", () => {
    const diff =
      "+ // refactor: extract the storage adapter\n+ class StorageAdapter { upload() {} }\n";
    const files = "src/storage/adapter.ts\n";
    const sel = selectReviewers(diff, files, { healingActive: true });
    const names = sel.reviewers.map((r) => r.name);
    expect(names).toContain("legacy-healing-auditor");
    expect(sel.pool_size).toBe(5);
  });

  it("isHealingActive returns true when LOKI_HEAL_MODE=true env is set", () => {
    const prev = process.env.LOKI_HEAL_MODE;
    process.env.LOKI_HEAL_MODE = "true";
    try {
      expect(isHealingActive(scratch)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LOKI_HEAL_MODE;
      else process.env.LOKI_HEAL_MODE = prev;
    }
  });

  it("isHealingActive returns false on a clean greenfield project", () => {
    const prev = process.env.LOKI_HEAL_MODE;
    delete process.env.LOKI_HEAL_MODE;
    try {
      expect(isHealingActive(scratch)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.LOKI_HEAL_MODE = prev;
    }
  });

  it("isHealingActive returns true when .loki/healing/friction-map.json exists", () => {
    const prev = process.env.LOKI_HEAL_MODE;
    delete process.env.LOKI_HEAL_MODE;
    try {
      const healingDir = join(scratch, ".loki", "healing");
      mkdirSync(healingDir, { recursive: true });
      writeFileSync(join(healingDir, "friction-map.json"), JSON.stringify({ entries: [] }));
      expect(isHealingActive(scratch)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.LOKI_HEAL_MODE = prev;
    }
  });

  it("writes aggregate.json with the documented shape on a clean review", async () => {
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "+ console.log('hi');\n", files: "src/x.ts\n" },
      reviewer: passReviewer,
    });
    expect(r.passed).toBe(true);

    const dirs = reviewDirs();
    expect(dirs.length).toBe(1);
    const reviewId = dirs[0]!;
    const aggPath = join(scratch, "quality", "reviews", reviewId, "aggregate.json");
    const agg = JSON.parse(readFileSync(aggPath, "utf-8")) as Record<string, unknown>;
    expect(agg["review_id"]).toBe(reviewId);
    expect(agg["iteration"]).toBe(1);
    expect(agg["pass_count"]).toBe(3);
    expect(agg["fail_count"]).toBe(0);
    expect(agg["has_blocking"]).toBe(false);
    expect(typeof agg["verdicts"]).toBe("string");
    expect(agg["verdicts"] as string).toContain("architecture-strategist:PASS");
  });

  it("writes per-reviewer .txt outputs alongside the prompt and selection", async () => {
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "+ const x = 1;\n", files: "src/x.ts\n" },
      reviewer: passReviewer,
    });
    expect(r.passed).toBe(true);
    const reviewId = reviewDirs()[0]!;
    const dir = join(scratch, "quality", "reviews", reviewId);
    // architecture-strategist is always present.
    const txt = readFileSync(join(dir, "architecture-strategist.txt"), "utf-8");
    expect(txt).toContain("VERDICT:");
    expect(txt).toContain("FINDINGS:");
    // selection.json mirrors selectReviewers() output shape.
    const selection = JSON.parse(readFileSync(join(dir, "selection.json"), "utf-8")) as {
      reviewers: Array<{ name: string; focus: string; checks: string }>;
      scores: Record<string, number>;
      pool_size: number;
    };
    expect(selection.reviewers.length).toBe(3);
    // v7.4.20: default pool excludes legacy-healing-auditor.
    expect(selection.pool_size).toBe(4);
    // Anti-sycophancy file written on unanimous pass.
    expect(existsSync(join(dir, "anti-sycophancy.txt"))).toBe(true);
  });

  it("blocks on a unanimous pass when the Devil's-Advocate raises blocking severity", async () => {
    const daBlockReviewer: ReviewerFn = async ({ reviewer }) =>
      reviewer.name === "devils-advocate"
        ? "VERDICT: FAIL\nFINDINGS:\n- [Critical] hidden untested error path the council missed"
        : "VERDICT: PASS\nFINDINGS:\n- None";
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "+ const x = 1;\n", files: "src/x.ts\n" },
      reviewer: daBlockReviewer,
    });
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("devil's advocate raised blocking severity");
  });

  it("blocks the gate when any reviewer reports [Critical] or [High]", async () => {
    let call = 0;
    const mixedReviewer: ReviewerFn = async () => {
      call += 1;
      if (call === 2) {
        return "VERDICT: FAIL\nFINDINGS:\n- [Critical] hardcoded secret in src/x.ts:3";
      }
      return "VERDICT: PASS\nFINDINGS:\n- None";
    };
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "+ const token = 'abc';\n", files: "src/x.ts\n" },
      reviewer: mixedReviewer,
    });
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("blocking severity");

    const reviewId = reviewDirs()[0]!;
    const agg = JSON.parse(
      readFileSync(join(scratch, "quality", "reviews", reviewId, "aggregate.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(agg["has_blocking"]).toBe(true);
    expect(agg["fail_count"]).toBe(1);
    expect(agg["pass_count"]).toBe(2);
  });

  it("does not block on FAIL with only Medium/Low severity findings", async () => {
    const lowFailReviewer: ReviewerFn = async ({ reviewer }) => {
      if (reviewer.name === "architecture-strategist") {
        return "VERDICT: FAIL\nFINDINGS:\n- [Medium] consider extracting helper";
      }
      return "VERDICT: PASS\nFINDINGS:\n- None";
    };
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "+ const a = 2;\n", files: "src/y.ts\n" },
      reviewer: lowFailReviewer,
    });
    expect(r.passed).toBe(true);
    const reviewId = reviewDirs()[0]!;
    const agg = JSON.parse(
      readFileSync(join(scratch, "quality", "reviews", reviewId, "aggregate.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(agg["has_blocking"]).toBe(false);
    expect(agg["fail_count"]).toBe(1);
    expect(agg["pass_count"]).toBe(2);
  });

  it("captures reviewer exceptions as a Critical FAIL (gate blocks)", async () => {
    const throwingReviewer: ReviewerFn = async ({ reviewer }) => {
      if (reviewer.name === "security-sentinel") throw new Error("provider down");
      return "VERDICT: PASS\nFINDINGS:\n- None";
    };
    const r = await runCodeReview(makeCtx(), {
      diffOverride: { diff: "+ const auth = true;\n", files: "src/auth.ts\n" },
      reviewer: throwingReviewer,
    });
    expect(r.passed).toBe(false);
    const reviewId = reviewDirs()[0]!;
    const txt = readFileSync(
      join(scratch, "quality", "reviews", reviewId, "security-sentinel.txt"),
      "utf-8",
    );
    expect(txt).toContain("[Critical]");
    expect(txt).toContain("provider down");
  });
});

// --- LSP diagnostics gate (P1-5) ------------------------------------------
//
// Artifact-reading gate, opt-in (default OFF). Writer PENDING (TODO(writer)
// in quality_gates.ts). These tests pin the runner's pass-through-on-absence
// honesty, the error/warning block policy, and the default-off sequence
// behavior so the gate never surprises a user without a language server.

describe("runLSPDiagnostics (P1-5 artifact-reading gate)", () => {
  beforeEach(() => {
    // These tests exercise the READER against pre-staged artifacts. Disable
    // the writer so its (correct) stale-artifact removal does not delete the
    // fixtures, and so a machine WITH a language server does not enumerate
    // loki's own diff into the scratch dir.
    process.env["LOKI_GATE_LSP_WRITER"] = "0";
  });

  function writeArtifact(obj: unknown) {
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(join(scratch, "quality", "lsp-diagnostics.json"), JSON.stringify(obj));
  }

  it("passes with honest 'gate did not run' detail when the artifact is absent", async () => {
    // No writer ran / LSP not available. Must NOT block and must NOT phrase
    // absence as "clean".
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("lsp not available");
    expect(r.detail ?? "").toContain("gate did not run");
    expect(r.detail ?? "").not.toContain("clean");
  });

  it("blocks when the artifact reports one or more errors (count_errors > 0)", async () => {
    writeArtifact({ count_errors: 2, count_warnings: 1, diagnostics: [] });
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("2 error(s)");
  });

  it("counts severity-1 diagnostics as errors when count_errors is absent", async () => {
    writeArtifact({
      diagnostics: [
        { severity: 1, message: "Cannot find name 'foo'" },
        { severity: 2, message: "unused var" },
      ],
    });
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("1 error(s)");
  });

  it("passes with an advisory detail when only warnings are present", async () => {
    writeArtifact({ count_errors: 0, count_warnings: 3, diagnostics: [] });
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("3 warning(s)");
    expect(r.detail ?? "").toContain("advisory");
  });

  it("passes cleanly when there are zero errors and zero warnings", async () => {
    writeArtifact({ count_errors: 0, count_warnings: 0, diagnostics: [] });
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("0 errors, 0 warnings");
  });

  it("honors the LOKI_STUB_GATE_LSP_DIAGNOSTICS escape hatch", async () => {
    process.env["LOKI_STUB_GATE_LSP_DIAGNOSTICS"] = "fail";
    // Even with a clean artifact present the stub override must win.
    writeArtifact({ count_errors: 0, count_warnings: 0, diagnostics: [] });
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("stub forced fail");
  });
});

describe("runQualityGates LSP-diagnostics toggle (default OFF)", () => {
  beforeEach(() => {
    // Keep the other real gates in stub mode so this block focuses on the
    // lsp_diagnostics sequence membership, not unrelated gate state.
    process.env["LOKI_STUB_GATE_STATIC_ANALYSIS"] = "pass";
    process.env["LOKI_STUB_GATE_TEST_COVERAGE"] = "pass";
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "pass";
    process.env["LOKI_STUB_GATE_DOC_COVERAGE"] = "pass";
    process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = "pass";
    // Reader-only fixtures: disable the writer (see the artifact-reading
    // describe block above for the rationale).
    process.env["LOKI_GATE_LSP_WRITER"] = "0";
  });

  it("does NOT run lsp_diagnostics by default (absent from passed[] and failed[])", async () => {
    const r = await runQualityGates(makeCtx());
    expect(r.passed).not.toContain("lsp_diagnostics");
    expect(r.failed).not.toContain("lsp_diagnostics");
  });

  it("runs and passes lsp_diagnostics when toggled on with no artifact (honest pass-through)", async () => {
    process.env["LOKI_GATE_LSP_DIAGNOSTICS"] = "true";
    const r = await runQualityGates(makeCtx());
    expect(r.passed).toContain("lsp_diagnostics");
    expect(r.failed).not.toContain("lsp_diagnostics");
    expect(r.blocked).toBe(false);
  });

  it("blocks via lsp_diagnostics when toggled on and the artifact reports errors", async () => {
    process.env["LOKI_GATE_LSP_DIAGNOSTICS"] = "true";
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(
      join(scratch, "quality", "lsp-diagnostics.json"),
      JSON.stringify({ count_errors: 1, count_warnings: 0, diagnostics: [] }),
    );
    const r = await runQualityGates(makeCtx());
    expect(r.failed).toContain("lsp_diagnostics");
    expect(r.blocked).toBe(true);
  });
});

// --- LSP diagnostics WRITER invocation (P1-5 closing the loop) -------------
//
// The gate now INVOKES the Python writer (mcp/lsp_proxy.py
// --write-diagnostics) before reading the artifact, so the gate is no longer
// inert. This block exercises the real writer subprocess end-to-end (NOT a
// stub): it must (a) not crash the gate, (b) write NOTHING when no changed
// file maps to a detected language server, and (c) leave the gate on its
// honest "did not run" absence path -- never a fabricated clean verdict. This
// is the hermetic, deny-filter half of the proof: it runs identically on any
// machine regardless of which (if any) language servers are installed, because
// the scratch dir has no source files the writer would query. The non-vacuity
// half (real severity-1 error -> blocking artifact) is proven against the
// writer's aggregation layer in mcp/tests/test_lsp_proxy.py
// (DiagnosticsWriterTests.test_real_error_recorded_and_blocks).
describe("runLSPDiagnostics writer invocation (no-false-fire)", () => {
  it("invokes the writer, writes no artifact for an empty scratch repo, and passes on the honest absence path", async () => {
    // Writer ENABLED (default). The scratch lokiDir has no source files that
    // map to any language server, so the writer must produce no artifact.
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("gate did not run");
    expect(r.detail ?? "").not.toContain("clean");
    // The writer must NOT have manufactured an artifact from a no-op run.
    expect(existsSync(join(scratch, "quality", "lsp-diagnostics.json"))).toBe(false);
  }, 130_000);

  it("removes a stale artifact when a later run measures nothing (no permanent block)", async () => {
    // Pre-stage a stale 'errors present' artifact, then run the gate with the
    // writer enabled. Because the scratch repo has nothing the writer can
    // measure, the writer must delete the stale artifact, so the gate falls
    // back to the honest absence path instead of blocking forever on last
    // iteration's errors.
    mkdirSync(join(scratch, "quality"), { recursive: true });
    writeFileSync(
      join(scratch, "quality", "lsp-diagnostics.json"),
      JSON.stringify({ count_errors: 9, count_warnings: 0, diagnostics: [] }),
    );
    const r = await runLSPDiagnostics(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("gate did not run");
    expect(existsSync(join(scratch, "quality", "lsp-diagnostics.json"))).toBe(false);
  }, 130_000);
});
