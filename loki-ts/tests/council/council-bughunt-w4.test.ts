import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// loki-ts/tests/council/council-bughunt-w4.test.ts -- W4 bug-hunt fixes.
//
// Covers two confirmed bugs found in the W4 read-only hunt:
//
//   H6 -- NO TIMEOUT on the reviewer subcall. A hung `claude` made
//         `await proc.exited` never resolve, so councilEvaluate hung forever
//         and the "we NEVER hang" invariant was false. The fix bounds every
//         dispatch with LOKI_COUNCIL_TIMEOUT_MS (default 600000ms) at BOTH the
//         dispatch race (any runner, incl. injected stubs) and inside
//         defaultClaudeRunner (kills the real child via AbortSignal).
//
//   M4 -- a CORRUPT .loki/queue/failed.json was caught and swallowed, and the
//         heuristic voter returned APPROVE ("no blocking signals"). For a
//         COMPLETION gate, "cannot read the failure ledger" must fail toward
//         the SAFE direction. The fix returns CANNOT_VALIDATE, which drops the
//         aggregate below the approval threshold so the decision is NOT COMPLETE.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  councilEvaluate,
  councilAggregateVotes,
  DEFAULT_VOTERS,
  type CouncilEvaluateContext,
} from "../../src/runner/council.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

function makeCtx(lokiDir: string): RunnerContext {
  return {
    cwd: lokiDir,
    lokiDir,
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

function makeCec(lokiDir: string, extra: Partial<CouncilEvaluateContext> = {}): CouncilEvaluateContext {
  return { ctx: makeCtx(lokiDir), iteration: 1, ...extra };
}

// ---------------------------------------------------------------------------
// H6 -- hung reviewer subcall must NOT wedge councilEvaluate.
// ---------------------------------------------------------------------------

describe("H6 -- council reviewer subcall timeout (no infinite hang)", () => {
  it("falls through to the heuristic within the timeout when the injected runner hangs forever", async () => {
    const prev = process.env["LOKI_COUNCIL_TIMEOUT_MS"];
    process.env["LOKI_COUNCIL_TIMEOUT_MS"] = "200";
    const td = mkdtempSync(join(tmpdir(), "loki-w4-h6-"));
    try {
      // A runner that NEVER resolves. Before the fix, dispatchClaudeAgents would
      // await this forever and councilEvaluate would never return.
      let hangCalls = 0;
      const hangingRunner = (_argv: string[]): Promise<{ stdout: string; exitCode: number }> => {
        hangCalls++;
        return new Promise(() => {
          /* never resolves */
        });
      };

      const t0 = Date.now();
      // No injected `voters` -> the --agents dispatch path is attempted with the
      // injected runner; on timeout it must fall through to DEFAULT_VOTERS, which
      // (clean lokiDir) APPROVE -> unanimous -> DA dispatch also hangs+times out
      // -> deterministic DA scan. End result returns without hanging.
      const result = await councilEvaluate(makeCec(td, { claudeRunner: hangingRunner }));
      const elapsed = Date.now() - t0;

      // Two dispatch attempts (base voters + devil's advocate), each bounded by
      // the 200ms timeout. Comfortably under 5s -- the point is it RETURNS.
      expect(elapsed).toBeLessThan(5000);
      // The hanging runner was actually invoked (the dispatch path ran), proving
      // the timeout fired rather than the path being skipped.
      expect(hangCalls).toBeGreaterThanOrEqual(1);
      // The fall-through produced a real aggregate (heuristic voters ran).
      expect(result.votes.length).toBeGreaterThanOrEqual(3);
    } finally {
      if (prev === undefined) delete process.env["LOKI_COUNCIL_TIMEOUT_MS"];
      else process.env["LOKI_COUNCIL_TIMEOUT_MS"] = prev;
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("dispatchClaudeAgents rejects (does not hang) on a hanging runner", async () => {
    const prev = process.env["LOKI_COUNCIL_TIMEOUT_MS"];
    process.env["LOKI_COUNCIL_TIMEOUT_MS"] = "150";
    const td = mkdtempSync(join(tmpdir(), "loki-w4-h6b-"));
    try {
      const mod = await import("../../src/council/voter_agents.ts");
      const hangingRunner = (_argv: string[]): Promise<{ stdout: string; exitCode: number }> =>
        new Promise(() => {});
      const t0 = Date.now();
      let threw = false;
      try {
        await mod.dispatchClaudeAgents(makeCec(td), hangingRunner);
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain("timed out");
      }
      const elapsed = Date.now() - t0;
      expect(threw).toBe(true);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      if (prev === undefined) delete process.env["LOKI_COUNCIL_TIMEOUT_MS"];
      else process.env["LOKI_COUNCIL_TIMEOUT_MS"] = prev;
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("councilTimeoutMs reads the env var at call time and falls back to the default on bad input", async () => {
    const mod = await import("../../src/council/voter_agents.ts");
    const prev = process.env["LOKI_COUNCIL_TIMEOUT_MS"];
    try {
      process.env["LOKI_COUNCIL_TIMEOUT_MS"] = "1234";
      expect(mod.councilTimeoutMs()).toBe(1234);
      process.env["LOKI_COUNCIL_TIMEOUT_MS"] = "not-a-number";
      expect(mod.councilTimeoutMs()).toBe(600000);
      process.env["LOKI_COUNCIL_TIMEOUT_MS"] = "0";
      expect(mod.councilTimeoutMs()).toBe(600000);
      delete process.env["LOKI_COUNCIL_TIMEOUT_MS"];
      expect(mod.councilTimeoutMs()).toBe(600000);
    } finally {
      if (prev === undefined) delete process.env["LOKI_COUNCIL_TIMEOUT_MS"];
      else process.env["LOKI_COUNCIL_TIMEOUT_MS"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// M4 -- corrupt failure ledger must NOT yield COMPLETE.
// ---------------------------------------------------------------------------

describe("M4 -- corrupt failed.json fails toward the safe direction", () => {
  it("heuristic voter returns CANNOT_VALIDATE (not APPROVE) when failed.json is corrupt", async () => {
    const td = mkdtempSync(join(tmpdir(), "loki-w4-m4-"));
    try {
      const queueDir = join(td, "queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "failed.json"), "{ this is not json ][");

      const voter = DEFAULT_VOTERS[0];
      if (!voter) throw new Error("default voter missing");
      const verdict = await voter(makeCec(td));
      expect(verdict.verdict).toBe("CANNOT_VALIDATE");
      expect(verdict.verdict).not.toBe("APPROVE");
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("aggregate decision is NOT COMPLETE when all voters CANNOT_VALIDATE on corrupt failed.json", async () => {
    const td = mkdtempSync(join(tmpdir(), "loki-w4-m4-agg-"));
    try {
      const queueDir = join(td, "queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "failed.json"), "<<<corrupt>>>");

      // Drive the deterministic heuristic voters directly (inject the set) so
      // this asserts the aggregate gate independent of any provider dispatch.
      const result = await councilEvaluate(makeCec(td, { voters: DEFAULT_VOTERS }));
      expect(result.decision).not.toBe("COMPLETE");
      expect(result.decision).toBe("CONTINUE");
      // All three heuristic voters read the same corrupt file -> all CANNOT_VALIDATE.
      expect(result.cannotValidateCount).toBe(3);
      expect(result.approveCount).toBe(0);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("aggregate of all-CANNOT_VALIDATE never reaches the approval threshold", async () => {
    const cv = (role: string) =>
      ({ role, verdict: "CANNOT_VALIDATE" as const, reason: "ledger unreadable", issues: [] });
    const agg = await councilAggregateVotes([cv("a"), cv("b"), cv("c")]);
    expect(agg.decision).toBe("CONTINUE");
    expect(agg.approveCount).toBe(0);
    expect(agg.cannotValidateCount).toBe(3);
  });

  it("devil's-advocate deterministic scan flips a unanimous APPROVE to CONTINUE on corrupt failed.json", async () => {
    // Drive the DA-scan Check 1 catch branch directly: inject 3 APPROVE voters
    // (so the base aggregate is unanimous APPROVE and the DA fires) while
    // failed.json on disk is corrupt. The DA scan must push a HIGH issue and
    // veto -> the flipped aggregate decision is CONTINUE, not COMPLETE.
    const td = mkdtempSync(join(tmpdir(), "loki-w4-da-corrupt-"));
    try {
      const queueDir = join(td, "queue");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, "failed.json"), "}{ corrupt ledger");
      // Also create a passing test log so Check 3 does not independently veto,
      // isolating the corrupt-ledger signal as the cause of the flip.
      const logsDir = join(td, "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(logsDir, "test-run.log"), "all tests passed\n");

      const approveVoters = ["a", "b", "c"].map(
        (role) =>
          async () => ({ role, verdict: "APPROVE" as const, reason: "ok", issues: [] }),
      );
      const result = await councilEvaluate(makeCec(td, { voters: approveVoters }));
      expect(result.decision).toBe("CONTINUE");
      // The appended DA vote is the veto and carries the corrupt-ledger issue.
      const da = result.votes[result.votes.length - 1];
      expect(da?.role).toBe("devils_advocate");
      expect(da?.verdict).toBe("REJECT");
      expect(da?.issues.some((i) => i.description.includes("corrupt failed.json"))).toBe(true);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("missing failed.json still APPROVEs (distinguishes missing from corrupt)", async () => {
    const td = mkdtempSync(join(tmpdir(), "loki-w4-m4-missing-"));
    try {
      // No queue/failed.json at all -> legit no failures -> APPROVE.
      const voter = DEFAULT_VOTERS[0];
      if (!voter) throw new Error("default voter missing");
      const verdict = await voter(makeCec(td));
      expect(verdict.verdict).toBe("APPROVE");
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });
});
