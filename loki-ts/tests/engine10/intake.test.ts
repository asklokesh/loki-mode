// loki-ts/tests/engine10/intake.test.ts
//
// E-04 wall check. RunContext deps (sessions/tests/cost/clock) are fakes per
// the slice's contract: machine.ts (E-02) and testmap.ts (E-05) do not exist
// yet on main, and this stage codes against types.ts's interfaces only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitStage } from "../../src/engine10/stages/seal.ts";
import { runIntake } from "../../src/engine10/stages/intake.ts";
import { RealTestMapProvider } from "../../src/engine10/testmap.ts";
import type { CostReader, RunContext, SessionResult, SessionRunner, TestMapProvider } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "intake");

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
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

/** Same as freshRepo, but from a named fixture dir under fixtures/intake/. */
function freshRepoFrom(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-intake-"));
  cpSync(join(FIX, name), dir, { recursive: true });
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

/** A single-call SessionRunner double for the E-66 confirmation session: records the brief it was
 *  given and returns a fixed marker parse (never spawns a real process). */
function fakeConfirmSession(result: Pick<SessionResult, "markers">): { runner: SessionRunner; briefs: string[] } {
  const briefs: string[] = [];
  return {
    briefs,
    runner: {
      async run(opts) {
        briefs.push(opts.brief);
        return { exit: 0, durationS: 0.1, killed: false, ...result };
      },
    },
  };
}

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

  test("E-164: lockfile-only dirt starts the run, is recorded, and is not attributed to the commit", async () => {
    writeFileSync(join(repoDir, "package-lock.json"), "{}\n");
    git(repoDir, ["add", "package-lock.json"]);
    git(repoDir, ["commit", "-q", "-m", "lock"]);
    writeFileSync(join(repoDir, "package-lock.json"), '{"setup":"npm install"}\n');
    const ctx = makeCtx(repoDir, runDir, fakeTests());
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "do a thing" });
    expect(result.status).toBe("completed");
    expect(Object.keys(result.data.preexisting_dirty as object)).toEqual(["package-lock.json"]);
    writeFileSync(join(repoDir, "README.md"), "run change\n");
    const c = await commitStage.run({ ...ctx, baseSha: String(result.data.base_sha), outputs: () => ({ intake: result.data }) } as RunContext, new AbortController().signal);
    expect(c.status).toBe("completed");
    expect(gitOut(repoDir, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("README.md");
    expect(gitOut(repoDir, ["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("M package-lock.json");
  });

  test("E-164: a dirty source file alongside a lockfile still refuses", async () => {
    writeFileSync(join(repoDir, "package-lock.json"), "{}\n");
    git(repoDir, ["add", "package-lock.json"]);
    git(repoDir, ["commit", "-q", "-m", "lock"]);
    writeFileSync(join(repoDir, "package-lock.json"), "{ }\n");
    writeFileSync(join(repoDir, "README.md"), "dirty\n");
    const result = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { taskText: "do a thing" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("README.md");
    expect(result.reason).not.toContain("package-lock.json");
  });

  test("untracked files do not block intake", async () => {
    writeFileSync(join(repoDir, "scratch.txt"), "untracked\n");
    const provider = fakeTests();
    const ctx = makeCtx(repoDir, runDir, provider);
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "do a thing" });
    expect(result.status).toBe("completed");
  });

  test("D65-BUG7: a linked worktree (.git is a file) starts the run and excludes .loki/ in the common git dir", async () => {
    const wt = join(runDir, "linked-wt");
    git(repoDir, ["worktree", "add", "-q", "-b", "ws-branch", wt]);
    const ctx = makeCtx(wt, runDir, fakeTests());
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "add a widget" });
    expect(result.status).toBe("completed");
    const common = gitOut(wt, ["rev-parse", "--git-path", "info/exclude"]).trim();
    expect(readFileSync(resolve(wt, common), "utf8")).toContain(".loki/");
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
    // E-42: what plan, implement, commit and seal read from intake.
    expect(result.data).toMatchObject({ task: "add a widget", title: "add a widget", repo: null, resumed: false });
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
    expect(result.data).toMatchObject({ task: "Still open\n\nnot done yet", title: "Still open" });
  });

  test("repo comes from remote.origin.url: owner/name for GitHub, the path for a local bare origin", async () => {
    git(repoDir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const r1 = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { taskText: "x" });
    expect(r1.data.repo).toBe("acme/widgets");
    git(repoDir, ["remote", "set-url", "origin", "/srv/origin.git"]);
    const r2 = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { taskText: "x" });
    expect(r2.data.repo).toBe("/srv/origin.git");
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

// E-66: "already implemented" as a first-class outcome. A deterministic evidence search (repo map
// symbols, test file names, CHANGELOG headings) gates one short cheap-model confirmation session
// that must cite files; only a confirmed candidate reaches ALREADY_SATISFIED with no PR.
describe("engine10 intake: already-implemented (E-66)", () => {
  const TASK = "Add global search (Cmd+K)";
  const CONFIRMED = "search-command.ts:1 search already implemented, tests/search.test.ts covers it, CHANGELOG.md documents it";

  test("code + test + CHANGELOG evidence, confirmed: no change needed, evidence listed, no repomap/testmap in output", async () => {
    const dir = freshRepoFrom("already-done-repo");
    const confirm = fakeConfirmSession({ markers: { done: false, alreadyDone: CONFIRMED, specConflict: null } });
    const ctx = makeCtx(dir, runDir, new RealTestMapProvider());
    ctx.sessions = confirm.runner;

    const result = await runIntake(ctx, new AbortController().signal, { taskText: TASK });

    expect(result.status).toBe("completed");
    expect(result.data.already_satisfied).toBe(true);
    expect(result.data.evidence).toContain(CONFIRMED);
    expect((result.data.evidence as string[]).some((e) => e.includes("search-command.ts"))).toBe(true);
    expect((result.data.evidence as string[]).some((e) => e.includes("search.test.ts"))).toBe(true);
    expect((result.data.evidence as string[]).some((e) => e.includes("Global Search (Cmd+K)"))).toBe(true);
    // No implement session ever runs from intake alone: this is the only session call.
    expect(confirm.briefs).toHaveLength(1);
    expect(confirm.briefs[0]).toContain("search-command.ts");
    expect(result.data.repomap_ref).toBeUndefined();
    expect(result.data.testmap).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("issue run, confirmed: a comment argv is built (no PR, no push script coupling)", async () => {
    const dir = freshRepoFrom("already-done-repo");
    const confirm = fakeConfirmSession({ markers: { done: false, alreadyDone: CONFIRMED, specConflict: null } });
    const ctx = makeCtx(dir, runDir, new RealTestMapProvider());
    ctx.sessions = confirm.runner;

    const result = await runIntake(ctx, new AbortController().signal, { issueJsonPath: join(FIX, "issue-already-done.json") });

    expect(result.data.already_satisfied).toBe(true);
    expect(result.data.comment_argv).toEqual(["comment", "e10-test-run", "acme/widgets#303", join(runDir, "already-done-comment.md")]);
    expect(readFileSync(join(runDir, "already-done-comment.md"), "utf8")).toContain(CONFIRMED);
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 4: a text run has no issue to comment on, so it gets no comment_argv, but
  // it must still carry the comment body -- main() prints it (supervisor.ts, alreadyDoneTextComment)
  // instead of the decision going unrecorded anywhere the operator can see it.
  test("text run, confirmed: comment body present for main() to print, no argv (no issue to post to)", async () => {
    const dir = freshRepoFrom("already-done-repo");
    const confirm = fakeConfirmSession({ markers: { done: false, alreadyDone: CONFIRMED, specConflict: null } });
    const ctx = makeCtx(dir, runDir, new RealTestMapProvider());
    ctx.sessions = confirm.runner;

    const result = await runIntake(ctx, new AbortController().signal, { taskText: TASK });

    expect(result.data.already_satisfied).toBe(true);
    expect(result.data.comment_argv).toBeUndefined();
    expect(typeof result.data.comment).toBe("string");
    expect(result.data.comment as string).toContain(CONFIRMED);
    expect(readFileSync(join(runDir, "already-done-comment.md"), "utf8")).toContain(CONFIRMED);
    rmSync(dir, { recursive: true, force: true });
  });

  test("candidate evidence but the model does not confirm: proceeds normally, no false positive", async () => {
    const dir = freshRepoFrom("already-done-repo");
    const decline = fakeConfirmSession({ markers: { done: true, alreadyDone: null, specConflict: null } });
    const ctx = makeCtx(dir, runDir, new RealTestMapProvider());
    ctx.sessions = decline.runner;

    const result = await runIntake(ctx, new AbortController().signal, { taskText: TASK });

    expect(decline.briefs).toHaveLength(1); // the deterministic search still ran the confirmation
    expect(result.data.already_satisfied).toBe(false);
    expect(result.data.repomap_ref).toBeDefined();
    expect(result.data.testmap).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a single weak keyword match (one source only) never calls the confirmation session", async () => {
    // "widget" matches the sample repo's repo-map symbol only: one category, below MIN_CATEGORIES.
    const ctx = makeCtx(repoDir, runDir, new RealTestMapProvider());
    ctx.sessions = noLlmSessions;
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "add a widget" });
    expect(result.data.already_satisfied).toBe(false);
  });
});
