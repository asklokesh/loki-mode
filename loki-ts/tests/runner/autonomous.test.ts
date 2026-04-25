// Skeleton tests for runAutonomous() -- exercise control-flow branches with
// hermetic .loki/ tmpdirs and FakeProvider injection. No real provider is
// invoked; no network calls. The goal is to lock in the loop's exit
// conditions before the C1/C2/C3/B1 modules land.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runAutonomous } from "../../src/runner/autonomous.ts";
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
      baseOpts({ maxIterations: 1, maxRetries: 5, providerOverride: provider }),
    );
    expect(code).toBe(0);
    // 1 iteration runs (counter incremented to 1), then 2nd iteration aborts on max.
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
  });

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
        maxIterations: 3,
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
