// LOKI_DURABLE_STATE=1 on the engine10 route: deterministic terminal failures exit 20, same as the legacy runner.
import { describe, expect, test } from "bun:test";
import { EXIT, exitCodeOf, type Outcome } from "../../src/engine10/output.ts";

const ON = { LOKI_DURABLE_STATE: "1" } as NodeJS.ProcessEnv;
const FAILURES: Outcome[] = ["FAILED", "PARTIAL", "BUDGET_STOP", "BLOCKED", "STALLED"];

describe("engine10 durable-state exit contract", () => {
  test("default contract is unchanged without the opt-in", () => {
    for (const o of Object.keys(EXIT) as Outcome[]) {
      expect(exitCodeOf(o, {} as NodeJS.ProcessEnv)).toBe(EXIT[o]);
      expect(exitCodeOf(o, { LOKI_DURABLE_STATE: "0" } as NodeJS.ProcessEnv)).toBe(EXIT[o]);
    }
  });
  test("with LOKI_DURABLE_STATE=1 every deterministic failure exits 20", () => {
    for (const o of FAILURES) expect(exitCodeOf(o, ON)).toBe(20);
  });
  test("success stays 0 and a signal cancel stays retryable (nonzero, not 20)", () => {
    expect(exitCodeOf("VERIFIED", ON)).toBe(0);
    expect(exitCodeOf("ALREADY_SATISFIED", ON)).toBe(0);
    expect(exitCodeOf("CANCELLED", ON)).toBe(130);
  });
});
