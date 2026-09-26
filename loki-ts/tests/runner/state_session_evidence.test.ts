// A new session restarts at iteration 0, so a previous session's
// .loki/quality/.test-results.iter ("1") would make its pass:true
// test-results.json read as fresh evidence at the new session's iteration 1.
// loadStateForRunner must drop that marker (and unit-tests.pass) whenever the
// session starts at iteration 0, and only then.
//
// Hermetic: a fresh tmpdir per test; cwd has no package.json, so the gate can
// never fall back to `npm test`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTestCoverage } from "../../src/runner/quality_gates.ts";
import { loadStateForRunner } from "../../src/runner/state.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let tmp = "";
let loki = "";
let quality = "";
const STUB = "LOKI_STUB_GATE_TEST_COVERAGE";
let savedStub: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-session-evidence-"));
  loki = join(tmp, ".loki");
  quality = join(loki, "quality");
  mkdirSync(quality, { recursive: true });
  savedStub = process.env[STUB];
  delete process.env[STUB];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedStub === undefined) delete process.env[STUB];
  else process.env[STUB] = savedStub;
});

function makeCtx(iterationCount: number): RunnerContext {
  return {
    cwd: tmp,
    lokiDir: loki,
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
    iterationCount,
    retryCount: 0,
    currentTier: "development",
    log: () => {},
  };
}

// What a previous session left behind after its iteration 1.
function leaveEvidence(): void {
  writeFileSync(join(quality, "test-results.json"), '{"runner":"jest","pass":true,"passed_count":3,"failed_count":0}');
  writeFileSync(join(quality, ".test-results.iter"), "1\n");
  writeFileSync(join(quality, "unit-tests.pass"), "");
}

function writeState(status: string, iterationCount: number): void {
  writeFileSync(join(loki, "autonomy-state.json"), JSON.stringify({ retryCount: 0, iterationCount, status }));
}

async function readsPassed(ctx: RunnerContext): Promise<boolean> {
  const r = await runTestCoverage(ctx);
  return r.passed === true && r.inconclusive !== true;
}

describe("loadStateForRunner: a previous session's test evidence", () => {
  const previous: Array<[string, () => void]> = [
    ["a terminal previous state (council_approved)", () => writeState("council_approved", 1)],
    ["a missing state file", () => {}],
    ["a corrupt state file", () => writeFileSync(join(loki, "autonomy-state.json"), "{not json")],
  ];
  for (const [label, setup] of previous) {
    it(`${label}: the leftover pass:true does not read as passed at the new session's iteration 1`, async () => {
      setup();
      leaveEvidence();
      // Control: before the load, the leftover reads as this iteration's pass.
      expect(await readsPassed(makeCtx(1))).toBe(true);

      const ctx = makeCtx(7);
      await loadStateForRunner(ctx);
      expect(ctx.iterationCount).toBe(0);
      expect(existsSync(join(quality, ".test-results.iter"))).toBe(false);
      expect(existsSync(join(quality, "unit-tests.pass"))).toBe(false);
      // The previous session's results file goes too: with the marker gone the
      // receipt's quality gates would otherwise fall back to its status.
      expect(existsSync(join(quality, "test-results.json"))).toBe(false);

      ctx.iterationCount += 1; // the loop increments before the gates run
      const r = await runTestCoverage(ctx);
      expect(r.passed === true && r.inconclusive !== true).toBe(false);
      expect(r.inconclusive).toBe(true);

      // Positive control: this session's own fresh artifact still passes.
      writeFileSync(join(quality, "test-results.json"), '{"runner":"jest","pass":true,"passed_count":3,"failed_count":0}');
      writeFileSync(join(quality, ".test-results.iter"), "1\n");
      expect(await readsPassed(ctx)).toBe(true);
    });
  }

  it("a genuine resume (paused at iteration 3) keeps the markers", async () => {
    writeState("paused", 3);
    leaveEvidence();
    const ctx = makeCtx(0);
    await loadStateForRunner(ctx);
    expect(ctx.iterationCount).toBe(3);
    expect(existsSync(join(quality, ".test-results.iter"))).toBe(true);
    expect(existsSync(join(quality, "unit-tests.pass"))).toBe(true);
  });
});
