// loki-ts/tests/engine10/plan.test.ts
//
// E-16 wall check (docs/v10/ENGINE.md section 16 / BOARD). Depends on
// machine.ts/session.ts (E-02/E-07) and the repo map (E-04) only through the
// RunContext/SessionRunner/RepoMap shapes, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlanBrief,
  planStage,
  selectRelevantFiles,
  truncatePlan,
} from "../../src/engine10/stages/plan.ts";
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

  test("a missing plan-output.txt yields an empty plan, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e16-"));
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(dir, sessions, { intake: { task: "fix the bug" } });

    const result = await planStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.plan).toBe("");

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
