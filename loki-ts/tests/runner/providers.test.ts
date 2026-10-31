// Tests for src/runner/providers.ts.
// Source-of-truth: providers/loader.sh, providers/claude.sh.
//
// Hermetic strategy for the Claude path: write a tiny shell stub that mimics
// the `claude` CLI (echoes its args, optionally exits non-zero), then point
// LOKI_CLAUDE_CLI at that stub for the duration of the test. We never spawn
// the real Claude binary.

// Read independently from the JSON so these assertions do not depend on resolveClaudeModel itself.
const CATALOG_OPUS: string = JSON.parse(_rf(_join(import.meta.dir, "../../../providers/model_catalog.json"), "utf8")).providers.claude.cli_aliases.opus;
import { describe, expect, it, beforeEach, afterEach, afterAll, test } from "bun:test";
import { resolveProvider, claudeProvider, codexProvider, clineProvider, aiderProvider, PROVIDER_COMMIT_HYGIENE, buildSdkLoopOptions, providerCallTimeoutMs, mergeDisallowedTools, engine10CacheTtlEnv, SDK_BUNDLED_CLAUDE_CODE, truthy, textOnlyArgv } from "../../src/runner/providers.ts";
import type { ProviderInvocation } from "../../src/runner/types.ts";
import { readFileSync as _rf, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join as _join, join } from "node:path";
import { _resetClaudeHelpCacheForTest, effortForTier, buildAutoFlags } from "../../src/providers/claude_flags.ts";
import { effortArgv, recordEffort } from "../../src/providers/model_routes.ts";
import { buildOpencodeArgv } from "../../src/runner/provider_opencode.ts";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let tmp: string;
let stubPath: string;
let outputPath: string;

// Build a fake CLI in tmp that records its argv to a sidecar file and exits
// with the requested code. Returns the absolute path to drop into
// LOKI_CLAUDE_CLI. The argv-record is what each test asserts on.
function writeStub(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
} = {}): string {
  const exitCode = opts.exitCode ?? 0;
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  const argvLog = join(tmp, "argv.log");
  // Posix sh stub. `printf %s\n "$@"` puts each argv on its own line.
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${argvLog}'`,
    stdout ? `printf '%s' '${stdout.replace(/'/g, "'\\''")}'` : "",
    stderr ? `printf '%s' '${stderr.replace(/'/g, "'\\''")}' 1>&2` : "",
    `exit ${exitCode}`,
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
  return argvLog;
}

function readArgv(argvLog: string): string[] {
  return readFileSync(argvLog, "utf8").split("\n").filter((l) => l.length > 0);
}

function makeCall(overrides: Partial<ProviderInvocation> = {}): ProviderInvocation {
  return {
    provider: "claude",
    prompt: "hello world",
    tier: "development",
    cwd: tmp,
    iterationOutputPath: outputPath,
    ...overrides,
  };
}

// Env that changes which model a claude call dispatches.
const MODEL_ENV_KEYS = [
  "LOKI_ALLOW_HAIKU", "LOKI_MAX_TIER", "LOKI_HOST_GUARD", "LOKI_SESSION_MODEL",
  "LOKI_LEGACY_TIER_SWITCHING", "LOKI_TIER_ROUTING", "LOKI_COMPLEXITY",
  "LOKI_CLAUDE_MODEL_PLANNING", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_CLAUDE_MODEL_FAST",
  "LOKI_MODEL_PLANNING", "LOKI_MODEL_DEVELOPMENT", "LOKI_MODEL_FAST",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-providers-test-"));
  stubPath = join(tmp, "claude-stub");
  outputPath = join(tmp, "iter", "captured.log");
  process.env["LOKI_CLAUDE_CLI"] = stubPath;
  // Wipe tier/maxTier env so tests start from a clean slate.
  for (const k of MODEL_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  delete process.env["LOKI_CLAUDE_CLI"];
  for (const k of MODEL_ENV_KEYS) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveProvider dispatch", () => {
  it("returns an invoker with .invoke for claude", async () => {
    const p = await resolveProvider("claude");
    expect(typeof p.invoke).toBe("function");
  });

  it("returns invokers for all four names (stubs included)", async () => {
    for (const name of ["claude", "codex", "cline", "aider"] as const) {
      const p = await resolveProvider(name);
      expect(typeof p.invoke).toBe("function");
    }
  });

  it("rejects unknown provider names", async () => {
    // Bypass the type-checker on purpose -- the call site might receive a
    // user-provided string, which is exactly the case loader.sh:29 guards.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveProvider("not-a-provider" as any),
    ).rejects.toThrow(/unknown provider/);
  });

  it("hosted mode rejects a provider without an enforceable hook", async () => {
    process.env["LOKI_HOST_GUARD"] = "1";
    try {
      await expect(resolveProvider("codex")).rejects.toThrow(/no enforced PreToolUse hook/);
    } finally {
      delete process.env["LOKI_HOST_GUARD"];
    }
  });
});

// codex was stubbed through v7.4.5; v7.4.6 ports codex.sh:113-189 in full.
// Real tests live in `codexProvider invocation` below.

describe("codexProvider invocation", () => {
  let codexStubPath: string;
  let codexArgvLog: string;
  let codexEnvLog: string;

  function writeCodexStub(opts: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  } = {}): void {
    const exitCode = opts.exitCode ?? 0;
    const stdout = opts.stdout ?? "";
    const stderr = opts.stderr ?? "";
    codexArgvLog = join(tmp, "codex-argv.log");
    codexEnvLog = join(tmp, "codex-env.log");
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${codexArgvLog}'`,
      // Capture both env vars so tests can assert presence + value.
      `printf 'LOKI_CODEX_REASONING_EFFORT=%s\\nCODEX_MODEL_REASONING_EFFORT=%s\\n' "\${LOKI_CODEX_REASONING_EFFORT}" "\${CODEX_MODEL_REASONING_EFFORT}" > '${codexEnvLog}'`,
      stdout ? `printf '%s' '${stdout.replace(/'/g, "'\\''")}'` : "",
      stderr ? `printf '%s' '${stderr.replace(/'/g, "'\\''")}' 1>&2` : "",
      `exit ${exitCode}`,
    ].filter(Boolean).join("\n");
    writeFileSync(codexStubPath, script);
    chmodSync(codexStubPath, 0o755);
  }

  function readCodexEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(codexEnvLog, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  beforeEach(() => {
    codexStubPath = join(tmp, "codex-stub");
    process.env["LOKI_CODEX_CLI"] = codexStubPath;
  });

  afterEach(() => {
    delete process.env["LOKI_CODEX_CLI"];
  });

  it("argv shape: [exec, --sandbox, workspace-write, --skip-git-repo-check, <prompt>] (providers.ts:400-405)", async () => {
    writeCodexStub({ stdout: "ok" });
    const p = codexProvider();
    const r = await p.invoke(makeCall({ provider: "codex", prompt: "build x" }));
    expect(r.exitCode).toBe(0);
    const argv = readFileSync(codexArgvLog, "utf8").split("\n").filter(Boolean);
    // codex 0.132.0: switched argv shape from the deprecated --full-auto preset
    // (and the v7.4.18 --ask-for-approval never / --sandbox danger-full-access
    // expansion) to the documented --sandbox workspace-write replacement. exec
    // is non-interactive (approval "never") so no --ask-for-approval is emitted.
    // Stub records positional args only ("$@" excludes argv[0] cli path).
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("--sandbox");
    expect(argv[2]).toBe("workspace-write");
    expect(argv[3]).toBe("--skip-git-repo-check");
    // The deprecated flags must no longer appear.
    expect(argv).not.toContain("--full-auto");
    expect(argv).not.toContain("--ask-for-approval");
    expect(argv).not.toContain("danger-full-access");
    // --output-last-message <path> is on by default and precedes the prompt;
    // the prompt is the last positional.
    expect(argv).toContain("--output-last-message");
    expect(argv[argv.length - 1]).toBe("build x");
  });

  it("LOKI_CODEX_OUTPUT_LAST=false disables --output-last-message (v7.4.18)", async () => {
    process.env["LOKI_CODEX_OUTPUT_LAST"] = "false";
    writeCodexStub({ stdout: "ok" });
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", prompt: "no-last" }));
    delete process.env["LOKI_CODEX_OUTPUT_LAST"];
    const argv = readFileSync(codexArgvLog, "utf8").split("\n").filter(Boolean);
    expect(argv).not.toContain("--output-last-message");
  });

  it("LOKI_CODEX_WEB_SEARCH=true appends --search (v7.4.18)", async () => {
    process.env["LOKI_CODEX_WEB_SEARCH"] = "true";
    writeCodexStub({ stdout: "ok" });
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", prompt: "with web" }));
    delete process.env["LOKI_CODEX_WEB_SEARCH"];
    const argv = readFileSync(codexArgvLog, "utf8").split("\n").filter(Boolean);
    expect(argv).toContain("--search");
  });

  it("tier=planning maps to effort=xhigh (codex.sh:128)", async () => {
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("xhigh");
    expect(readCodexEnv()["CODEX_MODEL_REASONING_EFFORT"]).toBe("xhigh");
  });

  it("tier=development maps to effort=high (codex.sh:129)", async () => {
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "development" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("high");
  });

  it("tier=fast maps to effort=low (codex.sh:130)", async () => {
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "fast" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("low");
  });

  it("LOKI_MAX_TIER=low caps planning(xhigh) -> low (codex.sh:165)", async () => {
    process.env["LOKI_MAX_TIER"] = "low";
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("low");
  });

  it("LOKI_MAX_TIER=high caps planning(xhigh) -> high but leaves high alone (codex.sh:166-168)", async () => {
    process.env["LOKI_MAX_TIER"] = "high";
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("high");
  });

  it("LOKI_MAX_TIER=opus does not cap (codex.sh:169)", async () => {
    process.env["LOKI_MAX_TIER"] = "opus";
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("xhigh");
  });

  // Parity fix (cross-file): codex.sh:163 and applyCodexMaxTier now normalize
  // LOKI_MAX_TIER with trim + lowercase BEFORE the case/switch, mirroring
  // claude.sh:356 (loki_apply_max_tier_clamp) and applyMaxTierCeiling:158. A
  // user-typed cap like "Haiku" or " haiku " (settings.json maxTier exports
  // verbatim) previously fell through to the default arm on BOTH codex routes,
  // silently bypassing the cost ceiling for codex while claude honored it. These
  // assert both routes now cap identically for mixed-case and whitespace input.
  it("LOKI_MAX_TIER='Haiku' (mixed case) caps planning(xhigh) -> low (parity with claude)", async () => {
    process.env["LOKI_MAX_TIER"] = "Haiku";
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    // planning -> xhigh; normalized "haiku" -> cap everything to low.
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("low");
  });

  it("LOKI_MAX_TIER=' haiku ' (whitespace) caps planning(xhigh) -> low (parity with claude)", async () => {
    process.env["LOKI_MAX_TIER"] = " haiku ";
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("low");
  });

  it("LOKI_MAX_TIER='Sonnet' (mixed case) caps planning(xhigh) -> high (parity with claude)", async () => {
    process.env["LOKI_MAX_TIER"] = "Sonnet";
    writeCodexStub();
    const p = codexProvider();
    await p.invoke(makeCall({ provider: "codex", tier: "planning" }));
    expect(readCodexEnv()["LOKI_CODEX_REASONING_EFFORT"]).toBe("high");
  });

  it("propagates non-zero exit code", async () => {
    writeCodexStub({ exitCode: 9, stderr: "boom" });
    const p = codexProvider();
    const r = await p.invoke(makeCall({ provider: "codex" }));
    expect(r.exitCode).toBe(9);
  });

  it("writes captured output (stdout + stderr) to iterationOutputPath", async () => {
    writeCodexStub({ stdout: "codex-stdout", stderr: "codex-warn" });
    const p = codexProvider();
    const r = await p.invoke(makeCall({ provider: "codex" }));
    expect(r.capturedOutputPath).toBe(outputPath);
    const captured = readFileSync(outputPath, "utf8");
    expect(captured).toContain("codex-stdout");
    expect(captured).toContain("codex-warn");
  });
});

describe("claudeProvider invocation", () => {
  it("textOnly adds the no-tools flag and the write denylist; a normal call does not", async () => {
    const argvLog = writeStub({ stdout: "ok" });
    await claudeProvider().invoke(makeCall({ textOnly: true }));
    const on = readArgv(argvLog);
    expect(on).toContain("--tools=");
    expect(on).toContain("--disallowedTools");
    expect(on.join(" ")).toContain("Bash");
    await claudeProvider().invoke(makeCall());
    expect(readArgv(argvLog)).not.toContain("--tools=");
  });

  it("textOnlyArgv drops --tools= for a CLI that does not advertise it, so the label reads cwd-only", () => {
    _resetClaudeHelpCacheForTest("  --model <model>  select model");
    try {
      expect(textOnlyArgv()).not.toContain("--tools=");
    } finally {
      _resetClaudeHelpCacheForTest(null);
    }
    _resetClaudeHelpCacheForTest("  --tools <tools...>  built-in tools");
    try {
      expect(textOnlyArgv()).toContain("--tools=");
    } finally {
      _resetClaudeHelpCacheForTest(null);
    }
  });

  it("passes --dangerously-skip-permissions (legacy), --model, and -p", async () => {
    const argvLog = writeStub({ stdout: "ok" });
    const p = claudeProvider();
    process.env["LOKI_PERMISSION_POLICY"] = "legacy"; // C-C2: compiled is the default
    let r;
    try {
      r = await p.invoke(makeCall({ tier: "development", prompt: "build x" }));
    } finally {
      delete process.env["LOKI_PERMISSION_POLICY"];
    }
    expect(r.exitCode).toBe(0);
    const argv = readArgv(argvLog);
    // v7.104.0: default (no LOKI_ALLOW_HAIKU) development tier maps to sonnet
    // (Sonnet 5 is the default execution model; was opus).
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--model");
    expect(argv).toContain("sonnet");
    expect(argv).toContain("-p");
    expect(argv).toContain("build x");
  });

  it("hosted CLI loop injects the trusted Bash hook settings", async () => {
    _resetClaudeHelpCacheForTest("  --settings <file-or-json>  load settings");
    process.env["LOKI_HOST_GUARD"] = "1";
    try {
      const argvLog = writeStub({ stdout: "ok" });
      const r = await claudeProvider().invoke(makeCall({ mainLoop: true }));
      expect(r.exitCode).toBe(0);
      const argv = readArgv(argvLog);
      const settingsIndex = argv.indexOf("--settings");
      expect(settingsIndex).toBeGreaterThanOrEqual(0);
      const settings = JSON.parse(argv[settingsIndex + 1] ?? "{}") as {
        hooks?: { PreToolUse?: Array<{ matcher?: string }> };
      };
      expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    } finally {
      _resetClaudeHelpCacheForTest(null);
      delete process.env["LOKI_HOST_GUARD"];
    }
  });

  it("hosted CLI loop fails closed when --settings is unavailable", async () => {
    _resetClaudeHelpCacheForTest("  --model <model>  select model");
    process.env["LOKI_HOST_GUARD"] = "1";
    try {
      writeStub({ stdout: "should not run" });
      const r = await claudeProvider().invoke(makeCall({ mainLoop: true }));
      expect(r.exitCode).toBe(1);
      expect(readFileSync(r.capturedOutputPath, "utf8")).toContain("requires Claude CLI --settings support");
    } finally {
      _resetClaudeHelpCacheForTest(null);
      delete process.env["LOKI_HOST_GUARD"];
    }
  });

  it("propagates exit code", async () => {
    writeStub({ exitCode: 7, stderr: "boom" });
    const p = claudeProvider();
    const r = await p.invoke(makeCall());
    expect(r.exitCode).toBe(7);
  });

  it("writes captured output to iterationOutputPath", async () => {
    writeStub({ stdout: "hello-stdout", stderr: "warn-stderr" });
    const p = claudeProvider();
    const r = await p.invoke(makeCall());
    expect(r.capturedOutputPath).toBe(outputPath);
    const captured = readFileSync(outputPath, "utf8");
    // Both stdout and stderr should land in the captured file -- the runner
    // greps over it for completion-promise + rate-limit signals.
    expect(captured).toContain("hello-stdout");
    expect(captured).toContain("warn-stderr");
  });

  it("creates parent directories for the captured-output path", async () => {
    writeStub({ stdout: "x" });
    const deepPath = join(tmp, "a", "b", "c", "captured.log");
    const p = claudeProvider();
    const r = await p.invoke(makeCall({ iterationOutputPath: deepPath }));
    expect(r.capturedOutputPath).toBe(deepPath);
    expect(readFileSync(deepPath, "utf8")).toContain("x");
  });

  it("honors LOKI_ALLOW_HAIKU=true tier mapping (fast -> haiku)", async () => {
    process.env["LOKI_ALLOW_HAIKU"] = "true";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "fast" }));
    const argv = readArgv(argvLog);
    // claude.sh:125-130: fast -> haiku when LOKI_ALLOW_HAIKU is set.
    expect(argv).toContain("haiku");
  });

  it("applies LOKI_MAX_TIER=sonnet ceiling to planning tier", async () => {
    process.env["LOKI_MAX_TIER"] = "sonnet";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "planning" }));
    const argv = readArgv(argvLog);
    // claude.sh:176-181: planning capped to the development tier under a sonnet
    // ceiling. v7.104.0: the development default is now sonnet, so the cap
    // resolves to sonnet (was opus).
    expect(argv).toContain("sonnet");
    // Ensure we did not pass through the planning-tier sentinel.
    expect(argv).not.toContain("planning");
  });

  it("applies LOKI_MAX_TIER=sonnet ceiling to a fable tier (claude.sh:358-362)", async () => {
    // A "fable" session tier reaches applyMaxTierCeiling via the SessionTier
    // string fallback. Bash caps planning OR fable down to development under a
    // sonnet ceiling (claude.sh:358-362); the TS sonnet arm now caps both. With
    // LOKI_ALLOW_HAIKU=true the cap is OBSERVABLE in the dispatched --model:
    // claudeTierToModel("fable") collapses to opus, and the fable arm re-resolves
    // it to development == sonnet (haiku-on dev tier), so --model is sonnet not
    // opus. Without the fable arm the model would stay opus -- this asserts the
    // capped sonnet appears as the --model value.
    process.env["LOKI_MAX_TIER"] = "sonnet";
    process.env["LOKI_ALLOW_HAIKU"] = "true";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "fable" }));
    const argv = readArgv(argvLog);
    // --model immediately follows the flag; assert the dispatched model (not the
    // --fallback-model token) is the capped sonnet.
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(argv[modelIdx + 1]).toBe("sonnet");
  });

  // Phase I (v7.5.25) regression tests for ANTHROPIC_BASE_URL +
  // LOKI_MODEL_OVERRIDE alt-provider routing. Added per Opus #2 reviewer
  // CONCERN that the bash and Bun routes had bash-only test coverage; this
  // closes the parity gap by directly exercising the Bun override branch.
  it("P12-27: set OTEL_* vars reach the child env unchanged; unset ones are not invented", async () => {
    const envLog = join(tmp, "env.log");
    writeFileSync(stubPath, `#!/bin/sh\nenv > '${envLog}'\nexit 0\n`);
    chmodSync(stubPath, 0o755);
    const keys = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME", "OTEL_RESOURCE_ATTRIBUTES", "CLAUDE_CODE_ENABLE_TELEMETRY"];
    const prev = keys.map((k) => process.env[k]);
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://c:4318";
    process.env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1";
    delete process.env["OTEL_SERVICE_NAME"];
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"];
    try {
      await claudeProvider().invoke(makeCall());
      const lines = readFileSync(envLog, "utf8").split("\n");
      expect(lines).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://c:4318");
      expect(lines).toContain("CLAUDE_CODE_ENABLE_TELEMETRY=1");
      expect(lines.some((l) => l.startsWith("OTEL_SERVICE_NAME="))).toBe(false);
    } finally {
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });

  it("Phase I: LOKI_MODEL_OVERRIDE wins when ANTHROPIC_BASE_URL also set", async () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://openrouter.ai/api/v1";
    process.env["LOKI_MODEL_OVERRIDE"] = "anthropic/claude-3.5-sonnet";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "development" }));
    const argv = readArgv(argvLog);
    expect(argv).toContain("--model");
    expect(argv).toContain("anthropic/claude-3.5-sonnet");
    expect(argv).not.toContain("opus");
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["LOKI_MODEL_OVERRIDE"];
  });

  it("Phase I: LOKI_MODEL_OVERRIDE alone (no BASE_URL) is ignored", async () => {
    process.env["LOKI_MODEL_OVERRIDE"] = "anthropic/claude-3.5-sonnet";
    delete process.env["ANTHROPIC_BASE_URL"];
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "development" }));
    const argv = readArgv(argvLog);
    // v7.104.0: default Anthropic-native invocation is the tier-mapped sonnet
    // alias (development tier default is sonnet; was opus).
    expect(argv).toContain("sonnet");
    expect(argv).not.toContain("anthropic/claude-3.5-sonnet");
    delete process.env["LOKI_MODEL_OVERRIDE"];
  });

  it("Phase I: ANTHROPIC_BASE_URL alone (no OVERRIDE) keeps tier alias", async () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://openrouter.ai/api/v1";
    delete process.env["LOKI_MODEL_OVERRIDE"];
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "development" }));
    const argv = readArgv(argvLog);
    // v7.104.0: development tier default is sonnet (was opus).
    expect(argv).toContain("sonnet");
    delete process.env["ANTHROPIC_BASE_URL"];
  });

  it("Phase I: Ollama local endpoint with override routes correctly", async () => {
    process.env["ANTHROPIC_BASE_URL"] = "http://localhost:11434/v1";
    process.env["LOKI_MODEL_OVERRIDE"] = "qwen2.5-coder:32b";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "fast" }));
    const argv = readArgv(argvLog);
    expect(argv).toContain("qwen2.5-coder:32b");
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["LOKI_MODEL_OVERRIDE"];
  });

  // v7.34.0 (council R1): the session stamp must attach ONLY to the main RARV
  // loop (call.mainLoop), never to a subcall like the override-council judge,
  // mirroring the bash route confining --session-id to _loki_claude_argv.
  it("session stamp: --session-id only on mainLoop call, never a subcall", async () => {
    // Inject help text so --session-id registers as supported.
    _resetClaudeHelpCacheForTest("  --session-id <uuid>  use id");
    process.env["LOKI_SESSION_STAMP"] = "1";
    process.env["LOKI_TRUST_RUN_ID"] = "run-20260611-1-1";
    try {
      const mainLog = writeStub();
      await claudeProvider().invoke(makeCall({ mainLoop: true }));
      const mainArgv = readArgv(mainLog);
      expect(mainArgv).toContain("--session-id");

      const subLog = writeStub();
      await claudeProvider().invoke(makeCall({})); // no mainLoop -> defaults false
      const subArgv = readArgv(subLog);
      expect(subArgv).not.toContain("--session-id");
    } finally {
      delete process.env["LOKI_SESSION_STAMP"];
      delete process.env["LOKI_TRUST_RUN_ID"];
      _resetClaudeHelpCacheForTest(null);
    }
  });

  // v7.41.4 parity (BUG 1): the LOKI_MAX_TIER ceiling must normalize (trim +
  // lowercase) before the case match, mirroring loki_apply_max_tier_clamp at
  // claude.sh:352 (`tr | sed`). Pre-fix, the Bun route switched on the RAW env
  // value, so a user-typed cap like "Haiku" or " haiku " missed the "haiku" arm
  // and dispatched opus -- blowing past the ceiling the quote claimed enforced.
  it("BUG1: LOKI_MAX_TIER='Haiku' (mixed case) caps like 'haiku' (claude.sh:352)", async () => {
    process.env["LOKI_MAX_TIER"] = "Haiku";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "development" }));
    const argv = readArgv(argvLog);
    // haiku ceiling re-resolves from the fast tier; default haiku-off mapping
    // sends fast -> sonnet (claude.sh:172-175 + provider_get_tier_param).
    expect(argv).toContain("--model");
    expect(argv).toContain("sonnet");
    // Pre-fix this would have fallen through to the raw default and dispatched
    // opus -- the exact ceiling-bypass drift this fix closes.
    expect(argv).not.toContain("opus");
  });

  it("BUG1: LOKI_MAX_TIER=' haiku ' (padded) caps like 'haiku' (claude.sh:352)", async () => {
    process.env["LOKI_MAX_TIER"] = " haiku ";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "planning" }));
    const argv = readArgv(argvLog);
    expect(argv).toContain("--model");
    expect(argv).toContain("sonnet");
    expect(argv).not.toContain("opus");
  });

  // v7.41.4 parity (BUG 2): LOKI_ALLOW_HAIKU is gated on an EXACT "true" string
  // by bash (claude.sh:294, claude-flags.sh:104) and by the Bun fallbackForPrimary
  // (claude_flags.ts:101). A permissive value like "1" must NOT enable haiku.
  it("BUG2: LOKI_ALLOW_HAIKU=1 does NOT enable haiku (exact 'true' only)", async () => {
    process.env["LOKI_ALLOW_HAIKU"] = "1";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "fast" }));
    const argv = readArgv(argvLog);
    // Default haiku-off mapping: fast -> sonnet (claude.sh:135-141). Pre-fix,
    // truthy("1") flipped the allow-haiku branch and returned haiku.
    expect(argv).toContain("sonnet");
    expect(argv).not.toContain("haiku");
  });

  it("BUG2: only LOKI_ALLOW_HAIKU='true' enables haiku (fast -> haiku)", async () => {
    process.env["LOKI_ALLOW_HAIKU"] = "true";
    const argvLog = writeStub();
    const p = claudeProvider();
    await p.invoke(makeCall({ tier: "fast" }));
    const argv = readArgv(argvLog);
    expect(argv).toContain("haiku");
  });
});

// ---------------------------------------------------------------------------
// Claude model resolution: per-tier env pins and the opus session pin (moat P4).
// Before this, the Bun route ignored LOKI_CLAUDE_MODEL_* / LOKI_MODEL_* and
// dispatched sonnet for an opus-pinned session; bash honored both.
// ---------------------------------------------------------------------------

describe("claude model resolution (per-tier pins, opus session pin)", () => {
  // Dispatch one call under exactly `env` (model env reset first) and return
  // the --model value the stub CLI received.
  async function dispatched(call: Partial<ProviderInvocation>, env: Record<string, string> = {}): Promise<string> {
    for (const k of MODEL_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const argvLog = writeStub();
    await claudeProvider().invoke(makeCall(call));
    const argv = readArgv(argvLog);
    return argv[argv.indexOf("--model") + 1] ?? "NO-MODEL";
  }

  it("per-tier LOKI_CLAUDE_MODEL_* pins reach dispatch, fast pin beats the haiku gate", async () => {
    const env = { LOKI_CLAUDE_MODEL_PLANNING: "opus", LOKI_CLAUDE_MODEL_DEVELOPMENT: "claude-sonnet-5", LOKI_CLAUDE_MODEL_FAST: "haiku" };
    expect(await dispatched({ tier: "planning" }, env)).toBe("opus");
    expect(await dispatched({ tier: "development" }, env)).toBe("claude-sonnet-5");
    expect(await dispatched({ tier: "fast" }, env)).toBe("haiku");
    expect(await dispatched({ tier: "fast" })).toBe("sonnet");
  });

  it("ANTHROPIC_DEFAULT_<FAMILY>_MODEL pins the family alias a tier resolves to (#299)", async () => {
    // Pinned: the sonnet tier resolves to the pin. Unset: the plain alias.
    expect(await dispatched({ tier: "development" }, { ANTHROPIC_DEFAULT_SONNET_MODEL: "x" })).toBe("x");
    expect(await dispatched({ tier: "development" })).toBe("sonnet");
    expect(await dispatched({ tier: "planning" }, { LOKI_CLAUDE_MODEL_PLANNING: "opus", ANTHROPIC_DEFAULT_OPUS_MODEL: "o" })).toBe("o");
    expect(await dispatched({ tier: "fast" }, { LOKI_ALLOW_HAIKU: "true", ANTHROPIC_DEFAULT_HAIKU_MODEL: "h" })).toBe("h");
    // An explicit non-alias tier pin is not rewritten, and a blank pin is ignored.
    expect(await dispatched({ tier: "development" }, { LOKI_CLAUDE_MODEL_DEVELOPMENT: "claude-sonnet-5", ANTHROPIC_DEFAULT_SONNET_MODEL: "x" })).toBe("claude-sonnet-5");
    expect(await dispatched({ tier: "development" }, { ANTHROPIC_DEFAULT_SONNET_MODEL: "  " })).toBe("sonnet");
  });

  it("LOKI_CLAUDE_MODEL_<TIER> beats LOKI_MODEL_<TIER>, and an empty value counts as unset", async () => {
    expect(await dispatched({ tier: "planning" }, { LOKI_MODEL_PLANNING: "opus" })).toBe("opus");
    expect(await dispatched({ tier: "planning" }, { LOKI_MODEL_PLANNING: "opus", LOKI_CLAUDE_MODEL_PLANNING: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(await dispatched({ tier: "planning" }, { LOKI_MODEL_PLANNING: "opus", LOKI_CLAUDE_MODEL_PLANNING: "" })).toBe("opus");
    expect(await dispatched({ tier: "development" }, { LOKI_MODEL_DEVELOPMENT: "" })).toBe("sonnet");
  });

  it("matches bash resolve_model_for_tier for per-tier pins and ceilings", async () => {
    const claudeSh = join(import.meta.dir, "..", "..", "..", "providers", "claude.sh");
    const matrix: Array<Record<string, string>> = [
      {},
      { LOKI_CLAUDE_MODEL_PLANNING: "opus", LOKI_CLAUDE_MODEL_FAST: "haiku" },
      { LOKI_MODEL_DEVELOPMENT: "claude-sonnet-5", LOKI_MAX_TIER: "sonnet" },
      { LOKI_CLAUDE_MODEL_PLANNING: "opus", LOKI_MAX_TIER: "sonnet", LOKI_CLAUDE_MODEL_DEVELOPMENT: "claude-sonnet-5" },
      { LOKI_CLAUDE_MODEL_FAST: "haiku", LOKI_MAX_TIER: "haiku" },
      { LOKI_ALLOW_HAIKU: "true" },
    ];
    for (const env of matrix) {
      for (const tier of ["planning", "development", "fast"]) {
        const bun = await dispatched({ tier }, env);
        const bash = execFileSync("bash", ["-c", `. "${claudeSh}" >/dev/null 2>&1; resolve_model_for_tier "${tier}"`], {
          env: { HOME: process.env["HOME"] ?? "/tmp", PATH: process.env["PATH"] ?? "", ...env },
        }).toString().trim();
        expect(`${tier} ${JSON.stringify(env)} -> ${bun}`).toBe(`${tier} ${JSON.stringify(env)} -> ${bash}`);
      }
    }
  });

  it("an opus session pin dispatches opus on the main loop (trim + lowercase, like run.sh)", async () => {
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "opus" })).toBe("opus");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: " OPUS " })).toBe("opus");
    // Complexity routing does not touch the pin.
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "opus", LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "simple" })).toBe("opus");
  });

  it("the opus pin stays inside LOKI_MAX_TIER, clamped at the planning level", async () => {
    const pin = { LOKI_SESSION_MODEL: "opus" };
    expect(await dispatched({ tier: "planning", mainLoop: true }, { ...pin, LOKI_MAX_TIER: "sonnet" })).toBe("sonnet");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { ...pin, LOKI_MAX_TIER: "Haiku" })).toBe("sonnet");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { ...pin, LOKI_MAX_TIER: "haiku", LOKI_ALLOW_HAIKU: "true" })).toBe("haiku");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { ...pin, LOKI_MAX_TIER: "opus" })).toBe("opus");
  });

  it("explicit top and floor setups dispatch opus and haiku; default routing stays sonnet", async () => {
    const claudeSh = join(import.meta.dir, "..", "..", "..", "providers", "claude.sh");
    const bash = (tier: string, env: Record<string, string>): string =>
      execFileSync("bash", ["-c", `. "${claudeSh}" >/dev/null 2>&1; resolve_model_for_tier "${tier}"`], {
        env: { HOME: process.env["HOME"] ?? "/tmp", PATH: process.env["PATH"] ?? "", ...env },
      }).toString().trim();
    // Default routing unchanged: no session value, or sonnet/medium, stays sonnet on every tier, both routes.
    const defaultEnvs: Record<string, string>[] = [{}, { LOKI_SESSION_MODEL: "sonnet" }, { LOKI_SESSION_MODEL: "development" }];
    for (const env of defaultEnvs) {
      for (const tier of ["planning", "development", "fast"] as const) {
        expect(await dispatched({ tier, mainLoop: true }, env)).toBe("sonnet");
        expect(bash(tier, env)).toBe("sonnet");
      }
    }
    // Explicit top (high is translated to planning before dispatch) and floor.
    for (const v of ["planning", "high", " HIGH "]) {
      expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: v })).toBe("opus");
    }
    for (const v of ["fast", "small"]) {
      expect(await dispatched({ tier: "fast", mainLoop: true }, { LOKI_SESSION_MODEL: v })).toBe("haiku");
    }
    expect(bash("planning", { LOKI_SESSION_MODEL: "planning" })).toBe("opus");
    expect(bash("fast", { LOKI_SESSION_MODEL: "fast" })).toBe("haiku");
    // Explicit per-tier pin, ceiling and legacy switching still win.
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "planning", LOKI_CLAUDE_MODEL_PLANNING: "sonnet" })).toBe("sonnet");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "planning", LOKI_MAX_TIER: "sonnet" })).toBe("sonnet");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "planning", LOKI_LEGACY_TIER_SWITCHING: "true" })).toBe("sonnet");
    expect(bash("planning", { LOKI_SESSION_MODEL: "planning", LOKI_MAX_TIER: "sonnet" })).toBe("sonnet");
    expect(bash("fast", { LOKI_SESSION_MODEL: "fast", LOKI_CLAUDE_MODEL_FAST: "sonnet" })).toBe("sonnet");
  });

  it("explicit LOKI_ALLOW_HAIKU other than true blocks the haiku arm on both routes", async () => {
    const claudeSh = join(import.meta.dir, "..", "..", "..", "providers", "claude.sh");
    const bash = (tier: string, env: Record<string, string>): string =>
      execFileSync("bash", ["-c", `. "${claudeSh}" >/dev/null 2>&1; resolve_model_for_tier "${tier}"`], {
        env: { HOME: process.env["HOME"] ?? "/tmp", PATH: process.env["PATH"] ?? "", ...env },
      }).toString().trim();
    for (const allow of ["false", "0", "no", ""]) {
      for (const v of ["small", "fast"]) {
        const env = { LOKI_SESSION_MODEL: v, LOKI_ALLOW_HAIKU: allow };
        expect(await dispatched({ tier: "fast", mainLoop: true }, env)).toBe("sonnet");
        expect(bash("fast", env)).toBe("sonnet");
      }
    }
    // Unset or true still reaches haiku; opus arm is not gated by ALLOW_HAIKU.
    expect(bash("fast", { LOKI_SESSION_MODEL: "small" })).toBe("haiku");
    expect(await dispatched({ tier: "fast", mainLoop: true }, { LOKI_SESSION_MODEL: "small", LOKI_ALLOW_HAIKU: "true" })).toBe("haiku");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "high", LOKI_ALLOW_HAIKU: "false" })).toBe("opus");
    expect(bash("planning", { LOKI_SESSION_MODEL: "planning", LOKI_ALLOW_HAIKU: "false" })).toBe("opus");
  });

  it("the opus pin does not apply to subcalls, legacy tier switching, or a tier the router moved", async () => {
    const pin = { LOKI_SESSION_MODEL: "opus" };
    expect(await dispatched({ tier: "planning" }, pin)).toBe("sonnet");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { ...pin, LOKI_LEGACY_TIER_SWITCHING: "true" })).toBe("sonnet");
    expect(await dispatched({ tier: "development", mainLoop: true }, pin)).toBe("sonnet");
    expect(await dispatched({ tier: "planning", mainLoop: true }, { LOKI_SESSION_MODEL: "sonnet" })).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// Cline provider tests (cline.sh:1-139).
//
// Hermetic strategy mirrors the claude pattern: a fake `cline` script
// records its argv to a sidecar file. We assert on argv shape, on
// LOKI_CLINE_MODEL env handling, exit-code propagation, and capturedOutput
// teeing. We never spawn the real cline binary.
// ---------------------------------------------------------------------------

describe("clineProvider invocation", () => {
  let clineStubPath: string;
  let clineArgvLog: string;

  function writeClineStub(opts: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  } = {}): void {
    const exitCode = opts.exitCode ?? 0;
    const stdout = opts.stdout ?? "";
    const stderr = opts.stderr ?? "";
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${clineArgvLog}'`,
      stdout ? `printf '%s' '${stdout.replace(/'/g, "'\\''")}'` : "",
      stderr ? `printf '%s' '${stderr.replace(/'/g, "'\\''")}' 1>&2` : "",
      `exit ${exitCode}`,
    ]
      .filter(Boolean)
      .join("\n");
    writeFileSync(clineStubPath, script);
    chmodSync(clineStubPath, 0o755);
  }

  beforeEach(() => {
    clineStubPath = join(tmp, "cline-stub");
    clineArgvLog = join(tmp, "cline-argv.log");
    process.env["LOKI_CLINE_CLI"] = clineStubPath;
    delete process.env["LOKI_CLINE_MODEL"];
  });

  afterEach(() => {
    delete process.env["LOKI_CLINE_CLI"];
    delete process.env["LOKI_CLINE_MODEL"];
  });

  it("argv shape without model: -y <prompt> (cline.sh:108-115)", async () => {
    writeClineStub({ stdout: "ok" });
    const p = clineProvider();
    const r = await p.invoke(
      makeCall({ provider: "cline", prompt: "do thing" }),
    );
    expect(r.exitCode).toBe(0);
    const argv = readArgv(clineArgvLog);
    // No LOKI_CLINE_MODEL -> no -m flag, prompt is positional.
    // S-209: the newline-framed stub splits the hygiene-prefixed prompt.
    expect(argv).toEqual(["-y", PROVIDER_COMMIT_HYGIENE, "do thing"]);
    expect(argv).not.toContain("-m");
  });

  it("argv shape with LOKI_CLINE_MODEL: -y -m <model> <prompt>", async () => {
    process.env["LOKI_CLINE_MODEL"] = "anthropic/claude-opus-4-7";
    writeClineStub();
    const p = clineProvider();
    await p.invoke(makeCall({ provider: "cline", prompt: "build x" }));
    const argv = readArgv(clineArgvLog);
    // cline.sh:113-114: -m and model name appear as a separate pair before
    // the positional prompt.
    expect(argv).toEqual(["-y", "-m", "anthropic/claude-opus-4-7", PROVIDER_COMMIT_HYGIENE, "build x"]);
  });

  it("propagates non-zero exit code", async () => {
    writeClineStub({ exitCode: 5, stderr: "rate limit" });
    const p = clineProvider();
    const r = await p.invoke(makeCall({ provider: "cline" }));
    expect(r.exitCode).toBe(5);
  });

  it("writes captured output (stdout + stderr) to iterationOutputPath", async () => {
    writeClineStub({ stdout: "cline-stdout", stderr: "cline-stderr" });
    const p = clineProvider();
    const r = await p.invoke(makeCall({ provider: "cline" }));
    expect(r.capturedOutputPath).toBe(outputPath);
    const captured = readFileSync(outputPath, "utf8");
    expect(captured).toContain("cline-stdout");
    expect(captured).toContain("cline-stderr");
  });

  it("ignores tier (cline.sh:117-128: single-model gateway)", async () => {
    // Cline returns CLINE_DEFAULT_MODEL for every tier and never adds a
    // tier-specific flag. Confirm planning and fast tiers emit identical argv.
    writeClineStub();
    const p = clineProvider();
    await p.invoke(makeCall({ provider: "cline", tier: "planning" }));
    const planningArgv = readArgv(clineArgvLog);
    writeClineStub();
    await p.invoke(makeCall({ provider: "cline", tier: "fast" }));
    const fastArgv = readArgv(clineArgvLog);
    expect(planningArgv).toEqual(fastArgv);
  });
});

// ---------------------------------------------------------------------------
// Aider provider tests (aider.sh:1-145).
//
// Hermetic strategy mirrors the others: fake `aider` records its argv. We
// assert on the mandatory --no-auto-commits flag (loki owns git),
// LOKI_AIDER_MODEL/FLAGS env handling, exit-code propagation, and captured
// output.
// ---------------------------------------------------------------------------

describe("aiderProvider invocation", () => {
  let aiderStubPath: string;
  let aiderArgvLog: string;

  function writeAiderStub(opts: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  } = {}): void {
    const exitCode = opts.exitCode ?? 0;
    const stdout = opts.stdout ?? "";
    const stderr = opts.stderr ?? "";
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${aiderArgvLog}'`,
      stdout ? `printf '%s' '${stdout.replace(/'/g, "'\\''")}'` : "",
      stderr ? `printf '%s' '${stderr.replace(/'/g, "'\\''")}' 1>&2` : "",
      `exit ${exitCode}`,
    ]
      .filter(Boolean)
      .join("\n");
    writeFileSync(aiderStubPath, script);
    chmodSync(aiderStubPath, 0o755);
  }

  beforeEach(() => {
    aiderStubPath = join(tmp, "aider-stub");
    aiderArgvLog = join(tmp, "aider-argv.log");
    process.env["LOKI_AIDER_CLI"] = aiderStubPath;
    delete process.env["LOKI_AIDER_MODEL"];
    delete process.env["LOKI_AIDER_FLAGS"];
  });

  afterEach(() => {
    delete process.env["LOKI_AIDER_CLI"];
    delete process.env["LOKI_AIDER_MODEL"];
    delete process.env["LOKI_AIDER_FLAGS"];
  });

  it("argv shape with default model (aider.sh:110-121)", async () => {
    writeAiderStub({ stdout: "ok" });
    const p = aiderProvider();
    const r = await p.invoke(
      makeCall({ provider: "aider", prompt: "fix bug" }),
    );
    expect(r.exitCode).toBe(0);
    const argv = readArgv(aiderArgvLog);
    // Mandatory tokens in the precise order built by aiderProvider().
    // --no-auto-commits is non-negotiable (aider.sh:118: loki owns git).
    expect(argv).toEqual([
      "--message",
      PROVIDER_COMMIT_HYGIENE,
      "fix bug",
      "--yes-always",
      "--no-auto-commits",
      "--model",
      CATALOG_OPUS,
    ]);
  });

  it("honors LOKI_AIDER_MODEL override (aider.sh:66)", async () => {
    process.env["LOKI_AIDER_MODEL"] = "ollama_chat/llama3";
    writeAiderStub();
    const p = aiderProvider();
    await p.invoke(makeCall({ provider: "aider", prompt: "p" }));
    const argv = readArgv(aiderArgvLog);
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(argv[modelIdx + 1]).toBe("ollama_chat/llama3");
  });

  it("appends LOKI_AIDER_FLAGS as whitespace-split argv tokens (aider.sh:114,120)", async () => {
    process.env["LOKI_AIDER_FLAGS"] = "--read README.md  --map-tokens 1024";
    writeAiderStub();
    const p = aiderProvider();
    await p.invoke(makeCall({ provider: "aider", prompt: "p" }));
    const argv = readArgv(aiderArgvLog);
    // All four tokens should appear after the mandatory flags. The double
    // space between README.md and --map-tokens collapses (mirrors bash IFS
    // word-splitting) -- no empty tokens leak through.
    expect(argv).toContain("--read");
    expect(argv).toContain("README.md");
    expect(argv).toContain("--map-tokens");
    expect(argv).toContain("1024");
    expect(argv).not.toContain("");
  });

  it("propagates non-zero exit code from the aider CLI", async () => {
    writeAiderStub({ exitCode: 13, stderr: "litellm error" });
    const p = aiderProvider();
    const r = await p.invoke(makeCall({ provider: "aider" }));
    expect(r.exitCode).toBe(13);
  });

  it("writes captured output (stdout + stderr) to iterationOutputPath", async () => {
    writeAiderStub({ stdout: "aider-stdout", stderr: "aider-stderr" });
    const p = aiderProvider();
    const r = await p.invoke(makeCall({ provider: "aider" }));
    expect(r.capturedOutputPath).toBe(outputPath);
    const captured = readFileSync(outputPath, "utf8");
    expect(captured).toContain("aider-stdout");
    expect(captured).toContain("aider-stderr");
  });
});

// Gemini provider tests removed in v7.5.18 Phase A (Gemini provider removed).

describe("providers advisor", () => {
  // R1-07 (docs/v11/ROUTER-1.md 4.4, 4.5): advisorModel and autoCompactWindow wiring under LOKI_ROUTER=1.
  // In SDK 0.3.293 both are fields of `interface Settings` (sdk.d.ts), reached through Options.settings.

  const KEYS = [
    "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_E10_STAGE", "LOKI_ALLOW_HAIKU", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "LOKI_CLAUDE_CLI",
    "LOKI_SESSION_STAMP", "LOKI_DIR",
  ];
  let saved: Record<string, string | undefined>;
  let dir: string;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "loki-r1-07-"));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => ({ tier: "development", model: "haiku", cwd: dir, runDir: dir, claudeCodeVersion: "2.1.293" });

  describe("bundled version constant", () => {
    test("SDK_BUNDLED_CLAUDE_CODE equals the installed SDK's claudeCodeVersion", () => {
      const manifest = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
      const v = (JSON.parse(readFileSync(manifest, "utf8")) as { claudeCodeVersion: string }).claudeCodeVersion;
      expect(SDK_BUNDLED_CLAUDE_CODE).toBe(v);
    });
  });

  describe("buildSdkLoopOptions under the router", () => {
    test("LOKI_ROUTER=1 carries settings.advisorModel=opus and autoCompactWindow=100000", () => {
      process.env["LOKI_ROUTER"] = "1";
      const o = buildSdkLoopOptions(base());
      expect(o.settings).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
      expect(o.model).toBe("haiku");
    });

    test("compact ceiling is keyed on the executor: haiku and unknown get it, sonnet and opus do not", () => {
      process.env["LOKI_ROUTER"] = "1";
      const w = (model: string) => buildSdkLoopOptions({ ...base(), model }).settings;
      expect(w("haiku")).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
      expect(w("claude-haiku-5-5")).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
      expect(w("sonnet")).toEqual({ advisorModel: "opus" });
      expect(w("claude-sonnet-5-5")).toEqual({ advisorModel: "opus" });
      expect(w("opus")).toEqual({ advisorModel: "opus" });
      expect(w("claude-opus-5-5")).toEqual({ advisorModel: "opus" });
      expect(w("some-unknown-model")).toEqual({ advisorModel: "opus", autoCompactWindow: 100000 });
    });

    test("advisor unavailable: both absent and the routed model is sonnet, never haiku", () => {
      process.env["LOKI_ROUTER"] = "1";
      process.env["LOKI_ROUTER_ADVISOR"] = "off";
      const o = buildSdkLoopOptions(base());
      expect(o.settings).toBeUndefined();
      expect(o.model).toBe("sonnet");
    });

    test("advisor unavailable on an old Claude Code, a cloud flag or a foreign base url", () => {
      process.env["LOKI_ROUTER"] = "1";
      expect(buildSdkLoopOptions({ ...base(), claudeCodeVersion: "2.1.292" }).settings).toBeUndefined();
      process.env["CLAUDE_CODE_USE_BEDROCK"] = "1";
      expect(buildSdkLoopOptions(base()).model).toBe("sonnet");
      delete process.env["CLAUDE_CODE_USE_BEDROCK"];
      process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example.com";
      expect(buildSdkLoopOptions(base()).settings).toBeUndefined();
    });

    test("a sticky advisor error marker in the run dir makes it unavailable", () => {
      process.env["LOKI_ROUTER"] = "1";
      writeFileSync(join(dir, "advisor-error.txt"), "advisor tool error\n");
      const o = buildSdkLoopOptions(base());
      expect(o.settings).toBeUndefined();
      expect(o.model).toBe("sonnet");
    });

    test("a haiku primary gets a sonnet fallbackModel under the router", () => {
      process.env["LOKI_ROUTER"] = "1";
      expect(buildSdkLoopOptions(base()).fallbackModel).toBe("sonnet");
    });

    test("any haiku model id (claude-haiku-5-5) is raised to sonnet when the advisor is unavailable", () => {
      process.env["LOKI_ROUTER"] = "1";
      process.env["LOKI_ROUTER_ADVISOR"] = "off";
      const o = buildSdkLoopOptions({ ...base(), model: "claude-haiku-5-5" });
      expect(o.model).toBe("sonnet");
      expect(o.settings).toBeUndefined();
      delete process.env["LOKI_ROUTER_ADVISOR"];
      const on = buildSdkLoopOptions({ ...base(), model: "claude-haiku-5-5" });
      expect(on.model).toBe("claude-haiku-5-5");
      expect(on.fallbackModel).toBe("sonnet");
    });

    test("a sonnet or opus model is never rewritten", () => {
      process.env["LOKI_ROUTER"] = "1";
      process.env["LOKI_ROUTER_ADVISOR"] = "off";
      expect(buildSdkLoopOptions({ ...base(), model: "sonnet" }).model).toBe("sonnet");
      expect(buildSdkLoopOptions({ ...base(), model: "opus" }).model).toBe("opus");
    });

    test("flag off or unset: byte-identical to the pre-router options", () => {
      const off = JSON.stringify(buildSdkLoopOptions(base()));
      process.env["LOKI_ROUTER"] = "0";
      expect(JSON.stringify(buildSdkLoopOptions(base()))).toBe(off);
      const o = buildSdkLoopOptions(base());
      expect("settings" in o).toBe(false);
      expect("model" in o).toBe(false);
      expect(o.fallbackModel).toBeUndefined();
    });

    test("SAFE-3a: an implement session blocks writes outside its working directory (the unit worktree); other stages do not", () => {
      process.env["LOKI_E10_STAGE"] = "implement";
      expect(buildSdkLoopOptions(base()).settings).toEqual({ permissions: { blockWritesOutsideWorkingDirectories: true } });
      process.env["LOKI_ROUTER"] = "1";
      expect(buildSdkLoopOptions(base()).settings).toEqual({ advisorModel: "opus", autoCompactWindow: 100000, permissions: { blockWritesOutsideWorkingDirectories: true } });
      delete process.env["LOKI_ROUTER"];
      for (const stage of ["plan", "fix", "wall", "deep", "review"]) {
        process.env["LOKI_E10_STAGE"] = stage;
        expect(buildSdkLoopOptions(base()).settings).toBeUndefined();
      }
      delete process.env["LOKI_E10_STAGE"];
      expect(buildSdkLoopOptions(base()).settings).toBeUndefined();
    });

    test("the engine10 six-tool whitelist is untouched by the router", () => {
      process.env["LOKI_E10_STAGE"] = "implement";
      const off = buildSdkLoopOptions(base()).tools;
      process.env["LOKI_ROUTER"] = "1";
      expect(buildSdkLoopOptions(base()).tools).toEqual(off);
    });
  });

  describe("CLI argv", () => {
    function stubCli(): { cli: string; log: string } {
      const log = join(dir, "argv.log");
      const cli = join(dir, "claude-stub.sh");
      writeFileSync(
        cli,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.293 (Claude Code)"; exit 0; fi\nif [ "$1" = "--help" ]; then echo "--settings --model"; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`,
      );
      chmodSync(cli, 0o755);
      return { cli, log };
    }
    const call = () => ({
      tier: "development" as const,
      prompt: "hi",
      cwd: dir,
      iterationOutputPath: join(dir, "out.txt"),
      mainLoop: false,
    });

    test("LOKI_ROUTER=1 puts advisorModel (no compact ceiling, sonnet executor) in a --settings JSON", async () => {
      const { cli, log } = stubCli();
      process.env["LOKI_CLAUDE_CLI"] = cli;
      process.env["LOKI_ROUTER"] = "1";
      process.env["LOKI_DIR"] = dir;
      await claudeProvider().invoke(call() as never);
      const argv = readFileSync(log, "utf8").split("\n");
      const i = argv.indexOf("--settings");
      expect(i).toBeGreaterThan(-1);
      expect(JSON.parse(argv[i + 1] as string)).toEqual({ advisorModel: "opus" });
    });

    test("SAFE-3a: an implement session on the CLI route carries the write fence in --settings; a plan session carries none", async () => {
      const { cli, log } = stubCli();
      process.env["LOKI_CLAUDE_CLI"] = cli;
      process.env["LOKI_DIR"] = dir;
      process.env["LOKI_E10_STAGE"] = "implement";
      await claudeProvider().invoke(call() as never);
      const argv = readFileSync(log, "utf8").split("\n");
      const i = argv.indexOf("--settings");
      expect(i).toBeGreaterThan(-1);
      expect(JSON.parse(argv[i + 1] as string)).toEqual({ permissions: { blockWritesOutsideWorkingDirectories: true } });
      rmSync(log);
      process.env["LOKI_E10_STAGE"] = "plan";
      await claudeProvider().invoke(call() as never);
      expect(readFileSync(log, "utf8")).not.toContain("--settings");
    });

    test("advisor unavailable or flag off: no advisor in argv", async () => {
      const { cli, log } = stubCli();
      process.env["LOKI_CLAUDE_CLI"] = cli;
      process.env["LOKI_DIR"] = dir;
      await claudeProvider().invoke(call() as never);
      expect(readFileSync(log, "utf8")).not.toContain("advisorModel");
      rmSync(log);
      process.env["LOKI_ROUTER"] = "1";
      process.env["LOKI_ROUTER_ADVISOR"] = "off";
      await claudeProvider().invoke(call() as never);
      expect(readFileSync(log, "utf8")).not.toContain("advisorModel");
    });
  });
});

describe("providers truthy", () => {
  // Unit tests for the `truthy()` helper in src/runner/providers.ts.
  //
  // Context (v7.5.7 fix): the Bun port previously gated LOKI_ALLOW_HAIKU on
  // the literal string "true", while the bash route accepts the broader set
  // "1" / "true" / "yes" / "on" (case-insensitive). The Bun side was tightened
  // silently; users flipping LOKI_ALLOW_HAIKU=1 between routes saw different
  // behavior. The helper is the single chokepoint for the matching rules.
  //
  // These tests pin the matching rules and ensure LOKI_ALLOW_HAIKU is now
  // honored end-to-end via the helper.

  describe("truthy() helper", () => {
    it("accepts the documented positive forms (case-insensitive, trimmed)", () => {
      const positives = [
        "1",
        "true",
        "TRUE",
        "True",
        "yes",
        "YES",
        "on",
        "ON",
        "  true  ",
        "\tyes\n",
      ];
      for (const v of positives) {
        expect(truthy(v)).toBe(true);
      }
    });

    it("rejects undefined, empty, and unrecognized strings", () => {
      const negatives: (string | undefined)[] = [
        undefined,
        "",
        "0",
        "false",
        "no",
        "off",
        "2",
        "truthy",
        " ",
        "y", // intentionally NOT accepted -- bash convention is full word
        "n",
      ];
      for (const v of negatives) {
        expect(truthy(v)).toBe(false);
      }
    });
  });
});

describe("TEN-COST-12 engine10 5-minute cache TTL", () => {
  test("engine10 stage session forces the 5-minute TTL", () => {
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "implement" })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
  });
  test("main RARV loop env is untouched", () => {
    expect(engine10CacheTtlEnv({})).toEqual({});
  });
  test("LOKI_E10_CACHE_TTL=1h opts out", () => {
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "plan", LOKI_E10_CACHE_TTL: "1h" })).toEqual({});
  });
  // #244: the TTL is chosen from the stage's persisted median call gap; an explicit user value always wins
  test("no gap data keeps 5m; a gap over 5m picks 1h; a gap at or under 5m keeps 5m", () => {
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix" })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: "420000" })).toEqual({});
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: "300000" })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: "junk" })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: String(20 * 60_000) })).toEqual({});
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: String(60 * 60_000 - 1) })).toEqual({});
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: String(60 * 60_000) })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: String(70 * 60_000) })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
  });
  test("an explicit LOKI_E10_CACHE_TTL beats the measured gap in both directions", () => {
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: "420000", LOKI_E10_CACHE_TTL: "5m" })).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
    expect(engine10CacheTtlEnv({ LOKI_E10_STAGE: "fix", LOKI_E10_CACHE_GAP_MS: "1000", LOKI_E10_CACHE_TTL: "1h" })).toEqual({});
  });

  // r2: the helper alone is not enough; pin the claudeProvider shellRun call site.
  describe("claudeProvider child env", () => {
    const KEYS = ["LOKI_E10_STAGE", "LOKI_E10_CACHE_TTL", "FORCE_PROMPT_CACHING_5M"];
    let backup: Record<string, string | undefined>;
    beforeEach(() => { backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; });
    afterEach(() => { for (const k of KEYS) { if (backup[k] === undefined) delete process.env[k]; else process.env[k] = backup[k]; } });
    async function childCacheEnv(): Promise<string> {
      const envLog = join(tmp, "env.log");
      writeStub();
      writeFileSync(stubPath, `#!/bin/sh\nprintf '%s' "\${FORCE_PROMPT_CACHING_5M-UNSET}" > '${envLog}'\nexit 0\n`);
      chmodSync(stubPath, 0o755);
      await claudeProvider().invoke(makeCall({ mainLoop: true }));
      return readFileSync(envLog, "utf8");
    }
    test("LOKI_E10_STAGE set gives the child FORCE_PROMPT_CACHING_5M=1", async () => {
      process.env["LOKI_E10_STAGE"] = "implement";
      expect(await childCacheEnv()).toBe("1");
    });
    test("without LOKI_E10_STAGE the child has no such key", async () => {
      expect(await childCacheEnv()).toBe("UNSET");
    });
  });
});

describe("bad call timeout (TEN-STABILITY-39)", () => {
  const KEY = "LOKI_PROVIDER_CALL_TIMEOUT";
  let saved: string | undefined;
  let writes: string[];
  let origWrite: typeof process.stderr.write;
  beforeEach(() => {
    saved = process.env[KEY];
    writes = [];
    origWrite = process.stderr.write;
    process.stderr.write = ((c: unknown) => { writes.push(String(c)); return true; }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = origWrite;
    if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved;
  });
  test("bad call timeout warns and keeps the 7200s default", () => {
    expect(providerCallTimeoutMs({ [KEY]: "2h" })).toBe(7200000);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("2h");
    expect(writes[0]).toContain("7200");
  });
  test("bad call timeout through claudeProvider.invoke notes once", async () => {
    process.env[KEY] = "2h";
    writeStub();
    await claudeProvider().invoke(makeCall({ mainLoop: true }));
    expect(writes.filter((w) => w.includes("LOKI_PROVIDER_CALL_TIMEOUT")).length).toBe(1);
  });
  test("unset and 0 behave as before, silently", () => {
    expect(providerCallTimeoutMs({})).toBe(7200000);
    expect(providerCallTimeoutMs({ [KEY]: "0" })).toBeUndefined();
    expect(providerCallTimeoutMs({ [KEY]: "30" })).toBe(30000);
    expect(writes.length).toBe(0);
  });
});

describe("LOKI_E10_DISALLOWED_TOOLS merge (Q18-04)", () => {
  it("keeps the policy deny list and the stage deny list, deduplicated", () => {
    const m = mergeDisallowedTools(["WebFetch", "WebSearch", "Read(//**/.env)"], "Bash(rm:*),WebSearch,");
    expect(m).toEqual(["WebFetch", "WebSearch", "Read(//**/.env)", "Bash(rm:*)"]);
  });
  it("with no policy deny list returns the stage list alone", () => {
    expect(mergeDisallowedTools(undefined, "A,B")).toEqual(["A", "B"]);
  });
});

// FC-AGENT-TEXT-FORGES-ENGINE-MARKER, stderr sibling: codex exec echoes the agent's commands and their output on
// stderr, so every CLI route must neutralize it exactly as it does stdout. One case per route (claude, codex, cline, aider).
import { closeQueryOnResult } from "../../src/runner/providers.ts";

describe("closeQueryOnResult: closes on the result frame only (CCR-01 r2)", () => {
  type Step = { frame: unknown; gapMs: number };
  // Scripted stream: each frame arrives after its gap; close() ends the stream, dropping any frame not yet delivered.
  const fake = (steps: Step[]) => {
    let closed = 0, i = 0;
    const q = { close: () => { closed++; }, [Symbol.asyncIterator]() { return { next: async () => {
      if (i >= steps.length || closed) return { value: undefined, done: true as const };
      const st = steps[i++];
      if (!st) throw new Error("fake stream ran past its scripted steps");
      await new Promise((r) => setTimeout(r, st.gapMs));
      return closed ? { value: undefined, done: true as const } : { value: st.frame, done: false as const };
    } }; } };
    return { q: q as never, closed: () => closed };
  };
  const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const toolUse = (cmd: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: cmd } }] } });
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
  const types = (out: unknown[]) => out.map((m) => (m as { type: string }).type);
  const drain = async (g: AsyncIterable<unknown>) => { const out: unknown[] = []; for await (const m of g) out.push(m); return out; };
  // Mutant: the removed substring-based close, re-added (grace timer armed by LOKI_DONE anywhere in a frame).
  async function* substringMutant(q: AsyncIterable<unknown> & { close?: () => void }, graceMs: number): AsyncGenerator<unknown> {
    const it = q[Symbol.asyncIterator]();
    let armed = false;
    try {
      for (;;) {
        const next = it.next();
        const r = armed ? await Promise.race([next, new Promise<null>((res) => setTimeout(() => res(null), graceMs))]) : await next;
        if (r === null || r.done) return;
        yield r.value;
        const m = r.value as { type?: string; message?: unknown };
        if (m?.type === "result") return;
        armed = /LOKI_DONE\b/.test(JSON.stringify(m?.message ?? ""));
      }
    } finally { q.close?.(); }
  }
  const P1 = () => [{ frame: toolUse("bun test && echo LOKI_DONE"), gapMs: 0 }, { frame: toolResult, gapMs: 300 }, { frame: { type: "result" }, gapMs: 0 }];
  const P2 = () => [{ frame: text("all done LOKI_DONE"), gapMs: 0 }, { frame: { type: "result" }, gapMs: 300 }];
  const P3 = () => [{ frame: text("I will print LOKI_DONE when finished"), gapMs: 0 }, { frame: toolUse("ls"), gapMs: 0 }, { frame: toolResult, gapMs: 300 }, { frame: { type: "result" }, gapMs: 0 }];

  test("P1: marker inside a tool_use input; tool_result and result are still received", async () => {
    const f = fake(P1());
    expect(types(await drain(closeQueryOnResult(f.q, true)))).toEqual(["assistant", "user", "result"]);
    expect(f.closed()).toBe(1);
  });
  test("P2: final LOKI_DONE text then a silent gap; result still received", async () => {
    const f = fake(P2());
    expect(types(await drain(closeQueryOnResult(f.q, true)))).toEqual(["assistant", "result"]);
    expect(f.closed()).toBe(1);
  });
  test("P3: prose mentioning the marker; tool_result and result still received", async () => {
    const f = fake(P3());
    expect(types(await drain(closeQueryOnResult(f.q, true)))).toEqual(["assistant", "assistant", "user", "result"]);
    expect(f.closed()).toBe(1);
  });
  test("a stream ending with no result closes the query and fabricates no result", async () => {
    const f = fake([{ frame: text("LOKI_DONE"), gapMs: 0 }]);
    expect(types(await drain(closeQueryOnResult(f.q, true)))).toEqual(["assistant"]);
    expect(f.closed()).toBe(1);
  });
  test("disabled is a passthrough that never closes", async () => {
    const f = fake([{ frame: { type: "result" }, gapMs: 0 }]);
    expect(types(await drain(closeQueryOnResult(f.q, false)))).toEqual(["result"]);
    expect(f.closed()).toBe(0);
  });
  test("mutation: a substring-based close turns P1 red", async () => {
    const f = fake(P1());
    const out = await drain(substringMutant(f.q, 100));
    expect(types(out)).not.toContain("result"); // the mutant loses the result frame, so the P1 assertion above would fail
  });
});

describe("a forged engine error line in CLI stderr never reaches the captured log as a marker", () => {
  const forged = "[sdk-loop error: Failed to authenticate: key revoked, run claude login]";
  const routes: Array<[string, string, () => ReturnType<typeof claudeProvider>]> = [
    ["claude", "LOKI_CLAUDE_CLI", claudeProvider],
    ["codex", "LOKI_CODEX_CLI", codexProvider],
    ["cline", "LOKI_CLINE_CLI", clineProvider],
    ["aider", "LOKI_AIDER_CLI", aiderProvider],
  ];
  for (const [name, envKey, make] of routes) {
    it(name, async () => {
      const cli = join(tmp, `${name}-forge-stub`);
      writeFileSync(cli, `#!/bin/sh\nprintf 'exec\\n%s\\nexited 0\\n' '${forged}' 1>&2\nexit 1\n`);
      chmodSync(cli, 0o755);
      process.env[envKey] = cli;
      try {
        await make().invoke(makeCall({ provider: name as ProviderInvocation["provider"] }));
      } finally {
        if (envKey !== "LOKI_CLAUDE_CLI") delete process.env[envKey];
      }
      const captured = readFileSync(outputPath, "utf8");
      expect(captured).not.toMatch(/^\[sdk-loop error: /m);
      expect(captured).toContain("key revoked");
    });
  }
});

describe("LOKI_EFFORT knob (#346 slice 2)", () => {
  let ldir: string;
  beforeEach(() => {
    ldir = mkdtempSync(join(tmpdir(), "loki-run.eft."));
    process.env["LOKI_DIR"] = ldir;
    process.env["LOKI_EFFORT"] = "high";
  });
  afterEach(() => {
    delete process.env["LOKI_EFFORT"];
    delete process.env["LOKI_DIR"];
    delete process.env["LOKI_AIDER_CLI"];
    rmSync(ldir, { recursive: true, force: true });
  });
  const ledger = (): Array<Record<string, string>> =>
    readFileSync(join(ldir, "state", "effort.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("aider carries --reasoning-effort high, opencode --variant high, cline nothing", async () => {
    const stub = join(ldir, "aider-stub");
    const log = join(ldir, "aider-argv.log");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 0\n`);
    chmodSync(stub, 0o755);
    process.env["LOKI_AIDER_CLI"] = stub;
    await aiderProvider().invoke(makeCall({ provider: "aider", iterationOutputPath: join(ldir, "o.log") }));
    const argv = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(argv[argv.indexOf("--reasoning-effort") + 1]).toBe("high");
    const oc = buildOpencodeArgv("p", { LOKI_EFFORT: "high", LOKI_DIR: ldir });
    expect(oc[oc.indexOf("--variant") + 1]).toBe("high");
    expect(effortArgv("cline", "", "development")).toEqual([]);
    expect(ledger().find((r) => r["provider"] === "cline")?.["effort"]).toBe("unsupported");
  });

  it("clamps max to the catalog's highest level and records clamped_from", () => {
    expect(effortArgv("aider", "x", "planning", { LOKI_EFFORT: "max", LOKI_DIR: ldir })).toEqual(["--reasoning-effort", "high"]);
    const last = ledger().pop()!;
    expect(last["effort"]).toBe("high");
    expect(last["clamped_from"]).toBe("max");
  });

  it("bash and Bun write byte-identical, valid JSON ledger lines for hostile values", () => {
    const vals = ['a"b', "back\\slash", "tab\there", "caf\u00e9"];
    for (const v of vals) {
      recordEffort("claude", "development", v, "high", v);
    }
    const bunLines = readFileSync(join(ldir, "state", "effort.jsonl"), "utf8");
    rmSync(join(ldir, "state"), { recursive: true });
    for (const v of vals) {
      execFileSync("bash", ["-c", 'source "$1/providers/models.sh"; loki_effort_record claude development "$2" high "$2"', "_", join(import.meta.dir, "../../.."), v], { env: { ...process.env, LOKI_DIR: ldir } });
    }
    const bashLines = readFileSync(join(ldir, "state", "effort.jsonl"), "utf8");
    expect(bashLines).toBe(bunLines);
    for (const l of bashLines.split("\n").filter(Boolean)) JSON.parse(l);
  });

  it("claude records clamped_from only for a valid clamped level", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level");
    for (const v of ["HIGH", "garbage", 'a"b']) {
      process.env["LOKI_EFFORT"] = v;
      buildAutoFlags({ tier: "development", complexity: "standard", primary: "claude-opus-5-5" });
    }
    const rows = ledger().filter((r) => r["provider"] === "claude");
    expect(rows.map((r) => r["clamped_from"])).toEqual(rows.map(() => ""));
  });

  it("emits nothing without LOKI_EFFORT, and claude takes it ahead of the tier default", () => {
    expect(effortArgv("aider", "x", "development", {})).toEqual([]);
    process.env["LOKI_EFFORT"] = "low";
    expect(effortForTier("development", "standard")).toBe("low");
    expect(effortForTier("development", "standard", "claude-opus-5-5")).toBe("low");
  });
});

describe("provider spawn PWD follows call.cwd (FC-PROVIDER-SPAWN-INHERITS-PARENT-PWD)", () => {
  it("opencode provider child sees PWD equal to call.cwd, not the parent PWD", async () => {
    const { opencodeProvider } = await import("../../src/runner/provider_opencode.ts");
    const root = realpathSync(mkdtempSync(_join(tmpdir(), "oc-pwd-")));
    const stub = _join(root, "stub.js");
    writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ pwd: process.env.PWD ?? null, cwd: process.cwd() }));\n`);
    chmodSync(stub, 0o755);
    const saved = { pwd: process.env["PWD"], cli: process.env["LOKI_OPENCODE_CLI"] };
    process.env["PWD"] = "/parent-pwd-not-the-cwd";
    process.env["LOKI_OPENCODE_CLI"] = stub;
    try {
      const out = _join(root, "out.txt");
      const r = await opencodeProvider().invoke({ prompt: "p", cwd: root, iterationOutputPath: out } as unknown as ProviderInvocation);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ pwd: root, cwd: root });
    } finally {
      if (saved.pwd === undefined) delete process.env["PWD"]; else process.env["PWD"] = saved.pwd;
      if (saved.cli === undefined) delete process.env["LOKI_OPENCODE_CLI"]; else process.env["LOKI_OPENCODE_CLI"] = saved.cli;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("in-session fix rounds: Stop hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-stophook-"));
  const sh = (script: string) => ({ cwd: dir, cmd: "sh", args: ["-c", script] });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const run = async (spec: { checks: { cwd: string; cmd: string; args: string[] }[]; rounds: number; budgetS: number }, times = 1, signal?: AbortSignal, preDelayMs = 0) => {
    const { createStopChecksHook } = await import("../../src/runner/stop_checks.ts");
    const hook = createStopChecksHook({ repoDir: dir, baseSha: "HEAD", ...spec }); const out: Record<string, unknown>[] = [];
    if (preDelayMs) await new Promise((r) => setTimeout(r, preDelayMs));
    for (let i = 0; i < times; i++) out.push(await hook({}, undefined, { signal: signal ?? new AbortController().signal }));
    return out;
  };
  test("a failing check blocks the stop and feeds the failure back", async () => {
    const [r] = await run({ checks: [sh("echo FAILED test_x; exit 1")], rounds: 2, budgetS: 30 });
    expect(r!.decision).toBe("block");
    expect(String(r!.reason)).toContain("FAILED test_x");
  });
  test("a passing check adds zero rounds", async () => {
    expect(await run({ checks: [sh("exit 0")], rounds: 2, budgetS: 30 })).toEqual([{}]);
  });
  test("the round cap is honored", async () => {
    const out = await run({ checks: [sh("exit 1")], rounds: 2, budgetS: 30 }, 4);
    expect(out.map((o) => o.decision)).toEqual(["block", "block", undefined, undefined]);
  });
  test("a missing tool allows the stop", async () => {
    expect(await run({ checks: [{ cwd: dir, cmd: "loki-no-such-tool-xyz", args: [] }], rounds: 2, budgetS: 30 })).toEqual([{}]);
  });
  test("the deadline starts at the Stop call, not at hook construction: a long session still blocks a failing check", async () => {
    const [r] = await run({ checks: [sh("echo STILL_RED; exit 1")], rounds: 2, budgetS: 2 }, 1, undefined, 2500);
    expect(r!.decision).toBe("block");
    expect(String(r!.reason)).toContain("STILL_RED");
  });
  test("the feedback forbids editing the read-only Wall files only, and allows an outdated non-Wall assertion", async () => {
    const [r] = await run({ checks: [sh("exit 1")], rounds: 2, budgetS: 30 });
    expect(String(r!.reason)).toContain("read-only Wall");
    expect(String(r!.reason)).toContain("may update that assertion");
    expect(String(r!.reason)).not.toContain("not the tests");
  });
  test("an aborted stage signal allows the stop and kills the check's process group", async () => {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    expect(await run({ checks: [sh("sleep 20; exit 1")], rounds: 2, budgetS: 30 }, 1, ac.signal)).toEqual([{}]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("a harness-owned load failure (same on the base commit) allows the stop; a protected Wall check still blocks", async () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-stophook-repo-"));
    try {
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
      git("init", "-q"); writeFileSync(join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-q", "-m", "base");
      const load = { cwd: repo, cmd: "sh", args: ["-c", "echo \"Cannot find module 'zzz-missing'\"; exit 1"] };
      expect(await run({ checks: [load], rounds: 2, budgetS: 30, repoDir: repo } as never)).toEqual([{}]);
      expect((await run({ checks: [{ ...load, protect: true }], rounds: 2, budgetS: 30, repoDir: repo } as never))[0]!.decision).toBe("block");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  test("planStopChecks: Wall tests first, red-on-base and system-interpreter tests skipped, knob off, no map", async () => {
    const { planStopChecks } = await import("../../src/runner/stop_checks.ts");
    mkdirSync(join(dir, ".loki", "state"), { recursive: true });
    for (const f of ["w.test.ts", "a.test.ts", "red.test.ts"]) writeFileSync(join(dir, f), "x\n");
    writeFileSync(join(dir, ".loki", "state", "repo-profile.json"), JSON.stringify({ baseline: { failing_ids: ["red.test.ts > boom"] } }));
    const map = { runners: ["bun"], tests: [{ runner: "bun", path: "a.test.ts" }, { runner: "bun", path: "red.test.ts" }] };
    const outputs = { intake: { testmap: map }, wall: { files: [{ path: join(dir, "w.test.ts"), runner: "bun" }] } };
    const plan = planStopChecks(dir, outputs, new Set(["a.test.ts", "red.test.ts"]), 480, "HEAD", {});
    expect(plan.stopChecks?.checks.map((c) => c.args.at(-1))).toEqual(["w.test.ts", "a.test.ts"]);
    expect(plan.stopChecks?.checks[0]!.protect).toBe(true);
    expect(plan.stopChecks?.checks[1]!.protect).toBeUndefined();
    expect(planStopChecks(dir, outputs, new Set(["a.test.ts"]), 480, "HEAD", { LOKI_E10_STOP_CHECKS: "0" })).toEqual({});
    expect(planStopChecks(dir, undefined, new Set(), 480, "HEAD", {})).toEqual({});
  });
  test("a check that outlives the stage budget is cut and never read as a failure", async () => {
    const t0 = Date.now();
    expect(await run({ checks: [sh("sleep 20; exit 1")], rounds: 2, budgetS: 2 })).toEqual([{}]);
    expect(Date.now() - t0).toBeLessThan(6000);
  });
  test("parseStopChecks rejects absent or malformed specs", async () => {
    const { parseStopChecks } = await import("../../src/runner/stop_checks.ts");
    expect(parseStopChecks(undefined)).toBeNull();
    expect(parseStopChecks("not json")).toBeNull();
    expect(parseStopChecks(JSON.stringify({ checks: [], rounds: 2, budgetS: 9 }))).toBeNull();
    expect(parseStopChecks(JSON.stringify({ checks: [{ cwd: "/", cmd: "x", args: [] }], rounds: 2, budgetS: 9 }))).toBeNull();
    expect(parseStopChecks(JSON.stringify({ checks: [{ cwd: "/", cmd: "x", args: [] }], rounds: 2, budgetS: 9, repoDir: "/", baseSha: "b" }))?.rounds).toBe(2);
  });
});
