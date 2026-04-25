// Tests for src/runner/completion.ts.
// Source-of-truth: autonomy/run.sh:8095-8114 (check_completion_promise).
//
// Hermetic: each test creates a fresh tmpdir for .loki and a tmp captured
// output file. We do NOT mutate the real process env permanently -- the
// LOKI_LEGACY_COMPLETION_MATCH flag is restored in afterEach.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCompletionPromise } from "../../src/runner/completion.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let tmp: string;
let lokiDir: string;
let prevLegacyFlag: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-completion-test-"));
  lokiDir = join(tmp, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  prevLegacyFlag = process.env["LOKI_LEGACY_COMPLETION_MATCH"];
  delete process.env["LOKI_LEGACY_COMPLETION_MATCH"];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prevLegacyFlag === undefined) {
    delete process.env["LOKI_LEGACY_COMPLETION_MATCH"];
  } else {
    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = prevLegacyFlag;
  }
});

function makeCtx(over: Partial<RunnerContext> = {}): RunnerContext {
  return {
    cwd: tmp,
    lokiDir,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 5,
    maxIterations: 100,
    baseWaitSeconds: 30,
    maxWaitSeconds: 3600,
    autonomyMode: "checkpoint",
    sessionModel: "sonnet",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 0,
    retryCount: 0,
    currentTier: "development",
    log: () => {},
    ...over,
  };
}

describe("checkCompletionPromise", () => {
  it("returns true when TASK_COMPLETION_CLAIMED signal is present, then consumes it", async () => {
    const signalDir = join(lokiDir, "signals");
    mkdirSync(signalDir, { recursive: true });
    const signalFile = join(signalDir, "TASK_COMPLETION_CLAIMED");
    writeFileSync(signalFile, '{"statement":"done","confidence":"high"}');

    const ctx = makeCtx();
    const out = join(tmp, "iter.log");
    writeFileSync(out, "anything");

    const result = await checkCompletionPromise(ctx, out);
    expect(result).toBe(true);
    // Signal must be consumed so the next iteration does not re-fire.
    expect(existsSync(signalFile)).toBe(false);
  });

  it("returns true when legacy match is enabled and promise text appears in captured output", async () => {
    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = "true";
    const ctx = makeCtx({ completionPromise: "ALL_TESTS_GREEN_AND_DEPLOYED" });
    const out = join(tmp, "iter.log");
    writeFileSync(
      out,
      "blah blah\nfinally: ALL_TESTS_GREEN_AND_DEPLOYED\nmore output\n",
    );

    const result = await checkCompletionPromise(ctx, out);
    expect(result).toBe(true);
  });

  it("returns false when neither signal nor legacy match fire", async () => {
    // Legacy flag NOT set -> default path. No signal file. Captured output
    // contains arbitrary text but no completion promise configured anyway.
    const ctx = makeCtx({ completionPromise: "PROMISE_NEVER_PRINTED" });
    const out = join(tmp, "iter.log");
    writeFileSync(out, "some unrelated provider output\n");

    const result = await checkCompletionPromise(ctx, out);
    expect(result).toBe(false);
  });

  it("returns false when legacy flag is on but promise text is absent", async () => {
    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = "true";
    const ctx = makeCtx({ completionPromise: "NEVER_GONNA_HAPPEN" });
    const out = join(tmp, "iter.log");
    writeFileSync(out, "all other output here\n");

    const result = await checkCompletionPromise(ctx, out);
    expect(result).toBe(false);
  });

  it("returns false when legacy flag is on but completionPromise is unset", async () => {
    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = "true";
    const ctx = makeCtx({ completionPromise: undefined });
    const out = join(tmp, "iter.log");
    writeFileSync(out, "anything\n");

    const result = await checkCompletionPromise(ctx, out);
    expect(result).toBe(false);
  });

  it("returns false when captured output path does not exist", async () => {
    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = "true";
    const ctx = makeCtx({ completionPromise: "DOES_NOT_MATTER" });
    const result = await checkCompletionPromise(ctx, join(tmp, "no-such-file.log"));
    expect(result).toBe(false);
  });
});
