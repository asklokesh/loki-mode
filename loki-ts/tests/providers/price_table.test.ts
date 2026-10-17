import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("price table override", () => {
  const dirs: string[] = [];
  const prev = process.env.LOKI_PRICE_TABLE;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOKI_PRICE_TABLE;
    else process.env.LOKI_PRICE_TABLE = prev;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function withFile(content: string): void {
    const d = mkdtempSync(join(tmpdir(), "loki-price-"));
    dirs.push(d);
    const f = join(d, "p.json");
    writeFileSync(f, content);
    process.env.LOKI_PRICE_TABLE = f;
  }
  test("overrides an existing entry and extends with a new one", () => {
    withFile(JSON.stringify({ "gpt-5": { input: 9, output: 18 }, "Acme-X": { input: 1, output: 2, cachedInput: 0.5 } }));
    expect(priceFor("gpt-5").price).toEqual({ input: 9, output: 18 });
    expect(priceFor("acme-x-1")).toEqual({ price: { input: 1, output: 2, cachedInput: 0.5 }, matched: true });
    expect(priceFor("gpt-5-mini").price.input).toBe(0.25);
    expect(usdFor("gpt-5", 1_000_000, 0)).toBe(9);
  });
  test("invalid file or entries fall back to the built-in table", () => {
    withFile("{not json");
    expect(priceFor("gpt-5").price.input).toBe(1.25);
    withFile("[1,2]");
    expect(priceFor("gpt-5").price.input).toBe(1.25);
    withFile(JSON.stringify({ "gpt-5": { input: -1, output: "x" } }));
    expect(priceFor("gpt-5").price.input).toBe(1.25);
    process.env.LOKI_PRICE_TABLE = "/nonexistent/loki-price.json";
    expect(priceFor("gpt-5").price.input).toBe(1.25);
  });
  test("unset env uses built-in table", () => {
    delete process.env.LOKI_PRICE_TABLE;
    expect(priceFor("gpt-5").price.input).toBe(1.25);
  });
});
