// loki-ts/tests/metrics/kpis.test.ts -- Phase K MVP (v7.5.28) regression tests.
//
// Covers:
//  - computeKpis on empty .loki/ dir -> zeroed efficiency + accuracy + notes
//  - computeKpis with realistic efficiency records -> correct aggregation
//  - computeKpis with council rounds -> correct unanimous + approval rates
//  - formatKpisJson is deterministic, parseable, includes schema_version
//  - formatKpisHuman includes all KPI labels in stable order
//  - malformed efficiency JSON is skipped, not fatal
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeKpis, formatKpisJson, formatKpisHuman } from "../../src/metrics/kpis.ts";

let td: string;

beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), "loki-kpis-"));
});
afterEach(() => {
  rmSync(td, { recursive: true, force: true });
});

describe("computeKpis", () => {
  it("returns zeroed KPIs with notes when .loki/ is empty", () => {
    const snap = computeKpis(td);
    expect(snap.schema_version).toBe(1);
    expect(snap.efficiency.iteration_count).toBe(0);
    expect(snap.efficiency.total_cost_usd).toBe(0);
    expect(snap.efficiency.avg_cost_per_iteration).toBeNull();
    expect(snap.accuracy.council_rounds).toBe(0);
    expect(snap.accuracy.unanimous_rate).toBeNull();
    expect(snap.notes.length).toBeGreaterThan(0);
    expect(snap.notes.join(" ")).toContain("no .loki/metrics/efficiency/");
    expect(snap.notes.join(" ")).toContain("no .loki/council/");
  });

  it("aggregates efficiency records correctly", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({
        iteration: 1,
        model: "opus",
        phase: "BOOTSTRAP",
        duration_ms: 1000,
        input_tokens: 100,
        output_tokens: 200,
        cost_usd: 0.5,
        status: "success",
      }),
    );
    writeFileSync(
      join(dir, "iteration-2.json"),
      JSON.stringify({
        iteration: 2,
        model: "sonnet",
        phase: "DEVELOPMENT",
        duration_ms: 2000,
        input_tokens: 300,
        output_tokens: 400,
        cost_usd: 1.25,
        status: "failed",
      }),
    );
    const snap = computeKpis(td);
    expect(snap.efficiency.iteration_count).toBe(2);
    expect(snap.efficiency.total_cost_usd).toBe(1.75);
    expect(snap.efficiency.avg_cost_per_iteration).toBe(0.875);
    expect(snap.efficiency.total_input_tokens).toBe(400);
    expect(snap.efficiency.total_output_tokens).toBe(600);
    expect(snap.efficiency.total_duration_ms).toBe(3000);
    expect(snap.efficiency.avg_duration_ms_per_iteration).toBe(1500);
    expect(snap.efficiency.model_breakdown).toEqual({ opus: 1, sonnet: 1 });
    expect(snap.efficiency.phase_breakdown).toEqual({ BOOTSTRAP: 1, DEVELOPMENT: 1 });
    expect(snap.efficiency.status_breakdown).toEqual({ success: 1, failed: 1 });
  });

  it("computes accuracy KPIs from council rounds", () => {
    const dir = join(td, "council", "votes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "round-1.json"),
      JSON.stringify({
        iteration: 1,
        verdict: "COMPLETE",
        complete_votes: 3,
        total_members: 3,
        threshold: 2,
      }),
    );
    writeFileSync(
      join(dir, "round-2.json"),
      JSON.stringify({
        iteration: 2,
        verdict: "CONTINUE",
        complete_votes: 1,
        total_members: 3,
        threshold: 2,
      }),
    );
    writeFileSync(
      join(dir, "round-3.json"),
      JSON.stringify({
        iteration: 3,
        verdict: "COMPLETE",
        complete_votes: 2,
        total_members: 3,
        threshold: 2,
      }),
    );
    const snap = computeKpis(td);
    expect(snap.accuracy.council_rounds).toBe(3);
    // 1 of 3 rounds was unanimous (round-1, 3==3); round-3 had 2 of 3
    expect(snap.accuracy.unanimous_rate).toBeCloseTo(1 / 3, 4);
    // 2 of 3 rounds were COMPLETE
    expect(snap.accuracy.approval_rate).toBeCloseTo(2 / 3, 4);
  });

  it("computes iteration_success_rate from status breakdown", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({ iteration: 1, status: "success", cost_usd: 0.1, model: "opus" }),
    );
    writeFileSync(
      join(dir, "iteration-2.json"),
      JSON.stringify({ iteration: 2, status: "success", cost_usd: 0.1, model: "opus" }),
    );
    writeFileSync(
      join(dir, "iteration-3.json"),
      JSON.stringify({ iteration: 3, status: "failed", cost_usd: 0.1, model: "opus" }),
    );
    const snap = computeKpis(td);
    // 2 success of 3 total
    expect(snap.accuracy.iteration_success_rate).toBeCloseTo(2 / 3, 4);
  });

  it("tolerates malformed efficiency JSON without throwing", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "iteration-1.json"), "{not valid json");
    writeFileSync(
      join(dir, "iteration-2.json"),
      JSON.stringify({ iteration: 2, cost_usd: 0.5, model: "opus", status: "success" }),
    );
    const snap = computeKpis(td);
    // Only the valid file is counted.
    expect(snap.efficiency.iteration_count).toBe(1);
    expect(snap.efficiency.total_cost_usd).toBe(0.5);
  });
});

describe("formatKpisJson", () => {
  it("produces deterministic JSON parseable to KpiSnapshot shape", () => {
    const snap = computeKpis(td);
    const json = formatKpisJson(snap);
    const reparsed = JSON.parse(json) as { schema_version: number; efficiency: unknown; accuracy: unknown };
    expect(reparsed.schema_version).toBe(1);
    expect(reparsed.efficiency).toBeDefined();
    expect(reparsed.accuracy).toBeDefined();
  });
});

describe("formatKpisHuman", () => {
  it("includes all KPI labels in stable order", () => {
    const snap = computeKpis(td);
    const out = formatKpisHuman(snap);
    expect(out).toContain("Loki Mode KPIs");
    expect(out).toContain("Efficiency");
    expect(out).toContain("Iterations:");
    expect(out).toContain("Total cost USD:");
    expect(out).toContain("Accuracy");
    expect(out).toContain("Council rounds:");
    expect(out).toContain("Unanimous rate:");
    // Order: Efficiency block before Accuracy block.
    const effIdx = out.indexOf("Efficiency");
    const accIdx = out.indexOf("Accuracy");
    expect(effIdx).toBeGreaterThan(-1);
    expect(accIdx).toBeGreaterThan(effIdx);
  });
});
