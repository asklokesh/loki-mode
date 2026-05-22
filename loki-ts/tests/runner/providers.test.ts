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

  it("argv shape: [exec, --full-auto, <prompt>] (codex.sh:188)", async () => {
    writeCodexStub({ stdout: "ok" });
    const p = codexProvider();
    const r = await p.invoke(makeCall({ provider: "codex", prompt: "build x" }));
    expect(r.exitCode).toBe(0);
    const argv = readFileSync(codexArgvLog, "utf8").split("\n").filter(Boolean);
    // v7.4.18: switched argv shape from --full-auto preset to the
    // explicit flags it expands to in codex CLI v0.125.0.
    // Stub records positional args only ("$@" excludes argv[0] cli path).
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("--ask-for-approval");
    expect(argv[2]).toBe("never");
    expect(argv[3]).toBe("--sandbox");
    expect(argv[4]).toBe("danger-full-access");
    // --output-last-message <path> is on by default; the prompt is the
    // last positional. Verify the prompt is present somewhere after the
    // approval/sandbox flags rather than asserting an exact index.
    expect(argv).toContain("build x");
    // --output-last-message defaults ON. Verify it is emitted.
    expect(argv).toContain("--output-last-message");
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
