import { describe, expect, test } from "bun:test";
import { groupCostLine, parseGroupCost, scopedEnv } from "../../src/features/speed/run_group.ts";

describe("scopedEnv identity", () => {
  test("keeps USER, LOGNAME, SHELL and drops an unrelated secret", () => {
    const out = scopedEnv({ PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", SHELL: "/bin/zsh", AWS_SECRET_ACCESS_KEY: "x", NPM_TOKEN: "y" });
    expect(out["USER"]).toBe("u");
    expect(out["LOGNAME"]).toBe("u");
    expect(out["SHELL"]).toBe("/bin/zsh");
    expect(out["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(out["NPM_TOKEN"]).toBeUndefined();
  });
});

const table = (rows: string[]): string => ["backlog: unit-g1-1 VERIFIED", "", "Summary: o/r", "ITEM           COST       RESULT", ...rows, "Total measured cost: $0.00"].join("\n");

describe("group cost", () => {
  test("sums unit costs", () => {
    const c = parseGroupCost(table(["unit-g1-1      $0.17      VERIFIED", "unit-g1-2      $0.25      VERIFIED"]));
    expect(c.usd).toBeCloseTo(0.42, 5);
    expect(groupCostLine([c])).toBe("loki: cost $0.42 (measured)\n");
  });
  test("unmeasured rows make it partial, never $0", () => {
    const c = parseGroupCost(table(["unit-g1-1      $0.17      VERIFIED", "unit-g1-2      unmeasured FAILED: x"]));
    expect(groupCostLine([c])).toBe("loki: cost partial: $0.17 for 1 of 2 unit session(s)\n");
  });
  test("no figures reads not measured", () => {
    const c = parseGroupCost(table(["unit-g1-1      unmeasured FAILED: x", "unit-g1-2      -          SKIPPED"]));
    expect(c.usd).toBeNull();
    expect(groupCostLine([c])).toBe("loki: cost not measured\n");
  });
  test("sums across launches", () => {
    const a = parseGroupCost(table(["unit-g1-1      $0.10      VERIFIED"])), b = parseGroupCost(table(["unit-g1-3      $0.05      VERIFIED"]));
    expect(groupCostLine([a, b])).toBe("loki: cost $0.15 (measured)\n");
  });
});
