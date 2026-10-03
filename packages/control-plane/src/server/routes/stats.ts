// GET /v1/stats?since=<ISO>: counts, verified rate, cost (measured and partial kept apart) and the receipts count, folded from the runs projection and stored events.
// An unpriced run is never summed as zero: its known part is reported as partial, and a window with nothing priced reads null.
import { eq } from "drizzle-orm";
import type { Db } from "../../db/migrate.ts";
import { events, runs } from "../../db/schema.ts";
import { effectiveVerdict, pubkeysFromEnv } from "../integrity.ts";
import type { RouteCtx } from "./index.ts";

export interface Stats {
  since: string | null;
  runs_total: number;
  runs_finished: number;
  runs_running: number;
  by_verdict: Record<string, number>;
  blocked_waiting: number;
  /** Plain VERIFIED (attested, signature-checked) over finished runs that carry a verdict; null when there are none. */
  verified_rate: number | null;
  /** Finished successes whose signature could not be checked (VERIFIED (signature not checked)); a rate of 0 with these is "not measured", not "failing". */
  verified_unchecked: number;
  /** At least one receipt verification key is configured (LOKI_CP_RECEIPT_PUBKEYS). */
  keys_configured: boolean;
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

export function computeStats(db: Db, since: string | null): Stats {
  const all = db.select().from(runs).all().filter((r) => !since || (r.startedAt !== null && r.startedAt >= since));
  const by: Record<string, number> = {};
  let finished = 0, running = 0, blocked = 0, withVerdict = 0, verified = 0, unchecked = 0;
  let mUsd = 0, mRuns = 0, pUsd = 0, pRuns = 0;
  for (const r of all) {
    if (r.endedAt) finished++; else running++;
    // FC-08 effective verdict: a tampered log reads TAMPERED, an unattested or unchecked success is never counted as plain VERIFIED (L3, L7)
    const verdict = r.verdict ? effectiveVerdict({ verdict: r.verdict, tampered: r.tampered === 1, attested: r.attested === 1, sig_checked: r.sigChecked === 1 }) : null;
    if (verdict) {
      by[verdict] = (by[verdict] ?? 0) + 1;
      if (r.endedAt) { withVerdict++; if (verdict === "VERIFIED") verified++; else if (verdict === "VERIFIED (signature not checked)") unchecked++; }
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
  const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
  return {
    since, runs_total: all.length, runs_finished: finished, runs_running: running, by_verdict: by, blocked_waiting: blocked,
    verified_rate: withVerdict ? verified / withVerdict : null, verified_unchecked: unchecked, keys_configured: pubkeysFromEnv().configured === true,
    cost: {
      measured_usd: mRuns ? r6(mUsd) : null, measured_runs: mRuns, partial_usd: pRuns ? r6(pUsd) : null, partial_runs: pRuns,
      label: pRuns ? "partial" : mRuns ? "measured" : "not measured",
    },
    receipts: { total, signed },
  };
}

export function mount(ctx: RouteCtx): void {
  ctx.app.get("/v1/stats", (c) => {
    const since = c.req.query("since") ?? null;
    if (since !== null && (!/^\d{4}-\d{2}-\d{2}/.test(since) || Number.isNaN(Date.parse(since)))) return c.json({ error: "since must be an ISO date or timestamp" }, 400);
    return c.json(computeStats(ctx.db, since === null ? null : new Date(since).toISOString()));
  });
}
