// loki-ts/tests/engine10/intake.test.ts
//
// E-04 wall check. RunContext deps (sessions/tests/cost/clock) are fakes per
// the slice's contract: machine.ts (E-02) and testmap.ts (E-05) do not exist
// yet on main, and this stage codes against types.ts's interfaces only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntake } from "../../src/engine10/stages/intake.ts";
import type { CostReader, RunContext, SessionRunner, TestMapProvider } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "intake");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Copies the sample repo into a fresh temp dir and git-initializes it there,
 *  so the checked-in fixture is never mutated by branch/exclude/commit. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-intake-"));
  cpSync(join(FIX, "sample-repo"), dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

/** A SessionRunner that fails the test if Intake ever calls it: Intake must
 *  never run an LLM session. */
const noLlmSessions: SessionRunner = {
  run() {
    throw new Error("intake must never start a provider session");
  },
};

const fakeCost: CostReader = { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) };

function fakeTests(runners: string[] = ["pytest"]): TestMapProvider {
  return {
    detect: async () => ({ runners: runners as never, tests: [] }),
    impacted: () => [],
  };
}

function makeCtx(repoDir: string, runDir: string, tests: TestMapProvider): RunContext {
  return {
    runId: "e10-test-run",
    repoDir,
    runDir,
    baseSha: "",
    branch: "loki/e10-test-run",
    provider: "claude",
    model: "test-model",
    deep: false,
    capS: 900,
    emit: () => {},
    sessions: noLlmSessions,
    tests,
    cost: fakeCost,
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
}

let repoDir: string;
let runDir: string;

beforeEach(() => {
  repoDir = freshRepo();
  runDir = mkdtempSync(join(tmpdir(), "e10-intake-rundir-"));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

describe("engine10 intake", () => {
  test("dirty tracked tree is refused, no LLM call", async () => {
    writeFileSync(join(repoDir, "README.md"), "dirty\n");
    const provider = fakeTests();
    const ctx = makeCtx(repoDir, runDir, provider);
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "do a thing" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("dirty");
  });

  test("untracked files do not block intake", async () => {
    writeFileSync(join(repoDir, "scratch.txt"), "untracked\n");
    const provider = fakeTests();
    const ctx = makeCtx(repoDir, runDir, provider);
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "do a thing" });
    expect(result.status).toBe("completed");
  });

  test("clean repo with literal task text: creates the branch, excludes .loki/, builds maps", async () => {
    const provider = fakeTests(["pytest", "vitest"]);
    const ctx = makeCtx(repoDir, runDir, provider);
    const start = Date.now();
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "add a widget" });
    const elapsedS = (Date.now() - start) / 1000;

    expect(result.status).toBe("completed");
    expect(result.data.source).toBe("text");
    expect(result.data.already_satisfied).toBe(false);
    expect(typeof result.data.base_sha).toBe("string");
    expect(result.data.task_sha256).toHaveLength(64);
    expect(elapsedS).toBeLessThan(15);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    expect(branch).toBe("loki/e10-test-run");

    const exclude = readFileSync(join(repoDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".loki/");

    const repomap = JSON.parse(readFileSync(result.data.repomap_ref as string, "utf8"));
    expect(repomap.files).toContain("src/util.ts");
    expect(repomap.entries.some((e: { symbols: string[] }) => e.symbols.includes("widget"))).toBe(true);

    expect(result.data.testmap).toEqual({ runners: ["pytest", "vitest"], tests: [] });
  });

  test("a closed-issue fixture gives ALREADY_SATISFIED, no LLM call, no test-map build", async () => {
    const provider = fakeTests();
    let detectCalls = 0;
    const spied: TestMapProvider = { ...provider, detect: async (d) => { detectCalls++; return provider.detect(d); } };
    const ctx = makeCtx(repoDir, runDir, spied);
    const issuePath = join(FIX, "issue-closed.json");

    const result = await runIntake(ctx, new AbortController().signal, { issueJsonPath: issuePath });

    expect(result.status).toBe("completed");
    expect(result.data.already_satisfied).toBe(true);
    expect(result.data.source).toBe("issue");
    expect(detectCalls).toBe(0); // no test map needed once already-done
  });

  test("an issue closed by a merged PR (still 'open' state) also gives ALREADY_SATISFIED", async () => {
    const provider = fakeTests();
    const ctx = makeCtx(repoDir, runDir, provider);
    const result = await runIntake(ctx, new AbortController().signal, { issueJsonPath: join(FIX, "issue-merged-pr.json") });
    expect(result.data.already_satisfied).toBe(true);
  });

  test("an open, unmerged issue is not already-done", async () => {
    const provider = fakeTests();
    const ctx = makeCtx(repoDir, runDir, provider);
    const result = await runIntake(ctx, new AbortController().signal, { issueJsonPath: join(FIX, "issue-open.json") });
    expect(result.data.already_satisfied).toBe(false);
    expect(result.data.source).toBe("issue");
  });

  test("an already-aborted signal fails before touching git", async () => {
    const provider = fakeTests();
    const ctx = makeCtx(repoDir, runDir, provider);
    const controller = new AbortController();
    controller.abort();
    const result = await runIntake(ctx, controller.signal, { taskText: "x" });
    expect(result.status).toBe("failed");
  });
});
