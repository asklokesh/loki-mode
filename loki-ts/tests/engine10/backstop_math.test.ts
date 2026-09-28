// E-67 rework: pins the backstop-vs-worker-cap relationship at DEFAULT_CAP_S and DEEP_CAP_S so a
// future constant change cannot reintroduce the exact-tie bug (Opus REJECT finding 1): the
// supervisor's backstop firing at the same instant the worker's own soft cap (machine.ts, 14/15
// of capS) tries to wind up, killing it before commit+seal can run.
import { describe, expect, test } from "bun:test";
import { BACKSTOP_GRACE_S } from "../../src/engine10/supervisor.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S, STAGE_BUDGETS } from "../../src/engine10/types.ts";

const workerCapAtS = (capS: number): number => (capS * 14) / 15;

describe("backstop clears the worker's own soft cap (E-67 finding 1)", () => {
  for (const capS of [DEFAULT_CAP_S, DEEP_CAP_S]) {
    test(`capS=${capS}: default backstop fires after commit+seal's target time, before the cap`, () => {
      const backstopS = capS - BACKSTOP_GRACE_S;
      const tailS = (STAGE_BUDGETS.commit.targetS ?? 0) + (STAGE_BUDGETS.seal.targetS ?? 0);
      expect(backstopS).toBeGreaterThan(workerCapAtS(capS) + tailS);
      expect(capS - backstopS).toBeGreaterThanOrEqual(STAGE_BUDGETS.pr.targetS ?? 0);
    });
  }
});
