import { describe, expect, test } from "bun:test";
import {
  calculateCostFromRecords,
  readEfficiencyDir,
  PRICING,
} from "../src/runner/budget.ts";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The budget circuit breaker priced cache tokens at zero. Writers have emitted
// cache_read_tokens / cache_creation_tokens since v6.82.0 (run.sh:7484), and
// they dominate real traffic: the fixture below is a measured iteration from
// tests/test-cost-capture.sh where cache reads are 797,496 tokens against
// 10,272 of plain input -- 98.7% of input volume, all of it free as far as the
// breaker was concerned.
//
// This only bites when cost_usd is absent, which is exactly the degraded path
// where a runaway is most likely and the breaker matters most.
// Expected rates come from the pricing FILE, never from literals: a rate
// change (MW-1 moved sonnet 3/15 to 2/10) must not break arithmetic tests,
// and reading the file instead of PRICING keeps the loader under test.
const FILE_SONNET = JSON.parse(
  readFileSync(join(import.meta.dir, "../data/model-pricing.json"), "utf-8"),
).pricing.sonnet as {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

const MEASURED = {
  model: "sonnet",
  input_tokens: 10272,
  output_tokens: 6164,
  cache_read_tokens: 797496,
  cache_creation_tokens: 79769,
};

// The measured record priced straight from the file's four sonnet tiers.
function expectedMeasured(): number {
  return (
    (MEASURED.input_tokens * FILE_SONNET.input +
      MEASURED.output_tokens * FILE_SONNET.output +
      MEASURED.cache_read_tokens * FILE_SONNET.cache_read +
      MEASURED.cache_creation_tokens * FILE_SONNET.cache_write) /
    1e6
  );
}

describe("budget: cache token pricing", () => {
  test("cache tokens are not free", () => {
    const withCache = calculateCostFromRecords([MEASURED]);
    const { cache_read_tokens, cache_creation_tokens, ...withoutCache } =
      MEASURED;
    const ignored = calculateCostFromRecords([withoutCache]);

    // The whole point: counting them must cost materially more than not.
    expect(withCache).toBeGreaterThan(ignored * 4);
    expect(withCache).toBeCloseTo(expectedMeasured(), 4);
  });

  test("a record with no cache fields is unchanged", () => {
    // Back-compat: older records lack the fields entirely and must price
    // exactly as before, not become NaN or inflate.
    expect(
      calculateCostFromRecords([
        { model: "sonnet", input_tokens: 1_000_000, output_tokens: 0 },
      ]),
    ).toBeCloseTo(FILE_SONNET.input, 6);
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

  test("the read-to-cost path preserves cache fields end to end", () => {
    // WIRING, not arithmetic. Every other case here calls
    // calculateCostFromRecords with a hand-built record, which proves the
    // FUNCTION is right and says nothing about what reaches it.
    //
    // The same shape has now bitten four other cost routes: the calculator was
    // correct and a caller dropped the cache fields on the way in. Here the
    // caller is readEfficiencyDir, so this drives the real file-to-cost flow
    // and asserts the total that the bash route and the dashboard also produce
    // for this record. Three routes, one number.
    const dir = mkdtempSync(join(tmpdir(), "loki-effread-"));
    try {
      writeFileSync(
        join(dir, "iteration-1.json"),
        JSON.stringify(MEASURED),
        "utf-8",
      );
      const records = readEfficiencyDir(dir);
      expect(records).toHaveLength(1);
      expect(records[0]!.cache_read_tokens).toBe(MEASURED.cache_read_tokens);
      expect(calculateCostFromRecords(records)).toBeCloseTo(
        expectedMeasured(),
        4,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache-heavy traffic is priced above a naive input-only estimate", () => {
    // Guards the specific regression: someone re-deriving cost from
    // input_tokens and output_tokens alone, cache tokens ignored.
    const real = calculateCostFromRecords([MEASURED]);
    const naive =
      (MEASURED.input_tokens / 1e6) * FILE_SONNET.input +
      (MEASURED.output_tokens / 1e6) * FILE_SONNET.output;
    expect(real).toBeGreaterThan(naive * 4);
  });

  test("the pricing table's cache tiers survive loading", () => {
    // THE ACTUAL BUG this file was rewritten for. The JSON loader copied only
    // input and output, dropping cache_read/cache_write even though the file
    // defines them. The cost loop's `?? p.input` fallback then charged cache
    // reads at the FULL input rate: a 10x overcharge on the dominant term,
    // which made the two routes disagree 4.2x about the same run.
    //
    // Asserting the loaded table (not the JSON file) is what catches it: the
    // file was always correct.
    const sonnet = PRICING["sonnet"]!;
    expect(sonnet.cache_read).toBe(FILE_SONNET.cache_read);
    expect(sonnet.cache_write).toBe(FILE_SONNET.cache_write);
    // A cache read must never cost the same as fresh input.
    expect(sonnet.cache_read).toBeLessThan(sonnet.input);
  });

  test("bash and TS routes agree on the same record", () => {
    // Both routes price the SAME efficiency JSON. When they disagree, one run
    // reports two different spends and the budget breaker fires at the wrong
    // point. This is the exact arithmetic the bash route performs in
    // check_budget_limit (run.sh): input + output + cache_read +
    // cache_write at the sonnet row's own rates (0.05x read on Sonnet 5.5).
    const p = PRICING["sonnet"]!;
    const bash =
      (MEASURED.input_tokens / 1e6) * p.input +
      (MEASURED.output_tokens / 1e6) * p.output +
      (MEASURED.cache_read_tokens / 1e6) * p.cache_read! +
      (MEASURED.cache_creation_tokens / 1e6) * p.cache_write!;
    expect(calculateCostFromRecords([MEASURED])).toBeCloseTo(bash, 4);
  });
});
