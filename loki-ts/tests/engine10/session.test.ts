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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

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

  test("a non-claude provider gets no model override and no host guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-session-"));
    const envFile = join(dir, "env.txt");
    process.env["LOKI_MODEL_OVERRIDE"] = "override-model-x";
    process.env["SESSION_TEST_ENV_FILE"] = envFile;
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = join(dir, "gc3.pid");

    const runner = createSessionRunner({ provider: "codex", childCommand: ["bash", [STUB]] });
    await runner.run(baseOpts({ limitS: 1 }));

    const dumped = readFileSync(envFile, "utf8");
    expect(dumped).toContain("LOKI_SDK_LOOP=\n");
    expect(dumped).toContain("LOKI_HOST_GUARD=\n");
    expect(dumped).toContain("LOKI_CLAUDE_MODEL_PLANNING=\n");

    delete process.env["LOKI_MODEL_OVERRIDE"];
    delete process.env["SESSION_TEST_ENV_FILE"];
    delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
