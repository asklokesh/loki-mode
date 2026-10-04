// E-67 rework: a hung worker must never end a run with no PR, no issue comment, and no reason.
// The backstop must fire INSIDE the cap (worker cap = cap minus grace), and whatever kills the
// worker (backstop, or a plain non-zero exit) must still leave a draft PR when there is a diff
// and a remote, or an issue-comment call naming the exact reason on an issue run.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/engine10/output.ts";
import { softCapS } from "../../src/engine10/machine.ts";
import { runPr, type PrContext } from "../../src/engine10/stages/pr.ts";
import { backstopS, BACKSTOP_NOT_PROVEN, runSupervisor, type CommentStep, type PrStep } from "../../src/engine10/supervisor.ts";

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
// checkPreflight also shells out to `gh --version` / `gh auth status` whenever opts.pr is set and
// the origin looks like GitHub (every repoWithCommit() remote does): a stub ahead of the real gh on
// PATH makes that check independent of the host's gh login AND of another test file (bun runs every
// file in one process) mutating GH_TOKEN/GITHUB_TOKEN in the shared process.env mid-run. Reproduced:
// this file alongside tests/runner/github_token_withheld.test.ts fails "gh ... not authenticated"
// without the stub, on both the pre- and post-r4 backstop formula.
const ghStubDir = mkdtempSync(join(tmpdir(), "e10-bs-gh-"));
roots.push(ghStubDir);
writeFileSync(join(ghStubDir, "gh"), '#!/bin/sh\ncase "$1" in\n  --version) echo "gh stub 0.0.0" ;;\n  auth) exit 0 ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
const ENV: NodeJS.ProcessEnv = { ...process.env, LOKI_CLAUDE_CLI: "/usr/bin/true", PATH: `${ghStubDir}:${process.env.PATH ?? ""}` };
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
function commentSpy(): { step: CommentStep; calls: { issueRef: string; reason: string; prUrl?: string | null }[] } {
  const calls: { issueRef: string; reason: string; prUrl?: string | null }[] = [];
  return { calls, step: async ({ issueRef, reason, prUrl }) => { calls.push(prUrl ? { issueRef, reason, prUrl } : { issueRef, reason }); return { argv: ["issue-comment", issueRef, "body.md"], ok: true }; } };
}
/** Same shape pause_audit.test.ts's writePushStub uses: never the real, credentialed engine10-push.sh. */
function writePushStub(dir: string, logPath: string): string {
  const scriptPath = join(dir, "push-stub.sh");
  writeFileSync(scriptPath, `#!/bin/sh\nmode="$1"; shift\nprintf 'CALL mode=%s args=%s\\n' "$mode" "$*" >> "${logPath}"\ncase "$mode" in\n  push-pr) echo "https://github.com/acme/widget/pull/9" ;;\nesac\nexit 0\n`, { mode: 0o755 });
  return scriptPath;
}
/** Drives the real pr.ts stage (against a stub push script), the way main()'s pr closure does. */
function realPr(pushScriptPath: string, runDir: string): PrStep {
  return async ({ runId, repoDir, verdict, notProven, pushEnv }) => {
    const r = await runPr({
      runId, repoDir, runDir, branch: `loki/${runId}`, pinnedOrigin: pushEnv._LOKI_PINNED_ORIGIN,
      outputs: () => ({ seal: { verdict, not_proven: notProven } }), capHit: () => false, emit: () => {},
    } as unknown as PrContext, new AbortController().signal, { pushScriptPath });
    const d = r.data as { pr_url?: string; draft?: boolean; existing?: boolean | null };
    return r.status === "completed"
      ? { url: d.pr_url ?? null, draft: d.draft === true, existing: d.existing ?? null }
      : { url: null, draft: false, existing: null, notProven: [`PR not opened: ${r.reason}`] };
  };
}

describe("E-67 rework: supervisor backstop", () => {
  test("the backstop fires before the cap elapses, not after it", async () => {
    const { dir } = repoWithCommit();
    const code = `setInterval(() => {}, 1000);`; // never exits, never emits anything
    const t0 = Date.now();
    const r = await runSupervisor({ runId: "e10-bs1", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1 });
    const wallMs = Date.now() - t0;
    // Old behavior killed at (cap + grace) = 3000ms. r4 (E-67 finding 1): grace clamps to
    // min(graceS, capS/30) so the backstop still clears the worker's own soft cap (1.867s here);
    // that puts the kill at ~1.933s instead of the old, unclamped (cap - grace) = 1000ms. The bound
    // below stays well under the old 3000ms while leaving slack for a loaded CI box.
    expect(wallMs).toBeLessThan(2900);
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

  test("FC-19: a sealed PARTIAL after a failed implement stage, with a diff, still opens the PR (never vanishes)", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${intakeLine(baseSha)}
      ${COMMIT_A_CHANGE}
      console.log(JSON.stringify({ type: "stage.failed", stage: "implement", data: { reason: "limit" } }));
      console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "PARTIAL", not_proven: ["implement failed"] } }));
      process.exit(0);
    `;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-fc19", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5, pr: pr.step, started: { task_source: "issue", issue_ref: "acme/widget#42" }, comment: commentSpy().step });
    expect(r.verdict).toBe("PARTIAL");
    expect(pr.calls.length).toBe(1);
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/1");
  }, 15_000);

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

  // Opus REJECT findings 2+3: `git diff` alone never sees an untracked file, and nothing pushes a
  // working tree that was never committed. Observed red on the pre-fix merge (old hasPushableDiff,
  // no backstop commit): the modified tracked file alone was enough for hasPushableDiff to return
  // true, so the PR DID open -- but `git diff base HEAD` on the pushed branch came back empty
  // (`[""]` instead of the two changed files): nothing was ever committed, so the PR carried no
  // diff at all. Green once the backstop makes its own commit before the diff check.
  test("hung worker leaves an untracked file and a modified-but-uncommitted tracked file: both reach the PR, with the reason in the body", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${intakeLine(baseSha)}
      require("node:fs").writeFileSync("a.txt", "changed\\n");
      require("node:fs").writeFileSync("untracked.txt", "new\\n");
      setInterval(() => {}, 1000);
    `;
    const workDir = mkdtempSync(join(tmpdir(), "e10-bs-out-")); // never inside repoDir: backstopCommit's `git add -A` would stage it
    roots.push(workDir);
    const runDir = join(dir, ".loki", "runs", "e10-bs6");
    const pushScriptPath = writePushStub(workDir, join(workDir, "push-calls.log"));
    const t0 = Date.now();
    const r = await runSupervisor({ runId: "e10-bs6", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1, pr: realPr(pushScriptPath, runDir) });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.verdict).toBe("FAILED");
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/9");
    const changed = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort();
    expect(changed).toEqual(["a.txt", "untracked.txt"]);
    expect(readFileSync(join(runDir, "pr-body.md"), "utf8")).toContain(BACKSTOP_NOT_PROVEN);
  }, 10_000);

  // Finding 2 in isolation (no tracked change at all): on the pre-fix merge, hasPushableDiff's
  // `git diff` sees nothing, so opts.pr is never even called (0 calls) -- the run just prints and
  // vanishes, exactly the bug E-67 exists to close. Proves untracked-only work is not just
  // undercounted in the diff but drops the PR entirely without the backstop commit.
  test("hung worker leaves only an untracked file (no tracked change): it still reaches the PR", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${intakeLine(baseSha)}
      require("node:fs").writeFileSync("untracked.txt", "new\\n");
      setInterval(() => {}, 1000);
    `;
    const workDir = mkdtempSync(join(tmpdir(), "e10-bs-out-"));
    roots.push(workDir);
    const runDir = join(dir, ".loki", "runs", "e10-bs7");
    const pushScriptPath = writePushStub(workDir, join(workDir, "push-calls.log"));
    const r = await runSupervisor({ runId: "e10-bs7", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1, pr: realPr(pushScriptPath, runDir) });
    expect(r.verdict).toBe("FAILED");
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/9");
    const changed = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort();
    expect(changed).toEqual(["untracked.txt"]);
  }, 10_000);

  // E-67 finding 1, small non-default capS with the DEFAULT grace (no graceS override, unlike
  // every test above): pre-fix, backstopMs = max(0, capS - 30) * 1000 was 0 at capS=5, so the
  // worker got SIGTERM at spawn and a clean exit never had a chance to land. Red on the pre-fix
  // formula (workerExit null, FAILED); green once the backstop clamps its grace for a small cap.
  test("small capS, default grace: a worker that exits cleanly before its cap is not killed at spawn", async () => {
    const { dir } = repoWithCommit();
    const code = `setTimeout(() => process.exit(0), 200);`;
    const r = await runSupervisor({ runId: "e10-bs8", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 5 });
    expect(r.workerExit).toBe(0);
    expect(r.notProven).not.toContain(BACKSTOP_NOT_PROVEN);
  }, 10_000);

  /** Polls until pid is gone (reaped after SIGKILL), returning elapsed ms from t0, or -1 on timeout.
   *  Measures the worker's actual death, not total supervisor wall time (which also includes
   *  backstopCommit's git calls and stdout drain, too noisy a bound under load). */
  async function pollDeathMs(t0: number, pidFile: string, maxMs: number): Promise<number> {
    const deadline = t0 + maxMs;
    while (Date.now() < deadline) {
      await Bun.sleep(30);
      let pidStr: string;
      try { pidStr = readFileSync(pidFile, "utf8"); } catch { continue; }
      try { process.kill(Number(pidStr), 0); } catch { return Date.now() - t0; }
    }
    return -1;
  }

  test("small capS, default grace: a hung worker is still killed before the cap elapses", async () => {
    const { dir } = repoWithCommit();
    const pidFile = join(dir, "worker.pid");
    const code = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const t0 = Date.now();
    const done = runSupervisor({ runId: "e10-bs9", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 5 });
    const deathMs = await pollDeathMs(t0, pidFile, 6000);
    const r = await done;
    expect(deathMs).toBeGreaterThan(0);
    expect(deathMs).toBeGreaterThan(backstopS(5) * 1000 - 300); // fires near its computed instant, not at spawn
    expect(deathMs).toBeLessThan(6000); // green ~4.97s; the old fixed-2s-escalation red would be ~6.8s+ (unaffected here, but keep headroom under load)
    expect(r.verdict).toBe("FAILED");
    expect(r.notProven).toContain(BACKSTOP_NOT_PROVEN);
  }, 10_000);

  // E-67 finding 1 follow-up: the SIGTERM->SIGKILL escalation used to be a fixed 2s regardless of
  // the cap, so a worker that traps SIGTERM (ignores it, only SIGKILL ends it) at a small capS still
  // got its full 2s before SIGKILL -- past the cap (capS=5: backstop ~4.83s, old SIGKILL ~6.83s).
  // Red on the pre-fix fixed 2000ms escalation (death near 6.8s); green once escalateMs clamps to
  // the time remaining before the cap (capS*1000 - backstopMs).
  test("small capS, default grace: a SIGTERM-trapping worker still dies at or before the cap", async () => {
    const { dir } = repoWithCommit();
    const pidFile = join(dir, "worker.pid");
    const code = `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const t0 = Date.now();
    const done = runSupervisor({ runId: "e10-bs10", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 5 });
    const deathMs = await pollDeathMs(t0, pidFile, 8000);
    const r = await done;
    expect(deathMs).toBeGreaterThan(0);
    expect(deathMs).toBeLessThan(6000); // green ~5.1s; the old fixed-2s-escalation red was ~6.9-7.0s (measured above)
    expect(r.verdict).toBe("FAILED");
  }, 15_000);

  // E-67 round 5 REJECT finding 1: below ~capS=24.83 (24s tail vs a smaller backstop window),
  // softCapS's fallback to the plain 14/15 point left as little as 0.17-0.8s between the worker's
  // own soft cap and the backstop -- not enough for a real seal (0.3-1.5s). Reproduced here with a
  // worker that waits until the real softCapS(capS) on its own clock, then takes a worst-case 1.5s
  // to "seal" (its clean-exit stand-in). Red on the pre-fix formula at capS 5, 20 and 24
  // (workerExit null, BACKSTOP_NOT_PROVEN); green once softCapS clamps to 0 instead of the plain
  // point, since the worker then finishes its 1.5s seal immediately, long before any backstop.
  // 25 and 30 are above the ~24.83s threshold (already on the budget>=0 path, unaffected by the
  // clamp): included as controls alongside the reds above, not as red-then-green themselves -- they
  // were already green on the pre-fix formula too (backstop_math.test.ts pins that directly).
  for (const capS of [5, 20, 24, 25, 30]) {
    test(`capS=${capS}, default grace: a worker that seals 1.5s after its own soft cap is not backstop-killed`, async () => {
      const { dir } = repoWithCommit();
      const waitMs = Math.round(softCapS(capS) * 1000);
      const code = `setTimeout(() => process.exit(0), ${waitMs} + 1500);`;
      const r = await runSupervisor({ runId: `e10-bs-softcap-${capS}`, repoDir: dir, env: ENV, workerArgv: worker(code), capS });
      expect(r.workerExit).toBe(0);
      expect(r.notProven).not.toContain(BACKSTOP_NOT_PROVEN);
    }, 30_000);
  }
});

// A-110: the exit ladder. A worker that seals a verdict and exits 0 must still map to the named outcome's exit code.
const ev = (type: string, stage: string | null, data: Record<string, unknown>): string => `console.log(JSON.stringify({ type: ${JSON.stringify(type)}, stage: ${JSON.stringify(stage)}, data: ${JSON.stringify(data)} }));`;
const sealedAs = (verdict: string): string => ev("receipt.sealed", "seal", { verdict, receipt_sha256: "ab".repeat(32), not_proven: [] });
const verifyRed = (sig: string): string => ev("stage.completed", "verify", { failures_grouped: [{ signature: sig }] });
async function ladder(code: () => string, extra: Partial<Parameters<typeof runSupervisor>[0]> = {}): Promise<{ r: Awaited<ReturnType<typeof runSupervisor>>; exit: number }> {
  const { dir, baseSha } = repoWithCommit();
  const r = await runSupervisor({ runId: "e10-ladder", repoDir: dir, env: ENV, workerArgv: worker(`${intakeLine(baseSha)}${code()}`), capS: 30, ...extra });
  return { r, exit: EXIT[r.outcome] };
}
describe("A-110 exit ladder", () => {
  test("a red suite that ends PARTIAL exits 1 (was 0: only FAILED exited non-zero)", async () => {
    const { r, exit } = await ladder(() => `${verifyRed("t::a")}${sealedAs("PARTIAL")}`);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.outcome).toBe("PARTIAL"); // FC-21 (d): the outcome is the receipt verdict
    expect(exit).toBe(1);
    expect(r.receiptSha).toBe("ab".repeat(32));
  });
  test("VERIFIED and ALREADY_SATISFIED exit 0", async () => {
    expect((await ladder(() => sealedAs("VERIFIED"))).exit).toBe(0);
    expect((await ladder(() => sealedAs("ALREADY_SATISFIED"))).exit).toBe(0);
  });
  test("a cap.hit run with a sealed receipt keeps the receipt verdict (L7), exit 1, and reports stop cap", async () => {
    const { r, exit } = await ladder(() => `${ev("cap.hit", "implement", {})}${sealedAs("PARTIAL")}`);
    expect(r.outcome).toBe("PARTIAL");
    expect(r.stop).toBe("cap");
    expect(exit).toBe(1);
  });
  test("a cap.hit run with no sealed receipt is still BUDGET_STOP, exit 3", async () => {
    const { r, exit } = await ladder(() => `${ev("cap.hit", "implement", {})}`);
    expect(r.outcome).toBe("BUDGET_STOP");
    expect(exit).toBe(3);
  });
  test("SPEC_CONFLICT exits 4 as BLOCKED and posts its one question on the issue", async () => {
    const comment = commentSpy();
    const { r, exit } = await ladder(() => `${ev("stage.completed", "implement", { spec_conflict_reason: "spec says A\nand B" })}${sealedAs("SPEC_CONFLICT")}`,
      { started: { task_source: "issue", issue_ref: "acme/widget#7" }, comment: comment.step });
    expect(r.outcome).toBe("BLOCKED");
    expect(exit).toBe(4);
    expect(comment.calls).toEqual([{ issueRef: "acme/widget#7", reason: "spec conflict: spec says A and B" }]);
  });
  test("the worker's escalated stop reason drives the outcome: stalled exits 5, fatal keeps its string, none stays FAILED", async () => {
    const stalled = await ladder(() => `${ev("escalated", null, { stop: "stalled" })}${sealedAs("PARTIAL")}`);
    expect(stalled.r.stop).toBe("stalled");
    expect(stalled.exit).toBe(5);
    const fatal = await ladder(() => `${ev("escalated", null, { stop: "fatal:quota_exhausted" })}${sealedAs("FAILED")}`);
    expect(fatal.r.stop).toBe("fatal:quota_exhausted");
    expect(fatal.exit).toBe(1);
    expect((await ladder(() => sealedAs("PARTIAL"))).r.stop).toBeNull();
  });
  test("a BLOCKED run that opened a draft PR names the PR in the comment instead of claiming none", async () => {
    const comment = commentSpy();
    const { r } = await ladder(() => `${COMMIT_A_CHANGE}${ev("stage.completed", "implement", { spec_conflict_reason: "A or B?" })}${sealedAs("SPEC_CONFLICT")}`,
      { started: { task_source: "issue", issue_ref: "acme/widget#7" }, pr: prSpy().step, comment: comment.step });
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/1");
    expect(comment.calls[0]!.prUrl).toBe(r.prUrl);
  });

  // A-104c: a run whose commit stage FAILED must not have backstopCommit sweep up what the commit
  // stage deliberately excluded (Wall file, stray lockfile, pre-run dirty file) and push it as a PR.
  test("commit stage failed: no backstop commit, no PR", async () => {
    const { dir, baseSha } = repoWithCommit();
    writeFileSync(join(dir, "a.txt"), "dirty before the run\n"); // pre-run dirty tracked file
    const code = `
      ${intakeLine(baseSha)}
      const fs = require("node:fs");
      fs.writeFileSync("loki_wall_x.py", "wall\\n");
      fs.writeFileSync("package-lock.json", "{}\\n");
      console.log(JSON.stringify({ type: "stage.failed", stage: "commit", data: { reason: "commit failed" } }));
      process.exit(1);
    `;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-bs-a104c", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5, pr: pr.step });
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(r.verdict).toBe("FAILED");
    expect(head).toBe(baseSha);
    expect(pr.calls.length).toBe(0);
    expect(r.prUrl).toBeNull();
  }, 10_000);

  test("intake refused (dirty tree): no backstop commit lands the user's files on their branch", async () => {
    const { dir } = repoWithCommit();
    writeFileSync(join(dir, "a.txt"), "user edit\n"); // dirty tracked file
    writeFileSync(join(dir, "notes.txt"), "mine\n"); // untracked
    const code = `console.log(JSON.stringify({ type: "stage.failed", stage: "intake", data: { reason: "dirty tracked tree" } })); process.exit(1);`;
    const r = await runSupervisor({ runId: "e10-bs-refused", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 5, graceS: 1 });
    const git = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    expect(r.verdict).toBe("FAILED");
    expect(git("rev-list", "--count", "--all").trim()).toBe("1");
    expect(git("log", "--all", "--format=%s")).not.toContain("backstop");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("user edit\n");
    expect(git("status", "--porcelain", "--", "a.txt", "notes.txt")).toBe(" M a.txt\n?? notes.txt\n");
  }, 10_000);
});
