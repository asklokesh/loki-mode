// 11.3.0 T5: --attempts N selection, executed-only counting, tie, receipt losers, cleanup, N=1 identity.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecordedChecks, runAttempts, selectWinner, countChecks, type AttemptCheck, type AttemptDeps, type AttemptOutcome, type AttemptsReceipt } from "../../src/runner/attempts.ts";
import { parseStartArgs } from "../../src/commands/start.ts";

const pass = (name: string, n = 3): AttemptCheck => ({ name, result: "pass", n });
const fail = (name: string): AttemptCheck => ({ name, result: "fail", n: 2 });

interface Harness {
  deps: AttemptDeps;
  created: string[];
  removed: string[];
  applied: string[];
  receipts: AttemptsReceipt[];
  direct: { calls: number };
}

function harness(opts: { gov?: number | null; checks: Record<number, AttemptCheck[]>; throwOn?: number; removeFails?: string; applyThrows?: boolean }): Harness {
  const h: Harness = { deps: undefined as unknown as AttemptDeps, created: [], removed: [], applied: [], receipts: [], direct: { calls: 0 } };
  h.deps = {
    repoDir: "/repo",
    receiptDir: "/rcpt",
    baseSha: () => "abc123",
    governorMax: () => (opts.gov === undefined ? 8 : opts.gov),
    createWorktree: (p) => void h.created.push(p),
    removeWorktree: (p) => {
      if (opts.removeFails && p.endsWith(opts.removeFails)) throw new Error("busy");
      h.removed.push(p);
    },
    runAttempt: async (id, wt): Promise<AttemptOutcome> => {
      if (opts.throwOn === id) throw new Error("provider crashed");
      return { id, exit: 0, checks: opts.checks[id] ?? [] };
    },
    applyWinner: (wt) => {
      if (opts.applyThrows) throw new Error("patch conflict");
      h.applied.push(wt);
    },
    makeContainer: () => "/c",
    removeContainer: () => {},
    writeReceipt: (_d, r) => {
      h.receipts.push(r);
      return "/rcpt/attempts-receipt.json";
    },
    runDirect: async () => {
      h.direct.calls++;
      return 0;
    },
  };
  return h;
}

describe("attempt counting", () => {
  it("counts only executed passes; not_run, flaky and n=0 passes never count", () => {
    const c = countChecks([pass("a"), { name: "b", result: "not_run" }, { name: "c", result: "pass", n: 0 }, { name: "d", result: "flaky", n: 2 }, fail("e")]);
    expect(c).toEqual({ passing: 1, failing: 1 });
  });
});

describe("selectWinner", () => {
  it("picks the attempt with the most executed passing checks", () => {
    const s = selectWinner([
      { id: 1, exit: 0, checks: [pass("a")] },
      { id: 2, exit: 0, checks: [pass("a"), pass("b"), fail("c")] },
      { id: 3, exit: 0, checks: [pass("a"), pass("b"), pass("c")].slice(0, 1) },
    ]);
    expect(s.winner).toEqual({ attempt_id: 2, executed_passing: 2, executed_failing: 1, tie: false });
    expect(s.losers.map((l) => l.attempt_id)).toEqual([1, 3]);
    expect(s.losers[0]!.why_lost).toContain("fewer executed passing checks (1 < 2)");
    expect(s.losers[1]!.why_lost).toContain("fewer executed passing checks (1 < 2)");
  });

  it("skipped checks do not make an attempt win", () => {
    const s = selectWinner([
      { id: 1, exit: 0, checks: [pass("a")] },
      { id: 2, exit: 0, checks: [{ name: "a", result: "not_run" }, { name: "b", result: "not_run" }, { name: "c", result: "pass", n: 0 }] },
    ]);
    expect(s.winner!.attempt_id).toBe(1);
    expect(s.losers[0]).toMatchObject({ attempt_id: 2, executed_passing: 0 });
  });

  it("a tie goes to the lowest attempt id and is stated as a tie", () => {
    const s = selectWinner([
      { id: 2, exit: 0, checks: [pass("a")] },
      { id: 1, exit: 0, checks: [pass("a")] },
    ]);
    expect(s.winner).toMatchObject({ attempt_id: 1, tie: true });
    expect(s.losers[0]!.why_lost).toContain("lowest attempt id (1) wins the tie");
  });

  it("no executed pass anywhere means no winner", () => {
    const s = selectWinner([{ id: 1, exit: 1, checks: [fail("a")] }, { id: 2, exit: 1, checks: [] }]);
    expect(s.winner).toBeNull();
    expect(s.no_winner_reason).toContain("nothing was applied");
  });
});

describe("runAttempts", () => {
  it("runs N attempts, applies the winner, records every loser, removes every worktree", async () => {
    const h = harness({ checks: { 1: [pass("a")], 2: [pass("a"), pass("b")], 3: [fail("a")] } });
    const code = await runAttempts(3, h.deps);
    expect(code).toBe(0);
    expect(h.created).toEqual(["/c/attempt-1", "/c/attempt-2", "/c/attempt-3"]);
    expect(h.applied).toEqual(["/c/attempt-2"]);
    expect(h.removed.sort()).toEqual(h.created);
    const r = h.receipts[0]!;
    expect(r.winner).toMatchObject({ attempt_id: 2, executed_passing: 2, tie: false });
    expect(r.losers.map((l) => [l.attempt_id, l.executed_passing, l.executed_failing])).toEqual([[1, 1, 0], [3, 0, 1]]);
    expect(r.governor.state).toBe("ok");
    expect(r.applied).toBe(true);
  });

  it("a crashed attempt is recorded as a loser and cannot win", async () => {
    const h = harness({ checks: { 1: [pass("a")], 2: [pass("a"), pass("b")] }, throwOn: 2 });
    await runAttempts(2, h.deps);
    const r = h.receipts[0]!;
    expect(r.winner!.attempt_id).toBe(1);
    expect(r.losers[0]!.why_lost).toContain("attempt errored: provider crashed");
  });

  it("removes worktrees on the failure path (apply throws) and still writes the receipt", async () => {
    const h = harness({ checks: { 1: [pass("a")], 2: [pass("a")] }, applyThrows: true });
    await expect(runAttempts(2, h.deps)).rejects.toThrow("patch conflict");
    expect(h.removed.sort()).toEqual(h.created);
    expect(h.receipts[0]!.applied).toBe(false);
    expect(h.receipts[0]!.no_winner_reason).toContain("apply failed");
  });

  it("a worktree that fails to remove is recorded and fails the run", async () => {
    const h = harness({ checks: { 1: [pass("a")], 2: [pass("a")] }, removeFails: "attempt-2" });
    const code = await runAttempts(2, h.deps);
    expect(code).toBe(1);
    expect(h.removed).toEqual(["/c/attempt-1"]);
    expect(h.receipts[0]!.cleanup.find((c) => !c.removed)).toMatchObject({ path: "/c/attempt-2", error: "busy" });
  });

  it("governor hold runs fewer attempts and records it", async () => {
    const h = harness({ gov: 2, checks: { 1: [pass("a")], 2: [pass("a"), pass("b")], 3: [pass("a"), pass("b"), pass("c")] } });
    await runAttempts(4, h.deps);
    expect(h.created.length).toBe(2);
    const r = h.receipts[0]!;
    expect(r.requested).toBe(4);
    expect(r.ran).toBe(2);
    expect(r.governor.state).toBe("hold");
    expect(r.governor.note).toContain("ran 2");
  });

  it("unknown governor falls back to one direct attempt, recorded", async () => {
    const h = harness({ gov: null, checks: {} });
    const code = await runAttempts(3, h.deps);
    expect(code).toBe(0);
    expect(h.direct.calls).toBe(1);
    expect(h.created).toEqual([]);
    expect(h.receipts[0]!.governor.state).toBe("hold");
  });

  it("N=1 is the unchanged direct path: no worktree, no governor read, no receipt", async () => {
    const h = harness({ checks: {} });
    let govCalls = 0;
    h.deps.governorMax = () => {
      govCalls++;
      return 8;
    };
    const code = await runAttempts(1, h.deps);
    expect(code).toBe(0);
    expect(h.direct.calls).toBe(1);
    expect(govCalls).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.receipts).toEqual([]);
  });
});

describe("--attempts flag parsing", () => {
  const run = (args: string[]) => {
    const errs: string[] = [];
    const r = parseStartArgs(args, (s) => void errs.push(s), () => {}, () => {});
    return { r, errs };
  };
  it("accepts 1-5", () => {
    expect((run(["./p.md", "--attempts", "3"]).r as { attempts: number }).attempts).toBe(3);
    expect((run(["./p.md", "--attempts=5"]).r as { attempts: number }).attempts).toBe(5);
  });
  it("rejects 0, 6 and non-numbers", () => {
    for (const v of ["0", "6", "x", "2.5"]) expect(run(["./p.md", "--attempts", v]).r).toBe(2);
  });
  it("absent flag leaves the parsed opts byte-identical (no attempts key)", () => {
    const { r } = run(["./p.md"]);
    expect(Object.keys(r as object)).not.toContain("attempts");
  });
});

describe("receipt-path read and NOT PROVEN", () => {
  it("reads checks from <worktree>/.loki/runs/<runId>/receipt.json (the path seal.ts writes), latest run wins", () => {
    const wt = mkdtempSync(join(tmpdir(), "loki-attempts-test-"));
    try {
      for (const [id, checks] of [["r-01", [{ name: "old", result: "fail" }]], ["r-02", [{ name: "t", result: "pass" }]]] as const) {
        mkdirSync(join(wt, ".loki", "runs", id), { recursive: true });
        writeFileSync(join(wt, ".loki", "runs", id, "receipt.json"), JSON.stringify({ checks }));
      }
      expect(readRecordedChecks(wt)).toEqual([{ name: "t", result: "pass" }]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("no receipt is null (NOT PROVEN), a side file is not read", () => {
    const wt = mkdtempSync(join(tmpdir(), "loki-attempts-test-"));
    try {
      expect(readRecordedChecks(wt)).toBeNull();
      mkdirSync(join(wt, ".loki"), { recursive: true });
      writeFileSync(join(wt, ".loki", "verify.json"), JSON.stringify({ checks: [{ name: "t", result: "pass" }] }));
      expect(readRecordedChecks(wt)).toBeNull();
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("an attempt without a receipt loses as NOT PROVEN to one with a receipt, even at 0 passes", () => {
    const s = selectWinner([{ id: 1, exit: 0, checks: null }, { id: 2, exit: 0, checks: [pass("a")] }]);
    expect(s.winner!.attempt_id).toBe(2);
    expect(s.losers[0]!.why_lost).toContain("NOT PROVEN");
  });

  it("no attempt with a receipt is BLOCKED, nothing applied, exit 1", async () => {
    const h = harness({ checks: {} });
    h.deps.runAttempt = async (id) => ({ id, exit: 0, checks: null });
    const code = await runAttempts(2, h.deps);
    expect(code).toBe(1);
    expect(h.applied).toEqual([]);
    expect(h.receipts[0]!.no_winner_reason).toContain("BLOCKED");
    expect(h.removed.sort()).toEqual(h.created);
  });
});
