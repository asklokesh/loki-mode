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
  type AgentVerdict,
  type Voter,
  type AggregateResult,
  type CouncilEvaluateContext,
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

// ---------------------------------------------------------------------------
// D2 slice -- real implementations of the 4 ex-stubs.
// ---------------------------------------------------------------------------

function approve(role: string): AgentVerdict {
  return { role, verdict: "APPROVE", reason: "ok", issues: [] };
}
function reject(role: string, severity: AgentVerdict["issues"][number]["severity"] = "HIGH"): AgentVerdict {
  return {
    role,
    verdict: "REJECT",
    reason: "found issues",
    issues: [{ severity, description: "blocking" }],
  };
}

describe("councilAggregateVotes", () => {
  it("returns COMPLETE when all voters APPROVE and no blocking severity", async () => {
    const r = await councilAggregateVotes([approve("a"), approve("b"), approve("c")]);
    expect(r.decision).toBe("COMPLETE");
    expect(r.unanimous).toBe(true);
    expect(r.approveCount).toBe(3);
    expect(r.rejectCount).toBe(0);
    expect(r.blockingSeverity).toBeNull();
    // 2/3 ceiling for n=3 -> 2.
    expect(r.threshold).toBe(2);
  });

  it("returns CONTINUE when all voters REJECT and surfaces highest severity", async () => {
    const r = await councilAggregateVotes([reject("a"), reject("b", "CRITICAL"), reject("c")]);
    expect(r.decision).toBe("CONTINUE");
    expect(r.unanimous).toBe(false);
    expect(r.approveCount).toBe(0);
    expect(r.rejectCount).toBe(3);
    expect(r.blockingSeverity).toBe("CRITICAL");
  });

  it("returns CONTINUE on mixed votes when severity gate trips", async () => {
    const r = await councilAggregateVotes([approve("a"), reject("b"), approve("c")]);
    // 2 of 3 approves clears the 2/3 ceiling -- but the REJECT carries a HIGH
    // severity which trips the severity-budget gate, forcing CONTINUE.
    expect(r.decision).toBe("CONTINUE");
    expect(r.unanimous).toBe(false);
    expect(r.approveCount).toBe(2);
    expect(r.rejectCount).toBe(1);
    expect(r.blockingSeverity).toBe("HIGH");
  });

  it("returns CONTINUE on empty input rather than dividing by zero", async () => {
    const r = await councilAggregateVotes([]);
    expect(r.decision).toBe("CONTINUE");
    expect(r.totalMembers).toBe(0);
    expect(r.threshold).toBe(0);
  });
});

describe("councilDevilsAdvocate", () => {
  it("triggers on unanimous APPROVE and vetoes when no test logs are present", async () => {
    const v = await councilDevilsAdvocate([approve("a"), approve("b"), approve("c")], { lokiDir: tmpBase });
    expect(v.role).toBe("devils_advocate");
    // No logs dir -> "no test result logs found" -> REJECT.
    expect(v.verdict).toBe("REJECT");
    expect(v.issues.some((i) => /test/i.test(i.description))).toBe(true);
  });

  it("upholds unanimous APPROVE when test logs show a pass marker", async () => {
    const fs = await import("node:fs");
    fs.mkdirSync(join(tmpBase, "logs"), { recursive: true });
    fs.writeFileSync(join(tmpBase, "logs", "test-run.log"), "running suite\nall tests passed\n");
    const v = await councilDevilsAdvocate([approve("a"), approve("b"), approve("c")], { lokiDir: tmpBase });
    expect(v.verdict).toBe("APPROVE");
    expect(v.issues.length).toBe(0);
  });

  it("is a no-op (returns APPROVE marker) when input is not unanimous", async () => {
    const v = await councilDevilsAdvocate([approve("a"), reject("b"), approve("c")], { lokiDir: tmpBase });
    expect(v.verdict).toBe("APPROVE");
    expect(v.reason).toMatch(/not unanimous/i);
    expect(v.issues.length).toBe(0);
  });
});

describe("councilEvaluate", () => {
  it("invokes injected voters in order and aggregates the result", async () => {
    const order: string[] = [];
    const voters: Voter[] = [
      async (_c: CouncilEvaluateContext) => { order.push("v1"); return approve("requirements_verifier"); },
      async (_c: CouncilEvaluateContext) => { order.push("v2"); return approve("test_auditor"); },
      async (_c: CouncilEvaluateContext) => { order.push("v3"); return reject("devils_advocate", "LOW"); },
    ];
    const r = await councilEvaluate({ ctx: fakeCtx(), iteration: 1, voters });
    expect(order).toEqual(["v1", "v2", "v3"]);
    expect(r.approveCount).toBe(2);
    expect(r.rejectCount).toBe(1);
    // LOW severity does NOT trip the default HIGH gate; n=3, threshold=2,
    // approve=2 -> COMPLETE.
    expect(r.decision).toBe("COMPLETE");
  });

  it("runs the devil's advocate and respects its veto on unanimous APPROVE", async () => {
    const voters: Voter[] = [
      async () => approve("requirements_verifier"),
      async () => approve("test_auditor"),
      async () => approve("devils_advocate"),
    ];
    // Default tmpBase has no logs/ dir -- DA will veto.
    const r = await councilEvaluate({ ctx: fakeCtx(), iteration: 1, voters });
    expect(r.decision).toBe("CONTINUE");
    expect(r.unanimous).toBe(false);
    // Contrarian verdict appended to votes list.
    expect(r.votes.length).toBe(4);
    expect(r.votes[3]?.role).toBe("devils_advocate");
    expect(r.votes[3]?.verdict).toBe("REJECT");
  });
});

describe("councilWriteReport", () => {
  it("writes .loki/council/report.md with the expected sections", async () => {
    const aggregate: AggregateResult = {
      decision: "COMPLETE",
      unanimous: true,
      approveCount: 3,
      rejectCount: 0,
      cannotValidateCount: 0,
      threshold: 2,
      totalMembers: 3,
      blockingSeverity: null,
      votes: [approve("requirements_verifier"), approve("test_auditor"), approve("devils_advocate")],
    };
    await councilWriteReport([aggregate], { lokiDir: tmpBase, iteration: 5 });
    const path = join(tmpBase, "council", "report.md");
    expect(existsSync(path)).toBe(true);
    const md = readFileSync(path, "utf-8");
    expect(md).toContain("# Completion Council Final Report");
    expect(md).toContain("**Iteration:** 5");
    expect(md).toContain("**Verdict:** APPROVED");
    expect(md).toContain("## Convergence Data");
    expect(md).toContain("## Council Configuration");
    expect(md).toContain("## Vote History");
    expect(md).toContain("Round 1: COMPLETE (3 approve / 0 reject");
    expect(md).toContain("requirements_verifier: APPROVE");
  });

  it("writes a CONTINUE verdict and 'No vote history' when no rounds supplied", async () => {
    await councilWriteReport([], { lokiDir: tmpBase, iteration: 0 });
    const md = readFileSync(join(tmpBase, "council", "report.md"), "utf-8");
    expect(md).toContain("**Verdict:** CONTINUE");
    expect(md).toContain("- No vote history available");
  });
});
