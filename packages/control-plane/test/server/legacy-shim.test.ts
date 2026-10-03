// CPE-24 legacy dashboard shim: mapped routes (status and shape), 308 for HTML, 501 and 410 for the rest, auth parity with the legacy server, first-hit logging,
// and agreement between the route table and docs/v10/CP-ENTERPRISE-UI.md section 5.2.
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../../src/db/migrate.ts";
import { audit } from "../../src/db/schema.ts";
import { ingest } from "../../src/server/ingest.ts";
import { tokenGuard } from "../../src/server/auth.ts";
import { LEGACY_ROUTES } from "../../src/server/legacy/routes.ts";
import { legacyShim, resetLegacyLog, type LegacyShimOpts } from "../../src/server/legacy/shim.ts";

const evs = readFileSync(join(import.meta.dir, "../fixtures/runs/verified-pr/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const RUN = evs[0].run as string;
const DONE = "aaaaaaaaaaaaaaaa", LIVE = "bbbbbbbbbbbbbbbb";
const NONE: Record<string, string | undefined> = {};

const mk = (o: Partial<LegacyShimOpts> = {}) => {
  const { db, sqlite } = openDb(":memory:");
  const lines: string[] = [];
  const app = new Hono();
  if (o.token) app.use("/v1/*", tokenGuard(o.token));
  app.route("/", legacyShim({ db, env: NONE, log: (l) => lines.push(l), version: "9.9.9", ...o }));
  return { app, db, sqlite, lines };
};
const seeded = () => {
  const m = mk();
  expect(ingest(m.db, { source: DONE, run_id: RUN, events: evs }).status).toBe(200);
  expect(ingest(m.db, { source: LIVE, run_id: RUN, events: evs.slice(0, 24) }).status).toBe(200);
  m.db.insert(audit).values([
    { ts: "2026-10-01T10:00:00.000Z", action: "run.remove", actor: "loopback", detail: { source: DONE } },
    { ts: "2026-10-02T10:00:00.000Z", action: "prune", actor: "loopback", detail: { removed: 3 } },
  ]).run();
  return m;
};
const peer = (address: string) => ({ requestIP: () => ({ address }) });
const LOOP = peer("127.0.0.1");
const get = (app: Hono, path: string, headers: Record<string, string> = {}, method = "GET", env: object | null = LOOP) => app.request(path, { method, headers, redirect: "manual" }, env ?? undefined);
const fill = (p: string) => p.replace(/\{[A-Za-z_]+:path\}/g, "a/b").replace(/\{[A-Za-z_]+\}/g, "x");

beforeEach(() => resetLegacyLog());

test("the route table and the doc table agree (method, path, action) and the counts are the documented ones", () => {
  const doc = readFileSync(join(import.meta.dir, "../../../../docs/v10/CP-ENTERPRISE-UI.md"), "utf8");
  const rows = [...doc.matchAll(/^\| (GET|POST|PUT|DELETE|PATCH|WS|MOUNT) `([^`]+)` \|.*\| ([^|]+) \|$/gm)].map((m) => ({ method: m[1] as string, path: m[2] as string, shim: (m[3] as string).trim() }));
  expect(rows.length).toBeGreaterThan(0);
  const code = (s: string) => (s === "map" ? "map" : s.startsWith("308") ? "308" : s.startsWith("410") ? "410" : s.startsWith("501") ? "501" : "none");
  const expected = rows.filter((r) => code(r.shim) !== "none").map((r) => `${r.method} ${r.path} ${code(r.shim)}`);
  expect(LEGACY_ROUTES.map((r) => `${r.method} ${r.path} ${r.action}`)).toEqual(expected);
  const count = (a: string) => LEGACY_ROUTES.filter((r) => r.action === a).length;
  for (const a of ["map", "308", "410", "501"]) expect(count(a)).toBe(rows.filter((r) => code(r.shim) === a).length);
});

test("GET /.well-known/agent.json: 200, open, A2A card without capabilities the CP cannot back", async () => {
  const { app, sqlite } = mk();
  const r = await get(app, "/.well-known/agent.json");
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(b).toMatchObject({ name: "Loki Mode", version: "9.9.9", capabilities: { streaming: false }, enterprise: { multi_tenant: false, rbac: false, sso: false } });
  expect(b.endpoints.runs).toBe("/v1/runs");
  sqlite.close();
});

test("GET /api/status: idle with no runs, running with a live run (count, phase, provider)", async () => {
  const empty = mk();
  const e = (await (await get(empty.app, "/api/status")).json()) as any;
  expect(e).toMatchObject({ status: "idle", version: "9.9.9", active_sessions: 0, database_connected: true, phase: "" });
  expect(e.uptime_seconds).toBeGreaterThanOrEqual(0);
  const { app, sqlite } = seeded();
  const s = (await (await get(app, "/api/status")).json()) as any;
  expect(s).toMatchObject({ status: "running", active_sessions: 1, phase: "commit" });
  expect(typeof s.provider).toBe("string");
  expect("running_agents" in s).toBe(false); // no data behind it: omitted, not zero
  sqlite.close(); empty.sqlite.close();
});

test("GET /api/v2/runs: a bare array of runs with id, filters, paging and 4xx on bad input", async () => {
  const { app, sqlite } = seeded();
  const all = (await (await get(app, "/api/v2/runs")).json()) as any[];
  expect(all.length).toBe(2);
  expect(all.map((r) => r.id).sort()).toEqual([`${DONE}:${RUN}`, `${LIVE}:${RUN}`]);
  expect(all[0]).toMatchObject({ run_id: RUN, created_at: all[0].started_at });
  const running = (await (await get(app, "/api/v2/runs?status=running")).json()) as any[];
  expect(running.map((r) => r.id)).toEqual([`${LIVE}:${RUN}`]);
  const completed = (await (await get(app, "/api/v2/runs?status=completed")).json()) as any[];
  expect(completed.map((r) => [r.id, r.verdict])).toEqual([[`${DONE}:${RUN}`, "VERIFIED"]]);
  expect(((await (await get(app, "/api/v2/runs?limit=1")).json()) as any[]).length).toBe(1);
  expect(((await (await get(app, "/api/v2/runs?limit=1&offset=1")).json()) as any[]).length).toBe(1);
  expect((await get(app, "/api/v2/runs?limit=0")).status).toBe(422);
  expect((await get(app, "/api/v2/runs?limit=1001")).status).toBe(422);
  expect((await get(app, "/api/v2/runs?status=bogus")).status).toBe(400);
  expect((await get(app, "/api/v2/runs?project_id=1")).status).toBe(400);
  sqlite.close();
});

test("GET /api/v2/runs/{run_id}: composite id and bare run id resolve, legacy integer ids and unknown ids are 404 with a legacy detail body", async () => {
  const { app, sqlite } = seeded();
  const d = (await (await get(app, `/api/v2/runs/${encodeURIComponent(`${DONE}:${RUN}`)}`)).json()) as any;
  expect(d).toMatchObject({ id: `${DONE}:${RUN}`, verdict: "VERIFIED", status: "completed" });
  expect(Array.isArray(d.stages)).toBe(true);
  expect((await get(app, `/api/v2/runs/${RUN}`)).status).toBe(200);
  const nf = await get(app, "/api/v2/runs/12345");
  expect(nf.status).toBe(404);
  expect(await nf.json()).toEqual({ detail: "Run not found" });
  expect((await get(app, `/api/v2/runs/${LIVE}:no-such-run`)).status).toBe(404);
  sqlite.close();
});

test("GET /api/v2/runs/{run_id}/timeline: phases, current_phase and events; 404 for an unknown run", async () => {
  const { app, sqlite } = seeded();
  const t = (await (await get(app, `/api/v2/runs/${LIVE}:${RUN}/timeline`)).json()) as any;
  expect(t.run_id).toBe(`${LIVE}:${RUN}`);
  expect(t.current_phase).toBe("commit");
  expect(t.phases.length).toBeGreaterThan(0);
  expect(t.phases[0]).toHaveProperty("name");
  expect(t.events.length).toBe(24);
  expect(Object.keys(t.events[0]).sort()).toEqual(["seq", "stage", "ts", "type"]);
  expect((await get(app, "/api/v2/runs/nope:nope/timeline")).status).toBe(404);
  sqlite.close();
});

test("GET /api/v2/audit and /v1/audit: newest first, filters, paging; resource_type is refused, not ignored", async () => {
  const { app, sqlite } = seeded();
  const a = (await (await get(app, "/api/v2/audit")).json()) as any[];
  expect(a.map((x) => x.action)).toEqual(["prune", "run.remove"]);
  expect(a[0]).toMatchObject({ actor: "loopback", timestamp: "2026-10-02T10:00:00.000Z", details: { removed: 3 } });
  expect(((await (await get(app, "/api/v2/audit?action=run.remove")).json()) as any[]).length).toBe(1);
  expect(((await (await get(app, "/api/v2/audit?start_date=2026-10-02")).json()) as any[]).length).toBe(1);
  expect(((await (await get(app, "/api/v2/audit?end_date=2026-10-01")).json()) as any[]).length).toBe(1);
  expect(((await (await get(app, "/api/v2/audit?limit=1&offset=1")).json()) as any[]).map((x) => x.action)).toEqual(["run.remove"]);
  expect((await get(app, "/api/v2/audit?resource_type=run")).status).toBe(400);
  expect((await get(app, "/api/v2/audit?limit=0")).status).toBe(422);
  const v1 = (await (await get(app, "/v1/audit")).json()) as any;
  expect(v1.entries.map((x: any) => x.action)).toEqual(["prune", "run.remove"]);
  expect(v1).toMatchObject({ limit: 100, offset: 0 });
  sqlite.close();
});

test("HTML routes 308 to the CP UI; on the CP app itself '/' is left to the SPA, a separately mounted shim redirects it", async () => {
  const { app, sqlite } = mk();
  for (const p of ["/start", "/cost", "/trust", "/lab", "/lab/anything"]) {
    const r = await get(app, p);
    expect([p, r.status, r.headers.get("location")]).toEqual([p, 308, "/"]);
  }
  expect((await get(app, "/")).status).toBe(404); // not registered: the CP SPA fallback serves it
  const sep = mk({ uiBase: "http://127.0.0.1:9999/" });
  const r = await get(sep.app, "/");
  expect([r.status, r.headers.get("location")]).toEqual([308, "http://127.0.0.1:9999/"]);
  expect((await get(sep.app, "/cost")).headers.get("location")).toBe("http://127.0.0.1:9999/");
  sqlite.close(); sep.sqlite.close();
});

test("every USED-but-unbacked route answers an explicit 501, every unused one 410, with no faked success", async () => {
  const { app, sqlite } = mk();
  let n501 = 0, n410 = 0;
  for (const r of LEGACY_ROUTES) {
    if (r.action !== "501" && r.action !== "410") continue;
    const res = await get(app, fill(r.path), {}, r.method === "WS" ? "GET" : r.method);
    const b = (await res.json()) as any;
    expect([r.method, r.path, res.status]).toEqual([r.method, r.path, r.action === "501" ? 501 : 410]);
    expect(b).toMatchObject({ legacy_route: r.path, method: r.method });
    if (r.action === "501") { n501++; expect(b.error).toBe("not yet supported by the Control Plane"); } else { n410++; expect(b.error).toBe("gone"); }
  }
  expect([n501, n410]).toEqual([LEGACY_ROUTES.filter((r) => r.action === "501").length, LEGACY_ROUTES.filter((r) => r.action === "410").length]);
  sqlite.close();
});

test("the named MISSING routes (start, audit verify, replay, cancel) are 501 and the dropped ones (api-keys, tenants, /ws) are 410 naming a replacement", async () => {
  const { app, sqlite } = mk();
  const cases: [string, string][] = [
    ["POST", "/api/control/start"],
    ["GET", "/api/v2/audit/verify"], ["POST", "/api/v2/runs/1/replay"], ["POST", "/api/v2/runs/1/cancel"],
  ];
  for (const [m, p] of cases) expect([m, p, (await get(app, p, {}, m)).status]).toEqual([m, p, 501]);
  const dropped: [string, string][] = [["GET", "/api/v2/api-keys"], ["POST", "/api/v2/api-keys"], ["DELETE", "/api/v2/api-keys/k1"], ["POST", "/api/v2/api-keys/k1/rotate"], ["GET", "/api/v2/tenants"], ["POST", "/api/v2/tenants"], ["GET", "/ws"]];
  for (const [m, p] of dropped) {
    const r = await get(app, p, {}, m);
    expect([m, p, r.status]).toEqual([m, p, 410]);
    expect(typeof ((await r.json()) as any).replacement).toBe("string");
  }
  sqlite.close();
});

test("auth parity: a CP token is required on every legacy-guarded route, open routes stay open", async () => {
  const { app, sqlite } = mk({ token: "s3cret" });
  const bearer = { authorization: "Bearer s3cret" };
  const guarded: [string, number][] = [["/api/status", 200], ["/api/v2/runs", 200], ["/api/v2/audit", 200], ["/v1/audit", 200], ["/api/cost", 200], ["/metrics", 200], ["/api/memory/stats", 410], ["/start", 308]];
  for (const [p, ok] of guarded) {
    const none = await get(app, p);
    expect([p, none.status, none.headers.get("www-authenticate")]).toEqual([p, 401, "Bearer"]);
    expect([p, (await get(app, p, { authorization: "Bearer nope" })).status]).toEqual([p, 401]);
    expect([p, (await get(app, p, bearer)).status]).toEqual([p, ok]);
  }
  expect((await get(app, "/api/status", bearer)).status).toBe(200);
  expect((await get(app, "/api/control/pause", {}, "POST")).status).toBe(401);
  expect((await get(app, "/api/control/start", bearer, "POST")).status).toBe(501);
  for (const p of ["/.well-known/agent.json", "/api/enterprise/status", "/api/auth/info", "/api/providers/models", "/docs", "/openapi.json"]) {
    expect([p, (await get(app, p)).status === 401]).toEqual([p, false]);
  }
  sqlite.close();
});

test("auth parity: legacy enterprise auth or OIDC on with no CP token fails closed; both off serves loopback peers only like legacy", async () => {
  for (const env of [{ LOKI_ENTERPRISE_AUTH: "true" }, { LOKI_ENTERPRISE_AUTH: "1" }, { LOKI_ENTERPRISE_AUTH: "YES" }, { LOKI_OIDC_ISSUER: "https://idp.test", LOKI_OIDC_CLIENT_ID: "cid" }]) {
    const { app, sqlite } = mk({ env });
    for (const [m, p] of [["GET", "/api/status"], ["GET", "/api/v2/runs"], ["GET", "/api/v2/audit"], ["POST", "/api/control/pause"], ["GET", "/api/cost"], ["GET", "/start"]] as const) {
      expect([JSON.stringify(env), m, p, (await get(app, p, {}, m)).status]).toEqual([JSON.stringify(env), m, p, 401]);
    }
    expect((await get(app, "/.well-known/agent.json")).status).toBe(200);
    sqlite.close();
  }
  for (const env of [{}, { LOKI_ENTERPRISE_AUTH: "false" }, { LOKI_OIDC_ISSUER: "https://idp.test" }]) {
    const { app, sqlite } = mk({ env });
    expect((await get(app, "/api/status")).status).toBe(200);
    expect((await get(app, "/api/control/start", {}, "POST")).status).toBe(501);
    sqlite.close();
  }
});

test("no token and legacy auth off: a non-loopback or unknown socket peer is 403 on every guarded route, whatever Host says", async () => {
  const { app, sqlite } = seeded();
  const spoof = { host: "127.0.0.1:1" };
  for (const p of ["/api/status", "/api/v2/runs", "/api/v2/audit", "/v1/audit", "/api/control/pause", "/lab/api/x", "/api/nope"]) {
    expect([p, "lan", (await get(app, p, spoof, "GET", peer("10.0.0.5"))).status]).toEqual([p, "lan", 403]);
    expect([p, "none", (await get(app, p, spoof, "GET", {})).status]).toEqual([p, "none", 403]);
    expect([p, "noenv", (await get(app, p, spoof, "GET", null)).status]).toEqual([p, "noenv", 403]);
  }
  expect((await get(app, "/api/control/pause", spoof, "POST", peer("10.0.0.5"))).status).toBe(403);
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    expect([ip, (await get(app, "/api/status", {}, "GET", peer(ip))).status]).toEqual([ip, 200]);
    expect([ip, (await get(app, "/v1/audit", {}, "GET", peer(ip))).status]).toEqual([ip, 200]);
  }
  // open routes stay open to any peer, as in legacy
  expect((await get(app, "/.well-known/agent.json", {}, "GET", peer("10.0.0.5"))).status).toBe(200);
  sqlite.close();
});

test("/v1/audit carries its own guard: legacy auth on with no token is 401 even without the /v1 middleware", async () => {
  const { app, sqlite } = mk({ env: { LOKI_ENTERPRISE_AUTH: "true" } });
  expect((await get(app, "/v1/audit")).status).toBe(401);
  expect((await get(app, "/v1/audit", { authorization: "Bearer x" })).status).toBe(401);
  sqlite.close();
});

test("/lab/api/* is 501 JSON on every method (not a 308); /lab pages still 308", async () => {
  const { app, sqlite } = mk();
  for (const m of ["GET", "POST", "PUT", "DELETE"]) {
    const r = await get(app, "/lab/api/anything/deep", {}, m);
    expect([m, r.status, r.headers.get("location")]).toEqual([m, 501, null]);
    expect(((await r.json()) as any).error).toContain("not yet supported");
  }
  expect((await get(app, "/lab/page")).status).toBe(308);
  sqlite.close();
});

test("unknown /api/* is a JSON 404 and a trailing slash on a mapped route is served like legacy", async () => {
  const { app, sqlite } = mk();
  const r = await get(app, "/api/does/not/exist");
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ detail: "Not Found" });
  expect((await get(app, "/api/status/")).status).toBe(200);
  expect((await get(app, "/api/v2/runs/")).status).toBe(200);
  expect((await get(app, "/api/control/start/", {}, "POST")).status).toBe(501);
  sqlite.close();
});

test("legacy enterprise auth on AND a CP token: the token is the gate", async () => {
  const { app, sqlite } = mk({ token: "t0k", env: { LOKI_ENTERPRISE_AUTH: "true" } });
  expect((await get(app, "/api/status")).status).toBe(401);
  expect((await get(app, "/api/status", { authorization: "Bearer t0k" })).status).toBe(200);
  sqlite.close();
});

test("first hit per process logs one migrate line per route, never again, and nothing on a 401", async () => {
  const { app, sqlite, lines } = mk({ token: "t" });
  await get(app, "/api/status");
  expect(lines).toEqual([]);
  const h = { authorization: "Bearer t" };
  await get(app, "/api/status", h); await get(app, "/api/status", h);
  await get(app, "/api/v2/runs/a:b", h);
  await get(app, "/start", h);
  await get(app, "/api/control/start", h, "POST"); await get(app, "/api/control/start", h, "POST");
  await get(app, "/api/proofs/summary", h);
  expect(lines).toEqual([
    "legacy dashboard route /api/status is served by the Control Plane; migrate to /v1/runs",
    "legacy dashboard route /api/v2/runs/{run_id} is served by the Control Plane; migrate to /v1/runs/:id",
    "legacy dashboard route /start is served by the Control Plane; migrate to /",
    "legacy dashboard route /api/control/start is not served by the Control Plane (501); no /v1 equivalent yet",
    "legacy dashboard route /api/proofs/summary is not served by the Control Plane (501); no /v1 equivalent yet",
  ]);
  sqlite.close();
});
