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
  geminiProvider,
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

  it("returns invokers for all five names (stubs included)", async () => {
    for (const name of ["claude", "codex", "gemini", "cline", "aider"] as const) {
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

describe("stubbed providers throw with discoverable message", () => {
  it("codex throws", async () => {
    const p = codexProvider();
    await expect(p.invoke(makeCall({ provider: "codex" }))).rejects.toThrow(
      /STUB: Phase 5/,
    );
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

// ---------------------------------------------------------------------------
// Gemini provider tests (gemini.sh:1-343 -> src/runner/providers.ts)
// ---------------------------------------------------------------------------
//
// FakeGemini stub strategy: a single shell stub records its argv (one per
// line) AND the GOOGLE_API_KEY value AND the call count to per-test sidecar
// files. It picks behavior from env vars set by the test:
//   GEMINI_FAKE_MODE   = ok | auth | rate | rate-then-ok | auth-then-ok
//   GEMINI_FAKE_LOG    = directory holding argv-N.log + key-N.log + count
// This lets us simulate:
//   - happy path (mode=ok)
//   - persistent auth failure (mode=auth, every call exits 1 with "401" on stderr)
//   - persistent rate-limit (mode=rate, every call exits 1 with "429" on stderr)
//   - auth on first call, success on second (mode=auth-then-ok)
//   - rate-limit on first call, success on second (mode=rate-then-ok)
const geminiStubScript = (mode: string, logDir: string): string => `#!/bin/sh
LOG_DIR='${logDir}'
mkdir -p "$LOG_DIR"
COUNT_FILE="$LOG_DIR/count"
N=0
if [ -f "$COUNT_FILE" ]; then N=$(cat "$COUNT_FILE"); fi
N=$((N + 1))
printf '%s' "$N" > "$COUNT_FILE"
printf '%s\\n' "$@" > "$LOG_DIR/argv-$N.log"
printf '%s' "\${GOOGLE_API_KEY:-}" > "$LOG_DIR/key-$N.log"
case '${mode}' in
  ok)
    printf 'gemini-ok'
    exit 0
    ;;
  auth)
    printf '401 Unauthorized: invalid api key\\n' 1>&2
    exit 1
    ;;
  rate)
    printf '429 quota exceeded resource exhausted\\n' 1>&2
    exit 1
    ;;
  auth-then-ok)
    if [ "$N" = "1" ]; then
      printf '401 Unauthorized: invalid api key\\n' 1>&2
      exit 1
    fi
    printf 'gemini-recovered'
    exit 0
    ;;
  rate-then-ok)
    if [ "$N" = "1" ]; then
      printf '429 quota exceeded\\n' 1>&2
      exit 1
    fi
    printf 'gemini-flash-ok'
    exit 0
    ;;
  *)
    exit 99
    ;;
esac
`;

let geminiStubSeq = 0;
function writeGeminiStub(mode: string): { stubPath: string; logDir: string } {
  // Unique stub + log dir per call so tests that invoke the provider multiple
  // times in a single `it` (e.g. the tier-matrix test) get independent argv
  // logs and call counters. Without this, COUNT_FILE persists across calls
  // and argv-1.log gets clobbered by later iterations.
  geminiStubSeq += 1;
  const stub = join(tmp, `gemini-stub-${geminiStubSeq}`);
  const logDir = join(tmp, `gemini-log-${geminiStubSeq}`);
  writeFileSync(stub, geminiStubScript(mode, logDir));
  chmodSync(stub, 0o755);
  return { stubPath: stub, logDir };
}

function readGeminiArgv(logDir: string, n: number): string[] {
  return readFileSync(join(logDir, `argv-${n}.log`), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

function readGeminiKey(logDir: string, n: number): string {
  return readFileSync(join(logDir, `key-${n}.log`), "utf8");
}

function readGeminiCount(logDir: string): number {
  try {
    return Number.parseInt(
      readFileSync(join(logDir, "count"), "utf8").trim(),
      10,
    );
  } catch {
    return 0;
  }
}

describe("geminiProvider invocation", () => {
  // The gemini provider reads several env vars at runtime. Each test owns a
  // clean env to avoid bleed (parallel test runners can otherwise leak
  // GOOGLE_API_KEY between cases).
  const geminiEnvKeys = [
    "LOKI_GEMINI_CLI",
    "LOKI_GEMINI_API_KEYS",
    "LOKI_GEMINI_MODEL_PLANNING",
    "LOKI_GEMINI_MODEL_DEVELOPMENT",
    "LOKI_GEMINI_MODEL_FAST",
    "LOKI_GEMINI_MODEL_FALLBACK",
    "LOKI_MODEL_PLANNING",
    "LOKI_MODEL_DEVELOPMENT",
    "LOKI_MODEL_FAST",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
  ];
  const wipeGeminiEnv = (): void => {
    for (const k of geminiEnvKeys) delete process.env[k];
  };

  beforeEach(() => {
    wipeGeminiEnv();
  });
  afterEach(() => {
    wipeGeminiEnv();
  });

  it("passes --approval-mode=yolo, --model, and prompt as positional last arg", async () => {
    const { stubPath: stub, logDir } = writeGeminiStub("ok");
    process.env["LOKI_GEMINI_CLI"] = stub;
    const p = geminiProvider();
    const r = await p.invoke(
      makeCall({ provider: "gemini", tier: "development", prompt: "hello-gemini" }),
    );
    expect(r.exitCode).toBe(0);
    const argv = readGeminiArgv(logDir, 1);
    // Order from buildGeminiArgv: [--approval-mode=yolo, --model, <model>, <prompt>].
    // The shell stub's $@ skips $0, so we should see exactly these 4 entries.
    expect(argv).toEqual([
      "--approval-mode=yolo",
      "--model",
      "gemini-3-pro-preview",
      "hello-gemini",
    ]);
    // Critical: prompt must be the LAST arg (gemini.sh:34-36 -- -p is deprecated).
    expect(argv[argv.length - 1]).toBe("hello-gemini");
  });

  it("maps tiers to pro for planning/development and flash for fast", async () => {
    const cases: Array<{ tier: "planning" | "development" | "fast"; expected: string }> = [
      { tier: "planning", expected: "gemini-3-pro-preview" },
      { tier: "development", expected: "gemini-3-pro-preview" },
      { tier: "fast", expected: "gemini-3-flash-preview" },
    ];
    for (const c of cases) {
      // Fresh stub dir per case so argv-1.log is unambiguous.
      const { stubPath: stub, logDir } = writeGeminiStub("ok");
      process.env["LOKI_GEMINI_CLI"] = stub;
      const p = geminiProvider();
      await p.invoke(makeCall({ provider: "gemini", tier: c.tier }));
      const argv = readGeminiArgv(logDir, 1);
      const modelIdx = argv.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(argv[modelIdx + 1]).toBe(c.expected);
    }
  });

  it("propagates non-zero exit code from the gemini CLI", async () => {
    // Use mode=auth so the first call fails. With no LOKI_GEMINI_API_KEYS
    // configured, no rotation happens -- the failure surfaces unchanged.
    const { stubPath: stub } = writeGeminiStub("auth");
    process.env["LOKI_GEMINI_CLI"] = stub;
    const p = geminiProvider();
    const r = await p.invoke(makeCall({ provider: "gemini" }));
    expect(r.exitCode).toBe(1);
  });

  it("rotates to next API key from LOKI_GEMINI_API_KEYS on auth error (401)", async () => {
    const { stubPath: stub, logDir } = writeGeminiStub("auth-then-ok");
    process.env["LOKI_GEMINI_CLI"] = stub;
    process.env["LOKI_GEMINI_API_KEYS"] = "key-A,key-B,key-C";
    // GOOGLE_API_KEY unset -> resolveInitialGeminiKey picks pool[0] = key-A.
    const p = geminiProvider();
    const r = await p.invoke(makeCall({ provider: "gemini" }));
    expect(r.exitCode).toBe(0);
    expect(readGeminiCount(logDir)).toBe(2);
    // First call used key-A and got 401.
    expect(readGeminiKey(logDir, 1)).toBe("key-A");
    // Recovery rotated to key-B and succeeded.
    expect(readGeminiKey(logDir, 2)).toBe("key-B");
  });

  it("falls back to flash model on rate-limit (429) and succeeds", async () => {
    const { stubPath: stub, logDir } = writeGeminiStub("rate-then-ok");
    process.env["LOKI_GEMINI_CLI"] = stub;
    const p = geminiProvider();
    // Planning tier -> pro on first attempt -> 429 -> flash on retry.
    const r = await p.invoke(
      makeCall({ provider: "gemini", tier: "planning" }),
    );
    expect(r.exitCode).toBe(0);
    expect(readGeminiCount(logDir)).toBe(2);
    const first = readGeminiArgv(logDir, 1);
    const second = readGeminiArgv(logDir, 2);
    expect(first[first.indexOf("--model") + 1]).toBe("gemini-3-pro-preview");
    expect(second[second.indexOf("--model") + 1]).toBe("gemini-3-flash-preview");
  });

  it("retries at most ONCE per invocation (does not loop on persistent auth failure)", async () => {
    // Persistent auth failure: every call returns 401. Even with a key pool,
    // the contract says one retry max -- count must be exactly 2 (initial +
    // one rotation), not pool.length.
    const { stubPath: stub, logDir } = writeGeminiStub("auth");
    process.env["LOKI_GEMINI_CLI"] = stub;
    process.env["LOKI_GEMINI_API_KEYS"] = "key-A,key-B,key-C,key-D";
    const p = geminiProvider();
    const r = await p.invoke(makeCall({ provider: "gemini" }));
    // Final exit code reflects the second call's failure.
    expect(r.exitCode).toBe(1);
    expect(readGeminiCount(logDir)).toBe(2);
  });

  it("does not retry when no API key pool is configured (auth failure surfaces immediately)", async () => {
    const { stubPath: stub, logDir } = writeGeminiStub("auth");
    process.env["LOKI_GEMINI_CLI"] = stub;
    // No LOKI_GEMINI_API_KEYS, no GOOGLE_API_KEY -> rotation finds nothing.
    const p = geminiProvider();
    const r = await p.invoke(makeCall({ provider: "gemini" }));
    expect(r.exitCode).toBe(1);
    // Exactly one call -- no rotation candidate available.
    expect(readGeminiCount(logDir)).toBe(1);
  });

  it("writes captured stdout + stderr to iterationOutputPath", async () => {
    const { stubPath: stub } = writeGeminiStub("ok");
    process.env["LOKI_GEMINI_CLI"] = stub;
    const p = geminiProvider();
    const r = await p.invoke(makeCall({ provider: "gemini" }));
    expect(r.capturedOutputPath).toBe(outputPath);
    const captured = readFileSync(outputPath, "utf8");
    expect(captured).toContain("gemini-ok");
  });
});
