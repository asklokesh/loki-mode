// E-65: engine10 provider sessions run lean (6 tools, no loki append, no MCP, project settings only); legacy is unchanged.
import { afterEach, describe, expect, it } from "bun:test";
import { buildSdkLoopOptions } from "../../src/runner/providers.ts";

const args = { tier: "development", model: "claude-sonnet-5", cwd: "/nonexistent-e65" };
const saved = process.env["LOKI_E10_STAGE"];
afterEach(() => {
  if (saved === undefined) delete process.env["LOKI_E10_STAGE"];
  else process.env["LOKI_E10_STAGE"] = saved;
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
