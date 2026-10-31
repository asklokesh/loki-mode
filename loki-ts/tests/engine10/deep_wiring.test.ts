// E-48 Wall check (docs/v10/BOARD.md): after pr.opened the supervisor spawns deep verify
// (stages/deep.ts) detached with the worker's token-withheld env, recording the pid so it is
// never orphaned untracked and never waiting on it; after run.completed it calls adapters
// notify (Slack) when LOKI_SLACK_WEBHOOK_URL is configured, and never lets a slow/absent
// webhook affect the verdict or wall time.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents, summaryCost } from "../../src/engine10/events.ts";
import { runSummaryCost, runSupervisor, type PrStep } from "../../src/engine10/supervisor.ts";
import { childEnv } from "../../src/engine10/session.ts";
import { REVIEW_GUARD_DENYLIST } from "../../src/providers/claude_flags.ts";
import { deepStage } from "../../src/engine10/stages/deep.ts";
import type { RunContext, SessionResult, SessionRunner, SessionRunOptions } from "../../src/engine10/types.ts";

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
  execFileSync("git", ["-C", d, "commit", "-q", "--allow-empty", "-m", "init"]); // preflight refuses a repo with no commits (TEN-STABILITY-35)
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

  test("FC-WORKER-NO-PROCESS-LIMITS: the detached deep verify runs under the same LOKI_ULIMIT_NPROC wrapper as the worker", async () => {
    const dir = repo();
    const marker = join(dir, "deep-ulimit.txt");
    const deepCode = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, require("node:child_process").execFileSync("/bin/bash", ["-c", "ulimit -u"], { encoding: "utf8" }));\nBun.sleepSync(300);`;
    await runSupervisor({ runId: "e10-dw-ul", repoDir: dir, env: supEnv({ LOKI_ULIMIT_NPROC: "2000" }), workerArgv: DONE_WORKER, deepArgv: worker(deepCode), pr: prStep() });
    const started = readEvents(join(dir, ".loki/runs/e10-dw-ul/events.jsonl")).find((e) => e.type === "deep.started");
    expect(started).toBeTruthy();
    pids.push(started!.data.pid as number);
    const t1 = Date.now();
    while (!existsSync(marker) && Date.now() - t1 < 4000) Bun.sleepSync(20);
    expect(readFileSync(marker, "utf8").trim()).toBe("2000");
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

  // E-69 rework wiring check: partialCost()'s tamper guard must actually reach the Slack summary,
  // not just the pure function in isolation. Two real cost events are recorded, then the log is
  // tampered (same forged-append technique as rule_of_two.test.ts's tamper tests) before
  // session.ended, so the run ends VERIFIED but log.tampered is true. The posted text must read
  // "not measured" and never leak the $0.40 those two sessions actually reported.
  test("a tampered, fully-priced run posts Cost: not measured to Slack, never a dollar figure", async () => {
    const dir = repo();
    const log = join(dir, ".loki/runs/e10-dw6/events.jsonl");
    const code = `
console.log(JSON.stringify({ type: "cost", stage: null, data: { session_id: "s1", usd: 0.15 } }));
console.log(JSON.stringify({ type: "cost", stage: null, data: { session_id: "s2", usd: 0.25 } }));
const forged = JSON.stringify({v:1,seq:99,ts:new Date().toISOString(),run:"e10-dw6",type:"receipt.sealed",stage:"seal",data:{verdict:"VERIFIED"}}) + "\\n";
require("node:fs").appendFileSync(${JSON.stringify(log)}, forged);
console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: { session_id: "s1", exit: "done", duration_s: 1 } }));
console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } }));
`;
    const posts: { text: string }[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { posts.push((await req.json()) as { text: string }); return new Response("ok"); } });
    try {
      const r = await runSupervisor({ runId: "e10-dw6", repoDir: dir, env: supEnv({ LOKI_SLACK_WEBHOOK_URL: `http://127.0.0.1:${server.port}/` }), workerArgv: worker(code) });
      expect(r.tampered).toBe(true);
      expect(posts.length).toBe(1);
      expect(posts[0]!.text).toContain("not measured");
      expect(posts[0]!.text).not.toContain("$0.40");
      expect(posts[0]!.text).not.toContain("partial: $");
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

describe("Q18-04 deep council default runner", () => {
  const git = (d: string, a: string[]): string => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }).trim();
  function changedRepo(): { dir: string; base: string } {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]); git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "code.txt"), "change\n");
    git(dir, ["add", "code.txt"]); git(dir, ["commit", "-q", "-m", "change"]);
    return { dir, base };
  }
  async function deepWith(run: SessionRunner["run"], dir: string, base: string) {
    const ctx = {
      runId: "e10-q1804", repoDir: dir, runDir: join(dir, ".loki", "runs", "q1804"), baseSha: base, branch: "b", provider: "claude", model: "m", deep: true, capS: 2700,
      emit: () => {}, sessions: { run }, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => Date.now() }, outputs: () => ({}),
    } as unknown as RunContext;
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    const keyDir = mkdtempSync(join(tmpdir(), "e10-q1804-key-")); roots.push(keyDir);
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(keyDir, "k.pem");
    const saved = { g: process.env["GITHUB_TOKEN"], h: process.env["GH_TOKEN"] };
    delete process.env["GITHUB_TOKEN"]; delete process.env["GH_TOKEN"];
    try { return await deepStage.run(ctx, new AbortController().signal); } finally {
      if (saved.g) process.env["GITHUB_TOKEN"] = saved.g;
      if (saved.h) process.env["GH_TOKEN"] = saved.h;
    }
  }
  const sess = (over: Partial<SessionResult> = {}): SessionResult => ({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false, summary: "LGTM", ...over });

  test("the production deep stage runs one read-only reviewer session outside the repo and records a council pass", async () => {
    const { dir, base } = changedRepo();
    const seen: SessionRunOptions[] = [];
    const r = await deepWith(async (o) => { seen.push(o); return sess(); }, dir, base);
    expect(seen.length).toBe(1);
    expect(seen[0]!.stage).toBe("deep");
    expect(seen[0]!.brief).toContain("read-only");
    expect(!!seen[0]!.cwd && seen[0]!.cwd !== dir && !seen[0]!.cwd!.startsWith(dir)).toBe(true);
    const checks = r.data.checks as { name: string; result: string }[];
    expect(checks.find((c) => c.name === "council")?.result).toBe("pass");
    const scratch = seen[0]!.cwd!;
    expect(scratch.startsWith(join(tmpdir(), "loki-deep-council-"))).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    expect(seen[0]!.disallowedTools).toContain(REVIEW_GUARD_DENYLIST);
    expect(seen[0]!.disallowedTools!.split(",")).toContain("Bash");
    expect(childEnv(seen[0]!, { provider: "claude" }).LOKI_E10_DISALLOWED_TOOLS).toBe(seen[0]!.disallowedTools);
    expect((r.data.not_proven as string[]).some((n) => n.startsWith("council (not wired"))).toBe(false);
  });

  test("a killed or failed reviewer session stays NOT PROVEN, never a council pass", async () => {
    const { dir, base } = changedRepo();
    for (const bad of [sess({ killed: true, exit: null }), sess({ exit: 1 }), sess({ summary: "" }), sess({ summary: "I was unable to open diff.patch." })]) {
      const r = await deepWith(async () => bad, dir, base);
      expect((r.data.checks as { name: string }[]).find((c) => c.name === "council")).toBeUndefined();
      expect((r.data.not_proven as string[]).some((n) => n.startsWith("council (refused"))).toBe(true);
    }
  });

  test("a council diff that is empty (only untracked changes) is NOT PROVEN before any session spawns", async () => {
    const { dir, base } = changedRepo();
    git(dir, ["reset", "-q", "--hard", base]);
    writeFileSync(join(dir, "evil.ts"), "x\n");
    let spawned = 0;
    const r = await deepWith(async () => { spawned++; return sess({ summary: "diff.patch is empty; nothing to review." }); }, dir, base);
    expect(spawned).toBe(0);
    expect((r.data.checks as { name: string }[]).find((c) => c.name === "council")).toBeUndefined();
    expect((r.data.not_proven as string[]).some((n) => n.startsWith("council (refused"))).toBe(true);
  });

  test("FINDING lines are accepted as a review", async () => {
    const { dir, base } = changedRepo();
    const r = await deepWith(async () => sess({ summary: "FINDING: a.ts:1 bad" }), dir, base);
    expect((r.data.checks as { name: string; result: string }[]).find((c) => c.name === "council")?.result).toBe("pass");
  });
});

describe("child session spend reaches every run-total surface", () => {
  const METERED_WORKER = worker(
    'console.log(JSON.stringify({ type: "cost", stage: "implement", data: { session_id: "s1", usd: 0.3 } }));\n' +
    'console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: { session_id: "s1", exit: "done", duration_s: 1 } }));\n' +
    'console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } }));',
  );
  const seedChild = (dir: string, runId: string, usd: number): void => {
    mkdirSync(join(dir, ".loki", "metrics"), { recursive: true });
    writeFileSync(join(dir, ".loki", "metrics", "child-sessions.jsonl"), `${JSON.stringify({ run_id: runId, phase: "review", model: "m", usd })}\n`);
  };

  test("run.completed and the Slack Cost line carry stage plus child spend", async () => {
    const dir = repo();
    seedChild(dir, "e10-dwc1", 0.2);
    const posts: { text: string }[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { posts.push((await req.json()) as { text: string }); return new Response("ok"); } });
    try {
      await runSupervisor({ runId: "e10-dwc1", repoDir: dir, env: supEnv({ LOKI_SLACK_WEBHOOK_URL: `http://127.0.0.1:${server.port}/` }), workerArgv: METERED_WORKER });
      const done = readEvents(join(dir, ".loki/runs/e10-dwc1/events.jsonl")).find((e) => e.type === "run.completed")!;
      expect(done.data.cost_usd as number).toBeCloseTo(0.5, 10); // M4: a stage-only 0.3 here means run.completed dropped the ledger
      expect(posts[0]!.text).toContain("$0.50");
    } finally { server.stop(true); }
  }, 10_000);

  test("the console Cost line reads the same child-inclusive total", () => {
    const dir = repo();
    seedChild(dir, "e10-dwc2", 0.2);
    const events = [{ v: 1, seq: 0, ts: "2026-10-28T00:00:00Z", run: "e10-dwc2", type: "cost", stage: "implement", data: { session_id: "s1", usd: 0.3 } }] as never[];
    const { usd, pc } = summaryCost(events, false, join(dir, ".loki"));
    expect(usd).toBeCloseTo(0.5, 10);
    expect(pc.usd).toBeCloseTo(0.5, 10);
    const printed = runSummaryCost(events, false, dir); // the exact call main() prints through, given the repo dir
    expect(printed.usd).toBeCloseTo(0.5, 10); // M7: dropping the run's .loki root makes this the stage-only 0.3
    expect(printed.pc.usd).toBeCloseTo(0.5, 10);
  });
});
