import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";
import { redactSecrets } from "../../../../loki-ts/src/util/redact.ts";
import type { Db } from "../db/migrate.ts";
import { events, localRepos, runs, sources } from "../db/schema.ts";
import { TEST_RUN_ID, tempRoots, underTemp } from "../db/fixture-cleanup.ts";
import { rebuildRun } from "./runs.ts";

export const MAX_EVENTS = 500;

export type IngestResult =
  | { status: 200; body: { accepted: number; duplicate: number; conflict: number; last_seq: number } }
  | { status: 400; body: { error: string } }
  | { status: 409; body: { accepted: number; duplicate: number; conflict: number; last_seq: number; error: string } };

/** Body: {source, run_id, events: EventEnvelope[]}. Event id = source:run:seq; same id and same hash is a no-op, a different hash is a 409 that flags the run and never overwrites. */
export function ingest(db: Db, body: unknown): IngestResult {
  const b = body as { source?: unknown; source_id?: unknown; run_id?: unknown; events?: unknown } | null;
  const sourceId = b?.source ?? b?.source_id;
  if (typeof sourceId !== "string" || !sourceId || typeof b?.run_id !== "string" || !b.run_id) return { status: 400, body: { error: "source and run_id required" } };
  const runId = b.run_id;
  // A3b: test suites once leaked fixture runs into a real control.db. A source rooted under a temp dir, or a test run-id prefix, is never real history.
  if (TEST_RUN_ID.test(runId)) return { status: 400, body: { error: `run_id ${runId} looks like a test fixture (e37-, e10-sig, e10-sg); refusing to ingest it` } };
  const repoPath = db.select({ p: localRepos.realpath }).from(localRepos).where(eq(localRepos.sourceId, sourceId)).get()?.p;
  if (repoPath && process.env.LOKI_CONTROL_ALLOW_TEMP_SOURCES !== "1" && underTemp(repoPath, tempRoots())) return { status: 400, body: { error: "source is a repo under a temp directory (a test fixture); refusing to ingest it" } };
  if (!Array.isArray(b.events) || b.events.length > MAX_EVENTS) return { status: 400, body: { error: `events must be an array of at most ${MAX_EVENTS}` } };

  const rows: { e: EventEnvelope; json: string; sha: string }[] = [];
  for (const [i, raw] of b.events.entries()) {
    const bad = validateEnvelope(raw);
    if (bad) return { status: 400, body: { error: `events[${i}]: ${bad}` } };
    const e = JSON.parse(redactSecrets(JSON.stringify(raw))) as EventEnvelope; // redacted again server-side
    if (e.run !== runId) return { status: 400, body: { error: `events[${i}]: run does not match run_id` } };
    const json = JSON.stringify(e);
    rows.push({ e, json, sha: createHash("sha256").update(json).digest("hex") });
  }

  const now = new Date().toISOString();
  let accepted = 0, duplicate = 0, conflict = 0;
  db.transaction((tx) => {
    tx.insert(sources).values({ id: sourceId, firstSeen: now, lastSeen: now }).onConflictDoUpdate({ target: sources.id, set: { lastSeen: now } }).run();
    for (const { e, sha } of rows) {
      const prior = tx.select({ sha: events.lineSha256 }).from(events)
        .where(and(eq(events.sourceId, sourceId), eq(events.runId, runId), eq(events.seq, e.seq))).get();
      if (prior) { if (prior.sha === sha) duplicate++; else conflict++; continue; }
      tx.insert(events).values({ sourceId, runId, seq: e.seq, ts: e.ts, type: e.type, stage: e.stage, data: e.data, lineSha256: sha, receivedAt: now }).run();
      accepted++;
    }
    if (accepted > 0) rebuildRun(tx as unknown as Db, sourceId, runId);
    if (conflict > 0) tx.update(runs).set({ conflict: 1 }).where(and(eq(runs.sourceId, sourceId), eq(runs.runId, runId))).run();
  });
  const last = db.select({ m: sql<number | null>`max(${events.seq})` }).from(events).where(and(eq(events.sourceId, sourceId), eq(events.runId, runId))).get()?.m ?? -1;
  const out = { accepted, duplicate, conflict, last_seq: last };
  return conflict > 0 ? { status: 409, body: { ...out, error: "conflicting content for an existing event id" } } : { status: 200, body: out };
}
