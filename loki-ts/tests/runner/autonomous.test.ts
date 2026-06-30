// Skeleton tests for runAutonomous() -- exercise control-flow branches with
// hermetic .loki/ tmpdirs and FakeProvider injection. No real provider is
// invoked; no network calls. The goal is to lock in the loop's exit
// conditions before the C1/C2/C3/B1 modules land.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runAutonomous, tryImport } from "../../src/runner/autonomous.ts";
import { saveStateForRunner as realSaveStateForRunner } from "../../src/runner/state.ts";
import type {
  Clock,
  CouncilHook,
  ProviderInvocation,
  ProviderInvoker,
  ProviderResult,
  RunnerContext,
  RunnerOpts,
  RunnerStateMod,
  SignalSource,
} from "../../src/runner/types.ts";

// ---------------------------------------------------------------------------
// Test doubles.
// ---------------------------------------------------------------------------

class FakeProvider implements ProviderInvoker {
  public calls: ProviderInvocation[] = [];
  constructor(private readonly results: ProviderResult[]) {}
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

class FakeSignals implements SignalSource {
  public interventions: (0 | 1 | 2)[] = [];
  public budgetExceeded = false;
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    return this.interventions.shift() ?? 0;
  }
  async isBudgetExceeded(): Promise<boolean> {
    return this.budgetExceeded;
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

class FakeCouncil implements CouncilHook {
  constructor(private readonly verdicts: boolean[]) {}
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    return this.verdicts.shift() ?? false;
  }
}

// v7.4.4 (BUG-24) regression guard. Mirrors the StopAfterNSignals pattern in
// autonomous_budget.test.ts (which proves the budgetMod adapter ran by
// asserting signals.budgetCheckCount === 0). The analog here proves the
// stateMod adapter ran by asserting saveCallCount > 0 and loadCallCount === 1.
// If autonomous.ts ever falls back to the no-op throw branch (state.ts not
// loadable / signature mismatch like BUG-24), saveCallCount stays at 0 and
// the loop dies on the FATAL throw.
//
// The fake calls through to the real saveStateForRunner so the on-disk
// autonomy-state.json is a real artifact we can validate the schema of.
type SaveCall = { status: string; exitCode: number; argCount: number };
class FakeStateMod implements RunnerStateMod {
  public saveCallCount = 0;
  public loadCallCount = 0;
  public saveCalls: SaveCall[] = [];
  async loadStateForRunner(_ctx: RunnerContext): Promise<void> {
    this.loadCallCount += 1;
    // No-op load -- we want the runner to start from a clean counter pair.
  }
  async saveStateForRunner(
    ctx: RunnerContext,
    status: string,
    exitCode: number,
  ): Promise<void> {
    this.saveCallCount += 1;
    this.saveCalls.push({ status, exitCode, argCount: arguments.length });
    // Delegate to the real adapter so the on-disk JSON exists and we can
    // assert its camelCase schema in the test below.
    await realSaveStateForRunner(ctx, status, exitCode);
  }
}

// ---------------------------------------------------------------------------
// Hermetic tmpdir per-test.
// ---------------------------------------------------------------------------

let tmpRoot: string;
let lokiDir: string;
let logLines: string[];
const logStream = {
  write(line: string | Uint8Array): boolean {
    logLines.push(typeof line === "string" ? line.trimEnd() : new TextDecoder().decode(line).trimEnd());
    return true;
  },
};

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "loki-runner-test-"));
  lokiDir = resolve(tmpRoot, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  logLines = [];
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function baseOpts(overrides: Partial<RunnerOpts> = {}): RunnerOpts {
  return {
    cwd: tmpRoot,
    provider: "claude",
    autonomyMode: "checkpoint",
    maxRetries: 3,
    maxIterations: 5,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    sessionModel: "sonnet",
    loggerStream: logStream as unknown as NodeJS.WritableStream,
    clock: new FakeClock(),
    signals: new FakeSignals(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runAutonomous", () => {
  it("exits cleanly on STOP signal", async () => {
    const signals = new FakeSignals();
    signals.interventions = [2];
    const provider = new FakeProvider([]);
    const code = await runAutonomous(baseOpts({ signals, providerOverride: provider }));
    expect(code).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("re-checks loop on PAUSE signal then exits when STOP follows", async () => {
    const signals = new FakeSignals();
    signals.interventions = [1, 2];
    const provider = new FakeProvider([]);
    const code = await runAutonomous(baseOpts({ signals, providerOverride: provider }));
    expect(code).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("returns 0 when max iterations reached", async () => {
    const provider = new FakeProvider([{ exitCode: 1, capturedOutputPath: "" }]);
    const code = await runAutonomous(
      baseOpts({ maxIterations: 2, maxRetries: 5, providerOverride: provider }),
    );
    expect(code).toBe(0);
    // maxIterations:2 -> 1 real iteration runs (counter increments to 1, not
    // >= 2), then the 2nd pass increments to 2 and aborts on max via `>=`,
    // mirroring bash run.sh:9896 (`-ge`). Was maxIterations:1 with strict `>`,
    // which let one iteration run; under `>=` maxIterations:1 would abort before
    // any provider call, so we use 2 to preserve the "one iteration runs" check.
    expect(provider.calls.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // BUG-2 parity proofs: max-iterations boundary (`>=` not `>`) and default
  // (1000 not 100). Source of truth: bash check_max_iterations (run.sh:9896,
  // `-ge`), evaluated AFTER the post-increment at run.sh:12889; default
  // MAX_ITERATIONS (run.sh:619, `${LOKI_MAX_ITERATIONS:-1000}`) and
  // build_prompt.ts:1160 (`envInt(env, "MAX_ITERATIONS", 1000)`).
  // ---------------------------------------------------------------------------

  it("BUG-2 boundary: max-iterations check is `>=` (matches bash -ge), not `>`", async () => {
    // With maxIterations=2 and a never-stop council, bash runs exactly ONE real
    // iteration: the counter post-increments to 1 (1 >= 2 is false, provider
    // runs), then the next pass increments to 2 (2 >= 2 is true, abort BEFORE
    // the provider call). So the stub provider is invoked exactly once.
    //
    // Non-vacuity: with the pre-fix strict `>`, the counter would have to reach
    // 3 to abort, so the provider would have been invoked TWICE -- this `toBe(1)`
    // would fail against the old comparison. The off-by-one was Bun running one
    // extra iteration past the cap relative to bash.
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([false, false, false]); // never stop
    const code = await runAutonomous(
      baseOpts({ maxIterations: 2, maxRetries: 5, providerOverride: provider, council }),
    );
    expect(code).toBe(0);
    expect(provider.calls.length).toBe(1);
  });

  it("BUG-2 default: unset maxIterations reads MAX_ITERATIONS env (not a hardcoded 100)", async () => {
    // Fast proof that the default path is envIntLocal("MAX_ITERATIONS", 1000),
    // not a hardcoded constant: omit maxIterations and set MAX_ITERATIONS=3.
    // The loop must abort at 3 via max_iterations_reached -- exactly 2 real
    // iterations run (post-increment 1,2 then 3 >= 3 aborts). A hardcoded 100
    // default would ignore the env entirely and run far past 3.
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([false, false, false, false]); // never stop
    const opts = baseOpts({ maxRetries: 5, providerOverride: provider, council });
    delete (opts as Partial<RunnerOpts>).maxIterations;
    const prevEnv = process.env["MAX_ITERATIONS"];
    process.env["MAX_ITERATIONS"] = "3";
    try {
      const code = await runAutonomous(opts);
      expect(code).toBe(0);
      expect(provider.calls.length).toBe(2);
      const state = JSON.parse(
        readFileSync(resolve(lokiDir, "autonomy-state.json"), "utf8"),
      ) as { status: string };
      expect(state.status).toBe("max_iterations_reached");
    } finally {
      if (prevEnv === undefined) delete process.env["MAX_ITERATIONS"];
      else process.env["MAX_ITERATIONS"] = prevEnv;
    }
  });

  it(
    "BUG-2 default: maxIterations defaults to 1000 (not 100) when both opt and env are unset",
    async () => {
      // Omit maxIterations AND env so makeContext applies the bare 1000 default.
      // We run 101 real iterations (council stops on the 101st). If the default
      // were still 100, the loop would have aborted via max_iterations_reached at
      // 100 (100 provider calls) before the council's stop fired. Reaching 101
      // iterations proves the cap is > 100, i.e. 1000.
      //
      // Non-vacuity: against the old `?? 100` default this would see only 100
      // provider calls and a max_iterations_reached terminal -- both fail.
      const STOP_AT = 101;
      const verdicts = Array.from({ length: STOP_AT }, (_, i) => i === STOP_AT - 1);
      const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
      const council = new FakeCouncil(verdicts);
      const opts = baseOpts({ maxRetries: 5, providerOverride: provider, council });
      delete (opts as Partial<RunnerOpts>).maxIterations;
      const prevEnv = process.env["MAX_ITERATIONS"];
      delete process.env["MAX_ITERATIONS"];
      try {
        const code = await runAutonomous(opts);
        expect(code).toBe(0);
        expect(provider.calls.length).toBe(STOP_AT);
      } finally {
        if (prevEnv === undefined) delete process.env["MAX_ITERATIONS"];
        else process.env["MAX_ITERATIONS"] = prevEnv;
      }
    },
    60_000,
  );

  it("returns 1 when max retries exceeded on persistent failure", async () => {
    const provider = new FakeProvider([{ exitCode: 1, capturedOutputPath: "" }]);
    const code = await runAutonomous(
      baseOpts({ maxRetries: 2, maxIterations: 100, providerOverride: provider }),
    );
    expect(code).toBe(1);
    expect(provider.calls.length).toBe(2);
  });

  it("returns 0 when council votes STOP after a successful iteration", async () => {
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([true]);
    const code = await runAutonomous(
      baseOpts({ providerOverride: provider, council, autonomyMode: "checkpoint" }),
    );
    expect(code).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });

  it("returns 0 when completion promise text appears in captured output", async () => {
    const promise = "All PRD requirements implemented and tests passing";
    const captured = resolve(lokiDir, "logs", "iter-output-test.log");
    mkdirSync(resolve(lokiDir, "logs"), { recursive: true });
    writeFileSync(captured, `noise\n${promise}\nmore noise\n`);

    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: captured }]);
    const council = new FakeCouncil([false]);

    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        council,
        completionPromise: promise,
        autonomyMode: "checkpoint",
        maxIterations: 5,
      }),
    );
    expect(code).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // FIX A REWORK: the Bun runner honors the quality-gate verdict with bash
  // parity. A real code_review BLOCK (gated on hardGates) refuses completion;
  // any OTHER gate failure (e.g. test_coverage on a bare project) is advisory
  // and MUST NOT over-block a clean run. Source of truth: run.sh:16868-16930
  // (code_review is the only completion-refusing gate) and quality_gates.ts
  // (blocked = failed.length>0 on the hard-gates path only).
  //
  // These tests drive the REAL quality_gates.ts via per-gate stub env vars
  // (LOKI_STUB_GATE_<NAME>) and disable the unrelated gates so the outcome is
  // deterministic. They restore env in a finally so no cross-test leak.
  // ---------------------------------------------------------------------------

  // Toggle keys for every non-code_review gate, so a single-gate test is
  // hermetic regardless of what the bare temp dir would otherwise trip.
  const NON_CODE_REVIEW_GATE_TOGGLES = [
    "PHASE_STATIC_ANALYSIS",
    "PHASE_UNIT_TESTS",
    "LOKI_GATE_MOCK",
    "LOKI_GATE_MUTATION",
    "LOKI_GATE_SEMANTIC_TESTS",
    "LOKI_GATE_INVARIANTS",
    "LOKI_GATE_DOC_COVERAGE",
    "LOKI_GATE_MAGIC_DEBATE",
    "LOKI_GATE_LSP_DIAGNOSTICS",
  ];

  async function withEnv(
    vars: Record<string, string>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prior[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k] of Object.entries(vars)) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  }

  it("FIX A: a real code_review BLOCK (hardGates) refuses completion even when the council votes STOP", async () => {
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    // Council would vote STOP on iteration 1; the code_review BLOCK must
    // override that and force another iteration instead of council_approved.
    const council = new FakeCouncil([true, true]);
    const fakeStateMod = new FakeStateMod();
    await withEnv(
      {
        LOKI_HARD_GATES: "true",
        PHASE_CODE_REVIEW: "true",
        LOKI_STUB_GATE_CODE_REVIEW: "fail",
        // Disable every other gate so this run is deterministic.
        ...Object.fromEntries(NON_CODE_REVIEW_GATE_TOGGLES.map((k) => [k, "0"])),
      },
      async () => {
        const code = await runAutonomous(
          baseOpts({
            providerOverride: provider,
            council,
            stateOverride: fakeStateMod,
            autonomyMode: "checkpoint",
            // maxIterations:2 -> iter 1 runs (code_review blocks, completion
            // refused), iter 2 hits the cap and exits 0 via
            // max_iterations_reached. Bounded.
            maxIterations: 2,
            maxRetries: 5,
          }),
        );
        // Loop terminates via max-iterations, not the council vote.
        expect(code).toBe(0);
        // Exactly one provider call: iter 1 ran, then the cap aborted iter 2.
        expect(provider.calls.length).toBe(1);
        // The decisive assertion: completion was REFUSED, so the run never
        // recorded council_approved (nor completion_promise_fulfilled). The only
        // terminal status is max_iterations_reached.
        const statuses = fakeStateMod.saveCalls.map((c) => c.status);
        expect(statuses).not.toContain("council_approved");
        expect(statuses).not.toContain("completion_promise_fulfilled");
        expect(statuses).toContain("max_iterations_reached");
      },
    );
  });

  it("FIX A: a non-code_review gate failure does NOT over-block a clean run (council STOP completes)", async () => {
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([true]); // STOP on iteration 1
    const fakeStateMod = new FakeStateMod();
    await withEnv(
      {
        LOKI_HARD_GATES: "true",
        // code_review passes; only test_coverage fails. Under the broken broad
        // `blocked||escalated` logic this would refuse completion (the bug this
        // rework fixes); under bash-parity semantics it must complete.
        PHASE_CODE_REVIEW: "true",
        LOKI_STUB_GATE_CODE_REVIEW: "pass",
        PHASE_UNIT_TESTS: "true",
        LOKI_STUB_GATE_TEST_COVERAGE: "fail",
        // Disable the remaining gates so test_coverage is the sole failure.
        PHASE_STATIC_ANALYSIS: "0",
        LOKI_GATE_MOCK: "0",
        LOKI_GATE_MUTATION: "0",
        LOKI_GATE_SEMANTIC_TESTS: "0",
        LOKI_GATE_INVARIANTS: "0",
        LOKI_GATE_DOC_COVERAGE: "0",
        LOKI_GATE_MAGIC_DEBATE: "0",
        LOKI_GATE_LSP_DIAGNOSTICS: "0",
      },
      async () => {
        const code = await runAutonomous(
          baseOpts({
            providerOverride: provider,
            council,
            stateOverride: fakeStateMod,
            autonomyMode: "checkpoint",
            maxIterations: 5,
            maxRetries: 5,
          }),
        );
        expect(code).toBe(0);
        // The council STOP was honored after exactly one iteration: a clean run
        // is NOT over-blocked by the advisory test_coverage failure.
        expect(provider.calls.length).toBe(1);
        const statuses = fakeStateMod.saveCalls.map((c) => c.status);
        expect(statuses).toContain("council_approved");
      },
    );
  });

  it("FIX A non-vacuity: with hard gates OFF, even a code_review fail stays advisory (council STOP completes)", async () => {
    // Mirrors run.sh:16977-16981 (soft-gates path: code_review is advisory and
    // never refuses completion). quality_gates.ts forces blocked=false on this
    // path, so the refusal condition (blocked && includes code_review) is never
    // met. This pins that hardGates is a true precondition of the refusal.
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([true]);
    const fakeStateMod = new FakeStateMod();
    await withEnv(
      {
        LOKI_HARD_GATES: "false",
        PHASE_CODE_REVIEW: "true",
        LOKI_STUB_GATE_CODE_REVIEW: "fail",
      },
      async () => {
        const code = await runAutonomous(
          baseOpts({
            providerOverride: provider,
            council,
            stateOverride: fakeStateMod,
            autonomyMode: "checkpoint",
            maxIterations: 5,
            maxRetries: 5,
          }),
        );
        expect(code).toBe(0);
        expect(provider.calls.length).toBe(1);
        const statuses = fakeStateMod.saveCalls.map((c) => c.status);
        expect(statuses).toContain("council_approved");
      },
    );
  });

  it("provider success path: invokes FakeProvider with a non-empty prompt", async () => {
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([true]); // stop after iter 1 so test is bounded
    const code = await runAutonomous(baseOpts({ providerOverride: provider, council }));
    expect(code).toBe(0);
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.provider).toBe("claude");
    expect(call.prompt.length).toBeGreaterThan(0);
    expect(call.iterationOutputPath.length).toBeGreaterThan(0);
  });

  // v7.4.4 (BUG-24) regression guard -- analog of the BUG-22
  // signals.budgetCheckCount === 0 assertion in autonomous_budget.test.ts.
  //
  // BUG-24: state.ts's public saveState(ctx) takes a single SaveStateContext.
  // Calling it with the runner's (ctx, status, exitCode) silently produced
  // malformed JSON. The fix added saveStateForRunner as an adapter and made
  // tryImport gate on it. This test proves:
  //   (1) the adapter path was taken (load called once, save many times);
  //       if the FATAL no-op fallback fired instead, the first persistState
  //       would throw and saveCallCount would be 0
  //   (2) every saveStateForRunner call received the (ctx, status, exitCode)
  //       3-arg shape with a recognized status enum and a numeric exitCode
  //   (3) the on-disk autonomy-state.json matches the camelCase contract
  //       (retryCount, iterationCount, status, lastExitCode, lastRun,
  //        prdPath, pid, maxRetries, baseWait)
  it("BUG-24 regression: saveStateForRunner adapter is invoked with 3-arg shape and writes camelCase JSON", async () => {
    const fakeStateMod = new FakeStateMod();
    const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
    const council = new FakeCouncil([false, false, false]); // never stop on council
    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        council,
        stateOverride: fakeStateMod,
        autonomyMode: "checkpoint",
        // maxIterations:4 so exactly 3 real iterations run before the cap. Under
        // bash parity (run.sh:12889 post-increment then run.sh:9896 `-ge`), the
        // counter increments to 1,2,3 (none >= 4), then increments to 4 and
        // aborts -- 3 provider calls. (Was 3 here when the Bun loop used strict
        // `>`, which ran one extra iteration vs bash; the parity fix to `>=`
        // makes maxIterations:3 yield only 2 iterations, so we bump to 4 to keep
        // this test's "3 iterations" intent intact.)
        maxIterations: 4,
        maxRetries: 5,
        prdPath: "/tmp/test-prd.md",
      }),
    );

    // Loop terminates at iteration 4 via max_iterations_reached -> exit 0.
    expect(code).toBe(0);

    // (1) adapter-path proof.
    expect(fakeStateMod.loadCallCount).toBe(1);
    expect(fakeStateMod.saveCallCount).toBeGreaterThan(0);
    // 3 iterations of (running, exited) + 1 max_iterations_reached = 7 saves.
    expect(fakeStateMod.saveCallCount).toBe(7);
    // Provider must have been invoked exactly 3 times (once per iteration).
    expect(provider.calls.length).toBe(3);

    // (2) arg-shape proof: every saveCall received exactly 3 args, status is
    //     a known enum value, exitCode is a number.
    const validStatuses = new Set([
      "paused",
      "stopped",
      "budget_exceeded",
      "policy_blocked",
      "max_iterations_reached",
      "running",
      "exited",
      "council_approved",
      "completion_promise_fulfilled",
      "failed",
    ]);
    for (const call of fakeStateMod.saveCalls) {
      expect(call.argCount).toBe(3);
      expect(typeof call.exitCode).toBe("number");
      expect(validStatuses.has(call.status)).toBe(true);
    }

    // Sanity: must observe at least one "running" and one "exited" save
    // (proves per-iteration state-machine transitions happened) plus the
    // terminal "max_iterations_reached".
    const seen = new Set(fakeStateMod.saveCalls.map((c) => c.status));
    expect(seen.has("running")).toBe(true);
    expect(seen.has("exited")).toBe(true);
    expect(seen.has("max_iterations_reached")).toBe(true);

    // (3) on-disk schema proof: autonomy-state.json must exist and parse
    //     as a strict camelCase record. BUG-24 produced malformed JSON;
    //     this assertion catches that class of regression.
    const statePath = resolve(lokiDir, "autonomy-state.json");
    expect(existsSync(statePath)).toBe(true);
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    for (const key of [
      "retryCount",
      "iterationCount",
      "status",
      "lastExitCode",
      "lastRun",
      "prdPath",
      "pid",
      "maxRetries",
      "baseWait",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(typeof parsed["retryCount"]).toBe("number");
    expect(typeof parsed["iterationCount"]).toBe("number");
    expect(typeof parsed["status"]).toBe("string");
    expect(typeof parsed["lastExitCode"]).toBe("number");
    expect(typeof parsed["lastRun"]).toBe("string");
    expect(typeof parsed["prdPath"]).toBe("string");
    expect(typeof parsed["pid"]).toBe("number");
    expect(typeof parsed["maxRetries"]).toBe("number");
    expect(typeof parsed["baseWait"]).toBe("number");
    // Final state should reflect the terminal transition.
    expect(parsed["status"]).toBe("max_iterations_reached");
    expect(parsed["prdPath"]).toBe("/tmp/test-prd.md");
    expect(parsed["maxRetries"]).toBe(5);
  });

  // v7.5.8: tryImport must throw a clear error if a loaded module is missing
  // an expected export. Pre-v7.5.8 the function ended in `return mod as
  // unknown as T` after a side-effecting key check, which silently lied to
  // the type system if the key validator drifted. Now: file-not-found still
  // returns null (graceful Phase-4 stub fallback), but a loaded-but-missing
  // export raises with the spec path AND the offending key in the message.
  it("tryImport throws a clear error when a loaded module is missing a required export", async () => {
    const stubPath = resolve(tmpRoot, "stub-module.mjs");
    // Module exposes `present` as a function but is MISSING `absent`. Both
    // are listed as required, so the second key triggers the throw.
    writeFileSync(
      stubPath,
      "export function present(){ return 42; }\n",
    );

    let err: unknown;
    try {
      await tryImport(stubPath, ["present", "absent"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain(stubPath);
    expect(msg).toContain("absent");
    expect(msg).toContain("missing");

    // Sanity: when all required keys are present and are functions, the
    // module loads normally. Preserves pre-existing behavior.
    const ok = await tryImport<{ present: () => number }>(stubPath, ["present"]);
    expect(ok).not.toBeNull();
    expect(ok!.present()).toBe(42);

    // Sanity: file-not-found still returns null (graceful fallback path used
    // by phase-4 sibling modules that haven't landed yet).
    const missing = await tryImport(resolve(tmpRoot, "does-not-exist.mjs"), ["foo"]);
    expect(missing).toBeNull();
  });

  // v7.5.10 (L5 BUG-9): the runner used to log the RARV phase but never
  // persist it. The dashboard polls `.loki/state/orchestrator.json` every 2s
  // for `currentPhase`, so it always rendered the bootstrap phase. This
  // test asserts that after each iteration the file is updated to the
  // RARV phase that matches `getRarvPhaseName(iterationCount)`. iter 1 ->
  // ACT, iter 2 -> REFLECT, iter 3 -> VERIFY (iter 0 -> REASON, but the
  // loop pre-increments iterationCount before computing the phase, so the
  // first observed phase is iter 1's ACT; we run enough iterations to
  // hit each branch).
  it("L5 BUG-9: RARV phase is persisted to orchestrator.json each iteration", async () => {
    // Pin LOKI_DIR for the duration of this test so we don't depend on
    // whatever the host shell exported.
    const prevLokiDir = process.env["LOKI_DIR"];
    process.env["LOKI_DIR"] = lokiDir;
    try {
      const fakeStateMod = new FakeStateMod();
      const provider = new FakeProvider([{ exitCode: 0, capturedOutputPath: "" }]);
      const council = new FakeCouncil([false, false, false, false]);
      const code = await runAutonomous(
        baseOpts({
          providerOverride: provider,
          council,
          stateOverride: fakeStateMod,
          autonomyMode: "checkpoint",
          // maxIterations:4 so exactly 3 real iterations run before the cap,
          // matching bash parity (run.sh:12889 post-increment then run.sh:9896
          // `-ge`). Was 3; bumped to 4 when the Bun loop switched from strict
          // `>` to `>=` (the parity fix), since `>=` aborts one iteration
          // earlier. Keeps the "last persisted phase is iteration 3" intent.
          maxIterations: 4,
          maxRetries: 5,
          prdPath: "/tmp/test-prd.md",
        }),
      );
      expect(code).toBe(0);

      // After max_iterations_reached the loop has run iters 1..3 plus the
      // post-increment that triggers termination. The last persisted phase
      // is from iteration 3 -> VERIFY. We assert the file exists, parses,
      // and contains a RarvPhase string.
      const orchestratorPath = resolve(lokiDir, "state", "orchestrator.json");
      expect(existsSync(orchestratorPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(orchestratorPath, "utf8")) as Record<string, unknown>;
      expect(typeof parsed["currentPhase"]).toBe("string");
      const validPhases = new Set(["REASON", "ACT", "REFLECT", "VERIFY"]);
      expect(validPhases.has(parsed["currentPhase"] as string)).toBe(true);
      // Iteration 3 -> VERIFY (per rarv.getRarvPhaseName).
      expect(parsed["currentPhase"]).toBe("VERIFY");
      // iteration field is also persisted so the dashboard can correlate.
      expect(parsed["iteration"]).toBe(3);
    } finally {
      if (prevLokiDir === undefined) {
        delete process.env["LOKI_DIR"];
      } else {
        process.env["LOKI_DIR"] = prevLokiDir;
      }
    }
  });

  it("perpetual mode never stops on council true; retries exhaust eventually", async () => {
    const provider = new FakeProvider([
      { exitCode: 0, capturedOutputPath: "" },
      { exitCode: 1, capturedOutputPath: "" },
      { exitCode: 1, capturedOutputPath: "" },
    ]);
    const council = new FakeCouncil([true, true]); // would stop in checkpoint mode
    const code = await runAutonomous(
      baseOpts({
        autonomyMode: "perpetual",
        providerOverride: provider,
        council,
        maxRetries: 2,
        maxIterations: 50,
      }),
    );
    // Hits max retries on the failing iterations -- council ignored.
    expect(code).toBe(1);
  });
});
