// Tests for src/runner/council.ts (Phase 5 D1 first slice).
//
// Strategy: each test gets a fresh tmpdir; we point LOKI_DIR at it so
// councilInit + defaultCouncil.trackIteration write into a sandbox and not
// the real .loki/. Restoring LOKI_DIR in afterEach prevents cross-test leak.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  councilInit,
  defaultCouncil,
  councilEvaluate,
  councilAggregateVotes,
  councilDevilsAdvocate,
  councilWriteReport,
  type CouncilState,
} from "../../src/runner/council.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let tmpBase = "";
let savedLokiDir: string | undefined;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "loki-council-test-"));
  savedLokiDir = process.env["LOKI_DIR"];
  process.env["LOKI_DIR"] = tmpBase;
});

afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  if (tmpBase && existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

function fakeCtx(): RunnerContext {
  return {
    cwd: tmpBase,
    lokiDir: tmpBase,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 1,
    maxIterations: 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    autonomyMode: "single-pass",
    sessionModel: "fast",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 0,
    retryCount: 0,
    currentTier: "fast",
    log: () => {},
  };
}

describe("councilInit", () => {
  it("creates .loki/council/state.json with the documented schema", async () => {
    await councilInit(undefined);
    const f = join(tmpBase, "council", "state.json");
    expect(existsSync(f)).toBe(true);
    const s = JSON.parse(readFileSync(f, "utf-8")) as CouncilState;
    expect(s.initialized).toBe(true);
    expect(s.enabled).toBe(true);
    expect(s.total_votes).toBe(0);
    expect(s.approve_votes).toBe(0);
    expect(s.reject_votes).toBe(0);
    expect(s.last_check_iteration).toBe(0);
    expect(s.consecutive_no_change).toBe(0);
    expect(s.done_signals).toBe(0);
    expect(Array.isArray(s.convergence_history)).toBe(true);
    expect(s.convergence_history.length).toBe(0);
    expect(Array.isArray(s.verdicts)).toBe(true);
    expect(s.verdicts.length).toBe(0);
    expect(s.prd_path).toBeNull();
  });

  it("persists prdPath when supplied", async () => {
    await councilInit("/path/to/prd.md");
    const s = JSON.parse(
      readFileSync(join(tmpBase, "council", "state.json"), "utf-8"),
    ) as CouncilState;
    expect(s.prd_path).toBe("/path/to/prd.md");
  });

  it("writes 2-space indented JSON for cross-runtime parity with python json.dump", async () => {
    await councilInit(undefined);
    const text = readFileSync(join(tmpBase, "council", "state.json"), "utf-8");
    // The bash version uses python json.dump(indent=2); confirm we match.
    expect(text).toContain('\n  "initialized": true');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is idempotent -- re-init overwrites state cleanly", async () => {
    await councilInit("/a.md");
    await councilInit("/b.md");
    const s = JSON.parse(
      readFileSync(join(tmpBase, "council", "state.json"), "utf-8"),
    ) as CouncilState;
    expect(s.prd_path).toBe("/b.md");
  });
});

describe("defaultCouncil", () => {
  it("shouldStop returns false in this slice (full pipeline is stubbed)", async () => {
    const r = await defaultCouncil.shouldStop(fakeCtx());
    expect(r).toBe(false);
  });

  it("trackIteration appends a row to convergence.log", async () => {
    expect(defaultCouncil.trackIteration).toBeDefined();
    await defaultCouncil.trackIteration!("/tmp/iter-1.log");
    const log = join(tmpBase, "council", "convergence.log");
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    // schema: timestamp|iteration|files|no_change|done|logfile
    const parts = lines[0]!.split("|");
    expect(parts.length).toBe(6);
    expect(Number.isInteger(parseInt(parts[0]!, 10))).toBe(true);
    expect(parts[5]).toBe("/tmp/iter-1.log");
  });

  it("trackIteration appends across multiple invocations", async () => {
    await defaultCouncil.trackIteration!("/tmp/iter-1.log");
    await defaultCouncil.trackIteration!("/tmp/iter-2.log");
    await defaultCouncil.trackIteration!("/tmp/iter-3.log");
    const log = join(tmpBase, "council", "convergence.log");
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("trackIteration reads iteration from state.json when present", async () => {
    await councilInit(undefined);
    await defaultCouncil.trackIteration!("/tmp/iter-x.log");
    const log = join(tmpBase, "council", "convergence.log");
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    const parts = lines[0]!.split("|");
    // last_check_iteration is 0 in a fresh state file.
    expect(parts[1]).toBe("0");
  });
});

describe("STUB exports throw with bash source citations", () => {
  it("councilEvaluate throws", async () => {
    await expect(
      councilEvaluate({ ctx: fakeCtx(), iteration: 1 }),
    ).rejects.toThrow(/STUB/);
  });

  it("councilAggregateVotes throws", async () => {
    await expect(councilAggregateVotes([])).rejects.toThrow(/STUB/);
  });

  it("councilDevilsAdvocate throws", async () => {
    await expect(councilDevilsAdvocate([])).rejects.toThrow(/STUB/);
  });

  it("councilWriteReport throws", async () => {
    await expect(councilWriteReport([])).rejects.toThrow(/STUB/);
  });
});
