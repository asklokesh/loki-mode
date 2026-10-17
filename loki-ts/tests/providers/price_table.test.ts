import { describe, expect, test } from "bun:test";
import { priceFor, usdFor } from "../../src/providers/price_table.ts";
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

describe("price table tiers", () => {
  test("mini and nano priced separately", () => {
    const pairs: Array<[string, string]> = [
      ["gpt-4o-mini", "gpt-4o"],
      ["gpt-4.1-mini", "gpt-4.1"],
      ["gpt-4.1-nano", "gpt-4.1"],
      ["gpt-5-mini", "gpt-5"],
      ["gpt-5-nano", "gpt-5"],
    ];
    for (const [small, full] of pairs) {
      const s = priceFor(small);
      expect(s.matched).toBe(true);
      expect(s.price.input).toBeLessThan(priceFor(full).price.input);
      expect(s.price.output).toBeLessThan(priceFor(full).price.output);
    }
    expect(usdFor("gpt-5-mini", 1_000_000, 1_000_000)).toBe(2.25);
    expect(usdFor("gpt-5-nano", 1_000_000, 1_000_000)).toBe(0.45);
    expect(usdFor("gpt-4o-mini-2024-07-18", 1_000_000, 1_000_000)).toBe(0.75);
  });
  test("provider cost entry path uses the mini price", () => {
    const mini = buildProviderCost("codex", "gpt-5-mini", "x".repeat(4000), "y".repeat(4000));
    const full = buildProviderCost("codex", "gpt-5", "x".repeat(4000), "y".repeat(4000));
    expect(mini!.total_cost_usd as number).toBeLessThan(full!.total_cost_usd as number);
  });
});
