// loki-ts/src/metrics/kpis.ts -- Phase K MVP (v7.5.28) read-only KPI derivation.
//
// Derives accuracy + efficiency KPIs from existing .loki/ state without any
// new instrumentation. The architect plan envisioned per-iteration emission +
// dashboard panel + benchmark harness; this MVP ships only the read-only
// derivation layer so users can run `loki kpis` and see a snapshot today.
//
// Inputs (all optional; missing files yield empty/null KPI fields):
//   .loki/metrics/efficiency/iteration-N.json  -- per-iter token + cost + status
//   .loki/council/votes/round-N.json           -- per-iter council verdicts
//   .loki/metrics/budget.json                  -- aggregate budget state
//
// Public API:
//   computeKpis(lokiDir) -> KpiSnapshot
//   formatKpisHuman(snap) -> string         (pretty-print for terminal)
//   formatKpisJson(snap)  -> string         (deterministic JSON)
//
// Design: pure functions, no I/O outside the lokiDir arg. No new env vars.
// No external deps. Reuses EfficiencyRecord + readEfficiencyDir from
// budget.ts so the cost arithmetic stays single-source-of-truth.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type EfficiencyRecord, readEfficiencyDir, calculateCostFromRecords } from "../runner/budget.ts";

export type CouncilRound = {
  iteration?: number;
  verdict?: string; // COMPLETE | CONTINUE | <other>
  complete_votes?: number;
  total_members?: number;
  threshold?: number;
};

export type KpiSnapshot = {
  // Provenance.
  schema_version: 1;
  generated_at: string; // ISO 8601 UTC
  loki_dir: string;

  // Efficiency KPIs (from .loki/metrics/efficiency/iteration-*.json).
  efficiency: {
    iteration_count: number;
    total_cost_usd: number;
    avg_cost_per_iteration: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
    total_duration_ms: number;
    avg_duration_ms_per_iteration: number | null;
    model_breakdown: Record<string, number>; // model alias -> count
    phase_breakdown: Record<string, number>; // phase name -> count
    status_breakdown: Record<string, number>; // success | failed | etc.
  };

  // Accuracy KPIs (from .loki/council/votes/round-*.json).
  accuracy: {
    council_rounds: number;
    unanimous_rate: number | null; // (rounds with complete_votes == total_members) / count
    approval_rate: number | null;  // (rounds with verdict=COMPLETE) / count
    iteration_success_rate: number | null; // status='success' / iteration_count
  };

  // Notes -- anything the MVP cannot compute, listed explicitly so the
  // operator knows what's missing rather than seeing a silent zero.
  notes: string[];
};

// Read all council round files. Tolerates missing dir.
function readCouncilRounds(councilDir: string): CouncilRound[] {
  const out: CouncilRound[] = [];
  const votesDir = join(councilDir, "votes");
  if (!existsSync(votesDir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(votesDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith("round-") || !name.endsWith(".json")) continue;
    try {
      const p = join(votesDir, name);
      if (!statSync(p).isFile()) continue;
      const obj = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      out.push({
        iteration:
          typeof obj["iteration"] === "number" ? (obj["iteration"] as number) : undefined,
        verdict: typeof obj["verdict"] === "string" ? (obj["verdict"] as string) : undefined,
        complete_votes:
          typeof obj["complete_votes"] === "number"
            ? (obj["complete_votes"] as number)
            : undefined,
        total_members:
          typeof obj["total_members"] === "number"
            ? (obj["total_members"] as number)
            : undefined,
        threshold:
          typeof obj["threshold"] === "number" ? (obj["threshold"] as number) : undefined,
      });
    } catch {
      // Malformed round file -- skip, do not fail the snapshot.
    }
  }
  return out;
}

function makeEmptyEfficiency(): KpiSnapshot["efficiency"] {
  return {
    iteration_count: 0,
    total_cost_usd: 0,
    avg_cost_per_iteration: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_duration_ms: 0,
    avg_duration_ms_per_iteration: null,
    model_breakdown: {},
    phase_breakdown: {},
    status_breakdown: {},
  };
}

function makeEmptyAccuracy(): KpiSnapshot["accuracy"] {
  return {
    council_rounds: 0,
    unanimous_rate: null,
    approval_rate: null,
    iteration_success_rate: null,
  };
}

function deriveEfficiency(records: readonly EfficiencyRecord[]): KpiSnapshot["efficiency"] {
  const out = makeEmptyEfficiency();
  if (records.length === 0) return out;
  out.iteration_count = records.length;
  out.total_cost_usd = Math.round(calculateCostFromRecords(records) * 10000) / 10000;
  for (const r of records) {
    if (typeof r.input_tokens === "number") out.total_input_tokens += r.input_tokens;
    if (typeof r.output_tokens === "number") out.total_output_tokens += r.output_tokens;
    const ext = r as EfficiencyRecord & {
      duration_ms?: number;
      phase?: string;
      status?: string;
    };
    if (typeof ext.duration_ms === "number") out.total_duration_ms += ext.duration_ms;
    if (typeof r.model === "string") {
      out.model_breakdown[r.model] = (out.model_breakdown[r.model] ?? 0) + 1;
    }
    if (typeof ext.phase === "string") {
      out.phase_breakdown[ext.phase] = (out.phase_breakdown[ext.phase] ?? 0) + 1;
    }
    if (typeof ext.status === "string") {
      out.status_breakdown[ext.status] = (out.status_breakdown[ext.status] ?? 0) + 1;
    }
  }
  out.avg_cost_per_iteration =
    Math.round((out.total_cost_usd / out.iteration_count) * 10000) / 10000;
  out.avg_duration_ms_per_iteration = Math.round(out.total_duration_ms / out.iteration_count);
  return out;
}

function deriveAccuracy(
  rounds: readonly CouncilRound[],
  successCount: number,
  totalIterations: number,
): KpiSnapshot["accuracy"] {
  const out = makeEmptyAccuracy();
  out.council_rounds = rounds.length;
  if (rounds.length > 0) {
    let unanimous = 0;
    let approve = 0;
    for (const r of rounds) {
      if (
        typeof r.complete_votes === "number" &&
        typeof r.total_members === "number" &&
        r.total_members > 0 &&
        r.complete_votes === r.total_members
      ) {
        unanimous += 1;
      }
      if (r.verdict === "COMPLETE") approve += 1;
    }
    out.unanimous_rate = Math.round((unanimous / rounds.length) * 10000) / 10000;
    out.approval_rate = Math.round((approve / rounds.length) * 10000) / 10000;
  }
  if (totalIterations > 0) {
    out.iteration_success_rate =
      Math.round((successCount / totalIterations) * 10000) / 10000;
  }
  return out;
}

// Main entry point. Returns a KPI snapshot for the given .loki dir.
// All file reads are best-effort; missing files yield empty/null KPIs.
export function computeKpis(lokiDir: string): KpiSnapshot {
  const notes: string[] = [];
  const efficiencyDir = join(lokiDir, "metrics", "efficiency");
  const councilDir = join(lokiDir, "council");

  const records = existsSync(efficiencyDir) ? readEfficiencyDir(efficiencyDir) : [];
  if (!existsSync(efficiencyDir)) {
    notes.push(`no .loki/metrics/efficiency/ dir (efficiency KPIs zeroed)`);
  } else if (records.length === 0) {
    notes.push(`.loki/metrics/efficiency/ exists but no iteration files found`);
  }

  const rounds = readCouncilRounds(councilDir);
  if (!existsSync(councilDir)) {
    notes.push(`no .loki/council/ dir (accuracy KPIs zeroed)`);
  } else if (rounds.length === 0) {
    notes.push(`.loki/council/ exists but no round-N.json files found`);
  }

  const efficiency = deriveEfficiency(records);
  const successCount = efficiency.status_breakdown["success"] ?? 0;
  const accuracy = deriveAccuracy(rounds, successCount, efficiency.iteration_count);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    loki_dir: lokiDir,
    efficiency,
    accuracy,
    notes,
  };
}

export function formatKpisJson(snap: KpiSnapshot): string {
  return JSON.stringify(snap, null, 2);
}

// Pretty-print for terminal output. Stable line ordering for golden tests.
export function formatKpisHuman(snap: KpiSnapshot): string {
  const lines: string[] = [];
  lines.push(`Loki Mode KPIs  (snapshot at ${snap.generated_at})`);
  lines.push(`Source: ${snap.loki_dir}`);
  lines.push(``);
  lines.push(`Efficiency`);
  lines.push(`  Iterations:           ${snap.efficiency.iteration_count}`);
  lines.push(`  Total cost USD:       ${snap.efficiency.total_cost_usd}`);
  lines.push(
    `  Avg cost per iter:    ${snap.efficiency.avg_cost_per_iteration ?? "n/a"}`,
  );
  lines.push(`  Total input tokens:   ${snap.efficiency.total_input_tokens}`);
  lines.push(`  Total output tokens:  ${snap.efficiency.total_output_tokens}`);
  lines.push(`  Total duration (ms):  ${snap.efficiency.total_duration_ms}`);
  lines.push(
    `  Avg duration / iter:  ${snap.efficiency.avg_duration_ms_per_iteration ?? "n/a"}`,
  );
  const mb = Object.entries(snap.efficiency.model_breakdown).sort((a, b) => a[0].localeCompare(b[0]));
  if (mb.length > 0) {
    lines.push(`  Model breakdown:      ${mb.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const pb = Object.entries(snap.efficiency.phase_breakdown).sort((a, b) => a[0].localeCompare(b[0]));
  if (pb.length > 0) {
    lines.push(`  Phase breakdown:      ${pb.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const sb = Object.entries(snap.efficiency.status_breakdown).sort((a, b) => a[0].localeCompare(b[0]));
  if (sb.length > 0) {
    lines.push(`  Status breakdown:     ${sb.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  lines.push(``);
  lines.push(`Accuracy`);
  lines.push(`  Council rounds:       ${snap.accuracy.council_rounds}`);
  lines.push(`  Unanimous rate:       ${snap.accuracy.unanimous_rate ?? "n/a"}`);
  lines.push(`  Approval rate:        ${snap.accuracy.approval_rate ?? "n/a"}`);
  lines.push(
    `  Iter success rate:    ${snap.accuracy.iteration_success_rate ?? "n/a"}`,
  );
  if (snap.notes.length > 0) {
    lines.push(``);
    lines.push(`Notes`);
    for (const n of snap.notes) lines.push(`  - ${n}`);
  }
  // R4 pointer: kpis is a single-run snapshot; `loki trust` shows the
  // across-runs trajectory (is the agent earning autonomy on this repo?).
  lines.push(``);
  lines.push(`See also: loki trust  (trust trajectory across runs)`);
  return lines.join("\n");
}
