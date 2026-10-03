// loki-ts/tests/engine10/intake.test.ts
//
// E-04 wall check. RunContext deps (sessions/tests/cost/clock) are fakes per
// the slice's contract: machine.ts (E-02) and testmap.ts (E-05) do not exist
// yet on main, and this stage codes against types.ts's interfaces only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  // The inline check pins LOKI_SPEED=0; the deferred (speed-on) path has its own tests (already_done_async).
  let prevSpeed: string | undefined;
  beforeAll(() => { prevSpeed = process.env.LOKI_SPEED; process.env.LOKI_SPEED = "0"; });
  afterAll(() => { if (prevSpeed === undefined) delete process.env.LOKI_SPEED; else process.env.LOKI_SPEED = prevSpeed; });
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

// D65-SPEC-F2: intake freezes .loki/contract.json; the wiring itself (not just the seal side) is tested here.
describe("engine10 intake: contract snapshot (D65-SPEC-F2)", () => {
  let repoDir: string;
  let runDir: string;
  let prev: string | undefined;
  const CONTRACT = JSON.stringify({ source: "s", criteria: [{ id: "AC-1", text: "export csv files", source_line: 1 }] }, null, 2) + "\n";
  const want = createHash("sha256").update(CONTRACT).digest("hex");
  const snapOf = (d: Record<string, unknown>) => d.contract_snapshot as { sha256: string | null; contract: { criteria: unknown[] } | null } | undefined;
  beforeEach(() => {
    prev = process.env["LOKI_CONTRACT"];
    delete process.env["LOKI_CONTRACT"];
    repoDir = freshRepo();
    runDir = mkdtempSync(join(tmpdir(), "e10-intake-run-"));
    mkdirSync(join(repoDir, ".loki"), { recursive: true });
    writeFileSync(join(repoDir, ".loki", "contract.json"), CONTRACT);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env["LOKI_CONTRACT"]; else process.env["LOKI_CONTRACT"] = prev;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  });
  test("normal path records the sha256 of the file bytes and the parsed contract", async () => {
    const result = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { taskText: "add a widget" });
    expect(result.status).toBe("completed");
    expect(result.data.already_satisfied).toBe(false);
    expect(snapOf(result.data)?.sha256).toBe(want);
    expect(snapOf(result.data)?.contract?.criteria).toHaveLength(1);
  });
  test("already_satisfied early return records it too", async () => {
    const result = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { issueJsonPath: join(FIX, "issue-closed.json") });
    expect(result.data.already_satisfied).toBe(true);
    expect(snapOf(result.data)?.sha256).toBe(want);
  });
  test("LOKI_CONTRACT=0 records no snapshot on either path", async () => {
    process.env["LOKI_CONTRACT"] = "0";
    const a = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { taskText: "add a widget" });
    expect(a.data.contract_snapshot).toBeUndefined();
    const b = await runIntake(makeCtx(repoDir, runDir, fakeTests()), new AbortController().signal, { issueJsonPath: join(FIX, "issue-closed.json") });
    expect(b.data.already_satisfied).toBe(true);
    expect(b.data.contract_snapshot).toBeUndefined();
  });
});

// FC-15: a run must never judge "already done" against Loki's own unmerged branch (FireLater#17).
describe("engine10 intake: base is not Loki's unmerged work (FC-15)", () => {
  let prevSpeed: string | undefined; let prevFetch: string | undefined; let prevBase: string | undefined;
  beforeAll(() => { prevSpeed = process.env.LOKI_SPEED; prevFetch = process.env.LOKI_E10_NO_FETCH; prevBase = process.env.LOKI_E10_BASE; process.env.LOKI_SPEED = "0"; delete process.env.LOKI_E10_BASE; });
  afterAll(() => {
    if (prevSpeed === undefined) delete process.env.LOKI_SPEED; else process.env.LOKI_SPEED = prevSpeed;
    if (prevFetch === undefined) delete process.env.LOKI_E10_NO_FETCH; else process.env.LOKI_E10_NO_FETCH = prevFetch;
    if (prevBase !== undefined) process.env.LOKI_E10_BASE = prevBase;
  });
  const CONFIRMED = "search-command.ts:1 search already implemented, tests/search.test.ts covers it, CHANGELOG.md documents it";
  /** origin (bare) with main = the unfixed sample repo; a clone whose local loki/* branch commits the "fix". */
  function originAndClone(): { root: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "e10-fc15-"));
    const seed = join(root, "seed");
    cpSync(join(FIX, "sample-repo"), seed, { recursive: true });
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["config", "user.email", "t@example.com"]); git(seed, ["config", "user.name", "t"]);
    git(seed, ["add", "-A"]); git(seed, ["commit", "-q", "-m", "initial"]);
    git(root, ["clone", "-q", "--bare", seed, join(root, "origin.git")]);
    git(root, ["clone", "-q", join(root, "origin.git"), join(root, "clone")]);
    const clone = join(root, "clone");
    git(clone, ["config", "user.email", "t@example.com"]); git(clone, ["config", "user.name", "t"]);
    git(clone, ["checkout", "-q", "-b", "loki/e10-20261003T150744Z-59b1"]);
    cpSync(join(FIX, "already-done-repo"), clone, { recursive: true });
    git(clone, ["add", "-A"]); git(clone, ["commit", "-q", "-m", "loki: fix the issue (unmerged draft)"]);
    return { root, clone };
  }

  test("checkout on a loki branch with unmerged commits: not refused, no ALREADY_SATISFIED from the loki commit, reported as unmerged Loki work", async () => {
    const { root, clone } = originAndClone();
    const confirm = fakeConfirmSession({ markers: { done: false, alreadyDone: CONFIRMED, specConflict: null } });
    const ctx = makeCtx(clone, runDir, new RealTestMapProvider());
    ctx.sessions = confirm.runner;
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "Add global search (Cmd+K)" });
    expect(result.status).toBe("completed");
    expect(result.data.already_satisfied).toBe(false);
    const u = result.data.unmerged_loki_work as { branch: string; target: string; commits: number; message: string };
    expect(u.branch).toBe("loki/e10-20261003T150744Z-59b1");
    expect(u.target).toBe("origin/main");
    expect(u.message).toContain("not on origin/main");
    rmSync(root, { recursive: true, force: true });
  });

  test("the same repo on the true base (origin/main): intake does not see the fix, so no ALREADY_SATISFIED", async () => {
    const { root, clone } = originAndClone();
    git(clone, ["checkout", "-q", "main"]);
    const decline = fakeConfirmSession({ markers: { done: true, alreadyDone: null, specConflict: null } });
    const ctx = makeCtx(clone, runDir, new RealTestMapProvider());
    ctx.sessions = decline.runner;
    const result = await runIntake(ctx, new AbortController().signal, { taskText: "Add global search (Cmd+K)" });
    expect(result.status).toBe("completed");
    expect(result.data.already_satisfied).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  /** clone on feature/search carrying one USER commit (the fix), nothing from Loki. */
  function userFeatureClone(): { root: string; clone: string; tip: string } {
    const { root, clone } = originAndClone();
    git(clone, ["checkout", "-q", "-b", "feature/search", "main"]);
    cpSync(join(FIX, "already-done-repo"), clone, { recursive: true });
    git(clone, ["add", "-A"]); git(clone, ["commit", "-q", "-m", "user: search"]);
    return { root, clone, tip: execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim() };
  }
  async function intakeOn(clone: string, alreadyDone: string | null = null): Promise<{ status: string; reason?: string; data: Record<string, unknown> }> {
    const ctx = makeCtx(clone, runDir, new RealTestMapProvider());
    ctx.sessions = fakeConfirmSession({ markers: { done: true, alreadyDone, specConflict: null } }).runner;
    return runIntake(ctx, new AbortController().signal, { taskText: "Add global search (Cmd+K)" });
  }

  test("A: a prior run with no commits sealed head_sha = the user's own tip: not Loki's work", async () => {
    const { root, clone, tip } = userFeatureClone();
    process.env.LOKI_E10_NO_FETCH = "1";
    mkdirSync(join(clone, ".loki", "runs", "e10-old"), { recursive: true });
    writeFileSync(join(clone, ".loki", "runs", "e10-old", "receipt.json"), JSON.stringify({ head_sha: tip, base_sha: tip }));
    const r = await intakeOn(clone);
    expect(r.status).toBe("completed");
    rmSync(root, { recursive: true, force: true });
  });

  test("B: loki/* branch created from the user's branch with zero Loki commits: not Loki's work", async () => {
    const { root, clone } = userFeatureClone();
    process.env.LOKI_E10_NO_FETCH = "1";
    git(clone, ["checkout", "-q", "-b", "loki/e10-x"]);
    const r = await intakeOn(clone);
    expect(r.status).toBe("completed");
    rmSync(root, { recursive: true, force: true });
  });

  test("B2: the same loki/* branch with a real Loki commit is not refused and claims nothing", async () => {
    const { root, clone } = userFeatureClone();
    process.env.LOKI_E10_NO_FETCH = "1";
    git(clone, ["checkout", "-q", "-b", "loki/e10-x"]);
    writeFileSync(join(clone, "loki.txt"), "x"); git(clone, ["add", "loki.txt"]); git(clone, ["commit", "-q", "-m", "loki: work"]);
    const r = await intakeOn(clone);
    expect(r.status).toBe("completed");
    expect(r.data.already_satisfied).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("D: fresh clone, checkout of a pushed loki/* branch with 1 Loki commit: not refused, no claim from that commit", async () => {
    const { root, clone } = originAndClone();
    git(clone, ["push", "-q", "origin", "loki/e10-20261003T150744Z-59b1"]);
    const fresh = join(root, "fresh");
    git(root, ["clone", "-q", join(root, "origin.git"), fresh]);
    git(fresh, ["config", "user.email", "t@example.com"]); git(fresh, ["config", "user.name", "t"]);
    process.env.LOKI_E10_NO_FETCH = "1";
    git(fresh, ["checkout", "-q", "loki/e10-20261003T150744Z-59b1"]);
    const r = await intakeOn(fresh, CONFIRMED);
    expect(r.status).toBe("completed");
    expect(r.data.already_satisfied).toBe(false);
    expect((r.data.unmerged_loki_work as { commits: number }).commits).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("a feature branch in a fresh clone carrying the user's own commit: not refused, no claim, not labelled Loki's", async () => {
    const { root, clone } = userFeatureClone();
    git(clone, ["push", "-q", "origin", "feature/search"]);
    const fresh = join(root, "fresh2");
    git(root, ["clone", "-q", join(root, "origin.git"), fresh]);
    git(fresh, ["config", "user.email", "t@example.com"]); git(fresh, ["config", "user.name", "t"]);
    process.env.LOKI_E10_NO_FETCH = "1";
    git(fresh, ["checkout", "-q", "feature/search"]);
    const r = await intakeOn(fresh, CONFIRMED);
    expect(r.status).toBe("completed");
    expect(r.data.already_satisfied).toBe(false);
    expect(r.data.unmerged_loki_work).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  test("ALREADY_SATISFIED is still reached when the work is genuinely on the PR target", async () => {
    const { root, clone } = originAndClone();
    git(clone, ["checkout", "-q", "main"]);
    cpSync(join(FIX, "already-done-repo"), clone, { recursive: true });
    git(clone, ["add", "-A"]); git(clone, ["commit", "-q", "-m", "user: search on main"]);
    git(clone, ["push", "-q", "origin", "main"]);
    git(clone, ["checkout", "-q", "loki/e10-20261003T150744Z-59b1"]);
    process.env.LOKI_E10_NO_FETCH = "1";
    const r = await intakeOn(clone, CONFIRMED);
    expect(r.status).toBe("completed");
    expect(r.data.already_satisfied).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("C: LOKI_E10_BASE=feature/search makes the loki/* branch allowed", async () => {
    const { root, clone } = userFeatureClone();
    process.env.LOKI_E10_NO_FETCH = "1"; process.env.LOKI_E10_BASE = "feature/search";
    git(clone, ["checkout", "-q", "-b", "loki/e10-x"]);
    const r = await intakeOn(clone);
    delete process.env.LOKI_E10_BASE;
    expect(r.status).toBe("completed");
    rmSync(root, { recursive: true, force: true });
  });
});
