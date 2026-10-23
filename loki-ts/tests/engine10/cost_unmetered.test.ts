import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// D48: a CLI-invoker (stub) session has no provider dollars. It records 0 with an explicit marker, never null;
// the same zero-usage file WITHOUT the marker stays unmeasured (E-69).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageMedianGapMs, writeEfficiencyRecord } from "../../src/providers/provider_cost.ts";
import { childEnv } from "../../src/engine10/session.ts";
import { PREFIX_COMPONENTS, cacheTtlFor, idleGapMs, prefixParts, prefixSha, stageShareText } from "../../src/util/cost_breakdown.ts";
import { recordSessionCost, resultCostPath, sumResultCosts, UNMETERED } from "../../src/engine10/cost.ts";

function root(extra: Record<string, unknown>): string {
  const r = mkdtempSync(join(tmpdir(), "loki-unmetered-"));
  mkdirSync(join(r, "metrics"), { recursive: true });
  writeFileSync(resultCostPath(r, "it1"), JSON.stringify({ total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, model: "m", ...extra }));
  return r;
}

test("marker file sums to usd 0, flagged unmetered", () => {
  const r = root({ source: UNMETERED });
  try {
    const c = sumResultCosts(r, ["it1"]);
    expect(c.usd).toBe(0);
    expect(c.unmetered).toBe(true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("the same zero-usage file without the marker stays null", () => {
  const r = root({});
  try {
    const c = sumResultCosts(r, ["it1"]);
    expect(c.usd).toBeNull();
    expect(c.unmetered).toBeUndefined();
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("efficiency record carries the marker as its cost_source, not provider", () => {
  const r = root({ source: UNMETERED });
  try {
    recordSessionCost(r, "it1", { status: "completed", durationMs: 1, model: "m" });
    const rec = JSON.parse(readFileSync(join(r, "metrics", "efficiency", "iteration-1.json"), "utf8"));
    expect(rec.cost_usd).toBe(0);
    expect(rec.cost_source).toBe(UNMETERED);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// TEN-COST-29: cache-cold hint on the cost summary
const cev = (stage: string, input: number, read: number, source = "x") => ({ type: "cost", stage, data: { usd: 1, source, input_tokens: input, cache_read_tokens: read, cache_creation_tokens: 0 } });
test("a stage with 5 percent cache reads gets one cache cold line", () => {
  const t = stageShareText([cev("plan", 95, 5), cev("fix", 10, 90)])!;
  expect(t.match(/cache cold:/g)!.length).toBe(1);
  expect(t).toContain("cache cold: plan");
  expect(t).not.toContain("cache cold: plan, fix");
  expect(t.split("\n").length).toBe(2);
});
test("no hint when all stages warm, exactly 30 percent, or unmetered", () => {
  expect(stageShareText([cev("plan", 10, 90), cev("fix", 70, 30)])).not.toContain("cache cold");
  expect(stageShareText([cev("plan", 100, 0, "cli-invoker-unmetered"), cev("fix", 10, 90)])).not.toContain("cache cold");
  expect(stageShareText([cev("plan", 70, 30)])).toBeNull();
});
test("single cold stage still reports the hint alone", () => {
  expect(stageShareText([cev("plan", 100, 0)])).toBe("cache cold: plan");
});

// #244: a cold stage names its likely cause (prefix changed between calls); a long inter-call gap names the 1h TTL opt-in
const pev = (stage: string, input: number, read: number, sha: string, ts?: string, durationMs = 0) => ({ ...cev(stage, input, read), ts, data: { ...cev(stage, input, read).data, prefix_sha: sha, duration_ms: durationMs } });
test("cold stage with an unstable prefix is flagged as prefix changed; a stable one is not", () => {
  expect(stageShareText([pev("plan", 100, 0, "a"), pev("plan", 100, 0, "b")])).toBe("cache cold: plan (prefix changed)");
  expect(stageShareText([pev("plan", 100, 0, "a"), pev("plan", 100, 0, "a")])).toBe("cache cold: plan");
  expect(stageShareText([pev("plan", 5, 95, "a"), pev("plan", 5, 95, "b")])).toBeNull();
});
// #306: the label names the component(s) whose hash differs between the stage's calls
const BASE = { system: "lean", tools: ["Bash", "Read"], thinking: "", effort: "high", brief: "b" };
const vary: Record<string, Partial<typeof BASE>> = { system: { system: "preset" }, tools: { tools: ["Bash"] }, thinking: { thinking: "8000" }, effort: { effort: "low" }, brief: { brief: "c" } };
const pcev = (stage: string, over: Partial<typeof BASE>) => { const parts = prefixParts({ ...BASE, ...over }); const e = cev(stage, 100, 0); return { ...e, data: { ...e.data, prefix_sha: prefixSha(parts), prefix_parts: parts } }; };
for (const c of PREFIX_COMPONENTS) {
  test(`cold stage whose only changed prefix component is ${c} is labelled with ${c}`, () => {
    expect(stageShareText([pcev("plan", {}), pcev("plan", vary[c]!)])).toBe(`cache cold: plan (prefix changed: ${c})`);
  });
}
test("two changed components are both named, in prefix order", () => {
  expect(stageShareText([pcev("plan", {}), pcev("plan", { effort: "low", tools: ["Bash"] })])).toBe("cache cold: plan (prefix changed: tools, effort)");
});
test("median gap over 5 minutes names the 1h TTL opt-in; short gaps do not", () => {
  const t0 = Date.parse("2026-10-22T00:00:00Z"), at = (m: number) => new Date(t0 + m * 60_000).toISOString();
  const slow = stageShareText([pev("fix", 5, 95, "a", at(0)), pev("fix", 5, 95, "a", at(7)), pev("fix", 5, 95, "a", at(15))])!;
  expect(slow).toBe("cache ttl: fix (median gap 8m); LOKI_E10_CACHE_TTL=1h");
  expect(stageShareText([pev("fix", 5, 95, "a", at(0)), pev("fix", 5, 95, "a", at(1))])).toBeNull();
  // B1: back-to-back sessions each running 10m (end times 10m apart) have zero idle gap: no 1h hint
  const M = 60_000;
  expect(stageShareText([pev("fix", 5, 95, "a", at(10), 10 * M), pev("fix", 5, 95, "a", at(20), 10 * M), pev("fix", 5, 95, "a", at(30), 10 * M)])).toBeNull();
  // B2: 20m idle chooses 1h; 70m idle does not
  expect(stageShareText([pev("fix", 5, 95, "a", at(1), M), pev("fix", 5, 95, "a", at(22), M), pev("fix", 5, 95, "a", at(43), M)])).toBe("cache ttl: fix (median gap 20m); LOKI_E10_CACHE_TTL=1h");
  expect(stageShareText([pev("fix", 5, 95, "a", at(1), M), pev("fix", 5, 95, "a", at(72), M), pev("fix", 5, 95, "a", at(143), M)])).toBeNull();
});

// #244: call gaps persist per stage in the efficiency records and reach the child env
const zeroCost = { usd: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, model: "m", unmetered: false } as never;
test("stageMedianGapMs reads the persisted per-stage gaps; no data is null", () => {
  const r = mkdtempSync(join(tmpdir(), "loki-gaps-"));
  try {
    expect(stageMedianGapMs(r, "fix")).toBeNull();
    for (const g of [100_000, 500_000, 700_000]) writeEfficiencyRecord(r, { status: "completed", durationMs: 1, model: "m", stage: "fix", gapMs: g }, zeroCost);
    writeEfficiencyRecord(r, { status: "completed", durationMs: 1, model: "m", stage: "plan", gapMs: 5 }, zeroCost);
    writeEfficiencyRecord(r, { status: "completed", durationMs: 1, model: "m", stage: "fix" }, zeroCost); // first call of a run: no gap
    writeFileSync(join(r, "metrics", "efficiency", "iteration-9999.json"), JSON.stringify({ stage: "fix", gap_ms: 99_999_999 })); // gap_ms without duration_ms: ignored
    expect(stageMedianGapMs(r, "fix")).toBe(500_000);
    expect(stageMedianGapMs(r, "plan")).toBe(5);
    expect(stageMedianGapMs(r, "verify")).toBeNull();
  } finally { rmSync(r, { recursive: true, force: true }); }
});
test("childEnv hands the stage's persisted median gap to the child, and nothing without data", () => {
  const r = mkdtempSync(join(tmpdir(), "loki-gaps-"));
  const o = { stage: "fix", brief: "b", tier: "development", iterationId: "i1", limitS: 1, signal: new AbortController().signal } as never;
  try {
    expect(childEnv(o, { provider: "claude", lokiRoot: r })["LOKI_E10_CACHE_GAP_MS"]).toBeUndefined();
    writeEfficiencyRecord(r, { status: "completed", durationMs: 1, model: "m", stage: "fix", gapMs: 420_000 }, zeroCost);
    expect(childEnv(o, { provider: "claude", lokiRoot: r })["LOKI_E10_CACHE_GAP_MS"]).toBe("420000");
  } finally { rmSync(r, { recursive: true, force: true }); }
});
test("idleGapMs excludes the session's own runtime and never goes negative", () => {
  expect(idleGapMs(20 * 60_000, 10 * 60_000, 10 * 60_000)).toBe(0); // back-to-back: starts when the previous ended
  expect(idleGapMs(30 * 60_000, 10 * 60_000, 10 * 60_000)).toBe(10 * 60_000);
  expect(idleGapMs(5, 100, 0)).toBe(0);
  expect([cacheTtlFor(300_000), cacheTtlFor(300_001), cacheTtlFor(3_599_999), cacheTtlFor(3_600_000)]).toEqual(["5m", "1h", "1h", "5m"]);
});
