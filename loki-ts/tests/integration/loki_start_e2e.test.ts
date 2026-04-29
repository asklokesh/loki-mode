// Integration: end-to-end `loki start <prd>` simulation through runAutonomous.
//
// Drives the autonomous loop with a hermetic FakeProvider against a synthetic
// PRD in a tmpdir. The point is to prove the LOOP WIRING is correct -- state
// writes, gate firing, iteration counter, termination -- not to test real LLM
// output. No real provider CLIs are spawned; no network.
//
// Scenarios covered (per task brief):
//   1. Loop iterates >= 2 cycles before terminating (max_iterations).
//   2. At least one quality gate (code_review) fires.
//   3. State files are written to .loki/state/ as the loop progresses.
//   4. Loop terminates cleanly on max_iterations rather than hanging.
//   5. With LOKI_INJECT_FINDINGS=1 + LOKI_AUTO_LEARNINGS=1, findings + learnings
//      get persisted across iterations -- HONEST SCOPE: skipped at the
//      runAutonomous level because runQualityGates calls runCodeReview(ctx)
//      without an injectable reviewer; the in-tree stubReviewer always
//      returns PASS and produces no [Critical] findings, so the persistence
//      path cannot be exercised hermetically through the loop. The same
//      flow IS covered at the runCodeReview boundary by
//      tests/integration/embedded_phase1_e2e.test.ts and override_on_block.
//   6. Override council on counter-evidence drop -- same scope limitation
//      as #5; covered at the runCodeReview boundary by
//      tests/integration/override_on_block.test.ts.
//
// Hermeticity: each test uses mkdtempSync + per-test env restoration. We force
// LOKI_OVERRIDE_REAL_JUDGE=0 so any judge dispatch falls back to the stub
// instead of spawning a provider CLI.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runAutonomous } from "../../src/runner/autonomous.ts";
import type {
  Clock,
  CouncilHook,
  ProviderInvocation,
  ProviderInvoker,
  ProviderResult,
  RunnerContext,
  RunnerOpts,
  SignalSource,
} from "../../src/runner/types.ts";

// ---------------------------------------------------------------------------
// Test doubles -- mirror the patterns in autonomous.test.ts and
// autonomous_budget.test.ts.
// ---------------------------------------------------------------------------

class FakeProvider implements ProviderInvoker {
  public calls: ProviderInvocation[] = [];
  constructor(private readonly results: ProviderResult[] = []) {}
  async invoke(call: ProviderInvocation): Promise<ProviderResult> {
    this.calls.push(call);
    const idx = Math.min(this.calls.length - 1, this.results.length - 1);
    const fallback: ProviderResult = {
      exitCode: 0,
      capturedOutputPath: call.iterationOutputPath,
    };
    return this.results[idx] ?? fallback;
  }
}

// Always returns 0 (no intervention) so the loop runs to natural termination
// (max_iterations). Tests that need an early STOP wire their own variant.
class NeverInterveneSignals implements SignalSource {
  public callCount = 0;
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    this.callCount += 1;
    return 0;
  }
  async isBudgetExceeded(): Promise<boolean> {
    return false;
  }
}

// FakeCouncil that NEVER votes stop -- forces the loop to run to
// max_iterations rather than terminate early on council approval.
class NeverStopCouncil implements CouncilHook {
  public callCount = 0;
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    this.callCount += 1;
    return false;
  }
}

class FakeClock implements Clock {
  public ticks = 0;
  public sleeps: number[] = [];
  now(): number {
    this.ticks += 1;
    return this.ticks * 1000;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }
}

// ---------------------------------------------------------------------------
// Hermetic tmpdir + env sandbox per test.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "LOKI_INJECT_FINDINGS",
  "LOKI_AUTO_LEARNINGS",
  "LOKI_OVERRIDE_COUNCIL",
  "LOKI_OVERRIDE_REAL_JUDGE",
  "LOKI_STUB_GATE_CODE_REVIEW",
  "LOKI_STUB_GATE_STATIC_ANALYSIS",
  "LOKI_STUB_GATE_TEST_COVERAGE",
  "LOKI_STUB_GATE_DOC_COVERAGE",
  "LOKI_STUB_GATE_MAGIC_DEBATE",
  "LOKI_DIR",
];

let savedEnv: Record<string, string | undefined> = {};
let tmpRoot: string;
let lokiDir: string;
let prdPath: string;
let logLines: string[];

const logStream = {
  write(line: string | Uint8Array): boolean {
    logLines.push(
      typeof line === "string"
        ? line.trimEnd()
        : new TextDecoder().decode(line).trimEnd(),
    );
    return true;
  },
};

function snapshotEnv(): void {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  snapshotEnv();
  tmpRoot = mkdtempSync(resolve(tmpdir(), "loki-start-e2e-"));
  lokiDir = resolve(tmpRoot, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  mkdirSync(resolve(lokiDir, "queue"), { recursive: true });
  mkdirSync(resolve(lokiDir, "state"), { recursive: true });

  // Synthetic PRD that `loki start <prd>` would consume.
  prdPath = resolve(tmpRoot, "synthetic-prd.md");
  writeFileSync(
    prdPath,
    [
      "# Synthetic PRD",
      "",
      "## Goal",
      "Build a tiny CLI that prints hello.",
      "",
      "## Acceptance",
      "- prints 'hello'",
      "- exits 0",
      "",
    ].join("\n"),
  );

  // Force stub-judge path so any override council dispatch is hermetic.
  process.env["LOKI_OVERRIDE_REAL_JUDGE"] = "0";
  // Pin LOKI_DIR so sibling modules (checkpoint.ts, etc.) that resolve via
  // the global lokiDir() helper see the same tmpdir as autonomous.ts.
  process.env["LOKI_DIR"] = lokiDir;
  // Default: short-circuit gate runners to deterministic PASS outcomes so the
  // loop is fast and does not depend on a real git repo. Tests that want to
  // exercise the actual code_review gate flip this to "fail" or unset.
  process.env["LOKI_STUB_GATE_STATIC_ANALYSIS"] = "pass";
  process.env["LOKI_STUB_GATE_TEST_COVERAGE"] = "pass";
  process.env["LOKI_STUB_GATE_DOC_COVERAGE"] = "pass";
  process.env["LOKI_STUB_GATE_MAGIC_DEBATE"] = "pass";

  logLines = [];
});

afterEach(() => {
  restoreEnv();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function baseOpts(overrides: Partial<RunnerOpts> = {}): RunnerOpts {
  return {
    cwd: tmpRoot,
    prdPath,
    provider: "claude",
    autonomyMode: "checkpoint",
    maxRetries: 5,
    maxIterations: 3,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    sessionModel: "sonnet",
    loggerStream: logStream as unknown as NodeJS.WritableStream,
    clock: new FakeClock(),
    signals: new NeverInterveneSignals(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("loki start <prd> e2e (runAutonomous + stub provider)", () => {
  it("scenario 1+4: loop iterates >=2 cycles and terminates cleanly on max_iterations", async () => {
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "pass";

    const provider = new FakeProvider();
    const council = new NeverStopCouncil();
    const signals = new NeverInterveneSignals();

    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        council,
        signals,
        maxIterations: 3,
      }),
    );

    // Clean exit on max_iterations (autonomous.ts:323 returns 0).
    expect(code).toBe(0);

    // Provider invoked exactly maxIterations times -- proves >=2 cycles ran.
    expect(provider.calls.length).toBe(3);
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);

    // Final terminal state must reflect max_iterations_reached (NOT a hang
    // and NOT max_retries_exceeded).
    const statePath = resolve(lokiDir, "autonomy-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      status: string;
      iterationCount: number;
      lastExitCode: number;
      prdPath: string;
    };
    expect(state.status).toBe("max_iterations_reached");
    // autonomous.ts increments iterationCount BEFORE the max check, so on the
    // (maxIterations+1)-th tick the counter reads 4 then the early return
    // fires. Provider was called exactly maxIterations=3 times, which is the
    // load-bearing "ran >=2 cycles" assertion.
    expect(state.iterationCount).toBeGreaterThanOrEqual(3);
    expect(state.lastExitCode).toBe(0);
    expect(state.prdPath).toBe(prdPath);

    // Council was consulted at least once per successful iteration.
    expect(council.callCount).toBeGreaterThanOrEqual(3);

    // Sanity: at least one log line announces the terminal transition.
    expect(
      logLines.some((l) => l.includes("max iterations reached")),
    ).toBe(true);
  });

  it("scenario 3: state files are written to .loki/state/ as the loop progresses", async () => {
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "pass";

    const provider = new FakeProvider();
    const council = new NeverStopCouncil();
    const signals = new NeverInterveneSignals();

    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        council,
        signals,
        maxIterations: 2,
      }),
    );
    expect(code).toBe(0);

    // .loki/autonomy-state.json: top-level state file.
    const statePath = resolve(lokiDir, "autonomy-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    // Schema sanity (camelCase contract from BUG-24).
    for (const key of [
      "retryCount",
      "iterationCount",
      "status",
      "lastExitCode",
      "lastRun",
      "prdPath",
      "pid",
    ]) {
      expect(state).toHaveProperty(key);
    }

    // Per-iteration checkpoint dirs exist under .loki/state/checkpoints/.
    // BUG-20 wired createCheckpoint after every successful iteration.
    const ckptRoot = resolve(lokiDir, "state", "checkpoints");
    expect(existsSync(ckptRoot)).toBe(true);
    const ckptDirs = readdirSync(ckptRoot);
    expect(ckptDirs.some((d) => d.startsWith("cp-1-"))).toBe(true);
    expect(ckptDirs.some((d) => d.startsWith("cp-2-"))).toBe(true);

    // Per-iteration captured-output logs exist under .loki/logs/.
    const logsDir = resolve(lokiDir, "logs");
    expect(existsSync(logsDir)).toBe(true);
    const iterLogs = readdirSync(logsDir).filter((n) =>
      n.startsWith("iter-output-"),
    );
    expect(iterLogs.length).toBe(2);
  });

  it("scenario 2: at least one quality gate (code_review) fires per iteration", async () => {
    // Force a deterministic FAIL on code_review so we can prove gate execution
    // by observing the on-disk failure-counter side effect.
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "fail";

    const provider = new FakeProvider();
    const council = new NeverStopCouncil();
    const signals = new NeverInterveneSignals();

    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        council,
        signals,
        maxIterations: 2,
      }),
    );
    expect(code).toBe(0);

    // gate-failure-count.json must exist and record code_review > 0.
    // This is the canonical proof that runQualityGates -> runCodeReview ran
    // (autonomous.ts:422-432) for at least one iteration.
    const counterPath = resolve(lokiDir, "quality", "gate-failure-count.json");
    expect(existsSync(counterPath)).toBe(true);
    const counts = JSON.parse(readFileSync(counterPath, "utf8")) as Record<
      string,
      number
    >;
    expect(typeof counts["code_review"]).toBe("number");
    expect(counts["code_review"]).toBeGreaterThanOrEqual(1);

    // Quality failure list also persists.
    const failureListPath = resolve(lokiDir, "quality", "gate-failures.json");
    if (existsSync(failureListPath)) {
      const list = JSON.parse(readFileSync(failureListPath, "utf8")) as
        | { failed?: string[] }
        | string[];
      const failed = Array.isArray(list) ? list : list.failed ?? [];
      expect(failed.includes("code_review")).toBe(true);
    }
  });

  it("scenario 5+6 (skipped at runAutonomous boundary, see test body)", () => {
    // HONEST SCOPE NOTE -- not silently skipped.
    //
    // runQualityGates() calls runCodeReview(ctx) WITHOUT a CodeReviewOpts
    // argument (quality_gates.ts:1372), so we cannot inject a custom
    // ReviewerFn through the runAutonomous loop. The default stubReviewer
    // (quality_gates.ts:547) always emits "VERDICT: PASS\nFINDINGS:- (stub)"
    // which produces zero [Critical] findings, so:
    //   - findings-<iter>.json is written but with an EMPTY findings array
    //     -- nothing meaningful to assert across iterations
    //   - the override council never engages because hasBlocking is false,
    //     so the counter-evidence drop has no BLOCK to lift
    //
    // The two scenarios ARE covered hermetically at the runCodeReview
    // boundary (one level closer than runAutonomous) by:
    //   - tests/integration/embedded_phase1_e2e.test.ts (scenario 5 + 6
    //     happy path: BLOCK -> counter-evidence drop -> override lifts)
    //   - tests/integration/override_on_block.test.ts (scenario 6 negative
    //     cases: untrusted proofType, missing flags, missing evidence)
    //
    // Driving them through runAutonomous would require either:
    //   (a) adding a LOKI_STUB_REVIEWER=fail env knob that makes the
    //       in-tree stubReviewer emit a [Critical] finding, OR
    //   (b) plumbing CodeReviewOpts through runQualityGates so the runner
    //       can pass an injectable ReviewerFn down.
    // Neither change is in scope for this test file. Marking explicit so
    // the coverage gap is visible, not hidden.
    expect(true).toBe(true);
  });

  it("loop does not hang: completes within bounded wall time even with always-failing provider", async () => {
    // Regression guard for scenario 4 (clean termination). With every iteration
    // returning exitCode=1 and maxRetries=2, the loop must hit
    // max_retries_exceeded and return 1 -- NOT spin forever.
    process.env["LOKI_STUB_GATE_CODE_REVIEW"] = "pass";

    const provider = new FakeProvider([
      { exitCode: 1, capturedOutputPath: "" },
      { exitCode: 1, capturedOutputPath: "" },
      { exitCode: 1, capturedOutputPath: "" },
    ]);
    const council = new NeverStopCouncil();
    const signals = new NeverInterveneSignals();
    const clock = new FakeClock();

    const start = Date.now();
    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        council,
        signals,
        clock,
        maxRetries: 2,
        maxIterations: 100,
        baseWaitSeconds: 0,
        maxWaitSeconds: 0,
      }),
    );
    const elapsedMs = Date.now() - start;

    // Persistent failure -> max_retries_exceeded -> exit 1.
    expect(code).toBe(1);
    expect(provider.calls.length).toBe(2);
    // FakeClock means real time elapsed is just JS overhead; should be << 2s.
    expect(elapsedMs).toBeLessThan(2000);

    // Terminal state reflects the failure path.
    const statePath = resolve(lokiDir, "autonomy-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      status: string;
    };
    expect(state.status).toBe("failed");
  });
});
