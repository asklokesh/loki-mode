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
    // No records at all is UNMEASURED, not a measured zero.
    expect(snap.efficiency.total_cost_usd).toBeNull();
    expect(snap.efficiency.avg_cost_per_iteration).toBeNull();
    expect(snap.accuracy.council_rounds).toBe(0);
    expect(snap.accuracy.unanimous_rate).toBeNull();
    expect(snap.notes.length).toBeGreaterThan(0);
    expect(snap.notes.join(" ")).toContain("no .loki/metrics/efficiency/");
    expect(snap.notes.join(" ")).toContain("no .loki/council/");
    // The note must not claim cost was "zeroed" -- that is the same false
    // claim as rendering $0.00, just in prose.
    expect(snap.notes.join(" ")).toContain("cost UNKNOWN");
    // Scoped per-note: the council note says "accuracy KPIs zeroed", which is
    // correct (accuracy really is zeroed). A COST- or TOKEN-zeroed claim is a
    // lie -- both are UNKNOWN, not zero. Duration zeroed stays legal.
    for (const n of snap.notes) {
      if (/zeroed/i.test(n)) {
        expect(n).not.toMatch(/cost[^,)]*zeroed/i);
        expect(n).not.toMatch(/token[^,)]*zeroed/i);
      }
    }
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

// An unmeasured cost must read UNKNOWN, never 0. Free and unmeasured are
// different claims and only one is honest. Mirrors the "measured" rule in
// autonomy/lib/efficiency_cost.py record_is_measured().
describe("unmeasured cost reads UNKNOWN, never zero", () => {
  // Matches the total-cost line only when it renders a bare zero ("0", "0.0").
  // Asserting not.toContain("$0.00") would be VACUOUS: the renderer emits a
  // bare number with no "$", so that assertion passes even with the bug.
  const ZERO_COST_LINE = /Total cost USD:\s+0(\.0+)?\s*$/m;

  it("nulls cost when records exist but carry no measured values", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    // The real FireLater shape: parseable records, every token field zero
    // (codex wrote no usage before v8.51.0). A present file is not a
    // measurement.
    for (const i of [1, 2]) {
      writeFileSync(
        join(dir, `iteration-${i}.json`),
        JSON.stringify({
          iteration: i,
          model: "gpt-5.3-codex",
          status: "success",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_usd: 0,
        }),
      );
    }
    const snap = computeKpis(td);
    expect(snap.efficiency.iteration_count).toBe(2);
    expect(snap.efficiency.total_cost_usd).toBeNull();
    expect(snap.efficiency.avg_cost_per_iteration).toBeNull();
    // The operator is told why, rather than shown a silent zero.
    expect(snap.notes.join(" ")).toContain("cost UNKNOWN, not zero");
  });

  it("renders UNKNOWN and never a bare zero for an unmeasured cost", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({ iteration: 1, model: "gpt-5.3-codex", status: "success", input_tokens: 0, cost_usd: 0 }),
    );
    const out = formatKpisHuman(computeKpis(td));
    expect(out).toContain("Total cost USD:       UNKNOWN (not measured)");
    expect(out).toContain("Avg cost per iter:    UNKNOWN (not measured)");
    expect(out).not.toMatch(ZERO_COST_LINE);
    // A bare null interpolation would render the literal string "null".
    expect(out).not.toContain("null");
  });

  it("renders a measured cost as the real number", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({ iteration: 1, model: "opus", status: "success", input_tokens: 100, output_tokens: 50, cost_usd: 0.42 }),
    );
    const snap = computeKpis(td);
    expect(snap.efficiency.total_cost_usd).toBe(0.42);
    const out = formatKpisHuman(snap);
    expect(out).toContain("Total cost USD:       0.42");
    expect(out).not.toContain("UNKNOWN");
  });

  it("preserves a GENUINELY measured zero rather than blanking it", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    // cost_usd is 0 but tokens were observed: this run WAS measured and
    // genuinely priced to zero. Distinct from "not measured" -- must stay 0.
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({ iteration: 1, model: "free-local", status: "success", input_tokens: 1200, output_tokens: 300, cost_usd: 0 }),
    );
    const snap = computeKpis(td);
    expect(snap.efficiency.total_cost_usd).toBe(0);
    expect(snap.efficiency.avg_cost_per_iteration).toBe(0);
    expect(formatKpisHuman(snap)).not.toContain("UNKNOWN");
  });

  // Matches the token lines only when they render a bare zero.
  const ZERO_INPUT_LINE = /Total input tokens:\s+0\s*$/m;
  const ZERO_OUTPUT_LINE = /Total output tokens:\s+0\s*$/m;

  it("nulls the TOKEN fields too when records carry no measured values", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    // Same FireLater shape. "we did not measure" must not render as "it was
    // zero" for tokens any more than it may for cost.
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({
        iteration: 1,
        model: "gpt-5.3-codex",
        status: "success",
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0,
      }),
    );
    const snap = computeKpis(td);
    expect(snap.efficiency.total_input_tokens).toBeNull();
    expect(snap.efficiency.total_output_tokens).toBeNull();
    const out = formatKpisHuman(snap);
    expect(out).toContain("Total input tokens:   UNKNOWN (not measured)");
    expect(out).toContain("Total output tokens:  UNKNOWN (not measured)");
    expect(out).not.toMatch(ZERO_INPUT_LINE);
    expect(out).not.toMatch(ZERO_OUTPUT_LINE);
    expect(out).not.toContain("null");
  });

  it("nulls the TOKEN fields when there are no records at all", () => {
    const snap = computeKpis(td);
    expect(snap.efficiency.total_input_tokens).toBeNull();
    expect(snap.efficiency.total_output_tokens).toBeNull();
    // Duration is wall clock, not provider usage: it stays a real zero.
    expect(snap.efficiency.total_duration_ms).toBe(0);
    const reparsed = JSON.parse(formatKpisJson(snap)) as {
      efficiency: { total_input_tokens: number | null; total_output_tokens: number | null };
    };
    expect(reparsed.efficiency.total_input_tokens).toBeNull();
    expect(reparsed.efficiency.total_output_tokens).toBeNull();
  });

  // The direction that would blank REAL data. A run WAS measured (cache tokens
  // observed) and genuinely emitted zero input and zero output tokens. Those
  // zeros are facts and must render as 0. A falsy guard (`|| "UNKNOWN"`) in
  // either the producer or the renderer fails exactly here.
  it("preserves GENUINELY measured zero token counts rather than blanking them", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({
        iteration: 1,
        model: "opus",
        status: "success",
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 797496,
      }),
    );
    const snap = computeKpis(td);
    expect(snap.efficiency.total_input_tokens).toBe(0);
    expect(snap.efficiency.total_output_tokens).toBe(0);
    const out = formatKpisHuman(snap);
    expect(out).toMatch(ZERO_INPUT_LINE);
    expect(out).toMatch(ZERO_OUTPUT_LINE);
    expect(out).not.toContain("UNKNOWN");
  });

  it("leaves measured non-zero token counts unchanged", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({ iteration: 1, model: "opus", status: "success", input_tokens: 100, output_tokens: 50 }),
    );
    writeFileSync(
      join(dir, "iteration-2.json"),
      JSON.stringify({ iteration: 2, model: "opus", status: "success", input_tokens: 300, output_tokens: 400 }),
    );
    const snap = computeKpis(td);
    expect(snap.efficiency.total_input_tokens).toBe(400);
    expect(snap.efficiency.total_output_tokens).toBe(450);
    const out = formatKpisHuman(snap);
    expect(out).toContain("Total input tokens:   400");
    expect(out).toContain("Total output tokens:  450");
    expect(out).not.toContain("UNKNOWN");
  });

  it("counts a cache-only record as measured", () => {
    const dir = join(td, "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    // Cache tiers dominate real traffic; measuring only input/output would
    // call a real cached iteration unmeasured.
    writeFileSync(
      join(dir, "iteration-1.json"),
      JSON.stringify({ iteration: 1, model: "opus", status: "success", input_tokens: 0, output_tokens: 0, cache_read_tokens: 797496 }),
    );
    expect(computeKpis(td).efficiency.total_cost_usd).not.toBeNull();
  });

  it("admits null in the type and survives a JSON round-trip", () => {
    const snap = computeKpis(td);
    // Type-level: the field genuinely accepts null (compile-time assertion).
    const cost: number | null = snap.efficiency.total_cost_usd;
    expect(cost).toBeNull();
    const reparsed = JSON.parse(formatKpisJson(snap)) as {
      efficiency: { total_cost_usd: number | null };
    };
    expect(reparsed.efficiency.total_cost_usd).toBeNull();
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
