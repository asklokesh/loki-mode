// Legacy dashboard shim (CPE-24, docs/v10/CP-ENTERPRISE-UI.md section 5). A Hono router, mounted on the CP app before the SPA fallback, that answers every route
// dashboard/server.py served: map onto CP data, 308 the HTML pages, 501 what the CP cannot back yet (never a faked success), 410 what nothing consumes.
// It binds no port and adds no machine-touching action. Auth is never looser than legacy (see legacyGuard).
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { Db } from "../../db/migrate.ts";
import { audit, runs } from "../../db/schema.ts";
import { peerIsLoopback, tokenMatches } from "../auth.ts";
import { liveInfo, listRuns, loadEvents, runDetail } from "../runs.ts";
import { LEGACY_ROUTES, type LegacyRoute } from "./routes.ts";
import { memoryMapped } from "./routes-memory.ts";
import { metricsMapped } from "./routes-metrics.ts";

export interface LegacyShimOpts {
  db: Db;
  /** Checkout whose .loki/ the metrics and cost mappings read (CPE24-P1); defaults to the process cwd like createApp. */
  repoDir?: string;
  /** The CP bearer token (LOKI_CONTROL_TOKEN). */
  token?: string;
  /** Environment used to read the legacy auth flags; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Origin of the CP UI for 308 targets. Empty (default) means the shim is mounted on the CP app itself, where "/" is already the UI. */
  uiBase?: string;
  log?: (line: string) => void;
  version?: string;
}

const flagOn = (v: string | undefined) => ["true", "1", "yes"].includes((v ?? "").toLowerCase());
/** The legacy dashboard enforced scopes when LOKI_ENTERPRISE_AUTH was on or OIDC was configured (dashboard/auth.py). */
export const legacyAuthEnabled = (env: Record<string, string | undefined>) => flagOn(env.LOKI_ENTERPRISE_AUTH) || !!(env.LOKI_OIDC_ISSUER && env.LOKI_OIDC_CLIENT_ID);

const logged = new Set<string>();
/** Test hook: forget which routes already logged their first hit. */
export const resetLegacyLog = () => logged.clear();

const toHono = (p: string) => p.replace(/\{([A-Za-z_]+):path\}/g, ":$1{.+}").replace(/\{([A-Za-z_]+)\}/g, ":$1");
const NOT_SUPPORTED = "not yet supported by the Control Plane";

const repoVersion = (): string => {
  for (const f of [join(import.meta.dir, "../../../../../VERSION")]) {
    try { if (existsSync(f)) return readFileSync(f, "utf8").trim(); } catch { /* fall through */ }
  }
  return "unknown";
};

const intParam = (v: string | undefined, def: number, min: number, max: number): number | null => {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

export function queryAudit(db: Db, q: { start_date?: string; end_date?: string; action?: string; limit: number; offset: number }) {
  const where = and(
    q.action ? eq(audit.action, q.action) : undefined,
    q.start_date ? gte(audit.ts, q.start_date) : undefined,
    q.end_date ? lt(audit.ts, `${q.end_date}￿`) : undefined,
  );
  return db.select().from(audit).where(where).orderBy(desc(audit.id)).limit(q.limit).offset(q.offset).all()
    .map((r) => ({ id: r.id, timestamp: r.ts, action: r.action, actor: r.actor, details: r.detail }));
}

export function legacyShim(opts: LegacyShimOpts) {
  const { db } = opts;
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((l: string) => console.warn(l));
  const version = opts.version ?? repoVersion();
  const bootedAt = Date.now();
  const uiBase = (opts.uiBase ?? "").replace(/\/+$/, "");
  const authOn = legacyAuthEnabled(env);
  const app = new Hono();

  /** Never looser than legacy: a CP token, when set, is always required; with none set, legacy enterprise auth or OIDC being on fails closed (the CP cannot check loki_* tokens); with neither, only a loopback socket peer is served (legacy 403s any other peer, whatever Host says; unknown peer fails closed). */
  const denied = (c: Context): Response | null => {
    if (opts.token) return tokenMatches(c.req.header("authorization"), opts.token) ? null : c.json({ detail: "Not authenticated" }, 401, { "www-authenticate": "Bearer" });
    if (authOn) return c.json({ detail: "Not authenticated" }, 401, { "www-authenticate": "Bearer" });
    return peerIsLoopback(c) ? null : c.json({ detail: "Forbidden" }, 403);
  };
  const once = (r: Pick<LegacyRoute, "method" | "path" | "action" | "migrate">) => {
    const key = `${r.method} ${r.path}`;
    if (logged.has(key)) return;
    logged.add(key);
    if (r.action === "501") log(`legacy dashboard route ${r.path} is not served by the Control Plane (501); no /v1 equivalent yet`);
    else if (r.action === "410") log(`legacy dashboard route ${r.path} is retired (410); nothing consumes it`);
    else log(`legacy dashboard route ${r.path} is served by the Control Plane; migrate to ${r.migrate}`);
  };

  const runKey = (id: string): { source: string; run: string } | null => {
    const i = id.indexOf(":");
    if (i > 0) return { source: id.slice(0, i), run: id.slice(i + 1) };
    const row = db.select({ s: runs.sourceId, r: runs.runId }).from(runs).where(eq(runs.runId, id)).orderBy(desc(runs.startedAt)).get();
    return row ? { source: row.s, run: row.r } : null;
  };
  const withId = <T extends { source_id: string; run_id: string; started_at: string | null }>(r: T) => ({ ...r, id: `${r.source_id}:${r.run_id}`, created_at: r.started_at });

  const auditList = (c: Context) => {
    const q = c.req.query();
    const limit = intParam(q.limit, 100, 1, 10000), offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) return { err: c.json({ detail: "limit must be 1..10000 and offset a non-negative integer" }, 422) };
    if (q.resource_type) return { err: c.json({ detail: "resource_type filter is not supported by the Control Plane audit log" }, 400) };
    return { rows: queryAudit(db, { start_date: q.start_date, end_date: q.end_date, action: q.action, limit, offset }), limit, offset };
  };

  const mapped: Record<string, (c: Context) => Response | Promise<Response>> = {
    "GET /.well-known/agent.json": (c) => c.json({
      name: "Loki Mode", version, url: "https://www.autonomi.dev/",
      description: "Multi-agent autonomous system by Autonomi. Served by the Loki Control Plane.",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
      protocols: { a2a: "0.1" },
      endpoints: { health: "/health", status: "/api/status", runs: "/v1/runs" },
      enterprise: { multi_tenant: false, rbac: false, audit_log: true, sso: false },
      authentication: { schemes: ["bearer"] },
      defaultInputModes: ["text/plain", "application/json"], defaultOutputModes: ["text/plain", "application/json"],
    }),
    "GET /api/status": (c) => {
      const running = db.select({ n: sql<number>`count(*)` }).from(runs).where(isNull(runs.endedAt)).get()?.n ?? 0;
      const latest = db.select().from(runs).where(isNull(runs.endedAt)).orderBy(desc(runs.startedAt)).get();
      const live = latest ? liveInfo(loadEvents(db, latest.sourceId, latest.runId)) : null;
      return c.json({
        status: running > 0 ? "running" : "idle", version, uptime_seconds: (Date.now() - bootedAt) / 1000,
        active_sessions: running, database_connected: true,
        phase: live?.current_stage ?? "", provider: latest?.provider ?? "",
      });
    },
    "GET /api/v2/runs": (c) => {
      const q = c.req.query();
      const limit = intParam(q.limit, 50, 1, 1000), offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || offset === null) return c.json({ detail: "limit must be 1..1000 and offset a non-negative integer" }, 422);
      if (q.project_id !== undefined) return c.json({ detail: "project_id filter is not supported by the Control Plane (runs are not grouped into legacy projects)" }, 400);
      if (q.status !== undefined && q.status !== "running" && q.status !== "completed") return c.json({ detail: "status must be running or completed" }, 400);
      if (q.status === undefined) return c.json(listRuns(db, { limit, cursor: String(offset) }).runs.map(withId));
      const keys = db.select({ s: runs.sourceId, r: runs.runId }).from(runs).where(q.status === "running" ? isNull(runs.endedAt) : isNotNull(runs.endedAt))
        .orderBy(desc(runs.startedAt)).limit(Math.min(limit, 200)).offset(offset).all();
      return c.json(keys.flatMap((k) => { const d = runDetail(db, k.s, k.r); return d ? [withId(d)] : []; }));
    },
    "GET /api/v2/runs/{run_id}": (c) => {
      const k = runKey(c.req.param("run_id") ?? "");
      const d = k ? runDetail(db, k.source, k.run) : null;
      return d ? c.json(withId(d)) : c.json({ detail: "Run not found" }, 404);
    },
    "GET /api/v2/runs/{run_id}/timeline": (c) => {
      const k = runKey(c.req.param("run_id") ?? "");
      const d = k ? runDetail(db, k.source, k.run) : null;
      if (!k || !d) return c.json({ detail: "Run not found" }, 404);
      return c.json({
        run_id: `${k.source}:${k.run}`,
        phases: d.stages.map((s) => ({ name: s.stage, status: s.status, started_at: s.started_at, ended_at: s.ended_at })),
        current_phase: d.current_stage,
        events: loadEvents(db, k.source, k.run).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, stage: e.stage })),
      });
    },
    "GET /api/v2/audit": (c) => { const r = auditList(c); return r.err ?? c.json(r.rows); },
    ...metricsMapped(opts.repoDir ?? process.cwd()),
    ...memoryMapped(opts.repoDir ?? process.cwd()),
  };

  // /lab/api/* is data, not a page: 501 JSON on every method (a 308 to the SPA would hand a client HTML). Registered before the /lab mount.
  app.all("/lab/api/*", (c) => {
    const d = denied(c);
    if (d) return d;
    return c.json({ error: NOT_SUPPORTED, detail: "The legacy dashboard route exists, but the Control Plane has no data or mechanism for it yet.", legacy_route: "/lab/api/*", method: c.req.method }, 501);
  });

  for (const r of LEGACY_ROUTES) {
    // On the CP app itself "/" is the UI already; redirecting it would loop. Only a separately mounted shim (uiBase set) redirects it.
    if (r.action === "308" && uiBase === "" && r.path === "/") continue;
    const hp = toHono(r.path);
    const handle = (c: Context): Response | Promise<Response> => {
      if (!r.open) { const d = denied(c); if (d) return d; }
      once(r);
      const body = { legacy_route: r.path, method: r.method };
      if (r.action === "map") return (mapped[`${r.method} ${r.path}`] as (c: Context) => Response | Promise<Response>)(c);
      if (r.action === "308") return c.redirect(`${uiBase}/`, 308);
      if (r.action === "410") return c.json({ error: "gone", detail: "This legacy dashboard route was retired; nothing consumes it.", ...body }, 410);
      return c.json({ error: NOT_SUPPORTED, detail: "The legacy dashboard route exists, but the Control Plane has no data or mechanism for it yet.", ...body }, 501);
    };
    const m = r.method === "WS" || r.method === "MOUNT" ? "GET" : r.method;
    app.on(m, hp, handle);
    if (hp !== "/" && !hp.endsWith("}")) app.on(m, `${hp}/`, handle); // legacy stripped a trailing slash
    if (r.method === "MOUNT") app.on(m, `${hp}/*`, handle);
  }

  // /v1/audit: the CP already stores the operator-action log; this exposes it (guarded by the /v1 bearer middleware and by the shim guard).
  app.get("/v1/audit", (c) => {
    const d = denied(c);
    if (d) return d;
    const r = auditList(c);
    return r.err ?? c.json({ entries: r.rows, limit: r.limit, offset: r.offset });
  });

  // Unknown /api/* is a JSON 404 like legacy, never the SPA shell.
  app.all("/api/*", (c) => { const d = denied(c); return d ?? c.json({ detail: "Not Found" }, 404); });

  return app;
}
