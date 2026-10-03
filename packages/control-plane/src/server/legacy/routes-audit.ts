// CPE24-P2: legacy (port 57374) mappings for audit and checkpoints. Reads share their implementation with routes/checkpoints.ts; the two POSTs
// keep the /v1 rule (loopback peer, loopback Host, JSON) even though the shim guard already passed, so a token alone never reaches a restore.
import type { Context } from "hono";
import type { Db } from "../../db/migrate.ts";
import { audit } from "../audit.ts";
import { isLoopbackHost, peerIsLoopback } from "../auth.ts";
import { auditSummary, createCheckpoint, getCheckpoint, listCheckpoints, parseDays, parseLimit, rollbackCheckpoint, validCheckpointId } from "../routes/checkpoints.ts";

type AuditList = (c: Context) => { err: Response; rows?: undefined } | { err?: undefined; rows: unknown[] };

const BAD_ID = "Invalid checkpoint_id: must be 1-128 chars of alphanumeric, hyphens, and underscores";

export function auditCheckpointMapped(db: Db, repoDir: string, auditList: AuditList): Record<string, (c: Context) => Response | Promise<Response>> {
  const local = (c: Context) => peerIsLoopback(c) && isLoopbackHost(c.req.header("host")) && (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
  const refuse = (c: Context) => c.json({ detail: "loopback JSON requests only" }, 403);
  return {
    "GET /api/enterprise/audit": (c) => { const r = auditList(c); return r.err ?? c.json(r.rows); },
    "GET /api/enterprise/audit/summary": (c) => c.json(auditSummary(db, parseDays(c.req.query("days")))),
    "GET /api/checkpoints": (c) => c.json(listCheckpoints(repoDir, parseLimit(c.req.query("limit")))),
    "GET /api/checkpoints/{checkpoint_id}": (c) => {
      const id = c.req.param("checkpoint_id") ?? "";
      if (!validCheckpointId(id)) return c.json({ detail: BAD_ID }, 400);
      const m = getCheckpoint(repoDir, id);
      return m ? c.json(m) : c.json({ detail: "Checkpoint not found" }, 404);
    },
    "POST /api/checkpoints": async (c) => {
      if (!local(c)) return refuse(c);
      const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof body?.message === "string" ? body.message : "";
      if (message.length > 500) return c.json({ detail: "message must be at most 500 characters" }, 422);
      try {
        const meta = createCheckpoint(repoDir, message);
        audit(db, { kind: "checkpoint.create", target: String(meta.id), result: "ok", detail: "legacy route" });
        return c.json(meta, 201);
      } catch (e) {
        audit(db, { kind: "checkpoint.create", result: "error", detail: (e as Error).message });
        return c.json({ detail: "could not create the checkpoint" }, 500);
      }
    },
    "POST /api/checkpoints/{checkpoint_id}/rollback": (c) => {
      if (!local(c)) return refuse(c);
      const id = c.req.param("checkpoint_id") ?? "";
      if (!validCheckpointId(id)) { audit(db, { kind: "checkpoint.rollback", target: id.slice(0, 128), result: "refused", detail: "invalid id (legacy route)" }); return c.json({ detail: BAD_ID }, 400); }
      const r = rollbackCheckpoint(repoDir, id);
      if (!r) { audit(db, { kind: "checkpoint.rollback", target: id, result: "refused", detail: "not found (legacy route)" }); return c.json({ detail: "Checkpoint not found" }, 404); }
      audit(db, { kind: "checkpoint.rollback", target: id, result: r.errors.length ? "partial" : "ok", detail: `restored ${r.restored}; pre-rollback snapshot ${r.pre_rollback_snapshot} (legacy route)` });
      return c.json({ ...r, message: `Restored ${r.restored} item(s) from ${id}. Prior state saved as ${r.pre_rollback_snapshot} (undo this rollback by restoring it).` });
    },
  };
}
