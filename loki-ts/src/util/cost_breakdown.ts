// loki-ts/src/util/cost_breakdown.ts
//
// P12-21 (E03): per-stage and retry attribution over the same result-cost records sumResultCosts reads.
// Logic lives here because engine10/cost.ts is at the core line cap. Fails closed: a record whose dollar figure is
// missing, non-finite, negative or all-zero-usage (E-69, same rule as sumResultCosts) makes its stage's usd (and the total) null, never a silent 0.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  savings_usd: number | null; // #409: same tokens at the top Claude tier minus actual usd; null when any session's dollars or tokens are unmeasured
}

type Rate = { input: number; output: number; read: number; write: number };
let topRate: Rate | null | undefined;
/** #409: the top Claude tier's per-MTok rates, derived from data/model-pricing.json (highest output rate among non-gpt rows), never a hardcoded id.
 *  null when the table is unreadable: savings then reads "not measured". */
export function topTierRate(): Rate | null {
  if (topRate !== undefined) return topRate;
  topRate = null;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [["..", "..", "data"], ["..", "data"]]) {
    try {
      const rows = (JSON.parse(readFileSync(resolve(here, ...rel, "model-pricing.json"), "utf8")) as { pricing?: Record<string, Record<string, unknown>> }).pricing ?? {};
      let best: Rate | null = null;
      for (const [k, v] of Object.entries(rows)) {
        const n = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
        if (k.startsWith("gpt-") || !n(v["input"]) || !n(v["output"])) continue;
        if (!best || v["output"] > best.output) best = { input: v["input"], output: v["output"], read: n(v["cache_read"]) ? v["cache_read"] : v["input"], write: n(v["cache_write_5m"]) ? v["cache_write_5m"] : n(v["cache_write"]) ? v["cache_write"] : v["input"] };
      }
      if (best) return (topRate = best);
    } catch { /* try next location */ }
  }
  return topRate;
}
const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"] as const;
/** Savings = cost of every session's tokens at the top tier minus the actual dollars. null (never 0) when any session lacks a valid dollar figure
 *  or any of the four token counts, or the pricing table gives no top tier. Rounded to 4 places. */
export function savingsUsd(rows: { usd: unknown; tokens: Record<string, unknown>; unmetered?: boolean }[]): number | null {
  const r = topTierRate();
  if (!r || rows.length === 0) return null;
  let actual = 0, cf = 0;
  for (const { usd, tokens, unmetered } of rows) {
    if (unmetered || !validUsd(usd) || TOKEN_KEYS.some((k) => typeof tokens[k] !== "number" || !Number.isFinite(tokens[k]) || (tokens[k] as number) < 0)) return null;
    const t = (k: (typeof TOKEN_KEYS)[number]): number => tokens[k] as number;
    actual += usd;
    cf += (t("input_tokens") * r.input + t("output_tokens") * r.output + t("cache_read_tokens") * r.read + t("cache_creation_tokens") * r.write) / 1_000_000;
  }
  return Math.round((cf - actual) * 1e4) / 1e4;
}

/** #306: the components of the cached prefix. prefixParts hashes each one; prefixSha is the hash of all of them, so a change to ANY component moves it
 *  and cacheColdText can name which one moved. Add a component here and it is covered everywhere (emit, key, label). */
export const PREFIX_COMPONENTS = ["system", "tools", "thinking", "effort", "brief"] as const;
export type PrefixComponent = (typeof PREFIX_COMPONENTS)[number];
export type PrefixParts = Record<PrefixComponent, string>;
const h12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
export const prefixParts = (i: { system?: string; tools: readonly string[]; thinking?: string; effort?: string; brief: string }): PrefixParts => ({
  system: h12(i.system ?? ""), tools: h12(i.tools.join(",")), thinking: h12(i.thinking ?? ""), effort: h12(i.effort ?? ""), brief: h12(i.brief.slice(0, 2048)),
});
/** Hash of every prefix component. cacheColdText compares it across a stage's calls to name a changed prefix. */
export const prefixSha = (parts: PrefixParts): string => h12(PREFIX_COMPONENTS.map((c) => `${c}=${parts[c]}`).join(";"));
const UNATTRIBUTED = "unattributed";
const validUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const tok = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
// E-69: a dollar figure with all-zero usage is a session that never ran (unless explicitly unmetered), so unknown, not $0
const noUsage = (r: Record<string, unknown>): boolean => r["source"] !== "cli-invoker-unmetered" && ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"].every((k) => tok(r[k]) === 0);
const isRetry = (r: Record<string, unknown>): boolean => r["retry"] === true || (typeof r["attempt"] === "number" && r["attempt"] > 1);
const add = (a: number | null, c: number | null): number | null => (a === null || c === null ? null : a + c);

/** `missing` are the run's iterations without a usable dollar figure (absent file, ambiguous resume): any one makes every total unknown. */
export function costBreakdown(recs: { iter: string; rec: Record<string, unknown> }[], missing: string[] = []): CostBreakdown {
  const out: CostBreakdown = { usd: missing.length > 0 ? null : 0, per_stage: {}, retry_usd: missing.length > 0 ? null : 0, retry_sessions: 0, savings_usd: null };
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
  if (missing.length === 0) out.savings_usd = savingsUsd(recs.map(({ rec }) => ({ usd: validUsd(rec["total_cost_usd"]) && !noUsage(rec) ? rec["total_cost_usd"] : null, tokens: rec, unmetered: rec["source"] === "cli-invoker-unmetered" })));
  return out;
}

/** TEN-COST-28: per-stage share of spend from the run's cost events, for the cost summary. Shares cover the metered stages and sum to
 *  exactly 100 (largest remainder); a stage with an unpriced or unmetered session says "unmetered", never 0. null when nothing was metered
 *  or only one stage exists (a share of 100% says nothing). */
export function stageShareText(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const line = shareLine(events), shares = line && `${line}; ${savingsText(events)}`, hints = [cacheColdText(events), cacheTtlText(events)].filter((h): h is string => h !== null);
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

/** #409: "saved $X vs top tier" (or "cost $X more than top tier" when negative, "no difference vs top tier" when it rounds to 0.00) from the cost events, or "savings not measured" when any session is unmetered or lacks tokens. Same math as CostBreakdown.savings_usd. */
function savingsText(events: { type: string; data: Record<string, unknown> }[]): string {
  const v = savingsUsd(events.filter((e) => e.type === "cost").map((e) => ({ usd: e.data["usd"], tokens: e.data, unmetered: e.data["source"] === "cli-invoker-unmetered" })));
  if (v === null) return "savings not measured";
  const r = Number(v.toFixed(2));
  if (r > 0) return `saved $${r.toFixed(2)} vs top tier`;
  return r < 0 ? `cost $${(-r).toFixed(2)} more than top tier` : "no difference vs top tier";
}

/** TEN-COST-29: stages whose prefix cache ran cold (cache read under 30 percent of input-side tokens) as one "cache cold: a, b" line, for the
 *  cost summary. Only metered sessions with token figures count; an unmetered or token-less stage is skipped, never called cold. A cold stage
 *  whose calls carry differing `prefix_sha` values (the hash of every prefix component, emitted by engine10/session.ts) is suffixed
 *  "(prefix changed: tools, effort)", naming the components whose `prefix_parts` differ between its calls (bare "(prefix changed)" when the events carry no parts). Without the hash the cause is not named. null when all warm. */
function cacheColdText(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const order: string[] = [], read = new Map<string, number>(), all = new Map<string, number>(), shas = new Map<string, Set<string>>(), parts = new Map<string, Record<string, Set<string>>>();
  for (const e of events) {
    if (e.type !== "cost" || e.data["source"] === "cli-invoker-unmetered" || typeof e.data["input_tokens"] !== "number") continue;
    const stage = e.stage || UNATTRIBUTED;
    if (!all.has(stage)) { order.push(stage); read.set(stage, 0); all.set(stage, 0); shas.set(stage, new Set()); }
    const r = Math.max(0, tok(e.data["cache_read_tokens"]));
    read.set(stage, read.get(stage)! + r);
    all.set(stage, all.get(stage)! + Math.max(0, tok(e.data["input_tokens"])) + r + Math.max(0, tok(e.data["cache_creation_tokens"])));
    if (typeof e.data["prefix_sha"] === "string") shas.get(stage)!.add(e.data["prefix_sha"]);
    const pp = e.data["prefix_parts"];
    if (pp && typeof pp === "object") {
      const m = parts.get(stage) ?? {}; parts.set(stage, m);
      for (const c of PREFIX_COMPONENTS) { const v = (pp as Record<string, unknown>)[c]; if (typeof v === "string") (m[c] ??= new Set()).add(v); }
    }
  }
  const changed = (s: string): string => { const m = parts.get(s) ?? {}, names = PREFIX_COMPONENTS.filter((c) => (m[c]?.size ?? 0) > 1); return names.length > 0 ? `: ${names.join(", ")}` : ""; };
  const cold = order.filter((s) => all.get(s)! > 0 && read.get(s)! / all.get(s)! < 0.3).map((s) => (shas.get(s)!.size > 1 ? `${s} (prefix changed${changed(s)})` : s));
  return cold.length > 0 ? `cache cold: ${cold.join(", ")}` : null;
}

export const CACHE_TTL_5M_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;
/** Idle time between two same-stage sessions: this session's start (end minus its own runtime) minus the previous session's end. Never negative. */
export const idleGapMs = (endedAtMs: number, durationMs: number, prevEndedAtMs: number): number => Math.max(0, (endedAtMs - durationMs) - prevEndedAtMs);
/** The one TTL rule: 1h only when the median idle gap is over 5m (a 5m cache expires between calls) and under 60m (past that neither TTL hits). */
export const cacheTtlFor = (medianIdleGapMs: number): "5m" | "1h" => (medianIdleGapMs > CACHE_TTL_5M_MS && medianIdleGapMs < CACHE_TTL_1H_MS ? "1h" : "5m");
export const median = (g: number[]): number => { const a = [...g].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; };
/** Measured idle gap per stage (median of idleGapMs over consecutive same-stage cost events; events without duration_ms are skipped). A stage whose
 *  median idle gap is between the 5 minute and 1 hour cache TTLs (cacheTtlFor) cannot hit a 5m cache, so the line names it and the opt-in that fits: "cache ttl: a (median gap 7m); LOKI_E10_CACHE_TTL=1h". The 5m
 *  default stays in engine10CacheTtlEnv (runner/providers.ts), the one TTL switch, which reads the persisted per-stage gaps (provider_cost.stageMedianGapMs). null when no stage has two timed calls over the TTL. */
function cacheTtlText(events: { type: string; stage: string | null; ts?: string; data: Record<string, unknown> }[]): string | null {
  const last = new Map<string, number>(), gaps = new Map<string, number[]>(), order: string[] = [];
  for (const e of events) {
    const t = e.type === "cost" && e.ts ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(t)) continue;
    const stage = e.stage || UNATTRIBUTED, dur = e.data["duration_ms"];
    if (last.has(stage) && typeof dur === "number" && Number.isFinite(dur)) { if (!gaps.has(stage)) { gaps.set(stage, []); order.push(stage); } gaps.get(stage)!.push(idleGapMs(t, dur, last.get(stage)!)); }
    last.set(stage, t);
  }
  const slow = order.filter((s) => cacheTtlFor(median(gaps.get(s)!)) === "1h");
  return slow.length > 0 ? `cache ttl: ${slow.map((s) => `${s} (median gap ${Math.round(median(gaps.get(s)!) / 60_000)}m)`).join(", ")}; LOKI_E10_CACHE_TTL=1h` : null;
}
