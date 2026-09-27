// E-03 Wall: supervisor/worker split, Rule of Two, tamper check, eval marker.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../src/engine10/events.ts";
import { runSupervisor, TAMPER_NOT_PROVEN, type PrStep } from "../../src/engine10/supervisor.ts";
import { assertWorkerEnv, runWorker } from "../../src/engine10/worker.ts";

const CANARY = "ghp_CANARYrealtoken0123456789abcdef";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-r2-"));
  roots.push(d);
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  return d;
}

function supEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: CANARY, GH_TOKEN: CANARY };
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

  test("worker refuses a real token and emits JSON lines", async () => {
    expect(() => assertWorkerEnv({ GITHUB_TOKEN: CANARY })).toThrow();
    expect(() => assertWorkerEnv({ GITHUB_TOKEN: "ghp_LOKIWITHHELDsentinel1abcINVALID" })).not.toThrow();
    const lines: string[] = [];
    await runWorker(async (emit) => { emit("stage.started", "intake", { target_s: 15, limit_s: 60 }); },
      { env: {}, write: (s) => lines.push(s) });
    expect(JSON.parse(lines[0]!)).toEqual({ type: "stage.started", stage: "intake", data: { target_s: 15, limit_s: 60 } });
  });
});
