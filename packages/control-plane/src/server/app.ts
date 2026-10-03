import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { openDb } from "../db/migrate.ts";
import { ingest } from "./ingest.ts";
import { defaultAnswerDir, writeAnswer } from "./answer.ts";
import { listRuns, runDetail } from "./runs.ts";
import { hostGuard, tokenGuard } from "./auth.ts";

const MAX_BODY = 1_000_000;

/** The built UI: packages/control-plane/ui/dist, found from src/server (source run) or dist (bundled server). */
const defaultUiDir = () => [join(import.meta.dir, "../../ui/dist"), join(import.meta.dir, "../ui/dist")].find((d) => existsSync(join(d, "index.html")));

/** dbPath ":memory:" for tests. Migrations run here, so /ready is true as soon as this returns. uiDir overrides the built-UI location. */
export function createApp(opts: { dbPath: string; uiDir?: string; answerDir?: string; token?: string; loopbackOnly?: boolean }) {
  const uiDir = opts.uiDir ?? defaultUiDir();
  const { db, sqlite } = openDb(opts.dbPath);
  let ready = true;
  const answerDir = opts.answerDir ?? defaultAnswerDir();
  const app = new Hono();
  // token: bearer required on /v1/*. loopbackOnly: reject a non-loopback Host (DNS rebinding). Both off by default; serve.ts sets them from env.
  if (opts.loopbackOnly) app.use("*", hostGuard());
  if (opts.token) app.use("/v1/*", tokenGuard(opts.token));

  app.get("/health", (c) => c.json({ service: "loki-control", pid: process.pid, install_path: import.meta.dir }));
  app.get("/ready", (c) => {
    try { sqlite.query("select 1").get(); } catch { ready = false; }
    return ready ? c.json({ ready: true }) : c.json({ ready: false }, 503);
  });

  app.post("/v1/ingest", async (c) => {
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ error: "body over 1 MB" }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const r = ingest(db, body);
    return c.json(r.body, r.status);
  });

  app.get("/v1/runs", (c) => {
    const q = c.req.query();
    return c.json(listRuns(db, { verdict: q.verdict, repo: q.repo, since: q.since, until: q.until, group_id: q.group_id, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor }));
  });
  const detail = (c: { json: (b: unknown, s?: 404) => Response }, source: string, run: string) => {
    const d = runDetail(db, source, run);
    return d ? c.json(d) : c.json({ error: "run not found" }, 404);
  };
  app.get("/v1/runs/:source/:run", (c) => detail(c, c.req.param("source"), c.req.param("run")));
  // BLOCKED answer: only for a run blocked on a question; JSON content type required (blocks cross-site form posts).
  app.post("/v1/runs/:source/:run/answer", async (c) => {
    const source = c.req.param("source"), run = c.req.param("run");
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "content-type must be application/json" }, 400);
    const text = await c.req.text();
    if (text.length > 20_000) return c.json({ error: "body too large" }, 413);
    let body: { answer?: unknown } | null;
    try { body = JSON.parse(text) as { answer?: unknown } | null; } catch { return c.json({ error: "invalid JSON" }, 400); }
    const d = runDetail(db, source, run);
    if (!d) return c.json({ error: "run not found" }, 404);
    if (!d.blocked_question) return c.json({ error: "run is not blocked on a question" }, 409);
    const r = writeAnswer(answerDir, source, run, body?.answer);
    return c.json(r.body, r.status);
  });
  // :id is `source:run` (run ids never contain a colon)
  app.get("/v1/runs/:id", (c) => {
    const id = c.req.param("id");
    const i = id.indexOf(":");
    return i < 0 ? c.json({ error: "id must be source:run" }, 404) : detail(c, id.slice(0, i), id.slice(i + 1));
  });

  // Static UI with SPA fallback. Registered last so /v1, /health and /ready always win.
  app.get("*", (c) => {
    const p = decodeURIComponent(new URL(c.req.url).pathname);
    if (!uiDir || p.startsWith("/v1/")) return c.json({ error: "not found" }, 404);
    const root = resolve(uiDir);
    const f = resolve(root, `.${p}`);
    if (f.startsWith(root + sep) && existsSync(f) && statSync(f).isFile()) return new Response(Bun.file(f));
    if (/\.[a-z0-9]+$/i.test(p)) return c.json({ error: "not found" }, 404); // a missing asset is a 404, not index.html
    return new Response(Bun.file(join(root, "index.html")));
  });

  return { app, db, close: () => sqlite.close() };
}
