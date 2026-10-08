// 11.3.0 T5: --attempts N selection, executed-only counting, tie, receipt losers, cleanup, N=1 identity.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
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
  prs: string[];
  lines: string[];
}

function harness(opts: { noPr?: boolean; prFails?: boolean; checks: Record<number, AttemptCheck[]>; throwOn?: number; wtFailsOn?: string; removeFails?: string; applyThrows?: boolean }): Harness {
  const h: Harness = { deps: undefined as unknown as AttemptDeps, created: [], removed: [], applied: [], receipts: [], direct: { calls: 0 }, prs: [], lines: [] };
  h.deps = {
    repoDir: "/repo",
    receiptDir: "/rcpt",
    baseSha: () => "abc123",
    ...(opts.noPr
      ? {}
      : {
          openPr: (wt: string) => {
            if (opts.prFails) throw new Error("gh not authenticated");
            h.prs.push(wt);
            return "https://example.test/pr/1";
          },
        }),
    print: (l) => void h.lines.push(l),
    createWorktree: (p) => {
      if (opts.wtFailsOn && p.endsWith(opts.wtFailsOn)) throw new Error("disk full");
      h.created.push(p);
    },
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
    expect(r.ran).toBe(3);
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

  it("N attempts run as N (bounded only by 1-5): no usage governor is consulted", async () => {
    const h = harness({ checks: { 1: [pass("a")], 2: [pass("a"), pass("b")], 3: [pass("a")], 4: [pass("a")], 5: [pass("a")] } });
    await runAttempts(5, h.deps);
    expect(h.created.length).toBe(5);
    expect(h.receipts[0]!.ran).toBe(5);
    expect(Object.keys(h.deps)).not.toContain("governorMax");
  });

  it("N=1 is the plain direct engine10 path: no worktree, no receipt", async () => {
    const h = harness({ checks: {} });
    const code = await runAttempts(1, h.deps);
    expect(code).toBe(0);
    expect(h.direct.calls).toBe(1);
    expect(h.created).toEqual([]);
    expect(h.receipts).toEqual([]);
  });

  it("the winner follows normal PR behavior: a PR by default, only for the winner", async () => {
    const h = harness({ checks: { 1: [pass("a")], 2: [pass("a"), pass("b")] } });
    expect(await runAttempts(2, h.deps)).toBe(0);
    expect(h.prs).toEqual(["/c/attempt-2"]);
    expect(h.receipts[0]!.pr).toEqual({ mode: "opened", url: "https://example.test/pr/1" });
    expect(h.lines.join("\n")).toContain("PR:         https://example.test/pr/1");
  });

  it("a worktree that cannot be created is not counted as run, and the degradation line prints", async () => {
    const h = harness({ noPr: true, wtFailsOn: "attempt-2", checks: { 1: [pass("a")], 3: [pass("a"), pass("b")] } });
    expect(await runAttempts(3, h.deps)).toBe(0);
    const r = h.receipts[0]!;
    expect(r.requested).toBe(3);
    expect(r.ran).toBe(2);
    expect(r.setup_failed).toEqual([{ attempt_id: 2, error: "disk full" }]);
    const out = h.lines.join("\n");
    expect(out).toContain("Attempts:   requested 3, ran 2");
    expect(out).toContain("Degraded:   only 2 of 3 attempts ran (attempt 2 worktree failed: disk full)");
  });

  it("--no-pr opens no PR and says so on the receipt and console", async () => {
    const h = harness({ noPr: true, checks: { 1: [pass("a")], 2: [pass("a"), pass("b")] } });
    expect(await runAttempts(2, h.deps)).toBe(0);
    expect(h.prs).toEqual([]);
    expect(h.receipts[0]!.pr.mode).toBe("skipped_no_pr");
    expect(h.lines.join("\n")).toContain("PR:         none (--no-pr)");
  });

  it("a PR that fails to open is loud: FAILED line and a non-zero exit, never a silent no-op", async () => {
    const h = harness({ prFails: true, checks: { 1: [pass("a")], 2: [pass("a"), pass("b")] } });
    expect(await runAttempts(2, h.deps)).toBe(1);
    expect(h.receipts[0]!.pr).toEqual({ mode: "failed", error: "gh not authenticated" });
    expect(h.lines.join("\n")).toContain("PR:         FAILED: gh not authenticated");
  });

  it("console summary prints requested, ran, the winner and why, and the losers", async () => {
    const h = harness({ noPr: true, checks: { 1: [pass("a")], 2: [pass("a"), pass("b")] } });
    await runAttempts(2, h.deps);
    const out = h.lines.join("\n");
    expect(out).toContain("Attempts:   requested 2, ran 2");
    expect(out).toContain("Winner:     attempt 2 with 2 executed passing check(s)");
    expect(out).toContain("Loser:      attempt 1: fewer executed passing checks (1 < 2)");
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
  const sealed = (wt: string, id: string, o: { verdict?: string; signed?: boolean; checks?: unknown[]; forge?: boolean } = {}) => {
    const dir = join(wt, ".loki", "runs", id);
    mkdirSync(dir, { recursive: true });
    const body: Record<string, unknown> = { run_id: id, verdict: o.verdict ?? "VERIFIED", checks: o.checks ?? [{ name: "t", result: "pass" }], verification: {} };
    body["receipt_sha256"] = receiptSha256(body as never);
    if (o.signed !== false) {
      const { jwt, kid } = signReceipt(id, body["receipt_sha256"] as string);
      body["verification"] = { jwt, kid };
    }
    if (o.forge) body["checks"] = [{ name: "x", result: "pass" }];
    writeFileSync(join(dir, "receipt.json"), JSON.stringify(body));
  };
  const withKey = <T>(fn: (wt: string) => Promise<T>) => async () => {
    const wt = mkdtempSync(join(tmpdir(), "loki-attempts-test-"));
    const keyFile = join(wt, "key.pem");
    writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const prev = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    try {
      await fn(wt);
    } finally {
      if (prev === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
      else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = prev;
      rmSync(wt, { recursive: true, force: true });
    }
  };

  it("reads checks from the newest <worktree>/.loki/runs/<runId>/receipt.json when it is signed and verified", withKey(async (wt) => {
    sealed(wt, "r-01", { checks: [{ name: "old", result: "fail" }] });
    sealed(wt, "r-02");
    expect(await readRecordedChecks(wt)).toEqual([{ name: "t", result: "pass" }]);
  }));

  it("B1: a forged unsigned receipt is NOT PROVEN", withKey(async (wt) => {
    sealed(wt, "r-01", { signed: false });
    expect(await readRecordedChecks(wt)).toBeNull();
  }));

  it("B1: a signed receipt edited after sealing is NOT PROVEN", withKey(async (wt) => {
    sealed(wt, "r-01", { forge: true });
    expect(await readRecordedChecks(wt)).toBeNull();
  }));

  it("B1: a BLOCKED verdict is NOT PROVEN even when signed and its checks pass", withKey(async (wt) => {
    sealed(wt, "r-01", { verdict: "BLOCKED" });
    expect(await readRecordedChecks(wt)).toBeNull();
  }));

  it("B2: a newer run dir with no receipt does not fall back to an older receipt", withKey(async (wt) => {
    sealed(wt, "r-01");
    mkdirSync(join(wt, ".loki", "runs", "r-02"), { recursive: true });
    expect(await readRecordedChecks(wt)).toBeNull();
  }));

  it("no receipt is null (NOT PROVEN), a side file is not read", withKey(async (wt) => {
    expect(await readRecordedChecks(wt)).toBeNull();
    mkdirSync(join(wt, ".loki"), { recursive: true });
    writeFileSync(join(wt, ".loki", "verify.json"), JSON.stringify({ checks: [{ name: "t", result: "pass" }] }));
    expect(await readRecordedChecks(wt)).toBeNull();
  }));

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
