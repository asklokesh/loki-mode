// loki-ts/src/engine10/cost.ts
//
// E-06: harvest result-cost side files into cost-event data.
// Reads `<lokiRoot>/metrics/result-cost-<iter>.json`, the exact file
// writeResultCost (src/runner/sdk_stream_parser.ts) writes:
//   {total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens}
// writeResultCost skips the file when the provider reported no cost, so an
// absent or unreadable file means UNKNOWN: usd is null, never 0.
//
// E-06b: also write `<lokiRoot>/metrics/efficiency/iteration-<N>.json`, the
// shape ENGINE.md section 10 and autonomy/lib/cost-summary.py read (that
// script is the eval harness's only source for `fully_measured` / total
// cost, and it is not ours to change). Unlike the legacy bash writer
// (autonomy/run.sh, `cat > iteration-${iteration}.json`), which always
// writes cost_usd (defaulting to 0 when unknown -- the exact "unmeasured
// read as free" bug section 10 exists to fix), this omits cost_usd entirely
// when the session had no dollar figure.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CostResult {
  usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  source: string; // comma-joined result-cost file paths that were read
  missing: string[]; // iterations with no dollar figure: either no file at all, or a file with tokens but no total_cost_usd
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function resultCostPath(lokiRoot: string, iteration: string): string {
  return join(lokiRoot, "metrics", `result-cost-${iteration}.json`);
}

// Sum across sessions. Any missing session makes usd null: a partial sum
// would understate the run's cost. Tokens still sum what was measured.
export function sumResultCosts(lokiRoot: string, iterations: string[]): CostResult {
  const out: CostResult = { usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, source: "", missing: [] };
  const sources: string[] = [];
  let usd = 0;
  for (const iter of iterations) {
    const path = resultCostPath(lokiRoot, iter);
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      out.missing.push(iter); // no file at all: neither cost nor tokens are usable
      continue;
    }
    // The file parsed, so its tokens are real even when total_cost_usd is
    // absent (a codex/tokens-only session): capture them regardless of
    // whether a dollar figure follows below. Dropping tokens here just
    // because the session was unpriced was the E-06 bug this fixes.
    out.input_tokens += num(rec["input_tokens"]);
    out.output_tokens += num(rec["output_tokens"]);
    out.cache_read_tokens += num(rec["cache_read_tokens"]);
    out.cache_creation_tokens += num(rec["cache_creation_tokens"]);
    sources.push(path);
    const c = rec["total_cost_usd"];
    if (typeof c !== "number" || !Number.isFinite(c)) {
      out.missing.push(iter); // dollars unknown for this session: the usd sum stays unknown too
      continue;
    }
    usd += c;
  }
  out.source = sources.join(",");
  if (iterations.length > 0 && out.missing.length === 0) out.usd = usd;
  return out;
}

export function readResultCost(lokiRoot: string, iteration: string): CostResult {
  return sumResultCosts(lokiRoot, [iteration]);
}

// --- E-06b: .loki/metrics/efficiency/iteration-<N>.json -------------------

export interface EfficiencySessionInfo {
  status: string; // "completed" | "failed" | "killed", matching SessionResult/legacy status_str
  durationMs: number;
  model: string;
}

const ITERATION_FILE_RE = /^iteration-(\d+)\.json$/;

function efficiencyDir(lokiRoot: string): string {
  return join(lokiRoot, "metrics", "efficiency");
}

/** N = next integer after any existing iteration-<N>.json (ENGINE.md section 10). */
export function nextEfficiencyIteration(lokiRoot: string): number {
  let names: string[];
  try {
    names = readdirSync(efficiencyDir(lokiRoot));
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of names) {
    const m = ITERATION_FILE_RE.exec(name);
    if (m?.[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/** Writes one efficiency record for a provider session and returns its N.
 *  cost_usd is omitted (never written as 0) when the session had no
 *  provider-reported dollars -- cost-summary.py then reads it as unmeasured,
 *  never as free. */
export function writeEfficiencyRecord(lokiRoot: string, info: EfficiencySessionInfo, cost: CostResult): number {
  const dir = efficiencyDir(lokiRoot);
  mkdirSync(dir, { recursive: true });
  const n = nextEfficiencyIteration(lokiRoot);
  const rec: Record<string, unknown> = {
    iteration: n,
    status: info.status,
    duration_ms: info.durationMs,
    model: info.model,
  };
  if (cost.usd !== null) rec.cost_usd = cost.usd;
  rec.input_tokens = cost.input_tokens;
  rec.output_tokens = cost.output_tokens;
  rec.cache_read_tokens = cost.cache_read_tokens;
  rec.cache_creation_tokens = cost.cache_creation_tokens;
  writeFileSync(join(dir, `iteration-${n}.json`), JSON.stringify(rec));
  return n;
}

/** What a provider session calls once it ends: reads its own result-cost
 *  file and writes the derived efficiency record in the same step. Returns
 *  the CostResult so the caller can also emit the `cost` event (section 5)
 *  from the same numbers. */
export function recordSessionCost(lokiRoot: string, iterationId: string, info: EfficiencySessionInfo): CostResult {
  const cost = readResultCost(lokiRoot, iterationId);
  writeEfficiencyRecord(lokiRoot, info, cost);
  return cost;
}
