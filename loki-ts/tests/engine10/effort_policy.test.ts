import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// ER-01: effort policy matrix, flag-off identity, user override precedence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixEffort, resolveEffort, stageEffort } from "../../src/contrib/effort_policy.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

const ON = { LOKI_E10_EFFORT_POLICY: "rerun" } as NodeJS.ProcessEnv;
let tmp: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["LOKI_E10_EFFORT", "LOKI_E10_EFFORT_POLICY"];
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "er01-")); for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } rmSync(tmp, { recursive: true, force: true }); });

async function envFor(stage: string, o: Partial<SessionRunOptions> = {}): Promise<string> {
  const out = join(tmp, `env-${stage}.txt`);
  const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", `env > '${out}'`]] });
  await runner.run({ stage, brief: "b", tier: "development", iterationId: `er01-${stage}`, limitS: 20, signal: new AbortController().signal, cwd: tmp, ...o } as SessionRunOptions);
  return readFileSync(out, "utf8");
}
const effortLine = (env: string) => /^LOKI_E10_EFFORT=(.*)$/m.exec(env)?.[1];

describe("pure policy", () => {
  test("stage matrix", () => {
    expect(stageEffort("implement", ON)).toBe("medium");
    expect(stageEffort("wall", ON)).toBe("medium");
    expect(stageEffort("plan", ON)).toBeUndefined();
    expect(fixEffort(1, true, ON)).toBe("high");
    expect(fixEffort(1, false, ON)).toBe("high");
    expect(fixEffort(2, true, ON)).toBe("xhigh");
    expect(fixEffort(2, false, ON)).toBe("high");
    expect(fixEffort(3, true, ON)).toBe("xhigh");
  });
  test("default on: unset env applies the policy", () => {
    expect(stageEffort("implement", {})).toBe("medium");
    expect(stageEffort("wall", {})).toBe("medium");
    expect(fixEffort(1, false, {})).toBe("high");
    expect(fixEffort(2, true, {})).toBe("xhigh");
  });
  test("opt-out yields nothing", () => {
    for (const v of ["off", "0", "false", "legacy"]) {
      expect(stageEffort("implement", { LOKI_E10_EFFORT_POLICY: v })).toBeUndefined();
      expect(fixEffort(2, true, { LOKI_E10_EFFORT_POLICY: v })).toBeUndefined();
    }
  });
  test("precedence: user env, then opts, then policy", () => {
    expect(resolveEffort("implement", "high", { ...ON, LOKI_E10_EFFORT: "low" })).toBe("low");
    expect(resolveEffort("implement", "high", ON)).toBe("high");
    expect(resolveEffort("implement", undefined, ON)).toBe("medium");
  });
});

describe("child env", () => {
  test("policy default on: implement and wall medium, fix uses the passed effort", async () => {
    expect(effortLine(await envFor("implement"))).toBe("medium");
    expect(effortLine(await envFor("wall"))).toBe("medium");
    expect(effortLine(await envFor("fix", { effort: "xhigh" }))).toBe("xhigh");
    expect(effortLine(await envFor("plan"))).toBeUndefined();
  });
  test("user LOKI_E10_EFFORT=low wins everywhere", async () => {
    process.env["LOKI_E10_EFFORT_POLICY"] = "rerun";
    process.env["LOKI_E10_EFFORT"] = "low";
    for (const s of ["implement", "wall", "plan"]) expect(effortLine(await envFor(s))).toBe("low");
    expect(effortLine(await envFor("fix", { effort: "xhigh" }))).toBe("low");
  });
  test("opt-out: no env gains LOKI_E10_EFFORT", async () => {
    process.env["LOKI_E10_EFFORT_POLICY"] = "off";
    for (const s of ["implement", "wall", "fix"]) expect(effortLine(await envFor(s))).toBeUndefined();
  });
});

describe("ER-05: a resumed session keeps its effort unless the stage escalates", () => {
  const stub = (iter: string, sid: string) => `mkdir -p .loki && echo '{"session_id":"${sid}"}' > .loki/e10-session-${iter}.json; env > '${join(tmp, `env-${iter}.txt`)}'`;
  async function call(iter: string, o: Partial<SessionRunOptions>, sid: string, events: string[] = []): Promise<string | undefined> {
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", stub(iter, sid)]], emit: (t) => { events.push(t); } });
    await runner.run({ stage: "implement", brief: "b", tier: "development", iterationId: iter, limitS: 20, signal: new AbortController().signal, cwd: tmp, ...o } as SessionRunOptions);
    return effortLine(readFileSync(join(tmp, `env-${iter}.txt`), "utf8"));
  }
  test("resumed call whose stage policy says medium after a high session keeps high", async () => {
    expect(await call("er05-a1", { effort: "high" }, "S-A")).toBe("high");
    const events: string[] = [];
    expect(await call("er05-a2", { resumeSessionId: "S-A" }, "S-A2", events)).toBe("high");
    expect(events).not.toContain("effort_escalation_cache_reset");
  });
  test("escalation high to xhigh is allowed and logs effort_escalation_cache_reset", async () => {
    expect(await call("er05-b1", { effort: "high" }, "S-B")).toBe("high");
    const events: string[] = [];
    expect(await call("er05-b2", { effort: "xhigh", resumeSessionId: "S-B" }, "S-B2", events)).toBe("xhigh");
    expect(events).toContain("effort_escalation_cache_reset");
  });
  test("a fresh session (no resume id) is unaffected", async () => {
    expect(await call("er05-c1", { effort: "high" }, "S-C")).toBe("high");
    expect(await call("er05-c2", {}, "S-C2")).toBe("medium");
  });
});
