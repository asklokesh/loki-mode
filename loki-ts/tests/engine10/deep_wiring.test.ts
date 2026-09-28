// E-48 Wall check (docs/v10/BOARD.md): after pr.opened the supervisor spawns deep verify
// (stages/deep.ts) detached with the worker's token-withheld env, recording the pid so it is
// never orphaned untracked and never waiting on it; after run.completed it calls adapters
// notify (Slack) when LOKI_SLACK_WEBHOOK_URL is configured, and never lets a slow/absent
// webhook affect the verdict or wall time.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../src/engine10/events.ts";
import { runSupervisor, type PrStep } from "../../src/engine10/supervisor.ts";

const CANARY = "ghp_" + "DEEPWIRECANARYrealtoken0123456789"; // built at runtime: never a literal secret-shaped string
const roots: string[] = [];
const pids: number[] = [];
afterAll(() => {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } // only pids this file recorded
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-deepwire-"));
  roots.push(d);
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "config", "user.name", "t"]); // preflight needs an identity; CI hosts have none
  execFileSync("git", ["-C", d, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  return d;
}

// Preflight (E-36) needs a resolvable claude CLI and, whenever a PR step runs against a
// github.com origin, a gh that reports authenticated; both are stubbed, never the real thing.
function stubBinDir(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-deepwire-bin-"));
  roots.push(d);
  for (const name of ["gh", "claude"]) {
    const p = join(d, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  return d;
}
const STUB_BIN = stubBinDir();
function supEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${STUB_BIN}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_TOKEN: CANARY, GH_TOKEN: CANARY, LOKI_CLAUDE_CLI: join(STUB_BIN, "claude"), ...extra };
}

const worker = (code: string): string[] => [process.execPath, "-e", code];
const DONE_WORKER = worker(
  'console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: { session_id: "s1", exit: "done", duration_s: 1 } }));\n' +
  'console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } }));',
);
const prStep = (url = "https://github.com/acme/widget/pull/1"): PrStep => async () => ({ url, draft: false, existing: false });

describe("E-48 deep verify spawn", () => {
  test("pr.opened spawns deep verify detached with withheld tokens, records the pid, and never blocks the run", async () => {
    const dir = repo();
    const marker = join(dir, "deep-marker.json");
    const deepCode =
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(1), gh: process.env.GH_TOKEN }));\n` +
      "Bun.sleepSync(1500);";
    const t0 = Date.now();
    const r = await runSupervisor({ runId: "e10-dw1", repoDir: dir, env: supEnv(), workerArgv: DONE_WORKER, deepArgv: worker(deepCode), pr: prStep() });
    expect(Date.now() - t0).toBeLessThan(1200); // the detached spawn (1500ms sleep) never delayed the return
    const events = readEvents(join(dir, ".loki/runs/e10-dw1/events.jsonl"));
    const started = events.find((e) => e.type === "deep.started");
    expect(started).toBeTruthy();
    expect(typeof started!.data.pid).toBe("number");
    pids.push(started!.data.pid as number); // recorded: cleanup stops only this pid
    const t1 = Date.now();
    while (!existsSync(marker) && Date.now() - t1 < 4000) Bun.sleepSync(20);
    const seen = JSON.parse(readFileSync(marker, "utf8")) as { argv: string[]; gh: string };
    expect(seen.gh).toStartWith("ghp_LOKIWITHHELDsentinel"); // worker env, not the real CANARY
    expect(seen.argv.at(-1)).toBe("https://github.com/acme/widget.git"); // pinned origin appended at spawn time
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/1");
  }, 15_000);

  test("no PR opened: deep verify is never spawned", async () => {
    const dir = repo();
    const r = await runSupervisor({ runId: "e10-dw2", repoDir: dir, env: supEnv(), workerArgv: DONE_WORKER, deepArgv: worker("Bun.sleepSync(50)") });
    const events = readEvents(join(dir, ".loki/runs/e10-dw2/events.jsonl"));
    expect(events.some((e) => e.type === "deep.started")).toBe(false);
    expect(r.prUrl).toBeNull();
  }, 10_000);

  test("a deep verify that fails to spawn is NOT PROVEN, never a crash", async () => {
    const dir = repo();
    const r = await runSupervisor({ runId: "e10-dw3", repoDir: dir, env: supEnv(), workerArgv: DONE_WORKER, deepArgv: ["/nonexistent-deep-worker-e10"], pr: prStep() });
    expect(r.verdict).toBe("VERIFIED");
    expect(r.notProven).toContain("deep verify not spawned");
  }, 10_000);
});

describe("E-48 adapters notify", () => {
  test("posts the run summary to Slack when a webhook is configured", async () => {
    const dir = repo();
    const posts: { text: string }[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { posts.push((await req.json()) as { text: string }); return new Response("ok"); } });
    try {
      const r = await runSupervisor({ runId: "e10-dw4", repoDir: dir, env: supEnv({ LOKI_SLACK_WEBHOOK_URL: `http://127.0.0.1:${server.port}/` }), workerArgv: DONE_WORKER });
      expect(posts.length).toBe(1);
      expect(posts[0]!.text).toContain("VERIFIED");
      expect(r.verdict).toBe("VERIFIED");
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("makes no request when no webhook is configured", async () => {
    const dir = repo();
    const posts: unknown[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { posts.push(await req.json()); return new Response("ok"); } });
    try {
      await runSupervisor({ runId: "e10-dw5", repoDir: dir, env: supEnv(), workerArgv: DONE_WORKER });
      expect(posts.length).toBe(0);
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("a hung webhook never delays run completion past the notify timeout", async () => {
    const dir = repo();
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) }); // never resolves
    try {
      const t0 = Date.now();
      const r = await runSupervisor({
        runId: "e10-dw6", repoDir: dir,
        env: supEnv({ LOKI_SLACK_WEBHOOK_URL: `http://127.0.0.1:${server.port}/`, LOKI_E10_NOTIFY_TIMEOUT_MS: "50" }),
        workerArgv: DONE_WORKER,
      });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.verdict).toBe("VERIFIED");
    } finally {
      server.stop(true);
    }
  }, 10_000);
});
