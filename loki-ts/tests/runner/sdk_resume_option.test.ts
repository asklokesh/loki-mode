// MW-2: sdkQueryProvider passes `resume` only when engine10 sets LOKI_E10_RESUME_SESSION, and records the session id it saw.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInvocation } from "../../src/runner/types.ts";

let scratch: string;
let seen: { prompt: string; options: Record<string, unknown> } | undefined;
const KEYS = ["LOKI_E10_RESUME_SESSION", "LOKI_E10_STAGE", "LOKI_ITERATION", "LOKI_HOST_GUARD"];
let backup: Record<string, string | undefined>;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-sdkresume-"));
  backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  seen = undefined;
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (args: { prompt: string; options: Record<string, unknown> }) => {
      seen = args;
      return (async function* () { yield { type: "result", is_error: false, total_cost_usd: 0.01, usage: {}, session_id: "sess-new" }; })();
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
