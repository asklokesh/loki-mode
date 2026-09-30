// E-65: engine10 provider sessions run lean (6 tools, no loki append, no MCP, project settings only); legacy is unchanged.
// S41-09: LOKI_E10_PREFIX=lean gives engine10 sessions a fixed-string systemPrompt (D41 item 2, D42 item 1).
import { afterEach, describe, expect, it } from "bun:test";
import { buildSdkLoopOptions, resolveSystemPrompt } from "../../src/runner/providers.ts";
import { LEAN_PREFIX } from "../../src/e10ext/lean_prefix.ts";

const args = { tier: "development", model: "claude-sonnet-5", cwd: "/nonexistent-e65" };
const savedStage = process.env["LOKI_E10_STAGE"];
const savedPrefix = process.env["LOKI_E10_PREFIX"];
afterEach(() => {
  if (savedStage === undefined) delete process.env["LOKI_E10_STAGE"];
  else process.env["LOKI_E10_STAGE"] = savedStage;
  if (savedPrefix === undefined) delete process.env["LOKI_E10_PREFIX"];
  else process.env["LOKI_E10_PREFIX"] = savedPrefix;
});

describe("engine10 lean SDK session options", () => {
  it("an engine10 session gets the lean shape", () => {
    process.env["LOKI_E10_STAGE"] = "implement";
    const o = buildSdkLoopOptions(args);
    expect(o.tools).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]);
    expect(o.noAppend).toBe(true);
    expect(o.settingSources).toEqual(["project"]);
    expect(o.mcpServers).toBeUndefined();
    expect(o.strictMcpConfig).toBe(true);
    expect(o.effort).toBe("high");
  });

  it("the legacy loop keeps its full shape", () => {
    delete process.env["LOKI_E10_STAGE"];
    const o = buildSdkLoopOptions(args);
    expect(o.tools).toBeUndefined();
    expect(o.noAppend).toBeUndefined();
    expect(o.settingSources).toEqual(["user", "project", "local"]);
    expect(o.effort).toBe("high");
  });
});

describe("S41-09 lean stable prefix (LOKI_E10_PREFIX=lean, flag)", () => {
  it("flag on: an engine10 session gets a fixed-string systemPrompt", () => {
    process.env["LOKI_E10_STAGE"] = "implement";
    process.env["LOKI_E10_PREFIX"] = "lean";
    const o = buildSdkLoopOptions(args);
    expect(typeof o.systemPrompt).toBe("string");
    expect(o.systemPrompt).toBe(LEAN_PREFIX);
  });

  it("flag on: the prefix is byte-identical across stages and across tasks", () => {
    process.env["LOKI_E10_PREFIX"] = "lean";
    process.env["LOKI_E10_STAGE"] = "plan";
    const plan = buildSdkLoopOptions(args);
    process.env["LOKI_E10_STAGE"] = "fix";
    const fix = buildSdkLoopOptions({ ...args, cwd: "/nonexistent-e65-task-2" });
    expect(plan.systemPrompt).toBe(LEAN_PREFIX); // not vacuous: both sides pinned to the real constant
    expect(plan.systemPrompt).toBe(fix.systemPrompt as string);
  });

  it("flag off (default): no systemPrompt override, engine10 or not", () => {
    delete process.env["LOKI_E10_PREFIX"];
    process.env["LOKI_E10_STAGE"] = "implement";
    expect(buildSdkLoopOptions(args).systemPrompt).toBeUndefined();
    delete process.env["LOKI_E10_STAGE"];
    expect(buildSdkLoopOptions(args).systemPrompt).toBeUndefined();
  });

  it("flag on but not an engine10 session: no override (legacy always keeps the preset)", () => {
    delete process.env["LOKI_E10_STAGE"];
    process.env["LOKI_E10_PREFIX"] = "lean";
    expect(buildSdkLoopOptions(args).systemPrompt).toBeUndefined();
  });

  it("resolveSystemPrompt: a string under the flag, the claude_code preset without it", () => {
    const on = resolveSystemPrompt({ systemPrompt: LEAN_PREFIX });
    expect(typeof on).toBe("string");
    expect(on).toBe(LEAN_PREFIX);

    const off = resolveSystemPrompt({ noAppend: true });
    expect(typeof off).toBe("object");
    expect(off).toEqual({ type: "preset", preset: "claude_code" });
  });
});
