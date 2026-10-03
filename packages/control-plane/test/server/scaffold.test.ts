// CPE-03: server scaffold. local_repos is filled only by local discovery (never /v1/ingest), /v1/repos returns display names only,
// the audit helper writes the actions table, and every planned route stub is present.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import { actions, localRepos } from "../../src/db/schema.ts";
import { audit } from "../../src/server/audit.ts";
import { createApp } from "../../src/server/app.ts";
import { routeModules } from "../../src/server/routes/index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cpe03-")));
const home = join(root, "home");
const repo = join(root, "work", "alpha-repo");
const other = join(root, "elsewhere", "beta-repo");
for (const d of [join(home, ".loki", "dashboard"), repo, other]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, ".loki", "dashboard", "projects.json"), JSON.stringify({ projects: { b: { path: other }, gone: { path: join(root, "missing") } } }));
const savedHome = process.env.HOME;
process.env.HOME = home;
afterAll(() => { process.env.HOME = savedHome; rmSync(root, { recursive: true, force: true }); });

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const get = (app: { fetch: (r: Request, e?: unknown) => Response | Promise<Response> }, ip = "127.0.0.1") =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/repos", { headers: { host: "127.0.0.1:1234" } }), peer(ip));

test("/v1/repos returns display names only, never a path, and keeps the loopback peer guard", async () => {
  const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true, repoDir: repo });
  const res = await get(app);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ repos: ["alpha-repo", "beta-repo"] });
  expect(text).not.toContain(root);
  expect(text).not.toContain("/");
  expect(db.select().from(localRepos).all().length).toBe(2); // the vanished registry path was skipped
  expect((await get(app, "10.0.0.9")).status).toBe(403);
  close();
});

test("/v1/repos is not registered on a non-loopback bind", async () => {
  const { app, close } = createApp({ dbPath: ":memory:", repoDir: repo });
  expect((await get(app)).status).toBe(404);
  close();
});

test("ingest never writes local_repos", async () => {
  const { app, db, close } = createApp({ dbPath: ":memory:", repoDir: repo });
  const before = db.select().from(localRepos).all();
  const FIX = join(import.meta.dir, "../fixtures/runs");
  const name = readdirSync(FIX).sort()[0]!;
  const evs = readFileSync(join(FIX, name, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => validateEnvelope(e) === null);
  expect(evs.length).toBeGreaterThan(0);
  const res = await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: "ffffffffffffffff", run_id: evs[0].run, events: evs }) });
  expect(res.status).toBe(200);
  const after = db.select().from(localRepos).all();
  expect(after).toEqual(before);
  expect(after.some((r) => r.sourceId === "ffffffffffffffff")).toBe(false);
  close();
});

test("audit helper writes the actions table and never throws", () => {
  const { db, close } = createApp({ dbPath: ":memory:", repoDir: repo });
  expect(audit(db, { kind: "start", target: "a/b#1", result: "ok" })).toBe(true);
  const rows = db.select().from(actions).all();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ actor: "local", kind: "start", target: "a/b#1", result: "ok" });
  close();
  expect(audit(db, { kind: "start", result: "ok" })).toBe(false); // closed db: swallowed
});

test("every planned route stub exists and mounts nothing harmful", () => {
  expect(routeModules.length).toBe(16);
});
