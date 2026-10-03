// CPE24-P2: checkpoints and audit summary, ported from dashboard/server.py (list/get/create/rollback checkpoint, get_audit_summary).
// Same store as legacy and run.sh: <repo>/.loki/state/checkpoints/{index.jsonl,<id>/metadata.json}. Audit data stays read-only: nothing here
// writes, edits or deletes an audit row or the hash chain. Create and rollback are state-changing, so they sit on `act` (loopback peer plus a
// loopback Host plus JSON, ctx.local) like every other POST route, and each is recorded in the actions log. Unmeasured values are null, never "" or 0.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { gte, sql } from "drizzle-orm";
import type { Db } from "../../db/migrate.ts";
import { audit as auditTable } from "../../db/schema.ts";
import { audit } from "../audit.ts";
import { probeAllowed, type RouteCtx } from "./index.ts";
import { NOT_MEASURED } from "./cost_ledger.ts";

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CHECKPOINTS = 50;

export const validCheckpointId = (id: string) => SAFE_ID.test(id);
const storeOf = (repoDir: string) => join(repoDir, ".loki", "state", "checkpoints");
const lokiOf = (repoDir: string) => join(repoDir, ".loki");
const readObj = (f: string): Rec | null => { try { const d = JSON.parse(readFileSync(f, "utf8")); return isObj(d) ? d : null; } catch { return null; } };
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");

export function listCheckpoints(repoDir: string, limit = 20) {
  const store = storeOf(repoDir);
  let lines: string[] = [];
  try { lines = readFileSync(join(store, "index.jsonl"), "utf8").split("\n"); } catch { return []; }
  const out: Rec[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!isObj(raw)) continue;
    const id = String(raw.id ?? "");
    if (!validCheckpointId(id)) continue;
    const it = raw.iter ?? raw.iteration;
    const cp: Rec = {
      id, created_at: str(raw.ts) ?? str(raw.created_at) ?? str(raw.timestamp), git_sha: str(raw.sha) ?? str(raw.git_sha),
      message: str(raw.task) ?? str(raw.message) ?? str(raw.task_description), iteration: Number.isInteger(it) ? it : null,
    };
    const meta = readObj(join(store, id, "metadata.json"));
    if (meta) {
      cp.git_branch = str(meta.git_branch); cp.provider = str(meta.provider); cp.phase = str(meta.phase);
      cp.message ??= str(meta.task_description); cp.git_sha ??= str(meta.git_sha); cp.created_at ??= str(meta.timestamp);
      cp.files_count = countFiles(join(store, id));
    }
    out.push(cp);
  }
  return out.reverse().slice(0, limit);
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string, top: boolean) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), false);
      else if (e.isFile() && !(top && e.name === "metadata.json")) n++;
    }
  };
  try { walk(dir, true); } catch { /* unreadable */ }
  return n;
}

export function getCheckpoint(repoDir: string, id: string): Rec | null {
  return validCheckpointId(id) ? readObj(join(storeOf(repoDir), id, "metadata.json")) : null;
}

const gitHead = (repoDir: string): string | null => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
};

export function createCheckpoint(repoDir: string, message: string, now = new Date()) {
  const store = storeOf(repoDir), loki = lokiOf(repoDir);
  mkdirSync(store, { recursive: true });
  const id = `chk-${stamp(now)}`, dir = join(store, id);
  mkdirSync(dir, { recursive: true });
  for (const f of ["dashboard-state.json", "session.json"]) { try { if (existsSync(join(loki, f))) copyFileSync(join(loki, f), join(dir, f)); } catch { /* skip */ } }
  try { if (existsSync(join(loki, "queue"))) cpSync(join(loki, "queue"), join(dir, "queue"), { recursive: true }); } catch { /* skip */ }
  const meta = { id, created_at: now.toISOString(), git_sha: gitHead(repoDir), message: message || null, files: readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
  appendFileSync(join(store, "index.jsonl"), `${JSON.stringify(meta)}\n`);
  // Retention: only chk- directories are ever pruned, never a rollback snapshot or a foreign directory.
  const mine = readdirSync(store, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("chk-")).map((e) => e.name).sort();
  while (mine.length > MAX_CHECKPOINTS) rmSync(join(store, mine.shift() as string), { recursive: true, force: true });
  return meta;
}

/** Restore .loki/ from a checkpoint after a forced pre-rollback snapshot (so the rollback can itself be undone). Never replaces .loki/state wholesale: the store lives in it. */
export function rollbackCheckpoint(repoDir: string, id: string, now = new Date()) {
  const store = storeOf(repoDir), loki = lokiOf(repoDir);
  let real = "", realStore = "";
  try { real = realpathSync(join(store, id)); realStore = realpathSync(store); } catch { return null; }
  if (!real.startsWith(`${realStore}${sep}`) || !statSync(real).isDirectory()) return null;
  const preId = `rb-pre-${stamp(now)}`, pre = join(store, preId);
  mkdirSync(pre, { recursive: true });
  const notStore = (src: string) => src !== store; // state/ holds the store itself; never copy it into itself
  for (const n of ["session.json", "dashboard-state.json", "CONTINUITY.md", "autonomy-state.json"]) { try { if (existsSync(join(loki, n))) copyFileSync(join(loki, n), join(pre, n)); } catch { /* skip */ } }
  for (const d of ["state", "queue"]) { try { if (existsSync(join(loki, d))) cpSync(join(loki, d), join(pre, d), { recursive: true, filter: notStore }); } catch { /* skip */ } }
  const preMeta = { id: preId, created_at: now.toISOString(), message: `pre-rollback snapshot (before restoring ${id})`, created_by: "control plane rollback" };
  writeFileSync(join(pre, "metadata.json"), JSON.stringify(preMeta, null, 2));
  appendFileSync(join(store, "index.jsonl"), `${JSON.stringify(preMeta)}\n`);
  let restored = 0;
  const errors: string[] = [];
  for (const e of readdirSync(real, { withFileTypes: true })) {
    if (e.name === "metadata.json" || e.name === "worktree-snapshot.txt") continue;
    const src = join(real, e.name);
    try {
      if (lstatSync(src).isSymbolicLink()) { errors.push(`${e.name}: symlink skipped`); continue; }
      cpSync(src, join(loki, e.name), { recursive: true, filter: (s) => s !== join(real, "state", "checkpoints") });
      restored++;
    } catch (err) { errors.push(`${e.name}: ${(err as Error).message}`); }
  }
  return { id, restored, pre_rollback_snapshot: preId, errors };
}

/** Read-only summary of the operator audit table over the last `days`. Fields the table does not record (success, resource type) are null. */
export function auditSummary(db: Db, days: number, now = Date.now()) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const where = gte(auditTable.ts, since);
  const total = db.select({ n: sql<number>`count(*)` }).from(auditTable).where(where).get()?.n ?? 0;
  const by = (col: typeof auditTable.action | typeof auditTable.actor) => Object.fromEntries(
    db.select({ k: col, n: sql<number>`count(*)` }).from(auditTable).where(where).groupBy(col).all().map((r) => [r.k, r.n]));
  return {
    period_days: days, total_events: total, by_action: by(auditTable.action), by_user: by(auditTable.actor),
    successful_events: null, failed_events: null, by_resource_type: null, recent_failures: null, not_measured: NOT_MEASURED,
  };
}

export const parseDays = (v: string | undefined) => { const n = Number.parseInt(v ?? "7", 10); return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 7; };
export const parseLimit = (v: string | undefined) => { const n = Number.parseInt(v ?? "20", 10); return Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 20; };

export function mount(ctx: RouteCtx): void {
  const deny = { error: "loopback only without a token" };
  const { app, act, db, repoDir } = ctx;
  app.get("/v1/checkpoints", (c) => (probeAllowed(ctx, c) ? c.json({ checkpoints: listCheckpoints(repoDir, parseLimit(c.req.query("limit"))) }) : c.json(deny, 403)));
  app.get("/v1/checkpoints/:id", (c) => {
    if (!probeAllowed(ctx, c)) return c.json(deny, 403);
    const id = c.req.param("id");
    if (!validCheckpointId(id)) return c.json({ error: "invalid checkpoint id" }, 400);
    const m = getCheckpoint(repoDir, id);
    return m ? c.json(m) : c.json({ error: "checkpoint not found" }, 404);
  });
  app.get("/v1/audit/summary", (c) => (probeAllowed(ctx, c) ? c.json(auditSummary(db, parseDays(c.req.query("days")))) : c.json(deny, 403)));

  act.post("/v1/checkpoints", async (c) => {
    if (!ctx.local(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as Rec;
    const message = typeof body.message === "string" ? body.message : "";
    if (message.length > 500) return c.json({ error: "message must be at most 500 characters" }, 400);
    try {
      const meta = createCheckpoint(repoDir, message);
      audit(db, { kind: "checkpoint.create", target: String(meta.id), result: "ok" });
      return c.json(meta, 201);
    } catch (e) {
      audit(db, { kind: "checkpoint.create", result: "error", detail: (e as Error).message });
      return c.json({ error: "could not create the checkpoint" }, 500);
    }
  });
  act.post("/v1/checkpoints/:id/rollback", (c) => {
    if (!ctx.local(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    const id = c.req.param("id");
    if (!validCheckpointId(id)) { audit(db, { kind: "checkpoint.rollback", target: id.slice(0, 128), result: "refused", detail: "invalid id" }); return c.json({ error: "invalid checkpoint id" }, 400); }
    const r = rollbackCheckpoint(repoDir, id);
    if (!r) { audit(db, { kind: "checkpoint.rollback", target: id, result: "refused", detail: "not found" }); return c.json({ error: "checkpoint not found" }, 404); }
    audit(db, { kind: "checkpoint.rollback", target: id, result: r.errors.length ? "partial" : "ok", detail: `restored ${r.restored}; pre-rollback snapshot ${r.pre_rollback_snapshot}` });
    return c.json({ ...r, message: `Restored ${r.restored} item(s) from ${id}. Prior state saved as ${r.pre_rollback_snapshot} (undo this rollback by restoring it).` });
  });
}
