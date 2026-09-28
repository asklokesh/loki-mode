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
import { buildRepoMap } from "../../src/engine10/repomap.ts";
import { buildTestMap } from "../../src/engine10/testmap.ts";
import type { CostReader, RunContext, SessionRunner } from "../../src/engine10/types.ts";

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
