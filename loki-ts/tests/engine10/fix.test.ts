import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// loki-ts/tests/engine10/fix.test.ts
//
// E-17 wall check (docs/v10/ENGINE.md section 16): at most 2 rounds, then
// PARTIAL. Depends on E-07/E-09 only through the SessionRunner interface and
// the outputs() shapes those stages produce, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDiff } from "../../src/runner/session_resume.ts";
import { buildFixBrief, fixStage } from "../../src/engine10/stages/fix.ts";
import type { FailureGroup } from "../../src/engine10/failures.ts";
import type {
  EventType,
  RunContext,
  SessionResult,
  SessionRunOptions,
  SessionRunner,
  StageName,
} from "../../src/engine10/types.ts";

class FakeSessionRunner implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private result: SessionResult) {}
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.calls.push(opts);
    return this.result;
  }
}

function fakeCtx(
  sessions: SessionRunner,
  outputs: Partial<Record<StageName, Record<string, unknown>>>,
  emitted: { type: EventType | (string & {}); stage: StageName | null; data: Record<string, unknown> }[] = [],
): RunContext {
  return {
    runId: "e10-test-1",
    repoDir: "/tmp/does-not-matter",
    runDir: "/tmp/does-not-matter/.loki/runs/e10-test-1",
    baseSha: "deadbeef",
    branch: "loki/e10-test-1",
    provider: "claude",
    model: "claude-test",
    deep: false,
    capS: 900,
    emit: (type, stage, data) => emitted.push({ type, stage, data }),
    sessions,
    tests: {
      async detect() {
        return { runners: [], tests: [] };
      },
      impacted() {
        return [];
      },
    },
    cost: {
      read() {
        return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      },
    },
    clock: { now: () => 0 },
    outputs: () => outputs,
  };
}

const doneResult: SessionResult = {
  exit: 0,
  markers: { done: true, alreadyDone: null, specConflict: null },
  durationS: 1.2,
  killed: false,
};

const groups: FailureGroup[] = [
  { signature: "AssertionError: expected # to equal #", count: 2, sample: "AssertionError: expected 1 to equal 2" },
];

describe("buildFixBrief", () => {
  test("carries the task, plan, impacted tests, the grouped failures and the diff stat", () => {
    const brief = buildFixBrief(
      "fix the bug",
      "1. patch X",
      ["tests/x.test.ts"],
      groups,
      "1 file changed, +3 -1",
    );
    expect(brief).toContain("fix the bug");
    expect(brief).toContain("1. patch X");
    expect(brief).toContain("tests/x.test.ts");
    expect(brief.toLowerCase()).toContain("read-only");
    expect(brief).toContain("Fast verify run failed");
    expect(brief).toContain("First failure signature (the harness found this");
    expect(brief.indexOf("First failure signature")).toBeLessThan(brief.indexOf("1. (2x)"));
    expect(brief).toContain("AssertionError: expected # to equal #");
    expect(brief).toContain("AssertionError: expected 1 to equal 2");
    expect(brief).toContain("1 file changed, +3 -1");
  });

  test("says so plainly when no groups were fed", () => {
    const brief = buildFixBrief("fix it", null, [], [], null);
    expect(brief).toContain("no grouped failures were provided");
  });

  test("says so plainly when the diff stat is not available", () => {
    const brief = buildFixBrief("fix it", null, [], [], null);
    expect(brief.toLowerCase()).toContain("diff stat is not available");
  });
});

describe("fix stage", () => {
  test("round 1: runs a session, feeds the grouped failures, emits fix.round", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const emitted: { type: EventType | (string & {}); stage: StageName | null; data: Record<string, unknown> }[] = [];
    const ctx = fakeCtx(
      sessions,
      {
        intake: { task: "fix the bug", impacted_tests: ["tests/x.test.ts"] },
        verify: { failures_grouped: groups },
      },
      emitted,
    );

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.round).toBe(1);
    expect(result.data.groups_fed).toBe(1);
    expect(sessions.calls).toHaveLength(1);
    expect(sessions.calls[0]!.brief).toContain("AssertionError: expected 1 to equal 2");
    expect(sessions.calls[0]!.iterationId).toBe("e10-test-1-fix1");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "fix.round", stage: "fix" });
    expect(emitted[0]!.data.round).toBe(1);
  });

  test("round 2: reads the prior round from ctx.outputs().fix and increments", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, { fix: { round: 1 }, verify: { failures_grouped: groups } });

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.round).toBe(2);
    expect(sessions.calls[0]!.iterationId).toBe("e10-test-1-fix2");
  });

  test("a third round is refused: no session call, status skipped", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, { fix: { round: 2 }, verify: { failures_grouped: groups } });

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("fix rounds exhausted");
    expect(sessions.calls).toHaveLength(0);
  });

  test("a killed session is reported but the round still completes", async () => {
    const sessions = new FakeSessionRunner({
      exit: null,
      markers: { done: false, alreadyDone: null, specConflict: null },
      durationS: 180,
      killed: true,
    });
    const ctx = fakeCtx(sessions, {});

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.killed).toBe(true);
  });

  test("with no verify output yet, feeds an empty group list rather than throwing", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, {});

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.groups_fed).toBe(0);
  });

  test("with no implement output yet, diff_stat is null, not an empty string", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, {});

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.data.diff_stat).toBeNull();
  });
});

describe("fix brief sees the current diff (TEN-QUALITY-07)", () => {
  const vcs = (d: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, stdio: "pipe" }).toString().trim();
  function repo(): { d: string; base: string } {
    const d = mkdtempSync(join(tmpdir(), "q07-"));
    vcs(d, "init", "-q");
    writeFileSync(join(d, "a.ts"), "export function add(a: number, b: number) {\n  return 0;\n}\n");
    vcs(d, "add", "a.ts");
    vcs(d, "commit", "-qm", "base");
    const base = vcs(d, "rev-parse", "HEAD");
    writeFileSync(join(d, "a.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    return { d, base };
  }
  const withRepo = async (fn: (d: string, base: string) => Promise<void> | void) => {
    const { d, base } = repo();
    try { await fn(d, base); } finally { rmSync(d, { recursive: true, force: true }); }
  };
  const ctxAt = (d: string, base: string, s: SessionRunner, outputs: Partial<Record<StageName, Record<string, unknown>>>) => ({ ...fakeCtx(s, outputs), repoDir: d, baseSha: base });

  test("round 1 brief carries the stat, not the unavailable note", () => withRepo(async (d, base) => {
    const s = new FakeSessionRunner(doneResult);
    await fixStage.run(ctxAt(d, base, s, { verify: { failures_grouped: groups } }), new AbortController().signal);
    expect(s.calls[0]!.brief).toContain("1 file changed");
    expect(s.calls[0]!.brief).not.toContain("(diff stat is not available)");
  }));

  test("round 2 brief carries the bounded hunks", () => withRepo(async (d, base) => {
    const s = new FakeSessionRunner(doneResult);
    await fixStage.run(ctxAt(d, base, s, { verify: { failures_grouped: groups }, fix: { round: 1 } }), new AbortController().signal);
    expect(s.calls[0]!.brief).toContain("+  return a + b;");
  }));

  test("a file under .loki/ never appears; untracked files are listed by name", () => withRepo((d, base) => {
    mkdirSync(join(d, ".loki"));
    writeFileSync(join(d, ".loki", "secret.json"), "x");
    writeFileSync(join(d, "new.ts"), "export const n = 1;\n");
    const out = currentDiff(d, base, 6000, true)!;
    expect(out).not.toContain(".loki");
    expect(out).toContain("new.ts");
  }));

  test("a 50 KB diff is cut to 6000 bytes with the truncation note", () => withRepo((d, base) => {
    writeFileSync(join(d, "a.ts"), Array.from({ length: 3000 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const out = currentDiff(d, base, 6000, true)!;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(6000);
    expect(out).toContain("[diff truncated");
  }));

  // FC-FIX-CONFLICT-STALLED: the implement rule (one correction resume, then believed), plus evidence: the tree must be unchanged.
  const conflictResult: SessionResult = { exit: 0, markers: { done: false, alreadyDone: null, specConflict: "needs a hosted service" }, durationS: 1, killed: false };
  test("a confirmed spec conflict with an unchanged tree reports exit spec_conflict after one correction resume", () => withRepo(async (d, base) => {
    const s = new FakeSessionRunner(conflictResult);
    const r = await fixStage.run(ctxAt(d, base, s, { verify: { failures_grouped: groups } }), new AbortController().signal);
    expect(s.calls).toHaveLength(2);
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe("needs a hosted service");
  }));

  test("a conflict claim from a round that edited the tree is not believed", () => withRepo(async (d, base) => {
    const s = new FakeSessionRunner(conflictResult);
    const run = s.run.bind(s);
    s.run = async (o) => { writeFileSync(join(d, "edit.ts"), `export const n = ${s.calls.length};\n`); return run(o); };
    const r = await fixStage.run(ctxAt(d, base, s, { verify: { failures_grouped: groups } }), new AbortController().signal);
    expect(r.data.exit).toBeUndefined();
  }));

  test("a non-repo directory returns null", () => {
    expect(currentDiff("/tmp/does-not-matter", "deadbeef")).toBeNull();
  });
});

describe("TEN-QUALITY-01 fix brief carries a failure excerpt", () => {
  test("verify then fix on a failing pytest: the fix brief has the assertion line", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "e10-fixex-"));
    try {
      const g = (a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repoDir, encoding: "utf8" });
      mkdirSync(join(repoDir, "tests"));
      writeFileSync(join(repoDir, "calc.py"), "def add(a, b):\n    return a + b\n");
      writeFileSync(join(repoDir, "tests", "test_calc.py"), "import sys, os\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom calc import add\n\ndef test_add():\n    assert add(2, 2) == 5\n");
      writeFileSync(join(repoDir, ".gitignore"), ".loki\n__pycache__\n.pytest_cache\n");
      g(["init", "-q"]); g(["add", "."]); g(["commit", "-qm", "base"]);
      const base = g(["rev-parse", "HEAD"]).trim();
      writeFileSync(join(repoDir, "calc.py"), "def add(a, b):\n    return a + b  # attempted\n");
      g(["commit", "-qam", "attempt"]);
      const runDir = join(repoDir, ".loki", "runs", "e10-fixex");
      mkdirSync(runDir, { recursive: true });
      const emitted: { type: string; stage: StageName | null; data: Record<string, unknown> }[] = [];
      const sessions = new FakeSessionRunner(doneResult);
      const tests = [{ runner: "pytest", path: "tests/test_calc.py" }];
      const ctx = {
        ...fakeCtx(sessions, { intake: { task: "fix add", impacted_tests: ["tests/test_calc.py"] } }, emitted),
        repoDir, runDir, baseSha: base,
        tests: { async detect() { return { runners: ["pytest"], tests }; }, impacted: () => tests },
      } as unknown as RunContext;
      const { verifyStage } = await import("../../src/engine10/stages/verify.ts");
      const v = await verifyStage.run(ctx, new AbortController().signal);
      const grouped = v.data.failures_grouped as FailureGroup[];
      expect(grouped.length).toBeGreaterThan(0);
      expect(JSON.stringify(v.data.checks)).not.toContain("assert 4 == 5"); // never on VerifyCheck
      expect(JSON.stringify(emitted)).not.toContain("assert 4 == 5"); // never in test.result
      const fctx = fakeCtx(sessions, { intake: { task: "fix add", impacted_tests: [] }, verify: { failures_grouped: grouped } });
      await fixStage.run(fctx, new AbortController().signal);
      const brief = sessions.calls[0]!.brief;
      expect(brief).toContain("E       assert 4 == 5");
      expect(brief).toContain("pytest"); // the rerun cmd leads the group
      expect(brief).not.toContain(repoDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("TEN-QUALITY-01 r2 verify-level excerpt guards", () => {
  async function verifyRepo(tag: string, files: Record<string, string>, extra?: (ctxBase: string) => void) {
    const repoDir = mkdtempSync(join(tmpdir(), `e10-${tag}-`));
    const g = (a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repoDir, encoding: "utf8" });
    mkdirSync(join(repoDir, "tests"));
    writeFileSync(join(repoDir, ".gitignore"), ".loki\n__pycache__\n.pytest_cache\n");
    writeFileSync(join(repoDir, "a.py"), "x = 1\n");
    g(["init", "-q"]); g(["add", "."]); g(["commit", "-qm", "base"]);
    const base = g(["rev-parse", "HEAD"]).trim();
    for (const [n, c] of Object.entries(files)) writeFileSync(join(repoDir, "tests", n), c);
    writeFileSync(join(repoDir, "a.py"), "x = 2\n");
    g(["add", "."]); g(["commit", "-qm", "attempt"]);
    extra?.(base);
    const runDir = join(repoDir, ".loki", "runs", tag);
    mkdirSync(runDir, { recursive: true });
    const tests = Object.keys(files).map((n) => ({ runner: "pytest", path: `tests/${n}` }));
    const ctx = {
      ...fakeCtx(new FakeSessionRunner(doneResult), { intake: { task: "t", impacted_tests: tests.map((t) => t.path) } }, []),
      repoDir, runDir, baseSha: base,
      tests: { async detect() { return { runners: ["pytest"], tests }; }, impacted: () => tests },
    } as unknown as RunContext;
    const { verifyStage } = await import("../../src/engine10/stages/verify.ts");
    const v = await verifyStage.run(ctx, new AbortController().signal);
    return { repoDir, grouped: v.data.failures_grouped as FailureGroup[] };
  }

  test("6 KB total cap is byte-exact for multibyte output: no U+FFFD, no lone surrogate", async () => {
    const body = (i: number): string => `def test_m${i}():\n    for k in range(60):\n        print("Expected: " + "\u6f22\U0001F600" * 30 + str(k))\n    assert False\n`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`test_m${i}.py`] = body(i);
    const { repoDir, grouped } = await verifyRepo("mbcap", files);
    try {
      expect(grouped.length).toBeGreaterThanOrEqual(5);
      let sum = 0;
      for (const f of grouped) {
        const x = f.sample.includes("\n") ? f.sample.slice(f.sample.indexOf("\n") + 1) : "";
        sum += Buffer.byteLength(x);
        expect(x).not.toContain("\uFFFD");
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x)).toBe(false);
      }
      expect(sum).toBeGreaterThan(0);
      expect(sum).toBeLessThanOrEqual(6144);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  }, 120_000);

  test("signature is stable across runs differing only in a duration line and never contains the excerpt", async () => {
    const mk = (n: number): string => `import time\n\ndef test_s():\n    print("Expected: ZEBRA_MARK")\n    print("took ${"${"}time.time()}s")\n    time.sleep(${n})\n    assert False\n`;
    const a = await verifyRepo("sig1", { "test_s.py": mk(0) });
    const b = await verifyRepo("sig2", { "test_s.py": mk(1) });
    try {
      expect(a.grouped.length).toBe(1);
      expect(a.grouped[0]!.sample).toContain("ZEBRA_MARK");
      expect(a.grouped[0]!.signature).toBe(b.grouped[0]!.signature);
      expect(a.grouped[0]!.signature).not.toContain("ZEBRA_MARK");
    } finally { rmSync(a.repoDir, { recursive: true, force: true }); rmSync(b.repoDir, { recursive: true, force: true }); }
  }, 120_000);
});
