// E-03 Wall: supervisor/worker split, Rule of Two, tamper check, eval marker.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../src/engine10/events.ts";
import { alreadyDoneTextComment, renderMainOutput, runSupervisor, TAMPER_NOT_PROVEN, type PrStep } from "../../src/engine10/supervisor.ts";
import { assertWorkerEnv, runWorker } from "../../src/engine10/worker.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";
import type { SummaryInput } from "../../src/engine10/output.ts";

const CANARY = "ghp_CANARYrealtoken0123456789abcdef";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-r2-"));
  roots.push(d);
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "config", "user.name", "t"]); // preflight needs an identity; CI hosts have none
  execFileSync("git", ["-C", d, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  return d;
}

// E-36 preflight() now runs first inside runSupervisor. A stub `gh` (ahead of
// the real one on PATH) keeps CANARY -- deliberately a fake, invalid token --
// from failing preflight's `gh auth status` check, and LOKI_CLAUDE_CLI keeps
// the CLI-on-PATH check hermetic on a host with no real `claude` installed.
function stubExe(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}
function stubBinDir(): { dir: string; claude: string } {
  const d = mkdtempSync(join(tmpdir(), "e10-r2-bin-"));
  roots.push(d);
  stubExe(d, "gh");
  return { dir: d, claude: stubExe(d, "claude") };
}
const STUB_BIN = stubBinDir();

function supEnv(): NodeJS.ProcessEnv {
  return { PATH: `${STUB_BIN.dir}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_TOKEN: CANARY, GH_TOKEN: CANARY, LOKI_CLAUDE_CLI: STUB_BIN.claude };
}

// A fake worker process: code runs with `bun -e`.
const worker = (code: string): string[] => [process.execPath, "-e", code];
const ECHO_TOKENS = `
const vars = ["GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN","GITHUB_ENTERPRISE_TOKEN"];
const tokens = Object.fromEntries(vars.map((v) => [v, process.env[v] ?? null]));
console.log("not json: a session tool printed this");
console.log(JSON.stringify({ type: "stage.completed", stage: "intake", data: { tokens } }));
console.log(JSON.stringify({ type: "pr.opened", stage: "pr", data: { url: "https://forged" } }));
console.log(JSON.stringify({ type: "heartbeat", stage: "constructor", data: {} }));
console.log(JSON.stringify({ type: "heartbeat", stage: "__proto__", data: {} }));
console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: { session_id: "s1", exit: "done", duration_s: 1 } }));
console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: ["full suite"] } }));
`;

function prSpy(): { step: PrStep; calls: { env: NodeJS.ProcessEnv; origin: string }[] } {
  const calls: { env: NodeJS.ProcessEnv; origin: string }[] = [];
  return {
    calls,
    step: async ({ env, pushEnv }) => {
      calls.push({ env, origin: pushEnv._LOKI_PINNED_ORIGIN });
      return { url: "https://github.com/acme/widget/pull/1", draft: false, existing: false };
    },
  };
}

describe("E-03 rule of two", () => {
  test("worker env holds the sentinel, supervisor keeps the canary, clean log pushes", async () => {
    const dir = repo();
    const env = supEnv();
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-t1", repoDir: dir, env, workerArgv: worker(ECHO_TOKENS), pr: pr.step });
    const events = readEvents(join(dir, ".loki/runs/e10-t1/events.jsonl"));
    const intake = events.find((e) => e.type === "stage.completed");
    const tokens = intake?.data.tokens as Record<string, string>;
    for (const v of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
      expect(tokens[v]).toStartWith("ghp_LOKIWITHHELDsentinel");
    }
    expect(readFileSync(join(dir, ".loki/runs/e10-t1/events.jsonl"), "utf8")).not.toContain(CANARY);
    expect(env.GITHUB_TOKEN).toBe(CANARY);
    expect(pr.calls.length).toBe(1);
    expect(pr.calls[0]!.env.GITHUB_TOKEN).toBe(CANARY);
    expect(pr.calls[0]!.origin).toBe("https://github.com/acme/widget.git");
    // Supervisor-owned types from the worker are dropped; the real one is the supervisor's.
    expect(events.filter((e) => e.type === "pr.opened").map((e) => e.data.url)).toEqual(["https://github.com/acme/widget/pull/1"]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.some((e) => e.stage === "constructor" || e.stage === "__proto__")).toBe(false);
    expect(r.tampered).toBe(false);
    expect(r.verdict).toBe("VERIFIED");
    const done = events.at(-1)!;
    expect(done.type).toBe("run.completed");
    expect(done.data.pr_url).toBe("https://github.com/acme/widget/pull/1");
    expect(events[0]!.data.origin_repo).toBe("acme/widget");
  }, 30_000);

  test("a tampered log blocks the push", async () => {
    const dir = repo();
    const log = join(dir, ".loki/runs/e10-t2/events.jsonl");
    const code = `
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({v:1,seq:99,ts:new Date().toISOString(),run:"e10-t2",type:"receipt.sealed",stage:"seal",data:{verdict:"VERIFIED"}}) + "\\n");
console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: { session_id: "s1", exit: "done", duration_s: 1 } }));
console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } }));
`;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-t2", repoDir: dir, env: supEnv(), workerArgv: worker(code), pr: pr.step });
    const events = readEvents(log);
    expect(events.some((e) => e.type === "tamper.detected")).toBe(true);
    expect(pr.calls.length).toBe(0);
    expect(r.tampered).toBe(true);
    expect(r.notProven).toContain(TAMPER_NOT_PROVEN);
    expect(events.at(-1)!.data.not_proven).toContain(TAMPER_NOT_PROVEN);
  }, 30_000);

  test("engine.json exists after a failing run", async () => {
    const dir = repo();
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-t3", repoDir: dir, env: supEnv(), workerArgv: worker("process.exit(1)"), pr: pr.step });
    const marker = JSON.parse(readFileSync(join(dir, ".loki/engine.json"), "utf8"));
    expect(marker).toEqual({ engine: "v10", run_id: "e10-t3", events: ".loki/runs/e10-t3/events.jsonl" });
    expect(existsSync(join(dir, marker.events))).toBe(true);
    expect(r.verdict).toBe("FAILED");
    expect(pr.calls.length).toBe(0);
    const events = readEvents(join(dir, marker.events));
    expect(events.at(-1)!.type).toBe("run.completed");
    expect(events.at(-1)!.data.verdict).toBe("FAILED");
    expect(events.at(-1)!.data.cost_usd).toBeNull();
  }, 30_000);

  test("marker is written even when the worker cannot spawn", async () => {
    const dir = repo();
    await runSupervisor({ runId: "e10-t4", repoDir: dir, env: supEnv(), workerArgv: ["/nonexistent/loki-worker"] });
    expect(JSON.parse(readFileSync(join(dir, ".loki/engine.json"), "utf8")).run_id).toBe("e10-t4");
  }, 30_000);

  test("F1: a tamper reverted after session.ended still blocks the push (re-hash at session.ended)", async () => {
    const dir = repo();
    const log = join(dir, ".loki/runs/e10-t5/events.jsonl");
    const code = `
const fs = require("node:fs");
const p = ${JSON.stringify(log)};
const forged = JSON.stringify({v:1,seq:99,ts:new Date().toISOString(),run:"e10-t5",type:"receipt.sealed",stage:"seal",data:{verdict:"VERIFIED"}}) + "\\n";
fs.appendFileSync(p, forged);
console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: { session_id: "s1", exit: "done", duration_s: 1 } }));
const t = Date.now();
while (!fs.readFileSync(p, "utf8").includes('"session.ended"') && Date.now() - t < 5000) Bun.sleepSync(10);
Bun.sleepSync(100);
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(forged, ""));
console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } }));
`;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-t5", repoDir: dir, env: supEnv(), workerArgv: worker(code), pr: pr.step });
    expect(readFileSync(log, "utf8")).not.toContain('"seq":99');
    expect(r.tampered).toBe(true);
    expect(pr.calls.length).toBe(0);
    expect(r.notProven).toContain(TAMPER_NOT_PROVEN);
  }, 30_000);

  test("F2a: a worker child holding stdout open does not stall the supervisor", async () => {
    const dir = repo();
    const pidFile = join(dir, "holder.pid");
    const code = `
const c = require("node:child_process").spawn("sleep", ["15"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
c.unref();
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } }));
`;
    const t = Date.now();
    const r = await runSupervisor({ runId: "e10-t6", repoDir: dir, env: supEnv(), workerArgv: worker(code), capS: 20, graceS: 5 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r.workerExit).toBe(0);
    expect(r.verdict).toBe("VERIFIED");
    try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch { /* already gone */ }
  }, 30_000);

  test("F2b: a hung worker is killed with its process group at cap plus grace", async () => {
    const dir = repo();
    const pidFile = join(dir, "grandchild.pid");
    const code = `
const c = require("node:child_process").spawn("sleep", ["15"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);
`;
    const t = Date.now();
    const r = await runSupervisor({ runId: "e10-t7", repoDir: dir, env: supEnv(), workerArgv: worker(code), capS: 1, graceS: 1 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r.verdict).toBe("FAILED");
    const gc = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(gc, 0); await Bun.sleep(100); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    const done = readEvents(join(dir, ".loki/runs/e10-t7/events.jsonl")).at(-1)!;
    expect(done.type).toBe("run.completed");
  }, 30_000);

  test("F3: a verdict outside the Verdict union is FAILED and never reaches the PR hook", async () => {
    const dir = repo();
    const code = `console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "PWNED", not_proven: [] } }));`;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-t8", repoDir: dir, env: supEnv(), workerArgv: worker(code), pr: pr.step });
    expect(r.verdict).toBe("FAILED");
    expect(pr.calls.length).toBe(0);
  }, 30_000);

  // E-66 review finding 1: an ALREADY_SATISFIED run (issue-closed, or the evidence-confirmed
  // no-change path) has nothing to open a PR over -- opening one anyway would push an empty or
  // stale branch. Reproduces the review's mutation: reverting the `verdict !== "ALREADY_SATISFIED"`
  // guard in supervisor.ts would turn this green into a call to pr.step.
  test("F5: an ALREADY_SATISFIED verdict never reaches the PR hook", async () => {
    const dir = repo();
    const code = `console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "ALREADY_SATISFIED", not_proven: [] } }));`;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-t10", repoDir: dir, env: supEnv(), workerArgv: worker(code), pr: pr.step });
    expect(r.verdict).toBe("ALREADY_SATISFIED");
    expect(pr.calls.length).toBe(0);
    expect(r.prUrl).toBeNull();
  }, 30_000);

  test("F4: malformed session.ended and negative cost data are dropped", async () => {
    const dir = repo();
    const code = `
console.log(JSON.stringify({ type: "session.ended", stage: "implement", data: {} }));
console.log(JSON.stringify({ type: "cost", stage: "implement", data: { session_id: "s1", usd: -5 } }));
console.log(JSON.stringify({ type: "cost", stage: "implement", data: { session_id: "s1", usd: 0.25 } }));
`;
    await runSupervisor({ runId: "e10-t9", repoDir: dir, env: supEnv(), workerArgv: worker(code) });
    const events = readEvents(join(dir, ".loki/runs/e10-t9/events.jsonl"));
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
    expect(events.filter((e) => e.type === "cost").map((e) => e.data.usd)).toEqual([0.25]);
    expect(events.at(-1)!.data.cost_usd).toBe(0.25);
  }, 30_000);

  // E-66 review finding 4: a text run has no issue to post the already-done comment to, so main()
  // must print it directly instead of silently dropping it the way an issue run's unwired argv
  // would otherwise mislead an operator into thinking nothing was decided.
  test("alreadyDoneTextComment: a confirmed text run's comment is picked up for printing", () => {
    const ev = (data: Record<string, unknown>): EventEnvelope => ({ v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", run: "r1", type: "stage.completed", stage: "intake", data });
    const events = [ev({ source: "text", already_satisfied: true, comment: "Loki 10: no change needed." })];
    expect(alreadyDoneTextComment(events)).toBe("Loki 10: no change needed.");
  });

  test("alreadyDoneTextComment: null for an issue run (it has comment_argv instead)", () => {
    const ev = (data: Record<string, unknown>): EventEnvelope => ({ v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", run: "r1", type: "stage.completed", stage: "intake", data });
    const events = [ev({ source: "issue", already_satisfied: true, comment: "Loki 10: no change needed.", comment_argv: ["comment"] })];
    expect(alreadyDoneTextComment(events)).toBeNull();
  });

  test("alreadyDoneTextComment: null for a normal (not already-satisfied) run", () => {
    const ev = (data: Record<string, unknown>): EventEnvelope => ({ v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", run: "r1", type: "stage.completed", stage: "intake", data });
    const events = [ev({ source: "text", already_satisfied: false })];
    expect(alreadyDoneTextComment(events)).toBeNull();
  });

  const SUMMARY: SummaryInput = { pr: null, verdict: "ALREADY_SATISFIED", notProven: [], flaky: [], cost: { usd: null, provider: "claude", tokens: null }, wallS: 1, stages: [] };

  // renderMainOutput is what main() actually writes to stdout (main() itself cannot be driven end
  // to end from a test process: it re-spawns process.argv[1] as the worker, which is not cli.ts
  // under a test runner). This is the real, red-then-green-verified proof that a text run's comment
  // reaches the operator's terminal, not just intake's own stage data.
  test("renderMainOutput: a confirmed text run prints the comment ahead of the summary", () => {
    const ev = (data: Record<string, unknown>): EventEnvelope => ({ v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", run: "r1", type: "stage.completed", stage: "intake", data });
    const events = [ev({ source: "text", already_satisfied: true, comment: "Loki 10: no change needed.\n\nEvidence:\n- a.ts: foo" })];
    const out = renderMainOutput(events, SUMMARY, "e10-t11", "sonnet");
    expect(out.startsWith("\nLoki 10: no change needed.\n\nEvidence:\n- a.ts: foo\n")).toBe(true);
    expect(out).toContain("Verdict:    ALREADY_SATISFIED");
    expect(out).toContain("Run:        e10-t11");
  });

  test("renderMainOutput: an issue run (or any run with no text comment) prints only the summary", () => {
    const ev = (data: Record<string, unknown>): EventEnvelope => ({ v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", run: "r1", type: "stage.completed", stage: "intake", data });
    const events = [ev({ source: "issue", already_satisfied: true, comment: "would post to the issue", comment_argv: ["comment"] })];
    const out = renderMainOutput(events, SUMMARY, "e10-t12", "sonnet");
    expect(out).not.toContain("would post to the issue");
    expect(out.startsWith("PR:")).toBe(true);
  });

  test("worker refuses a real token and emits JSON lines", async () => {
    expect(() => assertWorkerEnv({ GITHUB_TOKEN: CANARY })).toThrow();
    expect(() => assertWorkerEnv({ GITHUB_TOKEN: "ghp_LOKIWITHHELDsentinel1abcINVALID" })).not.toThrow();
    const lines: string[] = [];
    await runWorker(async (emit) => { emit("stage.started", "intake", { target_s: 15, limit_s: 60 }); },
      { env: {}, write: (s) => lines.push(s) });
    expect(JSON.parse(lines[0]!)).toEqual({ type: "stage.started", stage: "intake", data: { target_s: 15, limit_s: 60 } });
  });
});
