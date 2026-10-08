// loki-ts/src/engine10/cost_records.ts -- RECEIPT-TRUTH COST-RECORDS and FIX-RESUME (FC-44).
// Per-model cost from the SDK result line's modelUsage (whole pipeline, subagents included), the main-loop-only 5m/1h cache
// split labelled as such, and a per-session decision on whether a resumed session's total is cumulative. Anything that
// cannot be established reads NOT RECORDED (the key is omitted, usd is unknown), never a guess.
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const RECONCILE = 0.01;
export interface ModelRecord { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number }
export interface CostRecords {
  /** "all-models" = tokens come from modelUsage and its costUSD sums to total_cost_usd within 1%; "main-loop" = SDK usage, which excludes subagents. */
  tokens_scope?: "all-models" | "main-loop";
  per_model?: Record<string, ModelRecord>;
  turns?: number;
  /** usage.cache_creation split; main-loop scope only (modelUsage carries no split). */
  cache_creation_main_loop?: { ephemeral_5m_tokens: number; ephemeral_1h_tokens: number };
  /** "ambiguous" = a resumed session's total cannot be shown cumulative or not, so dollars read NOT RECORDED. "separate" = every resume total is provably not cumulative. */
  resume?: "ambiguous" | "separate";
}
type Rec = Record<string, unknown>;

/** Decide per resumed file whether it is separate or ambiguous. A cumulative total is never below its predecessor's, so a
 *  lower total proves separate; an equal-or-higher total fits both cases, so it is ambiguous (the SDK states cumulative is conditional). */
export function resumeVerdicts(recs: { iter: string; rec: Rec }[]): { ambiguous: string[]; separate: string[] } {
  const ambiguous: string[] = [], separate: string[] = [];
  for (const { iter, rec } of recs) {
    const from = rec["resumed_from"];
    if (typeof from !== "string" || !from) continue;
    const prev = recs.find((o) => o.iter !== iter && o.rec["session_id"] === from);
    const a = prev ? rec_cost(prev.rec) : null, b = rec_cost(rec);
    if (a !== null && b !== null && b < a) separate.push(iter); else ambiguous.push(iter);
  }
  return { ambiguous, separate };
}
const rec_cost = (r: Rec): number | null => (typeof r["total_cost_usd"] === "number" && Number.isFinite(r["total_cost_usd"]) ? r["total_cost_usd"] : null);

/** `recs` are the non-ambiguous parsed files; `expected` is the number of sessions in the run. Every aggregate below needs all of
 *  them, so a missing or ambiguous session leaves per_model, turns and the cache split out (NOT RECORDED), never a partial sum. */
export function buildRecords(recs: { iter: string; rec: Rec }[], expected: number, ambiguous: string[], separate: string[]): CostRecords {
  const out: CostRecords = {};
  if (ambiguous.length > 0) out.resume = "ambiguous"; else if (separate.length > 0) out.resume = "separate";
  if (recs.length === 0 || recs.length !== expected) return out;
  const turns = recs.map((r) => r.rec["num_turns"]);
  if (turns.every((t) => typeof t === "number")) out.turns = (turns as number[]).reduce((a, b) => a + b, 0);
  if (recs.every((r) => typeof r.rec["cache_creation_5m_tokens"] === "number" && typeof r.rec["cache_creation_1h_tokens"] === "number")) {
    out.cache_creation_main_loop = { ephemeral_5m_tokens: recs.reduce((a, r) => a + num(r.rec["cache_creation_5m_tokens"]), 0), ephemeral_1h_tokens: recs.reduce((a, r) => a + num(r.rec["cache_creation_1h_tokens"]), 0) };
  }
  const mus = recs.map((r) => r.rec["model_usage"]);
  if (mus.every((m) => typeof m === "object" && m !== null && !Array.isArray(m))) {
    const per: Record<string, ModelRecord> = {};
    let modelCost = 0;
    for (const m of mus as Record<string, Partial<ModelRecord>>[]) for (const [k, v] of Object.entries(m)) {
      const p = (per[k] ??= { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 });
      p.input_tokens += num(v.input_tokens); p.output_tokens += num(v.output_tokens); p.cache_read_tokens += num(v.cache_read_tokens); p.cache_creation_tokens += num(v.cache_creation_tokens); p.cost_usd += num(v.cost_usd);
      modelCost += num(v.cost_usd);
    }
    const total = recs.reduce((a, r) => a + num(r.rec["total_cost_usd"]), 0);
    if (total > 0 && Math.abs(modelCost - total) <= RECONCILE * total) { out.per_model = per; out.tokens_scope = "all-models"; }
  }
  if (out.tokens_scope === undefined) out.tokens_scope = "main-loop";
  return out;
}
