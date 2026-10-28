// PARITY-COST: cost measurement for non-Claude providers (codex, cline, aider, opencode) in engine10.
// Claude writes result-cost-<iter>.json itself. These providers do not, so cost.ts read them as "not measured" (usd null),
// which meant the per-run dollar cap (e10ext/budget_cap.ts) never applied. This module writes the SAME result-cost file
// shape (see cost.ts header) so the existing cost event, efficiency record and cap path work unchanged:
//   1. provider-reported dollars (aider "Cost: $X session"): estimated=false
//   2. provider-reported tokens (codex, aider, cline), priced from the table: estimated=true
//   3. prompt/response sizes, priced from the table: estimated=true
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CostResult } from "../engine10/cost.ts";
import { median } from "../util/cost_breakdown.ts";
import { estimateTokens, priceFor, usdFor } from "../providers/price_table.ts";

export interface ParsedUsage { input: number; output: number; cached: number; usd: number | null }

const toNum = (s: string): number => {
  const t = s.replace(/,/g, "").trim().toLowerCase();
  const m = /^([\d.]+)\s*([km])?$/.exec(t);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
};

/** aider: "Tokens: 1.2k sent, 340 received. Cost: $0.01 message, $0.02 session." Token lines sum; the last session figure wins. */
export function parseAiderUsage(text: string): ParsedUsage | null {
  const re = /Tokens:\s*([\d.,]+[km]?)\s*sent(?:,\s*([\d.,]+[km]?)\s*cache write)?(?:,\s*([\d.,]+[km]?)\s*cache hit)?,\s*([\d.,]+[km]?)\s*received\.?(?:\s*Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session)?/gi;
  let input = 0, output = 0, cached = 0, session: number | null = null, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    any = true;
    const i = toNum(m[1]!), o = toNum(m[4]!), c = m[3] ? toNum(m[3]) : 0;
    if (Number.isFinite(i)) input += i;
    if (Number.isFinite(o)) output += o;
    if (Number.isFinite(c)) cached += c;
    if (m[6]) session = Number(m[6]); // aider's session figure is cumulative: the last one is the total
  }
  return any ? { input, output, cached, usd: session !== null && Number.isFinite(session) ? session : null } : null;
}

/** codex: "Token usage: total=1234 input=1000 (+ 500 cached) output=234" or "tokens used\n12,345" (total only). */
export function parseCodexUsage(text: string): ParsedUsage | null {
  const full = /input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s*cached\))?\s*output=([\d,]+)/gi;
  let input = 0, output = 0, cached = 0, any = false, m: RegExpExecArray | null;
  while ((m = full.exec(text))) {
    any = true;
    input += toNum(m[1]!) || 0; cached += m[2] ? toNum(m[2]) || 0 : 0; output += toNum(m[3]!) || 0;
  }
  if (any) return { input: input + cached, output, cached, usd: null };
  const total = /tokens used\s*[:\n]\s*([\d,]+)/i.exec(text);
  if (total) {
    const t = toNum(total[1]!);
    if (Number.isFinite(t) && t > 0) { const i = Math.round(t * 0.9); return { input: i, output: t - i, cached: 0, usd: null }; } // total only: the split is a guess
  }
  return null;
}

/** cline: JSON usage such as {"tokensIn":123,"tokensOut":45,"totalCost":0.01}; sums every occurrence. */
export function parseClineUsage(text: string): ParsedUsage | null {
  let input = 0, output = 0, usd = 0, any = false, sawUsd = false;
  for (const m of text.matchAll(/"tokensIn"\s*:\s*(\d+)[^{}]*?"tokensOut"\s*:\s*(\d+)(?:[^{}]*?"totalCost"\s*:\s*([\d.]+))?/g)) {
    any = true; input += Number(m[1]); output += Number(m[2]);
    if (m[3]) { usd += Number(m[3]); sawUsd = true; }
  }
  return any ? { input, output, cached: 0, usd: sawUsd ? usd : null } : null;
}

export function parseUsage(provider: string, text: string): ParsedUsage | null {
  if (provider === "aider") return parseAiderUsage(text);
  if (provider === "codex") return parseCodexUsage(text);
  if (provider === "cline") return parseClineUsage(text);
  return null;
}

export const ESTIMATED_PROVIDERS: ReadonlySet<string> = new Set(["codex", "cline", "aider", "opencode"]);

export interface ProviderCostRecord {
  total_cost_usd: number | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
  model: string; estimated: boolean; cost_basis: "provider-dollars" | "provider-tokens" | "size-estimate" | "unpriced";
  /** Set when total_cost_usd is null: why the dollars are unmeasured. Tokens stay recorded. */
  unmeasured_reason?: string;
}

/** A model with no table entry has no known price: dollars are unmeasured (null + reason), never a DEFAULT_PRICE guess or 0. */
function unpriced(model: string, input: number, output: number, cached: number, estimated: boolean): ProviderCostRecord {
  return { total_cost_usd: null, input_tokens: input, output_tokens: output, cache_read_tokens: cached, cache_creation_tokens: 0, model, estimated, cost_basis: "unpriced", unmeasured_reason: `no known price for model "${model || "unknown"}"` };
}

export function buildProviderCost(provider: string, model: string, prompt: string, output: string): ProviderCostRecord | null {
  if (!ESTIMATED_PROVIDERS.has(provider)) return null;
  const u = parseUsage(provider, output);
  if (u && u.usd !== null && u.usd >= 0 && u.input + u.output > 0) {
    return { total_cost_usd: u.usd, input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cached, cache_creation_tokens: 0, model, estimated: false, cost_basis: "provider-dollars" };
  }
  const known = priceFor(model).matched;
  if (u && u.input + u.output > 0) {
    if (!known) return unpriced(model, u.input, u.output, u.cached, false);
    return { total_cost_usd: usdFor(model, u.input, u.output, u.cached), input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cached, cache_creation_tokens: 0, model, estimated: true, cost_basis: "provider-tokens" };
  }
  const i = estimateTokens(prompt), o = estimateTokens(output);
  if (i + o === 0) return null; // nothing ran: stays unmeasured, never a fake zero
  if (!known) return unpriced(model, i, o, 0, false);
  return { total_cost_usd: usdFor(model, i, o), input_tokens: i, output_tokens: o, cache_read_tokens: 0, cache_creation_tokens: 0, model, estimated: true, cost_basis: "size-estimate" };
}

/** Writes result-cost-<iter>.json at dest unless the provider already produced one. Returns the record written, or null. */
export function writeProviderCost(dest: string, provider: string, model: string, prompt: string, output: string): ProviderCostRecord | null {
  if (existsSync(dest)) return null;
  const rec = buildProviderCost(provider, model, prompt, output);
  if (!rec) return null;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(rec));
  return rec;
}

/** Reviewer-stage cost: one result-cost-<iter>.json per reviewer (stage "review", plus reviewer and model). Claude's --output-format json carries total_cost_usd and usage; other reviewers report tokens at most. A figure the reviewer did not report is left OUT of the file (unknown, never 0), so the run total stays null rather than undercounted. */
export function writeReviewerCost(lokiRoot: string, iterationId: string, o: { reviewer: string; provider: string; model?: string; stdout: string; stderr?: string }): void {
  try {
    const rec: Record<string, unknown> = { stage: "review", reviewer: o.reviewer };
    let model = o.model || "";
    if (o.provider === "claude") {
      const j = JSON.parse(o.stdout) as { total_cost_usd?: unknown; usage?: Record<string, unknown>; modelUsage?: Record<string, unknown> };
      if (typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd)) rec["total_cost_usd"] = j.total_cost_usd;
      const u = j.usage ?? {};
      for (const [k, from] of [["input_tokens", "input_tokens"], ["output_tokens", "output_tokens"], ["cache_read_tokens", "cache_read_input_tokens"], ["cache_creation_tokens", "cache_creation_input_tokens"]] as const) if (typeof u[from] === "number") rec[k] = u[from];
      model = Object.keys(j.modelUsage ?? {})[0] || model; // the provider-reported model wins over the requested pin
    } else {
      const u = parseUsage(o.provider, `${o.stdout}\n${o.stderr ?? ""}`);
      if (u) { rec["input_tokens"] = u.input; rec["output_tokens"] = u.output; if (u.usd !== null) rec["total_cost_usd"] = u.usd; }
    }
    if (model) rec["model"] = model;
    const dir = join(lokiRoot, "metrics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `result-cost-${iterationId}.json`), JSON.stringify(rec));
  } catch { /* best-effort: no file means the reviewer's cost is unknown, which the sum already reports */ }
}

// --- E-06b: .loki/metrics/efficiency/iteration-<N>.json -------------------

export interface EfficiencySessionInfo {
  status: string; // "completed" | "failed" | "killed", matching SessionResult/legacy status_str
  durationMs: number;
  model: string;
  stage?: string; // #244: the engine10 stage that ran, so cache gaps persist per stage
  gapMs?: number; // #244: ms since this run's previous session of the same stage ended; absent for a stage's first call
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
  if (info.stage) rec.stage = info.stage;
  if (info.gapMs !== undefined && Number.isFinite(info.gapMs) && info.gapMs >= 0) rec.gap_ms = Math.round(info.gapMs);
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

// P12-09b: a quota rerun reuses its iterationId, and the result-cost file is keyed by it. Kept here (outside the engine10 core line budget).
const costFile = (lokiRoot: string, id: string): string => join(lokiRoot, "metrics", `result-cost-${id}.json`);
/** Moves the earlier attempt's result-cost aside (-q<k>) so the rerun cannot overwrite it. */
export function archivePriorCost(lokiRoot: string, id: string): void {
  if (!existsSync(costFile(lokiRoot, id))) return;
  let k = 1; while (existsSync(costFile(lokiRoot, `${id}-q${k}`))) k++;
  renameSync(costFile(lokiRoot, id), costFile(lokiRoot, `${id}-q${k}`));
}
/** Archives the earlier attempt's cost in the session's own .loki and in lokiRoot (they differ for a wall temp dir). */
export function archivePriorCosts(lokiRoot: string | undefined, cwd: string | undefined, id: string): void {
  if (lokiRoot) for (const root of new Set([join(cwd ?? process.cwd(), ".loki"), lokiRoot])) archivePriorCost(root, id);
}
/** ids plus every archived earlier attempt of them, so a sum counts each attempt once. */
export function withArchivedCosts(lokiRoot: string, ids: string[], keep: (archivedId: string) => boolean = () => true): string[] {
  let files: string[] = []; try { files = readdirSync(join(lokiRoot, "metrics")); } catch { /* none yet */ }
  return [...new Set([...ids, ...ids.flatMap((id) => files.filter((f) => f.startsWith(`result-cost-${id}-q`) && f.endsWith(".json")).map((f) => f.slice("result-cost-".length, -".json".length)).filter(keep))])];
}
/** D48: marker on a result-cost file and the cost event/receipt for a CLI-invoker session that has no provider-reported dollars (recorded as 0, never null). */
export const UNMETERED = "cli-invoker-unmetered";
/** E-69 "never ran" shape of a result-cost file: a quota error result is always exactly $0, with all four usage counts 0 and source not the unmetered marker. Unreadable or any other shape is not it (an unknown cost must stay in the sum, flagged partial). */
export function neverRan(path: string, unmeteredMarker: string): boolean {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return r["total_cost_usd"] === 0 && r["source"] !== unmeteredMarker && ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"].every((k) => n(r[k]) === 0);
  } catch { return false; }
}
/** Sum ids for a run: ids plus archived earlier quota attempts, minus archives that never ran. Follow-up (telemetry only): seal.ts's router sum ignores archived ids. */
export function liveArchivedCosts(lokiRoot: string, ids: string[], unmeteredMarker: string): string[] {
  return withArchivedCosts(lokiRoot, ids, (id) => !neverRan(join(lokiRoot, "metrics", `result-cost-${id}.json`), unmeteredMarker));
}

/** #244: median persisted call gap (ms) of a stage across the repo's earlier runs, from the efficiency records' gap_ms; null with no data. Feeds the cache TTL switch. */
export function stageMedianGapMs(lokiRoot: string, stage: string): number | null {
  const gaps: number[] = [];
  try {
    for (const f of readdirSync(efficiencyDir(lokiRoot))) {
      if (!ITERATION_FILE_RE.test(f)) continue;
      try {
        const r = JSON.parse(readFileSync(join(efficiencyDir(lokiRoot), f), "utf8")) as Record<string, unknown>;
        if (r["stage"] === stage && typeof r["duration_ms"] === "number" && typeof r["gap_ms"] === "number" && Number.isFinite(r["gap_ms"])) gaps.push(r["gap_ms"]); // a record without duration_ms is not a timed call
      } catch { /* unreadable record: no data point */ }
    }
  } catch { return null; }
  return gaps.length > 0 ? median(gaps) : null;
}
