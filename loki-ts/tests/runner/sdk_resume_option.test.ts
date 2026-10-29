// MW-2: sdkQueryProvider passes `resume` only when engine10 sets LOKI_E10_RESUME_SESSION, and records the session id it saw.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInvocation } from "../../src/runner/types.ts";

let scratch: string;
let frames: Record<string, unknown>[] = [];
let seen: { prompt: string; options: Record<string, unknown> } | undefined;
const KEYS = ["LOKI_E10_MAX_TURNS", "FORCE_PROMPT_CACHING_5M", "LOKI_E10_CACHE_TTL", "LOKI_E10_RESUME_SESSION", "LOKI_E10_STAGE", "LOKI_ITERATION", "LOKI_HOST_GUARD"];
let backup: Record<string, string | undefined>;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-sdkresume-"));
  backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  seen = undefined;
  frames = [{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {}, session_id: "sess-new" }];
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (args: { prompt: string; options: Record<string, unknown> }) => {
      seen = args;
      return (async function* () { for (const f of frames) yield f; })();
    },
  }));
});
afterEach(() => {
  mock.restore();
  rmSync(scratch, { recursive: true, force: true });
  for (const k of KEYS) { if (backup[k] === undefined) delete process.env[k]; else process.env[k] = backup[k]; }
});
const call = (): ProviderInvocation => ({ provider: "claude", prompt: "p", tier: "development", cwd: scratch, iterationOutputPath: join(scratch, "out.txt"), mainLoop: true });

describe("sdkQueryProvider resume (MW-2)", () => {
  it("passes options.resume from LOKI_E10_RESUME_SESSION and writes the session id file", async () => {
    process.env["LOKI_E10_RESUME_SESSION"] = "sess-old";
    process.env["LOKI_E10_STAGE"] = "fix";
    process.env["LOKI_ITERATION"] = "r1-fix1";
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    expect((await sdkQueryProvider().invoke(call())).exitCode).toBe(0);
    expect(seen!.options["resume"]).toBe("sess-old");
    expect(JSON.parse(readFileSync(join(scratch, ".loki", "e10-session-r1-fix1.json"), "utf8"))).toEqual({ session_id: "sess-new" });
  });

  it("without the variable there is no resume option, and outside engine10 no id file", async () => {
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    expect("resume" in seen!.options).toBe(false);
    expect(existsSync(join(scratch, ".loki", "e10-session-0.json"))).toBe(false);
  });
});

// TEN-COST-12 r2: pin the SDK route call site of engine10CacheTtlEnv.
describe("sdkQueryProvider 5-minute cache TTL (TEN-COST-12)", () => {
  it("LOKI_E10_STAGE set gives query options.env FORCE_PROMPT_CACHING_5M=1", async () => {
    process.env["LOKI_E10_STAGE"] = "implement";
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    expect((seen!.options["env"] as Record<string, string>)["FORCE_PROMPT_CACHING_5M"]).toBe("1");
  });
  it("without LOKI_E10_STAGE options.env has no such key", async () => {
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    expect("FORCE_PROMPT_CACHING_5M" in (seen!.options["env"] as Record<string, string>)).toBe(false);
  });
});

// Engine10 liveness: every stage session carries a maxTurns cap and a turn-cap result is a bounded harness-owned stop.
describe("sdkQueryProvider maxTurns (engine10 liveness)", () => {
  it("the configured cap reaches query options.maxTurns inside a stage", async () => {
    process.env["LOKI_E10_STAGE"] = "implement";
    process.env["LOKI_E10_MAX_TURNS"] = "160";
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    expect(seen!.options["maxTurns"]).toBe(160);
  });
  it("no maxTurns outside an engine stage", async () => {
    process.env["LOKI_E10_MAX_TURNS"] = "160";
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    expect("maxTurns" in seen!.options).toBe(false);
  });
  it("session env derives the cap from the stage budget and honors an explicit value", async () => {
    const { clampBashTimeoutEnv } = await import("../../src/runner/worker_proc.ts");
    const a: NodeJS.ProcessEnv = {}; clampBashTimeoutEnv(a, 480);
    expect(a["LOKI_E10_MAX_TURNS"]).toBe("160");
    const b: NodeJS.ProcessEnv = { LOKI_E10_MAX_TURNS: "7" }; clampBashTimeoutEnv(b, 480);
    expect(b["LOKI_E10_MAX_TURNS"]).toBe("7");
    const c: NodeJS.ProcessEnv = { LOKI_E10_MAX_TURNS: "junk" }; clampBashTimeoutEnv(c, 5);
    expect(c["LOKI_E10_MAX_TURNS"]).toBe("10");
  });
  it("a stream ending in error_max_turns returns the harness exit code within a bounded time", async () => {
    process.env["LOKI_E10_STAGE"] = "implement";
    process.env["LOKI_E10_MAX_TURNS"] = "3";
    frames = [{ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.01, usage: {}, session_id: "s" }];
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    const { MAX_TURNS_EXIT } = await import("../../src/runner/worker_proc.ts");
    const t0 = Date.now();
    const r = await sdkQueryProvider().invoke(call());
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.exitCode).toBe(MAX_TURNS_EXIT);
  });
});
