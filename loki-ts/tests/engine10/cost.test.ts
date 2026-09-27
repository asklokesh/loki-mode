// loki-ts/tests/engine10/cost.test.ts
//
// E-06 wall check. Fixtures under fixtures/cost/<case>/metrics/ use the exact
// shape writeResultCost (src/runner/sdk_stream_parser.ts) writes.
// Unknown cost must be null, never 0.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readResultCost, sumResultCosts } from "../../src/engine10/cost.ts";

const FIX = join(import.meta.dir, "fixtures", "cost");

describe("engine10 cost", () => {
  test("reads one result-cost file", () => {
    const c = readResultCost(join(FIX, "two"), "e10-r1-plan");
    expect(c.usd).toBe(0.125);
    expect(c.input_tokens).toBe(1000);
    expect(c.output_tokens).toBe(200);
    expect(c.cache_read_tokens).toBe(5000);
    expect(c.missing).toEqual([]);
  });

  test("two files sum correctly", () => {
    const c = sumResultCosts(join(FIX, "two"), ["e10-r1-plan", "e10-r1-implement"]);
    expect(c.usd).toBe(0.625);
    expect(c.input_tokens).toBe(5000);
    expect(c.output_tokens).toBe(1000);
    expect(c.cache_read_tokens).toBe(25000);
    expect(c.missing).toEqual([]);
    expect(c.source).toContain("result-cost-e10-r1-implement.json");
  });

  test("a missing file gives usd null, never 0", () => {
    const c = readResultCost(join(FIX, "two"), "e10-r1-nope");
    expect(c.usd).toBeNull();
    expect(c.usd).not.toBe(0);
    expect(c.missing).toEqual(["e10-r1-nope"]);
  });

  test("one missing session makes the sum unknown, not a partial number", () => {
    const c = sumResultCosts(join(FIX, "partial"), ["e10-r1-plan", "e10-r1-implement"]);
    expect(c.usd).toBeNull();
    expect(c.missing).toEqual(["e10-r1-implement"]);
    // tokens still reflect what was measured
    expect(c.input_tokens).toBe(1000);
  });

  test("no sessions at all is unknown, not 0", () => {
    expect(sumResultCosts(join(FIX, "two"), []).usd).toBeNull();
  });

  test("a file without total_cost_usd or truncated JSON is unknown", () => {
    expect(readResultCost(join(FIX, "bad"), "e10-r1-nousd").usd).toBeNull();
    expect(readResultCost(join(FIX, "bad"), "e10-r1-trunc").usd).toBeNull();
  });
});
