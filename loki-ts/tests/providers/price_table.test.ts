import { describe, expect, test } from "bun:test";
import { usdFor } from "../../src/providers/price_table.ts";
import { buildProviderCost } from "../../src/providers/provider_cost.ts";

describe("usdFor clamps", () => {
  test("non-finite tokens give 0 contribution, never NaN", () => {
    expect(usdFor("gpt-5", NaN, 10)).toBe(usdFor("gpt-5", 0, 10));
    expect(usdFor("gpt-5", Infinity, 0)).toBe(0);
    expect(usdFor("gpt-5", 10, NaN)).toBe(usdFor("gpt-5", 10, 0));
    expect(usdFor("gpt-5", 10, 0, NaN)).toBe(usdFor("gpt-5", 10, 0));
  });
  test("negative tokens clamp to 0", () => {
    expect(usdFor("gpt-5", -100, -5, -1)).toBe(0);
  });
  test("cached above input is capped at input", () => {
    expect(usdFor("gpt-5", 100, 0, 500)).toBe(usdFor("gpt-5", 100, 0, 100));
    expect(usdFor("gpt-5", 100, 0, 500)).toBe(0.000013);
  });
  test("normal case unchanged", () => {
    expect(usdFor("gpt-5", 1_000_000, 1_000_000)).toBe(11.25);
    expect(usdFor("gpt-5", 1_000_000, 0, 400_000)).toBe(0.6 * 1.25 + 0.4 * 0.125);
  });
  test("buildProviderCost never yields a non-finite cost", () => {
    const rec = buildProviderCost("codex", "gpt-5", "x".repeat(400), "y".repeat(40));
    expect(rec).not.toBeNull();
    expect(Number.isFinite(rec!.total_cost_usd as number)).toBe(true);
  });
});
