import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { fold, partialCost } from "../../../../loki-ts/src/engine10/events.ts";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";
import type { Db } from "../db/migrate.ts";
import { events, runs } from "../db/schema.ts";
import { blockedQuestion } from "./answer.ts";

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

export function loadEvents(db: Db, sourceId: string, runId: string): EventEnvelope[] {
  return db.select().from(events).where(and(eq(events.sourceId, sourceId), eq(events.runId, runId))).orderBy(asc(events.seq)).all()
    .map((r) => ({ v: 1, seq: r.seq, ts: r.ts, run: r.runId, type: r.type, stage: r.stage, data: r.data }) as EventEnvelope);
}

/** Rebuilds the runs projection row from stored events with the real fold(). The only writer of `runs`. */
export function rebuildRun(db: Db, sourceId: string, runId: string): void {
  const evs = loadEvents(db, sourceId, runId);
  if (evs.length === 0) return;
  const f = fold(evs);
  const pc = partialCost(evs, f.run.tampered);
  const sd = f.run.started?.data ?? {};
  const done = f.run.completed?.data ?? {};
  const pr = evs.find((e) => e.type === "pr.opened")?.data;
  const row = {
    sourceId, runId,
    originRepo: str(sd.origin_repo), issueRef: str(sd.issue_ref), taskSource: str(sd.task_source),
    provider: str(sd.provider), model: str(sd.model), groupId: str(sd.group_id), unitId: str(sd.unit_id),
    startedAt: f.run.started?.ts ?? evs[0]?.ts ?? null, endedAt: f.run.completed?.ts ?? null,
    verdict: f.run.verdict,
    prUrl: str(done.pr_url) ?? str(pr?.url), prDraft: typeof pr?.draft === "boolean" ? Number(pr.draft) : null,
    costUsd: f.cost.usd, partialUsd: pc.usd, measuredSessions: pc.measured, totalSessions: pc.total,
    inputTokens: f.cost.inputTokens, outputTokens: f.cost.outputTokens,
    wallS: typeof done.wall_s === "number" ? done.wall_s : null,
    lastSeq: f.lastSeq, lastEventAt: evs[evs.length - 1]?.ts ?? null, tampered: Number(f.run.tampered),
  };
  // conflict is owned by ingest, so it is left out of the update set and survives a rebuild
  db.insert(runs).values(row).onConflictDoUpdate({ target: [runs.sourceId, runs.runId], set: row }).run();
}

const parseRun = (r: typeof runs.$inferSelect) => ({
  source_id: r.sourceId, run_id: r.runId, origin_repo: r.originRepo, issue_ref: r.issueRef, task_source: r.taskSource,
  group_id: r.groupId, unit_id: r.unitId, provider: r.provider, model: r.model, started_at: r.startedAt, ended_at: r.endedAt, verdict: r.verdict,
  pr_url: r.prUrl, pr_draft: r.prDraft === null ? null : r.prDraft === 1,
  cost_usd: r.costUsd, partial_usd: r.partialUsd, measured_sessions: r.measuredSessions, total_sessions: r.totalSessions,
  input_tokens: r.inputTokens, output_tokens: r.outputTokens, wall_s: r.wallS, last_seq: r.lastSeq,
  last_event_at: r.lastEventAt, tampered: r.tampered === 1, conflict: r.conflict === 1,
  status: r.endedAt ? "completed" : "running", elapsed_s: elapsedS(r),
});
// A run with no run.completed yet is running: add its live fields (stage, files) from the stored events.
const withLive = (db: Db, r: typeof runs.$inferSelect) => {
  const p = parseRun(r);
  return r.endedAt ? { ...p, current_stage: null, files_touched: [] as string[] } : { ...p, ...liveInfo(loadEvents(db, r.sourceId, r.runId)) };
};

/** Live view of one run from its events so far: current stage, files touched. Elapsed is computed per request. */
export function liveInfo(evs: EventEnvelope[]) {
  const open: string[] = [];
  for (const e of evs) {
    if (e.stage === null || !e.type.startsWith("stage.")) continue;
    const i = open.indexOf(e.stage);
    if (e.type === "stage.started") { if (i < 0) open.push(e.stage); } else if (i >= 0) open.splice(i, 1);
  }
  const lastStage = [...evs].reverse().find((e) => e.stage !== null && e.type.startsWith("stage."))?.stage ?? null;
  const files = new Set<string>();
  for (const e of evs) for (const k of ["changed_files", "files"]) {
    const v = e.data[k];
    if (Array.isArray(v)) for (const f of v) if (typeof f === "string") files.add(f);
  }
  return { current_stage: open[open.length - 1] ?? lastStage, files_touched: [...files] };
}

const elapsedS = (r: typeof runs.$inferSelect): number | null => {
  if (!r.startedAt) return null;
  const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
  return Math.max(0, (end - Date.parse(r.startedAt)) / 1000);
};

export interface ListQuery { verdict?: string; repo?: string; since?: string; until?: string; group_id?: string; limit?: number; cursor?: string }

export function listRuns(db: Db, q: ListQuery) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(Number.parseInt(q.cursor ?? "0", 10) || 0, 0); // ponytail: cursor is an opaque offset, keyset when write rate makes pages shift
  const where = and(
    q.verdict ? eq(runs.verdict, q.verdict) : undefined,
    q.repo ? eq(runs.originRepo, q.repo) : undefined,
    q.group_id ? eq(runs.groupId, q.group_id) : undefined,
    q.since ? gte(runs.startedAt, q.since) : undefined,
    q.until ? lt(runs.startedAt, q.until) : undefined,
  );
  const total = db.select({ n: sql<number>`count(*)` }).from(runs).where(where).get()?.n ?? 0;
  const rows = db.select().from(runs).where(where).orderBy(desc(runs.startedAt), asc(runs.runId)).limit(limit).offset(offset).all();
  return { runs: rows.map((r) => withLive(db, r)), total, next_cursor: offset + rows.length < total ? String(offset + rows.length) : null };
}

/** Summary row plus the folded detail: stage timeline, receipt, not_proven. Null when the run is unknown. */
export function runDetail(db: Db, sourceId: string, runId: string) {
  const r = db.select().from(runs).where(and(eq(runs.sourceId, sourceId), eq(runs.runId, runId))).get();
  if (!r) return null;
  const evs = loadEvents(db, sourceId, runId);
  const stages: { stage: string; started_at: string | null; ended_at: string | null; status: string }[] = [];
  for (const e of evs) {
    if (e.stage === null || !e.type.startsWith("stage.")) continue;
    let s = stages.find((x) => x.stage === e.stage);
    if (!s) stages.push((s = { stage: e.stage, started_at: null, ended_at: null, status: "started" }));
    if (e.type === "stage.started") s.started_at = e.ts;
    else { s.ended_at = e.ts; s.status = e.type.slice("stage.".length); }
  }
  const f = fold(evs);
  const done = f.run.completed?.data;
  const sealed = evs.find((e) => e.type === "receipt.sealed")?.data;
  return {
    ...withLive(db, r),
    blocked_question: blockedQuestion(evs, r.verdict),
    stages,
    stages_completed: f.completed,
    receipt: sealed ? { sha256: str(sealed.receipt_sha256), signed: sealed.signed === true, verdict: str(sealed.verdict), path: str(sealed.path) } : null,
    not_proven: Array.isArray(done?.not_proven) ? (done.not_proven as string[]) : [],
  };
}
