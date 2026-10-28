// select: walk-all-src
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { childEnv, classifyExitCause, createSessionRunner, resolveModel, diffShortstat, diffSignature, HEARTBEAT_MS_DEFAULT, untrackedList } from "../../src/engine10/session.ts";
import { clampBashTimeoutEnv, killGroupWithGrace, pinBashShellEnv } from "../../src/runner/worker_proc.ts";
import { resultCostPath, sumResultCosts, UNMETERED } from "../../src/engine10/cost.ts";
import { liveArchivedCosts, withArchivedCosts } from "../../src/providers/provider_cost.ts";
const archivedCostIds = (root: string, ids: string[]): string[] => liveArchivedCosts(root, ids, UNMETERED);
import type { SessionRunOptions } from "../../src/engine10/types.ts";
import { execFileSync } from "node:child_process";

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

  test("a silent session emits one session.stalled and heartbeats carry a progress class", async () => {
    process.env["LOKI_E10_STALL_S"] = "0.1";
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", "sleep 2.5"]], heartbeatMs: 30, emit: (type, _s, data) => events.push({ type, data }) });
    await runner.run(baseOpts({ limitS: 30 }));
    delete process.env["LOKI_E10_STALL_S"];
    expect(events.filter((e) => e.type === "session.stalled").length).toBe(1);
    expect(events.find((e) => e.type === "heartbeat")?.data["progress"]).toBeDefined();
  }, 10_000);

  test("Q18-06: LOKI_E10_STALL_KILL_S kills a silent child; one session.ended with cause and reason stalled", async () => {
    process.env["LOKI_E10_STALL_KILL_S"] = "0.1";
    const events: { type: string; data: Record<string, unknown> }[] = [];
    try {
      const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", "sleep 20"]], heartbeatMs: 30, emit: (type, _s, data) => events.push({ type, data }) });
      const res = await runner.run(baseOpts({ limitS: 30 }));
      expect(res.killed).toBe(true);
    } finally {
      delete process.env["LOKI_E10_STALL_KILL_S"];
    }
    const ended = events.filter((e) => e.type === "session.ended");
    expect(ended.length).toBe(1);
    expect(ended[0]?.data["cause"]).toBe("stalled");
    expect(ended[0]?.data["reason"]).toBe("stalled");
  }, 15_000);

  test("Q18-06: with the stall-kill knob unset or 0, a silent child is not killed and session.ended has no reason key", async () => {
    for (const v of [undefined, "0"]) {
      if (v === undefined) delete process.env["LOKI_E10_STALL_KILL_S"]; else process.env["LOKI_E10_STALL_KILL_S"] = v;
      process.env["LOKI_E10_STALL_S"] = "0.1";
      const events: { type: string; data: Record<string, unknown> }[] = [];
      try {
        const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", "sleep 0.6"]], heartbeatMs: 30, emit: (type, _s, data) => events.push({ type, data }) });
        const res = await runner.run(baseOpts({ limitS: 30 }));
        expect(res.killed).toBe(false);
      } finally {
        delete process.env["LOKI_E10_STALL_KILL_S"];
        delete process.env["LOKI_E10_STALL_S"];
      }
      const ended = events.find((e) => e.type === "session.ended");
      expect(ended).toBeDefined();
      expect("reason" in (ended?.data ?? {})).toBe(false);
    }
  }, 15_000);

  test("P12-09b: a rerun with the same iterationId keeps the earlier attempt's cost (summed, not overwritten)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1209b-cost-"));
    try {
      const lokiRoot = join(dir, ".loki");
      const child = (usd: number) => ["bash", ["-c", `mkdir -p .loki/metrics; echo '{"total_cost_usd":${usd},"input_tokens":5,"output_tokens":5,"model":"m"}' > .loki/metrics/result-cost-$LOKI_ITERATION.json; exit 1`]] as [string, string[]];
      for (const usd of [1, 2]) await createSessionRunner({ provider: "claude", lokiRoot, childCommand: child(usd) }).run(baseOpts({ cwd: dir, iterationId: "q-1", limitS: 20 }));
      expect(existsSync(resultCostPath(lokiRoot, "q-1"))).toBe(true);
      expect(sumResultCosts(lokiRoot, withArchivedCosts(lokiRoot, ["q-1"])).usd).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  test("P12-09b: a zero-usage is_error record from a quota attempt does not blank the run's cost (E-69 stays honest)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1209b-zero-"));
    try {
      const lokiRoot = join(dir, ".loki");
      const rec = (usd: number, tok: number) => ["bash", ["-c", `mkdir -p .loki/metrics; echo '{"total_cost_usd":${usd},"input_tokens":${tok},"output_tokens":${tok},"model":"m"}' > .loki/metrics/result-cost-$LOKI_ITERATION.json; exit ${usd === 0 ? 1 : 0}`]] as [string, string[]];
      for (const [usd, tok] of [[0, 0], [2.5, 5]] as const) await createSessionRunner({ provider: "claude", lokiRoot, childCommand: rec(usd, tok) }).run(baseOpts({ cwd: dir, iterationId: "z-1", limitS: 20 }));
      const c = sumResultCosts(lokiRoot, archivedCostIds(lokiRoot, ["z-1"]));
      expect(c.usd).toBe(2.5);
      expect(c.missing).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  // P12-09b: an archived attempt that cost money or has unknown cost must stay in the sum (flagged partial/ambiguous), never be dropped.
  for (const [name, first, ambiguous] of [
    ["C: unpriced model, tokens but total_cost_usd null", '{"total_cost_usd":null,"input_tokens":90000,"output_tokens":20000,"model":"m"}', false],
    ["E: resumed attempt at $1.20 with resumed_from", '{"total_cost_usd":1.2,"input_tokens":50,"output_tokens":50,"model":"m","resumed_from":"e-0"}', true],
  ] as const) test(`P12-09b regression ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1209b-reg-"));
    try {
      const lokiRoot = join(dir, ".loki"), sh = (body: string, code: number) => ["bash", ["-c", `mkdir -p .loki/metrics; echo '${body}' > .loki/metrics/result-cost-$LOKI_ITERATION.json; exit ${code}`]] as [string, string[]];
      for (const [body, code] of [[first, 1], ['{"total_cost_usd":2.5,"input_tokens":5,"output_tokens":5,"model":"m"}', 0]] as const) await createSessionRunner({ provider: "claude", lokiRoot, childCommand: sh(body, code) }).run(baseOpts({ cwd: dir, iterationId: "r-1", limitS: 20 }));
      const ids = archivedCostIds(lokiRoot, ["r-1"]);
      expect(ids).toContain("r-1-q1"); // the archive is counted, not dropped
      const c = sumResultCosts(lokiRoot, ids);
      expect(ambiguous ? c.partialUsd >= 2.5 : c.usd === null && c.missing.includes("r-1-q1")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
  test("P12-09b regression I: an archived $0.80 zero-usage attempt is counted, only a $0 one never ran", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1209b-i-"));
    try {
      const lokiRoot = join(dir, ".loki"), sh = (body: string) => ["bash", ["-c", `mkdir -p .loki/metrics; echo '${body}' > .loki/metrics/result-cost-$LOKI_ITERATION.json; exit 1`]] as [string, string[]];
      for (const body of ['{"total_cost_usd":0.8,"input_tokens":0,"output_tokens":0,"model":"m"}', '{"total_cost_usd":2.5,"input_tokens":5,"output_tokens":5,"model":"m"}']) await createSessionRunner({ provider: "claude", lokiRoot, childCommand: sh(body) }).run(baseOpts({ cwd: dir, iterationId: "i-1", limitS: 20 }));
      expect(archivedCostIds(lokiRoot, ["i-1"])).toContain("i-1-q1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
  test("P12-09b: the unmetered stub record (B) is counted, not dropped as never-ran", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-p1209b-unm-"));
    try {
      const lokiRoot = join(dir, ".loki"), sh = (body: string) => ["bash", ["-c", `mkdir -p .loki/metrics; echo '${body}' > .loki/metrics/result-cost-$LOKI_ITERATION.json; exit 1`]] as [string, string[]];
      for (const body of ['{"total_cost_usd":0,"input_tokens":0,"output_tokens":0,"model":"m","source":"cli-invoker-unmetered"}', '{"total_cost_usd":2.5,"input_tokens":5,"output_tokens":5,"model":"m"}']) await createSessionRunner({ provider: "claude", lokiRoot, childCommand: sh(body) }).run(baseOpts({ cwd: dir, iterationId: "u-1", limitS: 20 }));
      expect(archivedCostIds(lokiRoot, ["u-1"])).toContain("u-1-q1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

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
  describe("live budget watcher", () => {
    const runWatch = async (prior: number, script: string, limitS: number) => {
      const dir = mkdtempSync(join(tmpdir(), "loki-e10-bw-"));
      const eff = join(dir, ".loki", "metrics", "efficiency");
      mkdirSync(eff, { recursive: true });
      writeFileSync(join(eff, "iteration-1.json"), JSON.stringify({ cost_usd: prior }));
      const events: string[] = [];
      const prev = process.env["LOKI_E10_MAX_COST_USD"];
      process.env["LOKI_E10_MAX_COST_USD"] = "5";
      try {
        const runner = createSessionRunner({
          provider: "codex", lokiRoot: join(dir, ".loki"), remaining: () => 5,
          emit: (t: string) => { events.push(t); }, childCommand: ["bash", ["-c", script.replace("EFF", eff)]],
        } as never);
        const result = await runner.run(baseOpts({ limitS, cwd: dir }));
        return { result, events };
      } finally {
        if (prev === undefined) delete process.env["LOKI_E10_MAX_COST_USD"]; else process.env["LOKI_E10_MAX_COST_USD"] = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    };
    test("spend from earlier runs over the cap does not kill a fresh session", async () => {
      const { result, events } = await runWatch(6, "sleep 6; echo done", 30);
      expect(result.killed).toBe(false);
      expect(events).not.toContain("guard.budget_stop");
    }, 20000);
    test("spend added during this session over the cap kills it", async () => {
      const { result, events } = await runWatch(6, `echo '{"cost_usd": 6}' > EFF/iteration-2.json; sleep 30`, 60);
      expect(result.killed).toBe(true);
      expect(events).toContain("guard.budget_stop");
    }, 20000);
  });
});

describe("P12-12c diffSignature sees in-place growth of one modified file", () => {
  const g = (d: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  test("shortstat repeats (1 file, 1 insertion) but the signature moves", () => {
    const d = mkdtempSync(join(tmpdir(), "p12-12c-"));
    try {
      g(d, "init", "-q"); writeFileSync(join(d, "a.txt"), "one\n"); g(d, "add", "a.txt"); g(d, "commit", "-qm", "init");
      writeFileSync(join(d, "a.txt"), "one\ntwo\n");
      const before = diffSignature(d), stat = diffShortstat(d);
      writeFileSync(join(d, "a.txt"), "one\ntwo-with-more-text\n");
      expect(diffShortstat(d)).toEqual(stat);
      expect(diffSignature(d)).not.toBe(before);
      expect(diffSignature(d)).toBe(diffSignature(d));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("P12-12d diffSignature base path and per-list budget", () => {
  const g = (d: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  const fixed = { files: 1, insertions: 1, deletions: 0 };
  const SPILL = 1100; // just over the 1000-file per-list budget; each file is a real write plus a git add, so the count is the test's cost
  test("cwd in a repo subdirectory: an in-place edit of a tracked file moves the signature", () => {
    const d = mkdtempSync(join(tmpdir(), "p12-12d-"));
    try {
      g(d, "init", "-q"); mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "a.txt"), "one\n"); g(d, "add", "sub/a.txt"); g(d, "commit", "-qm", "init");
      writeFileSync(join(d, "sub", "a.txt"), "one\ntwo\n");
      const sub = join(d, "sub"), before = diffSignature(sub, fixed);
      writeFileSync(join(sub, "a.txt"), "one\ntwo-with-more-text\n");
      expect(diffSignature(sub, fixed)).not.toBe(before);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("untracked growth is seen even with a very large tracked change list", () => {
    const d = mkdtempSync(join(tmpdir(), "p12-12d-"));
    try {
      g(d, "init", "-q");
      for (let i = 0; i < SPILL; i++) writeFileSync(join(d, `t${i}.txt`), "x\n");
      g(d, "add", "."); g(d, "commit", "-qm", "init");
      for (let i = 0; i < SPILL; i++) writeFileSync(join(d, `t${i}.txt`), "y\n");
      writeFileSync(join(d, "new.txt"), "a\n");
      const before = diffSignature(d, fixed);
      writeFileSync(join(d, "new.txt"), "a\nbbbbbbbbbbbb\n");
      expect(diffSignature(d, fixed)).not.toBe(before);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000); // two thousand-file writes and a git add/commit exceed bun's 5s default on a loaded host (FC-TEST-BULK-FIXTURE-DEFAULT-TIMEOUT)
});

describe("P12-12e diffSignature uses one scope from a repo subdirectory", () => {
  const g = (d: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  test("growth outside cwd leaves the signature alone, growth inside cwd moves it", () => {
    const d = mkdtempSync(join(tmpdir(), "p12-12e-"));
    try {
      g(d, "init", "-q"); mkdirSync(join(d, "sub")); mkdirSync(join(d, "other"));
      writeFileSync(join(d, "sub", "a.txt"), "one\n"); writeFileSync(join(d, "other", "b.txt"), "one\n"); g(d, "add", "."); g(d, "commit", "-qm", "init");
      const sub = join(d, "sub");
      writeFileSync(join(sub, "a.txt"), "one\ntwo\n");
      const before = diffSignature(sub);
      writeFileSync(join(d, "other", "b.txt"), "one\nelsewhere\n"); // outside cwd: not this run's progress
      expect(diffShortstat(sub).files).toBe(1);
      expect(diffSignature(sub)).toBe(before);
      writeFileSync(join(sub, "a.txt"), "one\ntwo-with-more-text\n"); // inside cwd
      expect(diffSignature(sub)).not.toBe(before);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("P12-12 diffShortstat counts untracked files", () => {
  const g = (d: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  test("a stage that only adds new files reads as nonzero, .loki and the real index untouched", () => {
    const d = mkdtempSync(join(tmpdir(), "p12-12-"));
    try {
      g(d, "init", "-q"); writeFileSync(join(d, "a.txt"), "one\n"); g(d, "add", "a.txt"); g(d, "commit", "-qm", "init");
      expect(diffShortstat(d)).toEqual({ files: 0, insertions: 0, deletions: 0 });
      writeFileSync(join(d, "new1.txt"), "x\ny\nz\n"); writeFileSync(join(d, "new 2.txt"), "q\n"); mkdirSync(join(d, ".loki")); writeFileSync(join(d, ".loki", "s.json"), "{}\n");
      expect(diffShortstat(d)).toEqual({ files: 2, insertions: 0, deletions: 0 });
      expect(g(d, "status", "--porcelain", "-uall")).toContain("?? new1.txt");
      expect(g(d, "diff", "--cached", "--name-only").trim()).toBe("");
      writeFileSync(join(d, "a.txt"), "one\ntwo\n");
      expect(diffShortstat(d)).toEqual({ files: 3, insertions: 1, deletions: 0 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("an untracked nested repo with no commits never drops the tracked change", () => {
    const d = mkdtempSync(join(tmpdir(), "p12-12-"));
    try {
      g(d, "init", "-q"); writeFileSync(join(d, "a.txt"), "one\n"); g(d, "add", "a.txt"); g(d, "commit", "-qm", "init");
      mkdirSync(join(d, "sub")); g(join(d, "sub"), "init", "-q"); writeFileSync(join(d, "a.txt"), "one\ntwo\n");
      const r = diffShortstat(d);
      expect(r.files).toBeGreaterThanOrEqual(1); expect(r.insertions).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("TEN-COST-13 lean prefix default", () => {
  const cfg = { provider: "claude" } as Parameters<typeof childEnv>[1];
  const o = { iterationId: "i", stage: "plan", brief: "b", tier: "development" } as Parameters<typeof childEnv>[0];
  test("defaults LOKI_E10_PREFIX to lean, and an explicit user value wins", () => {
    const saved = process.env["LOKI_E10_PREFIX"];
    try {
      delete process.env["LOKI_E10_PREFIX"];
      expect(childEnv(o, cfg)["LOKI_E10_PREFIX"]).toBe("lean");
      process.env["LOKI_E10_PREFIX"] = "off";
      expect(childEnv(o, cfg)["LOKI_E10_PREFIX"]).toBe("off");
    } finally { if (saved === undefined) delete process.env["LOKI_E10_PREFIX"]; else process.env["LOKI_E10_PREFIX"] = saved; }
  });
});

describe("turn cap env in a nested run", () => {
  const cfg = { provider: "claude" } as Parameters<typeof childEnv>[1];
  const o = { iterationId: "i", stage: "implement", brief: "b", tier: "development", limitS: 480 } as Parameters<typeof childEnv>[0];
  test("a stage session's derived cap is not inherited as an explicit value; a user value outside a stage still wins", () => {
    const saved = { stage: process.env["LOKI_E10_STAGE"], turns: process.env["LOKI_E10_MAX_TURNS"] };
    try {
      delete process.env["LOKI_E10_STAGE"]; process.env["LOKI_E10_MAX_TURNS"] = "7";
      expect(childEnv(o, cfg)["LOKI_E10_MAX_TURNS"]).toBe("7");
      process.env["LOKI_E10_STAGE"] = "implement"; // we are inside a stage session: the 7 was derived by the parent
      expect(childEnv(o, cfg)["LOKI_E10_MAX_TURNS"]).toBe("160");
    } finally {
      for (const [k, v] of [["LOKI_E10_STAGE", saved.stage], ["LOKI_E10_MAX_TURNS", saved.turns]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe("TEN-SPEED-21 heartbeat single ls-files", () => {
  test("heartbeat single ls-files: one heartbeat tick runs ls-files once", async () => {
    const d = mkdtempSync(join(tmpdir(), "ten-speed-21-")), bin = join(d, "bin"), log = join(d, "calls.log"), repo = join(d, "repo");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim(), oldPath = process.env["PATH"];
    try {
      mkdirSync(bin); mkdirSync(repo);
      writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = ls-files ] && echo x >> "${log}"; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
      execFileSync(real, ["init", "-q"], { cwd: repo }); writeFileSync(join(repo, "u.txt"), "a\n");
      process.env["PATH"] = `${bin}:${oldPath}`;
      const beats: number[] = [];
      const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", "sleep 0.7"]], heartbeatMs: 100, emit: (type) => { if (type === "heartbeat") beats.push(1); } });
      const r = await runner.run(baseOpts({ cwd: repo, limitS: 20 }));
      expect(r.exit).toBe(0);
      expect(beats.length).toBeGreaterThan(0);
      expect(readFileSync(log, "utf8").trim().split("\n").length).toBe(beats.length);
    } finally { process.env["PATH"] = oldPath; rmSync(d, { recursive: true, force: true }); }
  });
  test("background-task guard: claude session env disables background tasks and clamps Bash timeouts to the stage budget", () => {
    const saved = { d: process.env["BASH_DEFAULT_TIMEOUT_MS"], m: process.env["BASH_MAX_TIMEOUT_MS"] };
    delete process.env["BASH_DEFAULT_TIMEOUT_MS"]; delete process.env["BASH_MAX_TIMEOUT_MS"];
    try {
      const small = childEnv(baseOpts({ limitS: 20 }), { provider: "claude" });
      expect(small["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]).toBe("1");
      expect(small["BASH_DEFAULT_TIMEOUT_MS"]).toBe("30000"); // floor
      expect(small["BASH_MAX_TIMEOUT_MS"]).toBe("30000");
      const big = childEnv(baseOpts({ limitS: 600 }), { provider: "claude" });
      expect(big["BASH_DEFAULT_TIMEOUT_MS"]).toBe("120000"); // already under the budget: unchanged
      expect(big["BASH_MAX_TIMEOUT_MS"]).toBe("590000"); // 600s stage minus the 10s margin
      expect(childEnv(baseOpts({ limitS: 600 }), { provider: "codex" })["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]).toBeUndefined();
      const e: NodeJS.ProcessEnv = { BASH_DEFAULT_TIMEOUT_MS: "5000" };
      clampBashTimeoutEnv(e, 600);
      expect(e["BASH_DEFAULT_TIMEOUT_MS"]).toBe("5000"); // a smaller user value wins
    } finally {
      if (saved.d !== undefined) process.env["BASH_DEFAULT_TIMEOUT_MS"] = saved.d;
      if (saved.m !== undefined) process.env["BASH_MAX_TIMEOUT_MS"] = saved.m;
    }
  });

  test("claude session env pins SHELL to /bin/bash; opt-out and a missing bash leave it unchanged", () => {
    const saved = { s: process.env["SHELL"], k: process.env["LOKI_E10_KEEP_USER_SHELL"] };
    try {
      process.env["SHELL"] = "/bin/zsh"; delete process.env["LOKI_E10_KEEP_USER_SHELL"];
      const claude = childEnv(baseOpts({ limitS: 600 }), { provider: "claude" });
      expect(claude["SHELL"]).toBe(existsSync("/bin/bash") ? "/bin/bash" : "/bin/zsh");
      expect(claude["PATH"]).toBe(process.env["PATH"]);
      expect(childEnv(baseOpts({ limitS: 600 }), { provider: "codex" })["SHELL"]).toBe("/bin/zsh"); // claude provider only
      process.env["LOKI_E10_KEEP_USER_SHELL"] = "1";
      expect(childEnv(baseOpts({ limitS: 600 }), { provider: "claude" })["SHELL"]).toBe("/bin/zsh");
    } finally {
      if (saved.s !== undefined) process.env["SHELL"] = saved.s; else delete process.env["SHELL"];
      if (saved.k !== undefined) process.env["LOKI_E10_KEEP_USER_SHELL"] = saved.k; else delete process.env["LOKI_E10_KEEP_USER_SHELL"];
    }
    const a: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" }; pinBashShellEnv(a, () => true);
    expect(a["SHELL"]).toBe("/bin/bash");
    const b: NodeJS.ProcessEnv = { SHELL: "/bin/zsh" }; pinBashShellEnv(b, () => false);
    expect(b["SHELL"]).toBe("/bin/zsh");
    const c: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", LOKI_E10_KEEP_USER_SHELL: "1" }; pinBashShellEnv(c, () => true);
    expect(c["SHELL"]).toBe("/bin/zsh");
    const d: NodeJS.ProcessEnv = {}; pinBashShellEnv(d, () => true);
    expect(d["SHELL"]).toBe("/bin/bash");
  });

  test("fixture A: a Bash-like call past the clamped timeout ends inside the stage cap and never reports a background move", async () => {
    // Stub honoring the same two env contracts as Claude Code (timeout stops the command; background only when not disabled).
    const script = 'ms=${BASH_DEFAULT_TIMEOUT_MS:-120000}; timeout $((ms/1000)) sleep 60; if [ "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" = 1 ]; then echo "command stopped at its timeout"; else echo "moved to the background"; sleep 60; fi; echo LOKI_DONE';
    const saved = process.env["BASH_DEFAULT_TIMEOUT_MS"]; process.env["BASH_DEFAULT_TIMEOUT_MS"] = "1000";
    try {
      const t0 = Date.now();
      const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", script]] });
      const res = await runner.run(baseOpts({ limitS: 20 }));
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(res.killed).toBe(false);
      expect(res.summary).not.toContain("moved to the background");
      expect(res.summary).toContain("stopped at its timeout");
    } finally { if (saved === undefined) delete process.env["BASH_DEFAULT_TIMEOUT_MS"]; else process.env["BASH_DEFAULT_TIMEOUT_MS"] = saved; }
  }, 20_000);

  test("fixture B: a live background child after LOKI_DONE ends the session within 10s and its process group is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-bg-"));
    const pidFile = join(dir, "bg.pid");
    const events: string[] = [];
    try {
      const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", `sleep 300 & echo $! > "${pidFile}"; echo LOKI_DONE; exit 0`]], emit: (type) => events.push(type) });
      const t0 = Date.now();
      const res = await runner.run(baseOpts({ limitS: 120 }));
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(res.markers.done).toBe(true);
      expect(events).toContain("session.group_reaped");
      const bg = Number(readFileSync(pidFile, "utf8").trim());
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(bg)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});

describe("killGroupWithGrace re-checks the group before SIGKILL (CCR-01 r2 N1)", () => {
  const run = async (groupSurvivesTerm: boolean): Promise<string[]> => {
    const sent: string[] = [];
    const real = process.kill;
    let termSent = false;
    process.kill = ((pid: number, sig?: string | number) => {
      if (pid !== -424242) return real.call(process, pid, sig as never);
      if (sig === 0) { if (termSent && !groupSurvivesTerm) throw new Error("ESRCH"); return true; }
      sent.push(String(sig));
      if (sig === "SIGTERM") termSent = true;
      return true;
    }) as typeof process.kill;
    try { killGroupWithGrace(424242); await new Promise((r) => setTimeout(r, 2400)); } finally { process.kill = real; }
    return sent;
  };
  test("group gone after SIGTERM: no SIGKILL, so a reused pgid is never hit", async () => {
    expect(await run(false)).toEqual(["SIGTERM"]);
  }, 10_000);
  test("group still alive after the grace: SIGKILL follows", async () => {
    expect(await run(true)).toEqual(["SIGTERM", "SIGKILL"]);
  }, 10_000);
});

describe("opencode records the model it was asked for", () => {
  test("resolveModel: LOKI_OPENCODE_MODEL, else an unreported default naming the provider", () => {
    const prev = process.env["LOKI_OPENCODE_MODEL"], prevO = process.env["LOKI_MODEL_OVERRIDE"];
    delete process.env["LOKI_MODEL_OVERRIDE"];
    try {
      process.env["LOKI_OPENCODE_MODEL"] = "anthropic/some-model";
      expect(resolveModel("opencode")).toBe("anthropic/some-model");
      delete process.env["LOKI_OPENCODE_MODEL"];
      expect(resolveModel("opencode")).toBe("opencode default (unreported)");
    } finally { if (prev === undefined) delete process.env["LOKI_OPENCODE_MODEL"]; else process.env["LOKI_OPENCODE_MODEL"] = prev; if (prevO !== undefined) process.env["LOKI_MODEL_OVERRIDE"] = prevO; }
  });
  test("a stage's claude pin (Wall) never reaches session.started under opencode", async () => {
    const prev = process.env["LOKI_OPENCODE_MODEL"];
    process.env["LOKI_OPENCODE_MODEL"] = "anthropic/some-model";
    const events: { type: string; data: Record<string, unknown> }[] = [];
    try {
      const runner = createSessionRunner({ provider: "opencode", model: resolveModel("opencode"), childCommand: ["bash", ["-c", "true"]], emit: (type, _s, data) => events.push({ type, data }) });
      await runner.run(baseOpts({ limitS: 10, model: "claude-haiku-4-5" }));
    } finally { if (prev === undefined) delete process.env["LOKI_OPENCODE_MODEL"]; else process.env["LOKI_OPENCODE_MODEL"] = prev; }
    expect(events.find((e) => e.type === "session.started")?.data["model"]).toBe("anthropic/some-model");
  }, 10_000);
});
