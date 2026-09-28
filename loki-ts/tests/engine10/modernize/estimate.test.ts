// M-06: up-front estimate (cost, time, risk), --budget math, --dry-run print.
import { describe, expect, it } from "bun:test";
import type { ClusterResult } from "../../../src/engine10/modernize/cluster.ts";
import {
  budgetExceeded, estimate, formatDryRun,
} from "../../../src/engine10/modernize/estimate.ts";

const result: ClusterResult = {
  units: [
    { id: "u-0", nodes: ["a"], lines: 100, highRisk: false },
    { id: "u-1", nodes: ["b"], lines: 2000, highRisk: true },
  ],
  waves: [["u-0"], ["u-1"]],
};

describe("estimate", () => {
  it("computes cost as units x per-unit prior", () => {
    const e = estimate(result, { usdPerUnit: 3, p50UnitTimeS: null }, 4);
    expect(e.units).toBe(2);
    expect(e.waves).toBe(2);
    expect(e.costUsd).toBe(6);
  });

  it("computes wall time as waves x p50 unit time / workers", () => {
    const e = estimate(result, { usdPerUnit: null, p50UnitTimeS: 100 }, 4);
    expect(e.wallTimeS).toBe((2 * 100) / 4);
  });

  it("never divides by zero workers", () => {
    const e = estimate(result, { usdPerUnit: null, p50UnitTimeS: 100 }, 0);
    expect(e.wallTimeS).toBe(200);
  });

  it("reports null (never $0/0s) when there is no prior", () => {
    const e = estimate(result, { usdPerUnit: null, p50UnitTimeS: null }, 4);
    expect(e.costUsd).toBeNull();
    expect(e.wallTimeS).toBeNull();
  });

  it("counts risk classes from cluster.ts's highRisk flag", () => {
    const e = estimate(result, { usdPerUnit: null, p50UnitTimeS: null }, 4);
    expect(e.riskHigh).toBe(1);
    expect(e.riskNormal).toBe(1);
  });
});

describe("budgetExceeded", () => {
  it("never blocks when there is no budget", () => {
    expect(budgetExceeded(1000, 50, null)).toBe(false);
  });

  it("never blocks when the in-flight cost is unmeasured", () => {
    expect(budgetExceeded(1000, null, 10)).toBe(false);
  });

  it("blocks once spent plus in-flight would exceed the budget", () => {
    expect(budgetExceeded(90, 5, 100)).toBe(false);
    expect(budgetExceeded(90, 11, 100)).toBe(true);
  });
});

describe("formatDryRun", () => {
  it("prints 'not measured' rather than a fabricated number", () => {
    const e = estimate(result, { usdPerUnit: null, p50UnitTimeS: null }, 4);
    const out = formatDryRun(e);
    expect(out).toContain("cost: not measured");
    expect(out).toContain("wall time: not measured");
    expect(out).toContain("units: 2");
    expect(out).toContain("risk: 1 high, 1 normal");
  });

  it("prints real numbers when priors are known", () => {
    const e = estimate(result, { usdPerUnit: 2.5, p50UnitTimeS: 60 }, 2);
    const out = formatDryRun(e);
    expect(out).toContain("cost: $5.00");
    expect(out).toContain("wall time: 60s");
  });
});
