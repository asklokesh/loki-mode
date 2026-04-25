// Loki Mode `stats` command -- TypeScript port of autonomy/loki cmd_stats (line 2285).
//
// Aggregates session statistics from $LOKI_DIR/state, $LOKI_DIR/metrics, and
// $LOKI_DIR/quality. Supports text (default) and JSON modes plus an
// --efficiency flag that adds per-iteration breakdown.
//
// Implementation choice: reimplements the inline Python aggregator in
// TypeScript rather than shelling out via util/python.runInline. This keeps
// the command hermetic (no python3 dependency for stats), simplifies testing,
// and matches Bun's strengths. The JSON shape and text output match the bash
// version byte-for-byte (with one rounding deviation noted below).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { YELLOW, NC } from "../util/colors.ts";

// ---- Types ----

type IterationMetric = {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  duration_seconds?: number;
};

type GateValue = boolean | { passed?: boolean; status?: string } | unknown;

type ReviewFile = {
  verdict?: string;
  approved?: boolean;
  reviewers?: unknown;
};

type StatsJson = {
  session: { iterations: number; duration_seconds: number; phase: string };
  tokens: { input: number; output: number; total: number; cost_usd: number };
  quality: {
    gates_passed: number;
    gates_total: number;
    reviews_total: number;
    reviews_approved: number;
    reviews_revision: number;
    gate_failures: Record<string, number>;
  };
  efficiency: {
    avg_tokens_per_iteration: number;
    avg_cost_per_iteration: number;
    avg_duration_per_iteration: number;
  };
  budget: { used: number; limit: number; percent: number };
  iterations?: Array<{
    number: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_seconds: number;
  }>;
};

// ---- Helpers ----

function safeReadJson<T = unknown>(path: string): T | null {
  try {
    if (!statSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listIterationFiles(effDir: string): string[] {
  if (!isDir(effDir)) return [];
  try {
    const names = readdirSync(effDir).filter(
      (n) => n.startsWith("iteration-") && n.endsWith(".json"),
    );
    names.sort(); // mirror Python sorted(glob(...))
    return names.map((n) => join(effDir, n));
  } catch {
    return [];
  }
}

// Format integer with thousand separators -- equivalent to Python `f'{n:,}'`.
function fmtNumber(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

// Format duration as "Hh MMm" or "Mm SSs" or "Ns".
// Mirrors Python fmt_duration in cmd_stats.
function fmtDuration(secsRaw: number): string {
  const secs = Math.trunc(secsRaw);
  if (secs < 60) return `${secs}s`;
  const hours = Math.trunc(secs / 3600);
  const mins = Math.trunc((secs % 3600) / 60);
  const rem = secs % 60;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, "0")}m`;
  return `${mins}m ${String(rem).padStart(2, "0")}s`;
}

// Round half-away-from-zero like Python 3's round() for typical positive values
// would actually be banker's rounding, but bash uses round() which is banker's.
// For non-negative aggregates we use Math.round (half-up) which matches the
// observed bash behavior for the values seen in iteration files. Documented
// deviation: when the fractional part is exactly .5 with an even integer part,
// Python rounds down (banker's) whereas Math.round rounds up. Token counts and
// costs computed from sums almost never hit exact .5 cases.
function pyRound(n: number, digits = 0): number {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

// Format a float to fixed decimals (matches Python f-string `{x:.2f}`).
function fmtFixed(n: number, digits: number): string {
  return n.toFixed(digits);
}

// Pad a string to a given width on the right (left-justify), mirrors Python `{x:<10}`.
function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// ---- Aggregation ----

type Aggregated = {
  phase: string;
  iterationCount: number;
  iterations: IterationMetric[];
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
  budgetLimit: number;
  budgetUsed: number;
  gatesPassed: number;
  gatesTotal: number;
  gateFailures: Record<string, number>;
  reviewsTotal: number;
  reviewsApproved: number;
  reviewsRevision: number;
};

function aggregate(loki: string): Aggregated {
  // Session state (orchestrator)
  let phase = "N/A";
  let iterationCount = 0;
  const orch = safeReadJson<{ currentPhase?: string; currentIteration?: number }>(
    join(loki, "state", "orchestrator.json"),
  );
  if (orch && typeof orch === "object") {
    if (typeof orch.currentPhase === "string") phase = orch.currentPhase;
    if (typeof orch.currentIteration === "number") iterationCount = orch.currentIteration;
  }

  // Per-iteration metrics
  const effDir = join(loki, "metrics", "efficiency");
  const iterPaths = listIterationFiles(effDir);
  const iterations: IterationMetric[] = [];
  for (const p of iterPaths) {
    const obj = safeReadJson<IterationMetric>(p);
    if (obj && typeof obj === "object") iterations.push(obj);
  }

  if (iterations.length > 0) {
    iterationCount = Math.max(iterationCount, iterations.length);
  }

  const totalInput = iterations.reduce((s, it) => s + (it.input_tokens ?? 0), 0);
  const totalOutput = iterations.reduce((s, it) => s + (it.output_tokens ?? 0), 0);
  const totalTokens = totalInput + totalOutput;
  const totalCost = iterations.reduce((s, it) => s + (it.cost_usd ?? 0), 0);
  const totalDuration = iterations.reduce((s, it) => s + (it.duration_seconds ?? 0), 0);

  // Budget
  let budgetLimit = 0;
  let budgetUsed = 0;
  const bd = safeReadJson<{ budget_limit?: number; budget_used?: number }>(
    join(loki, "metrics", "budget.json"),
  );
  if (bd && typeof bd === "object") {
    if (typeof bd.budget_limit === "number") budgetLimit = bd.budget_limit;
    if (typeof bd.budget_used === "number") budgetUsed = bd.budget_used;
  }

  // Quality gates
  let gatesPassed = 0;
  let gatesTotal = 0;
  const gates = safeReadJson<unknown>(join(loki, "state", "quality-gates.json"));
  if (gates && typeof gates === "object") {
    if (Array.isArray(gates)) {
      for (const g of gates as GateValue[]) {
        gatesTotal += 1;
        if (g === true) {
          gatesPassed += 1;
        } else if (g && typeof g === "object") {
          const obj = g as { passed?: unknown; status?: unknown };
          if (obj.passed === true || obj.status === "passed") gatesPassed += 1;
        }
      }
    } else {
      for (const v of Object.values(gates as Record<string, GateValue>)) {
        if (typeof v === "boolean") {
          gatesTotal += 1;
          if (v) gatesPassed += 1;
        } else if (v && typeof v === "object") {
          gatesTotal += 1;
          const obj = v as { passed?: unknown; status?: unknown };
          if (obj.passed === true || obj.status === "passed") gatesPassed += 1;
        }
      }
    }
  }

  // Gate failures
  let gateFailures: Record<string, number> = {};
  const gf = safeReadJson<unknown>(join(loki, "quality", "gate-failure-count.json"));
  if (gf && typeof gf === "object" && !Array.isArray(gf)) {
    // Coerce values to numbers, drop non-numeric entries to stay defensive.
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(gf as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
    gateFailures = out;
  }

  // Code reviews
  let reviewsTotal = 0;
  let reviewsApproved = 0;
  let reviewsRevision = 0;
  const qDir = join(loki, "quality");
  if (isDir(qDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(qDir);
    } catch {
      names = [];
    }
    for (const fname of names) {
      if (!fname.endsWith(".json") || fname === "gate-failure-count.json") continue;
      const rev = safeReadJson<ReviewFile>(join(qDir, fname));
      if (!rev || typeof rev !== "object") continue;
      const hasMarker = "verdict" in rev || "approved" in rev || "reviewers" in rev;
      if (!hasMarker) continue;
      reviewsTotal += 1;
      const verdict = (rev.verdict ?? "").toString().toLowerCase();
      if (rev.approved === true || ["approved", "approve", "pass"].includes(verdict)) {
        reviewsApproved += 1;
      } else if (["revision", "revise", "changes_requested", "reject"].includes(verdict)) {
        reviewsRevision += 1;
      }
    }
  }

  return {
    phase,
    iterationCount,
    iterations,
    totalInput,
    totalOutput,
    totalTokens,
    totalCost,
    totalDuration,
    budgetLimit,
    budgetUsed,
    gatesPassed,
    gatesTotal,
    gateFailures,
    reviewsTotal,
    reviewsApproved,
    reviewsRevision,
  };
}

// ---- Output renderers ----

function renderJson(a: Aggregated, showEfficiency: boolean): string {
  const ic = a.iterationCount;
  const json: StatsJson = {
    session: { iterations: ic, duration_seconds: a.totalDuration, phase: a.phase },
    tokens: {
      input: a.totalInput,
      output: a.totalOutput,
      total: a.totalTokens,
      cost_usd: pyRound(a.totalCost, 2),
    },
    quality: {
      gates_passed: a.gatesPassed,
      gates_total: a.gatesTotal,
      reviews_total: a.reviewsTotal,
      reviews_approved: a.reviewsApproved,
      reviews_revision: a.reviewsRevision,
      gate_failures: a.gateFailures,
    },
    efficiency: {
      avg_tokens_per_iteration: ic > 0 ? pyRound(a.totalTokens / ic, 0) : 0,
      avg_cost_per_iteration: ic > 0 ? pyRound(a.totalCost / ic, 2) : 0,
      avg_duration_per_iteration: ic > 0 ? pyRound(a.totalDuration / ic, 1) : 0,
    },
    budget: {
      used: pyRound(a.budgetUsed, 2),
      limit: a.budgetLimit,
      percent: a.budgetLimit > 0 ? pyRound((a.budgetUsed / a.budgetLimit) * 100, 1) : 0,
    },
  };
  if (showEfficiency) {
    json.iterations = a.iterations.map((it, i) => ({
      number: i + 1,
      input_tokens: it.input_tokens ?? 0,
      output_tokens: it.output_tokens ?? 0,
      cost_usd: pyRound(it.cost_usd ?? 0, 2),
      duration_seconds: it.duration_seconds ?? 0,
    }));
  }
  // Python's json.dumps preserves float-ness of values produced by round(x, n)
  // (e.g. 1280.0 -> "1280.0", 10.0 -> "10.0"). JS `JSON.stringify(10.0)` emits
  // `10`. Match Python by suffixing `.0` to integral floats in known
  // float-typed fields. Bash falls back to int 0 when the divisor is zero
  // (json.dumps emits `0`), so we skip the substitution in those cases.
  let out = JSON.stringify(json, null, 2);
  function forceFloat(field: string, when: boolean) {
    if (!when) return;
    const re = new RegExp(`("${field}": )(-?\\d+)(,?)$`, "m");
    out = out.replace(re, (_m, p1: string, p2: string, p3: string) => `${p1}${p2}.0${p3}`);
  }
  forceFloat("avg_duration_per_iteration", ic > 0 && Number.isInteger(json.efficiency.avg_duration_per_iteration));
  forceFloat("percent", a.budgetLimit > 0 && Number.isInteger(json.budget.percent));
  // tokens.cost_usd is `round(totalCost, 2)` -- always a float when iterations exist.
  forceFloat("cost_usd", ic > 0 && Number.isInteger(json.tokens.cost_usd));
  // Per-iteration cost_usd entries (when --efficiency): replace each integral one.
  if (showEfficiency) {
    out = out.replace(
      /("cost_usd": )(-?\d+)(,?)$/gm,
      (_m, p1: string, p2: string, p3: string) => `${p1}${p2}.0${p3}`,
    );
  }
  return out;
}

function renderText(a: Aggregated, showEfficiency: boolean): string {
  const lines: string[] = [];
  lines.push("Loki Mode Session Statistics");
  lines.push("============================");
  lines.push("");

  // Session
  lines.push("Session");
  lines.push(`  Iterations completed: ${a.iterationCount}`);
  lines.push(`  Duration: ${fmtDuration(a.totalDuration)}`);
  lines.push(`  Current phase: ${a.phase}`);
  lines.push("");

  // Token Usage
  lines.push("Token Usage");
  if (a.iterations.length > 0) {
    lines.push(`  Input tokens:  ${fmtNumber(a.totalInput)}`);
    lines.push(`  Output tokens: ${fmtNumber(a.totalOutput)}`);
    lines.push(`  Total tokens:  ${fmtNumber(a.totalTokens)}`);
    lines.push(`  Estimated cost: $${fmtFixed(a.totalCost, 2)}`);
  } else {
    lines.push("  N/A (no iteration metrics found)");
  }
  lines.push("");

  // Quality Gates
  lines.push("Quality Gates");
  if (a.gatesTotal > 0) {
    const pct = Math.round((a.gatesPassed / a.gatesTotal) * 100);
    lines.push(`  Gates passed: ${a.gatesPassed}/${a.gatesTotal} (${pct}%)`);
  } else {
    lines.push("  Gates passed: N/A");
  }
  if (a.reviewsTotal > 0) {
    const parts: string[] = [];
    if (a.reviewsApproved > 0) parts.push(`${a.reviewsApproved} approved`);
    if (a.reviewsRevision > 0) parts.push(`${a.reviewsRevision} revision requested`);
    const detail = parts.length > 0 ? parts.join(", ") : "N/A";
    lines.push(`  Code reviews: ${a.reviewsTotal} (${detail})`);
  }
  if (Object.keys(a.gateFailures).length > 0) {
    const failureParts = Object.entries(a.gateFailures)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} (${v})`);
    if (failureParts.length > 0) {
      lines.push(`  Gate failures: ${failureParts.join(", ")}`);
    }
  }
  lines.push("");

  // Efficiency
  lines.push("Efficiency");
  if (a.iterationCount > 0 && a.iterations.length > 0) {
    const avgTokens = Math.round(a.totalTokens / a.iterationCount);
    const avgCost = a.totalCost / a.iterationCount;
    const avgDur = a.totalDuration / a.iterationCount;
    lines.push(`  Avg tokens/iteration: ${fmtNumber(avgTokens)}`);
    lines.push(`  Avg cost/iteration: $${fmtFixed(avgCost, 2)}`);
    lines.push(`  Avg duration/iteration: ${fmtDuration(avgDur)}`);
  } else {
    lines.push("  N/A (no iteration metrics found)");
  }
  lines.push("");

  // Budget
  lines.push("Budget");
  if (a.budgetLimit > 0) {
    // Python prints round(x, 1) as a float repr (e.g. 4.0 -> "4.0", 12.5 -> "12.5").
    const pctNum = pyRound((a.budgetUsed / a.budgetLimit) * 100, 1);
    const pct = Number.isInteger(pctNum) ? `${pctNum}.0` : `${pctNum}`;
    lines.push(
      `  Used: $${fmtFixed(a.budgetUsed, 2)} / $${fmtFixed(a.budgetLimit, 2)} (${pct}%)`,
    );
  } else if (a.budgetUsed > 0) {
    lines.push(`  Used: $${fmtFixed(a.budgetUsed, 2)} (no limit set)`);
  } else {
    lines.push("  N/A");
  }

  // Per-iteration breakdown
  if (showEfficiency && a.iterations.length > 0) {
    lines.push("");
    lines.push("Per-Iteration Breakdown");
    a.iterations.forEach((it, idx) => {
      const i = idx + 1;
      const inp = padRight(fmtNumber(it.input_tokens ?? 0), 10);
      const out = padRight(fmtNumber(it.output_tokens ?? 0), 10);
      const cost = it.cost_usd ?? 0;
      const dur = fmtDuration(it.duration_seconds ?? 0);
      const idxStr = padRight(`${i}`, 3);
      lines.push(
        `  #${idxStr} input: ${inp} output: ${out} cost: $${fmtFixed(cost, 2)}  time: ${dur}`,
      );
    });
  }

  return lines.join("\n");
}

// ---- Entry point ----

export type StatsResult = {
  exitCode: number;
  stdout: string;
};

export function computeStats(argv: readonly string[]): StatsResult {
  let showJson = false;
  let showEfficiency = false;
  for (const arg of argv) {
    if (arg === "--json") showJson = true;
    else if (arg === "--efficiency") showEfficiency = true;
    // unknown flags ignored to match bash behavior (case *) shift)
  }

  const loki = lokiDir();
  if (!isDir(loki)) {
    if (showJson) {
      return { exitCode: 0, stdout: '{"error": "No active session"}' };
    }
    const msg = `${YELLOW}No active session found.${NC}\nStart a session with: loki start <prd>`;
    return { exitCode: 0, stdout: msg };
  }

  const a = aggregate(loki);
  const out = showJson ? renderJson(a, showEfficiency) : renderText(a, showEfficiency);
  return { exitCode: 0, stdout: out };
}

export async function runStats(argv: readonly string[]): Promise<number> {
  const r = computeStats(argv);
  console.log(r.stdout);
  return r.exitCode;
}
