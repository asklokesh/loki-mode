// EL-W0-06 (D86, FC-04, L1): engine10 never pins a weaker model than raw `claude -p` would use.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeProvider } from "../../src/runner/providers.ts";
import { _resetClaudeHelpCacheForTest } from "../../src/providers/claude_flags.ts";
import { PROVIDER_DEFAULT_MODEL, createSessionRunner, resolveModel } from "../../src/engine10/session.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { modelDowngrades } from "../../src/runner/model_downgrades.ts";
import type { RunContext, SessionRunOptions } from "../../src/engine10/types.ts";

const LOKI_TS = resolve(import.meta.dir, "../..");
const E2E = join(import.meta.dir, "fixtures", "e2e");
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

  test("the provider-default label passed as opts.model is no pin: no label in the child env, default marker kept", async () => {
    const dumped = await childEnvDump({ model: PROVIDER_DEFAULT_MODEL });
    expect(dumped).not.toContain("provider default");
    expect(dumped).not.toMatch(/^LOKI_(CLAUDE_)?MODEL_DEVELOPMENT=/m);
    expect(dumped).toContain("LOKI_E10_MODEL_DEFAULT=1");
  }, 20_000);

  test("LOKI_MODEL_OVERRIDE=sonnet records a downgrade", () => {
    const d = modelDowngrades("claude", { LOKI_MODEL_OVERRIDE: "sonnet" });
    expect(d).toEqual([{ stage: "all", model: "sonnet", reason: "LOKI_MODEL_OVERRIDE" }]);
    expect(modelDowngrades("claude", { LOKI_CLAUDE_MODEL_DEVELOPMENT: "haiku" })[0]?.stage).toBe("implement");
  });

  test("non-claude providers record nothing and the resolved default is never a weak alias", () => {
    expect(modelDowngrades("codex", { LOKI_MODEL_OVERRIDE: "sonnet" })).toEqual([]);
    expect(resolveModel("claude")).not.toBe("sonnet");
  });
});

// Real entry (bin/loki, stub claude CLI): the argv the model actually got, per stage.
function runDefault(): { argv: string[]; out: string; started: Record<string, unknown> } {
  const repo = join(tmp, "repo");
  cpSync(join(E2E, "repo"), repo, { recursive: true });
  const git = (...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: repo, env: process.env }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "e2e"); git("config", "user.email", "e2e@example.invalid");
  git("add", "calc.ts", "calc.test.ts", "bunfig.toml"); git("commit", "-q", "-m", "base");
  const argvLog = join(tmp, "argv-stub.log");
  const env: Record<string, string | undefined> = {
    ...process.env, LOKI_TS_ENTRY: join(LOKI_TS, "src", "cli.ts"), LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(E2E, "bin", "claude"), PATH: `${join(E2E, "bin")}:${process.env.PATH ?? ""}`,
    E2E_STUB_MODE: "done", E2E_STUB_ARGV_LOG: argvLog, LOKI_NO_BROWSER: "1", LOKI_E10_PLAN: "1",
    LOKI_RECEIPT_SIGNING_KEY_FILE: join(tmp, "k.pem"),
  };
  for (const k of ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST", "LOKI_CLAUDE_MODEL_PLANNING", "LOKI_MODEL_PLANNING", "LOKI_LEGACY_BASH", "LOKI_RECEIPT_SIGNING_KEY", "LOKI_E10_CASCADE", "LOKI_E10_WALL_TIER", "LOKI_MAX_TIER", "LOKI_TIER_ROUTING", "LOKI_ALLOW_HAIKU"]) delete env[k];
  const r = Bun.spawnSync(["bash", resolve(LOKI_TS, "../bin/loki"), "add a multiply(a, b) function to calc.ts", "--no-pr"], { cwd: repo, env, timeout: 90_000 });
  const marker = JSON.parse(readFileSync(join(repo, ".loki", "engine.json"), "utf8")) as { events: string };
  const events = readFileSync(join(repo, marker.events), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { argv: existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : [], out: r.stdout.toString() + r.stderr.toString(), started: events.find((e) => e.type === "run.started").data };
}

describe("EL-W0-06 a default run end to end", () => {
  test("implement runs with no --model; the pinned plan stage and the downgrade list are visible", () => {
    const { argv, out, started } = runDefault();
    const impl = argv.find((l) => l.startsWith("implement"));
    expect(impl).toBeDefined();
    expect(impl).not.toContain("--model");
    expect(argv.join("\n")).not.toContain("provider default");
    expect(argv.find((l) => l.startsWith("plan"))).toContain("--model sonnet");
    const stages = (started.downgrades as { stage: string }[]).map((d) => d.stage);
    expect(stages).toEqual(expect.arrayContaining(["plan", "wall", "already_done"]));
    expect(out).toContain("downgrade:");
  }, 120_000);
});

describe("EL-W0-06 fix rounds never leak the label and never go below the default", () => {
  const groups = [{ signature: "bun:a.test.ts", count: 1, sample: "FULL OUTPUT" }];
  async function fixEnv(prior: Record<string, Record<string, unknown>>): Promise<string> {
    const out = join(tmp, "fixenv.txt");
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", ["-c", `env > '${out}'`]] });
    const ctx = {
      runId: "e10-l1fix", repoDir: tmp, runDir: tmp, baseSha: "abc", branch: "b", provider: "claude", model: PROVIDER_DEFAULT_MODEL, deep: false, capS: 900, emit: () => {},
      sessions: runner, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => Date.now() },
      outputs: () => ({ intake: { task: "t" }, verify: { failures_grouped: groups }, ...prior }),
    } as unknown as RunContext;
    await fixStage.run(ctx, new AbortController().signal);
    return readFileSync(out, "utf8");
  }
  test("first failure at the default: no pin reaches the child", async () => {
    const env = await fixEnv({});
    expect(env).toContain("LOKI_E10_MODEL_DEFAULT=1");
    expect(env).not.toContain("provider default");
    expect(env).not.toMatch(/^LOKI_(CLAUDE_)?MODEL_DEVELOPMENT=/m);
  }, 20_000);
  test("repeated failure at the default: escalates up to opus, the label never reaches the child", async () => {
    const env = await fixEnv({ fix: { round: 1, signatures: "bun:a.test.ts", diagnosis: "d" } });
    expect(env).not.toContain("provider default");
    expect(env).toMatch(/^LOKI_CLAUDE_MODEL_DEVELOPMENT=.*opus/m);
    expect(env).not.toContain("LOKI_E10_MODEL_DEFAULT=1");
  }, 20_000);
});

describe("EL-W0-06 auxiliary pins are listed", () => {
  test("default env lists plan, wall and already_done; opus override still lists wall pins; cascade opt-in is listed; all-opus is empty", () => {
    expect(modelDowngrades("claude", {}).map((d) => d.stage)).toEqual(["plan", "wall", "already_done"]);
    expect(modelDowngrades("claude", { LOKI_MODEL_OVERRIDE: "opus" }).map((d) => d.stage)).toEqual(["wall", "already_done"]);
    expect(modelDowngrades("claude", { LOKI_E10_CASCADE: "1" })[0]?.stage).toBe("implement,fix");
    expect(modelDowngrades("claude", { LOKI_E10_WALL_TIER: "opus", LOKI_CLAUDE_MODEL_FAST: "opus" })).toEqual([]);
  });
});
