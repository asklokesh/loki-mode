// loki-ts/tests/engine10/cost.test.ts
//
// E-06 wall check. Fixtures under fixtures/cost/<case>/metrics/ use the exact
// shape writeResultCost (src/runner/sdk_stream_parser.ts) writes.
// Unknown cost must be null, never 0.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextEfficiencyIteration,
  readResultCost,
  recordSessionCost,
  sumResultCosts,
  writeEfficiencyRecord,
} from "../../src/engine10/cost.ts";

const FIX = join(import.meta.dir, "fixtures", "cost");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const COST_SUMMARY = join(REPO_ROOT, "autonomy", "lib", "cost-summary.py");

// Runs the REAL harness reader (ENGINE.md section 10 point 2), not a
// reimplementation of its fully_measured/total rule.
function runCostSummary(checkout: string): Record<string, unknown> {
  const out = Bun.spawnSync(["python3", COST_SUMMARY, checkout, "--json"]);
  if (out.exitCode !== 0) {
    throw new Error(`cost-summary.py exited ${out.exitCode}: ${out.stderr.toString()}`);
  }
  return JSON.parse(out.stdout.toString());
}

function tmpCheckout(): string {
  return mkdtempSync(join(tmpdir(), "e10-cost-"));
}

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

  // E-69 (EV-8 failure mode: "Cost: $0.00 (claude, 0 tokens)"): a result-cost file
  // reporting total_cost_usd 0 with zero usage on every token field is a session
  // that never really ran; it must read as unmeasured, never a real $0.00.
  test("total_cost_usd 0 with zero tokens on every field is unmeasured (EV-8)", () => {
    const c = readResultCost(join(FIX, "zero"), "e10-r1-zero");
    expect(c.usd).toBeNull();
    expect(c.missing).toEqual(["e10-r1-zero"]);
    expect(c.measuredCount).toBe(0);
    expect(c.totalCount).toBe(1);
    expect(c.partialUsd).toBe(0);
  });

  test("a real free session (nonzero tokens, total_cost_usd 0) still measures as $0.00", () => {
    // Genuine EV-8 counter-case: the provider actually priced this session at $0, with real
    // usage on both token fields, so it must NOT be swept into "unmeasured" by the zero-usage
    // guard above. A `noUsage = c === 0` mutation (treating any exactly-zero cost as unmeasured,
    // the exact regression that guard exists to prevent) turns this red: usd becomes null.
    const c = readResultCost(join(FIX, "free"), "e10-r1-free");
    expect(c.usd).toBe(0);
    expect(c.missing).toEqual([]);
    expect(c.measuredCount).toBe(1);
    expect(c.totalCount).toBe(1);
    expect(c.partialUsd).toBe(0);
  });

  test("one priced, one zero-usage session: usd null but partialUsd/measuredCount report what was measured", () => {
    const c = sumResultCosts(join(FIX, "mixed"), ["e10-r1-plan", "e10-r1-zero"]);
    expect(c.usd).toBeNull();
    expect(c.missing).toEqual(["e10-r1-zero"]);
    expect(c.measuredCount).toBe(1);
    expect(c.totalCount).toBe(2);
    expect(c.partialUsd).toBe(0.125);
  });
});

describe("engine10 efficiency writer (E-06b)", () => {
  test("writes iteration-N.json with N = next integer, and omits cost_usd when unpriced", () => {
    const checkout = tmpCheckout();
    const lokiRoot = join(checkout, ".loki");
    try {
      expect(nextEfficiencyIteration(lokiRoot)).toBe(1); // no dir yet

      const priced = readResultCost(join(FIX, "two"), "e10-r1-plan");
      const n1 = writeEfficiencyRecord(lokiRoot, { status: "completed", durationMs: 12000, model: "claude-x" }, priced);
      expect(n1).toBe(1);
      const rec1 = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-1.json"), "utf8"));
      expect(rec1).toMatchObject({
        iteration: 1, status: "completed", duration_ms: 12000, model: "claude-x",
        cost_usd: 0.125, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, cache_creation_tokens: 300,
      });
      expect(rec1.cost_source).toBe("provider");

      // second session: no dollars reported -> cost_usd must be ABSENT, never 0.
      const unpriced = readResultCost(join(FIX, "bad"), "e10-r1-nousd");
      const n2 = writeEfficiencyRecord(lokiRoot, { status: "completed", durationMs: 500, model: "codex-x" }, unpriced);
      expect(n2).toBe(2);
      const rec2 = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-2.json"), "utf8"));
      expect("cost_usd" in rec2).toBe(false);
      expect("cost_source" in rec2).toBe(false);
      expect(rec2.input_tokens).toBe(10);
      expect(rec2.output_tokens).toBe(2);

      expect(nextEfficiencyIteration(lokiRoot)).toBe(3);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe("engine10 cost-summary.py integration (E-06b green criterion)", () => {
  test("a claude fixture (both sessions priced) reads fully_measured true with the right total", () => {
    const checkout = tmpCheckout();
    const lokiRoot = join(checkout, ".loki");
    mkdirSync(join(lokiRoot, "metrics"), { recursive: true });
    // Each provider session's own result-cost file lands where writeResultCost
    // really puts it, so recordSessionCost below runs the full real pipeline:
    // result-cost-<iter>.json -> read -> iteration-N.json.
    copyFileSync(join(FIX, "two", "metrics", "result-cost-e10-r1-plan.json"), join(lokiRoot, "metrics", "result-cost-e10-r1-plan.json"));
    copyFileSync(join(FIX, "two", "metrics", "result-cost-e10-r1-implement.json"), join(lokiRoot, "metrics", "result-cost-e10-r1-implement.json"));
    try {
      recordSessionCost(lokiRoot, "e10-r1-plan", { status: "completed", durationMs: 1000, model: "claude-x" });
      recordSessionCost(lokiRoot, "e10-r1-implement", { status: "completed", durationMs: 2000, model: "claude-x" });

      const s = runCostSummary(checkout);
      expect(s.iterations_found).toBe(2);
      expect(s.fully_measured).toBe(true);
      expect(s.total_cost_usd).toBe(0.625); // 0.125 + 0.5, exact figures from the "two" fixture
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("a tokens-only fixture reads fully_measured false with a null total", () => {
    const checkout = tmpCheckout();
    const lokiRoot = join(checkout, ".loki");
    mkdirSync(join(lokiRoot, "metrics"), { recursive: true });
    copyFileSync(join(FIX, "bad", "metrics", "result-cost-e10-r1-nousd.json"), join(lokiRoot, "metrics", "result-cost-e10-r1-nousd.json"));
    try {
      // Session 1: a real tokens-only (codex-style) session -- reported
      // tokens, no dollars. Nonzero tokens make this record "measured" on
      // their own strength (autonomy/lib/efficiency_cost.py record_is_measured
      // is field-agnostic), so cost stays unknown rather than $0 while the
      // session itself still counts as observed.
      recordSessionCost(lokiRoot, "e10-r1-nousd", { status: "completed", durationMs: 800, model: "codex-x" });
      // Session 2: killed before it reported anything at all (no
      // result-cost file was ever written for it) -- readResultCost's own
      // "missing" path gives all-zero tokens and null cost, which
      // record_is_measured correctly reads as UNmeasured, not free.
      recordSessionCost(lokiRoot, "e10-r1-never-ran", { status: "killed", durationMs: 50, model: "codex-x" });

      const s = runCostSummary(checkout);
      expect(s.iterations_found).toBe(2);
      expect(s.iterations_measured).toBe(1); // only the tokens-bearing session
      expect(s.fully_measured).toBe(false);
      expect(s.total_cost_usd).toBeNull();
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
