// Run artifacts read API (CPE-04): a run's events (paged) and an allowlist of files from <repo>/.loki/runs/<run>/.
// Events come from the store. Files are read from disk, so that route is loopback-only (on `act`) and every path is contained:
// the run id must be a known ingested run with a discovered local repo, the name must match a fixed allowlist, and the
// realpath of the file must stay under the realpath of <repo>/.loki/runs/<run>. The repo path never appears in a response.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { events, localRepos, runs } from "../../db/schema.ts";
import type { RouteCtx } from "./index.ts";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const EVENTS_DEFAULT = 500;
export const EVENTS_MAX = 1000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const NAME = /^(?:issue\.json|plan\.json|receipt\.json|receipt\.md|report\.md|task\.md|diff\.patch|evidence\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.png)$/;

const TYPES: Record<string, string> = {
  json: "application/json; charset=utf-8",
  md: "text/plain; charset=utf-8",
  patch: "text/plain; charset=utf-8",
  png: "image/png",
};

export const safeId = (s: string) => ID.test(s) && !s.includes("..");

/** Reads a regular file up to the cap through one descriptor (the size check and the read see the same file). */
export function readCapped(path: string): { status: 200; body: Buffer } | { status: 404 | 413 } {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { status: 404 }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { status: 404 };
    if (st.size > MAX_ARTIFACT_BYTES) return { status: 413 };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { status: 200, body: buf.subarray(0, off) };
  } finally { closeSync(fd); }
}

export function mount(ctx: RouteCtx): void {
  const { app, act, db } = ctx;
  const known = (source: string, run: string) =>
    safeId(source) && safeId(run) && !!db.select({ r: runs.runId }).from(runs).where(and(eq(runs.sourceId, source), eq(runs.runId, run))).get();

  // Paged events for the log: seq > after, ascending. DB only, so it serves on `app` behind the normal guards.
  app.get("/v1/runs/:source/:run/events", (c) => {
    const source = c.req.param("source"), run = c.req.param("run");
    if (!known(source, run)) return c.json({ error: "run not found" }, 404);
    const rawAfter = c.req.query("after"), rawLimit = c.req.query("limit");
    if (rawAfter !== undefined && !/^\d{1,15}$/.test(rawAfter)) return c.json({ error: "after must be a non-negative integer" }, 400);
    if (rawLimit !== undefined && !/^\d{1,6}$/.test(rawLimit)) return c.json({ error: "limit must be a positive integer" }, 400);
    const after = rawAfter === undefined ? -1 : Number(rawAfter);
    const limit = Math.min(rawLimit === undefined ? EVENTS_DEFAULT : Number(rawLimit), EVENTS_MAX);
    if (limit < 1) return c.json({ error: "limit must be a positive integer" }, 400);
    const rows = db.select().from(events).where(and(eq(events.sourceId, source), eq(events.runId, run), gt(events.seq, after))).orderBy(asc(events.seq)).limit(limit + 1).all();
    const out = rows.slice(0, limit).map((r) => ({ v: 1, seq: r.seq, ts: r.ts, run: r.runId, type: r.type, stage: r.stage, data: r.data }));
    return c.json({ events: out, next_after: out.length ? out[out.length - 1]?.seq ?? null : null, has_more: rows.length > limit });
  });

  // One allowlisted artifact file. Loopback peer only; a non-loopback bind never registers this route (act is detached).
  act.get("/v1/runs/:source/:run/artifact/*", (c: Context) => {
    if (!ctx.peerIsLoopback(c)) return c.json({ error: "loopback only" }, 403);
    const source = c.req.param("source"), run = c.req.param("run");
    const path = new URL(c.req.url).pathname;
    const at = path.indexOf("/artifact/");
    const raw = at < 0 ? "" : path.slice(at + "/artifact/".length);
    let name: string;
    try { name = decodeURIComponent(raw); } catch { return c.json({ error: "malformed URL encoding" }, 400); }
    // Traversal, absolute names, backslashes, NUL and anything off the allowlist all fail this one exact match.
    if (!NAME.test(name)) return c.json({ error: "artifact not on the allowlist" }, 404);
    if (!known(source, run)) return c.json({ error: "run not found" }, 404);
    const repo = db.select({ p: localRepos.realpath }).from(localRepos).where(eq(localRepos.sourceId, source)).get();
    if (!repo) return c.json({ error: "artifact not available" }, 404);
    let runsRoot: string, runDir: string, file: string;
    try {
      runsRoot = realpathSync(join(repo.p, ".loki", "runs"));
      runDir = realpathSync(join(runsRoot, run));
    } catch { return c.json({ error: "artifact not found" }, 404); }
    if (runDir !== join(runsRoot, run)) return c.json({ error: "artifact not found" }, 404);
    try { file = realpathSync(join(runDir, name)); } catch { return c.json({ error: "artifact not found" }, 404); }
    if (!file.startsWith(runDir + sep)) return c.json({ error: "artifact not found" }, 404);
    const r = readCapped(file);
    if (r.status === 413) return c.json({ error: `artifact over ${MAX_ARTIFACT_BYTES} bytes` }, 413);
    if (r.status !== 200) return c.json({ error: "artifact not found" }, 404);
    const ext = name.slice(name.lastIndexOf(".") + 1);
    return new Response(new Uint8Array(r.body), {
      status: 200,
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "content-length": String(r.body.length),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "no-store",
      },
    });
  });
}
