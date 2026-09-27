// loki-ts/src/engine10/cost.ts
//
// E-06: harvest result-cost side files into cost-event data.
// Reads `<lokiRoot>/metrics/result-cost-<iter>.json`, the exact file
// writeResultCost (src/runner/sdk_stream_parser.ts) writes:
//   {total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens}
// writeResultCost skips the file when the provider reported no cost, so an
// absent or unreadable file means UNKNOWN: usd is null, never 0.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CostResult {
  usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  source: string; // comma-joined result-cost file paths that were read
  missing: string[]; // iterations with no usable result-cost file
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
  const out: CostResult = { usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, source: "", missing: [] };
  const sources: string[] = [];
  let usd = 0;
  for (const iter of iterations) {
    const path = resultCostPath(lokiRoot, iter);
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      out.missing.push(iter);
      continue;
    }
    const c = rec["total_cost_usd"];
    if (typeof c !== "number" || !Number.isFinite(c)) {
      out.missing.push(iter);
      continue;
    }
    usd += c;
    out.input_tokens += num(rec["input_tokens"]);
    out.output_tokens += num(rec["output_tokens"]);
    out.cache_read_tokens += num(rec["cache_read_tokens"]);
    sources.push(path);
  }
  out.source = sources.join(",");
  if (iterations.length > 0 && out.missing.length === 0) out.usd = usd;
  return out;
}

export function readResultCost(lokiRoot: string, iteration: string): CostResult {
  return sumResultCosts(lokiRoot, [iteration]);
}
