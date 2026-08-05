// v8 Phase 4 Story 4: hermetic test for sdkQueryProvider (NO API call). The
// Agent SDK's query() is stubbed via mock.module to yield a canned SDKMessage
// stream; we assert the provider satisfies the ProviderInvoker contract, writes
// the captured text to iterationOutputPath, derives the exit code fail-closed,
// spreads process.env, and delegates non-mainLoop calls to the CLI path.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("passes options.env spreading process.env (PATH survives -- the env-replace trap)", async () => {
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
    const env = lastQueryArgs?.options?.["env"] as Record<string, string> | undefined;
    expect(env).toBeTruthy();
    expect(env!["PATH"]).toBe(process.env["PATH"]); // not stripped
  });

  it("sets the fully-autonomous permission options (bypass + companion flag)", async () => {
    stubQuery([{ type: "result", is_error: false, total_cost_usd: 0.01, usage: {} }]);
    const { sdkQueryProvider } = await import("../../src/runner/providers.ts");
    await sdkQueryProvider().invoke(call());
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
