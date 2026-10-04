import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { fold, partialCost } from "../../../../loki-ts/src/engine10/events.ts";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";
import type { Db } from "../db/migrate.ts";
import { events, runs } from "../db/schema.ts";
import { blockedQuestion } from "./answer.ts";
import { diffStatFor } from "./diffstat.ts";
import { effectiveVerdict, pubkeysFromEnv, sealedPrefix, SUCCESS_VERDICTS, verifyRunIntegrity } from "./integrity.ts";

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

export function loadEvents(db: Db, sourceId: string, runId: string): EventEnvelope[] {
  return db.select().from(events).where(and(eq(events.sourceId, sourceId), eq(events.runId, runId))).orderBy(asc(events.seq)).all()
    .map((r) => ({ v: 1, seq: r.seq, ts: r.ts, run: r.runId, type: r.type, stage: r.stage, data: r.data }) as EventEnvelope);
}

/** Rebuilds the runs projection row from stored events with the real fold(). The only writer of `runs`. */
export function rebuildRun(db: Db, sourceId: string, runId: string): void {
  const evs = loadEvents(db, sourceId, runId);
  if (evs.length === 0) return;
  const f = fold(sealedPrefix(evs)); // the verdict comes from the authenticated prefix; lines after the sealing line are unauthenticated
  const keys = pubkeysFromEnv();
  const integ = verifyRunIntegrity(evs, { pubkeyFor: keys }); // EL-FC08b: tampered is the supervisor flag OR any ingest-side integrity failure
  const tampered = f.run.tampered || integ.tampered;
  const pc = partialCost(evs, tampered);
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
    lastSeq: f.lastSeq, lastEventAt: evs[evs.length - 1]?.ts ?? null, tampered: Number(tampered),
    attested: Number(integ.attested), sigChecked: Number(integ.sig_checked), integrityKeyFp: keys.fingerprint ?? "", integrityReasons: JSON.stringify(integ.reasons),
  };
  // conflict is owned by ingest, so it is left out of the update set and survives a rebuild
  db.insert(runs).values(row).onConflictDoUpdate({ target: [runs.sourceId, runs.runId], set: row }).run();
}

const reasonsOf = (j: string | null): string[] => { try { const x = JSON.parse(j ?? "[]"); return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []; } catch { return []; } };

const parseRun = (r: typeof runs.$inferSelect) => ({
  source_id: r.sourceId, run_id: r.runId, origin_repo: r.originRepo, issue_ref: r.issueRef, task_source: r.taskSource,
  group_id: r.groupId, unit_id: r.unitId, provider: r.provider, model: r.model, started_at: r.startedAt, ended_at: r.endedAt, verdict: r.verdict,
  pr_url: r.prUrl, pr_draft: r.prDraft === null ? null : r.prDraft === 1,
  cost_usd: r.costUsd, partial_usd: r.partialUsd, measured_sessions: r.measuredSessions, total_sessions: r.totalSessions,
  input_tokens: r.inputTokens, output_tokens: r.outputTokens, wall_s: r.wallS, last_seq: r.lastSeq,
  last_event_at: r.lastEventAt, tampered: r.tampered === 1, conflict: r.conflict === 1,
  attested: r.attested === 1, sig_checked: r.sigChecked === 1, integrity_reasons: reasonsOf(r.integrityReasons),
  effective_verdict: effectiveVerdict({ verdict: r.verdict, tampered: r.tampered === 1, attested: r.attested === 1, sig_checked: r.sigChecked === 1 }),
  status: r.endedAt ? "completed" : "running", elapsed_s: elapsedS(r),
});
/** The task title the intake stage recorded (its `title`, else the first line of `task`), for sidebar rows of runs that have no issue ref. Null when intake has not completed. */
export function taskTitle(db: Db, sourceId: string, runId: string): string | null {
  const d = db.select({ data: events.data }).from(events).where(and(eq(events.sourceId, sourceId), eq(events.runId, runId), eq(events.type, "stage.completed"), eq(events.stage, "intake"))).orderBy(asc(events.seq)).limit(1).get()?.data as Record<string, unknown> | undefined;
  const raw = str(d?.["title"]) ?? str(d?.["task"]);
  const t = raw?.split("\n")[0]?.trim();
  return t ? (t.length > 140 ? `${t.slice(0, 139)}...` : t) : null;
}
// A run with no run.completed yet is running: add its live fields (stage, files) from the stored events.
const withLive = (db: Db, r: typeof runs.$inferSelect) => {
  const p = { ...parseRun(r), title: taskTitle(db, r.sourceId, r.runId) };
  // A finished run's events carry no diff; its receipt's base and head give one (git numstat, null when unmeasurable).
  return r.endedAt ? { ...p, current_stage: null, files_touched: [] as string[], diff_stat: diffStatFor(db, r.sourceId, r.runId) } : { ...p, ...liveInfo(loadEvents(db, r.sourceId, r.runId)), diff_stat: null };
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

/** FC-08: filters match the DISPLAY verdict. Plain VERIFIED (and ALREADY_SATISFIED) lists only attested, signature-checked runs; "<verdict> (signature not checked)" the attested
 *  rest; UNVERIFIED every non-tampered run that is not attested. */
const SIG_SUFFIX = " (signature not checked)";
const verdictFilter = (v: string | undefined) => {
  if (!v) return undefined;
  if (v === "TAMPERED") return eq(runs.tampered, 1);
  if (v === "UNVERIFIED") return and(eq(runs.tampered, 0), sql`${runs.verdict} is not null`, sql`coalesce(${runs.attested}, 0) != 1`);
  if (SUCCESS_VERDICTS.has(v)) return and(eq(runs.verdict, v), eq(runs.tampered, 0), eq(runs.attested, 1), eq(runs.sigChecked, 1));
  if (v.endsWith(SIG_SUFFIX) && SUCCESS_VERDICTS.has(v.slice(0, -SIG_SUFFIX.length))) return and(eq(runs.verdict, v.slice(0, -SIG_SUFFIX.length)), eq(runs.tampered, 0), eq(runs.attested, 1), sql`coalesce(${runs.sigChecked}, 0) != 1`);
  return and(eq(runs.verdict, v), eq(runs.tampered, 0), eq(runs.attested, 1));
};

const RECOMPUTE_CHUNK = 200;
/** Boot-time recompute. Rows are re-judged when their integrity was never evaluated (attested IS NULL) or was evaluated under a different key set (stored fingerprint differs).
 *  Chunked, one transaction per chunk. A row whose events are gone is marked unattested with a reason and the current fingerprint, so it is not retried on every boot. */
export function recomputeLegacy(db: Db): number {
  const fp = pubkeysFromEnv().fingerprint ?? "";
  let n = 0;
  for (;;) {
    const rows = db.select({ s: runs.sourceId, r: runs.runId }).from(runs).where(sql`${runs.attested} is null or ${runs.integrityKeyFp} is not ${fp}`).limit(RECOMPUTE_CHUNK).all();
    if (rows.length === 0) return n;
    db.transaction((tx) => {
      const t = tx as unknown as Db;
      for (const x of rows) {
        if (loadEvents(t, x.s, x.r).length === 0) {
          t.update(runs).set({ attested: 0, sigChecked: 0, integrityKeyFp: fp, integrityReasons: JSON.stringify(["stored events are missing; integrity cannot be evaluated"]) }).where(and(eq(runs.sourceId, x.s), eq(runs.runId, x.r))).run();
        } else rebuildRun(t, x.s, x.r);
      }
    });
    n += rows.length;
  }
}

export interface ListQuery { verdict?: string; repo?: string; since?: string; until?: string; group_id?: string; limit?: number; cursor?: string }

export function listRuns(db: Db, q: ListQuery) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(Number.parseInt(q.cursor ?? "0", 10) || 0, 0); // ponytail: cursor is an opaque offset, keyset when write rate makes pages shift
  const where = and(
    verdictFilter(q.verdict),
    q.repo ? eq(runs.originRepo, q.repo) : undefined,
    q.group_id ? eq(runs.groupId, q.group_id) : undefined,
    q.since ? gte(runs.startedAt, q.since) : undefined,
    q.until ? lt(runs.startedAt, q.until) : undefined,
  );
  const total = db.select({ n: sql<number>`count(*)` }).from(runs).where(where).get()?.n ?? 0;
  const rows = db.select().from(runs).where(where).orderBy(desc(runs.startedAt), asc(runs.runId)).limit(limit).offset(offset).all();
  return { runs: rows.map((r) => withLive(db, r)), total, next_cursor: offset + rows.length < total ? String(offset + rows.length) : null };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\[\d{1,3}(?:;\d{1,3})*m/g;
const oneLine = (s: string, max: number) => s.replace(ANSI, "").replace(/[\x00-\x1f\x7f\s]+/g, " ").trim().slice(0, max);
// FC-19: Loki's own stage rules talked the model into a false spec conflict. The engine records no version or classifier, so this reads the model's own words.
const OWN_RULES = /\bstage rules\b|\bstage-rules\b/i;

/** The terminal stop reason as one ANSI-free sentence, from the run's own end (never from verify output); null when the run did not stop short. */
export function stopReason(evs: EventEnvelope[], verdict: string | null): { reason: string | null; ownRules: boolean } {
  if (verdict === "SPEC_CONFLICT") {
    const why = evs.find((e) => e.type === "stage.completed" && e.stage === "implement")?.data.spec_conflict_reason;
    const text = typeof why === "string" ? oneLine(why, 4000) : "";
    const first = text.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? "";
    const reason = `The run stopped on a spec conflict: ${first ? first.slice(0, 240) : "the task and the repository disagree"}`;
    return { reason: /[.!?]$/.test(reason) ? reason : `${reason}.`, ownRules: OWN_RULES.test(text) };
  }
  if (verdict === "FAILED") {
    const failed = [...evs].reverse().find((e) => e.type === "stage.failed");
    const why = typeof failed?.data?.reason === "string" ? oneLine(failed.data.reason as string, 240) : "";
    if (failed && failed.stage) return { reason: `The run failed in the ${failed.stage} stage${why ? `: ${why}` : ""}.`, ownRules: false };
    const bad = evs.filter((e) => e.type === "test.result" && (e.data as Record<string, unknown>).result === "fail").length;
    return { reason: bad ? `The run failed: ${bad} check${bad === 1 ? "" : "s"} did not pass.` : "The run failed and did not record a reason.", ownRules: false };
  }
  return { reason: null, ownRules: false };
}

/** Summary row plus the folded detail: stage timeline, receipt, not_proven. Null when the run is unknown. */
export function runDetail(db: Db, sourceId: string, runId: string) {
  const r = db.select().from(runs).where(and(eq(runs.sourceId, sourceId), eq(runs.runId, runId))).get();
  if (!r) return null;
  const evs = loadEvents(db, sourceId, runId);
  const stages: { stage: string; started_at: string | null; ended_at: string | null; status: string; reason: string | null }[] = [];
  for (const e of evs) {
    if (e.stage === null || !e.type.startsWith("stage.")) continue;
    let s = stages.find((x) => x.stage === e.stage);
    if (!s) stages.push((s = { stage: e.stage, started_at: null, ended_at: null, status: "started", reason: null }));
    if (e.type === "stage.started") s.started_at = e.ts;
    else {
      s.ended_at = e.ts; s.status = e.type.slice("stage.".length);
      // The engine records why a stage was skipped or failed (stage.skipped data.reason); nothing is invented when it did not.
      const why = (e.data as Record<string, unknown> | null)?.reason;
      s.reason = typeof why === "string" && why ? why : null;
    }
  }
  const f = fold(evs);
  const done = f.run.completed?.data;
  const sealed = evs.find((e) => e.type === "receipt.sealed")?.data;
  const stop = stopReason(evs, r.verdict);
  return {
    ...withLive(db, r),
    blocked_question: blockedQuestion(evs, r.verdict),
    stop_reason: stop.reason,
    own_rules_block: stop.ownRules,
    stages,
    stages_completed: f.completed,
    receipt: sealed ? { sha256: str(sealed.receipt_sha256), signed: sealed.signed === true, verdict: str(sealed.verdict), path: str(sealed.path) } : null,
    not_proven: Array.isArray(done?.not_proven) ? (done.not_proven as string[]) : [],
  };
}
