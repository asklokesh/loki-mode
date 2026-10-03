// GET /v1/audit: the actions table written by src/server/audit.ts, newest first, paged. The helper never stores secrets.
import { desc, sql } from "drizzle-orm";
import { actions } from "../../db/schema.ts";
import type { RouteCtx } from "./index.ts";

export function mount(ctx: RouteCtx): void {
  ctx.app.get("/v1/audit", (c) => {
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0, 0);
    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(actions).get()?.n ?? 0;
    const rows = ctx.db.select().from(actions).orderBy(desc(actions.ts), desc(actions.id)).limit(limit).offset(offset).all();
    return c.json({
      actions: rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, kind: r.kind, target: r.target, result: r.result, detail: r.detail })),
      total, next_cursor: offset + rows.length < total ? String(offset + rows.length) : null,
    });
  });
}
