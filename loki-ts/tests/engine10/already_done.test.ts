// loki-ts/tests/engine10/already_done.test.ts -- E-66 unit + mutation-proof tests for the
// deterministic evidence search and its confirmation gate.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAlreadyDoneCommentArgv,
  buildConfirmBrief,
  checkAlreadyDone,
  findEvidence,
  renderAlreadyDoneComment,
} from "../../src/engine10/already_done.ts";
import { buildRepoMap, listRepoFiles } from "../../src/engine10/repomap.ts";
import { buildTestMap, isTestFile } from "../../src/engine10/testmap.ts";
import type { CostReader, RunContext, SessionRunner, TestMap } from "../../src/engine10/types.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";

const FIX = join(import.meta.dir, "fixtures", "intake", "already-done-repo");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-already-done-"));
  execFileSync("cp", ["-R", `${FIX}/.`, dir]);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

const TASK = "Add global search (Cmd+K)";

describe("findEvidence (deterministic search)", () => {
  test("code + test + CHANGELOG together clear the MIN_CATEGORIES gate", () => {
    const dir = freshRepo();
    const repoMap = buildRepoMap(dir);
    const testMap = buildTestMap(dir);
    const hits = findEvidence(TASK, repoMap, testMap, dir);
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(["code", "test", "changelog"]));
    rmSync(dir, { recursive: true, force: true });
  });

  // Mutation proof: dropping MIN_CATEGORIES to 1 would make this pass on a single incidental
  // match (the task merely names a symbol that already exists), which is exactly the
  // false-positive the two-category gate exists to prevent.
  test("one category alone (a task naming an existing symbol) is never a candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-onecat-")); // no CHANGELOG/README here
    const repoMap = { files: ["src/search-command.ts"], entries: [{ path: "src/search-command.ts", symbols: ["search"] }], truncated: false };
    const hits = findEvidence("refactor search internals", repoMap, { runners: [], tests: [] }, dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no keyword overlap at all: no evidence, no crash on a repo with no CHANGELOG/README", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-empty-"));
    const hits = findEvidence("completely unrelated task text", { files: [], entries: [], truncated: false }, { runners: [], tests: [] }, dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  // Two unrelated keywords each hitting a different source is not the same signal as one keyword
  // naming the feature in two places (the fixture test above): "gizmo" is a real symbol name but
  // has no test or changelog mention, "sprocket" is a test-name-only coincidence with no code or
  // changelog mention. Neither says the task's actual feature already exists.
  test("two different keywords each covering a different source alone are not enough", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-crosscat-"));
    const repoMap = { files: ["src/gizmo.ts"], entries: [{ path: "src/gizmo.ts", symbols: ["gizmo"] }], truncated: false };
    const testMap = { runners: ["bun" as const], tests: [{ runner: "bun" as const, path: "tests/sprocket.test.ts" }] };
    const hits = findEvidence("wire the gizmo into the sprocket pipeline", repoMap, testMap, dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 2, reproduced on THIS repo (not a fixture): before the stop-word list and
  // whole-token matching, these two tasks matched hundreds of unrelated lines (generic words like
  // "add", "mode", "the", "files" hitting test names and old CHANGELOG headings) and would have
  // spent a confirmation session on almost every real-world run. A genuinely already-built feature
  // (the fixture case just above, and again below) must still clear the gate.
  test("generic-word tasks give zero candidate evidence on a real, large repo", () => {
    // Uncapped: this repo has ~4700+ tracked files, well past listRepoFiles' default 2000-file
    // cap. Capped, this test stayed green even with STOP_WORDS emptied out (the words that would
    // have produced a false candidate live past file #2000), which made the test worthless as a
    // guard. Number.MAX_SAFE_INTEGER as maxFiles turns the cap off for both repoMap and testMap.
    const repoMap = buildRepoMap(REPO_ROOT, Number.MAX_SAFE_INTEGER);
    // Tracked test files only (git ls-files), never buildTestMap's raw fs walk: this checkout's
    // .claude/worktrees/ holds a full repo copy per concurrent agent (excluded via
    // .git/info/exclude, so `git ls-files` never sees it, but a plain readdirSync walk would),
    // which made the earlier version of this test slow enough to risk the CI timeout.
    const testMap: TestMap = { runners: ["bun"], tests: listRepoFiles(REPO_ROOT, Number.MAX_SAFE_INTEGER).files.filter(isTestFile).map((path) => ({ runner: "bun", path })) };
    for (const task of ["Add a dark mode toggle to the settings page", "Support exporting invoices as PDF files"]) {
      expect(findEvidence(task, repoMap, testMap, REPO_ROOT)).toEqual([]);
    }
  });

  // A flat `slice(0, N)` after concatenating [...code, ...test, ...changelog] could let 30 code
  // hits alone fill the cap and crowd the test category out entirely, even though both sources
  // are what made this a candidate in the first place. The cap must be per source.
  test("hit list is capped per source, so a noisy category never crowds another one out", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-cap-"));
    const entries = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, symbols: ["widget"] }));
    const tests = [{ runner: "bun" as const, path: "tests/widget-x.test.ts" }];
    const hits = findEvidence("ship the widget dashboard", { files: [], entries, truncated: false }, { runners: ["bun"], tests }, dir);
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(["code", "test"]));
    expect(hits.some((h) => h.source === "test")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildConfirmBrief", () => {
  test("cites every deterministic hit and demands a citing marker line", () => {
    const brief = buildConfirmBrief(TASK, [{ source: "code", path: "src/search-command.ts", line: "search" }]);
    expect(brief).toContain("src/search-command.ts: search");
    expect(brief).toContain("LOKI_ALREADY_DONE:");
    expect(brief).toContain("Do not edit any file");
  });
});

const fakeCost: CostReader = { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) };
function ctxWith(sessions: SessionRunner, repoDir: string): RunContext {
  return {
    runId: "e10-already-done-run", repoDir, runDir: repoDir, baseSha: "", branch: "loki/e10-already-done-run",
    provider: "claude", model: "test-model", deep: false, capS: 900, emit: () => {}, sessions,
    tests: { detect: async (d) => buildTestMap(d), impacted: () => [] }, cost: fakeCost,
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
}

describe("checkAlreadyDone", () => {
  test("no candidate evidence: never calls the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-nocand-"));
    const sessions: SessionRunner = { run: () => { throw new Error("must not be called"); } };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, "unrelated task", { files: [], entries: [], truncated: false }, { runners: [], tests: [] });
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("candidate evidence, confirmed: returns the model's citation plus the deterministic hits", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "search-command.ts:1 already implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result?.satisfied).toBe(true);
    expect(result?.evidence[0]).toBe("search-command.ts:1 already implemented");
    expect(result?.evidence.some((e) => e.includes("search-command.ts: search"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("candidate evidence, not confirmed: null, never a false already-done", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: true, alreadyDone: null, specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 3: a marker with no real citation must never satisfy already-done, even
  // though the marker string itself is non-empty (the old gate was `if (!alreadyDone) return
  // null`, which "LOKI_ALREADY_DONE: yes" alone would pass).
  test("confirmed marker names no file at all: rejected, not already-done", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "yes, fully implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // A citation must name one of THIS search's own hits, not merely an existing file: naming a real
  // but unrelated path (package.json exists, but was never offered as evidence) must not count.
  test("confirmed marker names a real file that is not in the hit list: rejected", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "bunfig.toml proves it", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 5: a changelog heading says a feature was documented, not that working
  // code for it exists today. A citation naming only the changelog entry (never the code or the
  // test) must not be enough, even though CHANGELOG.md is a real hit in the hit list.
  test("confirmed marker cites only the CHANGELOG.md hit: rejected, changelog alone is not code", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "CHANGELOG.md documents this feature", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 5: substring citation must respect a word boundary, so a coincidental
  // superstring of a hit's basename ("presearch-command.ts" contains the literal text
  // "search-command.ts") is never mistaken for citing "search-command.ts".
  test("a coincidental substring of a basename is not a citation of it", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "see presearch-command.ts for background", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // The citation gate requires the cited path to still exist on disk, not just to appear in the
  // hit list findEvidence built a moment earlier (the repo can change between the search and the
  // confirmation session). Same hit, both branches of that existsSync check.
  test("confirmed marker cites a hit whose file no longer exists on disk: rejected", async () => {
    const dir = freshRepo();
    const repoMap = buildRepoMap(dir);
    const testMap = buildTestMap(dir);
    rmSync(join(dir, "src", "search-command.ts"));
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "search-command.ts:1 already implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, repoMap, testMap);
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("confirmed marker cites a hit whose file still exists on disk: accepted", async () => {
    const dir = freshRepo();
    const repoMap = buildRepoMap(dir);
    const testMap = buildTestMap(dir);
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "search-command.ts:1 already implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, repoMap, testMap);
    expect(result?.satisfied).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an already-aborted signal never calls the session", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: () => { throw new Error("must not be called"); } };
    const controller = new AbortController();
    controller.abort();
    const result = await checkAlreadyDone(ctxWith(sessions, dir), controller.signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("comment building (no PR)", () => {
  test("renderAlreadyDoneComment lists every evidence line", () => {
    const body = renderAlreadyDoneComment(["a.ts: foo", "CHANGELOG.md: Foo"]);
    expect(body).toContain("no change needed");
    expect(body).toContain("- a.ts: foo");
    expect(body).toContain("- CHANGELOG.md: Foo");
  });

  test("buildAlreadyDoneCommentArgv is deterministic argv, not a shell string", () => {
    const argv = buildAlreadyDoneCommentArgv("e10-run-1", "acme/widgets#303", "/tmp/body.md");
    expect(argv).toEqual(["comment", "e10-run-1", "acme/widgets#303", "/tmp/body.md"]);
  });
});
