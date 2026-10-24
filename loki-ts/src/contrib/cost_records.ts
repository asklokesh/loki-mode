// loki-ts/src/contrib/cost_records.ts -- RECEIPT-TRUTH COST-RECORDS and FIX-RESUME (FC-44).
// Per-model cost from the SDK result line's modelUsage (whole pipeline, subagents included), the main-loop-only 5m/1h cache
// split labelled as such, and a per-session decision on whether a resumed session's total is cumulative. Anything that
// cannot be established reads NOT RECORDED (the key is omitted, usd is unknown), never a guess.
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const RECONCILE = 0.01;
import type { CostRecords, ModelRecord } from "../engine10/types.ts";
export type { CostRecords, ModelRecord };
type Rec = Record<string, unknown>;

/** The IMMEDIATE predecessor of a resumed link. A resume chain can share one session id across several files, so the id alone does not name the parent.
 *  Cumulative totals only grow along a chain, so the parent is the candidate with the highest total not above this link's. Two candidates tied at that total cannot be told apart: undefined (ambiguous). When every candidate is above this link, the nearest one is returned (the "lower total proves separate" test). */
function immediatePredecessor(recs: { iter: string; rec: Rec }[], iter: string, from: string, b: number | null): { iter: string; rec: Rec } | undefined {
  const c = recs.filter((o) => o.iter !== iter && o.rec["session_id"] === from);
  if (c.length <= 1) return c[0];
  const cost = (o: { rec: Rec }): number | null => rec_cost(o.rec), known = c.filter((o) => cost(o) !== null);
  if (known.length !== c.length) return undefined;
  const below = b === null ? [] : known.filter((o) => cost(o)! <= b), pool = below.length > 0 ? below : known;
  const best = below.length > 0 ? Math.max(...pool.map((o) => cost(o)!)) : Math.min(...pool.map((o) => cost(o)!));
  const top = pool.filter((o) => cost(o) === best);
  return top.length === 1 ? top[0] : undefined;
}
/** Decide per resumed file whether it is separate or ambiguous. A cumulative total is never below its predecessor's, so a
 *  lower total proves separate; an equal-or-higher total fits both cases, so it is ambiguous (the SDK states cumulative is conditional). */
export function resumeVerdicts(recs: { iter: string; rec: Rec }[]): { ambiguous: string[]; separate: string[]; delta: Record<string, Rec> } {
  const ambiguous: string[] = [], separate: string[] = [], delta: Record<string, Rec> = {};
  for (const { iter, rec } of recs) {
    const from = rec["resumed_from"];
    if (typeof from !== "string" || !from) continue;
    const prev = immediatePredecessor(recs, iter, from, rec_cost(rec));
    const a = prev ? rec_cost(prev.rec) : null, b = rec_cost(rec);
    const d = prev ? cumulativeDelta(prev.rec, rec) : null;
    if (a !== null && b !== null && b < a) separate.push(iter); else if (d) delta[iter] = d; else ambiguous.push(iter);
  }
  return { ambiguous, separate, delta };
}
/** A resumed file whose total is PROVABLY cumulative gets billed for its own call only. Proof: its model_usage output tokens equal the
 *  predecessor's model_usage output plus its own top-level output_tokens (the call-only figure), and its total is not below the predecessor's.
 *  Returns the rec with total_cost_usd and model_usage reduced to the delta against the predecessor (taken against its immediate predecessor in the chain, see immediatePredecessor, so each link bills only its own increment and no parent is counted twice), or null when it cannot be proven (stays ambiguous, usd unknown). */
export function cumulativeDelta(prev: Rec, rec: Rec): Rec | null {
  const a = rec_cost(prev), b = rec_cost(rec), pm = prev["model_usage"], rm = rec["model_usage"];
  if (a === null || b === null || b < a) return null;
  if (b > a && num(rec["output_tokens"]) === 0) return null; // dollars with no output of its own cannot be attributed to this call: ambiguous
  const isMap = (m: unknown): m is Record<string, Record<string, unknown>> => typeof m === "object" && m !== null && !Array.isArray(m);
  if (!isMap(pm) || !isMap(rm) || typeof rec["output_tokens"] !== "number") return null;
  const outSum = (m: Record<string, Record<string, unknown>>): number => Object.values(m).reduce((t, v) => t + num(v?.["output_tokens"]), 0);
  if (outSum(rm) !== outSum(pm) + num(rec["output_tokens"])) return null;
  const mu: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(rm)) {
    const p0 = pm[k] ?? {}, d: Record<string, unknown> = { ...v };
    for (const f of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"]) d[f] = Math.max(0, num(v[f]) - num(p0[f]));
    mu[k] = d;
  }
  return { ...rec, total_cost_usd: b - a, model_usage: mu };
}
const rec_cost = (r: Rec): number | null => (typeof r["total_cost_usd"] === "number" && Number.isFinite(r["total_cost_usd"]) ? r["total_cost_usd"] : null);

/** `recs` are the non-ambiguous parsed files; `expected` is the number of sessions in the run. Every aggregate below needs all of
 *  them, so a missing or ambiguous session leaves per_model, turns and the cache split out (NOT RECORDED), never a partial sum. */
export function buildRecords(recs: { iter: string; rec: Rec }[], expected: number, ambiguous: string[], separate: string[], delta: string[] = []): CostRecords {
  const out: CostRecords = {};
  if (ambiguous.length > 0) out.resume = "ambiguous"; else if (separate.length > 0) out.resume = "separate"; else if (delta.length > 0) out.resume = "delta";
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
