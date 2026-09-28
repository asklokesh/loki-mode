// E-67 rework r4: pins the backstop-vs-worker-cap relationship by calling the real supervisor.ts and
// machine.ts functions (not a mirrored formula), so a future constant or formula change cannot silently
// drift. Opus REJECT finding 1 (round 3): a fixed 30s grace made backstopMs 0 or negative for any capS <=
// 30, and still landed at or before the worker's own soft cap for every capS <= ~750. Follow-up 2: the
// soft cap itself (machine.ts) is now tightened for a small capS so the commit+seal tail actually fits
// before the backstop, everywhere that is achievable at all (default and deep caps are unchanged).
import { describe, expect, test } from "bun:test";
import { softCapS } from "../../src/engine10/machine.ts";
import { backstopS, BACKSTOP_GRACE_S } from "../../src/engine10/supervisor.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S, STAGE_BUDGETS } from "../../src/engine10/types.ts";

const KILL_GRACE_S = 2; // machine.ts's KILL_GRACE_MS, mirrored here only as a plain number for the assertion
const tailS = (STAGE_BUDGETS.commit.targetS ?? 0) + (STAGE_BUDGETS.seal.targetS ?? 0) + KILL_GRACE_S;
const plainS = (capS: number): number => (capS * 14) / 15;

describe("backstop clears the worker's own (real) soft cap (E-67 finding 1)", () => {
  for (const capS of [5, 30, 31, 300, DEFAULT_CAP_S, DEEP_CAP_S]) {
    test(`capS=${capS}: backstop is strictly between softCapS(capS) and the cap`, () => {
      const backstopS_ = backstopS(capS, BACKSTOP_GRACE_S);
      expect(backstopS_).toBeGreaterThan(softCapS(capS));
      expect(backstopS_).toBeLessThan(capS);
      expect(backstopS_).toBeGreaterThan(0);
    });
  }

  // Finding 1 follow-up 2: below ~capS=21 the commit+seal tail (fixed cost, ~22s here) cannot fit
  // inside the cap at all; softCapS falls back to the plain 14/15 point there instead of going
  // negative. capS=5 is that disclosed residual, asserted separately below, not in this loop.
  for (const capS of [30, 31, 300, DEFAULT_CAP_S, DEEP_CAP_S]) {
    test(`capS=${capS}: the soft cap also leaves commit+seal's full target time before the backstop`, () => {
      expect(backstopS(capS, BACKSTOP_GRACE_S) - softCapS(capS)).toBeGreaterThanOrEqual(tailS);
    });
  }

  test("capS=DEFAULT_CAP_S/DEEP_CAP_S: the soft cap is unchanged from the plain 14/15 point", () => {
    expect(softCapS(DEFAULT_CAP_S)).toBeCloseTo(plainS(DEFAULT_CAP_S), 6);
    expect(softCapS(DEEP_CAP_S)).toBeCloseTo(plainS(DEEP_CAP_S), 6);
    expect(DEFAULT_CAP_S - backstopS(DEFAULT_CAP_S, BACKSTOP_GRACE_S)).toBeGreaterThanOrEqual(STAGE_BUDGETS.pr.targetS ?? 0);
  });

  test("capS=5: the tail cannot fit at all; the soft cap falls back to the plain 14/15 point (disclosed residual)", () => {
    expect(softCapS(5)).toBeCloseTo(plainS(5), 6);
    expect(backstopS(5) - softCapS(5)).toBeLessThan(tailS);
  });

  test("a graceS override smaller than capS/30 is honored (test-only knob), still clears the soft cap", () => {
    const backstopS_ = backstopS(2, 1);
    expect(backstopS_).toBeGreaterThan(softCapS(2));
    expect(backstopS_).toBeLessThan(2);
  });
});
