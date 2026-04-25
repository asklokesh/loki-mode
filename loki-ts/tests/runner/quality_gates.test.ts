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
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearGateFailure,
  getGateFailureCount,
  runCodeReview,
  runDocQualityGate,
  runMagicDebateGate,
  runQualityGates,
  runStaticAnalysis,
  runTestCoverage,
  selectReviewers,
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
  "LOKI_STUB_GATE_STATIC_ANALYSIS",
  "LOKI_STUB_GATE_TEST_COVERAGE",
  "LOKI_STUB_GATE_CODE_REVIEW",
  "LOKI_STUB_GATE_DOC_COVERAGE",
  "LOKI_STUB_GATE_MAGIC_DEBATE",
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
    // All five gates enabled by default.
    expect(r.passed).toEqual([
      "static_analysis",
      "test_coverage",
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
    const r = await runQualityGates(makeCtx());
    expect(r.passed).toEqual(["code_review"]);
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
  it("flags the invalid .sh file and leaves the valid one alone", async () => {
    // Build fixture: autonomy/{ok.sh,bad.sh}, scripts/ok.js
    mkdirSync(join(scratch, "autonomy"), { recursive: true });
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(join(scratch, "autonomy", "ok.sh"), "#!/bin/bash\necho hello\n");
    // Unterminated quote -- bash -n must exit non-zero.
    writeFileSync(join(scratch, "autonomy", "bad.sh"), "#!/bin/bash\necho \"oops\n");
    writeFileSync(join(scratch, "scripts", "ok.js"), "const x = 1;\n");

    const ctx = makeCtx();
    const r = await runStaticAnalysis(ctx);
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("bad.sh");
    // Valid file should not appear in the failure summary.
    expect(r.detail ?? "").not.toContain("ok.sh:");
  });

  it("passes when all .sh and .js files are syntactically valid", async () => {
    mkdirSync(join(scratch, "autonomy"), { recursive: true });
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    writeFileSync(join(scratch, "autonomy", "a.sh"), "#!/bin/bash\nls\n");
    writeFileSync(join(scratch, "autonomy", "b.sh"), "true\n");
    writeFileSync(join(scratch, "scripts", "a.js"), "const x = 2;\n");

    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("3 files clean");
  });

  it("returns pass with zero files when neither directory exists", async () => {
    // scratch is fresh -- no autonomy/ or scripts/ subdir exists.
    const r = await runStaticAnalysis(makeCtx());
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("0 files clean");
  });
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

  it("fails when CLAUDE.md is missing", async () => {
    writeFileSync(join(scratch, "README.md"), "# R\n\nbody body body body body body body body body.\n");
    writeFileSync(join(scratch, "SKILL.md"), "# S\n\nbody body body body body body body body body.\n");
    const r = await runDocQualityGate(makeCtx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("CLAUDE.md");
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
    expect(sel.pool_size).toBe(5);
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
    expect(selection.pool_size).toBe(5);
    // Anti-sycophancy file written on unanimous pass.
    expect(existsSync(join(dir, "anti-sycophancy.txt"))).toBe(true);
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
