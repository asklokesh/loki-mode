// loki-ts/src/engine10/cost.ts
//
// E-06: harvest result-cost side files (`<lokiRoot>/metrics/result-cost-<iter>.json`, the exact shape writeResultCost in
// src/runner/sdk_stream_parser.ts writes: {total_cost_usd, input_tokens, output_tokens, cache_read_tokens,
// cache_creation_tokens, model}) into cost-event data. Absent/unreadable/no-total_cost_usd, or a dollar figure with
// all-zero usage (E-69, the EV-8 failure mode), all mean UNKNOWN: usd null, never 0.
//
// E-06b: also writes `<lokiRoot>/metrics/efficiency/iteration-<N>.json`, the shape ENGINE.md section 10 and
// autonomy/lib/cost-summary.py read (not ours to change). Unlike the legacy bash writer (autonomy/run.sh), which
// always writes cost_usd (defaulting to 0 when unknown), this omits cost_usd when there is no dollar figure.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CostRecords, CostTotals } from "./types.ts";
import { hooks } from "./hooks.ts";
import { join } from "node:path"; import { routerEnabled } from "../runner/router/flag.ts";

/** D48: marker on a result-cost file and the cost event/receipt for a CLI-invoker session (LOKI_E10_INVOKER=cli, e.g. the
 *  stub provider) that has no provider-reported dollars. Recorded as 0, never null, and always disclosed in NOT PROVEN. */
export const UNMETERED = "cli-invoker-unmetered";

export interface RouterUsage {
  requests_total: number;
  requests_over_100k: number;
  over_100k_input_tokens: number;
  over_100k_output_tokens: number;
  advisor_calls: number;
  advisor_input_tokens: number;
  advisor_output_tokens: number;
}

export interface CostResult {
  unmetered?: boolean; // some session in this sum carried the UNMETERED marker
  usd: number | null;
  // E-69: dollars actually reported by the measured sessions even when usd above is null (some OTHER
  // session in this call wasn't priced). Lets a caller render "partial: $X for N of M" instead of "not measured".
  partialUsd: number;
  measuredCount: number; // sessions with a provider-sourced dollar figure and real usage (see noUsage below)
  totalCount: number; // iterations.length, so a caller can report "N of M"
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  // RECEIPT-TRUTH: whether any read file actually carried the key. A sum of nothing is NOT RECORDED, not 0.
  cache_read_seen?: boolean;
  cache_creation_seen?: boolean;
  tokens_measured?: { k: number; n: number }; // set only when k < n: sessions whose tokens went into the sums
  records?: CostRecords; // COST-RECORDS / FIX-RESUME: per-model, scope, turns, resume verdict; absent when no file was read
  duration_ms?: number; // sum of the SDK result line duration_ms over the files that carried one; absent when none did
  // R1-08: summed router telemetry. over_100k_* are the input/output tokens of requests strictly over
  // 100K prompt tokens, so a caller can apply the pricing over_100k tier (budget.ts); not applied here.
  // Optional so other CostResult producers (budget.ts) need no change; sumResultCosts always sets it.
  router?: RouterUsage;
  model: string | null; // E-50: provider-reported model from the result-cost file itself, never a guess
  source: string; // comma-joined result-cost file paths that were read
  missing: string[]; // iterations with no dollar figure: no file, a file with no total_cost_usd, or all-zero usage (see noUsage below)
}

/** R1-08: router telemetry is recorded only when the router flag is on (1/true/on, same as the router flag readers), so LOKI_ROUTER unset or 0
 *  leaves the result-cost file and CostResult byte-identical to pre-router. Shared by the stream parser. */
export function routerTelemetryOn(env: Record<string, string | undefined> = process.env): boolean {
  return routerEnabled(env);
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function resultCostPath(lokiRoot: string, iteration: string): string {
  return join(lokiRoot, "metrics", `result-cost-${iteration}.json`);
}

// Sum across sessions. Any missing session makes usd null: a partial sum
// would understate the run's cost. Tokens still sum what was measured.
// `context` are other iterations of the same run, read only to find a resumed session's predecessor (never summed).
export function sumResultCosts(lokiRoot: string, iterations: string[], context: string[] = []): CostResult {
  const out: CostResult = {
    usd: null, partialUsd: 0, measuredCount: 0, totalCount: iterations.length,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    ...(routerTelemetryOn() ? { router: { requests_total: 0, requests_over_100k: 0, over_100k_input_tokens: 0, over_100k_output_tokens: 0,
      advisor_calls: 0, advisor_input_tokens: 0, advisor_output_tokens: 0 } } : {}),
    model: null, source: "", missing: [],
  };
  const sources: string[] = [];
  const recs: { iter: string; rec: Record<string, unknown> }[] = [];
  let usd = 0, readSeen = 0, creationSeen = 0, durSeen = 0, tokenSessions = 0;
  // FIX-RESUME: decide ambiguity over every parsed file first; an ambiguous file (a resumed total that may already
  // include its predecessor) is excluded from EVERY summed figure, not just dollars (R3-2).
  const parsed = new Map<string, Record<string, unknown>>();
  for (const iter of iterations) {
    try { parsed.set(iter, JSON.parse(readFileSync(resultCostPath(lokiRoot, iter), "utf8")) as Record<string, unknown>); } catch { /* counted missing below */ }
  }
  const own = new Set(iterations);
  const lookup = [...iterations.filter((i) => parsed.has(i)).map((iter) => ({ iter, rec: parsed.get(iter)! }))];
  for (const iter of context) {
    if (own.has(iter)) continue;
    try { lookup.push({ iter, rec: JSON.parse(readFileSync(resultCostPath(lokiRoot, iter), "utf8")) as Record<string, unknown> }); } catch { /* absent predecessor stays ambiguous */ }
  }
  const verdicts = hooks.costRecords?.resumeVerdicts(lookup) ?? { ambiguous: [], separate: [] };
  const rv = { ambiguous: verdicts.ambiguous.filter((i) => own.has(i)), separate: verdicts.separate.filter((i) => own.has(i)) };
  for (const iter of iterations) {
    const path = resultCostPath(lokiRoot, iter);
    const rec = parsed.get(iter);
    if (!rec) {
      out.missing.push(iter); // no file at all: neither cost nor tokens are usable
      continue;
    }
    if (rv.ambiguous.includes(iter)) {
      out.missing.push(iter);
      sources.push(path);
      continue;
    }
    // The file parsed, so its tokens are real even when total_cost_usd is absent (a codex/tokens-only
    // session): capture them regardless of a dollar figure below (dropping them was the E-06 bug).
    tokenSessions++;
    const inTok = num(rec["input_tokens"]);
    const outTok = num(rec["output_tokens"]);
    const cacheR = num(rec["cache_read_tokens"]);
    const cacheC = num(rec["cache_creation_tokens"]);
    out.input_tokens += inTok;
    out.output_tokens += outTok;
    out.cache_read_tokens += cacheR;
    out.cache_creation_tokens += cacheC;
    if (typeof rec["cache_read_tokens"] === "number") readSeen++;
    if (typeof rec["cache_creation_tokens"] === "number") creationSeen++;
    if (typeof rec["duration_ms"] === "number" && Number.isFinite(rec["duration_ms"])) { out.duration_ms = (out.duration_ms ?? 0) + rec["duration_ms"]; durSeen++; }
    if (out.router) out.router["requests_total"] += num(rec["requests_total"]);
    if (out.router) out.router["requests_over_100k"] += num(rec["requests_over_100k"]);
    if (out.router) out.router["over_100k_input_tokens"] += num(rec["over_100k_input_tokens"]);
    if (out.router) out.router["over_100k_output_tokens"] += num(rec["over_100k_output_tokens"]);
    if (out.router) out.router["advisor_calls"] += num(rec["advisor_calls"]);
    if (out.router) out.router["advisor_input_tokens"] += num(rec["advisor_input_tokens"]);
    if (out.router) out.router["advisor_output_tokens"] += num(rec["advisor_output_tokens"]);
    if (typeof rec["model"] === "string" && rec["model"]) out.model = rec["model"];
    sources.push(path);
    recs.push({ iter, rec });
    const c = rec["total_cost_usd"];
    // E-69 (EV-8 failure mode "Cost: $0.00 (claude, 0 tokens)"): a dollar figure with all-zero usage
    // is a session that never really ran, so it's unmeasured like a missing file, never a real $0.00.
    const unmetered = rec["source"] === UNMETERED; // D48: an explicit marker, so the zero is disclosed, not a fake provider figure
    if (unmetered) out.unmetered = true;
    const noUsage = !unmetered && inTok === 0 && outTok === 0 && cacheR === 0 && cacheC === 0;
    if (typeof c !== "number" || !Number.isFinite(c) || noUsage) {
      out.missing.push(iter); // dollars unknown for this session: the usd sum stays unknown too
      continue;
    }
    usd += c;
    out.partialUsd += c;
    out.measuredCount++;
  }
  out.source = sources.join(",");
  // RECEIPT-TRUTH: a cache total is published only when EVERY session carried the key; a partial sum is not the run total
  out.cache_read_seen = iterations.length > 0 && readSeen === iterations.length;
  out.cache_creation_seen = iterations.length > 0 && creationSeen === iterations.length;
  if (iterations.length > 0 && tokenSessions < iterations.length) out.tokens_measured = { k: tokenSessions, n: iterations.length };
  if (durSeen !== iterations.length) delete out.duration_ms; // a partial duration is not the run's
  if (hooks.costRecords && (rv.ambiguous.length > 0 || recs.length > 0)) {
    const r = hooks.costRecords.build(recs, iterations.length, rv.ambiguous, rv.separate);
    // whole-pipeline tokens replace the main-loop-only usage figures only when EVERY session carried modelUsage (R3-1)
    if (r.tokens_scope === "all-models" && r.per_model) {
      const v = Object.values(r.per_model);
      const sum = (k: keyof (typeof v)[number]): number => v.reduce((a, m) => a + m[k], 0);
      out.input_tokens = sum("input_tokens"); out.output_tokens = sum("output_tokens"); out.cache_read_tokens = sum("cache_read_tokens"); out.cache_creation_tokens = sum("cache_creation_tokens");
      out.cache_read_seen = true; out.cache_creation_seen = true; // modelUsage reports every model's cache figures
    }
    out.records = r;
  }
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

// The one predicate for "this session has no recorded usage": its efficiency record and its cost event both omit every token key.
export function tokensUnmeasured(cost: Pick<CostResult, "tokens_measured" | "records">): boolean {
  return cost.tokens_measured !== undefined || cost.records?.resume === "ambiguous";
}

// Writes one efficiency record for a provider session and returns its N. cost_usd is omitted (never written as 0)
// when the session had no provider-reported dollars -- cost-summary.py then reads it as unmeasured, never as free.
export function writeEfficiencyRecord(lokiRoot: string, info: EfficiencySessionInfo, cost: CostResult, costSource = "provider"): number {
  const dir = efficiencyDir(lokiRoot);
  mkdirSync(dir, { recursive: true });
  const n = nextEfficiencyIteration(lokiRoot);
  const rec: Record<string, unknown> = {
    iteration: n,
    status: info.status,
    duration_ms: info.durationMs,
    model: cost.model ?? info.model, // E-50: provider-reported model wins over the caller's guess
  };
  if (cost.usd !== null) {
    rec.cost_usd = cost.usd;
    rec.cost_source = costSource; // EV-1 gate reads only provider-sourced dollars ("partial-stream": E-98e, priced from streamed usage, never itself provider-reported)
  }
  // A session left out of the token sums (ambiguous resume) writes NO token keys: every reader treats a record without them as
  // unmeasured, where a written 0 would read as a measured zero.
  if (tokensUnmeasured(cost)) {
    rec.tokens_measured = false; // explicit marker the efficiency readers key on (kpis, stats, efficiency_cost.py, dashboard)
  } else {
    rec.input_tokens = cost.input_tokens;
    rec.output_tokens = cost.output_tokens;
    rec.cache_read_tokens = cost.cache_read_tokens;
    rec.cache_creation_tokens = cost.cache_creation_tokens;
  }
  writeFileSync(join(dir, `iteration-${n}.json`), JSON.stringify(rec));
  return n;
}

// What a provider session calls once it ends: reads its own result-cost file and writes the derived efficiency record
// in the same step. Returns the CostResult so the caller can also emit the `cost` event (section 5) from the same numbers.
export function recordSessionCost(lokiRoot: string, iterationId: string, info: EfficiencySessionInfo): CostResult {
  // The predecessor of a resumed session is another file of the same run: look it up so a provably separate resume is not blanked.
  let siblings: string[] = [];
  try { siblings = readdirSync(join(lokiRoot, "metrics")).filter((f) => f.startsWith("result-cost-") && f.endsWith(".json")).map((f) => f.slice("result-cost-".length, -".json".length)); } catch { /* no metrics dir yet */ }
  const cost = sumResultCosts(lokiRoot, [iterationId], siblings);
  writeEfficiencyRecord(lokiRoot, info, cost, cost.unmetered ? UNMETERED : "provider");
  return cost;
}

/** Map the file-summed CostResult to the machine's CostTotals; a cache key no file carried stays unseen (NOT RECORDED), never 0. */
export function costTotalsOf(c: CostResult): CostTotals {
  return { usd: c.usd, ...(c.tokens_measured ? { tokensMeasured: c.tokens_measured } : {}), inputTokens: c.input_tokens, outputTokens: c.output_tokens, cacheReadTokens: c.cache_read_tokens, cacheCreationTokens: c.cache_creation_tokens, cacheReadSeen: c.cache_read_seen === true, cacheCreationSeen: c.cache_creation_seen === true, ...(c.duration_ms !== undefined ? { durationMs: c.duration_ms } : {}), ...(c.records ? { records: c.records } : {}), measuredCount: c.measuredCount, totalCount: c.totalCount, partialUsd: c.partialUsd, unmetered: c.unmetered };
}
