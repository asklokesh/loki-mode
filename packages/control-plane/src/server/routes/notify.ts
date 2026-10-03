// GET /v1/notifications: derived from the runs projection and stored events. Nothing is stored or invented; unread state is client-side.
import { desc, inArray } from "drizzle-orm";
import type { Db } from "../../db/migrate.ts";
import { events, runs } from "../../db/schema.ts";
import type { RouteCtx } from "./index.ts";

export type NotificationKind = "blocked" | "finished" | "tampered" | "conflict" | "budget";
export interface Notification {
  id: string; kind: NotificationKind; ts: string; source_id: string; run_id: string;
  verdict: string | null; title: string; link: string;
}

const BUDGET_TYPES = ["cap.hit", "budget.hit"];

export function deriveNotifications(db: Db): Notification[] {
  const out: Notification[] = [];
  const mk = (kind: NotificationKind, s: string, r: string, ts: string | null, verdict: string | null, title: string, extra = ""): void => {
    out.push({ id: `${kind}:${s}:${r}${extra}`, kind, ts: ts ?? "", source_id: s, run_id: r, verdict, title, link: `/runs/${encodeURIComponent(s)}/${encodeURIComponent(r)}` });
  };
  for (const r of db.select().from(runs).all()) {
    const when = r.endedAt ?? r.lastEventAt ?? r.startedAt;
    const name = r.originRepo ?? r.runId;
    if (r.verdict === "SPEC_CONFLICT") mk("blocked", r.sourceId, r.runId, when, r.verdict, `Blocked, waiting for your answer: ${name}`);
    else if (r.endedAt && r.verdict) mk("finished", r.sourceId, r.runId, r.endedAt, r.verdict, `Finished ${r.verdict}: ${name}`);
    if (r.tampered === 1) mk("tampered", r.sourceId, r.runId, when, r.verdict, `Event log failed its integrity check: ${name}`);
    if (r.conflict === 1) mk("conflict", r.sourceId, r.runId, when, r.verdict, `Ingest conflict, a stored event was contradicted: ${name}`);
  }
  for (const e of db.select({ s: events.sourceId, r: events.runId, seq: events.seq, ts: events.ts, type: events.type }).from(events).where(inArray(events.type, BUDGET_TYPES)).orderBy(desc(events.ts)).all()) {
    mk("budget", e.s, e.r, e.ts, null, `Stopped at its ${e.type === "cap.hit" ? "time" : "budget"} cap: ${e.r}`, `:${e.seq}`);
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? -1 : 1));
}

export function mount(ctx: RouteCtx): void {
  ctx.app.get("/v1/notifications", (c) => {
    const all = deriveNotifications(ctx.db);
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0, 0);
    const kind = c.req.query("kind");
    const list = kind ? all.filter((n) => n.kind === kind) : all;
    const page = list.slice(offset, offset + limit);
    return c.json({ notifications: page, total: list.length, next_cursor: offset + page.length < list.length ? String(offset + page.length) : null });
  });
}
