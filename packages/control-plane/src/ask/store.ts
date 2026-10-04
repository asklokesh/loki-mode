// CP-ASK slice 5: persistence for Ask threads, messages and events in control.db.
// Pure store: no spawn, no HTTP. Seq numbers are dense per thread (messages) and per message (events).
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/migrate.ts";
import { askEvents, askMessages, askThreads } from "../db/schema.ts";
import type { AskEventKind } from "./parse.ts";

export type AskStatus = "queued" | "running" | "done" | "failed" | "timeout" | "over_budget" | "interrupted";
export const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "timeout", "over_budget", "interrupted"]);

const now = () => new Date().toISOString();

export function createThread(db: Db, o: { provider: string; model?: string | null; repo?: string | null; title?: string | null }): string {
  const id = randomUUID();
  const t = now();
  db.insert(askThreads).values({ id, createdAt: t, updatedAt: t, repo: o.repo ?? null, provider: o.provider, model: o.model ?? null, title: o.title ?? null }).run();
  return id;
}

export const getThread = (db: Db, id: string) => db.select().from(askThreads).where(eq(askThreads.id, id)).get();
export const listThreads = (db: Db, limit = 100) => db.select().from(askThreads).orderBy(sql`${askThreads.updatedAt} desc`).limit(limit).all();
export const getMessage = (db: Db, id: string) => db.select().from(askMessages).where(eq(askMessages.id, id)).get();
export const listMessages = (db: Db, threadId: string) => db.select().from(askMessages).where(eq(askMessages.threadId, threadId)).orderBy(asc(askMessages.seq)).all();

/** Append a user message and its queued assistant placeholder in one transaction. */
export function addTurn(db: Db, threadId: string, question: string): { userId: string; assistantId: string } {
  return db.transaction((tx) => {
    const max = tx.select({ m: sql<number | null>`max(${askMessages.seq})` }).from(askMessages).where(eq(askMessages.threadId, threadId)).get()?.m ?? -1;
    const userId = randomUUID(), assistantId = randomUUID();
    const t = now();
    tx.insert(askMessages).values({ id: userId, threadId, seq: max + 1, role: "user", text: question, status: "done", finishedAt: t }).run();
    tx.insert(askMessages).values({ id: assistantId, threadId, seq: max + 2, role: "assistant", text: "", status: "queued" }).run();
    tx.update(askThreads).set({ updatedAt: t, title: sql`coalesce(${askThreads.title}, ${question.slice(0, 80)})` }).where(eq(askThreads.id, threadId)).run();
    return { userId, assistantId };
  });
}

export function appendEvent(db: Db, messageId: string, kind: AskEventKind, payload: unknown): number {
  return db.transaction((tx) => {
    const max = tx.select({ m: sql<number | null>`max(${askEvents.seq})` }).from(askEvents).where(eq(askEvents.messageId, messageId)).get()?.m ?? -1;
    tx.insert(askEvents).values({ id: randomUUID(), messageId, seq: max + 1, kind, payload: JSON.stringify(payload), ts: now() }).run();
    return max + 1;
  });
}

/** Events after `afterSeq` (exclusive); omit for all. */
export function listEvents(db: Db, messageId: string, afterSeq = -1) {
  return db.select().from(askEvents).where(and(eq(askEvents.messageId, messageId), gt(askEvents.seq, afterSeq))).orderBy(asc(askEvents.seq)).all();
}

/** Tool calls the answer was grounded on, in call order. */
export function citations(db: Db, messageId: string): { id: unknown; name: unknown; input: unknown }[] {
  return listEvents(db, messageId).filter((e) => e.kind === "tool_use").map((e) => {
    const p = JSON.parse(e.payload) as { id?: unknown; name?: unknown; input?: unknown };
    return { id: p.id, name: p.name, input: p.input };
  });
}

export function setRunning(db: Db, messageId: string, pid: number, pgid: number): void {
  db.update(askMessages).set({ status: "running", workerPid: pid, pgid, startedAt: now() }).where(eq(askMessages.id, messageId)).run();
}

export function finishMessage(db: Db, messageId: string, o: { status: AskStatus; text?: string; costUsd?: number | null; error?: string | null }): void {
  db.update(askMessages).set({ status: o.status, ...(o.text !== undefined ? { text: o.text } : {}), costUsd: o.costUsd ?? null, error: o.error ?? null, finishedAt: now() }).where(eq(askMessages.id, messageId)).run();
}

/** Queued or running assistant messages (the concurrency gauge). */
export const activeCount = (db: Db): number =>
  db.select({ n: sql<number>`count(*)` }).from(askMessages).where(inArray(askMessages.status, ["queued", "running"])).get()?.n ?? 0;

export const threadBusy = (db: Db, threadId: string): boolean =>
  !!db.select({ i: askMessages.id }).from(askMessages).where(and(eq(askMessages.threadId, threadId), inArray(askMessages.status, ["queued", "running"]))).get();

/** Boot recovery: a running row whose worker pid is dead becomes interrupted. Queued, done and live rows are untouched. */
export function markInterrupted(db: Db, isAlive: (pid: number) => boolean): number {
  let n = 0;
  for (const m of db.select().from(askMessages).where(eq(askMessages.status, "running")).all()) {
    if (m.workerPid !== null && isAlive(m.workerPid)) continue;
    finishMessage(db, m.id, { status: "interrupted", text: m.text, costUsd: m.costUsd, error: "interrupted: the worker process is gone" });
    n++;
  }
  return n;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
