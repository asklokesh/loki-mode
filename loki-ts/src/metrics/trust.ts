// loki-ts/src/metrics/trust.ts -- R4 visible trust trajectory derivation.
//
// The story no competitor tells: show whether the agent is EARNING autonomy on
// THIS repo over time. Derives a per-project trust trajectory from the
// persistent per-run records R1/R3 already write to
// .loki/proofs/<run_id>/proof.json. No new run-time instrumentation; pure
// read-and-aggregate.
//
// This is the Bun-native parity of autonomy/lib/trust_trajectory.py. Both read
// the same proof.json files and apply the same median half-split direction
// logic, so `loki trust` is consistent whether routed to Bun or bash. The
// Python module is the source of truth for the dashboard endpoint + bash
// fallback; this TS module is the source of truth for the Bun CLI route (the
// same dual-implementation pattern `kpis` uses).
//
// Honest-data rule: with fewer than 2 runs the trajectory is "insufficient"
// and no direction is invented. Numbers only ever come from real proof.json
// values; a missing axis is reported available:false, never a misleading 0.
//
// Public API:
//   computeTrajectory(lokiDir) -> TrustTrajectory
//   formatTrajectoryHuman(traj) -> string
//   formatTrajectoryJson(traj) -> string
//   writeTrajectoryCache(lokiDir, traj) -> string | null

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_VERSION = 1 as const;

export type AxisKey =
  | "council_pass_rate"
  | "gate_pass_rate"
  | "iterations"
  | "interventions";

const AXIS_ORDER: AxisKey[] = [
  "council_pass_rate",
  "gate_pass_rate",
  "iterations",
  "interventions",
];

const AXIS_HIGHER_IS_BETTER: Record<AxisKey, boolean> = {
  council_pass_rate: true,
  gate_pass_rate: true,
  iterations: false,
  interventions: false,
};

const AXIS_EPSILON: Record<AxisKey, number> = {
  council_pass_rate: 0.01,
  gate_pass_rate: 0.01,
  iterations: 0.25,
  interventions: 0.25,
};

const AXIS_LABELS: Record<AxisKey, string> = {
  council_pass_rate: "Council pass rate",
  gate_pass_rate: "Gate pass rate",
  iterations: "Iterations to completion",
  interventions: "Human interventions",
};

const PASS_TOKENS = ["APPROVE", "APPROVED", "COMPLETE", "PASS", "PASSED"];

export type AxisDirection = {
  axis: AxisKey;
  label: string;
  available: boolean;
  higher_is_better: boolean;
  note?: string;
  data_points?: number;
  latest?: number;
  direction?: "up" | "down" | "flat";
  improving?: boolean | null;
  delta?: number;
  earlier_mean?: number;
  later_mean?: number;
  insufficient?: boolean;
};

export type TrustRun = {
  run_id: string;
  generated_at: string | null;
  council_pass_rate: number | null;
  gate_pass_rate: number | null;
  iterations: number | null;
  interventions: number | null;
};

export type TrustTrajectory = {
  schema_version: 1;
  generated_at: string;
  loki_dir: string;
  runs_count: number;
  insufficient: boolean;
  axes: Record<AxisKey, AxisDirection>;
  improving_count: number;
  regressing_count: number;
  improving_axes: AxisKey[];
  regressing_axes: AxisKey[];
  series: TrustRun[];
  notes: string[];
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function verdictIsPass(verdict: unknown): boolean | null {
  const v = String(verdict ?? "").trim().toUpperCase();
  if (!v) return null;
  for (const tok of PASS_TOKENS) {
    if (v.startsWith(tok)) return true;
  }
  return false;
}

function councilPassValue(council: Record<string, unknown>): number | null {
  const fv = verdictIsPass(council["final_verdict"]);
  if (fv !== null) return fv ? 1.0 : 0.0;
  const reviewers = council["reviewers"];
  if (Array.isArray(reviewers) && reviewers.length > 0) {
    let approve = 0;
    let counted = 0;
    for (const r of reviewers) {
      if (!r || typeof r !== "object") continue;
      counted += 1;
      const vote = String((r as Record<string, unknown>)["vote"] ?? "")
        .trim()
        .toUpperCase();
      if (PASS_TOKENS.some((tok) => vote.startsWith(tok))) approve += 1;
    }
    if (counted > 0) return approve === counted ? 1.0 : 0.0;
  }
  return null;
}

function gateRateValue(qg: Record<string, unknown>): number | null {
  const total = Number(qg["total"]);
  const passed = Number(qg["passed"]);
  if (!Number.isFinite(total) || !Number.isFinite(passed)) return null;
  if (total <= 0) return null;
  return Math.max(0, Math.min(1, passed / total));
}

function iterationsValue(iterations: unknown): number | null {
  let c: unknown;
  if (iterations && typeof iterations === "object") {
    c = (iterations as Record<string, unknown>)["count"];
  } else {
    c = iterations;
  }
  const n = Number(c);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function interventionsValue(proof: Record<string, unknown>): number | null {
  const council = obj(proof["council"]);
  for (const src of [council["interventions"], proof["interventions"]]) {
    const n = Number(src);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function loadRuns(lokiDir: string): TrustRun[] {
  const proofsDir = join(lokiDir, "proofs");
  const runs: TrustRun[] = [];
  if (!existsSync(proofsDir)) return runs;
  let entries: string[];
  try {
    entries = readdirSync(proofsDir).sort();
  } catch {
    return runs;
  }
  for (const name of entries) {
    const d = join(proofsDir, name);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    let proof: Record<string, unknown> | null = null;
    try {
      proof = JSON.parse(readFileSync(join(d, "proof.json"), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // Malformed / missing proof: skip, do not fail the trajectory.
      continue;
    }
    if (!proof || typeof proof !== "object") continue;
    runs.push({
      run_id: String(proof["run_id"] ?? name),
      generated_at:
        typeof proof["generated_at"] === "string"
          ? (proof["generated_at"] as string)
          : null,
      council_pass_rate: councilPassValue(obj(proof["council"])),
      gate_pass_rate: gateRateValue(obj(proof["quality_gates"])),
      iterations: iterationsValue(proof["iterations"]),
      interventions: interventionsValue(proof),
    });
  }
  // Ascending by generated_at; runs without a timestamp sort last but keep
  // stable directory order among themselves.
  runs.sort((a, b) => {
    const an = a.generated_at === null ? 1 : 0;
    const bn = b.generated_at === null ? 1 : 0;
    if (an !== bn) return an - bn;
    return (a.generated_at ?? "").localeCompare(b.generated_at ?? "");
  });
  return runs;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function directionForAxis(axis: AxisKey, orderedValues: (number | null)[]): AxisDirection {
  const higher = AXIS_HIGHER_IS_BETTER[axis];
  const eps = AXIS_EPSILON[axis];
  const label = AXIS_LABELS[axis];
  const pts = orderedValues.filter((v): v is number => v !== null);
  const n = pts.length;
  if (n === 0) {
    return {
      axis,
      label,
      available: false,
      higher_is_better: higher,
      note: "no runs recorded this metric",
    };
  }
  if (n < 2) {
    return {
      axis,
      label,
      available: true,
      higher_is_better: higher,
      data_points: n,
      latest: round4(pts[n - 1]!),
      direction: "flat",
      improving: null,
      delta: 0.0,
      earlier_mean: round4(pts[0]!),
      later_mean: round4(pts[n - 1]!),
      insufficient: true,
      note: "not enough history yet (need 2+ runs with this metric)",
    };
  }
  const half = Math.floor(n / 2);
  const earlier = pts.slice(0, half);
  const later = pts.slice(n - half);
  const earlierMean = mean(earlier);
  const laterMean = mean(later);
  const delta = laterMean - earlierMean;
  let direction: "up" | "down" | "flat";
  if (Math.abs(delta) <= eps) direction = "flat";
  else if (delta > 0) direction = "up";
  else direction = "down";
  let improving: boolean | null;
  if (direction === "flat") {
    improving = null;
  } else {
    const goingUp = direction === "up";
    improving = goingUp === higher;
  }
  return {
    axis,
    label,
    available: true,
    higher_is_better: higher,
    data_points: n,
    latest: round4(pts[n - 1]!),
    direction,
    improving,
    delta: round4(delta),
    earlier_mean: round4(earlierMean),
    later_mean: round4(laterMean),
    insufficient: false,
  };
}

export function computeTrajectory(lokiDir: string): TrustTrajectory {
  const runs = loadRuns(lokiDir);
  const series: TrustRun[] = runs.map((r) => ({
    run_id: r.run_id,
    generated_at: r.generated_at,
    council_pass_rate: r.council_pass_rate,
    gate_pass_rate: r.gate_pass_rate,
    iterations: r.iterations,
    interventions: r.interventions,
  }));

  const axes = {} as Record<AxisKey, AxisDirection>;
  for (const axis of AXIS_ORDER) {
    axes[axis] = directionForAxis(
      axis,
      runs.map((r) => r[axis]),
    );
  }

  const insufficient = runs.length < 2;
  const improvingAxes = AXIS_ORDER.filter(
    (a) => axes[a].available && axes[a].improving === true,
  );
  const regressingAxes = AXIS_ORDER.filter(
    (a) => axes[a].available && axes[a].improving === false,
  );

  const notes: string[] = [];
  if (insufficient) {
    notes.push(
      `not enough history yet: ${runs.length} run(s) recorded, need 2+ to show a trend`,
    );
  }
  if (!axes["interventions"].available) {
    notes.push(
      "intervention trend unavailable: no per-run intervention count in proof.json yet (axis lights up automatically once recorded)",
    );
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    loki_dir: lokiDir,
    runs_count: runs.length,
    insufficient,
    axes,
    improving_count: improvingAxes.length,
    regressing_count: regressingAxes.length,
    improving_axes: improvingAxes,
    regressing_axes: regressingAxes,
    series,
    notes,
  };
}

export function formatTrajectoryJson(traj: TrustTrajectory): string {
  return JSON.stringify(traj, null, 2);
}

// Persist the derived trajectory to .loki/metrics/trust-trajectory.json so all
// surfaces (CLI, dashboard endpoint, bash fallback) share one cached source of
// truth. Best-effort: returns the path on success, null on failure. The cache
// is always recomputable from .loki/proofs/, so a write failure is non-fatal.
// Parity with autonomy/lib/trust_trajectory.py:write_trajectory_cache.
export function writeTrajectoryCache(
  lokiDir: string,
  traj: TrustTrajectory,
): string | null {
  const outDir = join(lokiDir, "metrics");
  const outPath = join(outDir, "trust-trajectory.json");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, JSON.stringify(traj, null, 2));
    return outPath;
  } catch {
    return null;
  }
}

function arrow(direction: string | undefined): string {
  // Arrow words only (no emoji): keeps parity with the bash/python output.
  if (direction === "up") return "up";
  if (direction === "down") return "down";
  return "flat";
}

function fmtAxisLine(ax: AxisDirection): string {
  const label = ax.label ?? ax.axis;
  if (!ax.available) {
    return `  ${(label + ":").padEnd(26)} no data`;
  }
  let tag: string;
  if (ax.insufficient) tag = "(need 2+ runs)";
  else if (ax.improving === true) tag = "improving";
  else if (ax.improving === false) tag = "regressing";
  else tag = "stable";
  const polarity = ax.higher_is_better ? "higher better" : "lower better";
  const latest = ax.latest ?? "n/a";
  return `  ${(label + ":").padEnd(26)} ${arrow(ax.direction).padEnd(5)} latest=${String(latest).padEnd(7)} ${tag.padEnd(11)} [${polarity}]`;
}

export function formatTrajectoryHuman(traj: TrustTrajectory): string {
  const lines: string[] = [];
  lines.push(`Loki Mode Trust Trajectory  (snapshot at ${traj.generated_at})`);
  lines.push(`Source: ${traj.loki_dir}`);
  lines.push(`Runs analyzed: ${traj.runs_count}`);
  lines.push(``);
  if (traj.insufficient) {
    lines.push(`Not enough history yet.`);
    lines.push(`Trust trajectory needs 2+ recorded runs to show a direction.`);
    lines.push(`Each \`loki start\` run writes a proof-of-run; come back after the next run.`);
    if (traj.notes.length > 0) {
      lines.push(``);
      lines.push(`Notes`);
      for (const n of traj.notes) lines.push(`  - ${n}`);
    }
    return lines.join("\n");
  }
  lines.push(`Is the agent earning autonomy on this repo?`);
  for (const axis of AXIS_ORDER) {
    if (traj.axes[axis]) lines.push(fmtAxisLine(traj.axes[axis]));
  }
  lines.push(``);
  const imp = traj.improving_count;
  const reg = traj.regressing_count;
  if (imp && !reg) lines.push(`Overall: trending more trustworthy (${imp} axis improving).`);
  else if (reg && !imp) lines.push(`Overall: trust regressing (${reg} axis regressing). Review recent runs.`);
  else if (imp || reg) lines.push(`Overall: mixed (${imp} improving / ${reg} regressing).`);
  else lines.push(`Overall: stable.`);
  if (traj.notes.length > 0) {
    lines.push(``);
    lines.push(`Notes`);
    for (const n of traj.notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}
