// A3e (L6): a local run with no live worker PID, no terminal event and no new event for a grace period is shown as stopped, not "Running" forever.
// The worker PID is the one the supervisor recorded in <run dir>/run.pid (verified by start time, never matched by name). A run whose repo is not on
// this machine cannot be checked and is left alone. The runs row is a projection: a later event for the run rebuilds it, so a revived run recovers.
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { verifyRunPid } from "../../../../loki-ts/src/util/run_pid.ts";
import type { Db } from "../db/migrate.ts";
import { localRepos, runs } from "../db/schema.ts";

export const STOPPED_VERDICT = "STOPPED";
export const STOPPED_REASON = "stopped (no longer running)";
export const STALE_GRACE_MS = 120_000;

export function reconcileDeadRuns(db: Db, o: { now?: number; graceMs?: number; verify?: typeof verifyRunPid } = {}): number {
  const now = o.now ?? Date.now(), grace = o.graceMs ?? STALE_GRACE_MS, verify = o.verify ?? verifyRunPid;
  let n = 0;
  for (const r of db.select().from(runs).where(isNull(runs.endedAt)).all()) {
    const last = Date.parse(r.lastEventAt ?? r.startedAt ?? "");
    if (Number.isNaN(last) || now - last < grace) continue;
    const repoRow = db.select().from(localRepos).where(eq(localRepos.sourceId, r.sourceId)).get();
    if (!repoRow) continue;
    let repo: string;
    try { repo = realpathSync(repoRow.realpath); } catch { continue; }
    const root = join(repo, ".loki", "runs"), dir = resolve(root, r.runId);
    if (!dir.startsWith(root + sep)) continue;
    if (verify(dir, r.runId).ok) continue;
    db.update(runs).set({ endedAt: r.lastEventAt ?? new Date(last).toISOString(), verdict: r.verdict ?? STOPPED_VERDICT })
      .where(and(eq(runs.sourceId, r.sourceId), eq(runs.runId, r.runId), isNull(runs.endedAt))).run();
    n++;
  }
  return n;
}
