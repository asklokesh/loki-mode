// E-67 rework r4: pins the backstop-vs-worker-cap relationship by calling the real supervisor.ts
// function (not a mirrored formula), so a future constant or formula change cannot silently drift
// (Opus REJECT finding 1, reproduced round 3: a fixed 30s grace made backstopMs 0 or negative for
// any capS <= 30, and still landed at or before the worker's own soft cap for every capS <= ~750).
import { describe, expect, test } from "bun:test";
import { backstopS, BACKSTOP_GRACE_S } from "../../src/engine10/supervisor.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S, STAGE_BUDGETS } from "../../src/engine10/types.ts";

const workerCapAtS = (capS: number): number => (capS * 14) / 15;

describe("backstop clears the worker's own soft cap (E-67 finding 1)", () => {
  for (const capS of [5, 30, 31, 300, DEFAULT_CAP_S, DEEP_CAP_S]) {
    test(`capS=${capS}: backstop is strictly between the soft cap and the cap`, () => {
      const backstopS_ = backstopS(capS, BACKSTOP_GRACE_S);
      expect(backstopS_).toBeGreaterThan(workerCapAtS(capS));
      expect(backstopS_).toBeLessThan(capS);
      expect(backstopS_).toBeGreaterThan(0);
    });
  }

  for (const capS of [DEFAULT_CAP_S, DEEP_CAP_S]) {
    test(`capS=${capS}: default backstop also fires after commit+seal's target time, before the cap`, () => {
      const backstopS_ = backstopS(capS, BACKSTOP_GRACE_S);
      const tailS = (STAGE_BUDGETS.commit.targetS ?? 0) + (STAGE_BUDGETS.seal.targetS ?? 0);
      expect(backstopS_).toBeGreaterThan(workerCapAtS(capS) + tailS);
      expect(capS - backstopS_).toBeGreaterThanOrEqual(STAGE_BUDGETS.pr.targetS ?? 0);
    });
  }

  test("a graceS override smaller than capS/30 is honored (test-only knob), still clears the soft cap", () => {
    const backstopS_ = backstopS(2, 1);
    expect(backstopS_).toBeGreaterThan(workerCapAtS(2));
    expect(backstopS_).toBeLessThan(2);
  });
});
