// A3a-A3f: stale CP restart (FC-26), fixture ingest refusal + wider cleanup, dead-run reconcile, registered-repo issues. Hermetic HOME, headless, only recorded PIDs are signalled.
import { afterAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartStaleControlPlane } from "../../../../loki-ts/src/commands/control.ts";
import { verifyRunPid } from "../../../../loki-ts/src/util/run_pid.ts";
import { openDb } from "../../src/db/migrate.ts";
import { cleanupLeakedFixtures } from "../../src/db/fixture-cleanup.ts";
import { createApp } from "../../src/server/app.ts";
import { reconcileDeadRuns } from "../../src/server/reconcile.ts";
import { localRepos, runs } from "../../src/db/schema.ts";

process.env.LOKI_NO_BROWSER = "1";
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "cp-a3-")));
const children: { pid: number; kill: () => void }[] = [];
const servers: { stop: (f?: boolean) => void }[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } } // only PIDs this test spawned
  for (const s of servers) s.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fakeCp(version: string, recordedVersion: string) {
  const home = mkdtempSync(join(tmp, "home-"));
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ service: "loki-control", version }) });
  servers.push(srv);
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  mkdirSync(join(home, ".loki", "control"), { recursive: true });
  writeFileSync(join(home, ".loki", "control", "instance.json"), JSON.stringify({ pid: child.pid, port: srv.port, url: `http://127.0.0.1:${srv.port}`, version: recordedVersion }));
  return { env: { HOME: home } as NodeJS.ProcessEnv, child };
}

test("A3a: a CP running version X while Y is installed is restarted (recorded PID only)", async () => {
  const { env, child } = await fakeCp("1.0.0", "1.0.0");
  expect(alive(child.pid)).toBe(true);
  const restarted = await restartStaleControlPlane(env, "2.0.0", { waitMs: 5000 });
  await child.exited;
  expect(restarted).toBe(child.pid);
  expect(alive(child.pid)).toBe(false);
});

test("A3a: a CP already on the installed version is left running", async () => {
  const { env, child } = await fakeCp("2.0.0", "2.0.0");
  expect(await restartStaleControlPlane(env, "2.0.0")).toBeNull();
  expect(alive(child.pid)).toBe(true);
});

test("A3a: a recorded PID whose /health is not loki-control is never signalled", async () => {
  const home = mkdtempSync(join(tmp, "home-"));
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ service: "other" }) });
  servers.push(srv);
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  mkdirSync(join(home, ".loki", "control"), { recursive: true });
  writeFileSync(join(home, ".loki", "control", "instance.json"), JSON.stringify({ pid: child.pid, url: `http://127.0.0.1:${srv.port}`, version: "1.0.0" }));
  expect(await restartStaleControlPlane({ HOME: home } as NodeJS.ProcessEnv, "2.0.0")).toBeNull();
  expect(alive(child.pid)).toBe(true);
});

test("A3a: /health reports the started version and the installed version (the UI banner compares them)", async () => {
  const vf = join(tmp, "VERSION");
  writeFileSync(vf, "1.0.0\n");
  process.env.LOKI_VERSION_FILE = vf;
  process.env.LOKI_CONTROL_VERSION = "1.0.0";
  const { app, close } = createApp({ dbPath: ":memory:" });
  writeFileSync(vf, "2.0.0\n");
  const h = (await (await app.request("/health")).json()) as { version: string; installed_version: string };
  delete process.env.LOKI_VERSION_FILE; delete process.env.LOKI_CONTROL_VERSION;
  close();
  expect(h.version).toBe("1.0.0");
  expect(h.installed_version).toBe("2.0.0");
});

const ev = (run: string, seq: number, type: string, data: Record<string, unknown> = {}) => ({ v: 1, run, seq, ts: "2026-01-01T00:00:00.000Z", type, stage: null, data });
const post = (app: { request: (u: string, i: RequestInit) => Response | Promise<Response> }, source: string, run: string) =>
  app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source, run_id: run, events: [ev(run, 0, "run.started")] }) });

test("A3b: ingest refuses test run-id prefixes and sources under a temp dir, accepts a real run", async () => {
  delete process.env.LOKI_CONTROL_ALLOW_TEMP_SOURCES; // the package preload sets it for suites that register temp repos
  const { app, db, close } = createApp({ dbPath: ":memory:" });
  for (const id of ["e37-cline", "e37-codex", "e10-sig", "e10-sg1", "e10-sg2"]) expect((await post(app, "src1", id)).status).toBe(400);
  db.insert(localRepos).values({ sourceId: "tmpsrc", realpath: join(tmp, "fixture-repo"), name: "fx", discoveredAt: "t" }).run();
  expect((await post(app, "tmpsrc", "e10-20261004T000000Z-aaaa")).status).toBe(400);
  expect((await post(app, "src1", "e10-20261004T000000Z-bbbb")).status).toBe(200);
  process.env.LOKI_CONTROL_ALLOW_TEMP_SOURCES = "1";
  close();
});

const seedRun = (s: Database, src: string, id: string, repo: string | null, verdict: string | null = null) => {
  s.query("insert or ignore into sources (id, first_seen, last_seen) values (?, 't', 't')").run(src);
  s.query("insert into runs (source_id, run_id, origin_repo, verdict, ended_at, started_at, last_event_at, partial_usd, measured_sessions, total_sessions, input_tokens, output_tokens, last_seq, tampered) values (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, 0, 0, 0, 0, 0)").run(src, id, repo, verdict, verdict ? "2026-01-01T00:01:00Z" : null);
};
const repoRow = (s: Database, src: string, path: string) => s.query("insert into local_repos (source_id, realpath, name, discovered_at) values (?, ?, ?, 't')").run(src, path, src);

test("A3b/A3f: startup cleanup removes null-origin test rows, HOME and non-repo runs, FAILED-with-no-run-dir; keeps real rows", () => {
  const home = join(tmp, "cleanhome");
  const proj = join(home, "proj"), plain = join(home, "plain"), gone = join(home, "gone");
  mkdirSync(join(proj, ".git"), { recursive: true }); mkdirSync(join(proj, ".loki", "runs", "real-ok"), { recursive: true });
  mkdirSync(plain, { recursive: true }); mkdirSync(join(gone, ".git"), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const { sqlite } = openDb(":memory:");
    seedRun(sqlite, "s0", "e37-cline", null); seedRun(sqlite, "s0", "e37-codex", null); seedRun(sqlite, "s0", "e10-sig", null); seedRun(sqlite, "s0", "e10-sg1", null);
    seedRun(sqlite, "s0", "e10-20261004T120000Z-keep", null); // null origin but not a test id: kept
    seedRun(sqlite, "sh", "e10-20261004T011807Z-cc22", null, "FAILED"); repoRow(sqlite, "sh", home); // started in HOME
    seedRun(sqlite, "sp", "e10-20261004T011822Z-e606", null, "FAILED"); repoRow(sqlite, "sp", plain); // non-repo dir
    seedRun(sqlite, "sg", "e10-20261004T020000Z-nodir", null, "FAILED"); repoRow(sqlite, "sg", gone); // FAILED, no run dir
    seedRun(sqlite, "sr", "real-ok", "acme/real", "FAILED"); repoRow(sqlite, "sr", proj); // FAILED but has a run dir
    seedRun(sqlite, "sr", "real-run", "acme/real", "VERIFIED"); // finished, run dir irrelevant
    expect(cleanupLeakedFixtures(sqlite, ["/nonexistent-temp-root"])).toBe(7); // the fixture dirs live under tmpdir, so the temp-root rule is neutralised to test the new rules alone
    const left = (sqlite.query("select run_id from runs order by run_id").all() as { run_id: string }[]).map((r) => r.run_id);
    expect(left).toEqual(["e10-20261004T120000Z-keep", "real-ok", "real-run"]);
    expect(cleanupLeakedFixtures(sqlite, ["/nonexistent-temp-root"])).toBe(0);
  } finally { process.env.HOME = saved; }
});

test("A3e: a run with no live worker PID and no terminal event becomes stopped after the grace period", () => {
  const repo = join(tmp, "recon-repo");
  mkdirSync(join(repo, ".loki", "runs"), { recursive: true });
  const { db, sqlite } = openDb(":memory:");
  seedRun(sqlite, "sx", "e10-dead", "acme/r"); repoRow(sqlite, "sx", repo);
  seedRun(sqlite, "sx", "e10-live", "acme/r");
  seedRun(sqlite, "sx", "e10-recent", "acme/r");
  sqlite.query("update runs set last_event_at = ? where run_id = 'e10-recent'").run(new Date().toISOString());
  seedRun(sqlite, "elsewhere", "e10-remote", "acme/r"); // repo not on this machine: cannot be checked, left alone
  const verify = ((_dir: string, id: string) => (id === "e10-live" ? { ok: true, pid: 1234 } : { ok: false, reason: "stale" })) as typeof verifyRunPid;
  expect(reconcileDeadRuns(db, { verify })).toBe(1);
  const rows = Object.fromEntries(db.select().from(runs).all().map((r) => [r.runId, r]));
  expect(rows["e10-dead"]!.endedAt).not.toBeNull();
  expect(rows["e10-dead"]!.verdict).toBe("STOPPED");
  expect(rows["e10-live"]!.endedAt).toBeNull();
  expect(rows["e10-recent"]!.endedAt).toBeNull();
  expect(rows["e10-remote"]!.endedAt).toBeNull();
});

test("repos/issues: registered repo only, fixed argv, 400 unregistered, 502 on gh failure", async () => {
  const calls: string[][] = [];
  let fail = false;
  const gh = async (argv: string[]) => { calls.push(argv); return fail ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: JSON.stringify([{ number: 7, title: "Bug", url: "https://x/7", extra: 1 }]), stderr: "" }; };
  const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true, ghImpl: gh });
  db.insert(localRepos).values({ sourceId: "srcw", realpath: join(tmp, "widgets"), name: "widgets", discoveredAt: "t" }).run();
  db.insert(runs).values({ sourceId: "srcw", runId: "r1", originRepo: "acme/widgets", partialUsd: 0, measuredSessions: 0, totalSessions: 0, inputTokens: 0, outputTokens: 0, lastSeq: 0, tampered: 0 }).run();
  const get = (q: string) => app.fetch(new Request(`http://127.0.0.1:1234/v1/repos/issues?repo=${encodeURIComponent(q)}`, { headers: { host: "127.0.0.1:1234" } }), { requestIP: () => ({ address: "127.0.0.1" }) });
  expect((await get("nope; evil")).status).toBe(400);
  expect((await get("acme/widgets")).status).toBe(400); // owner/name is not a registered display name
  expect(calls.length).toBe(0);
  const ok = await get("widgets");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ issues: [{ number: 7, title: "Bug", url: "https://x/7" }] });
  expect(calls).toEqual([["issue", "list", "--repo", "acme/widgets", "--state", "open", "--json", "number,title,url", "--limit", "50"]]);
  fail = true;
  expect((await get("widgets")).status).toBe(502);
  close();
});
