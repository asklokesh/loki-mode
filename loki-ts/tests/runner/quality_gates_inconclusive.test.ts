import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// Wave-7 bug-hunt regression tests for src/runner/quality_gates.ts.
//
// Covers two forward-looking fixes. NOTE on reachability: runCodeReview /
// parseVerdict in this module are DORMANT today -- `loki start` routes to the
// bash route (autonomy/run.sh) and runQualityGates (the only transitive caller
// of runCodeReview) has zero production callers. These tests close LANDMINES
// before the Bun runner is ever wired to `loki start`. They are NOT live-user
// regression coverage; they are parity guards for the migration goal.
//
//   bun-F1: inconclusive review (all reviewers return non-empty but
//           UNPARSEABLE output, reviewers ARE available) must BLOCK by default
//           and only pass when LOKI_REVIEW_INCONCLUSIVE_BLOCK=0. Parity with
//           bash Finding #596 / FIX A2 (autonomy/run.sh:9328-9330, 9494-9502).
//   bun-F2: parseVerdict tolerates leading whitespace before the VERDICT token
//           ("  VERDICT: PASS" -> PASS, not UNKNOWN).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseVerdict, runCodeReview } from "../../src/runner/quality_gates.ts";
import type { ReviewerFn } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let scratch = "";

const ENV_KEYS = [
  "LOKI_REVIEW_INCONCLUSIVE_BLOCK",
  "LOKI_INJECT_FINDINGS",
  "LOKI_OVERRIDE_COUNCIL",
  "LOKI_GATE_DEVILS_ADVOCATE",
  "LOKI_STUB_GATE_CODE_REVIEW",
];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-gates-inconc-"));
  // Keep the dormant findings-injection side effect out of these tests so the
  // assertions isolate the inconclusive decision. (It is try/caught and
  // non-fatal regardless, but this keeps the temp dir clean.)
  process.env["LOKI_INJECT_FINDINGS"] = "0";
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

// A reviewer that returns non-empty PROSE with no VERDICT: line. parseVerdict
// classifies this as UNKNOWN, so passCount + failCount === 0 across the panel.
// Injecting opts.reviewer keeps reviewerAvailable = true, so the gate takes
// the real inconclusive path, NOT the !reviewerAvailable UNAVAILABLE
// short-circuit.
const unparseableReviewer: ReviewerFn = async ({ reviewer }) =>
  `Thanks for the diff. The change to ${reviewer.name} looks broadly reasonable to me, ` +
  `though I would want to see more context before signing off. No machine-readable verdict here.`;

describe("bun-F1: inconclusive code review (zero usable verdicts, reviewers available)", () => {
  const diffOverride = { diff: "+ const x = 1;\n", files: "src/x.ts\n" };

  it("BLOCKS by default when all reviewers return unparseable output", async () => {
    const r = await runCodeReview(makeCtx(), {
      reviewer: unparseableReviewer,
      diffOverride,
    });
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("inconclusive");
    // Confirm we hit the inconclusive path, not the UNAVAILABLE short-circuit
    // (which would say "UNAVAILABLE - no reviewer CLI on PATH").
    expect(r.detail ?? "").not.toContain("UNAVAILABLE");
  });

  it("PASSES (non-blocking) only when LOKI_REVIEW_INCONCLUSIVE_BLOCK=0", async () => {
    process.env["LOKI_REVIEW_INCONCLUSIVE_BLOCK"] = "0";
    const r = await runCodeReview(makeCtx(), {
      reviewer: unparseableReviewer,
      diffOverride,
    });
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").toContain("LOKI_REVIEW_INCONCLUSIVE_BLOCK=0");
  });

  it("still BLOCKS when the env var is unset or empty (bash :-1 default parity)", async () => {
    // Empty string must behave like unset: block. (Guard uses === \"0\".)
    process.env["LOKI_REVIEW_INCONCLUSIVE_BLOCK"] = "";
    const r = await runCodeReview(makeCtx(), {
      reviewer: unparseableReviewer,
      diffOverride,
    });
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("inconclusive");
  });

  it("a real PASS verdict still passes (the guard does not over-fire)", async () => {
    const passReviewer: ReviewerFn = async () => "VERDICT: PASS\nFINDINGS:\n- None";
    // Disable the Devil's-Advocate re-review so the unanimous-PASS branch does
    // not dispatch the injected reviewer a second time; we only assert the
    // base aggregation does not trip the inconclusive guard.
    process.env["LOKI_GATE_DEVILS_ADVOCATE"] = "0";
    const r = await runCodeReview(makeCtx(), {
      reviewer: passReviewer,
      diffOverride,
    });
    expect(r.passed).toBe(true);
    expect(r.detail ?? "").not.toContain("inconclusive");
  });
});

describe("bun-F2: parseVerdict tolerates leading whitespace before VERDICT", () => {
  it("classifies '  VERDICT: PASS' (leading whitespace) as PASS, not UNKNOWN", () => {
    const v = parseVerdict("r", "  VERDICT: PASS\nFINDINGS:\n- None");
    expect(v.verdict).toBe("PASS");
    expect(v.blocking).toBe(false);
  });

  it("classifies a tab-indented '\\tVERDICT: FAIL' with [Critical] as blocking FAIL", () => {
    const v = parseVerdict("r", "\tVERDICT: FAIL\nFINDINGS:\n- [Critical] real defect");
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });

  it("a bare 'VERDICT: PASS' (no leading whitespace) still parses as PASS (no regression)", () => {
    const v = parseVerdict("r", "VERDICT: PASS\nFINDINGS:\n- None");
    expect(v.verdict).toBe("PASS");
  });

  it("genuinely verdictless prose stays UNKNOWN (feeds the bun-F1 guard)", () => {
    const v = parseVerdict("r", "Looks fine to me but no formal verdict here.");
    expect(v.verdict).toBe("UNKNOWN");
  });
});
