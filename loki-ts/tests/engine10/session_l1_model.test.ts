// EL-W0-06 (D86, FC-04, L1): engine10 never pins a weaker model than raw `claude -p` would use.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProvider } from "../../src/runner/providers.ts";
import { _resetClaudeHelpCacheForTest } from "../../src/providers/claude_flags.ts";
import { createSessionRunner, resolveModel } from "../../src/engine10/session.ts";
import { modelDowngrades } from "../../src/runner/model_downgrades.ts";
import type { SessionRunOptions } from "../../src/engine10/types.ts";

const KEYS = ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_PLANNING", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_PLANNING", "LOKI_MODEL_DEVELOPMENT", "LOKI_MODEL_FAST", "LOKI_MAX_TIER", "LOKI_TIER_ROUTING", "LOKI_E10_MODEL_DEFAULT", "LOKI_E10_EFFORT", "LOKI_CLAUDE_CLI", "LOKI_E10_INVOKER"];
let tmp: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "loki-e10-l1-")); for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } rmSync(tmp, { recursive: true, force: true }); });

function opts(o: Partial<SessionRunOptions> = {}): SessionRunOptions {
  return { stage: "implement", brief: "b", tier: "development", iterationId: "e10-l1-1", limitS: 20, signal: new AbortController().signal, cwd: tmp, ...o } as SessionRunOptions;
}
// A child that dumps its env, standing in for the engine10 session child.
async function childEnvDump(o: Partial<SessionRunOptions> = {}): Promise<string> {
  const out = join(tmp, "env.txt");
  const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", `env > '${out}'`]] });
  await runner.run(opts(o));
  return readFileSync(out, "utf8");
}
// Runs the real claudeProvider against a stub CLI and returns the argv it was given.
async function providerArgv(): Promise<string[]> {
  const stub = join(tmp, "claude-stub"), log = join(tmp, "argv.log");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 0\n`);
  chmodSync(stub, 0o755);
  process.env["LOKI_CLAUDE_CLI"] = stub;
  _resetClaudeHelpCacheForTest();
  await claudeProvider().invoke({ provider: "claude", prompt: "p", tier: "development", cwd: tmp, iterationOutputPath: join(tmp, "iter", "o.log"), mainLoop: true } as never);
  return readFileSync(log, "utf8").split("\n");
}

describe("EL-W0-06 never below raw", () => {
  test("no env: the session marks the provider default and the claude argv carries no --model", async () => {
    const dumped = await childEnvDump();
    expect(dumped).toContain("LOKI_E10_MODEL_DEFAULT=1");
    expect(dumped).not.toContain("LOKI_CLAUDE_MODEL_DEVELOPMENT=");
    process.env["LOKI_E10_MODEL_DEFAULT"] = "1";
    expect(await providerArgv()).not.toContain("--model");
  }, 20_000);

  test("an explicit pin keeps --model even with the default marker present", async () => {
    process.env["LOKI_E10_MODEL_DEFAULT"] = "1";
    process.env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = "opus";
    const argv = await providerArgv();
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  }, 20_000);

  test("effort passes through when set and is absent from the child env when unset", async () => {
    expect(await childEnvDump()).not.toContain("LOKI_E10_EFFORT=");
    expect(await childEnvDump({ effort: "high" })).toContain("LOKI_E10_EFFORT=high");
  }, 20_000);

  test("LOKI_MODEL_OVERRIDE=sonnet records a downgrade", () => {
    const d = modelDowngrades("claude", { LOKI_MODEL_OVERRIDE: "sonnet" });
    expect(d).toEqual([{ stage: "all", model: "sonnet", reason: "LOKI_MODEL_OVERRIDE" }]);
    expect(modelDowngrades("claude", { LOKI_CLAUDE_MODEL_DEVELOPMENT: "haiku" })[0]?.stage).toBe("implement");
  });

  test("an explicit opus override, or nothing configured, records no downgrade", () => {
    expect(modelDowngrades("claude", { LOKI_MODEL_OVERRIDE: "opus" })).toEqual([]);
    expect(modelDowngrades("claude", {})).toEqual([]);
    expect(modelDowngrades("codex", { LOKI_MODEL_OVERRIDE: "sonnet" })).toEqual([]);
    expect(resolveModel("claude")).not.toBe("sonnet");
  });
});
