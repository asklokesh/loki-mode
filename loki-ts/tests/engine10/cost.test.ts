// loki-ts/tests/engine10/cost.test.ts
//
// E-06 wall check. Fixtures under fixtures/cost/<case>/metrics/ use the exact
// shape writeResultCost (src/runner/sdk_stream_parser.ts) writes.
// Unknown cost must be null, never 0.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costTotalsOf,
  nextEfficiencyIteration,
  readResultCost,
  recordSessionCost,
  sumResultCosts,
  writeEfficiencyRecord,
} from "../../src/engine10/cost.ts";
import { partialUsagePath, recordPartialStreamCost } from "../../src/runner/budget.ts";

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

describe("RECEIPT-TRUTH COST-RECORDS and FIX-RESUME (FC-44)", () => {
  const write = (dir: string, iter: string, rec: Record<string, unknown>): void => {
    mkdirSync(join(dir, "metrics"), { recursive: true });
    writeFileSync(join(dir, "metrics", `result-cost-${iter}.json`), JSON.stringify(rec));
  };
  const mu = (cost: number, i = 100) => ({ "m-main": { input_tokens: i, output_tokens: 10, cache_read_tokens: 1000, cache_creation_tokens: 50, cost_usd: cost * 0.8 }, "m-sub": { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: cost * 0.2 } });
  test("modelUsage that reconciles to total_cost_usd within 1% supplies whole-pipeline tokens and per-model cost", () => {
    const d = tmpCheckout();
    try {
      write(d, "a", { total_cost_usd: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 1000, cache_creation_tokens: 50, num_turns: 3, model_usage: mu(1), cache_creation_5m_tokens: 20, cache_creation_1h_tokens: 30 });
      const c = sumResultCosts(d, ["a"]);
      expect(c.records?.tokens_scope).toBe("all-models");
      expect(c.input_tokens).toBe(105); // main loop 100 plus the subagent model's 5
      expect(Object.keys(c.records!.per_model!)).toEqual(["m-main", "m-sub"]);
      expect(c.records?.turns).toBe(3);
      expect(c.records?.cache_creation_main_loop).toEqual({ ephemeral_5m_tokens: 20, ephemeral_1h_tokens: 30 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("modelUsage that does not reconcile is dropped: tokens stay main-loop labelled, no per_model", () => {
    const d = tmpCheckout();
    try {
      write(d, "a", { total_cost_usd: 1, input_tokens: 100, output_tokens: 10, model_usage: mu(0.5) });
      const c = sumResultCosts(d, ["a"]);
      expect(c.records?.tokens_scope).toBe("main-loop");
      expect(c.records?.per_model).toBeUndefined();
      expect(c.input_tokens).toBe(100);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("resume: a lower total proves the resumed session is separate, so both are summed", () => {
    const d = tmpCheckout();
    try {
      write(d, "impl", { total_cost_usd: 2, input_tokens: 10, output_tokens: 1, session_id: "S1" });
      write(d, "fix", { total_cost_usd: 0.5, input_tokens: 4, output_tokens: 1, session_id: "S1b", resumed_from: "S1" });
      const c = sumResultCosts(d, ["impl", "fix"]);
      expect(c.usd).toBe(2.5);
      expect(c.records?.resume).toBe("separate");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("resume: an equal-or-higher total could be cumulative, so dollars read NOT RECORDED (null), never a guess", () => {
    const d = tmpCheckout();
    try {
      write(d, "impl", { total_cost_usd: 2, input_tokens: 10, output_tokens: 1, session_id: "S1" });
      write(d, "fix", { total_cost_usd: 2.6, input_tokens: 14, output_tokens: 2, session_id: "S1", resumed_from: "S1" });
      const c = sumResultCosts(d, ["impl", "fix"]);
      expect(c.usd).toBeNull();
      expect(c.missing).toEqual(["fix"]);
      expect(c.records?.resume).toBe("ambiguous");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("R3-1: a missing session blocks the all-models override, so a partial modelUsage sum is never published as the run total", () => {
    const d = tmpCheckout();
    try {
      write(d, "a", { total_cost_usd: 1, input_tokens: 9, output_tokens: 1, cache_read_tokens: 7, cache_creation_tokens: 2, num_turns: 2, model_usage: { sonnet: { input_tokens: 9, output_tokens: 1, cache_read_tokens: 100, cache_creation_tokens: 5, cost_usd: 1 } } });
      const c = sumResultCosts(d, ["a", "missing"]);
      expect(c.usd).toBeNull();
      expect(c.tokens_measured).toEqual({ k: 1, n: 2 });
      expect(c.cache_read_seen).toBe(false);
      expect(c.cache_creation_seen).toBe(false);
      expect(c.records?.per_model).toBeUndefined();
      expect(c.records?.tokens_scope).toBeUndefined();
      expect(c.records?.turns).toBeUndefined();
      expect(c.cache_read_tokens).toBe(7); // main-loop figure of the one measured session, never the 100 from modelUsage
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("R3-2: an ambiguous resume is excluded from every summed figure, not only dollars", () => {
    const d = tmpCheckout();
    try {
      const base = { output_tokens: 1, cache_read_tokens: 1000, cache_creation_tokens: 10, num_turns: 2, duration_ms: 500 };
      write(d, "impl", { ...base, total_cost_usd: 1, input_tokens: 100, session_id: "S1", model_usage: mu(1) });
      write(d, "fix", { ...base, total_cost_usd: 1.4, input_tokens: 140, cache_read_tokens: 1400, session_id: "S1", resumed_from: "S1", model_usage: mu(1.4) });
      const c = sumResultCosts(d, ["impl", "fix"]);
      expect(c.usd).toBeNull();
      expect(c.missing).toEqual(["fix"]);
      expect(c.measuredCount).toBe(1);
      expect(c.partialUsd).toBe(1);
      expect(c.input_tokens).toBe(100);
      expect(c.cache_read_seen).toBe(false);
      expect(c.cache_creation_seen).toBe(false);
      expect(c.duration_ms).toBeUndefined();
      expect(c.records).toEqual({ resume: "ambiguous" });
      expect(c.tokens_measured).toEqual({ k: 1, n: 2 });
      expect(costTotalsOf(c).tokensMeasured).toEqual({ k: 1, n: 2 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("CH-03 chain: implement resumes plan's session; an equal-or-higher total is ambiguous, a lower one is separate", () => {
    const rec = (usd: number, id: string, from?: string) => ({ total_cost_usd: usd, input_tokens: 10, output_tokens: 1, session_id: id, ...(from ? { resumed_from: from } : {}) });
    const d = tmpCheckout();
    try {
      write(d, "plan", rec(0.3, "P"));
      write(d, "impl", rec(0.9, "P2", "P")); // higher than plan: could be cumulative
      const c = sumResultCosts(d, ["plan", "impl"]);
      expect(c.usd).toBeNull();
      expect(c.missing).toEqual(["impl"]);
      expect(c.records?.resume).toBe("ambiguous");
      write(d, "impl", rec(0.1, "P2", "P")); // lower than plan: provably a separate total
      const s = sumResultCosts(d, ["plan", "impl"]);
      expect(s.usd).toBeCloseTo(0.4, 10);
      expect(s.records?.resume).toBe("separate");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("CH-03 chain: each fix round resumes the session before it (plan, implement, fix1, fix2)", () => {
    const rec = (usd: number, id: string, from?: string) => ({ total_cost_usd: usd, input_tokens: 10, output_tokens: 1, session_id: id, ...(from ? { resumed_from: from } : {}) });
    const d = tmpCheckout();
    try {
      write(d, "plan", rec(0.5, "P"));
      write(d, "impl", rec(0.2, "I", "P"));      // separate (below plan)
      write(d, "fix1", rec(0.1, "F1", "I"));     // separate (below implement)
      write(d, "fix2", rec(0.15, "F2", "F1"));   // 0.15 >= fix1's 0.1: could be cumulative, so ambiguous
      const c = sumResultCosts(d, ["plan", "impl", "fix1", "fix2"]);
      expect(c.usd).toBeNull();
      expect(c.missing).toEqual(["fix2"]);
      expect(c.records?.resume).toBe("ambiguous");
      expect(c.tokens_measured).toEqual({ k: 3, n: 4 });
      expect(c.measuredCount).toBe(3);
      write(d, "fix2", rec(0.05, "F2", "F1"));   // below fix1: separate, the whole chain sums
      const s = sumResultCosts(d, ["plan", "impl", "fix1", "fix2"]);
      expect(s.usd).toBeCloseTo(0.85, 10);
      expect(s.records?.resume).toBe("separate");
      expect(s.tokens_measured).toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("R4-1: an ambiguous resumed session writes an efficiency record with NO token keys and tokens_measured:false, never zeros", () => {
    const d = tmpCheckout();
    try {
      const lokiRoot = join(d, ".loki");
      write(lokiRoot, "fix", { total_cost_usd: 1.4, input_tokens: 140, output_tokens: 1, cache_read_tokens: 1400, session_id: "S2", resumed_from: "S1" });
      recordSessionCost(lokiRoot, "fix", { status: "completed", durationMs: 5, model: "m" });
      const rec = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-1.json"), "utf8"));
      for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"]) expect(k in rec).toBe(false);
      expect(rec.tokens_measured).toBe(false);
      // a plain session still writes its numbers and no marker
      write(lokiRoot, "plan", { total_cost_usd: 0.5, input_tokens: 10, output_tokens: 1, session_id: "P" });
      recordSessionCost(lokiRoot, "plan", { status: "completed", durationMs: 5, model: "m" });
      const ok = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-2.json"), "utf8"));
      expect(ok.input_tokens).toBe(10);
      expect("tokens_measured" in ok).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("R4-1: a resume provably below its predecessor (found among sibling files) keeps its efficiency numbers", () => {
    const d = tmpCheckout();
    try {
      const lokiRoot = join(d, ".loki");
      write(lokiRoot, "impl", { total_cost_usd: 1.0, input_tokens: 100, output_tokens: 1, session_id: "S1" });
      write(lokiRoot, "fix", { total_cost_usd: 0.2, input_tokens: 20, output_tokens: 1, session_id: "S2", resumed_from: "S1" });
      recordSessionCost(lokiRoot, "fix", { status: "completed", durationMs: 5, model: "m" });
      const rec = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-1.json"), "utf8"));
      expect(rec.input_tokens).toBe(20);
      expect("tokens_measured" in rec).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a complete run carries no tokens_measured", () => {
    const d = tmpCheckout();
    try {
      write(d, "a", { total_cost_usd: 1, input_tokens: 9, output_tokens: 1 });
      expect(sumResultCosts(d, ["a"]).tokens_measured).toBeUndefined();
      expect("tokensMeasured" in costTotalsOf(sumResultCosts(d, ["a"]))).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("resume: a predecessor outside the summed set is ambiguous; a plain run has no resume key", () => {
    const d = tmpCheckout();
    try {
      write(d, "fix", { total_cost_usd: 1, input_tokens: 14, output_tokens: 2, session_id: "S2", resumed_from: "S1" });
      expect(sumResultCosts(d, ["fix"]).usd).toBeNull();
      write(d, "p", { total_cost_usd: 1, input_tokens: 1, output_tokens: 1 });
      expect(sumResultCosts(d, ["p"]).records?.resume).toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("RECEIPT-TRUTH cache keys through the real reader and the worker mapping (FC-44)", () => {
  const write = (dir: string, iter: string, rec: Record<string, unknown>): void => {
    mkdirSync(join(dir, "metrics"), { recursive: true });
    writeFileSync(join(dir, "metrics", `result-cost-${iter}.json`), JSON.stringify(rec));
  };
  test("no file carrying cache keys: seen flags are false (NOT RECORDED), not a measured 0", () => {
    const d = tmpCheckout();
    try {
      write(d, "e10-r1-a", { total_cost_usd: 0.1, input_tokens: 24, output_tokens: 9 });
      const c = sumResultCosts(d, ["e10-r1-a"]);
      expect(c.cache_read_seen).toBeFalsy();
      expect(costTotalsOf(c).cacheReadSeen).toBe(false);
      expect(c.cache_creation_seen).toBeFalsy();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a partial set is not a total: one of three sessions carrying the key leaves it unseen", () => {
    const d = tmpCheckout();
    try {
      write(d, "a", { total_cost_usd: 0.1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 100, cache_creation_tokens: 1 });
      write(d, "b", { total_cost_usd: 0.1, input_tokens: 1, output_tokens: 1 });
      const c = costTotalsOf(sumResultCosts(d, ["a", "b", "c"]));
      expect(c.cacheReadSeen).toBe(false);
      expect(c.cacheCreationSeen).toBe(false);
      expect(c.usd).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("every file carrying cache keys (even zero) sets the seen flags and sums duration_ms", () => {
    const d = tmpCheckout();
    try {
      write(d, "e10-r1-a", { total_cost_usd: 0.1, input_tokens: 24, output_tokens: 9, cache_read_tokens: 0, cache_creation_tokens: 7, duration_ms: 1500 });
      write(d, "e10-r1-b", { total_cost_usd: 0.1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 0, duration_ms: 500 });
      const c = sumResultCosts(d, ["e10-r1-a", "e10-r1-b"]);
      expect(c.cache_read_seen).toBe(true);
      expect(c.cache_creation_seen).toBe(true);
      expect(c.cache_creation_tokens).toBe(7);
      expect(c.duration_ms).toBe(2000);
      expect(costTotalsOf(c)).toMatchObject({ cacheReadSeen: true, cacheCreationSeen: true, cacheCreationTokens: 7, durationMs: 2000 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

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

  // E-98e: an unrecognized model id must never silently price at pricingFor's
  // sonnet fallback (budget.ts:170) -- the trap named in MEDIUM-ANALYSIS.md's
  // resized card. Neither "opus"/"sonnet"/"haiku"/"fable" nor an exact
  // data/model-pricing.json key appears in this id, so usd must stay null.
  test("E-98e: an unrecognized model id in a partial-usage file prices as unmeasured, not a fallback", () => {
    const checkout = tmpCheckout();
    const lokiRoot = join(checkout, ".loki");
    mkdirSync(join(lokiRoot, "metrics"), { recursive: true });
    try {
      writeFileSync(partialUsagePath(lokiRoot, "e10-r1-unknownmodel"), JSON.stringify({
        input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0, model: "future-model-9",
      }));
      const c = recordPartialStreamCost(lokiRoot, "e10-r1-unknownmodel", { status: "killed", durationMs: 90_000, model: "future-model-9" });
      expect(c.usd).toBeNull();
      expect(c.input_tokens).toBe(1_000_000); // tokens are still recorded even though price is unknown
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
