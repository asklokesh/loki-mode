// loki-ts/src/util/cost_breakdown.ts
//
// P12-21 (E03): per-stage, retry and cache attribution over the same result-cost records sumResultCosts reads.
// Logic lives here because engine10/cost.ts is at the core line cap. Fails closed: a record whose dollar figure is
// missing, non-finite or negative makes its stage's usd (and the total) null, never a silent 0.
export interface StageCost { usd: number | null; sessions: number }
export interface CostBreakdown {
  usd: number | null; // sum of per_stage usd; null when any session's dollars are unknown
  per_stage: Record<string, StageCost>;
  retry_usd: number | null; // dollars spent in retry sessions (a subset of usd, not added on top)
  retry_sessions: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

const UNATTRIBUTED = "unattributed";
const validUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const tok = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const isRetry = (r: Record<string, unknown>): boolean => r["retry"] === true || (typeof r["attempt"] === "number" && r["attempt"] > 1);
const add = (a: number | null, c: number | null): number | null => (a === null || c === null ? null : a + c);

export function costBreakdown(recs: { iter: string; rec: Record<string, unknown> }[]): CostBreakdown {
  const out: CostBreakdown = { usd: 0, per_stage: {}, retry_usd: 0, retry_sessions: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  for (const { rec } of recs) {
    const stage = typeof rec["stage"] === "string" && rec["stage"] ? rec["stage"] : UNATTRIBUTED;
    const s = (out.per_stage[stage] ??= { usd: 0, sessions: 0 });
    const c = validUsd(rec["total_cost_usd"]) ? rec["total_cost_usd"] : null;
    s.sessions++;
    s.usd = add(s.usd, c);
    out.usd = add(out.usd, c);
    if (isRetry(rec)) {
      out.retry_sessions++;
      out.retry_usd = add(out.retry_usd, c);
    }
    out.cache_read_tokens += tok(rec["cache_read_tokens"]);
    out.cache_creation_tokens += tok(rec["cache_creation_tokens"]);
  }
  return out;
}
