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

/** TEN-COST-28: per-stage share of spend from the run's cost events, for the cost summary. Shares cover the metered stages and sum to
 *  exactly 100 (largest remainder); a stage with an unpriced or unmetered session says "unmetered", never 0. null when nothing was metered
 *  or only one stage exists (a share of 100% says nothing). */
export function stageShareText(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const shares = shareLine(events), hints = [cacheColdText(events), cacheTtlText(events)].filter((h): h is string => h !== null);
  return [...(shares ? [shares] : []), ...hints].join(`\n${" ".repeat(12)}`) || null; // 12 = output.ts LABEL_WIDTH: the hints line up under the Spend value
}
function shareLine(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const order: string[] = [], usd = new Map<string, number>(), unmetered = new Set<string>();
  for (const e of events) {
    if (e.type !== "cost") continue;
    const stage = e.stage || UNATTRIBUTED;
    if (!usd.has(stage)) { order.push(stage); usd.set(stage, 0); }
    if (validUsd(e.data["usd"]) && e.data["source"] !== "cli-invoker-unmetered") usd.set(stage, usd.get(stage)! + e.data["usd"]);
    else unmetered.add(stage);
  }
  const metered = order.filter((s) => !unmetered.has(s) && usd.get(s)! > 0);
  const total = metered.reduce((a, s) => a + usd.get(s)!, 0);
  if (order.length < 2 || total <= 0) return null;
  const raw = metered.map((s) => (usd.get(s)! / total) * 100), pct = raw.map(Math.floor);
  let left = 100 - pct.reduce((a, b) => a + b, 0);
  [...raw.keys()].sort((a, b) => (raw[b]! - pct[b]!) - (raw[a]! - pct[a]!) || a - b).forEach((i) => { if (left-- > 0) pct[i]!++; });
  const top = metered.reduce((a, s) => (usd.get(s)! > usd.get(a)! ? s : a), metered[0]!);
  const parts = order.map((s) => { const i = metered.indexOf(s); return i >= 0 ? `${s} ${pct[i]}%` : `${s} unmetered`; });
  return `${parts.join(", ")}; top: ${top}`;
}

/** TEN-COST-29: stages whose prefix cache ran cold (cache read under 30 percent of input-side tokens) as one "cache cold: a, b" line, for the
 *  cost summary. Only metered sessions with token figures count; an unmetered or token-less stage is skipped, never called cold. A cold stage
 *  whose calls carry differing `prefix_sha` values (the hash of the brief's leading block, emitted by engine10/session.ts) is suffixed
 *  "(prefix changed)": the cache key moved between its calls. Without the hash the cause is not named. null when all warm. */
function cacheColdText(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const order: string[] = [], read = new Map<string, number>(), all = new Map<string, number>(), shas = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== "cost" || e.data["source"] === "cli-invoker-unmetered" || typeof e.data["input_tokens"] !== "number") continue;
    const stage = e.stage || UNATTRIBUTED;
    if (!all.has(stage)) { order.push(stage); read.set(stage, 0); all.set(stage, 0); shas.set(stage, new Set()); }
    const r = Math.max(0, tok(e.data["cache_read_tokens"]));
    read.set(stage, read.get(stage)! + r);
    all.set(stage, all.get(stage)! + Math.max(0, tok(e.data["input_tokens"])) + r + Math.max(0, tok(e.data["cache_creation_tokens"])));
    if (typeof e.data["prefix_sha"] === "string") shas.get(stage)!.add(e.data["prefix_sha"]);
  }
  const cold = order.filter((s) => all.get(s)! > 0 && read.get(s)! / all.get(s)! < 0.3).map((s) => (shas.get(s)!.size > 1 ? `${s} (prefix changed)` : s));
  return cold.length > 0 ? `cache cold: ${cold.join(", ")}` : null;
}

const CACHE_TTL_5M_MS = 5 * 60_000;
/** Measured inter-call gap per stage (median of consecutive same-stage cost event times). A stage whose median gap exceeds the 5 minute cache
 *  TTL cannot hit a 5m cache, so the line names it and the opt-in that fits: "cache ttl: a (median gap 7m); LOKI_E10_CACHE_TTL=1h". The 5m
 *  default stays in engine10CacheTtlEnv (runner/providers.ts), the one TTL switch. null when no stage has two timed calls over the TTL. */
function cacheTtlText(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const last = new Map<string, number>(), gaps = new Map<string, number[]>(), order: string[] = [];
  for (const e of events) {
    const t = e.type === "cost" && e.ts ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(t)) continue;
    const stage = e.stage || UNATTRIBUTED;
    if (last.has(stage)) { if (!gaps.has(stage)) { gaps.set(stage, []); order.push(stage); } gaps.get(stage)!.push(t - last.get(stage)!); }
    last.set(stage, t);
  }
  const med = (g: number[]): number => { const a = [...g].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; };
  const slow = order.filter((s) => med(gaps.get(s)!) > CACHE_TTL_5M_MS);
  return slow.length > 0 ? `cache ttl: ${slow.map((s) => `${s} (median gap ${Math.round(med(gaps.get(s)!) / 60_000)}m)`).join(", ")}; LOKI_E10_CACHE_TTL=1h` : null;
}
