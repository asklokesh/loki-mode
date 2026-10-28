// loki-ts/tests/engine10/plan.test.ts
//
// E-16 wall check (docs/v10/ENGINE.md section 16 / BOARD). Depends on
// machine.ts/session.ts (E-02/E-07) and the repo map (E-04) only through the
// RunContext/SessionRunner/RepoMap shapes, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { MAX_RELEVANT_FILES } from "../../src/engine10/relevant_files.ts";
import { rankRelevant } from "../../src/util/relevance.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlanBrief,
  planStage,
  selectRelevantFiles,
  truncatePlan,
} from "../../src/engine10/stages/plan.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { buildRepoMap } from "../../src/engine10/repomap.ts";
import type { RepoMap } from "../../src/engine10/repomap.ts";
import type {
  RunContext,
  SessionResult,
  SessionRunOptions,
  SessionRunner,
  StageName,
} from "../../src/engine10/types.ts";

class FakeSessionRunner implements SessionRunner {
  lastOpts: SessionRunOptions | null = null;
  constructor(
    private result: SessionResult,
    private onRun?: (opts: SessionRunOptions) => void,
  ) {}
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.lastOpts = opts;
    this.onRun?.(opts);
    return this.result;
  }
}

function fakeCtx(
  runDir: string,
  sessions: SessionRunner,
  outputs: Partial<Record<StageName, Record<string, unknown>>>,
): RunContext {
  return {
    runId: "e10-test-1",
    repoDir: "/tmp/does-not-matter",
    runDir,
    baseSha: "deadbeef",
    branch: "loki/e10-test-1",
    provider: "claude",
    model: "claude-test",
    deep: false,
    capS: 900,
    emit: () => {},
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
  durationS: 0.8,
  killed: false,
};

describe("engine10 plan: relevant-file selection", () => {
  const repoMap: RepoMap = {
    files: ["src/search.ts", "src/util.ts", "README.md"],
    entries: [
      { path: "src/search.ts", symbols: ["searchUsers", "rankResults"] },
      { path: "src/util.ts", symbols: ["formatDate"] },
      { path: "README.md", symbols: [] },
    ],
    truncated: false,
  };

  test("picks files whose path or symbols overlap the task, best score first", () => {
    const files = selectRelevantFiles("add ranking to the search results", repoMap);
    expect(files).toEqual(["src/search.ts"]);
  });

  test("drops files with zero overlap instead of padding the list", () => {
    const files = selectRelevantFiles("fix the date formatter", repoMap);
    expect(files).toEqual(["src/util.ts"]);
  });

  test("caps at the requested max even with many matches", () => {
    const big: RepoMap = {
      files: [],
      entries: Array.from({ length: 20 }, (_, i) => ({ path: `src/widget${i}.ts`, symbols: ["widget"] })),
      truncated: false,
    };
    const files = selectRelevantFiles("build a widget", big, 8);
    expect(files.length).toBe(8);
  });

  test("each pick carries the matched keywords as its reason (P12-42)", () => {
    const picks = rankRelevant("fix the date formatter", repoMap, MAX_RELEVANT_FILES);
    expect(picks.map((p) => p.path)).toEqual(selectRelevantFiles("fix the date formatter", repoMap));
    expect(picks[0]!.reason).toContain("matched:");
    expect(picks[0]!.reason).toContain("date");
  });

  const qmap = (entries: RepoMap["entries"]): RepoMap => ({ files: entries.map((e) => e.path), entries, truncated: false });

  test("TEN-QUALITY-05: exact tokens only, 'add a retry flag' does not select address.py", () => {
    const m = qmap([{ path: "src/address.py", symbols: [] }, { path: "src/retry.py", symbols: [] }]);
    expect(selectRelevantFiles("add a retry flag", m)).toEqual(["src/retry.py"]);
    expect(selectRelevantFiles("handle dress retry", m)).toEqual(["src/retry.py"]); // 'dress' sits inside 'address'
  });

  test("TEN-QUALITY-05: traceback path ranks first ahead of keyword noise", () => {
    const noise = Array.from({ length: 7 }, (_, i) => ({ path: `src/noise${i}.py`, symbols: ["query", "pkg"] }));
    const m = qmap([...noise, { path: "src/pkg/query.py", symbols: [] }]);
    const task = 'query failed\n  File "src/pkg/query.py", line 88, in run\n    pkg query';
    expect(selectRelevantFiles(task, m)[0]).toBe("src/pkg/query.py");
  });

  test("TEN-QUALITY-05: file:line:col and dotted module name a path", () => {
    const m = qmap([{ path: "a/x.ts", symbols: [] }, { path: "a/b.ts", symbols: [] }, { path: "pkg/mod.py", symbols: [] }]);
    expect(selectRelevantFiles("crash at a/b.ts:12:3", m)[0]).toBe("a/b.ts");
    expect(selectRelevantFiles("raised in pkg.mod.Name", m)[0]).toBe("pkg/mod.py");
  });

  test("TEN-QUALITY-05: bulk_create and parseConfig match symbols by token", () => {
    const m = qmap([{ path: "db/a.py", symbols: ["Other"] }, { path: "db/query.py", symbols: ["QuerySet.bulk_create"] }, { path: "cfg/c.py", symbols: ["parse_config"] }]);
    expect(selectRelevantFiles("bulk_create is slow", m)).toEqual(["db/query.py"]);
    expect(selectRelevantFiles("fix parseConfig", m)).toEqual(["cfg/c.py"]);
  });

  describe("TEN-QUALITY-10: named path past the 2000-file repo map cap", () => {
    const mk = (): string => {
      const repo = mkdtempSync(join(tmpdir(), "loki-q10-"));
      mkdirSync(join(repo, "d"), { recursive: true });
      for (let i = 0; i < 2500; i++) writeFileSync(join(repo, "d", `f${String(i).padStart(4, "0")}.py`), `def fn${i}(): pass\n`);
      const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
      g("init", "-q"); g("add", "-A");
      g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
      writeFileSync(join(repo, "d", "untracked_9999.py"), "def u(): pass\n");
      return repo;
    };
    const tb = (p: string) => `Traceback\n  File "${p}", line 3, in run\n    boom`;

    test("tracked file 2400 beyond the cap ranks first; untracked and absent paths are ignored", () => {
      const repo = mk();
      try {
        const map = buildRepoMap(repo);
        expect(map.truncated).toBe(true);
        expect(map.files).not.toContain("d/f2400.py");
        expect(selectRelevantFiles(tb("d/f2400.py"), map, 8, repo)[0]).toBe("d/f2400.py");
        expect(selectRelevantFiles(tb("d/f2400.py"), map)).toEqual([]); // no repoDir: old behavior
        expect(selectRelevantFiles(tb("d/untracked_9999.py"), map, 8, repo)).toEqual([]);
        expect(selectRelevantFiles(tb("d/f9999.py"), map, 8, repo)).toEqual([]);
        expect(selectRelevantFiles(tb("d/f2400.py"), { ...map, truncated: false }, 8, repo)).toEqual([]);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });

    test("planStage passes ctx.repoDir so the real path ranks the beyond-cap file", async () => {
      const repo = mk(), dir = mkdtempSync(join(tmpdir(), "loki-q10r-")), prev = process.env.LOKI_E10_PLAN;
      process.env.LOKI_E10_PLAN = "always";
      try {
        writeFileSync(join(dir, "repomap.json"), JSON.stringify(buildRepoMap(repo)));
        const sessions = new FakeSessionRunner(doneResult, () => writeFileSync(join(dir, "plan-output.txt"), "step", "utf8"));
        const ctx = { ...fakeCtx(dir, sessions, { intake: { task: tb("d/f2400.py"), repomap_ref: join(dir, "repomap.json") } }), repoDir: repo };
        const result = await planStage.run(ctx, new AbortController().signal);
        expect(result.data.relevant_files).toEqual(["d/f2400.py"]);
      } finally {
        if (prev === undefined) delete process.env.LOKI_E10_PLAN; else process.env.LOKI_E10_PLAN = prev;
        rmSync(repo, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("no keyword overlap in the task yields no relevant files", () => {
    expect(selectRelevantFiles("   ", repoMap)).toEqual([]);
  });
});

describe("engine10 plan: output truncation", () => {
  test("a 25-line stub output is truncated to 10", () => {
    const raw = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    const plan = truncatePlan(raw);
    expect(plan.split("\n").length).toBe(10);
    expect(plan.split("\n")[0]).toBe("line 1");
    expect(plan.split("\n")[9]).toBe("line 10");
  });

  test("blank lines are not counted toward the limit", () => {
    const raw = "a\n\n\nb\nc";
    expect(truncatePlan(raw, 2)).toBe("a\nb");
  });

  test("short output passes through unchanged", () => {
    expect(truncatePlan("only one line")).toBe("only one line");
  });
});

describe("engine10 plan brief", () => {
  test("quotes the task and lists relevant files and the output path", () => {
    const brief = buildPlanBrief("fix the bug", ["src/search.ts"], "/run/plan-output.txt");
    expect(brief).toContain("fix the bug");
    expect(brief).toContain("src/search.ts");
    expect(brief).toContain("/run/plan-output.txt");
    expect(brief.toLowerCase()).toContain("at most 10");
  });

  test("recorded assumptions reach the implement brief; none leaves it byte-identical", () => {
    const a = ["\"fast\" taken literally: the smallest change"];
    expect(buildImplementBrief("t", "p", [], "", null, a)).toContain(a[0]!);
    expect(buildImplementBrief("t", "p", [], "", null, [])).toBe(buildImplementBrief("t", "p", []));
  });

  test("recorded assumptions reach the plan brief after the task; none adds nothing", () => {
    const a = ["\"fast\" taken literally: the smallest change"];
    const brief = buildPlanBrief("t", [], "/r/plan-output.txt", undefined, false, false, false, false, a);
    expect(brief).toContain("recorded assumptions");
    expect(brief).toContain(a[0]!);
    expect(buildPlanBrief("t", [], "/r/plan-output.txt", undefined, false, false, false, false, [])).toBe(buildPlanBrief("t", [], "/r/plan-output.txt"));
  });


  test("says so when no relevant files were found", () => {
    const brief = buildPlanBrief("fix the bug", [], "/run/plan-output.txt");
    expect(brief.toLowerCase()).toContain("no relevant files");
  });
});

describe("engine10 plan stage", () => {
  test("reads the session's plan-output.txt, truncates it, and reports relevant_files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e16-"));
    const repomapPath = join(dir, "repomap.json");
    const repoMap: RepoMap = {
      files: ["src/search.ts"],
      entries: [{ path: "src/search.ts", symbols: ["searchUsers"] }],
      truncated: false,
    };
    writeFileSync(repomapPath, JSON.stringify(repoMap));

    const rawPlan = Array.from({ length: 25 }, (_, i) => `step ${i + 1}`).join("\n");
    const sessions = new FakeSessionRunner(doneResult, (opts) => {
      // Simulate the session obeying the brief and writing its plan file.
      const outputPath = join(dir, "plan-output.txt");
      expect(opts.brief).toContain(outputPath);
      writeFileSync(outputPath, rawPlan, "utf8");
    });
    const ctx = fakeCtx(dir, sessions, {
      intake: { task: "add search ranking", repomap_ref: repomapPath },
    });

    const result = await planStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.relevant_files).toEqual(["src/search.ts"]);
    expect((result.data.plan as string).split("\n").length).toBe(10);
    expect(result.data.plan).toContain("step 1");
    expect(result.data.plan).not.toContain("step 11");

    rmSync(dir, { recursive: true, force: true });
  });

  test("the plan session's brief carries the intake assumptions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e16-asm-"));
    let seen = "";
    const sessions = new FakeSessionRunner(doneResult, (opts) => { seen = opts.brief; });
    const ctx = fakeCtx(dir, sessions, { intake: { task: "make it fast, maybe", assumptions: ["\"make it fast\" taken literally: smallest change"] } });
    await planStage.run(ctx, new AbortController().signal);
    expect(seen).toContain("recorded assumptions");
    expect(seen).toContain("taken literally: smallest change");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing plan-output.txt yields an empty plan, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e16-"));
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(dir, sessions, { intake: { task: "fix the bug" } });

    const result = await planStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.plan).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  test("E-61: a non-killed error exit fails the plan stage and writes the stderr tail under runDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e16-err-"));
    const sessions = new FakeSessionRunner({
      exit: 1,
      markers: { done: false, alreadyDone: null, specConflict: null },
      durationS: 1,
      killed: false,
      stderrTail: "plan provider crashed",
    } as SessionResult);
    const ctx = fakeCtx(dir, sessions, { intake: { task: "fix the bug" } });

    const result = await planStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(typeof result.data.stderr_path).toBe("string");
    const stderrPath = result.data.stderr_path as string;
    expect(stderrPath.startsWith(dir)).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("plan provider crashed");
    expect(result.reason).toBe("exit 1 (general error)");

    rmSync(dir, { recursive: true, force: true });
  });

  test("runs the session at fast tier with a unique iteration id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e16-"));
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(dir, sessions, { intake: { task: "fix the bug" } });

    await planStage.run(ctx, new AbortController().signal);

    expect(sessions.lastOpts?.tier).toBe("fast");
    expect(sessions.lastOpts?.iterationId).toBe("e10-test-1-plan");
    expect(sessions.lastOpts?.stage).toBe("plan");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("FC-OUT-OF-REPO: the plan names no in-repo target", () => {
  const run = async (scope: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "loki-oor-"));
    const prev = process.env.LOKI_E10_PLAN; process.env.LOKI_E10_PLAN = "always";
    try {
      const sessions = new FakeSessionRunner(doneResult, () => { if (scope !== null) writeFileSync(join(dir, "plan-scope.json"), scope, "utf8"); });
      return (await planStage.run(fakeCtx(dir, sessions, { intake: { task: "add a Slack command" } }), new AbortController().signal)).data;
    } finally { if (prev === undefined) delete process.env.LOKI_E10_PLAN; else process.env.LOKI_E10_PLAN = prev; rmSync(dir, { recursive: true, force: true }); }
  };
  test("brief asks the planner to declare an out-of-repo change", () => {
    expect(buildPlanBrief("t", [], "/r/plan-output.txt")).toContain("out_of_repo");
  });
  test("empty files with a stated reason flags out_of_repo and carries the reason", async () => {
    const d = await run('{"files":[],"out_of_repo":"the code lives in a hosted service"}');
    expect(d.out_of_repo).toBe(true);
    expect(d.spec_conflict_reason).toBe("out-of-repo: the code lives in a hosted service");
  });
  test("empty files without a reason still flags it with a default reason", async () => {
    expect((await run('{"files":[]}')).spec_conflict_reason).toBe("out-of-repo: the plan named no in-repo target files");
  });
  test("a plan that names real files never fires, even if it also sets out_of_repo", async () => {
    const d = await run('{"files":["src/a.ts"],"out_of_repo":"x"}');
    expect(d.out_of_repo).toBeUndefined(); expect(d.spec_conflict_reason).toBeUndefined();
  });
  test("a missing or malformed scope is unknown, never out-of-repo", async () => {
    expect((await run(null)).out_of_repo).toBeUndefined();
    expect((await run("not json")).out_of_repo).toBeUndefined();
    expect((await run('{"nofiles":1}')).out_of_repo).toBeUndefined();
  });
});
