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
    // null == NOT MEASURED. Free and unmeasured are different claims and only
    // one is honest: a run that did work necessarily consumed tokens, so
    // all-zeros means we failed to measure. Rendering that as 0 certifies the
    // run cost nothing, which is a fabricated fact. Same rule, same reason as
    // autonomy/lib/efficiency_cost.py record_is_measured() -- see recordsMeasured().
    total_cost_usd: number | null;
    avg_cost_per_iteration: number | null;
    // Same rule, same reason: Python's collect_efficiency() nulls the token
    // fields alongside usd on the same unmeasured condition. A reader must be
    // able to tell "emitted no output tokens" from "nothing was recorded".
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    // NOT part of the measured predicate, and Python does not null it either.
    // Duration comes from the wall clock, not from provider-reported usage.
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

// TS mirror of autonomy/lib/efficiency_cost.py record_is_measured(), applied to
// the SUM across records exactly as collect_efficiency() does (that function
// sums the five fields, then runs the predicate over the totals).
//
// Deliberately reads the raw records rather than this module's derived
// total_cost_usd: that total comes from calculateCostFromRecords(), which
// PRICES tokens, so it is nonzero even when no cost_usd was ever observed. It
// would answer "did we compute a number", not "did we measure one".
//
// A parseable file is not a measurement. Measured means at least one record
// carried a non-zero observed value in one of these five fields.
const MEASURED_FIELDS = [
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
] as const;

function recordsMeasured(records: readonly EfficiencyRecord[]): boolean {
  if (records.length === 0) return false; // mirrors Python's `collected` gate
  for (const key of MEASURED_FIELDS) {
    let sum = 0;
    for (const r of records) {
      const v = r[key];
      // typeof v === "number" already excludes booleans; Python needs an
      // explicit isinstance(v, bool) skip only because bool subclasses int.
      if (typeof v === "number" && Number.isFinite(v)) sum += v;
    }
    if (sum !== 0) return true;
  }
  return false;
}

function makeEmptyEfficiency(): KpiSnapshot["efficiency"] {
  return {
    iteration_count: 0,
    total_cost_usd: null,
    avg_cost_per_iteration: null,
    total_input_tokens: null,
    total_output_tokens: null,
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
  // ONE predicate for the whole snapshot -- cost and tokens are measured or
  // unmeasured together, exactly as Python nulls usd and the token counts on
  // the same condition. A second predicate is how the honesty rule drifts.
  const measured = recordsMeasured(records);
  // Unmeasured stays null. A genuine measured 0.0 (records carried non-zero
  // tokens but priced to nothing) is preserved as 0, not blanked.
  out.total_cost_usd = measured
    ? Math.round(calculateCostFromRecords(records) * 10000) / 10000
    : null;
  // Summed into locals, not into out.*: those fields admit null now, and
  // `null += n` is not a thing.
  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of records) {
    if (typeof r.input_tokens === "number") inputTokens += r.input_tokens;
    if (typeof r.output_tokens === "number") outputTokens += r.output_tokens;
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
  // A measured total of 0 is real data and stays 0. Only `measured === false`
  // blanks it -- a falsy check on the sum would report a genuinely zero token
  // count as unmeasured, which is the same dishonesty pointed the other way.
  out.total_input_tokens = measured ? inputTokens : null;
  out.total_output_tokens = measured ? outputTokens : null;
  // Explicit null check, never falsy: a measured total of 0 must still yield a
  // measured average of 0. `if (!total)` would turn that into "not measured".
  out.avg_cost_per_iteration =
    out.total_cost_usd === null
      ? null
      : Math.round((out.total_cost_usd / out.iteration_count) * 10000) / 10000;
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
    // "zeroed" would be the same false claim in prose: cost is UNKNOWN here,
    // not zero. Tokens are UNKNOWN for the same reason. Duration alone is
    // genuinely zeroed -- it is wall clock, not provider-reported usage.
    notes.push(
      `no .loki/metrics/efficiency/ dir (cost UNKNOWN, tokens UNKNOWN, duration zeroed)`,
    );
  } else if (records.length === 0) {
    notes.push(
      `.loki/metrics/efficiency/ exists but no iteration files found (cost UNKNOWN, not zero)`,
    );
  }

  const rounds = readCouncilRounds(councilDir);
  if (!existsSync(councilDir)) {
    notes.push(`no .loki/council/ dir (accuracy KPIs zeroed)`);
  } else if (rounds.length === 0) {
    notes.push(`.loki/council/ exists but no round-N.json files found`);
  }

  const efficiency = deriveEfficiency(records);
  // Records present but every measured field zero (the shape a pre-v8.51.0
  // codex run wrote). Cost reads UNKNOWN rather than $0.00; say why.
  if (records.length > 0 && efficiency.total_cost_usd === null) {
    notes.push(
      `${records.length} efficiency record(s) present but no token/cost values recorded (cost UNKNOWN, not zero; tokens UNKNOWN)`,
    );
  }
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
  // Explicit branch: a bare interpolation of null renders the string "null",
  // and rendering it as 0 would certify an unmeasured run as free.
  lines.push(
    `  Total cost USD:       ${snap.efficiency.total_cost_usd ?? "UNKNOWN (not measured)"}`,
  );
  lines.push(
    `  Avg cost per iter:    ${snap.efficiency.avg_cost_per_iteration ?? "UNKNOWN (not measured)"}`,
  );
  // `??` and never `||`: a measured 0 is falsy, and `||` would blank real data.
  lines.push(
    `  Total input tokens:   ${snap.efficiency.total_input_tokens ?? "UNKNOWN (not measured)"}`,
  );
  lines.push(
    `  Total output tokens:  ${snap.efficiency.total_output_tokens ?? "UNKNOWN (not measured)"}`,
  );
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
