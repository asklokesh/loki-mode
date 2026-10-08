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
  test("flag off yields nothing", () => {
    expect(stageEffort("implement", {})).toBeUndefined();
    expect(fixEffort(2, true, {})).toBeUndefined();
  });
  test("precedence: user env, then opts, then policy", () => {
    expect(resolveEffort("implement", "high", { ...ON, LOKI_E10_EFFORT: "low" })).toBe("low");
    expect(resolveEffort("implement", "high", ON)).toBe("high");
    expect(resolveEffort("implement", undefined, ON)).toBe("medium");
  });
});

describe("child env", () => {
  test("policy on: implement and wall medium, fix uses the passed effort", async () => {
    process.env["LOKI_E10_EFFORT_POLICY"] = "rerun";
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
  test("flag off: no env gains LOKI_E10_EFFORT", async () => {
    for (const s of ["implement", "wall", "fix"]) expect(effortLine(await envFor(s))).toBeUndefined();
  });
});
