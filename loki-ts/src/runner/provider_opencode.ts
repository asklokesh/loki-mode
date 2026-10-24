// opencode provider for the Bun runner and engine10 (mirrors providers/opencode.sh).
//   opencode run --auto [-m provider/model] [LOKI_OPENCODE_FLAGS...] <prompt>
// Verified flags (opencode 1.18.9): `run` takes the prompt positionally,
// --auto auto-approves permissions, -m takes "provider/model". Claude stays the
// default provider; this is an additive route. Cost is not measured and kill
// blocking is not enforced (the engine10 seal records both as NOT PROVEN).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { run as shellRun } from "../util/shell.ts";
import { effortArgv } from "../providers/model_routes.ts";
import { PROVIDER_COMMIT_HYGIENE } from "./providers.ts";
import type { ProviderInvocation, ProviderInvoker, ProviderResult } from "./types.ts";

export const OPENCODE_CAPABILITIES = {
  subagents: false,
  parallel: false,
  taskTool: false,
  mcp: true,
  maxParallel: 1,
  degraded: false,
  costMeasured: false,
  killBlockingEnforced: false,
} as const;

/** Pure argv builder so the invocation shape is unit-testable without spawning. */
export function buildOpencodeArgv(prompt: string, env: Record<string, string | undefined> = process.env): string[] {
  const cliOverride = env["LOKI_OPENCODE_CLI"];
  const cli = cliOverride && cliOverride.length > 0 ? cliOverride : "opencode";
  const argv: string[] = [cli, "run", "--auto"];
  // Provider-scoped model only: opencode ids are "provider/model"; the global tier vars carry Claude aliases.
  const model = (env["LOKI_OPENCODE_MODEL"] ?? "").trim();
  if (model.length > 0) argv.push("-m", model);
  argv.push(...effortArgv("opencode", model, "development", env)); // LOKI_EFFORT -> --variant (catalog-clamped)
  for (const tok of (env["LOKI_OPENCODE_FLAGS"] ?? "").split(/\s+/)) if (tok.length > 0) argv.push(tok);
  argv.push(`${PROVIDER_COMMIT_HYGIENE}\n\n${prompt}`);
  return argv;
}

export function opencodeProvider(): ProviderInvoker {
  return {
    async invoke(call: ProviderInvocation): Promise<ProviderResult> {
      const r = await shellRun(buildOpencodeArgv(call.prompt), { cwd: call.cwd });
      mkdirSync(dirname(call.iterationOutputPath), { recursive: true });
      await Bun.write(call.iterationOutputPath, r.stderr.length > 0 ? `${r.stderr}\n${r.stdout}` : r.stdout);
      return { exitCode: r.exitCode, capturedOutputPath: call.iterationOutputPath };
    },
  };
}
