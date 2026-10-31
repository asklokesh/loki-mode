// v8 Phase 4 Story 4: hermetic test for sdkQueryProvider (NO API call). The
// Agent SDK's query() is stubbed via mock.module to yield a canned SDKMessage
// stream; we assert the provider satisfies the ProviderInvoker contract, writes
// the captured text to iterationOutputPath, derives the exit code fail-closed,
// spreads process.env, and delegates non-mainLoop calls to the CLI path.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_DEFAULT_MODEL } from "../../src/util/claude_model.ts";
import type { ProviderInvocation } from "../../src/runner/types.ts";

let scratch: string;
let lastQueryArgs: { prompt: string; options: Record<string, unknown> } | undefined;

// A fake query() that records its args and yields a caller-provided message set.
function stubQuery(messages: unknown[]) {
  lastQueryArgs = undefined;
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (args: { prompt: string; options: Record<string, unknown> }) => {
      lastQueryArgs = args;
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
  }));
}

function call(overrides: Partial<ProviderInvocation> = {}): ProviderInvocation {
  return {
    provider: "claude",
    prompt: "build the thing",
    tier: "development",
    cwd: scratch,
    iterationOutputPath: join(scratch, "iter-out.txt"),
    mainLoop: true,
    ...overrides,
  };
}

let prevClaudeCli: string | undefined;
let prevHostGuard: string | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-sdkprov-"));
  // Never spawn the real claude CLI in these hermetic tests: any path that
  // delegates to claudeProvider (mainLoop:false, or the default-off gate) would
  // otherwise hang on a live CLI. `true` exits 0 immediately for any argv.
  prevClaudeCli = process.env["LOKI_CLAUDE_CLI"];
  prevHostGuard = process.env["LOKI_HOST_GUARD"];
  process.env["LOKI_CLAUDE_CLI"] = "true";
  delete process.env["LOKI_HOST_GUARD"];
});
afterEach(() => {
  mock.restore(); // undo the module mock so it never leaks to other files
  rmSync(scratch, { recursive: true, force: true });
  if (prevClaudeCli === undefined) delete process.env["LOKI_CLAUDE_CLI"];
  else process.env["LOKI_CLAUDE_CLI"] = prevClaudeCli;
  if (prevHostGuard === undefined) delete process.env["LOKI_HOST_GUARD"];
  else process.env["LOKI_HOST_GUARD"] = prevHostGuard;
});

describe("sdkQueryProvider (hermetic, stubbed query)", () => {
  it("mainLoop success: writes captured text + returns exit 0 + capturedOutputPath", async () => {
    stubQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "hello from the loop" }] } },
      { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, usage: {}, result: "done" },
    ]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    const r = await sdkQueryProvider().invoke(call());
    expect(r.exitCode).toBe(0);
    expect(r.capturedOutputPath).toBe(join(scratch, "iter-out.txt"));
    const body = readFileSync(r.capturedOutputPath, "utf8");
    expect(body).toContain("hello from the loop");
    expect(body).toContain("done");
  });

  it("LOKI_CLAUDE_TASK_BUDGET reaches the query options as taskBudget {total}; unset or invalid omits it (#242)", async () => {
    const prev = process.env["LOKI_CLAUDE_TASK_BUDGET"];
    const msgs = [{ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, usage: {} }];
    const run = async (v: string | undefined) => {
      if (v === undefined) delete process.env["LOKI_CLAUDE_TASK_BUDGET"]; else process.env["LOKI_CLAUDE_TASK_BUDGET"] = v;
      stubQuery(msgs);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      return lastQueryArgs?.options?.["taskBudget"];
    };
    try {
      expect(await run("64000")).toEqual({ total: 64000 });
      expect(await run(undefined)).toBeUndefined();
      expect(await run("0")).toBeUndefined();
      expect(await run("abc")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["LOKI_CLAUDE_TASK_BUDGET"]; else process.env["LOKI_CLAUDE_TASK_BUDGET"] = prev;
    }
  });

  it("requested_model in the result-cost record is the exact model passed to query (P12-23)", async () => {
    const keys = ["LOKI_MAX_TIER", "LOKI_CLAUDE_MODEL_PLANNING", "LOKI_E10_MODEL_DEFAULT", "LOKI_ITERATION", "LOKI_ROUTER", "LOKI_TIER_ROUTING"];
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) { prev[k] = process.env[k]; delete process.env[k]; }
    process.env["LOKI_ITERATION"] = "7";
    const msgs = [
      { type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "s" },
      { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, usage: {}, session_id: "s" },
    ];
    const rec = () => JSON.parse(readFileSync(join(scratch, ".loki", "metrics", "result-cost-7.json"), "utf8"));
    try {
      process.env["LOKI_MAX_TIER"] = "sonnet";
      process.env["LOKI_CLAUDE_MODEL_PLANNING"] = "opus";
      stubQuery(msgs);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call({ tier: "planning" }));
      const passed = lastQueryArgs?.options?.["model"];
      expect(typeof passed).toBe("string");
      expect(rec().requested_model).toBe(passed as string);
      expect(rec().requested_model).not.toBe("opus");

      delete process.env["LOKI_MAX_TIER"];
      delete process.env["LOKI_CLAUDE_MODEL_PLANNING"];
      process.env["LOKI_E10_MODEL_DEFAULT"] = "1";
      stubQuery(msgs);
      await sdkQueryProvider().invoke(call({ tier: "development" }));
      expect(lastQueryArgs?.options?.["model"]).toBeUndefined();
      expect(rec().requested_model).toBe(PROVIDER_DEFAULT_MODEL);
      expect(rec().model_downgraded).toBeNull();
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  });

  it("requested_model follows the router-rewritten model, not the haiku pin (P12-23b)", async () => {
    const keys = ["LOKI_MAX_TIER", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT", "LOKI_E10_MODEL_DEFAULT", "LOKI_ITERATION", "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_TIER_ROUTING"];
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) { prev[k] = process.env[k]; delete process.env[k]; }
    process.env["LOKI_ITERATION"] = "8";
    process.env["LOKI_ROUTER"] = "1";
    process.env["LOKI_ROUTER_ADVISOR"] = "off"; // advisor unavailable: router turns a haiku executor into sonnet
    process.env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = "haiku";
    try {
      stubQuery([
        { type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "s" },
        { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, usage: {}, session_id: "s" },
      ]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call({ tier: "development" }));
      const passed = lastQueryArgs?.options?.["model"];
      expect(passed).toBe("sonnet");
      const r = JSON.parse(readFileSync(join(scratch, ".loki", "metrics", "result-cost-8.json"), "utf8"));
      expect(r.requested_model).toBe(passed as string);
      expect(r.requested_model).not.toBe("haiku");
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  });

  it("is_error result -> exit 1", async () => {
    stubQuery([
      { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0.01, usage: {} },
    ]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    const r = await sdkQueryProvider().invoke(call());
    expect(r.exitCode).toBe(1);
  });

  it("no result message (aborted/crashed stream) -> fail-closed exit 1", async () => {
    stubQuery([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    const r = await sdkQueryProvider().invoke(call());
    expect(r.exitCode).toBe(1);
    // captured text still written (load-bearing for scanners)
    expect(readFileSync(r.capturedOutputPath, "utf8")).toContain("partial");
  });

  it("a thrown query() is fail-closed: exit 1 + captured file exists", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => {
        throw new Error("sdk exploded");
      },
    }));
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    const r = await sdkQueryProvider().invoke(call());
    expect(r.exitCode).toBe(1);
    expect(existsSync(r.capturedOutputPath)).toBe(true);
    expect(readFileSync(r.capturedOutputPath, "utf8")).toContain("sdk-loop error");
  });

  it("P12-26c: LOKI_PERMISSION_POLICY=compiled reaches query() permissionMode (no bypass)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sdkq-perm-"));
    const keys = ["LOKI_PERMISSION_POLICY", "LOKI_DATA_DIR", "LOKI_MANAGED_SETTINGS"] as const;
    const prev = keys.map((k) => process.env[k]);
    process.env["LOKI_PERMISSION_POLICY"] = "compiled";
    process.env["LOKI_DATA_DIR"] = dataDir;
    process.env["LOKI_MANAGED_SETTINGS"] = join(dataDir, "missing-managed.json");
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write; // silence the no-policy warning
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const opts = lastQueryArgs?.options ?? {};
      expect(opts["permissionMode"]).toBe("acceptEdits");
      expect(opts["allowDangerouslySkipPermissions"]).toBeUndefined();
    } finally {
      process.stderr.write = realWrite;
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("P12-27: set OTEL_* vars are in options.env; unset ones are not invented", async () => {
    const keys = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME"];
    const prev = keys.map((k) => process.env[k]);
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://c:4318";
    delete process.env["OTEL_SERVICE_NAME"];
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const env = lastQueryArgs?.options?.["env"] as Record<string, string>;
      expect(env["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("http://c:4318");
      expect("OTEL_SERVICE_NAME" in env).toBe(false);
    } finally {
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });

  it("passes options.env spreading process.env (PATH survives -- the env-replace trap)", async () => {
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    const env = lastQueryArgs?.options?.["env"] as Record<string, string> | undefined;
    expect(env).toBeTruthy();
    expect(env!["PATH"]).toBe(process.env["PATH"]); // not stripped
  });

  // MW-1: CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS (Claude Code 2.1.288 / SDK 0.3.288) must reach the session env.
  it("CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS passes through to query() env when set, absent when unset", async () => {
    const key = "CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS";
    const prev = process.env[key];
    try {
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      process.env[key] = "1";
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      await sdkQueryProvider().invoke(call());
      const setEnv = lastQueryArgs?.options?.["env"] as Record<string, string>;
      expect(setEnv[key]).toBe("1");

      delete process.env[key];
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      await sdkQueryProvider().invoke(call());
      const unsetEnv = lastQueryArgs?.options?.["env"] as Record<string, string>;
      expect(key in unsetEnv).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  // E-65: what actually reaches query() for an engine10 session, not just what buildSdkLoopOptions returns.
  it("engine10 session: query() gets the 6 engine tools, the stable preset, and no LOKI_E10_* in the session env", async () => {
    const prev = { stage: process.env["LOKI_E10_STAGE"], brief: process.env["LOKI_E10_BRIEF"] };
    process.env["LOKI_E10_STAGE"] = "implement";
    process.env["LOKI_E10_BRIEF"] = "brief";
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const opts = lastQueryArgs?.options ?? {};
      expect(opts["tools"]).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]);
      expect(opts["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true });
      expect(opts["settingSources"]).toEqual(["project"]);
      expect(opts["mcpServers"]).toBeUndefined();
      const env = opts["env"] as Record<string, string>;
      expect(Object.keys(env).filter((k) => k.startsWith("LOKI_E10_"))).toEqual([]);
      expect(env["PATH"]).toBe(process.env["PATH"]);
    } finally {
      for (const [k, v] of [["LOKI_E10_STAGE", prev.stage], ["LOKI_E10_BRIEF", prev.brief]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  // In-session fix rounds: the Stop hook is installed only when the engine10 child env carries a valid spec, with a timeout past its budget.
  it("engine10 session: query() gets a Stop hook with a bounded timeout when LOKI_E10_STOP_CHECKS is set, none when unset", async () => {
    const keys = ["LOKI_E10_STAGE", "LOKI_E10_BRIEF", "LOKI_E10_STOP_CHECKS"] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env["LOKI_E10_STAGE"] = "implement"; process.env["LOKI_E10_BRIEF"] = "brief";
    try {
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      delete process.env["LOKI_E10_STOP_CHECKS"];
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      await sdkQueryProvider().invoke(call());
      expect((lastQueryArgs?.options?.["hooks"] as Record<string, unknown> | undefined)?.["Stop"]).toBeUndefined();
      process.env["LOKI_E10_STOP_CHECKS"] = JSON.stringify({ checks: [{ cwd: "/", cmd: "sh", args: ["-c", "exit 0"] }], rounds: 2, budgetS: 60, repoDir: "/", baseSha: "HEAD" });
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      await sdkQueryProvider().invoke(call());
      const stop = (lastQueryArgs?.options?.["hooks"] as { Stop?: { timeout?: number; hooks: unknown[] }[] } | undefined)?.Stop;
      expect(stop?.length).toBe(1);
      expect(stop![0]!.timeout).toBeGreaterThan(60);
      expect(typeof stop![0]!.hooks[0]).toBe("function");
      const env = lastQueryArgs?.options?.["env"] as Record<string, string>;
      expect("LOKI_E10_STOP_CHECKS" in env).toBe(false);
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  });

  // S41-09: LOKI_E10_PREFIX=lean, default off (D41 item 2, D42 item 1).
  it("engine10 session, LOKI_E10_PREFIX=lean: query() gets a fixed-string systemPrompt", async () => {
    const prev = { stage: process.env["LOKI_E10_STAGE"], prefix: process.env["LOKI_E10_PREFIX"] };
    process.env["LOKI_E10_STAGE"] = "implement";
    process.env["LOKI_E10_PREFIX"] = "lean";
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      const { LEAN_PREFIX } = await import("../../src/features/lean_prefix.ts");
      await sdkQueryProvider().invoke(call());
      const opts = lastQueryArgs?.options ?? {};
      expect(typeof opts["systemPrompt"]).toBe("string");
      expect(opts["systemPrompt"]).toBe(LEAN_PREFIX);
      // the flag never touches the tool list (card: "The tool list is unchanged").
      expect(opts["tools"]).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]);
    } finally {
      for (const [k, v] of [["LOKI_E10_STAGE", prev.stage], ["LOKI_E10_PREFIX", prev.prefix]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("engine10 session, LOKI_E10_PREFIX unset (default off): query() keeps the stable preset (CP-01 default)", async () => {
    const prev = { stage: process.env["LOKI_E10_STAGE"], prefix: process.env["LOKI_E10_PREFIX"] };
    process.env["LOKI_E10_STAGE"] = "implement";
    delete process.env["LOKI_E10_PREFIX"];
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const opts = lastQueryArgs?.options ?? {};
      expect(opts["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true });
    } finally {
      for (const [k, v] of [["LOKI_E10_STAGE", prev.stage], ["LOKI_E10_PREFIX", prev.prefix]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("legacy loop: query() keeps the full tool set and the autonomy append", async () => {
    const prev = process.env["LOKI_E10_STAGE"];
    delete process.env["LOKI_E10_STAGE"];
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const opts = lastQueryArgs?.options ?? {};
      expect(opts["tools"]).toBeUndefined();
      expect((opts["systemPrompt"] as { append?: string }).append).toContain("[LOKI-AUTONOMY-AGENT]");
      expect(opts["settingSources"]).toEqual(["user", "project", "local"]);
    } finally {
      if (prev !== undefined) process.env["LOKI_E10_STAGE"] = prev;
    }
  });

  it("sets the fully-autonomous permission options (bypass + companion flag)", async () => {
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    const prevPolicy = process.env["LOKI_PERMISSION_POLICY"];
    process.env["LOKI_PERMISSION_POLICY"] = "legacy"; // C-C2: bypass is the legacy escape hatch
    try {
      await sdkQueryProvider().invoke(call());
    } finally {
      if (prevPolicy === undefined) delete process.env["LOKI_PERMISSION_POLICY"];
      else process.env["LOKI_PERMISSION_POLICY"] = prevPolicy;
    }
    const opts = lastQueryArgs?.options ?? {};
    expect(opts["permissionMode"]).toBe("bypassPermissions");
    expect(opts["allowDangerouslySkipPermissions"]).toBe(true);
    expect(opts["includeHookEvents"]).toBe(true);
  });

  it("hosted SDK loop denies Docker through the trusted Bash hook", async () => {
    process.env["LOKI_HOST_GUARD"] = "1";
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    const hooks = lastQueryArgs?.options?.["hooks"] as {
      PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
    };
    const callback = hooks.PreToolUse[0]?.hooks[0];
    expect(callback).toBeTruthy();
    const verdict = await callback!({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "docker stop autonomi-postgres-1" },
      cwd: scratch,
      session_id: "test-session",
      transcript_path: join(scratch, "transcript.jsonl"),
      tool_use_id: "test-tool",
    }) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(verdict.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  // S41-11: LOKI_E10_TRIM=1, default off (D41 item 2, D42).
  it("LOKI_E10_TRIM unset (default off), no host guard: options carry no hooks key at all, byte-identical to main", async () => {
    const prev = process.env["LOKI_E10_TRIM"];
    delete process.env["LOKI_E10_TRIM"];
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const opts = lastQueryArgs?.options ?? {};
      expect("hooks" in opts).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["LOKI_E10_TRIM"];
      else process.env["LOKI_E10_TRIM"] = prev;
    }
  });

  it("LOKI_E10_TRIM=1: query() gets a PostToolUse hook that trims an oversized Bash result", async () => {
    const prev = process.env["LOKI_E10_TRIM"];
    process.env["LOKI_E10_TRIM"] = "1";
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const hooks = lastQueryArgs?.options?.["hooks"] as {
        PostToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
      };
      const callback = hooks.PostToolUse[0]?.hooks[0];
      expect(callback).toBeTruthy();
      const bigStdout = Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n");
      const verdict = (await callback!({
        tool_name: "Bash",
        tool_response: { stdout: bigStdout, stderr: "", interrupted: false },
      })) as { hookSpecificOutput?: { updatedToolOutput?: { stdout?: string } } };
      const trimmedStdout = verdict.hookSpecificOutput?.updatedToolOutput?.stdout ?? "";
      expect(trimmedStdout).toContain("[loki trimmed 90 lines]");
    } finally {
      if (prev === undefined) delete process.env["LOKI_E10_TRIM"];
      else process.env["LOKI_E10_TRIM"] = prev;
    }
  });

  it("LOKI_E10_TRIM=1 together with the host guard: PreToolUse and PostToolUse both wire, neither drops the other", async () => {
    const prevTrim = process.env["LOKI_E10_TRIM"];
    process.env["LOKI_E10_TRIM"] = "1";
    process.env["LOKI_HOST_GUARD"] = "1";
    try {
      stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
      const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
      await sdkQueryProvider().invoke(call());
      const hooks = lastQueryArgs?.options?.["hooks"] as Record<string, unknown[]>;
      expect(hooks["PreToolUse"]?.length).toBeGreaterThan(0);
      expect(hooks["PostToolUse"]?.length).toBeGreaterThan(0);
    } finally {
      if (prevTrim === undefined) delete process.env["LOKI_E10_TRIM"];
      else process.env["LOKI_E10_TRIM"] = prevTrim;
    }
  });

  it("mainLoop:false delegates to the CLI path (query is NOT called)", async () => {
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    // A non-mainLoop call must delegate to claudeProvider (which spawns the CLI).
    // We only assert query() was NOT invoked (lastQueryArgs stays undefined); the
    // CLI spawn itself may fail in the sandbox, which is fine -- we catch it.
    try {
      await sdkQueryProvider().invoke(call({ mainLoop: false }));
    } catch {
      // CLI path may throw if claude is absent -- irrelevant to this assertion
    }
    expect(lastQueryArgs).toBeUndefined(); // query() never reached
  });
});

describe("resolveProvider LOKI_SDK_LOOP gate", () => {
  const prev = process.env["LOKI_SDK_LOOP"];
  afterEach(() => {
    if (prev === undefined) delete process.env["LOKI_SDK_LOOP"];
    else process.env["LOKI_SDK_LOOP"] = prev;
  });

  // Positive behavioral proof (not a tautology, council CONCERN): stub query()
  // and invoke the RESOLVED provider on a mainLoop call. If the gate returned the
  // SDK provider, query() runs; if it returned claudeProvider (the bash path),
  // query() is NEVER touched. We assert which one fired via lastQueryArgs.
  it("default-off: resolveProvider('claude') does NOT run query() (bash path)", async () => {
    delete process.env["LOKI_SDK_LOOP"];
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    // LOKI_CLAUDE_CLI=true (beforeEach) makes the bash claudeProvider return
    // instantly. The SDK path would NOT consult it, so if query() ran,
    // lastQueryArgs would be set. Asserting it is undefined proves the gate
    // returned the bash path, not the SDK provider (positive, non-tautological).
    const { resolveProvider } = await import("../../src/runner/providers.ts");
    const p = await resolveProvider("claude");
    await p.invoke(call()); // mainLoop:true
    expect(lastQueryArgs).toBeUndefined(); // query() never reached -> NOT the SDK path
  });

  it("LOKI_SDK_LOOP=1: resolveProvider('claude') DOES run query() (SDK path)", async () => {
    process.env["LOKI_SDK_LOOP"] = "1";
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { resolveProvider } = await import("../../src/runner/providers.ts");
    const p = await resolveProvider("claude");
    await p.invoke(call()); // mainLoop:true
    expect(lastQueryArgs).toBeTruthy(); // query() WAS reached -> the SDK path
  });
});
