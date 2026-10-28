// loki-ts/tests/engine10/cost.test.ts
//
// E-06 wall check. Fixtures under fixtures/cost/<case>/metrics/ use the exact
// shape writeResultCost (src/runner/sdk_stream_parser.ts) writes.
// Unknown cost must be null, never 0.
import { describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costTotalsOf,
  nextEfficiencyIteration,
  recordSessionCost,
  sumChildLedger,
  sumResultCosts,
  sumRunCosts,
  writeEfficiencyRecord,
} from "../../src/engine10/cost.ts";
import { costBreakdown, stageShareText, topTierRate } from "../../src/util/cost_breakdown.ts";
import { partialUsagePath, recordPartialStreamCost } from "../../src/runner/budget.ts";
import { consumeSdkStream } from "../../src/runner/sdk_stream_parser.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { makeEvent, partialCost, runCostUsd, summaryCost } from "../../src/engine10/events.ts";
import { appendChildLedger, childSpendMeter, runCost } from "../../src/util/child_ledger.ts";
import { resumeVerdicts } from "../../src/contrib/cost_records.ts";
import { archivePriorCost, liveArchivedCosts } from "../../src/providers/provider_cost.ts";
import { UNMETERED } from "../../src/engine10/cost.ts";
import { execFileSync } from "node:child_process";
import { sealStage } from "../../src/engine10/stages/seal.ts";
import { workerCostReader } from "../../src/engine10/worker.ts";
import type { Obj, RunContext, StageName } from "../../src/engine10/types.ts";

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
  test("R5-1: a session with no result-cost file emits a cost event with NO token keys (same predicate as the efficiency record)", async () => {
    const d = tmpCheckout();
    try {
      const lokiRoot = join(d, ".loki");
      write(lokiRoot, "e10-a", { total_cost_usd: 0.5, input_tokens: 10, output_tokens: 20, session_id: "A" });
      const emitted: Record<string, unknown>[] = [];
      const run = (id: string, cmd: string) => createSessionRunner({ provider: "claude", lokiRoot, childCommand: ["bash", ["-c", cmd]], emit: (t: string, _s: unknown, data: Record<string, unknown>) => { if (t === "cost") emitted.push(data); } }).run({ stage: "implement", brief: "x", tier: "dev", iterationId: id, limitS: 30, signal: new AbortController().signal, cwd: d } as never);
      await run("e10-b", "exit 1");
      const ev = emitted.find((e) => e["session_id"] === "e10-b") as Record<string, unknown>;
      expect(ev).toBeDefined();
      for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]) expect(k in ev).toBe(false);
      const rec = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-1.json"), "utf8"));
      expect(rec.tokens_measured).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("R5-2: a killed session with no partial-usage file writes an efficiency record with NO token keys and tokens_measured:false, never a measured zero", () => {
    const d = tmpCheckout();
    try {
      const lokiRoot = join(d, ".loki");
      mkdirSync(join(lokiRoot, "metrics"), { recursive: true });
      const c = recordPartialStreamCost(lokiRoot, "e10-k", { status: "killed", durationMs: 5, model: "m" });
      expect(c.tokens_measured).toEqual({ k: 0, n: 1 });
      const rec = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-1.json"), "utf8"));
      for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"]) expect(k in rec).toBe(false);
      expect(rec.tokens_measured).toBe(false);
      // with a partial file the streamed usage is still recorded as measured
      writeFileSync(partialUsagePath(lokiRoot, "e10-k2"), JSON.stringify({ input_tokens: 7, output_tokens: 3, model: "claude-sonnet-5-5" }));
      const m = recordPartialStreamCost(lokiRoot, "e10-k2", { status: "killed", durationMs: 5, model: "m" });
      expect(m.tokens_measured).toBeUndefined();
      expect(JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-2.json"), "utf8")).input_tokens).toBe(7);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("R5-3: the FC-19 conflict-resume ('-r' iteration) at or above its predecessor comes out ambiguous and labelled", () => {
    const d = tmpCheckout();
    try {
      write(d, "e10-x-impl", { total_cost_usd: 1, input_tokens: 10, output_tokens: 1, session_id: "S1" });
      write(d, "e10-x-impl-r", { total_cost_usd: 1.5, input_tokens: 16, output_tokens: 2, session_id: "S1", resumed_from: "S1" });
      const c = sumResultCosts(d, ["e10-x-impl", "e10-x-impl-r"]);
      expect(c.records?.resume).toBe("ambiguous");
      expect(c.usd).toBeNull();
      expect(c.tokens_measured).toEqual({ k: 1, n: 2 });
      expect(c.input_tokens).toBe(10);
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
    const c = sumResultCosts(join(FIX, "two"), ["e10-r1-plan"]);
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
    const c = sumResultCosts(join(FIX, "two"), ["e10-r1-nope"]);
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
    expect(sumResultCosts(join(FIX, "bad"), ["e10-r1-nousd"]).usd).toBeNull();
    expect(sumResultCosts(join(FIX, "bad"), ["e10-r1-trunc"]).usd).toBeNull();
  });

  // E-69 (EV-8 failure mode: "Cost: $0.00 (claude, 0 tokens)"): a result-cost file
  // reporting total_cost_usd 0 with zero usage on every token field is a session
  // that never really ran; it must read as unmeasured, never a real $0.00.
  test("total_cost_usd 0 with zero tokens on every field is unmeasured (EV-8)", () => {
    const c = sumResultCosts(join(FIX, "zero"), ["e10-r1-zero"]);
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
    const c = sumResultCosts(join(FIX, "free"), ["e10-r1-free"]);
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

      const priced = sumResultCosts(join(FIX, "two"), ["e10-r1-plan"]);
      const n1 = writeEfficiencyRecord(lokiRoot, { status: "completed", durationMs: 12000, model: "claude-x" }, priced);
      expect(n1).toBe(1);
      const rec1 = JSON.parse(readFileSync(join(lokiRoot, "metrics", "efficiency", "iteration-1.json"), "utf8"));
      expect(rec1).toMatchObject({
        iteration: 1, status: "completed", duration_ms: 12000, model: "claude-x",
        cost_usd: 0.125, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, cache_creation_tokens: 300,
      });
      expect(rec1.cost_source).toBe("provider");

      // second session: no dollars reported -> cost_usd must be ABSENT, never 0.
      const unpriced = sumResultCosts(join(FIX, "bad"), ["e10-r1-nousd"]);
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
      // result-cost file was ever written for it) -- sumResultCosts own
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

describe("P12-21 cost attribution breakdown", () => {
  const put = (dir: string, iter: string, rec: Record<string, unknown>): void => {
    mkdirSync(join(dir, "metrics"), { recursive: true });
    writeFileSync(join(dir, "metrics", `result-cost-${iter}.json`), JSON.stringify(rec));
  };
  const base = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_creation_tokens: 7 };

  test("per-stage and retry usd sum to the run usd, cache tokens carried", () => {
    const d = tmpCheckout();
    try {
      put(d, "1", { ...base, total_cost_usd: 0.5, stage: "dev" });
      put(d, "2", { ...base, total_cost_usd: 0.25, stage: "dev", retry: true });
      put(d, "3", { ...base, total_cost_usd: 0.25, stage: "test", attempt: 2 });
      put(d, "4", { ...base, total_cost_usd: 1 });
      const c = sumResultCosts(d, ["1", "2", "3", "4"]);
      const b = c.breakdown!;
      expect(c.usd).toBe(2);
      expect(b.usd).toBe(c.usd);
      expect(Object.values(b.per_stage).reduce((a, s) => a + (s.usd ?? NaN), 0)).toBe(c.usd as number);
      expect(b.per_stage["dev"]).toMatchObject({ usd: 0.75, sessions: 2, cache_read_tokens: 200, cache_creation_tokens: 14 });
      expect(b.per_stage["unattributed"]!.usd).toBe(1);
      expect(b.retry_usd).toBe(0.5);
      expect(b.retry_sessions).toBe(2);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("per-stage cache_hit_ratio is read / (read + creation), null when no cache tokens", () => {
    const d = tmpCheckout();
    try {
      put(d, "1", { input_tokens: 1, output_tokens: 1, cache_read_tokens: 7000, cache_creation_tokens: 0, total_cost_usd: 0.1, stage: "implement" });
      put(d, "2", { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 7000, total_cost_usd: 0.1, stage: "implement" });
      put(d, "3", { input_tokens: 1, output_tokens: 1, total_cost_usd: 0.1, stage: "plan" });
      const b = sumResultCosts(d, ["1", "2", "3"]).breakdown!;
      expect(b.per_stage["implement"]).toMatchObject({ cache_read_tokens: 7000, cache_creation_tokens: 7000, cache_hit_ratio: 0.5 });
      expect(b.per_stage["plan"]!.cache_hit_ratio).toBeNull();
      expect(b.per_stage["plan"]!.cache_read_tokens).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("non-finite or negative cost fails closed to null, never summed as zero", () => {
    const d = tmpCheckout();
    try {
      put(d, "1", { ...base, total_cost_usd: 0.5, stage: "dev" });
      put(d, "2", { ...base, total_cost_usd: "NaN", stage: "dev", retry: true });
      put(d, "3", { ...base, total_cost_usd: -1, stage: "test" });
      put(d, "4", { ...base, total_cost_usd: 2, stage: "ship" });
      const b = sumResultCosts(d, ["1", "2", "3", "4"]).breakdown!;
      expect(b.usd).toBeNull();
      expect(b.per_stage["dev"]!.usd).toBeNull();
      expect(b.per_stage["test"]!.usd).toBeNull();
      expect(b.per_stage["ship"]!.usd).toBe(2);
      expect(b.retry_usd).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("all-zero-usage record (E-69) and a missing file null the breakdown exactly when run usd is null", () => {
    const d = tmpCheckout();
    try {
      put(d, "1", { total_cost_usd: 0.5, input_tokens: 1, output_tokens: 1, stage: "dev" });
      put(d, "2", { total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, stage: "test" });
      const z = sumResultCosts(d, ["1", "2"]);
      expect(z.usd).toBeNull();
      expect(z.breakdown!.usd).toBeNull();
      expect(z.breakdown!.per_stage["test"]!.usd).toBeNull();
      expect(z.breakdown!.per_stage["dev"]!.usd).toBe(0.5);
      const m = sumResultCosts(d, ["1", "9"]);
      expect(m.usd).toBeNull();
      expect(m.breakdown!.usd).toBeNull();
      const ok = sumResultCosts(d, ["1"]);
      expect(ok.breakdown!.usd).toBe(ok.usd as number);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("writeResultCost emits stage and attempt, sumResultCosts attributes them", async () => {
    const d = tmpCheckout();
    const prev = { s: process.env["LOKI_E10_STAGE"], a: process.env["LOKI_E10_ATTEMPT"] };
    try {
      process.env["LOKI_E10_STAGE"] = "verify"; process.env["LOKI_E10_ATTEMPT"] = "2";
      const usage = { input_tokens: 5, output_tokens: 5 };
      await consumeSdkStream([{ type: "result", is_error: false, total_cost_usd: 0.3, usage }], { cwd: d, iteration: "1", hookEventsEnabled: false, write: () => {} });
      const b = sumResultCosts(join(d, ".loki"), ["1"]).breakdown!;
      expect(Object.keys(b.per_stage)).toEqual(["verify"]);
      expect(b.retry_usd).toBe(0.3);
    } finally {
      for (const [k, v] of [["LOKI_E10_STAGE", prev.s], ["LOKI_E10_ATTEMPT", prev.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("TEN-COST-28 per-stage spend share in the summary", () => {
  const ev = (stage: string, usd: number | null, source = "x") => ({ type: "cost", stage, data: { usd, source } });
  test("shares sum to 100 and the top stage is named", async () => {
    const { stageShareText } = await import("../../src/util/cost_breakdown.ts");
    const t = stageShareText([ev("plan", 1), ev("implement", 1), ev("fix", 1), ev("implement", 1)])!;
    expect(t).toBe("plan 25%, implement 50%, fix 25%; top: implement; savings not measured");
    const odd = stageShareText([ev("plan", 1), ev("wall", 1), ev("fix", 1)])!;
    expect(odd.match(/(\d+)%/g)!.reduce((a, p) => a + parseInt(p, 10), 0)).toBe(100);
  });
  test("unpriced or unmetered stages say unmetered, never 0; nothing metered is null", async () => {
    const { stageShareText } = await import("../../src/util/cost_breakdown.ts");
    expect(stageShareText([ev("plan", 3), ev("xreview", null), ev("fix", 0, "cli-invoker-unmetered"), ev("implement", 1)]))
      .toBe("plan 75%, xreview unmetered, fix unmetered, implement 25%; top: plan; savings not measured");
    expect(stageShareText([ev("plan", null), ev("fix", null)])).toBeNull();
    expect(stageShareText([ev("plan", 2)])).toBeNull();
  });
  test("renderMainOutput prints a Spend line under Cost and omits it when absent", async () => {
    const { renderMainOutput } = await import("../../src/engine10/supervisor.ts");
    const { stageShareText } = await import("../../src/util/cost_breakdown.ts");
    const events = [{ v: 1, seq: 1, ts: "t", run: "r", ...ev("plan", 1) }, { v: 1, seq: 2, ts: "t", run: "r", ...ev("fix", 3) }] as never[];
    const base = { pr: null, verdict: "VERIFIED", notProven: [], flaky: [], wallS: 1, stages: [] };
    const withS = renderMainOutput(events, { ...base, cost: { usd: 4, provider: "claude", tokens: 1, stageShares: stageShareText(events) } } as never);
    expect(withS).toContain("Spend:");
    expect(withS).toContain("plan 25%, fix 75%; top: fix");
    expect(withS.indexOf("Cost:")).toBeLessThan(withS.indexOf("Spend:"));
    expect(renderMainOutput(events, { ...base, cost: { usd: 4, provider: "claude", tokens: 1 } } as never)).not.toContain("Spend:");
  });
});

// #409: savings vs the top Claude tier, derived from model-pricing.json
describe("savings_usd (#409)", () => {
  const stages = [["plan", 1200, 300, 40000, 2000, 0.31], ["implement", 9000, 4000, 120000, 15000, 0.9], ["verify", 500, 200, 9000, 0, 0.05], ["review", 3000, 800, 30000, 1000, 0.2]] as const;
  const recs = stages.map(([stage, i, o, r, w, usd]) => ({ iter: stage, rec: { stage, total_cost_usd: usd, input_tokens: i, output_tokens: o, cache_read_tokens: r, cache_creation_tokens: w } }));
  const events = stages.map(([stage, i, o, r, w, usd]) => ({ type: "cost", stage, data: { usd, source: "x", input_tokens: i, output_tokens: o, cache_read_tokens: r, cache_creation_tokens: w } }));
  const top = topTierRate()!;
  const cf = stages.reduce((a, [, i, o, r, w]) => a + (i * top.input + o * top.output + r * top.read + w * top.write) / 1e6, 0);
  const actual = stages.reduce((a, s) => a + s[5], 0);
  test("top tier is derived from the pricing table, with its own cache rates", () => {
    expect(top.output).toBeGreaterThan(20);
    expect(top.read).toBeLessThan(top.input);
  });
  test("savings_usd equals counterfactual minus actual and text agrees", () => {
    const b = costBreakdown(recs);
    expect(Math.abs(b.savings_usd! - (cf - actual))).toBeLessThan(0.01);
    expect(cf - actual).toBeLessThan(0);
    expect(b.savings_usd!).toBeLessThan(0);
    const t = stageShareText(events);
    expect(t).toContain(`cost $${(actual - cf).toFixed(2)} more than top tier`);
    expect(t).not.toContain("saved $");
    expect(t).not.toContain("no savings");
  });
  const one = (usd: number, input: number) => ({ type: "cost", stage: "plan", data: { usd, source: "x", input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } });
  const two = (usd: number, input: number) => [one(usd, input), { ...one(0, 0), stage: "fix" }];
  const oneRec = (usd: number, input: number) => [{ iter: "plan", rec: { stage: "plan", total_cost_usd: usd, input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }];
  test("actual above top-tier price keeps signed JSON and renders no savings, never saved $-X", () => {
    const input = 1_000_000, cfv = top.input;
    expect(costBreakdown(oneRec(cfv + 3, input)).savings_usd!).toBeLessThan(0);
    const t = stageShareText(two(cfv + 3, input));
    expect(t).toContain("cost $3.00 more than top tier");
    expect(t).not.toContain("saved $-");
    expect(t).not.toContain("no savings");
  });
  test("a tiny negative or zero value never renders $-0.00 or saved $0.00", () => {
    const input = 1_000_000, cfv = top.input;
    for (const usd of [cfv + 0.004, cfv + 0.0049, cfv]) {
      const t = stageShareText(two(usd, input));
      expect(t).not.toContain("$-0.00");
      expect(t).not.toContain("saved $0.00");
      expect(t).not.toContain("more than top tier");
      expect(t).toContain("no difference vs top tier");
    }
  });
  test("a cheaper counterfactual is a cost increase, never positive savings", () => {
    const t = stageShareText(two(top.input + 0.5, 1_000_000))!;
    expect(t).toContain("cost $0.50 more than top tier");
    expect(t).not.toContain("saved");
  });
  test("unknown cost renders as not measured, never 0 or no difference", () => {
    const unk = { ...one(0, 1000), data: { usd: 0, source: "cli-invoker-unmetered", input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    const u = stageShareText([unk, { ...one(1, 1000), stage: "fix" }]) ?? "";
    expect(u).toContain("savings not measured");
    expect(u).not.toContain("no difference");
    expect(u).not.toContain("no savings");
    const nan = stageShareText([one(NaN, 1000), { ...one(1, 1000), stage: "fix" }]) ?? "";
    expect(nan).not.toContain("no difference");
    expect(nan).not.toContain("$0.00");
  });
  test("positive savings render exactly saved $X.XX vs top tier", () => {
    const input = 1_000_000, cfv = top.input;
    const usd = Math.max(0, cfv - 2.5);
    expect(costBreakdown(oneRec(usd, input)).savings_usd!).toBeCloseTo(cfv - usd, 3);
    expect(stageShareText(two(usd, input))).toContain(`saved $${(cfv - usd).toFixed(2)} vs top tier`);
  });
  test("an unmeasured stage makes savings null and the text says not measured, never 0", () => {
    const bad = recs.map((r, i) => (i === 2 ? { ...r, rec: { stage: "verify", total_cost_usd: 0.05 } } : r));
    expect(costBreakdown(bad).savings_usd).toBeNull();
    const ev = events.map((e, i) => (i === 2 ? { ...e, data: { usd: 0.05, source: "x" } } : e));
    expect(stageShareText(ev)).toContain("savings not measured");
    expect(costBreakdown(recs, ["it-9"]).savings_usd).toBeNull();
  });
});

describe("one cost ledger: per-session deltas, child sessions, fail closed", () => {
  const write = (dir: string, iter: string, rec: Record<string, unknown>): void => {
    mkdirSync(join(dir, "metrics"), { recursive: true });
    writeFileSync(join(dir, "metrics", `result-cost-${iter}.json`), JSON.stringify(rec));
  };
  const mu = (cost: number, out: number) => ({ "m-main": { input_tokens: 10, output_tokens: out, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: cost } });
  // run5 shape: the resumed file's total_cost_usd and model_usage are cumulative (plan + implement), its top-level output_tokens are the implement call only.
  const plan = { total_cost_usd: 0.0233, input_tokens: 10, output_tokens: 1261, session_id: "P1", model_usage: mu(0.0233, 1261) };
  const impl = { total_cost_usd: 0.0366, input_tokens: 10, output_tokens: 300, session_id: "P1", resumed_from: "P1", model_usage: mu(0.0366, 1561) };
  test("a resumed implement after plan counts only its own delta, never the parent again", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", plan); write(d, "impl", impl);
      const c = sumResultCosts(d, ["plan", "impl"]);
      expect(c.usd).toBeCloseTo(0.0366, 10); // plan 0.0233 + implement delta 0.0133, not 0.0599 and not null
      expect(c.missing).toEqual([]);
      expect(c.records?.resume).toBe("delta");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a resumed total that is not provably cumulative stays unknown, never guessed", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", plan); write(d, "impl", { ...impl, model_usage: undefined });
      const c = sumResultCosts(d, ["plan", "impl"]);
      expect(c.usd).toBeNull();
      expect(c.missing).toEqual(["impl"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a cross-review child session is included in the run total", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", plan); write(d, "impl", impl);
      writeFileSync(join(d, "metrics", "child-sessions.jsonl"), `${JSON.stringify({ phase: "xreview", model: "m", usd: 0.0349, run_id: "R1", source: "x" })}\n${JSON.stringify({ phase: "xreview", model: "m", usd: 9, run_id: "OTHER", source: "x" })}\n`);
      const c = sumRunCosts(d, ["plan", "impl"], [], "R1");
      expect(c.usd).toBeCloseTo(0.0715, 10);
      expect(c.measuredCount).toBe(3);
      expect(c.totalCount).toBe(3);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a child line with no dollar figure makes the run total unknown, with the measured part kept", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", plan);
      writeFileSync(join(d, "metrics", "child-sessions.jsonl"), `${JSON.stringify({ phase: "wall", model: "m", cost_status: "unmeasured", run_id: "R1", source: "x" })}\n`);
      expect(sumChildLedger(d, "R1")).toEqual({ usd: null, partialUsd: 0, measured: 0, total: 1, inputTokens: 0, outputTokens: 0 });
      const c = sumRunCosts(d, ["plan"], [], "R1");
      expect(c.usd).toBeNull();
      expect(c.partialUsd).toBeCloseTo(0.0233, 10);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  // F1 run5 replay: stage cost events (plan 0.0233, implement delta 0.0133) plus one reviewer child line of 0.0286235.
  const child = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ phase: "reviewer", model: "m", input_tokens: 5, output_tokens: 7, usd: 0.0286235, run_id: "R1", source: "x", ...extra })}\n`;
  const costEvents = [makeEvent("R1", 0, "cost", "plan", { session_id: "plan", usd: 0.0233 }), makeEvent("R1", 1, "cost", "implement", { session_id: "impl", usd: 0.0133 })];
  test("F1: run.completed total equals the receipt total and includes the child ledger", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", plan); write(d, "impl", impl);
      writeFileSync(join(d, "metrics", "child-sessions.jsonl"), child());
      const receipt = sumRunCosts(d, ["plan", "impl"], [], "R1").usd;
      expect(receipt).toBeCloseTo(0.0366 + 0.0286235, 10);
      expect(runCostUsd(costEvents, false, d)).toBe(receipt);
      expect(summaryCost(costEvents, false, d).usd).toBe(receipt);
      expect(partialCost(costEvents, false, d).total).toBe(3);
      expect(runCostUsd(costEvents, true, d)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("F1: a child line that cannot be priced, read or attributed makes the run total null, never an undercount", () => {
    for (const ledger of [child({ usd: undefined, cost_status: "unmeasured" }), child({ usd: 0, input_tokens: 0, output_tokens: 0 }), `${child()}{"run_id":"R1","usd":\n`]) {
      const d = tmpCheckout();
      try {
        mkdirSync(join(d, "metrics"), { recursive: true });
        writeFileSync(join(d, "metrics", "child-sessions.jsonl"), ledger);
        expect(runCostUsd(costEvents, false, d)).toBeNull();
      } finally { rmSync(d, { recursive: true, force: true }); }
    }
    const d = tmpCheckout();
    try {
      mkdirSync(join(d, "metrics", "child-sessions.jsonl"), { recursive: true });
      expect(runCostUsd(costEvents, false, d)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("F1: sumRunCosts breakdown.usd agrees with usd", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", plan); write(d, "impl", impl);
      writeFileSync(join(d, "metrics", "child-sessions.jsonl"), child());
      const c = sumRunCosts(d, ["plan", "impl"], [], "R1");
      expect(c.breakdown?.usd).toBe(c.usd);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  // F2: plan, middle and impl all carry session P1 (the SDK keeps the id across resumes); totals are cumulative.
  const link = (usd: number, ownOut: number, cumOut: number, from?: string) => ({ total_cost_usd: usd, input_tokens: 10, output_tokens: ownOut, session_id: "P1", ...(from ? { resumed_from: from } : {}), model_usage: mu(usd, cumOut) });
  test("F2: a 3-link chain subtracts the immediate predecessor, so the parent is counted once", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", link(0.02, 100, 100)); write(d, "mid", link(0.03, 50, 150, "P1")); write(d, "impl", link(0.05, 50, 200, "P1"));
      const c = sumResultCosts(d, ["plan", "mid", "impl"]);
      expect(c.usd).toBeCloseTo(0.05, 10); // not 0.06
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("F2: a link with zero output but nonzero cost is ambiguous, total null", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", link(0.02, 100, 100)); write(d, "mid", link(0.03, 0, 100, "P1")); write(d, "impl", link(0.05, 50, 150, "P1"));
      const c = sumResultCosts(d, ["plan", "mid", "impl"]);
      expect(c.usd).toBeNull();
      expect(c.missing).toContain("mid");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("one cost ledger: quota reruns, torn lines, children bucket", () => {
  const write = (dir: string, iter: string, rec: Record<string, unknown>): void => {
    mkdirSync(join(dir, "metrics"), { recursive: true });
    writeFileSync(join(dir, "metrics", `result-cost-${iter}.json`), JSON.stringify(rec));
  };
  const quota = { total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, source: "sdk" };
  const real = { total_cost_usd: 1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, source: "sdk" };
  const withRunId = <T>(id: string | undefined, fn: () => T): T => {
    const prev = process.env["LOKI_E10_RUN_ID"];
    if (id === undefined) delete process.env["LOKI_E10_RUN_ID"]; else process.env["LOKI_E10_RUN_ID"] = id;
    try { return fn(); } finally { if (prev === undefined) delete process.env["LOKI_E10_RUN_ID"]; else process.env["LOKI_E10_RUN_ID"] = prev; }
  };

  test("a quota rerun: the event-log total and the receipt total are the same number", () => {
    const d = tmpCheckout();
    try {
      write(d, "implement", quota); archivePriorCost(d, "implement"); write(d, "implement", real); // attempt 1 hit quota (archived -q1), attempt 2 ran
      const events = [makeEvent("R1", 0, "cost", "implement", { session_id: "implement", usd: null }), makeEvent("R1", 1, "cost", "implement", { session_id: "implement", usd: 1 })];
      const receipt = sumRunCosts(d, liveArchivedCosts(d, ["implement"], UNMETERED), [], "R1");
      expect(receipt.usd).toBe(1);
      expect(runCostUsd(events, false, d)).toBe(receipt.usd);
      expect(summaryCost(events, false, d).usd).toBe(receipt.usd);
      expect(runCost(events, d)).toMatchObject({ usd: receipt.usd, partialUsd: receipt.partialUsd, measuredCount: receipt.measuredCount, totalCount: receipt.totalCount });
      expect(partialCost(events, false, d)).toEqual({ measured: 1, total: 1, usd: 1 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a rerun whose first attempt was a real unpriced session stays unknown", () => {
    const d = tmpCheckout();
    try {
      write(d, "implement", { ...quota, input_tokens: 9 }); archivePriorCost(d, "implement"); write(d, "implement", real); // $0 with real usage is not the never-ran shape
      const events = [makeEvent("R1", 0, "cost", "implement", { session_id: "implement", usd: null }), makeEvent("R1", 1, "cost", "implement", { session_id: "implement", usd: 1 })];
      expect(runCostUsd(events, false, d)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  const rec = { phase: "reviewer", model: "m", input_tokens: 5, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0, usd: 0.25, source: "x" };
  test("a ledger line torn at ANY byte of the real writer's output never undercounts this run", () => {
    const d = tmpCheckout();
    try {
      withRunId("R1", () => appendChildLedger(d, rec));
      const full = readFileSync(join(d, "metrics", "child-sessions.jsonl"), "utf8").trimEnd();
      expect(sumChildLedger(d, "R1")).toMatchObject({ usd: 0.25, total: 1 });
      for (let i = 1; i < full.length; i++) {
        writeFileSync(join(d, "metrics", "child-sessions.jsonl"), full.slice(0, i));
        const k = sumChildLedger(d, "R1");
        expect(k.usd).toBeNull(); // cut at byte i: unknown, never the 0 of a skipped line
        expect(k.total).toBe(1);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a torn line that provably names another run does not blank this run", () => {
    const d = tmpCheckout();
    try {
      withRunId("R2", () => appendChildLedger(d, rec));
      const other = readFileSync(join(d, "metrics", "child-sessions.jsonl"), "utf8").trimEnd();
      writeFileSync(join(d, "metrics", "child-sessions.jsonl"), `${other.slice(0, other.length - 9)}\n`);
      withRunId("R1", () => appendChildLedger(d, rec));
      expect(sumChildLedger(d, "R1")).toMatchObject({ usd: 0.25, total: 1 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  const ledger = (d: string): string => join(d, "metrics", "child-sessions.jsonl");
  test("a real torn write (no newline) followed by another run's append never loses this run's cost", () => {
    const d = tmpCheckout();
    try {
      withRunId("E", () => appendChildLedger(d, { ...rec, usd: 0.2 }));
      withRunId("other", () => appendChildLedger(d, { ...rec, usd: 9 }));
      appendFileSync(ledger(d), '{"run_id":"other","phase":"xr'); // torn: NO newline after the fragment
      withRunId("E", () => appendChildLedger(d, { ...rec, usd: 5 })); // the writer starts a fresh line, so nothing glues
      expect(sumChildLedger(d, "E")).toMatchObject({ usd: 5.2, total: 2, measured: 2 });
      const text = readFileSync(ledger(d), "utf8");
      expect(text).toContain('xr\n{"run_id":"E"'); // the fragment stayed on its own line
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a torn write cut to 30 bytes then a new run's append: the new run is exact, the old run is unknown", () => {
    const d = tmpCheckout();
    try {
      withRunId("R0", () => appendChildLedger(d, rec));
      truncateSync(ledger(d), 30);
      withRunId("R1", () => appendChildLedger(d, { ...rec, usd: 5 }));
      expect(sumChildLedger(d, "R1")).toMatchObject({ usd: 5, total: 1 });
      expect(sumChildLedger(d, "R0").usd).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a fragment glued onto this run's record (an old writer) makes the total unknown, never an undercount", () => {
    const d = tmpCheckout();
    try {
      mkdirSync(join(d, "metrics"), { recursive: true });
      const own = JSON.stringify({ run_id: "E", ...rec, usd: 5 });
      writeFileSync(ledger(d), `${JSON.stringify({ run_id: "E", ...rec, usd: 0.2 })}\n{"run_id":"other","phase":"xr${own}\n`); // the old writer glued E's record onto a torn fragment
      expect(sumChildLedger(d, "E").usd).toBeNull();
      expect(sumChildLedger(d, "E").partialUsd).toBeCloseTo(0.2, 10);
      expect(sumChildLedger(d, "Z")).toMatchObject({ usd: 0, total: 0 }); // a run named in no part of the glued line is unaffected
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("an old torn fragment before this run's first record does not blank the run, one after its first record does", () => {
    const d = tmpCheckout();
    try {
      mkdirSync(join(d, "metrics"), { recursive: true });
      writeFileSync(ledger(d), '{"run_id":"old","pha\n{"ph\n'); // old fragments, one unattributable
      withRunId("E", () => appendChildLedger(d, { ...rec, usd: 0.5 }));
      expect(sumChildLedger(d, "E")).toMatchObject({ usd: 0.5, total: 1 });
      appendFileSync(ledger(d), '{"ph\n'); // unattributable fragment AFTER this run started
      expect(sumChildLedger(d, "E").usd).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a torn fragment with no id that is a prefix of this run's record start makes the total unknown, wherever it sits", () => {
    for (const frag of ['{"ru', "{", '{"run_id"']) {
      const d = tmpCheckout();
      try {
        withRunId("other", () => appendChildLedger(d, { ...rec, usd: 9 }));
        appendFileSync(ledger(d), `${frag}\n`); // torn, before E's first record and not the last line
        withRunId("E", () => appendChildLedger(d, { ...rec, usd: 5 }));
        expect(sumChildLedger(d, "E").usd).toBeNull();
        expect(sumChildLedger(d, "E").partialUsd).toBe(5);
      } finally { rmSync(d, { recursive: true, force: true }); }
    }
  });
  test("an unattributable fragment after this run's own record that is not the last line makes the total unknown", () => {
    for (const frag of ['{"ru', '{"ph']) {
      const d = tmpCheckout();
      try {
        withRunId("E", () => appendChildLedger(d, { ...rec, usd: 0.2 }));
        appendFileSync(ledger(d), `${frag}\n`);
        withRunId("E", () => appendChildLedger(d, { ...rec, usd: 5 }));
        expect(sumChildLedger(d, "E").usd).toBeNull();
      } finally { rmSync(d, { recursive: true, force: true }); }
    }
  });
  test("the writer puts run_id first, whether from the env or the record", () => {
    const d = tmpCheckout();
    try {
      withRunId("R1", () => { appendChildLedger(d, rec); appendChildLedger(d, { ...rec, run_id: "R9" }); });
      const lines = readFileSync(join(d, "metrics", "child-sessions.jsonl"), "utf8").trim().split("\n");
      expect(lines[0]!.startsWith('{"run_id":"R1",')).toBe(true);
      expect(lines[1]!.startsWith('{"run_id":"R9",')).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("scope is truthful: tokens and per_stage are stage-only, the children bucket carries the rest, per_stage + children_usd = usd", () => {
    const d = tmpCheckout();
    try {
      write(d, "plan", { ...real, total_cost_usd: 1, session_id: "S1" });
      withRunId("R1", () => appendChildLedger(d, rec));
      const c = sumRunCosts(d, ["plan"], [], "R1");
      expect(c.usd).toBeCloseTo(1.25, 10);
      expect(c.input_tokens).toBe(10); expect(c.output_tokens).toBe(5); // stage sessions only
      expect(c.children).toEqual({ usd: 0.25, partial_usd: 0.25, sessions: 1, measured: 1, input_tokens: 5, output_tokens: 7 });
      const stageUsd = Object.values(c.breakdown!.per_stage).reduce((t, s) => t + (s.usd ?? 0), 0);
      expect(stageUsd + (c.breakdown!.children_usd as number)).toBeCloseTo(c.usd as number, 10);
      expect(c.breakdown!.usd).toBe(c.usd);
      expect(costTotalsOf(c).children).toEqual(c.children);
      expect(sumRunCosts(d, ["plan"], [], "R-none").children).toBeUndefined(); // a run without children carries no bucket
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("childSpendMeter reports only the spend added after it was created", () => {
    const d = tmpCheckout();
    try {
      withRunId("R1", () => appendChildLedger(d, rec));
      const spent = childSpendMeter(d, "R1");
      expect(spent()).toBe(0);
      withRunId("R1", () => appendChildLedger(d, rec));
      withRunId("R2", () => appendChildLedger(d, rec));
      expect(spent()).toBeCloseTo(0.25, 10);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("resume predecessor ties", () => {
  test("two candidates tied at the best total are ambiguous: no usd, never the first one", () => {
    // Only the FIRST tied candidate happens to prove a cumulative delta, so a first-wins pick would bill "3" a delta against an arbitrary parent.
    const recs = [
      { iter: "1", rec: { session_id: "S", total_cost_usd: 1, model_usage: { m: { output_tokens: 10, cost_usd: 1 } } } },
      { iter: "2", rec: { session_id: "S", total_cost_usd: 1, model_usage: { m: { output_tokens: 99, cost_usd: 1 } } } },
      { iter: "3", rec: { session_id: "T", resumed_from: "S", total_cost_usd: 2, output_tokens: 5, model_usage: { m: { output_tokens: 15, cost_usd: 2 } } } },
    ];
    const v = resumeVerdicts(recs);
    expect(v.ambiguous).toContain("3"); // M3: picking top[0] on a tie lets "3" become a delta against an arbitrary parent
    expect(v.delta["3"]).toBeUndefined();
    expect(v.separate).not.toContain("3");
  });
  test("a single best candidate is still the parent", () => {
    const recs = [
      { iter: "1", rec: { session_id: "S", total_cost_usd: 1 } },
      { iter: "2", rec: { session_id: "S", total_cost_usd: 1.5 } },
      { iter: "3", rec: { session_id: "T", resumed_from: "S", total_cost_usd: 0.5 } },
    ];
    expect(resumeVerdicts(recs).separate).toContain("3"); // every candidate is above 0.5: the lowest (1) is the unique parent and 0.5 < 1 proves a separate session
  });
});

describe("the sealed receipt carries this run's child sessions (worker cost reader through the seal stage)", () => {
  const sh = (cwd: string, ...argv: string[]): string => execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
  const sealWith = async (cost: RunContext["cost"], repo: string): Promise<{ cost: { usd: number | null; children?: { usd: number | null; sessions: number } } }> => {
    mkdirSync(join(repo, ".loki/runs/R1"), { recursive: true });
    sh(repo, "git", "init", "-q", "-b", "main"); sh(repo, "git", "config", "user.name", "t"); sh(repo, "git", "config", "user.email", "t@t.invalid");
    writeFileSync(join(repo, "a.txt"), "one\n"); sh(repo, "git", "add", "a.txt"); sh(repo, "git", "commit", "-q", "-m", "base");
    const base = sh(repo, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "a.txt"), "two\n"); sh(repo, "git", "commit", "-q", "-am", "work");
    const outputs = {
      intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", resumed: false }, wall: { files: [] }, implement: { exit: "done", iteration_ids: ["plan"] },
      verify: { checks: [{ name: "bun:w.test.ts", cmd: "bun test", result: "pass", n: 2, duration_s: 1 }], flaky: [], wall_passed: true, target_checks: [] },
    } as Partial<Record<StageName, Obj>>;
    const ctx: RunContext = {
      runId: "R1", repoDir: repo, runDir: join(repo, ".loki/runs/R1"), baseSha: base, branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
      emit: () => {}, sessions: { run: async () => ({ exit: 0 }) as never },
      tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
      cost, clock: { now: () => Date.now() }, outputs: () => outputs,
    };
    const r = await sealStage.run(ctx, new AbortController().signal);
    return JSON.parse(readFileSync(r.data.receipt_path as string, "utf8"));
  };
  test("stage cost plus this run's child ledger lines appear on the sealed receipt, and another run's lines do not", async () => {
    const repo = mkdtempSync(join(tmpdir(), "e10-seal-cost-"));
    try {
      mkdirSync(join(repo, ".loki", "metrics"), { recursive: true });
      writeFileSync(join(repo, ".loki", "metrics", "result-cost-plan.json"), JSON.stringify({ total_cost_usd: 1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, source: "sdk", session_id: "S1" }));
      const lokiDir = join(repo, ".loki"), r = { phase: "reviewer", model: "m", input_tokens: 5, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0, source: "x" };
      appendChildLedger(lokiDir, { ...r, run_id: "R1", usd: 0.25 }); appendChildLedger(lokiDir, { ...r, run_id: "R2", usd: 9 });
      const receipt = await sealWith(workerCostReader("R1"), repo);
      expect(receipt.cost.usd).toBeCloseTo(1.25, 10); // X6: a reader that drops the run id sums no children and seals 1
      expect(receipt.cost.children).toMatchObject({ usd: 0.25, sessions: 1 });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
