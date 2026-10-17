// loki-ts/src/util/cost_breakdown.ts
//
// P12-21 (E03): per-stage and retry attribution over the same result-cost records sumResultCosts reads.
// Logic lives here because engine10/cost.ts is at the core line cap. Fails closed: a record whose dollar figure is
// missing, non-finite, negative or all-zero-usage (E-69, same rule as sumResultCosts) makes its stage's usd (and the total) null, never a silent 0.
export interface StageCost {
  usd: number | null;
  sessions: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_hit_ratio: number | null; // read / (read + creation); null when both are 0, never 0
}
export interface CostBreakdown {
  usd: number | null; // sum of per_stage usd; null when any session's dollars are unknown
  per_stage: Record<string, StageCost>;
  retry_usd: number | null; // dollars spent in retry sessions (a subset of usd, not added on top)
  retry_sessions: number;
}

const UNATTRIBUTED = "unattributed";
const validUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const tok = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
// E-69: a dollar figure with all-zero usage is a session that never ran (unless explicitly unmetered), so unknown, not $0
const noUsage = (r: Record<string, unknown>): boolean => r["source"] !== "cli-invoker-unmetered" && ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"].every((k) => tok(r[k]) === 0);
const isRetry = (r: Record<string, unknown>): boolean => r["retry"] === true || (typeof r["attempt"] === "number" && r["attempt"] > 1);
const add = (a: number | null, c: number | null): number | null => (a === null || c === null ? null : a + c);

/** `missing` are the run's iterations without a usable dollar figure (absent file, ambiguous resume): any one makes every total unknown. */
export function costBreakdown(recs: { iter: string; rec: Record<string, unknown> }[], missing: string[] = []): CostBreakdown {
  const out: CostBreakdown = { usd: missing.length > 0 ? null : 0, per_stage: {}, retry_usd: missing.length > 0 ? null : 0, retry_sessions: 0 };
  for (const { rec } of recs) {
    const stage = typeof rec["stage"] === "string" && rec["stage"] ? rec["stage"] : UNATTRIBUTED;
    const s = (out.per_stage[stage] ??= { usd: 0, sessions: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cache_hit_ratio: null });
    const c = validUsd(rec["total_cost_usd"]) && !noUsage(rec) ? rec["total_cost_usd"] : null;
    s.sessions++;
    s.cache_read_tokens += Math.max(0, tok(rec["cache_read_tokens"]));
    s.cache_creation_tokens += Math.max(0, tok(rec["cache_creation_tokens"]));
    const cacheTotal = s.cache_read_tokens + s.cache_creation_tokens;
    s.cache_hit_ratio = cacheTotal > 0 ? s.cache_read_tokens / cacheTotal : null;
    s.usd = add(s.usd, c);
    out.usd = add(out.usd, c);
    if (isRetry(rec)) {
      out.retry_sessions++;
      out.retry_usd = add(out.retry_usd, c);
    }
  }
  return out;
}
