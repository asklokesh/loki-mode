// FC-43: a LOKI_DONE exit with an empty diff gets exactly one correction round before verify fails it; no wording is inspected.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { EMPTY_DONE_CORRECTION } from "../../src/util/conflict_resume.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const already = (e: string): SessionResult => ({ exit: 0, markers: { done: false, alreadyDone: e, specConflict: null }, durationS: 1, killed: false });
const errored: SessionResult = { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: false };

describe("FC-43 empty-diff done resume", () => {
  let repo: string, base: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "fc43-"));
    git(repo, ["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    base = git(repo, ["rev-parse", "HEAD"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  class Seq implements SessionRunner {
    calls: SessionRunOptions[] = [];
    constructor(private rs: Array<SessionResult | (() => SessionResult)>) {}
    async run(o: SessionRunOptions): Promise<SessionResult> {
      this.calls.push(o);
      const r = this.rs[Math.min(this.calls.length - 1, this.rs.length - 1)]!;
      return typeof r === "function" ? r() : r;
    }
  }
  const ctxOf = (s: SessionRunner): RunContext => ({
    runId: "e10-fc43", repoDir: repo, runDir: join(repo, ".loki", "runs", "e10-fc43"), baseSha: base, branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions: s,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 }, outputs: () => ({}),
  } as unknown as RunContext);

  test("done with an empty tree resumes once with the correction", async () => {
    const s = new Seq([done, already("a.txt:1 already one")]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]!.brief).toContain(EMPTY_DONE_CORRECTION);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("already_done");
    expect(r.data.iteration_ids).toEqual(["e10-fc43-impl", "e10-fc43-impl-e"]);
  });
  test("a resume that makes the change completes as done", async () => {
    const s = new Seq([done, () => { writeFileSync(join(repo, "a.txt"), "two\n"); return done; }]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.data.exit).toBe("done");
  });
  test("a persistent empty done is resumed exactly once", async () => {
    const s = new Seq([done, done, done]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.data.exit).toBe("done");
  });
  test("a resume that errors keeps the first result", async () => {
    const s = new Seq([done, errored]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("done");
  });
  test("no resume when the tree already has a change", async () => {
    writeFileSync(join(repo, "b.txt"), "new\n");
    const s = new Seq([done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(1);
  });
  test("no resume for an already_done claim", async () => {
    const s = new Seq([already("a.txt:1")]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(1);
  });
  test("an unreadable git tree skips the resume and never throws", async () => {
    const s = new Seq([done]);
    const c = { ...ctxOf(s), baseSha: "not-a-sha" } as RunContext;
    const r = await implementStage.run(c, new AbortController().signal);
    expect(s.calls.length).toBe(1);
    expect(r.status).toBe("completed");
  });
});
