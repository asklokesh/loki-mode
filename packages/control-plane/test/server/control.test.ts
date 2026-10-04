// CPE-09 run control: stop only signals a pid whose run.pid belongs to the run, is alive and has the recorded start time.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actions, localRepos } from "../../src/db/schema.ts";
import { createApp } from "../../src/server/app.ts";
import { processStartTime, writeRunPid } from "../../../../loki-ts/src/util/run_pid.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const tmp = mkdtempSync(join(tmpdir(), "cp-control-"));
const repo = join(tmp, "repo");
mkdirSync(join(repo, ".git"), { recursive: true }); // a run may only start in a repo (A3d)
const answers = join(tmp, "answers");
const spawned: string[][] = [];
const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true, startBin: "/bin/loki-test", answerDir: answers, spawnImpl: async (argv, _cwd, onExit) => { spawned.push(argv); onExit?.(); return { pid: 4242 }; } });
db.insert(localRepos).values({ sourceId: SRC, realpath: repo, name: "repo", discoveredAt: new Date().toISOString() }).run();
const children: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) { try { c.kill("SIGKILL"); } catch { /* gone */ } } // only PIDs this test spawned
  close();
  rmSync(tmp, { recursive: true, force: true });
});

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const call = (kind: string, run: string, o: { ip?: string | null; ct?: string; src?: string } = {}) =>
  app.fetch(new Request(`http://127.0.0.1:1234/v1/runs/${o.src ?? SRC}/${run}/${kind}`, { method: "POST", headers: { "content-type": o.ct ?? "application/json", host: "127.0.0.1:1234" }, body: "{}" }), o.ip === null ? undefined : peer(o.ip ?? "127.0.0.1"));
const runDir = (run: string) => { const d = join(repo, ".loki", "runs", run); mkdirSync(d, { recursive: true }); return d; };
const sleeper = (): ReturnType<typeof spawn> => { const c = spawn("sleep", ["60"], { stdio: "ignore" }); children.push(c); return c; };
const pidFile = (dir: string, o: { pid: number; start: string; run_id: string }) => writeFileSync(join(dir, "run.pid"), JSON.stringify({ ...o, argv: ["loki"] }));
const audited = () => db.select().from(actions).all();
const load = async (name: string, mutate?: (l: string) => string) => {
  const evs = readFileSync(join(FIX, name, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(mutate ? mutate(l) : l));
  const ing = await app.request("http://127.0.0.1:1234/v1/ingest", { method: "POST", headers: { host: "127.0.0.1:1234" }, body: JSON.stringify({ source: SRC, run_id: evs[0].run, events: evs }) });
  if (ing.status !== 200) throw new Error(`ingest ${ing.status} ${await ing.text()}`);
  return evs[0].run as string;
};

test("a stale pid (process already gone) is refused and nothing is signalled", async () => {
  const c = sleeper();
  const start = processStartTime(c.pid!)!;
  const dead = c.pid!;
  c.kill("SIGKILL");
  await new Promise((r) => c.once("exit", r));
  const d = runDir("stale");
  pidFile(d, { pid: dead, start, run_id: "stale" });
  const r = await call("stop", "stale");
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toContain("no longer running");
});

test("a reused pid (live process, different start time) is refused and survives", async () => {
  const c = sleeper();
  const d = runDir("reused");
  pidFile(d, { pid: c.pid!, start: "Mon Jan  1 00:00:00 2001", run_id: "reused" });
  const r = await call("stop", "reused");
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toContain("start time differs");
  expect(c.exitCode).toBeNull();
  expect(processStartTime(c.pid!)).not.toBeNull();
});

test("another run's pid file in this run's dir is refused", async () => {
  const c = sleeper();
  const d = runDir("mine");
  pidFile(d, { pid: c.pid!, start: processStartTime(c.pid!)!, run_id: "someone-else" });
  const r = await call("stop", "mine");
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: string }).error).toContain("different run");
  expect(c.exitCode).toBeNull();
});

test("no run.pid, an unknown repo and a bad id are refused", async () => {
  runDir("nopid");
  expect((await call("stop", "nopid")).status).toBe(409);
  expect((await call("stop", "x", { src: "0000000000000000" })).status).toBe(404);
  expect((await call("stop", "..%2Fetc")).status).toBe(400);
});

test("happy path: stop SIGTERMs a child this test spawned, identified only by its recorded pid and start time", async () => {
  const c = sleeper();
  const d = runDir("happy");
  writeRunPid(d, "happy", c.pid!, ["loki", "start", "x"]);
  const exited = new Promise<string | null>((r) => c.once("exit", (_code, sig) => r(sig)));
  const r = await call("stop", "happy");
  expect(r.status).toBe(200);
  expect(((await r.json()) as { pid: number }).pid).toBe(c.pid!);
  expect(await exited).toBe("SIGTERM");
});

test("actions need a loopback peer and JSON, and are not registered on a non-loopback bind", async () => {
  const d = runDir("guard");
  const c = sleeper();
  writeRunPid(d, "guard", c.pid!);
  expect((await call("stop", "guard", { ip: "192.168.1.50" })).status).toBe(403);
  expect((await call("stop", "guard", { ip: null })).status).toBe(403);
  expect((await call("stop", "guard", { ct: "text/plain" })).status).toBe(403);
  const other = createApp({ dbPath: ":memory:", loopbackOnly: false });
  const r = await other.app.fetch(new Request(`http://127.0.0.1:1234/v1/runs/${SRC}/guard/stop`, { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:1234" }, body: "{}" }), peer("127.0.0.1"));
  expect(r.status).toBe(404);
  other.close();
});

test("retry re-starts the recorded issue ref with an argv array; a run with no usable ref gets 501, not a fake", async () => {
  const issueRun = await load("verified", (l) => l.replace(/"issue_ref":null/, '"issue_ref":"acme/widgets#7"').replace(/"task_source":"text"/, '"task_source":"issue"'));
  spawned.length = 0;
  const r = await call("retry", issueRun);
  expect(r.status).toBe(200);
  expect(spawned).toEqual([["/bin/loki-test", "start", "acme/widgets#7"]]);
  const blocked = await load("blocked");
  const r2 = await call("retry", blocked);
  expect(r2.status).toBe(501);
  expect(((await r2.json()) as { error: string }).error).toContain("not supported");
  expect(spawned.length).toBe(1);
});

test("resume needs a BLOCKED run with a recorded answer, then spawns `loki answer <run>`", async () => {
  const blocked = await load("blocked");
  spawned.length = 0;
  expect((await call("resume", blocked)).status).toBe(409);
  mkdirSync(join(answers, SRC), { recursive: true });
  writeFileSync(join(answers, SRC, `${blocked}.answer.txt`), "use a parameter\n");
  const r = await call("resume", blocked);
  expect(r.status).toBe(200);
  expect(spawned).toEqual([["/bin/loki-test", "answer", blocked]]);
  const notBlocked = await load("failed");
  expect((await call("resume", notBlocked)).status).toBe(409);
});

test("every action is audited, including refusals", () => {
  const rows = audited().filter((a) => a.kind.startsWith("run."));
  expect(rows.length).toBeGreaterThan(8);
  expect(rows.some((a) => a.kind === "run.stop" && a.result === "ok")).toBe(true);
  expect(rows.some((a) => a.kind === "run.stop" && a.result === "refused")).toBe(true);
  expect(rows.some((a) => a.kind === "run.retry" && a.result === "unsupported")).toBe(true);
  expect(rows.some((a) => a.kind === "run.resume" && a.result === "ok")).toBe(true);
});
