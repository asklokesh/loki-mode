// D48: a CLI-invoker (stub) session has no provider dollars. It records 0 with an explicit marker, never null;
// the same zero-usage file WITHOUT the marker stays unmeasured (E-69).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
