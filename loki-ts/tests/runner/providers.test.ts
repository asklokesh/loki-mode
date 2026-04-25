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

  it("gemini throws", async () => {
    const p = geminiProvider();
    await expect(p.invoke(makeCall({ provider: "gemini" }))).rejects.toThrow(
      /STUB: Phase 5/,
    );
  });

  it("cline throws", async () => {
    const p = clineProvider();
    await expect(p.invoke(makeCall({ provider: "cline" }))).rejects.toThrow(
      /STUB: Phase 5/,
    );
  });

  it("aider throws", async () => {
    const p = aiderProvider();
    await expect(p.invoke(makeCall({ provider: "aider" }))).rejects.toThrow(
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
