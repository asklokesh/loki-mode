// loki-ts/tests/engine10/session.test.ts
//
// E-07 wall check. session.ts (SessionRunner, types.ts/E-01) spawns one
// provider session in its own process group and enforces limitS by killing
// the whole group, so a grandchild the session forks dies too. It emits a
// heartbeat event while waiting, and reaches the LOKI_MODEL_OVERRIDE env
// vars into the child only for provider "claude". run() takes only real
// SessionRunOptions fields -- the same shape E-08 (Implement) will call --
// with the provider/model/emit bound on the factory instead.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const STUB = join(import.meta.dir, "fixtures", "session", "stub.sh");
const STUB_MARKER = join(import.meta.dir, "fixtures", "session", "stub_marker.sh");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function baseOpts(overrides: Partial<SessionRunOptions> = {}): SessionRunOptions {
  return {
    stage: "implement",
    brief: "test brief",
    tier: "development",
    iterationId: "e10-test-1",
    limitS: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("engine10 session", () => {
  test("kills the whole process group at the limit, grandchild included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const gcPidFile = join(dir, "grandchild.pid");
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = gcPidFile;

    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB]] });
    const result = await runner.run(baseOpts({ limitS: 1 }));

    expect(result.killed).toBe(true);

    const gcPid = Number(readFileSync(gcPidFile, "utf8").trim());
    // Give the SIGKILL escalation (2s grace) time to land.
    await new Promise((r) => setTimeout(r, 2500));
    expect(isAlive(gcPid)).toBe(false);

    delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test("emits a heartbeat event while waiting", async () => {
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const runner = createSessionRunner({
      provider: "claude",
      childCommand: ["bash", [STUB_MARKER]],
      heartbeatMs: 30,
      emit: (type, stage, data) => events.push({ type, stage, data }),
    });
    await runner.run(baseOpts({ limitS: 30 }));

    const started = events.find((e) => e.type === "session.started");
    const heartbeats = events.filter((e) => e.type === "heartbeat");
    const ended = events.find((e) => e.type === "session.ended");
    expect(started?.data["provider"]).toBe("claude");
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[0]?.data["waiting_on"]).toBe("implement");
    expect(ended?.data["exit"]).toBe("already_done");
  }, 10_000);

  test("parses LOKI_ALREADY_DONE from stdout", async () => {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB_MARKER]] });
    const result = await runner.run(baseOpts({ limitS: 30 }));
    expect(result.exit).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.markers.alreadyDone).toBe("fixture evidence");
    expect(result.markers.specConflict).toBeNull();
  }, 10_000);

  test("the model override reaches the child env only for claude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const envFile = join(dir, "env.txt");
    process.env["LOKI_MODEL_OVERRIDE"] = "override-model-x";
    process.env["SESSION_TEST_ENV_FILE"] = envFile;
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = join(dir, "gc2.pid");

    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB]] });
    await runner.run(baseOpts({ limitS: 1 }));

    const dumped = readFileSync(envFile, "utf8");
    expect(dumped).toContain("LOKI_ITERATION=e10-test-1");
    expect(dumped).toContain("LOKI_SDK_LOOP=1");
    expect(dumped).toContain("LOKI_HOST_GUARD=1");
    expect(dumped).toContain("LOKI_CLAUDE_MODEL_PLANNING=override-model-x");
    expect(dumped).toContain("LOKI_CLAUDE_MODEL_DEVELOPMENT=override-model-x");
    expect(dumped).toContain("LOKI_CLAUDE_MODEL_FAST=override-model-x");

    delete process.env["LOKI_MODEL_OVERRIDE"];
    delete process.env["SESSION_TEST_ENV_FILE"];
    delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test("a non-claude provider passes inherited env through untouched (never blanked, never added)", async () => {
    // childEnv's real guarantee (session.ts:52-54): for a non-claude provider
    // it never TOUCHES LOKI_SDK_LOOP / LOKI_HOST_GUARD / the model-override
    // vars, one way or the other. It does not add them, and it must not blank
    // them either -- LOKI_HOST_GUARD in particular gates resolveProvider's
    // fail-closed throw (providers.ts:63), so clearing it would defeat it.
    // Asserting they come out empty only ever held because the test runner's
    // OWN ambient env happened not to have them set; set ambient values here
    // so the assertion exercises the actual contract instead of an accident.
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const envFile = join(dir, "env.txt");
    process.env["LOKI_MODEL_OVERRIDE"] = "override-model-x";
    process.env["SESSION_TEST_ENV_FILE"] = envFile;
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = join(dir, "gc3.pid");
    process.env["LOKI_SDK_LOOP"] = "ambient-sdk-loop";
    process.env["LOKI_HOST_GUARD"] = "ambient-host-guard";
    process.env["LOKI_CLAUDE_MODEL_PLANNING"] = "ambient-planning-model";

    const runner = createSessionRunner({ provider: "codex", childCommand: ["bash", [STUB]] });
    await runner.run(baseOpts({ limitS: 1 }));

    const dumped = readFileSync(envFile, "utf8");
    expect(dumped).toContain("LOKI_SDK_LOOP=ambient-sdk-loop");
    expect(dumped).toContain("LOKI_HOST_GUARD=ambient-host-guard");
    expect(dumped).toContain("LOKI_CLAUDE_MODEL_PLANNING=ambient-planning-model");

    delete process.env["LOKI_MODEL_OVERRIDE"];
    delete process.env["SESSION_TEST_ENV_FILE"];
    delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
    delete process.env["LOKI_SDK_LOOP"];
    delete process.env["LOKI_HOST_GUARD"];
    delete process.env["LOKI_CLAUDE_MODEL_PLANNING"];
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test("an already-aborted signal is honored before spawning: no child, no wait for the limit", async () => {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB]] });
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await runner.run(baseOpts({ limitS: 30, signal: controller.signal }));
    const elapsedS = (Date.now() - start) / 1000;
    expect(result.killed).toBe(true);
    expect(elapsedS).toBeLessThan(5);
  }, 10_000);

  test("abort during a running session kills the whole group, grandchild included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const gcPidFile = join(dir, "grandchild.pid");
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = gcPidFile;

    const controller = new AbortController();
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB]] });
    const runPromise = runner.run(baseOpts({ limitS: 30, signal: controller.signal }));

    await waitForFile(gcPidFile);
    const gcPid = Number(readFileSync(gcPidFile, "utf8").trim());
    controller.abort();
    const result = await runPromise;

    expect(result.killed).toBe(true);
    // Give the SIGKILL escalation (2s grace) time to land.
    await new Promise((r) => setTimeout(r, 2500));
    expect(isAlive(gcPid)).toBe(false);

    delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test("exports main matching cli.ts's routing contract for `engine10 session`", async () => {
    const { route, runEngine10 } = await import("../../src/engine10/cli.ts");
    expect(route(["session"])).toEqual({ module: "session.ts", fn: "main", args: [] });

    const mod = await import("../../src/engine10/session.ts");
    expect(typeof mod.main).toBe("function");

    // Prove the dispatch mechanism itself resolves without the "does not
    // export main" error, without invoking the real session (which spawns a
    // provider CLI -- never safe to do from a unit test). A probe loader
    // stands in for the exports cli.ts would see from the real file.
    const state: { calledWith: string[] | null } = { calledWith: null };
    const probeLoad = async (spec: string) => {
      expect(spec).toBe("./session.ts");
      return {
        main: (args: string[]) => {
          state.calledWith = args;
          return 0;
        },
      };
    };
    expect(await runEngine10(["session", "--x"], probeLoad)).toBe(0);
    expect(state.calledWith).toEqual(["--x"]);
  });
});
