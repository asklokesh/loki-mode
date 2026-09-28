// E-67 rework: a hung worker must never end a run with no PR, no issue comment, and no reason.
// The backstop must fire INSIDE the cap (worker cap = cap minus grace), and whatever kills the
// worker (backstop, or a plain non-zero exit) must still leave a draft PR when there is a diff
// and a remote, or an issue-comment call naming the exact reason on an issue run.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKSTOP_NOT_PROVEN, runSupervisor, type CommentStep, type PrStep } from "../../src/engine10/supervisor.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) execFileSync("rm", ["-rf", r]); });

/** A repo with one real commit, so intake's base_sha (emitted by the fake worker below) names a
 *  real ancestor and `git diff <base> HEAD` can tell a real diff from none. */
function repoWithCommit(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-bs-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  const baseSha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, baseSha };
}
// Preflight requires a resolvable provider CLI; point it at a no-op so these tests need no real
// claude CLI on PATH (and still pass with the real one removed from PATH, per the rework rules).
const ENV: NodeJS.ProcessEnv = { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true" };
const worker = (code: string): string[] => [process.execPath, "-e", code];
const intakeLine = (baseSha: string): string =>
  `console.log(JSON.stringify({ type: "stage.completed", stage: "intake", data: { base_sha: ${JSON.stringify(baseSha)} } }));`;
// `commit --allow-empty` reuses the parent's tree (no diff); a real diff needs a changed file.
const COMMIT_A_CHANGE = `
  require("node:fs").writeFileSync("changed.txt", "wip\\n");
  require("node:child_process").execFileSync("git", ["add", "changed.txt"]);
  require("node:child_process").execFileSync("git", ["commit", "-q", "-m", "wip"]);
`;

function prSpy(): { step: PrStep; calls: { verdict: string }[] } {
  const calls: { verdict: string }[] = [];
  return { calls, step: async ({ verdict }) => { calls.push({ verdict }); return { url: "https://github.com/acme/widget/pull/1", draft: true, existing: null }; } };
}
function commentSpy(): { step: CommentStep; calls: { issueRef: string; reason: string }[] } {
  const calls: { issueRef: string; reason: string }[] = [];
  return { calls, step: async ({ issueRef, reason }) => { calls.push({ issueRef, reason }); return { argv: ["issue-comment", issueRef, "body.md"], ok: true }; } };
}

describe("E-67 rework: supervisor backstop", () => {
  test("the backstop fires before the cap elapses, not after it", async () => {
    const { dir } = repoWithCommit();
    const code = `setInterval(() => {}, 1000);`; // never exits, never emits anything
    const t0 = Date.now();
    const r = await runSupervisor({ runId: "e10-bs1", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1 });
    const wallMs = Date.now() - t0;
    // Old behavior killed at (cap + grace) = 3000ms; the fix kills at (cap - grace) = 1000ms.
    expect(wallMs).toBeLessThan(2000);
    expect(r.verdict).toBe("FAILED");
    expect(r.notProven).toContain(BACKSTOP_NOT_PROVEN);
  }, 10_000);

  test("hung worker with a diff and a remote: still ends as a draft PR call", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${intakeLine(baseSha)}
      ${COMMIT_A_CHANGE}
      setInterval(() => {}, 1000);
    `;
    const pr = prSpy();
    const t0 = Date.now();
    const r = await runSupervisor({ runId: "e10-bs2", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1, pr: pr.step });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.verdict).toBe("FAILED");
    expect(pr.calls.length).toBe(1);
    expect(pr.calls[0]!.verdict).toBe("FAILED");
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/1");
  }, 10_000);

  test("hung worker with no diff, on an issue run: posts an issue comment with the exact reason", async () => {
    const { dir } = repoWithCommit(); // no extra commit: base_sha stays HEAD, so there is no diff
    const code = `setInterval(() => {}, 1000);`;
    const comment = commentSpy();
    const pr = prSpy();
    const t0 = Date.now();
    const r = await runSupervisor({
      runId: "e10-bs3", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1,
      started: { task_source: "issue", issue_ref: "acme/widget#42" }, pr: pr.step, comment: comment.step,
    });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.verdict).toBe("FAILED");
    expect(pr.calls.length).toBe(0);
    expect(comment.calls.length).toBe(1);
    expect(comment.calls[0]!.issueRef).toBe("acme/widget#42");
    expect(comment.calls[0]!.reason).toContain(BACKSTOP_NOT_PROVEN);
    expect(r.prUrl).toBeNull();
  }, 10_000);

  test("worker exits non-zero (not a hang) with a diff and a remote: still gets a draft PR, not silently dropped", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${COMMIT_A_CHANGE}
      ${intakeLine(baseSha)}
      process.exit(1);
    `;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-bs4", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5, pr: pr.step });
    expect(r.verdict).toBe("FAILED");
    expect(r.workerExit).toBe(1);
    expect(pr.calls.length).toBe(1);
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/1");
  }, 10_000);

  test("worker exits non-zero with no diff, no issue: prints a reason instead of vanishing", async () => {
    const { dir } = repoWithCommit();
    const code = `process.exit(1);`;
    const orig = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as typeof process.stderr.write;
    let r;
    try {
      r = await runSupervisor({ runId: "e10-bs5", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5 });
    } finally {
      process.stderr.write = orig;
    }
    expect(r.verdict).toBe("FAILED");
    expect(r.prUrl).toBeNull();
    expect(err).toContain("e10-bs5");
    expect(err).toContain("FAILED");
  }, 10_000);
});
