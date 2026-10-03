// Run removal: `loki control prune` (direct DB) and DELETE /v1/runs/:source/:run. Temp DBs and a sandbox HOME only.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { createApp } from "../../src/server/app.ts";
import { runControl } from "../../../../loki-ts/src/commands/control.ts";

const tmp = mkdtempSync(join(tmpdir(), "cp-prune-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function seed(path: string): void {
  const { sqlite } = openDb(path);
  const src = sqlite.query("insert into sources (id, first_seen, last_seen) values (?, ?, ?)");
  const ev = sqlite.query("insert into events (source_id, run_id, seq, ts, type, stage, data, line_sha256, received_at) values (?, ?, 1, ?, 'run.started', null, '{}', 'x', ?)");
  const run = sqlite.query("insert into runs (source_id, run_id, origin_repo, started_at, partial_usd, measured_sessions, total_sessions, input_tokens, output_tokens, last_seq, tampered) values (?, ?, ?, ?, 0, 0, 0, 0, 0, 1, 0)");
  for (const s of ["srcA", "srcB"]) src.run(s, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  const rows: [string, string, string, string][] = [
    ["srcA", "w-old", "acme/widget", "2026-01-05T10:00:00Z"],
    ["srcA", "w-new", "acme/widget", "2026-09-05T10:00:00Z"],
    ["srcB", "r-old", "real/project", "2026-01-06T10:00:00Z"],
    ["srcB", "r-new", "real/project", "2026-09-06T10:00:00Z"],
  ];
  for (const [s, r, repo, at] of rows) { run.run(s, r, repo, at); ev.run(s, r, at, at); }
  sqlite.close();
}
/** The startup fixture cleanup (FC-07b) removes acme/widget; server tests need the seeded rows to survive a start. */
function keepAtStart(path: string): void {
  const { sqlite } = openDb(path);
  sqlite.query("update runs set origin_repo = 'acme/gadget' where origin_repo = 'acme/widget'").run();
  sqlite.close();
}
const counts = (path: string) => {
  const d = new Database(path, { readonly: true });
  const q = (sql: string) => (d.query(sql).get() as { n: number }).n;
  const o = { runs: q("select count(*) n from runs"), events: q("select count(*) n from events"), sources: q("select count(*) n from sources"), audit: q("select count(*) n from audit where action not like 'fixture.cleanup%'") };
  d.close();
  return o;
};
async function cli(args: string[], db: string): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const wo = process.stdout.write.bind(process.stdout), we = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try { return { code: await runControl(["prune", ...args], { HOME: tmp, LOKI_CONTROL_DB: db }), out, err }; }
  finally { process.stdout.write = wo; process.stderr.write = we; }
}
const fresh = (name: string): string => { const p = join(tmp, `${name}.db`); seed(p); return p; };

test("prune by repo removes only that repo's runs, events and the orphaned source", async () => {
  const db = fresh("repo");
  const r = await cli(["--repo", "acme/widget"], db);
  expect(r.code).toBe(0);
  expect(r.out).toContain("removed 2 runs, 2 events, 1 orphaned sources");
  expect(counts(db)).toEqual({ runs: 2, events: 2, sources: 1, audit: 1 });
});

test("prune by date removes runs started before it, keeps newer and other sources' rows", async () => {
  const db = fresh("date");
  const r = await cli(["--before", "2026-06-01"], db);
  expect(r.code).toBe(0);
  expect(r.out).toContain("removed 2 runs, 2 events, 0 orphaned sources");
  expect(counts(db)).toMatchObject({ runs: 2, events: 2, sources: 2 });
});

test("combined filters are ANDed", async () => {
  const db = fresh("both");
  const r = await cli(["--repo", "acme/widget", "--before", "2026-06-01T00:00:00Z"], db);
  expect(r.out).toContain("removed 1 runs, 1 events, 0 orphaned sources");
  expect(counts(db)).toMatchObject({ runs: 3, events: 3, sources: 2 });
});

test("dry-run reports counts and removes and audits nothing", async () => {
  const db = fresh("dry");
  const r = await cli(["--repo", "acme/widget", "--dry-run"], db);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would remove 2 runs, 2 events, 1 orphaned sources");
  expect(counts(db)).toEqual({ runs: 4, events: 4, sources: 2, audit: 0 });
});

test("bad dates exit 2 and change nothing", async () => {
  const db = fresh("bad");
  for (const bad of ["yesterday", "2026-13-01", "2026-02-31", "10/01/2026", "2026-10-01T10:00", ""]) {
    const r = await cli(["--before", bad], db);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a valid ISO 8601 date");
  }
  expect(counts(db).runs).toBe(4);
});

test("no filter and unknown flags are refused with exit 2", async () => {
  const db = fresh("nofilter");
  expect((await cli([], db)).code).toBe(2);
  expect((await cli(["--dry-run"], db)).code).toBe(2);
  expect((await cli(["--everything"], db)).code).toBe(2);
  expect((await cli(["--repo"], db)).code).toBe(2);
  expect((await cli(["--repo", "not-a-slug"], db)).code).toBe(2);
  expect(counts(db).runs).toBe(4);
});

test("missing DB is not created", async () => {
  const db = join(tmp, "absent.db");
  const r = await cli(["--repo", "acme/widget"], db);
  expect(r.code).toBe(0);
  expect(existsSync(db)).toBe(false);
});

test("prune waits on a concurrent writer instead of failing (WAL + busy timeout)", async () => {
  const db = fresh("busy");
  // a separate process holds the write lock for 400 ms (prune is synchronous, so an in-process holder could never release)
  const holder = Bun.spawn(["bun", "-e", `const {Database}=require("bun:sqlite");const d=new Database(process.argv[1]);d.exec("PRAGMA busy_timeout=5000;BEGIN IMMEDIATE");console.log("locked");setTimeout(()=>{d.exec("COMMIT");d.close()},400)`, db], { stdout: "pipe" });
  const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  const r = await cli(["--repo", "acme/widget"], db);
  await holder.exited;
  expect(r.code).toBe(0);
  expect(counts(db).runs).toBe(2);
});

// ---- DELETE endpoint (loopback-only, like /v1/start) ----
const H = { "content-type": "application/json", host: "127.0.0.1:47821" };
type Srv = { fetch: (r: Request, env?: unknown) => Response | Promise<Response> };
function served(opts: { token?: string } = {}) {
  const p = join(tmp, `srv-${Math.random().toString(36).slice(2)}.db`);
  seed(p);
  keepAtStart(p);
  const c = createApp({ dbPath: p, loopbackOnly: true, ...opts });
  return { ...c, p };
}
const del = (app: Srv, path: string, headers: Record<string, string> = H, ip = "127.0.0.1") =>
  app.fetch(new Request(`http://127.0.0.1:47821${path}`, { method: "DELETE", headers }), { requestIP: () => ({ address: ip }) });
const get = (app: Srv, path: string) => app.fetch(new Request(`http://127.0.0.1:47821${path}`, { headers: { host: "127.0.0.1:47821" } }), { requestIP: () => ({ address: "127.0.0.1" }) });

test("DELETE 200 returns resulting state and audits first; run is gone", async () => {
  const { app, p } = served();
  const r = await del(app, "/v1/runs/srcA/w-old");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, removed: { runs: 1, events: 1, sources: 0 }, remaining_runs: 3 });
  expect((await get(app, "/v1/runs/srcA/w-old")).status).toBe(404);
  const d = new Database(p, { readonly: true });
  const row = d.query("select action, detail from audit where action not like 'fixture.cleanup%'").get() as { action: string; detail: string };
  expect(row.action).toBe("run.remove");
  expect(JSON.parse(row.detail)).toMatchObject({ source_id: "srcA", run_id: "w-old" });
  d.close();
});

test("DELETE of the last run in a source drops only that orphaned source", async () => {
  const { app, p } = served();
  const extra = new Database(p);
  extra.query("insert into sources (id, first_seen, last_seen) values ('unrelated', 'x', 'x')").run();
  extra.close();
  await del(app, "/v1/runs/srcA/w-old");
  const r = await del(app, "/v1/runs/srcA/w-new");
  expect(((await r.json()) as { removed: { sources: number } }).removed.sources).toBe(1);
  expect(counts(p).sources).toBe(2); // srcB and the unrelated empty source survive
});

test("DELETE unknown run is 404 and writes no audit row", async () => {
  const { app, p } = served();
  expect((await del(app, "/v1/runs/srcA/nope")).status).toBe(404);
  expect(counts(p).audit).toBe(0);
});

test("DELETE refuses cross-origin, non-JSON, a non-loopback peer, a foreign Host, and (with a token) a missing bearer; nothing is deleted", async () => {
  const { app, p } = served({ token: "tok" });
  const auth = { ...H, authorization: "Bearer tok" };
  expect((await del(app, "/v1/runs/srcA/w-old", { ...auth, origin: "http://evil.example" })).status).toBe(403);
  expect((await del(app, "/v1/runs/srcA/w-old", { ...auth, origin: "not a url" })).status).toBe(403);
  expect((await del(app, "/v1/runs/srcA/w-old", { ...auth, "content-type": "text/plain" })).status).toBe(400);
  expect((await del(app, "/v1/runs/srcA/w-old", auth, "10.0.0.5")).status).toBe(403);
  expect((await del(app, "/v1/runs/srcA/w-old", { ...auth, host: "evil.example" })).status).toBe(403);
  expect((await del(app, "/v1/runs/srcA/w-old", H)).status).toBe(401);
  expect(counts(p)).toMatchObject({ runs: 4, audit: 0 });
  expect((await del(app, "/v1/runs/srcA/w-old", { ...auth, origin: "http://127.0.0.1:47821" })).status).toBe(200);
});

test("DELETE is not registered on a non-loopback server", async () => {
  const p = join(tmp, "nonlo.db");
  seed(p); keepAtStart(p);
  const { app } = createApp({ dbPath: p, token: "tok" });
  const r = await app.request("/v1/runs/srcA/w-old", { method: "DELETE", headers: { ...H, authorization: "Bearer tok" } });
  expect(r.status).toBe(404);
  expect(counts(p).runs).toBe(4);
});

// ---- packaged artifact: the bundled CLI, from a cwd outside the repo, against a DB built through migrations ----
const DIST = join(import.meta.dir, "../../../../loki-ts/dist/loki.js");
const outside = mkdtempSync(join(tmpdir(), "cp-outside-"));
const dist = (args: string[]) => Bun.spawnSync(["bun", DIST, "control", "prune", ...args], { cwd: outside, env: { PATH: process.env.PATH ?? "", HOME: tmp } });
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test.skipIf(!existsSync(DIST))("bundled dist: dry-run is read-only, real prune works, from outside the repo", () => {
  const db = fresh("dist");
  const before = new Database(db, { readonly: true }).query("pragma journal_mode").get();
  const d = dist(["--repo", "acme/widget", "--dry-run", "--db", db]);
  expect(text(d.stderr)).not.toContain("migrations folder");
  expect(d.exitCode).toBe(0);
  expect(text(d.stdout)).toContain("would remove 2 runs");
  expect(counts(db)).toEqual({ runs: 4, events: 4, sources: 2, audit: 0 });
  expect(new Database(db, { readonly: true }).query("pragma journal_mode").get()).toEqual(before);
  const r = dist(["--repo", "acme/widget", "--db", db]);
  expect(r.exitCode).toBe(0);
  expect(text(r.stdout)).toContain("removed 2 runs, 2 events, 1 orphaned sources");
  expect(counts(db)).toEqual({ runs: 2, events: 2, sources: 1, audit: 1 });
});

test.skipIf(!existsSync(DIST))("bundled dist: a non-database file gives a clean message, no stack trace", () => {
  const bad = join(tmp, "garbage.db");
  Bun.write(bad, "this is not sqlite");
  const r = dist(["--repo", "acme/widget", "--db", bad]);
  expect(r.exitCode).toBe(1);
  expect(text(r.stderr)).toContain("nothing was removed");
  expect(text(r.stderr)).not.toContain("    at ");
});
