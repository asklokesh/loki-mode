// CPE-25/26: merge queue and PR risk routes shell out to a stub `loki` (never the real CLI or GitHub), validate every argument, and audit mutations and refusals.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { actions } from "../../src/db/schema.ts";
import { limits, parseRisk } from "../../src/server/routes/merge_risk.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-merge-")));
const bin = join(dir, "loki");
// argv is logged one call per line (joined by a single space); stdout and exit code come from out.<sub> and rc.<sub> files.
writeFileSync(bin, `#!/bin/sh\nD="$(dirname "$0")"\necho "$*" >> "$D/calls.log"\n[ -f "$D/out.$1" ] && cat "$D/out.$1"\n[ -f "$D/rc.$1" ] && exit "$(cat "$D/rc.$1")"\nexit 0\n`);
chmodSync(bin, 0o755);
const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true, startBin: bin, repoDir: dir });
afterAll(() => { close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { for (const f of ["calls.log", "out.merge", "rc.merge", "out.review", "rc.review"]) rmSync(join(dir, f), { force: true }); db.delete(actions).run(); });

const calls = (): string[] => { try { return readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const peer = (address: string) => ({ requestIP: () => ({ address }) });
const req = (method: string, path: string, body?: unknown, o: { ip?: string; origin?: string; ct?: string } = {}) =>
  app.fetch(new Request(`http://127.0.0.1:1234${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: "127.0.0.1:1234", ...(body === undefined ? {} : { "content-type": o.ct ?? "application/json" }), ...(o.origin ? { origin: o.origin } : {}) },
  }), peer(o.ip ?? "127.0.0.1"));
const rows = () => db.select().from(actions).all();

test("merge queue list parses the CLI output and add passes validated PR numbers as argv", async () => {
  writeFileSync(join(dir, "out.merge"), "#12\n#40\n");
  const l = await req("GET", "/v1/merge/queue");
  expect(await l.json()).toEqual({ measured: true, queue: [12, 40] });
  expect(calls()).toEqual(["merge list"]);
  const a = await req("POST", "/v1/merge/queue", { prs: ["7", 8] });
  expect(a.status).toBe(200);
  expect(calls()[1]).toBe("merge add 7 8");
  expect(rows().some((r) => r.kind === "merge.add" && r.result === "ok")).toBe(true);
});

test("an empty queue reads as empty and a failing CLI reads as not measured", async () => {
  writeFileSync(join(dir, "out.merge"), "Merge queue is empty\n");
  expect(await (await req("GET", "/v1/merge/queue")).json()).toEqual({ measured: true, queue: [] });
  writeFileSync(join(dir, "rc.merge"), "3");
  const j = (await (await req("GET", "/v1/merge/queue")).json()) as { measured: boolean; queue: unknown[] };
  expect(j.measured).toBe(false);
});

test("validation: 422 for argv injection and malformed PR numbers, nothing spawned, refusals audited", async () => {
  for (const pr of ["1;rm", "--foo", "-1", "1 2", "$(id)", "", "12345678", "1\n2", 1.5, null, {}]) {
    expect((await req("POST", "/v1/merge/queue", { prs: [pr] })).status).toBe(422);
  }
  expect((await req("POST", "/v1/merge/queue", { prs: [] })).status).toBe(422);
  expect((await req("POST", "/v1/merge/queue", {})).status).toBe(422);
  expect((await req("POST", "/v1/merge/queue", { prs: ["1"], repo: "/etc" })).status).toBe(422);
  for (const q of ["pr=1;rm", "pr=--foo", "pr=", "since=--foo", "since=-x", "since=a%20b", "since=a;b", "since=a%0Ab", "since=" + "a".repeat(101), "staged=0", "", "pr=1&since=HEAD", "pr=1&staged=1"]) {
    expect((await req("GET", `/v1/review/risk?${q}`)).status).toBe(422);
  }
  expect(calls()).toEqual([]);
  expect(rows().every((r) => r.result === "refused")).toBe(true);
  expect(rows().length).toBeGreaterThan(20);
});

test("merge run requires a boolean dryRun; invalid or missing never reaches the CLI", async () => {
  for (const b of [{}, { dryRun: "true" }, { dryRun: 1 }, { dryRun: null }]) expect((await req("POST", "/v1/merge/run", b)).status).toBe(422);
  expect((await req("POST", "/v1/merge/run", [])).status).toBe(400);
  expect(calls()).toEqual([]);
});

test("the dry run only ever invokes `merge run --dry-run`, and a real run is a separate, audited call", async () => {
  writeFileSync(join(dir, "out.merge"), "#5: checks green, would merge (squash)\nDry run: nothing changed\n");
  const d = await req("POST", "/v1/merge/run", { dryRun: true });
  expect(d.status).toBe(200);
  const dj = (await d.json()) as { ok: boolean; dryRun: boolean; lines: string[] };
  expect(dj.dryRun).toBe(true);
  expect(dj.lines[0]).toContain("would merge");
  expect(calls()).toEqual(["merge run --dry-run"]);
  expect(rows().map((r) => r.kind)).toEqual(["merge.dry_run"]);

  writeFileSync(join(dir, "out.merge"), "#5: merged\nMerged: 1, left in queue: 0\n");
  const r = await req("POST", "/v1/merge/run", { dryRun: false });
  expect(r.status).toBe(200);
  expect(calls()).toEqual(["merge run --dry-run", "merge run"]);
  expect(rows().map((x) => x.kind)).toEqual(["merge.dry_run", "merge.pr_merged", "merge.run"]);
});

test("a real run that leaves PRs in the queue (exit 1) is a result, not a server error", async () => {
  writeFileSync(join(dir, "out.merge"), "#5: checks not green (rc=1), left in queue, not merged\n");
  writeFileSync(join(dir, "rc.merge"), "1");
  const r = await req("POST", "/v1/merge/run", { dryRun: false });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { ok: boolean; ran: boolean; exit: number };
  expect(j).toMatchObject({ ok: false, ran: true, exit: 1 });
  expect(rows()[0]).toMatchObject({ kind: "merge.run", result: "blocked" });
});

test("non-loopback peers, bad Origin and non-JSON are refused 403 and audited, with no spawn", async () => {
  expect((await req("POST", "/v1/merge/run", { dryRun: false }, { ip: "192.168.1.50" })).status).toBe(403);
  expect((await req("POST", "/v1/merge/queue", { prs: ["1"] }, { ip: "10.0.0.2" })).status).toBe(403);
  expect((await req("POST", "/v1/merge/run", { dryRun: false }, { origin: "https://evil.example" })).status).toBe(403);
  expect((await req("POST", "/v1/merge/run", { dryRun: false }, { ct: "text/plain" })).status).toBe(403);
  expect((await req("GET", "/v1/merge/queue", undefined, { ip: "192.168.1.50" })).status).toBe(403);
  expect((await req("GET", "/v1/review/risk?pr=1", undefined, { ip: "192.168.1.50" })).status).toBe(403);
  expect(calls()).toEqual([]);
  expect(rows().length).toBe(6);
  expect(rows().every((r) => r.result === "refused")).toBe(true);
});

test("risk: pr, staged and since map to fixed argv and a valid report parses", async () => {
  const report = { score: 42, level: "medium", source: "PR #9", files: 3, factors: [{ factor: "size", points: 4, max: 20, detail: "100 changed lines" }] };
  writeFileSync(join(dir, "out.review"), JSON.stringify(report) + "\n");
  const a = (await (await req("GET", "/v1/review/risk?pr=9")).json()) as { measured: boolean; score: number; factors: unknown[] };
  expect(a).toMatchObject({ measured: true, score: 42 });
  expect(a.factors.length).toBe(1);
  await req("GET", "/v1/review/risk?staged=1");
  await req("GET", "/v1/review/risk?since=origin/main");
  expect(calls()).toEqual(["review --risk --json --pr 9", "review --risk --json --staged", "review --risk --json --since origin/main"]);
});

test("risk: unparseable output, a failing CLI and an out-of-range score all read not measured, never 0", async () => {
  for (const out of ["not json at all", "{}", '{"score":"high","factors":[]}', '{"score":150,"factors":[]}', '{"score":5,"factors":[{"factor":1}]}', ""]) {
    writeFileSync(join(dir, "out.review"), out);
    const j = (await (await req("GET", "/v1/review/risk?pr=3")).json()) as Record<string, unknown>;
    expect(j["measured"]).toBe(false);
    expect("score" in j).toBe(false);
  }
  writeFileSync(join(dir, "out.review"), JSON.stringify({ score: 10, level: "low", factors: [] }));
  writeFileSync(join(dir, "rc.review"), "1");
  const f = (await (await req("GET", "/v1/review/risk?pr=3")).json()) as Record<string, unknown>;
  expect(f["measured"]).toBe(false);
  expect("score" in f).toBe(false);
  expect(parseRisk('{"score":0,"level":"low","factors":[]}')?.score).toBe(0);
});

test("a missing binary reads not measured", async () => {
  const other = createApp({ dbPath: ":memory:", loopbackOnly: true, startBin: join(dir, "nope"), repoDir: dir });
  const r = await other.app.fetch(new Request("http://127.0.0.1:1234/v1/review/risk?pr=1", { headers: { host: "127.0.0.1:1234" } }), peer("127.0.0.1"));
  expect(((await r.json()) as { measured: boolean }).measured).toBe(false);
  other.close();
});

// A stub that records its pid, prints a merged line, then blocks on a long sleep child (like gh/sleep under cmd_merge).
const slowBin = (name: string, body: string): string => { const b = join(dir, name); writeFileSync(b, `#!/bin/sh\n${body}\n`); chmodSync(b, 0o755); return b; };
const appWith = (startBin: string, repoDir = dir) => createApp({ dbPath: ":memory:", loopbackOnly: true, startBin, repoDir });
const post = (a: { app: { fetch: (r: Request, e?: unknown) => Response | Promise<Response> } }, path: string, body: unknown) =>
  a.app.fetch(new Request(`http://127.0.0.1:1234${path}`, { method: "POST", body: JSON.stringify(body), headers: { host: "127.0.0.1:1234", "content-type": "application/json" } }), peer("127.0.0.1"));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("production limits are pinned: 600s real-merge timeout and 5000-byte body cap", async () => {
  expect(limits.mergeRunMs).toBe(600_000);
  expect(limits.bodyMax).toBe(5_000);
  const big = await req("POST", "/v1/merge/queue", { prs: ["1"], pad: "x".repeat(5_001) });
  expect(big.status).toBe(413);
  const ok = await req("POST", "/v1/merge/queue", { prs: ["1"] });
  expect(ok.status).toBe(200);
});

test("a real merge that times out returns the collected lines with timedOut, audits merged PRs and leaves no live child", async () => {
  const pidf = join(dir, "child.pid");
  rmSync(pidf, { force: true });
  const b = slowBin("loki-slow", `echo "#5: merged"\nsleep 300 &\necho $! > "${pidf}"\nwait`);
  const a = appWith(b);
  const saved = limits.mergeRunMs, savedG = limits.graceMs;
  limits.mergeRunMs = 800; limits.graceMs = 300;
  try {
    const r = await post(a, "/v1/merge/run", { dryRun: false });
    const j = (await r.json()) as { lines: string[]; timedOut: boolean; partial: boolean; ran: boolean; error: string };
    expect(r.status).toBe(500);
    expect(j.timedOut).toBe(true);
    expect(j.partial).toBe(true);
    expect(j.lines).toEqual(["#5: merged"]);
    expect(j.error).toContain("timed out");
    const cpid = Number(readFileSync(pidf, "utf8").trim());
    expect(cpid).toBeGreaterThan(1);
    await sleep(300);
    expect(alive(cpid)).toBe(false);
    const audited = a.db.select().from(actions).all();
    expect(audited.some((x) => x.kind === "merge.pr_merged" && x.target === "#5")).toBe(true);
  } finally { limits.mergeRunMs = saved; limits.graceMs = savedG; a.close(); }
});

test("the child env carries a poll budget that fits inside the route timeout", async () => {
  const b = slowBin("loki-env", `echo "$LOKI_MERGE_MAX_POLLS $LOKI_MERGE_POLL_S"`);
  const a = appWith(b);
  const j = (await (await post(a, "/v1/merge/run", { dryRun: false })).json()) as { lines: string[] };
  const [tries, poll] = j.lines[0]!.split(" ").map(Number);
  expect(tries! * poll!).toBeLessThan(600);
  expect(tries!).toBeGreaterThan(0);
  a.close();
});

test("only exit 1 is blocked; other non-zero exits are errors", async () => {
  writeFileSync(join(dir, "out.merge"), "boom\n");
  writeFileSync(join(dir, "rc.merge"), "2");
  const r = await req("POST", "/v1/merge/run", { dryRun: false });
  expect(r.status).toBe(500);
  expect(((await r.json()) as { ran: boolean }).ran).toBe(false);
  expect(rows()[0]).toMatchObject({ kind: "merge.run", result: "error" });
});

test("an output-cap kill is reported as such, not as a timeout", async () => {
  const b = slowBin("loki-flood", `yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
  const a = appWith(b);
  const r = await post(a, "/v1/merge/run", { dryRun: false });
  const j = (await r.json()) as { timedOut: boolean; capped: boolean; error: string };
  expect(j.capped).toBe(true);
  expect(j.timedOut).toBe(false);
  expect(j.error).toContain("size cap");
  a.close();
});

test("a second real merge in the same repo is 409 while the first runs", async () => {
  const b = slowBin("loki-hold", `sleep 2`);
  const a = appWith(b);
  const first = post(a, "/v1/merge/run", { dryRun: false });
  await sleep(300);
  const second = await post(a, "/v1/merge/run", { dryRun: false });
  expect(second.status).toBe(409);
  expect(a.db.select().from(actions).all().some((x) => x.result === "conflict")).toBe(true);
  expect((await first).status).toBe(200);
  expect((await post(a, "/v1/merge/run", { dryRun: false })).status).toBe(200);
  a.close();
});

test("the busy lock keys on the real path: a symlinked registry entry cannot start a second real run", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cp-home-")));
  const link = join(home, "repolink");
  symlinkSync(dir, link);
  mkdirSync(join(home, ".loki", "dashboard"), { recursive: true });
  writeFileSync(join(home, ".loki", "dashboard", "projects.json"), JSON.stringify({ projects: { x: { path: link } } }));
  const oldHome = process.env["HOME"];
  process.env["HOME"] = home;
  const b = slowBin("loki-hold2", `sleep 2`);
  const a = appWith(b);
  try {
    const first = post(a, "/v1/merge/run", { dryRun: false });
    await sleep(300);
    expect((await post(a, "/v1/merge/run", { dryRun: false, repo: link })).status).toBe(409);
    expect((await post(a, "/v1/merge/run", { dryRun: false, repo: "repolink" })).status).toBe(409);
    expect((await first).status).toBe(200);
  } finally { process.env["HOME"] = oldHome; a.close(); rmSync(home, { recursive: true, force: true }); }
});

test("GET queue and risk enforce Origin, and concurrent CLI spawns beyond the cap get 429", async () => {
  expect((await req("GET", "/v1/merge/queue", undefined, { origin: "https://evil.example" })).status).toBe(403);
  expect((await req("GET", "/v1/review/risk?pr=1", undefined, { origin: "https://evil.example" })).status).toBe(403);
  expect(calls()).toEqual([]);
  const b = slowBin("loki-hold3", `sleep 1\necho "#1"`);
  const a = appWith(b);
  const get = () => a.app.fetch(new Request("http://127.0.0.1:1234/v1/merge/queue", { headers: { host: "127.0.0.1:1234" } }), peer("127.0.0.1"));
  const rs = await Promise.all([get(), get(), get(), get()]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 429, 429]);
  a.close();
});

test("parseRisk reports files null (not 0) when the field is missing", () => {
  expect(parseRisk('{"score":5,"level":"low","factors":[]}')?.files).toBeNull();
  expect(parseRisk('{"score":5,"level":"low","files":4,"factors":[]}')?.files).toBe(4);
  expect(existsSync(bin)).toBe(true);
});
