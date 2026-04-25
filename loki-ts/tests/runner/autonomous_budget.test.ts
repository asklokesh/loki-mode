// Integration test for the budget-exceeded path in runAutonomous.
//
// Background: v7.4.2 fix (BUG-22) wrapped checkBudgetLimit (object-returning,
// public API) in checkBudgetLimitForRunner (boolean-returning) so the loop
// no longer treated the truthy result object as "always over budget" -- which
// previously caused an infinite loop (sleep 60s, continue, repeat).
//
// That fix shipped without a positive integration test that actually exercises
// the over-budget branch. This file fills that gap: a future regression that
// re-introduces the bug (e.g. typoing the function name or reverting to the
// object-returning call) would either hang here or fail an assertion.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runAutonomous } from "../../src/runner/autonomous.ts";
import type {
  Clock,
  ProviderInvocation,
  ProviderInvoker,
  ProviderResult,
  RunnerContext,
  RunnerOpts,
  SignalSource,
} from "../../src/runner/types.ts";

// ---------------------------------------------------------------------------
// Test doubles -- mirror the patterns in autonomous.test.ts.
// ---------------------------------------------------------------------------

class FakeProvider implements ProviderInvoker {
  public calls: ProviderInvocation[] = [];
  async invoke(call: ProviderInvocation): Promise<ProviderResult> {
    this.calls.push(call);
    return { exitCode: 0, capturedOutputPath: call.iterationOutputPath };
  }
}

// Returns intervention=0 (no signal) for the first N calls, then 2 (STOP)
// thereafter. This guarantees test termination even if the budget path
// unexpectedly skips its branch.
class StopAfterNSignals implements SignalSource {
  public callCount = 0;
  public budgetCheckCount = 0;
  constructor(private readonly stopAfter: number) {}
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    this.callCount += 1;
    return this.callCount > this.stopAfter ? 2 : 0;
  }
  async isBudgetExceeded(): Promise<boolean> {
    // If this fires, the runner fell back to the SignalSource path -- which
    // means budgetMod failed to import (regression: someone removed or
    // renamed checkBudgetLimitForRunner). Track so the test can assert.
    this.budgetCheckCount += 1;
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
// Hermetic tmpdir + env-var sandbox per test.
// ---------------------------------------------------------------------------

let tmpRoot: string;
let lokiDir: string;
let logLines: string[];
let savedBudgetEnv: string | undefined;

const logStream = {
  write(line: string | Uint8Array): boolean {
    logLines.push(typeof line === "string" ? line.trimEnd() : new TextDecoder().decode(line).trimEnd());
    return true;
  },
};

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "loki-runner-budget-test-"));
  lokiDir = resolve(tmpRoot, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  logLines = [];
  savedBudgetEnv = process.env["BUDGET_LIMIT"];
});

afterEach(() => {
  if (savedBudgetEnv === undefined) {
    delete process.env["BUDGET_LIMIT"];
  } else {
    process.env["BUDGET_LIMIT"] = savedBudgetEnv;
  }
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
    ...overrides,
  };
}

// Seed an efficiency record whose computed cost vastly exceeds any reasonable
// budget. With model=opus, 100k input tokens + 50k output tokens cost
// (100000/1e6)*5 + (50000/1e6)*25 = 0.5 + 1.25 = 1.75 USD. Combined with
// cost_usd=1000 it sums to 1001.75, well over a 0.01 limit.
function seedEfficiencyOverBudget(): void {
  const dir = resolve(lokiDir, "metrics", "efficiency");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "iteration-1.json"),
    JSON.stringify({
      input_tokens: 100000,
      output_tokens: 50000,
      cost_usd: 1000,
      model: "opus",
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runAutonomous budget-exceeded path", () => {
  it("loops on budget exceeded, sleeps 60s each iteration, exits on STOP", async () => {
    seedEfficiencyOverBudget();
    process.env["BUDGET_LIMIT"] = "0.01";

    const provider = new FakeProvider();
    const signals = new StopAfterNSignals(3); // allow 3 budget-exceeded loops
    const clock = new FakeClock();

    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        signals,
        clock,
        // Pass through so checkBudgetLimitForRunner uses ctx.budgetLimit
        // even if BUDGET_LIMIT env was somehow unset.
        budgetLimit: 0.01,
      }),
    );

    // STOP signal terminates the loop cleanly.
    expect(code).toBe(0);

    // Provider must NEVER be invoked while over-budget. If checkBudgetLimitForRunner
    // returned the wrong shape (BUG-22 regression), the loop would still loop --
    // but seeing zero provider calls confirms the budget guard fired.
    expect(provider.calls.length).toBe(0);

    // PAUSE marker file written by checkBudgetLimit() side-effect.
    expect(existsSync(resolve(lokiDir, "PAUSE"))).toBe(true);

    // BUDGET_EXCEEDED signal payload written.
    const sigPath = resolve(lokiDir, "signals", "BUDGET_EXCEEDED");
    expect(existsSync(sigPath)).toBe(true);
    const sig = JSON.parse(readFileSync(sigPath, "utf8")) as {
      type: string;
      limit: number;
      current: number;
    };
    expect(sig.type).toBe("BUDGET_EXCEEDED");
    expect(sig.limit).toBe(0.01);
    expect(sig.current).toBeGreaterThan(0.01);

    // budget.json written and reflects exceeded=true.
    const budgetState = JSON.parse(
      readFileSync(resolve(lokiDir, "metrics", "budget.json"), "utf8"),
    ) as { exceeded: boolean; budget_used: number; budget_limit: number };
    expect(budgetState.exceeded).toBe(true);
    expect(budgetState.budget_limit).toBe(0.01);
    expect(budgetState.budget_used).toBeGreaterThan(0.01);

    // FakeClock should have recorded exactly 3 sleeps of 60_000ms each --
    // one per iteration of the budget-exceeded branch (autonomous.ts:252).
    // If the BUG-22 regression returned, this would still be 3 (loop bounded
    // by signals), so we additionally check NO provider work happened.
    const sixtyKSleeps = clock.sleeps.filter((ms) => ms === 60_000);
    expect(sixtyKSleeps.length).toBe(3);

    // Sanity: at least one log line announces the pause.
    expect(logLines.some((l) => l.includes("budget limit exceeded"))).toBe(true);

    // Regression guard: ensure the loop actually went through budgetMod, NOT
    // the SignalSource fallback. If checkBudgetLimitForRunner was renamed or
    // deleted, tryImport would return null and signals.isBudgetExceeded would
    // be polled instead -- and would never hit the over-budget branch.
    expect(signals.budgetCheckCount).toBe(0);
  });

  it("under-budget path does not trigger PAUSE/BUDGET_EXCEEDED", async () => {
    // Seed a tiny efficiency record well under the limit.
    const dir = resolve(lokiDir, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "iteration-1.json"),
      JSON.stringify({ cost_usd: 0.001, model: "sonnet" }),
    );
    process.env["BUDGET_LIMIT"] = "100";

    const provider = new FakeProvider();
    const signals = new StopAfterNSignals(0); // STOP immediately on first check
    const clock = new FakeClock();

    const code = await runAutonomous(
      baseOpts({
        providerOverride: provider,
        signals,
        clock,
        budgetLimit: 100,
      }),
    );

    expect(code).toBe(0);
    // Under-budget path must NOT write PAUSE or BUDGET_EXCEEDED.
    expect(existsSync(resolve(lokiDir, "PAUSE"))).toBe(false);
    expect(existsSync(resolve(lokiDir, "signals", "BUDGET_EXCEEDED"))).toBe(false);
    // No 60s budget sleep.
    expect(clock.sleeps.includes(60_000)).toBe(false);
  });
});
