import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// S-177 (BACKLOG 98, Bun half): the runTestCoverage `npm test` fallback must
// not read an exit-0 run whose summary prints failures as a pass. Mirrors the
// bash summary parser (run.sh enforce_test_coverage `_tr_failed_n` awk).
//
// Each case drives the real fallback end to end: a stub runner under
// node_modules/.bin prints a canned summary and exits 0, `npm test` runs it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTestCoverage } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-npm-summary-"));
  delete process.env.LOKI_STUB_GATE_TEST_COVERAGE;
});

afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function ctx(): RunnerContext {
  return {
    cwd: scratch,
    lokiDir: scratch,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 5,
    maxIterations: 10,
    baseWaitSeconds: 1,
    maxWaitSeconds: 60,
    autonomyMode: "single-pass",
    sessionModel: "development",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 1,
    retryCount: 0,
    currentTier: "development",
    log: () => {},
  };
}

// A stub `runner` that prints `text` (one line per array entry) to `stream`
// and exits 0, wired as the package's test script.
function stubRunner(runner: string, lines: string[], stream: "out" | "err" = "out"): void {
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "p", version: "1.0.0", scripts: { test: runner } }),
  );
  mkdirSync(join(scratch, "node_modules", ".bin"), { recursive: true });
  const body = join(scratch, "summary.txt");
  writeFileSync(body, lines.join("\n") + "\n");
  const bin = join(scratch, "node_modules", ".bin", runner);
  writeFileSync(bin, `#!/bin/sh\ncat '${body}'${stream === "err" ? " >&2" : ""}\nexit 0\n`);
  chmodSync(bin, 0o755);
}

describe("npm test fallback: exit 0 with failures in the summary", () => {
  it("jest 'Tests: 1 failed' returns passed false", async () => {
    stubRunner("jest", ["Test Suites: 1 failed, 1 total", "Tests:       1 failed, 2 passed, 3 total"], "err");
    const r = await runTestCoverage(ctx());
    expect(r.passed).toBe(false);
    expect(r.detail ?? "").toContain("1 failed");
  }, 60_000);

  it("vitest 'Test Files 1 failed' returns passed false", async () => {
    stubRunner("vitest", [" Test Files  1 failed | 2 passed (3)", "      Tests  4 passed (4)"]);
    const r = await runTestCoverage(ctx());
    expect(r.passed).toBe(false);
  }, 60_000);

  it("pytest '1 passed, 1 error' returns passed false", async () => {
    stubRunner("pytest", ["========== 1 passed, 1 error in 0.52s =========="]);
    const r = await runTestCoverage(ctx());
    expect(r.passed).toBe(false);
  }, 60_000);

  it("ANSI-coloured jest summary is still read", async () => {
    stubRunner("jest", ["\u001b[1mTests:\u001b[22m       \u001b[31m2 failed\u001b[39m, 3 total"], "err");
    const r = await runTestCoverage(ctx());
    expect(r.passed).toBe(false);
  }, 60_000);

  it("positive control: 'Tests: 3 passed' returns passed true", async () => {
    stubRunner("jest", ["Test Suites: 1 passed, 1 total", "Tests:       3 passed, 3 total"], "err");
    const r = await runTestCoverage(ctx());
    expect(r.passed).toBe(true);
    expect(r.inconclusive).toBeFalsy();
  }, 60_000);
});
