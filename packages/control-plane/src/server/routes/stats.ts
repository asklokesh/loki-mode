// GET /v1/stats?since=<ISO>: counts, verified rate, cost (measured and partial kept apart) and the receipts count, folded from the runs projection and stored events.
// An unpriced run is never summed as zero: its known part is reported as partial, and a window with nothing priced reads null.
// GET /v1/stats/outcomes?since=<ISO>&repo=<origin>: L002 outcome metrics (sessions, fix rounds, escalations, cache-read share, cost per VERIFIED run,
// first-pass rate, wall time percentiles), for the window and per repo. `loki stats --outcomes` computes the same numbers from local runs through computeOutcomes.
import { eq } from "drizzle-orm";
import type { Db } from "../../db/migrate.ts";
import { events, runs } from "../../db/schema.ts";
import { effectiveVerdict, pubkeysFromEnv } from "../integrity.ts";
import type { Hono } from "hono";

export interface Stats {
  since: string | null;
  runs_total: number;
  runs_finished: number;
  runs_running: number;
  by_verdict: Record<string, number>;
  blocked_waiting: number;
  /** Plain VERIFIED (attested, signature-checked) over the VERIFIABLE finished outcomes (verified, signature-unchecked verified, failed); ALREADY_SATISFIED and other outcomes are not in the denominator. Null when there are none. */
  verified_rate: number | null;
  /** Finished runs by outcome class: verified (checked), failed (FAILED, PARTIAL, TAMPERED), already_satisfied (either signature state), other (SPEC_CONFLICT, UNVERIFIED, unattested, anything else). Unchecked verified runs are in verified_unchecked. */
  breakdown: { verified: number; failed: number; already_satisfied: number; other: number };
  /** Finished successes whose signature could not be checked (VERIFIED (signature not checked)); a rate of 0 with these is "not measured", not "failing". */
  verified_unchecked: number;
  /** At least one receipt verification key is configured (the local signer key or LOKI_CP_RECEIPT_PUBKEYS). */
  keys_configured: boolean;
  /** Present when a named local signing key could not be used (unreadable, malformed, not Ed25519); keys_configured then reflects the remaining keys. */
  keys_reason?: string;
  cost: {
    /** Sum over runs whose cost is fully measured; null when no run in the window is. */
    measured_usd: number | null;
    measured_runs: number;
    /** Sum of the known part of runs with an unpriced session (a lower bound); null when there are none. */
    partial_usd: number | null;
    partial_runs: number;
    label: "measured" | "partial" | "not measured";
  };
  receipts: { total: number; signed: number };
}

type Run = typeof runs.$inferSelect;
/** The run fields the outcome metrics read: a stored runs row, or runs.ts projectRun over a local events.jsonl (loki stats --outcomes). */
export type OutcomeRow = Pick<Run, "originRepo" | "startedAt" | "endedAt" | "verdict" | "tampered" | "attested" | "sigChecked" | "costUsd" | "totalSessions" | "fixRounds" | "escalations" | "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "wallS" | "size">;
type VerdictFields = Pick<Run, "verdict" | "tampered" | "attested" | "sigChecked">;

/** FC-08 effective verdict: a tampered log reads TAMPERED, an unattested or unchecked success is never counted as plain VERIFIED (L3, L7). */
const displayVerdict = (r: VerdictFields): string | null =>
  r.verdict ? effectiveVerdict({ verdict: r.verdict, tampered: r.tampered === 1, attested: r.attested === 1, sig_checked: r.sigChecked === 1 }) : null;
export type OutcomeClass = "verified" | "unchecked" | "satisfied" | "failed" | "other";
/** The one outcome classifier: verified = plain VERIFIED (attested, signature-checked); unchecked = VERIFIED (signature not checked); satisfied = ALREADY_SATISFIED in either
 *  signature state; failed = FAILED, PARTIAL, TAMPERED; other = SPEC_CONFLICT, UNVERIFIED, unattested and anything else. Null when the run has no verdict. */
export function outcomeClass(r: VerdictFields): OutcomeClass | null {
  const v = displayVerdict(r);
  if (v === null) return null;
  if (v === "VERIFIED") return "verified";
  if (v === "VERIFIED (signature not checked)") return "unchecked";
  if (v === "ALREADY_SATISFIED" || v === "ALREADY_SATISFIED (signature not checked)") return "satisfied";
  if (v === "FAILED" || v === "PARTIAL" || v === "TAMPERED") return "failed";
  return "other";
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function computeStats(db: Db, since: string | null): Stats {
  const all = db.select().from(runs).all().filter((r) => !since || (r.startedAt !== null && r.startedAt >= since));
  const by: Record<string, number> = {};
  let finished = 0, running = 0, blocked = 0, verified = 0, unchecked = 0, failed = 0, satisfied = 0, other = 0;
  let mUsd = 0, mRuns = 0, pUsd = 0, pRuns = 0;
  for (const r of all) {
    if (r.endedAt) finished++; else running++;
    const verdict = displayVerdict(r);
    if (verdict) {
      by[verdict] = (by[verdict] ?? 0) + 1;
      const k = r.endedAt ? outcomeClass(r) : null;
      if (k === "verified") verified++;
      else if (k === "unchecked") unchecked++;
      else if (k === "satisfied") satisfied++;
      else if (k === "failed") failed++;
      else if (k === "other") other++;
    }
    if (r.verdict === "SPEC_CONFLICT") blocked++;
    if (r.costUsd !== null) { mUsd += r.costUsd; mRuns++; }
    else if (r.totalSessions > 0) { pUsd += r.partialUsd; pRuns++; }
  }
  const keys = new Set(all.map((r) => `${r.sourceId}/${r.runId}`));
  let total = 0, signed = 0;
  for (const e of db.select({ s: events.sourceId, r: events.runId, data: events.data }).from(events).where(eq(events.type, "receipt.sealed")).all()) {
    if (!keys.has(`${e.s}/${e.r}`)) continue;
    total++;
    if ((e.data as { signed?: unknown } | null)?.signed === true) signed++;
  }
  return {
    since, runs_total: all.length, runs_finished: finished, runs_running: running, by_verdict: by, blocked_waiting: blocked,
    verified_rate: verified + unchecked + failed ? verified / (verified + unchecked + failed) : null,
    breakdown: { verified, failed, already_satisfied: satisfied, other }, verified_unchecked: unchecked, keys_configured: pubkeysFromEnv().configured === true, ...(pubkeysFromEnv().reason ? { keys_reason: pubkeysFromEnv().reason } : {}),
    cost: {
      measured_usd: mRuns ? r6(mUsd) : null, measured_runs: mRuns, partial_usd: pRuns ? r6(pUsd) : null, partial_runs: pRuns,
      label: pRuns ? "partial" : mRuns ? "measured" : "not measured",
    },
    receipts: { total, signed },
  };
}

// ---- L002 outcome metrics ----
// Definitions are shared with benchmarks/h2h/h2h.py where they overlap: sessions = cost events in the run's events.jsonl (h2h loki_metrics priced + unpriced; the
// child-session ledger is not in events.jsonl), p50 = the median (h2h statistics.median), every other percentile = h2h pct(). Every value carries its n, and
// n = 0 reads "not measured" with a null value.

/** h2h.py pct(): the sorted value at index round(q * (n - 1)), with Python's round half to even. Null for no values. */
export function pct(vals: readonly number[], q: number): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b), x = q * (s.length - 1), f = Math.floor(x), d = x - f;
  const k = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return s[Math.max(0, Math.min(s.length - 1, k))]!;
}
/** h2h.py statistics.median: the middle value, or the mean of the two middle values. Null for no values. */
export function median(vals: readonly number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : r6((s[m - 1]! + s[m]!) / 2);
}

export type Label = "measured" | "not measured";
const label = (n: number): Label => (n > 0 ? "measured" : "not measured");
export type Percentiles<K extends string> = { [P in "p50" | K]: number | null } & { n: number; label: Label };
const spread = <K extends string>(vals: number[], hi: K, q: number): Percentiles<K> =>
  ({ p50: median(vals), [hi]: pct(vals, q), n: vals.length, label: label(vals.length) }) as Percentiles<K>;
export interface Count { total: number; mean: number | null; n: number; label: Label }
const count = (vals: number[]): Count => {
  const t = vals.reduce((a, b) => a + b, 0);
  return { total: t, mean: vals.length ? r6(t / vals.length) : null, n: vals.length, label: label(vals.length) };
};

export interface CostPerVerified {
  /** Spend of finished priced runs divided by the plain VERIFIED runs among them. ALREADY_SATISFIED and signature-unchecked successes are not successes here. Null when n = 0. */
  value: number | null;
  /** The denominator: finished, priced, plain VERIFIED runs. */
  n: number;
  label: Label;
  /** Sum of cost_usd over finished, priced (every session priced), non-tampered runs, whatever their verdict; null when none is priced. */
  spend_usd: number | null;
  priced_runs: number;
  /** Finished non-tampered runs without a full price (subscription, local provider or an unpriced session): left out of both sides. */
  unpriced_runs: number;
  /** Every finished plain VERIFIED run, priced or not. */
  verified_runs: number;
}
/** THE cost per VERIFIED run. /v1/stats/outcomes, /v1/cost/repos and `loki stats --outcomes` all read it; nothing else divides spend by verified runs. */
export function costPerVerified(rows: readonly OutcomeRow[]): CostPerVerified {
  let spend = 0, priced = 0, unpriced = 0, verified = 0, pricedVerified = 0;
  for (const r of rows) {
    if (!r.endedAt || r.tampered === 1) continue; // a tampered log reports no trusted dollars (engine10 partialCost)
    const ok = outcomeClass(r) === "verified";
    if (ok) verified++;
    if (r.costUsd === null) { unpriced++; continue; }
    priced++; spend += r.costUsd;
    if (ok) pricedVerified++;
  }
  return { value: pricedVerified ? r6(spend / pricedVerified) : null, n: pricedVerified, label: label(pricedVerified), spend_usd: priced ? r6(spend) : null, priced_runs: priced, unpriced_runs: unpriced, verified_runs: verified };
}

/** cache_read / (input + cache_read + cache_creation) for one run; null when it recorded no input tokens. */
export const cacheReadShare = (r: Pick<Run, "inputTokens" | "cacheReadTokens" | "cacheCreationTokens">): number | null => {
  const d = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
  return d > 0 ? r6(r.cacheReadTokens / d) : null;
};

export interface Outcomes {
  runs_finished: number;
  /** Finished runs whose log failed integrity: counted as failures in first_pass_rate, left out of every per-run count (their numbers are untrusted). */
  runs_tampered: number;
  sessions: Percentiles<"p90">;
  fix_rounds: Count;
  escalations: Count;
  cache_read_share: { value: number | null; n: number; label: Label; cache_read_tokens: number; input_tokens_total: number };
  cost_per_verified_usd: CostPerVerified;
  first_pass_rate: { value: number | null; n: number; label: Label; first_pass_runs: number };
  wall_s: { all: Percentiles<"p95">; by_size: Record<string, Percentiles<"p95">> };
}

export const OUTCOME_DEFINITIONS = {
  sessions: "cost events per finished run (h2h sessions); p50 is the median, p90 is h2h pct()",
  fix_rounds: "fix.round events per finished run",
  escalations: "escalated plus route.escalated events per finished run",
  cache_read_share: "cache_read_tokens over input + cache_read + cache_creation tokens, summed over finished runs that recorded input tokens",
  cost_per_verified_usd: "spend of finished priced runs over the plain VERIFIED runs among them; ALREADY_SATISFIED is not a success here",
  first_pass_rate: "plain VERIFIED runs with 0 fix rounds over finished verifiable runs (VERIFIED, VERIFIED signature not checked, FAILED, PARTIAL, TAMPERED)",
  wall_s: "run.completed wall_s of finished runs: p50 (median) and p95 (h2h pct()), overall and by the plan stage's task size",
  n: "every value carries its n; n = 0 reads not measured and the value is null",
} as const;

/** Outcome metrics over the given runs. Running runs are left out; a tampered run counts only as a failure. */
export function computeOutcomes(rows: readonly OutcomeRow[]): Outcomes {
  const fin = rows.filter((r) => r.endedAt);
  const ok = fin.filter((r) => r.tampered !== 1);
  let fp = 0, verifiable = 0, cr = 0, tot = 0, crN = 0;
  for (const r of fin) {
    const k = outcomeClass(r);
    if (k === "verified" || k === "unchecked" || k === "failed") verifiable++;
    if (k === "verified" && r.fixRounds === 0) fp++;
  }
  for (const r of ok) {
    const d = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
    if (d > 0) { cr += r.cacheReadTokens; tot += d; crN++; }
  }
  const walled = ok.filter((r) => r.wallS !== null);
  const sizeOf = (r: OutcomeRow): string => r.size ?? "unknown";
  const sizes = [...new Set(walled.map(sizeOf))].sort();
  return {
    runs_finished: fin.length, runs_tampered: fin.length - ok.length,
    sessions: spread(ok.map((r) => r.totalSessions), "p90", 0.9),
    fix_rounds: count(ok.map((r) => r.fixRounds)),
    escalations: count(ok.map((r) => r.escalations)),
    cache_read_share: { value: crN ? r6(cr / tot) : null, n: crN, label: label(crN), cache_read_tokens: cr, input_tokens_total: tot },
    cost_per_verified_usd: costPerVerified(rows),
    first_pass_rate: { value: verifiable ? r6(fp / verifiable) : null, n: verifiable, label: label(verifiable), first_pass_runs: fp },
    wall_s: {
      all: spread(walled.map((r) => r.wallS!), "p95", 0.95),
      by_size: Object.fromEntries(sizes.map((z) => [z, spread(walled.filter((r) => sizeOf(r) === z).map((r) => r.wallS!), "p95", 0.95)])),
    },
  };
}

/** The whole set plus one block per repo (origin_repo; "(unknown)" when the run recorded none, as /v1/cost/repos keys it) and the field definitions. */
export function outcomesReport(rows: readonly OutcomeRow[]) {
  const byRepo = new Map<string, OutcomeRow[]>();
  for (const r of rows) { const k = r.originRepo ?? "(unknown)"; byRepo.set(k, [...(byRepo.get(k) ?? []), r]); }
  return { ...computeOutcomes(rows), by_repo: Object.fromEntries([...byRepo.keys()].sort().map((k) => [k, computeOutcomes(byRepo.get(k)!)])), definitions: OUTCOME_DEFINITIONS };
}

const badSince = (s: string): boolean => !/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(Date.parse(s));

// Typed by the two fields it reads (not RouteCtx) so `loki stats --outcomes` can import this file without type-checking the whole route registry.
export function mount(ctx: { app: Hono; db: Db }): void {
  ctx.app.get("/v1/stats", (c) => {
    const since = c.req.query("since") ?? null;
    if (since !== null && badSince(since)) return c.json({ error: "since must be an ISO date or timestamp" }, 400);
    return c.json(computeStats(ctx.db, since === null ? null : new Date(since).toISOString()));
  });
  ctx.app.get("/v1/stats/outcomes", (c) => {
    const since = c.req.query("since") ?? null, repo = c.req.query("repo") ?? null;
    if (since !== null && badSince(since)) return c.json({ error: "since must be an ISO date or timestamp" }, 400);
    const iso = since === null ? null : new Date(since).toISOString();
    const rows = ctx.db.select().from(runs).all().filter((r) => (!iso || (r.startedAt !== null && r.startedAt >= iso)) && (repo === null || (r.originRepo ?? "(unknown)") === repo));
    return c.json({ since: iso, repo, ...outcomesReport(rows) });
  });
}
