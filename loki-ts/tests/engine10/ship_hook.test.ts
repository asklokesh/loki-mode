// CP-02: the shipper hook never changes a run. With LOKI_CONTROL_URL unset: no ship.json and no network. With it set to a live stub:
// the same result and an identical events.jsonl (timestamps aside), and the events arrive.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor } from "../../src/engine10/supervisor.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) execFileSync("rm", ["-rf", r]); });
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-ship-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
  return dir;
}
const CODE = `console.log(JSON.stringify({ type: "stage.completed", stage: "intake", data: { base_sha: "x" } })); await new Promise((r) => setTimeout(r, 900));`;
const norm = (p: string): string[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
  const e = JSON.parse(l); e.ts = "T"; if ("wall_s" in e.data) e.data.wall_s = 0; return JSON.stringify(e);
});

test("unset: no ship.json, no network; set: same result and log, and events arrive", async () => {
  let posts = 0, got = 0;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { posts++; got += ((await req.json()) as { events: unknown[] }).events.length; return Response.json({}); } });
  const base: NodeJS.ProcessEnv = { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" };
  delete base.LOKI_CONTROL_URL;
  try {
    const a = repo(), b = repo();
    const ra = await runSupervisor({ runId: "e10-ship1", repoDir: a, env: base, workerArgv: [process.execPath, "-e", CODE], capS: 20 });
    const aLog = join(a, ".loki", "runs", "e10-ship1", "events.jsonl");
    expect(existsSync(join(a, ".loki", "runs", "e10-ship1", "ship.json"))).toBe(false);
    expect(posts).toBe(0);
    const rb = await runSupervisor({ runId: "e10-ship1", repoDir: b, env: { ...base, LOKI_CONTROL_URL: `http://127.0.0.1:${srv.port}` }, workerArgv: [process.execPath, "-e", CODE], capS: 20 });
    const bLog = join(b, ".loki", "runs", "e10-ship1", "events.jsonl");
    expect(rb.verdict).toBe(ra.verdict);
    expect(rb.workerExit).toBe(ra.workerExit);
    expect(norm(bLog)).toEqual(norm(aLog)); // the log is unchanged by shipping
    expect(posts).toBeGreaterThan(0);
    expect(got).toBeGreaterThan(0);
  } finally { srv.stop(true); }
}, 30_000);
