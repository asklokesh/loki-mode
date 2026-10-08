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
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { classifyExitCause, createSessionRunner, HEARTBEAT_MS_DEFAULT } from "../../src/engine10/session.ts";
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
const STUB_SIGTERM143 = join(import.meta.dir, "fixtures", "session", "stub_sigterm143.sh");

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
    // E-68: every heartbeat carries elapsed seconds and the diff stat, not just a "waiting" ping.
    expect(typeof heartbeats[0]?.data["elapsed_s"]).toBe("number");
    expect(heartbeats[0]?.data["elapsed_s"] as number).toBeGreaterThanOrEqual(0);
    expect(heartbeats[0]?.data["diff"]).toMatchObject({ files: expect.any(Number), insertions: expect.any(Number), deletions: expect.any(Number) });
    expect(ended?.data["exit"]).toBe("already_done");
    // E-68: exit is classified alongside the coarse ImplementExit, never left un-named.
    expect(ended?.data["cause"]).toBe("exit 0 (success)");
  }, 10_000);

  test("E-68: the heartbeat default is at most 30s, so a stuck provider call never goes silent longer", () => {
    expect(HEARTBEAT_MS_DEFAULT).toBeLessThanOrEqual(30_000);
  });

  test("E-68: classifyExitCause names every outcome; the string 'cause not classified' is never producible", () => {
    expect(classifyExitCause(0, false)).toBe("exit 0 (success)");
    expect(classifyExitCause(1, false)).toBe("exit 1 (general error)");
    expect(classifyExitCause(2, false)).toBe("exit 2 (misuse of shell command)");
    expect(classifyExitCause(124, false)).toBe("exit 124 (timeout)");
    expect(classifyExitCause(125, false)).toBe("exit 125 (timeout or container failure)");
    expect(classifyExitCause(126, false)).toBe("exit 126 (command not executable)");
    expect(classifyExitCause(127, false)).toBe("exit 127 (command not found)");
    expect(classifyExitCause(130, false)).toBe("exit 130 (SIGINT)");
    expect(classifyExitCause(137, false)).toBe("exit 137 (SIGKILL)");
    expect(classifyExitCause(143, false)).toBe("exit 143 (SIGTERM)");
    expect(classifyExitCause(null, true)).toBe("limit");
    expect(classifyExitCause(null, false)).toBe("external kill");
    // A code with no table entry still names the number: never a bare fallback string.
    expect(classifyExitCause(255, false)).toBe("exit 255 (unrecognized code)");
    expect(classifyExitCause(17, false)).toBe("exit 17 (unrecognized code)");
    // E-68 rework: classify from what the ENGINE knows, not the child's self-reported
    // code. A code the child made up (143, or anything else) while the engine itself
    // did the killing is always "limit" or "aborted", per which one fired.
    expect(classifyExitCause(143, true, "limit")).toBe("limit");
    expect(classifyExitCause(143, true, "aborted")).toBe("aborted");
    expect(classifyExitCause(0, true, "limit")).toBe("limit");
    expect(classifyExitCause(null, true, "aborted")).toBe("aborted");
    for (const [exit, killed] of [
      [0, false], [1, false], [2, false], [124, false], [125, false], [126, false], [127, false],
      [130, false], [137, false], [143, false], [255, false], [null, true], [null, false],
    ] as const) {
      expect(classifyExitCause(exit, killed)).not.toBe("cause not classified");
    }
  });

  test("E-68: 'cause not classified' does not appear anywhere in the engine10 source", () => {
    const root = join(import.meta.dir, "..", "..", "src", "engine10");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      expect(readFileSync(join(root, f), "utf8")).not.toContain("cause not classified");
    }
  });

  test("E-68: session.ended classifies the cause when the session is killed at the limit", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const runner = createSessionRunner({
      provider: "claude", childCommand: ["bash", [STUB]],
      emit: (type, _s, data) => events.push({ type, data }),
    });
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = join(dir, "gc.pid");
    try {
      await runner.run(baseOpts({ limitS: 1 }));
      const ended = events.find((e) => e.type === "session.ended");
      expect(ended?.data["cause"]).toBe("limit");
    } finally {
      delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  // Reviewer rejection on E-68's first pass: stub.sh dies BY SIGNAL (code
  // null) on SIGTERM, but the real session child is `bun src/cli.ts engine10
  // session`, which installs `process.on("SIGTERM", () => process.exit(143))`
  // before it dispatches (cli.ts:330) -- so a real limit kill reports exit
  // 143, not null. classifyExitCause must name that "limit" from what the
  // engine itself knows (it sent the SIGTERM), never from the child's
  // self-reported code. stub_sigterm143.sh traps TERM and exits 143 the same
  // way, so this reproduces the real behavior instead of the signal-death
  // shortcut the rejected test used.
  test("E-68: a child that traps SIGTERM and exits 143 (the real session route's behavior) is still classified as limit, not exit 143", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = join(dir, "gc.pid");
    const runner = createSessionRunner({
      provider: "claude", childCommand: ["bash", [STUB_SIGTERM143]],
      emit: (type, _s, data) => events.push({ type, data }),
    });
    try {
      const result = await runner.run(baseOpts({ limitS: 1 }));
      expect(result.exit).toBe(143);
      expect(result.killed).toBe(true);
      const ended = events.find((e) => e.type === "session.ended");
      expect(ended?.data["exit"]).toBe("killed");
      expect(ended?.data["cause"]).toBe("limit");
    } finally {
      delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  // Reviewer's minor (non-blocking) finding on the same review: `killed` is
  // set both by the limitS timer AND by an external abort (the machine's cap
  // or a stage-limit AbortController on opts.signal), so a fix that just
  // checks `killed` would also mislabel an external abort as "limit". The
  // engine knows which one fired; classify each by its real source.
  test("E-68: an external abort mid-session is classified as aborted, not limit", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const gcPidFile = join(dir, "gc.pid");
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = gcPidFile;
    const controller = new AbortController();
    const runner = createSessionRunner({
      provider: "claude", childCommand: ["bash", [STUB]],
      emit: (type, _s, data) => events.push({ type, data }),
    });
    try {
      const runPromise = runner.run(baseOpts({ limitS: 30, signal: controller.signal }));
      await waitForFile(gcPidFile);
      controller.abort();
      await runPromise;
      const ended = events.find((e) => e.type === "session.ended");
      expect(ended?.data["cause"]).toBe("aborted");
    } finally {
      delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("E-61: captures only the last 64 KB of stderr, tail-trimmed not truncated-from-start", async () => {
    const runner = createSessionRunner({
      provider: "claude",
      // More than 64 KB before the sentinel, so only the tail survives.
      childCommand: ["bash", ["-c", "head -c 70000 /dev/zero | tr '\\0' 'x' 1>&2; printf SENTINEL_TAIL 1>&2; exit 1"]],
    });
    const result = await runner.run(baseOpts({ limitS: 30 }));
    const tail = (result as unknown as { stderrTail?: string }).stderrTail;
    expect(result.exit).toBe(1);
    expect(result.killed).toBe(false);
    expect(typeof tail).toBe("string");
    expect(Buffer.byteLength(tail as string, "utf8")).toBe(65536);
    expect((tail as string).endsWith("SENTINEL_TAIL")).toBe(true);
  }, 10_000);

  test("E-61: a session with no stderr output reports an empty tail, never undefined", async () => {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB_MARKER]] });
    const result = await runner.run(baseOpts({ limitS: 30 }));
    const tail = (result as unknown as { stderrTail?: string }).stderrTail;
    expect(tail).toBe("");
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

  test("FIX-RESUME: a resumed session whose total may be cumulative emits no token figures on its cost event", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "loki-e10-session-cwd-"));
    const root = join(mkdtempSync(join(tmpdir(), "loki-e10-session-root-")), ".loki");
    const script = [
      "mkdir -p .loki/metrics",
      "echo '{\"total_cost_usd\":0.5,\"input_tokens\":3,\"output_tokens\":4,\"session_id\":\"S2\",\"resumed_from\":\"S1\"}' > .loki/metrics/result-cost-$LOKI_ITERATION.json",
    ].join("; ");
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const runner = createSessionRunner({ provider: "claude", model: "m-1", lokiRoot: root, childCommand: ["bash", ["-c", script]], emit: (type, _s, data) => events.push({ type, data }) });
    await runner.run(baseOpts({ limitS: 30, cwd }));
    const d = events.find((e) => e.type === "cost")!.data;
    expect(d["usd"]).toBeNull();
    expect(d["resume"]).toBe("ambiguous");
    for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]) expect(k in d).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("E-42: markers from the iteration log, real session.ended exit, cost priced into lokiRoot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "loki-e10-session-cwd-"));
    const root = join(mkdtempSync(join(tmpdir(), "loki-e10-session-root-")), ".loki");
    const script = [
      "mkdir -p .loki/metrics",
      "echo 'Finish with one line: LOKI_ALREADY_DONE: <evidence>' > .loki/iteration-$LOKI_ITERATION.log",
      "echo 'LOKI_ALREADY_DONE: from the log' >> .loki/iteration-$LOKI_ITERATION.log",
      "echo '{\"total_cost_usd\":0.5,\"input_tokens\":3,\"output_tokens\":4}' > .loki/metrics/result-cost-$LOKI_ITERATION.json",
    ].join("; ");
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const runner = createSessionRunner({
      provider: "claude", model: "m-1", lokiRoot: root, childCommand: ["bash", ["-c", script]],
      emit: (type, _s, data) => events.push({ type, data }),
    });
    const r = await runner.run(baseOpts({ limitS: 30, cwd }));
    expect(r.markers.alreadyDone).toBe("from the log");
    expect(events.find((e) => e.type === "session.ended")?.data.exit).toBe("already_done");
    expect(events.find((e) => e.type === "cost")?.data).toMatchObject({ session_id: "e10-test-1", usd: 0.5, input_tokens: 3 });
    const eff = JSON.parse(readFileSync(join(root, "metrics", "efficiency", "iteration-1.json"), "utf8"));
    expect(eff).toMatchObject({ cost_usd: 0.5, cost_source: "provider", model: "m-1", status: "completed" });
    expect(existsSync(join(root, "metrics", "result-cost-e10-test-1.json"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  }, 10_000);

  test("E-42: LOKI_E10_INVOKER=cli drops LOKI_SDK_LOOP and never sets LOKI_LEGACY_BASH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const envFile = join(dir, "env.txt");
    const saved = { inv: process.env.LOKI_E10_INVOKER, sdk: process.env.LOKI_SDK_LOOP };
    process.env.LOKI_E10_INVOKER = "cli";
    process.env.LOKI_SDK_LOOP = "1";
    try {
      const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", `env > ${envFile}`]] });
      await runner.run(baseOpts({ limitS: 30 }));
    } finally {
      if (saved.inv === undefined) delete process.env.LOKI_E10_INVOKER; else process.env.LOKI_E10_INVOKER = saved.inv;
      if (saved.sdk === undefined) delete process.env.LOKI_SDK_LOOP; else process.env.LOKI_SDK_LOOP = saved.sdk;
    }
    const dumped = readFileSync(envFile, "utf8");
    expect(dumped).not.toMatch(/^LOKI_SDK_LOOP=/m);
    expect(dumped).not.toMatch(/^LOKI_LEGACY_BASH=/m);
    expect(dumped).toContain("LOKI_HOST_GUARD=1");
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
