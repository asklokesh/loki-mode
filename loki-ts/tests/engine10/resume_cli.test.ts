// E-46 (docs/v10/BOARD.md): wire --resume end to end through the supervisor (refused today). machine.ts
// already skips any stage whose stage.completed is in `opts.prior` -- the resume primitive itself -- and
// E-39's resume_e2e.test.ts proves that primitive end to end with a fake worker. This file drives
// supervisor.ts's own pieces directly, without duplicating either: main() no longer hard-refuses
// --resume, and runSupervisor() never re-spawns or re-seals a run whose log already holds run.completed
// -- it reports the recorded verdict and opens any still-pending PR exactly once.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readEvents } from "../../src/engine10/events.ts";
import { eventsRelPath, main, runSupervisor, type PrStep } from "../../src/engine10/supervisor.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-resume-cli-"));
  roots.push(d);
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  execFileSync("git", ["-C", d, "config", "user.email", "e10@test"]);
  execFileSync("git", ["-C", d, "config", "user.name", "e10 test"]);
  return d;
}

/** A resolvable stand-in for the claude CLI, so preflight's provider-on-PATH check passes hermetically. */
function stubClaude(): string {
  const bin = mkdtempSync(join(tmpdir(), "e10-resume-cli-bin-"));
  roots.push(bin);
  const p = join(bin, "claude");
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

/** Seeds a run's events.jsonl directly (no real worker), for the runSupervisor-level tests below. */
function seedCompleted(dir: string, runId: string, data: Record<string, unknown>): void {
  new EventLog(join(dir, eventsRelPath(runId)), runId).append("run.completed", null, data);
}

function capture(stream: "stdout" | "stderr", fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const target = process[stream];
  const orig = target.write.bind(target);
  let out = "";
  target.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof target.write;
  return fn().then((code) => ({ code, out })).finally(() => { target.write = orig; });
}

const prevCwd = process.cwd();
afterEach(() => { process.chdir(prevCwd); });

describe("E-46 --resume through the supervisor", () => {
  test("main() no longer hard-refuses --resume; an unknown run id gets a clear error and touches nothing", async () => {
    const dir = repo();
    process.chdir(dir);
    const { code, out } = await capture("stderr", () => main(["--resume", "no-such-run"]));
    expect(code).toBe(2);
    expect(out).toContain("no run to resume: no-such-run");
    expect(out).not.toContain("not wired yet");
    expect(existsSync(join(dir, ".loki"))).toBe(false);
  });

  test("runSupervisor resuming an already-completed run reports its recorded verdict and PR, and re-spawns nothing", async () => {
    const dir = repo();
    const runId = "e10-resume-done-1";
    seedCompleted(dir, runId, { verdict: "VERIFIED", pr_url: "https://github.com/acme/widget/pull/9", not_proven: ["full suite"], cost_usd: 0.1, wall_s: 12 });
    const before = readEvents(join(dir, eventsRelPath(runId)));

    const r = await runSupervisor({ runId, repoDir: dir, workerArgv: ["/nonexistent/loki-worker-should-not-run"] });

    expect(r.verdict).toBe("VERIFIED");
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/9");
    expect(r.notProven).toEqual(["full suite"]);
    expect(r.workerExit).toBe(0);
    expect(r.tampered).toBe(false);
    expect(readEvents(join(dir, eventsRelPath(runId)))).toEqual(before); // no duplicate run.completed, no worker spawned
  });

  test("runSupervisor resuming a completed run reports its recorded (null) PR as-is and never calls the PR step", async () => {
    const dir = repo();
    const runId = "e10-resume-done-2";
    seedCompleted(dir, runId, { verdict: "VERIFIED", pr_url: null, not_proven: [], cost_usd: 0, wall_s: 5 });
    let calls = 0;
    const prStep: PrStep = async () => { calls++; return { url: "https://github.com/acme/widget/pull/10", draft: false, existing: false }; };

    const r = await runSupervisor({ runId, repoDir: dir, workerArgv: ["/nonexistent/loki-worker-should-not-run"], pr: prStep });

    expect(calls).toBe(0); // resuming a finished run is inert: no second push attempt
    expect(r.prUrl).toBeNull();
    const after = readEvents(join(dir, eventsRelPath(runId)));
    expect(after.filter((e) => e.type === "run.completed").length).toBe(1); // never re-seals
  });

  test("runSupervisor resuming a NOT-yet-completed run (run.started only) still re-spawns a real worker on the same run id", async () => {
    const dir = repo();
    const runId = "e10-resume-inprogress";
    new EventLog(join(dir, eventsRelPath(runId)), runId).append("run.started", null, { provider: "claude" });

    const code = 'console.log(JSON.stringify({type:"receipt.sealed",stage:"seal",data:{verdict:"VERIFIED",not_proven:[]}}));';
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LOKI_CLAUDE_CLI: stubClaude() };
    const r = await runSupervisor({ runId, repoDir: dir, env, workerArgv: [process.execPath, "-e", code] });

    expect(r.verdict).toBe("VERIFIED");
    const events = readEvents(join(dir, eventsRelPath(runId)));
    expect(events.filter((e) => e.type === "run.started").length).toBe(2); // one per attempt, same seq space as E-39
    expect(events.filter((e) => e.type === "run.completed").length).toBe(1);
  });
});
