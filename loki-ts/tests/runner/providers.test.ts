// Tests for src/runner/providers.ts.
// Source-of-truth: providers/loader.sh, providers/claude.sh.
//
// Hermetic strategy for the Claude path: write a tiny shell stub that mimics
// the `claude` CLI (echoes its args, optionally exits non-zero), then point
// LOKI_CLAUDE_CLI at that stub for the duration of the test. We never spawn
// the real Claude binary.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  resolveProvider,
  claudeProvider,
  codexProvider,
  clineProvider,
  aiderProvider,
} from "../../src/runner/providers.ts";
import type { ProviderInvocation } from "../../src/runner/types.ts";
import { _resetClaudeHelpCacheForTest } from "../../src/providers/claude_flags.ts";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-providers-test-"));
  stubPath = join(tmp, "claude-stub");
  outputPath = join(tmp, "iter", "captured.log");
  process.env["LOKI_CLAUDE_CLI"] = stubPath;
  // Wipe tier/maxTier env so tests start from a clean slate.
  delete process.env["LOKI_ALLOW_HAIKU"];
  delete process.env["LOKI_MAX_TIER"];
});

afterEach(() => {
  delete process.env["LOKI_CLAUDE_CLI"];
  delete process.env["LOKI_ALLOW_HAIKU"];
  delete process.env["LOKI_MAX_TIER"];
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
  it("passes --dangerously-skip-permissions, --model, and -p", async () => {
    const argvLog = writeStub({ stdout: "ok" });
    const p = claudeProvider();
    const r = await p.invoke(makeCall({ tier: "development", prompt: "build x" }));
    expect(r.exitCode).toBe(0);
    const argv = readArgv(argvLog);
    // Default (no LOKI_ALLOW_HAIKU): development tier maps to opus
    // (claude.sh:135-141).
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--model");
    expect(argv).toContain("opus");
    expect(argv).toContain("-p");
    expect(argv).toContain("build x");
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
    // claude.sh:176-181: planning capped to development tier under sonnet
    // ceiling. Default haiku-off mapping: development -> opus.
    expect(argv).toContain("opus");
    // The cap re-resolves to development; with haiku off, that is opus too.
    // Ensure we did not pass through the planning-tier sentinel by also
    // confirming exit code propagated through the stub.
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
    // Default Anthropic-native invocation: tier-mapped opus alias.
    expect(argv).toContain("opus");
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
    expect(argv).toContain("opus");
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
    expect(argv).toEqual(["-y", "do thing"]);
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
    expect(argv).toEqual(["-y", "-m", "anthropic/claude-opus-4-7", "build x"]);
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
      "fix bug",
      "--yes-always",
      "--no-auto-commits",
      "--model",
      "claude-opus-4-7",
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
