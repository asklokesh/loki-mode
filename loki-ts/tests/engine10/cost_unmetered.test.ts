// D48: a CLI-invoker (stub) session has no provider dollars. It records 0 with an explicit marker, never null;
// the same zero-usage file WITHOUT the marker stays unmeasured (E-69).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageShareText } from "../../src/util/cost_breakdown.ts";
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
const pev = (stage: string, input: number, read: number, sha: string, ts?: string) => ({ ...cev(stage, input, read), ts, data: { ...cev(stage, input, read).data, prefix_sha: sha } });
test("cold stage with an unstable prefix is flagged as prefix changed; a stable one is not", () => {
  expect(stageShareText([pev("plan", 100, 0, "a"), pev("plan", 100, 0, "b")])).toBe("cache cold: plan (prefix changed)");
  expect(stageShareText([pev("plan", 100, 0, "a"), pev("plan", 100, 0, "a")])).toBe("cache cold: plan");
  expect(stageShareText([pev("plan", 5, 95, "a"), pev("plan", 5, 95, "b")])).toBeNull();
});
test("median gap over 5 minutes names the 1h TTL opt-in; short gaps do not", () => {
  const t0 = Date.parse("2026-10-22T00:00:00Z"), at = (m: number) => new Date(t0 + m * 60_000).toISOString();
  const slow = stageShareText([pev("fix", 5, 95, "a", at(0)), pev("fix", 5, 95, "a", at(7)), pev("fix", 5, 95, "a", at(15))])!;
  expect(slow).toBe("cache ttl: fix (median gap 8m); LOKI_E10_CACHE_TTL=1h");
  expect(stageShareText([pev("fix", 5, 95, "a", at(0)), pev("fix", 5, 95, "a", at(1))])).toBeNull();
});
