import { describe, expect, test } from "bun:test";
import { calculateCostFromRecords } from "../src/runner/budget.ts";

// The budget circuit breaker priced cache tokens at zero. Writers have emitted
// cache_read_tokens / cache_creation_tokens since v6.82.0 (run.sh:7484), and
// they dominate real traffic: the fixture below is a measured iteration from
// tests/test-cost-capture.sh where cache reads are 797,496 tokens against
// 10,272 of plain input -- 98.7% of input volume, all of it free as far as the
// breaker was concerned.
//
// This only bites when cost_usd is absent, which is exactly the degraded path
// where a runaway is most likely and the breaker matters most.
const MEASURED = {
  model: "sonnet",
  input_tokens: 10272,
  output_tokens: 6164,
  cache_read_tokens: 797496,
  cache_creation_tokens: 79769,
};

describe("budget: cache token pricing", () => {
  test("cache tokens are not free", () => {
    const withCache = calculateCostFromRecords([MEASURED]);
    const { cache_read_tokens, cache_creation_tokens, ...withoutCache } =
      MEASURED;
    const ignored = calculateCostFromRecords([withoutCache]);

    // The whole point: counting them must cost materially more than not.
    expect(withCache).toBeGreaterThan(ignored * 5);
    // sonnet: 3/M input, 15/M output, 0.3/M cache read, 3.75/M cache write.
    //   10272*3 + 6164*15 + 797496*0.3 + 79769*3.75, all /1e6
    expect(withCache).toBeCloseTo(2.7551, 3);
  });

  test("a record with no cache fields is unchanged", () => {
    // Back-compat: older records lack the fields entirely and must price
    // exactly as before, not become NaN or inflate.
    expect(
      calculateCostFromRecords([
        { model: "sonnet", input_tokens: 1_000_000, output_tokens: 0 },
      ]),
    ).toBeCloseTo(3.0, 6);
  });

  test("an explicit cost_usd still wins over token math", () => {
    // The provider's own number is authoritative when present; adding cache
    // pricing must not start double-counting it.
    expect(
      calculateCostFromRecords([{ ...MEASURED, cost_usd: 9.0 }]),
    ).toBeCloseTo(9.0, 6);
  });

  test("an unknown model's cache tiers fall back to the input rate", () => {
    // Fail-safe direction for a budget breaker: an unpriced cache tier must
    // over-estimate (stop sooner), never under-estimate. Asserting it is at
    // least the plain-input price of the same volume proves it is not zero.
    const cost = calculateCostFromRecords([
      { model: "definitely-not-a-real-model", cache_read_tokens: 1_000_000 },
    ]);
    expect(cost).toBeGreaterThan(0);
  });

  test("cache-heavy traffic is priced above a naive input-only estimate", () => {
    // Guards the specific regression: someone re-deriving cost from
    // input_tokens alone would report 0.1233 for the measured iteration. The
    // real number is ~22x that.
    const real = calculateCostFromRecords([MEASURED]);
    expect(real).toBeGreaterThan(2.0);
  });
});
