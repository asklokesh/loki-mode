// E-67 rework: a hung worker must never end a run with no PR, no issue comment, and no reason.
// The backstop must fire INSIDE the cap (worker cap = cap minus grace), and whatever kills the
// worker (backstop, or a plain non-zero exit) must still leave a draft PR when there is a diff
// and a remote, or an issue-comment call naming the exact reason on an issue run.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process"; import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stageCapability, workerStages } from "../../src/engine10/worker.ts"; import { buildStageEnv, stageCapability as contribCapability } from "../../src/contrib/stage_capability.ts"; import { SENTINEL_PREFIX } from "../../src/util/credential_env.ts"; import { SAFE_BUN_FLAGS } from "../../src/runner/worker_proc.ts";
import { EXIT } from "../../src/engine10/output.ts";
import { loadAwareTimeoutMs, setLoadAwareTimeout } from "../preload.ts";
import { softCapS } from "../../src/engine10/machine.ts";
import { runPr, type PrContext } from "../../src/engine10/stages/pr.ts";
import { backstopS, BACKSTOP_NOT_PROVEN, runSupervisor, type CommentStep, type PrStep } from "../../src/engine10/supervisor.ts";

setLoadAwareTimeout(5_000); // bun default; the tests without their own budget (A-110 ladder runs 3 supervisors) scale with load

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
    expect(wallMs).toBeLessThan(loadAwareTimeoutMs(2900));
    expect(r.verdict).toBe("FAILED");
    expect(r.notProven).toContain(BACKSTOP_NOT_PROVEN);
  }, loadAwareTimeoutMs(10_000));

  test("hung worker with a diff and a remote: backstop commit lands locally, nothing is pushed (FC-NO-PUSH-UNVERIFIED)", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${intakeLine(baseSha)}
      ${COMMIT_A_CHANGE}
      setInterval(() => {}, 1000);
    `;
    const pr = prSpy();
    const t0 = Date.now();
    const r = await runSupervisor({ runId: "e10-bs2", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1, pr: pr.step });
    expect(Date.now() - t0).toBeLessThan(loadAwareTimeoutMs(2500));
    expect(r.verdict).toBe("FAILED");
    expect(pr.calls.length).toBe(0);
    expect(r.prUrl).toBeNull();
  }, loadAwareTimeoutMs(10_000));

  test("FC-19: a sealed PARTIAL after a failed implement stage, with a diff, opens a PR (PR-FIRST-1)", async () => {
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
    expect(pr.calls[0]!.verdict).toBe("PARTIAL");
    expect(r.prUrl).not.toBeNull();
  }, loadAwareTimeoutMs(15_000));

  test("a PARTIAL run with a real diff that was cancelled never calls pr and has no prUrl", async () => {
    const { dir, baseSha } = repoWithCommit();
    const code = `
      ${intakeLine(baseSha)}
      ${COMMIT_A_CHANGE}
      console.log(JSON.stringify({ type: "cancel_effective", stage: null, data: {} }));
      console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "PARTIAL", not_proven: ["cancelled"] } }));
      process.exit(0);
    `;
    const pr = prSpy();
    const r = await runSupervisor({ runId: "e10-cancel-partial", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5, pr: pr.step });
    expect(r.outcome).toBe("CANCELLED");
    expect(pr.calls.length).toBe(0);
    expect(r.prUrl).toBeNull();
  }, loadAwareTimeoutMs(15_000));

  test("P1: a sealed SPEC_CONFLICT or PARTIAL with no net diff never calls pr (no empty branch), and the blocked run still comments", async () => {
    for (const verdict of ["SPEC_CONFLICT", "PARTIAL"]) {
      const { dir, baseSha } = repoWithCommit();
      const code = `
        ${intakeLine(baseSha)}
        console.log(JSON.stringify({ type: "stage.completed", stage: "implement", data: { spec_conflict_reason: "contradiction" } }));
        console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: ${JSON.stringify(verdict)}, not_proven: [] } }));
        process.exit(0);
      `;
      const pr = prSpy(), comment = commentSpy();
      const r = await runSupervisor({ runId: `e10-p1-${verdict.toLowerCase()}`, repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5, pr: pr.step, started: { task_source: "issue", issue_ref: "acme/widget#42" }, comment: comment.step });
      expect(r.verdict as string).toBe(verdict);
      expect(pr.calls.length).toBe(0);
      expect(r.prUrl).toBeNull();
      if (verdict === "SPEC_CONFLICT") expect(comment.calls.length).toBe(1);
    }
  }, loadAwareTimeoutMs(20_000));

  test("PR-FIRST-1: with a real diff VERIFIED and PARTIAL call pr (PARTIAL as a draft), SPEC_CONFLICT and FAILED never do (branch stays local)", async () => {
    for (const verdict of ["SPEC_CONFLICT", "PARTIAL", "FAILED", "VERIFIED"]) {
      const { dir, baseSha } = repoWithCommit();
      const code = `
        ${intakeLine(baseSha)}
        ${COMMIT_A_CHANGE}
        console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: ${JSON.stringify(verdict)}, not_proven: [] } }));
        process.exit(0);
      `;
      const pr = prSpy();
      await runSupervisor({ runId: `e10-nopush-${verdict.toLowerCase()}`, repoDir: dir, env: ENV, workerArgv: worker(code), capS: 20, graceS: 5, pr: pr.step });
      expect(pr.calls.length).toBe(verdict === "VERIFIED" || verdict === "PARTIAL" ? 1 : 0);
      if (pr.calls.length === 1) expect(pr.calls[0]!.verdict).toBe(verdict);
    }
  }, loadAwareTimeoutMs(40_000));

  test("P1: a comment step reporting skipped lands skipped:true on the issue.commented event", async () => {
    const { dir } = repoWithCommit();
    const skipping: CommentStep = async ({ issueRef }) => ({ argv: ["issue-comment", issueRef, "b.md"], ok: true, skipped: true });
    await runSupervisor({ runId: "e10-p1-skip", repoDir: dir, env: ENV, workerArgv: worker(`process.exit(1);`), capS: 20, graceS: 5, started: { task_source: "issue", issue_ref: "acme/widget#42" }, comment: skipping });
    const ev = readFileSync(join(dir, ".loki", "runs", "e10-p1-skip", "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"issue.commented"'));
    expect(ev.length).toBe(1);
    expect(JSON.parse(ev[0]!).data.skipped).toBe(true);
  }, loadAwareTimeoutMs(10_000));

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
    expect(Date.now() - t0).toBeLessThan(loadAwareTimeoutMs(2500));
    expect(r.verdict).toBe("FAILED");
    expect(pr.calls.length).toBe(0);
    expect(comment.calls.length).toBe(1);
    expect(comment.calls[0]!.issueRef).toBe("acme/widget#42");
    expect(comment.calls[0]!.reason).toContain(BACKSTOP_NOT_PROVEN);
    expect(r.prUrl).toBeNull();
  }, loadAwareTimeoutMs(10_000));

  test("the issue backstop comment body starts with the loki-backstop marker so the steer webhook ignores it", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/engine10/supervisor.ts"), "utf8");
    expect(src).toContain("writeFileSync(bodyFile, `<!-- loki-backstop -->\\nLoki 10 run ${runId}");
  });

  test("worker exits non-zero (not a hang) with a diff and a remote: pushes nothing (FC-NO-PUSH-UNVERIFIED)", async () => {
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
    expect(pr.calls.length).toBe(0);
    expect(r.prUrl).toBeNull();
  }, loadAwareTimeoutMs(10_000));

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
  }, loadAwareTimeoutMs(10_000));

  // Opus REJECT findings 2+3: `git diff` alone never sees an untracked file, and nothing pushes a
  // working tree that was never committed. Observed red on the pre-fix merge (old hasPushableDiff,
  // no backstop commit): the modified tracked file alone was enough for hasPushableDiff to return
  // true, so the PR DID open -- but `git diff base HEAD` on the pushed branch came back empty
  // (`[""]` instead of the two changed files): nothing was ever committed, so the PR carried no
  // diff at all. Green once the backstop makes its own commit before the diff check.
  test("hung worker leaves an untracked file and a modified-but-uncommitted tracked file: both land in the local backstop commit, nothing is pushed", async () => {
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
    expect(Date.now() - t0).toBeLessThan(loadAwareTimeoutMs(2500));
    expect(r.verdict).toBe("FAILED");
    expect(r.prUrl).toBeNull();
    expect(r.notProven).toContain(BACKSTOP_NOT_PROVEN);
    const changed = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort();
    expect(changed).toEqual(["a.txt", "untracked.txt"]);
    expect(existsSync(join(workDir, "push-calls.log"))).toBe(false);
  }, loadAwareTimeoutMs(10_000));

  // FC-COMMIT-STAGES-USER-UNTRACKED: the supervisor hands the intake's preexisting_untracked_blobs to the backstop, so the user's untouched untracked file stays out of the commit.
  test("hung worker: a pre-run untracked file listed in the intake blobs is left out of the backstop commit", async () => {
    const { dir, baseSha } = repoWithCommit();
    writeFileSync(join(dir, "user-notes.txt"), "mine\n");
    const blob = execFileSync("git", ["hash-object", "user-notes.txt"], { cwd: dir, encoding: "utf8" }).trim();
    const mode = (statSync(join(dir, "user-notes.txt")).mode & 0o777).toString(8);
    const intake = `console.log(JSON.stringify({ type: "stage.completed", stage: "intake", data: { base_sha: ${JSON.stringify(baseSha)}, preexisting_untracked: ["user-notes.txt"], preexisting_untracked_blobs: { "user-notes.txt": ${JSON.stringify(`${blob} ${mode}`)} } } }));`;
    const code = `
      ${intake}
      require("node:fs").writeFileSync("a.txt", "changed\\n");
      setInterval(() => {}, 1000);
    `;
    const workDir = mkdtempSync(join(tmpdir(), "e10-bs-out-"));
    roots.push(workDir);
    const runDir = join(dir, ".loki", "runs", "e10-bs-untracked");
    const pushScriptPath = writePushStub(workDir, join(workDir, "push-calls.log"));
    const r = await runSupervisor({ runId: "e10-bs-untracked", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 2, graceS: 1, pr: realPr(pushScriptPath, runDir) });
    expect(r.verdict).toBe("FAILED");
    const changed = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort();
    expect(changed).toEqual(["a.txt"]);
    expect(readFileSync(join(dir, "user-notes.txt"), "utf8")).toBe("mine\n");
  }, 10_000);

  // Finding 2 in isolation (no tracked change at all): on the pre-fix merge, hasPushableDiff's
  // `git diff` sees nothing, so opts.pr is never even called (0 calls) -- the run just prints and
  // vanishes, exactly the bug E-67 exists to close. Proves untracked-only work is not just
  // undercounted in the diff but drops the PR entirely without the backstop commit.
  test("hung worker leaves only an untracked file (no tracked change): kept in the local backstop commit, not pushed", async () => {
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
    expect(r.prUrl).toBeNull();
    const changed = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n").sort();
    expect(changed).toEqual(["untracked.txt"]);
  }, loadAwareTimeoutMs(10_000));

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
  }, loadAwareTimeoutMs(10_000));

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
    const deathMs = await pollDeathMs(t0, pidFile, loadAwareTimeoutMs(6000));
    const r = await done;
    expect(deathMs).toBeGreaterThan(0);
    expect(deathMs).toBeGreaterThan(backstopS(5) * 1000 - 300); // fires near its computed instant, not at spawn
    expect(deathMs).toBeLessThan(loadAwareTimeoutMs(6000)); // headroom only (scaled with load); the regression guard is the lower bound above, the SIGTERM->SIGKILL gap is guarded in bs10
    expect(r.verdict).toBe("FAILED");
    expect(r.notProven).toContain(BACKSTOP_NOT_PROVEN);
  }, loadAwareTimeoutMs(10_000));

  // E-67 finding 1 follow-up: the SIGTERM->SIGKILL escalation used to be a fixed 2s regardless of
  // the cap, so a worker that traps SIGTERM (ignores it, only SIGKILL ends it) at a small capS still
  // got its full 2s before SIGKILL -- past the cap (capS=5: backstop ~4.83s, old SIGKILL ~6.83s).
  // Red on the pre-fix fixed 2000ms escalation (death near 6.8s); green once escalateMs clamps to
  // the time remaining before the cap (capS*1000 - backstopMs).
  test("small capS, default grace: a SIGTERM-trapping worker still dies at or before the cap", async () => {
    const { dir } = repoWithCommit();
    const pidFile = join(dir, "worker.pid");
    const termFile = join(dir, "sigterm.ms");
    const code = `
      process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(termFile)}, String(Date.now())); });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const t0 = Date.now();
    const done = runSupervisor({ runId: "e10-bs10", repoDir: dir, env: ENV, workerArgv: worker(code), capS: 5 });
    const deathMs = await pollDeathMs(t0, pidFile, loadAwareTimeoutMs(8000));
    const r = await done;
    expect(deathMs).toBeGreaterThan(0);
    // Load independent: the SIGTERM->SIGKILL gap is measured from the worker's own signal timestamp,
    // so machine load shifts both ends together. Clamped escalateMs is ~170ms at capS=5; the pre-fix
    // fixed 2000ms escalation can never measure below 2000ms, so a 1000ms bound separates them at any load.
    const gapMs = t0 + deathMs - Number(readFileSync(termFile, "utf8"));
    expect(gapMs).toBeLessThan(1000);
    expect(r.verdict).toBe("FAILED");
  }, loadAwareTimeoutMs(15_000));

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
    }, loadAwareTimeoutMs(30_000));
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
  test("a red suite that ends PARTIAL exits 6 (was 0: only FAILED exited non-zero)", async () => {
    const { r, exit } = await ladder(() => `${verifyRed("t::a")}${sealedAs("PARTIAL")}`);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.outcome).toBe("PARTIAL"); // FC-21 (d): the outcome is the receipt verdict
    expect(exit).toBe(6);
    expect(r.receiptSha).toBe("ab".repeat(32));
  });
  test("VERIFIED and ALREADY_SATISFIED exit 0", async () => {
    expect((await ladder(() => sealedAs("VERIFIED"))).exit).toBe(0);
    expect((await ladder(() => sealedAs("ALREADY_SATISFIED"))).exit).toBe(0);
  });
  test("a cap.hit run with a sealed receipt keeps the receipt verdict (L7), exit 6, and reports stop cap", async () => {
    const { r, exit } = await ladder(() => `${ev("cap.hit", "implement", {})}${sealedAs("PARTIAL")}`);
    expect(r.outcome).toBe("PARTIAL");
    expect(r.stop).toBe("cap");
    expect(exit).toBe(6);
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
  test("FV-gh-steer-3: a status step replaces the failure comment; blocked carries its question, and the PR link and final outcome each project once", async () => {
    const comment = commentSpy(), seen: { prUrl?: string | null; outcome?: string; reason?: string }[] = [];
    const status = async (p: { prUrl?: string | null; outcome?: string; reason?: string }): Promise<{ argv: string[]; ok: boolean }> => { seen.push(p); return { argv: ["issue-comment", "--update"], ok: true }; };
    const { r } = await ladder(() => `${COMMIT_A_CHANGE}${ev("stage.completed", "implement", { spec_conflict_reason: "A or B?" })}${sealedAs("SPEC_CONFLICT")}`,
      { started: { task_source: "issue", issue_ref: "acme/widget#7" }, pr: prSpy().step, comment: comment.step, status });
    expect(r.outcome).toBe("BLOCKED");
    expect(comment.calls).toEqual([]);
    expect(seen).toEqual([{ prUrl: null, outcome: "BLOCKED", reason: "spec conflict: A or B?" }]); // no PR step ran, so only the final outcome projects
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
  test("a BLOCKED run with a diff opens no PR (FC-NO-PUSH-UNVERIFIED) and the comment claims none", async () => {
    const comment = commentSpy(), pr = prSpy();
    const { r } = await ladder(() => `${COMMIT_A_CHANGE}${ev("stage.completed", "implement", { spec_conflict_reason: "A or B?" })}${sealedAs("SPEC_CONFLICT")}`,
      { started: { task_source: "issue", issue_ref: "acme/widget#7" }, pr: pr.step, comment: comment.step });
    expect(r.prUrl).toBeNull();
    expect(pr.calls.length).toBe(0);
    expect(comment.calls[0]!.prUrl).toBeUndefined();
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
  }, loadAwareTimeoutMs(10_000));

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
  }, loadAwareTimeoutMs(10_000));
});

describe("GAME10-05a: per-stage capability map", () => {
  type Cap = { stage: string; secrets: string[]; can_push: boolean | "unknown"; network: boolean | "unknown" };
  const SECRET_VALUE = "ghp_realtokenvalue0123456789abcdefABCD";
  const ANTH_VALUE = "sk-ant-secretvalue-0123456789";
  const BOT_VALUE = "ghp_bottokenvalue0123456789abcdefABCDEF";
  const emptyHome = (): string => { const h = mkdtempSync(join(tmpdir(), "e10-cap-home-")); roots.push(h); return h; };
  const homeWith = (files: Record<string, string>): string => { const h = emptyHome(); for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(h, rel)), { recursive: true }); writeFileSync(join(h, rel), body); } return h; };
  const cleanEnv = (home: string): NodeJS.ProcessEnv => ({ ...ENV, HOME: home, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined, GH_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_GLOBAL: undefined, LOKI_PR_BOT_TOKEN: undefined });
  const recorded = (dir: string, runId: string): { raw: string; stages: Cap[] } => {
    const raw = readFileSync(join(dir, ".loki", "runs", runId, "events.jsonl"), "utf8");
    const recs = raw.split("\n").filter((l) => l.includes('"capability.recorded"')).map((l) => JSON.parse(l) as { data: { stages: Cap[] } });
    return { raw, stages: recs.flatMap((r) => r.data.stages) };
  };
  async function capsFor(runId: string, env: NodeJS.ProcessEnv): Promise<{ stages: Cap[]; raw: string }> {
    const { dir, baseSha } = repoWithCommit();
    await runSupervisor({ runId, repoDir: dir, env, workerArgv: worker(`${intakeLine(baseSha)} process.exit(1);`), capS: 20, graceS: 5 });
    return recorded(dir, runId);
  }
  /** A VERIFIED run whose pr hook is the real runPr against a stub push script, wired the way main()'s closure wires it. */
  async function prCaps(runId: string, env: NodeJS.ProcessEnv, deep = false): Promise<{ stages: Cap[]; raw: string }> {
    const { dir, baseSha } = repoWithCommit();
    const code = `${intakeLine(baseSha)} ${COMMIT_A_CHANGE} console.log(JSON.stringify({ type: "receipt.sealed", stage: "seal", data: { verdict: "VERIFIED", not_proven: [] } })); process.exit(0);`;
    const workDir = mkdtempSync(join(tmpdir(), "e10-cap-out-")); roots.push(workDir);
    const pushScriptPath = writePushStub(workDir, join(workDir, "push-calls.log"));
    const runDir = join(dir, ".loki", "runs", runId);
    const step: PrStep = async (p) => {
      const r = await runPr({ runId: p.runId, repoDir: p.repoDir, runDir, branch: `loki/${p.runId}`, pinnedOrigin: p.pushEnv._LOKI_PINNED_ORIGIN, outputs: () => ({ seal: { verdict: p.verdict, not_proven: p.notProven } }), capHit: () => false, emit: () => {} } as unknown as PrContext, new AbortController().signal, { pushScriptPath, onSpawnEnv: p.recordSpawnEnv });
      return r.status === "completed" ? { url: (r.data as { pr_url?: string }).pr_url ?? null, draft: false, existing: null } : { url: null, draft: false, existing: null, notProven: [`PR not opened: ${r.reason}`] };
    };
    await runSupervisor({ runId, repoDir: dir, env, workerArgv: worker(code), capS: 20, graceS: 5, pr: step, ...(deep ? { deepArgv: worker("process.exit(0)") } : {}) });
    return recorded(dir, runId);
  }
  const withProcessEnv = async (patch: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(patch)) { saved[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
    try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };

  test("worker stages record unknown, never false: their env is a copy of the supervisor env, not an allowlist env; no value is recorded", async () => {
    const r = await capsFor("e10-cap-withheld", { ...cleanEnv(emptyHome()), GH_TOKEN: SECRET_VALUE, ANTHROPIC_API_KEY: ANTH_VALUE });
    for (const st of ["intake", "plan", "wall", "implement", "verify", "commit", "seal"]) expect(r.stages.some((s) => s.stage === st)).toBe(true);
    expect(r.stages.every((s) => s.can_push === "unknown" && s.network === "unknown")).toBe(true);
    expect(r.stages.every((s) => s.secrets.includes("ANTHROPIC_API_KEY"))).toBe(true);
    expect(r.raw).not.toContain(SECRET_VALUE); expect(r.raw).not.toContain(ANTH_VALUE);
  }, loadAwareTimeoutMs(20_000));

  test("review 1: the pr stage is recorded from the env it spawns with, so bot author plus LOKI_PR_BOT_TOKEN records can_push true while the supervisor env holds no token", async () => {
    await withProcessEnv({ LOKI_PR_AUTHOR: "bot", LOKI_PR_BOT_TOKEN: BOT_VALUE, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined }, async () => {
      const r = await prCaps("e10-cap-bot", cleanEnv(emptyHome()));
      const pr = r.stages.find((s) => s.stage === "pr");
      expect(pr).toBeDefined(); expect(pr!.can_push).toBe(true); expect(pr!.secrets).toContain("LOKI_PR_BOT_TOKEN"); expect(pr!.secrets).toContain("GH_TOKEN");
      expect(r.stages.filter((s) => s.stage !== "pr").every((s) => s.can_push !== true)).toBe(true);
      expect(r.raw).not.toContain(BOT_VALUE);
    });
  }, loadAwareTimeoutMs(30_000));

  test("round 3: with no token and a bare HOME the real pr spawn env still records unknown, never false", async () => {
    const noTok = { LOKI_PR_AUTHOR: undefined, LOKI_PR_BOT_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined, GH_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_GLOBAL: undefined };
    const bareHome = emptyHome();
    await withProcessEnv({ ...noTok, HOME: bareHome }, async () => {
      const r = await prCaps("e10-cap-none", cleanEnv(bareHome));
      expect(r.stages.find((s) => s.stage === "pr")!.can_push).toBe("unknown");
    });
  }, loadAwareTimeoutMs(60_000));

  test("round 3: the real worker, deep and pr spawn envs are not helper-built, so every one records unknown, never false", async () => {
    const bareHome = emptyHome();
    await withProcessEnv({ LOKI_PR_AUTHOR: undefined, LOKI_PR_BOT_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined, HOME: bareHome }, async () => {
      const r = await prCaps("e10-cap-deep", cleanEnv(bareHome), true);
      for (const st of ["intake", "wall", "seal", "deep", "pr"]) expect(r.stages.some((s) => s.stage === st)).toBe(true);
      expect(r.stages.every((s) => s.can_push === "unknown" && s.network === "unknown")).toBe(true);
    });
  }, loadAwareTimeoutMs(60_000));

  test("review 3: LOKI_OFFLINE and LOKI_NO_NETWORK are declarations, not isolation, so the recorded network is never false", async () => {
    const r = await capsFor("e10-cap-offline", { ...cleanEnv(emptyHome()), LOKI_OFFLINE: "1", LOKI_NO_NETWORK: "1" });
    expect(r.stages.every((s) => s.network === "unknown")).toBe(true);
  }, loadAwareTimeoutMs(20_000));

  // --- round 3: fail closed. Each row is one input the round-2 review showed understating a stage; every case must NOT record false. ---
  const runTmp = (): string => { const d = mkdtempSync(join(tmpdir(), "loki-run.")); roots.push(d); writeFileSync(join(d, ".loki-run-owned"), `${d}\n`); return d; };
  const withRunTmp = <T>(d: string, fn: () => T): T => { const saved = process.env.LOKI_RUN_TMP; process.env.LOKI_RUN_TMP = d; try { return fn(); } finally { if (saved === undefined) delete process.env.LOKI_RUN_TMP; else process.env.LOKI_RUN_TMP = saved; } };
  const NO_NET = ["unshare", "-n", "bun", "worker.ts"], BARE = ["bun", "worker.ts"];
  /** An env that satisfies every can_push-false condition: allowlist names only, run-owned HOME, no system git config, global git config /dev/null. */
  const sealedEnv = (home: string): NodeJS.ProcessEnv => buildStageEnv(home, { PATH: "/usr/bin" });
  /** The same names and values but not returned by the helper: a forged lookalike. */
  const forgedEnv = (home: string): NodeJS.ProcessEnv => ({ ...sealedEnv(home) });
  /** A helper-built env patched in place (undefined deletes), so the object stays a helper product while one input is bent. */
  const bent = (home: string, patch: NodeJS.ProcessEnv): NodeJS.ProcessEnv => { const e = sealedEnv(home); for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete e[k]; else e[k] = v; } return e; };
  type Case = { env?: NodeJS.ProcessEnv; argv?: string[]; setup?: (home: string) => void };
  const SBPL_ALLOW_AFTER = "(version 1)(deny network*)(allow network*)", SBPL_COMMENT_ONLY = "(version 1)\n; (deny network*)\n", SBPL_DENY = "(version 1)(deny network*)";
  const SBPL_EVAL_ALLOW = "(version 1)(deny network*)(deny file-read-data (begin ((eval (string->symbol (string-append \"al\" \"low\"))) default) ((eval (string->symbol (string-append \"al\" \"low\"))) network*) (literal \"/nonexistent-x\")))"; // round 3 security: SBPL is a Scheme, so an allow can be built at runtime
  const rows: { finding: string; field: "can_push" | "network" | "secrets"; cases: Case[]; check?: (c: Cap) => boolean }[] = [
    { finding: "1 SSH_AUTH_SOCK set", field: "can_push", cases: [{ env: { SSH_AUTH_SOCK: "/tmp/agent.sock" } }, { env: { SSH_AUTH_SOCK: "/tmp/agent.sock" }, argv: NO_NET }] },
    { finding: "2 key in ~/.ssh or GIT_SSH_COMMAND", field: "can_push", cases: [{ env: { GIT_SSH_COMMAND: "ssh -i /k" } }, { env: { GIT_SSH_COMMAND: "ssh -i /k" }, argv: NO_NET }, { setup: (h) => { mkdirSync(join(h, ".ssh")); writeFileSync(join(h, ".ssh", "id_ed25519"), "k"); } }] },
    { finding: "3 credential.helper in the repo .git/config", field: "can_push", cases: [{ setup: (h) => { mkdirSync(join(h, "repo", ".git"), { recursive: true }); writeFileSync(join(h, "repo", ".git", "config"), "[credential]\n\thelper = store\n"); } }] },
    { finding: "4 credential helper in the system gitconfig", field: "can_push", cases: [{ env: { GIT_CONFIG_NOSYSTEM: undefined } }] },
    { finding: "5 GIT_CONFIG_PARAMETERS or GIT_CONFIG_KEY_n carrying a helper", field: "can_push", cases: [{ env: { GIT_CONFIG_PARAMETERS: "'credential.helper=store'" } }, { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "store" } }, { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "store" }, argv: NO_NET }] },
    { finding: "6 GIT_ASKPASS set", field: "can_push", cases: [{ env: { GIT_ASKPASS: "/bin/askpass" } }, { env: { GIT_ASKPASS: "/bin/askpass" }, argv: NO_NET }] },
    { finding: "7 GITLAB_TOKEN or LOKI_PR_BOT_TOKEN alone", field: "can_push", cases: [{ env: { GITLAB_TOKEN: SECRET_VALUE } }, { env: { LOKI_PR_BOT_TOKEN: BOT_VALUE } }, { env: { LOKI_PR_BOT_TOKEN: BOT_VALUE }, argv: NO_NET }], check: (c) => c.can_push === true },
    { finding: "8 secrets misses GH_PAT, NPM_CONFIG__AUTH, OPENAI_KEY, DATABASE_URL, MY_API_KEY", field: "secrets", cases: [{ env: { GH_PAT: "x", NPM_CONFIG__AUTH: "x", OPENAI_KEY: "x", DATABASE_URL: "postgres://u:p@h/db", MY_API_KEY: "1" } }], check: (c) => ["GH_PAT", "NPM_CONFIG__AUTH", "OPENAI_KEY", "DATABASE_URL", "MY_API_KEY"].every((n) => (c.secrets as string[]).includes(n)) },
    { finding: "9 unshare -r with the inner -n, firejail with the inner --net=none", field: "network", cases: [{ argv: ["unshare", "-r", "bun", "worker.ts", "-n", "3"] }, { argv: ["firejail", "bun", "w.ts", "--net=none"] }] },
    { finding: "10 bwrap --unshare-all --share-net", field: "network", cases: [{ argv: ["bwrap", "--unshare-all", "--share-net", "bun", "w.ts"] }] },
    { finding: "11 sandbox-exec -p with a later allow", field: "network", cases: [{ argv: ["sandbox-exec", "-p", SBPL_ALLOW_AFTER, "bun", "w.ts"] }] },
    { finding: "12 sandbox-exec -p with the deny only in a comment", field: "network", cases: [{ argv: ["sandbox-exec", "-p", SBPL_COMMENT_ONLY, "bun", "w.ts"] }] },
    { finding: "13 sandbox-exec -p with an allow built by string-append and eval", field: "network", cases: [{ argv: ["sandbox-exec", "-p", SBPL_EVAL_ALLOW, "bun", "w.ts"] }], check: (c) => c.network === "unknown" && c.can_push === "unknown" },
  ];
  test.each(rows.map((r) => [r.finding, r] as const))("round 3 negative control, finding %s: never recorded as false", (_n, row) => {
    for (const c of row.cases) {
      const root = runTmp(), home = join(root, "home"); mkdirSync(home);
      c.setup?.(home);
      const env = bent(home, c.env ?? {});
      const cap = withRunTmp(root, () => stageCapability("x", env, c.argv ?? BARE)) as Cap;
      if (row.check) expect(row.check(cap)).toBe(true); else expect((cap as unknown as Record<string, unknown>)[row.field]).not.toBe(false);
    }
  });

  test("round 3 positive control: false is returned when it is proven, for the allowlist env and for each strict wrapper", () => {
    const root = runTmp(), home = join(root, "home"); mkdirSync(home);
    withRunTmp(root, () => {
      expect(stageCapability("x", sealedEnv(home), NO_NET)).toEqual({ stage: "x", secrets: [], can_push: false, network: false });
      for (const argv of [["unshare", "--net", "bun"], ["unshare", "-rn", "bun"], ["bwrap", "--unshare-net", "bun"], ["bwrap", "--unshare-all", "--bind", "/", "/", "bun"], ["bwrap", "--share-net", "--unshare-all", "bun"], ["firejail", "--quiet", "--net=none", "bun"], ["/usr/bin/firejail", "--net=none", "--", "bun"]]) expect(stageCapability("x", sealedEnv(home), argv).network).toBe(false);
      for (const argv of [["sandbox-exec", "-p", SBPL_DENY, "bun"], ["sandbox-exec", "-D", "A=b", "-p", "(version 1)\n(deny network*) ; no net", "bun"], ["sandbox-exec", "-p", SBPL_EVAL_ALLOW, "bun"]]) expect(stageCapability("x", sealedEnv(home), argv)).toMatchObject({ network: "unknown", can_push: "unknown" }); // SBPL is never read, even from the buildStageEnv env
    });
  });

  test("round 3: can_push stays unknown when any one of the four conditions fails", () => {
    const root = runTmp(), home = join(root, "home"); mkdirSync(home); const other = emptyHome();
    withRunTmp(root, () => {
      const unknown = (env: NodeJS.ProcessEnv, argv: string[] = NO_NET): unknown => stageCapability("x", env, argv).can_push;
      expect(unknown(bent(home, { HOME: other }))).toBe("unknown"); // HOME is not run-owned
      expect(unknown(bent(home, { HOME: undefined }))).toBe("unknown");
      expect(unknown(bent(home, { GIT_CONFIG_NOSYSTEM: undefined }))).toBe("unknown");
      expect(unknown(bent(home, { GIT_CONFIG_GLOBAL: "/etc/gitconfig" }))).toBe("unknown");
      expect(unknown(bent(home, { EXTRA: "1" }))).toBe("unknown"); // passthrough beyond the allowlist
      expect(unknown(sealedEnv(home), BARE)).toBe("unknown"); // network not proven cut
      expect(unknown(forgedEnv(home))).toBe("unknown"); // right HOME, GIT_CONFIG_* and safe names, but not built by the helper
      expect(unknown(Object.assign(forgedEnv(home), { LOKI_STAGE_ENV_BUILT: "1", __built: "true" }))).toBe("unknown"); // no env var or property can forge the mark
    });
    expect(contribCapability("x", sealedEnv(home), NO_NET, undefined).can_push).toBe("unknown"); // no run-owned directory known
  });

  test("round 3: network parse reads only the wrapper's own leading flags and abandons on anything it cannot place", () => {
    const net = (argv: string[]): unknown => stageCapability("x", {}, argv).network;
    for (const argv of [[], ["bun", "w.ts"], ["unshare"], ["unshare", "--net=/proc/1/ns/net", "bun"], ["unshare", "-S", "0", "-n", "bun"], ["unshare", "--", "-n", "bun"], ["bwrap", "bun"], ["bwrap", "--unshare-net", "--frobnicate", "bun"], ["bwrap", "--args", "3", "bun"], ["firejail", "--net=none", "--net=eth0", "bun"], ["firejail", "--net=none", "--ignore=net", "bun"], ["sandbox-exec", "-f", "p.sb", "bun"], ["sandbox-exec", "-n", "no-network", "bun"], ["sandbox-exec", "-p", "\"(deny network*)\"", "bun"], ["sandbox-exec", "-p", "(version 1)(deny network*", "bun"], ["sandbox-exec", "-p", "(version 1)(deny network*)(import \"x.sb\")", "bun"], ["sandbox-exec", "-p", "(version 1)(deny network*)(if #t (allow network*))", "bun"], ["docker", "run", "--network", "none", "bun"], ["env", "unshare", "-n", "bun"]]) expect(net(argv)).toBe("unknown");
  });

  test("round 3: secrets is the child env names outside the one safe list, whatever they are called", () => {
    const c = stageCapability("x", { PATH: "/usr/bin", HOME: "/h", LOKI_ALLOW_AGENT_GITHUB_TOKEN: "1", ANTHROPIC_API_KEY: ANTH_VALUE, FOO: "bar", GONE: undefined });
    expect(c.secrets).toEqual(["ANTHROPIC_API_KEY", "FOO", "LOKI_ALLOW_AGENT_GITHUB_TOKEN"]);
    expect(JSON.stringify(c)).not.toContain(ANTH_VALUE);
  });

  test("round 3: with no contrib registered a capability is unknown everywhere", async () => {
    const { hooks } = await import("../../src/engine10/hooks.ts"); const saved = hooks.stageCapability; delete hooks.stageCapability;
    try { expect(stageCapability("x", { GH_TOKEN: "t" }, NO_NET)).toEqual({ stage: "x", secrets: "unknown", can_push: "unknown", network: "unknown" }); } finally { hooks.stageCapability = saved; }
  });

  test("review 4: the worker emits capability.observed for every worker stage, from the env it really runs with, as its first line", async () => {
    const child = spawn(process.execPath, [...SAFE_BUN_FLAGS, resolve(import.meta.dir, "../../src/cli.ts"), "engine10", "worker", "e10-cap-observed", "claude", "m", "fast"], { cwd: repoWithCommit().dir, env: { ...cleanEnv(emptyHome()), LOKI_CLAUDE_CLI: "/usr/bin/true", ANTHROPIC_API_KEY: ANTH_VALUE, LOKI_E10_CAP_S: "5" }, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const first = await new Promise<string>((res, rej) => { const t = setTimeout(() => rej(new Error("no line from worker")), loadAwareTimeoutMs(20_000)); createInterface({ input: child.stdout! }).once("line", (l) => { clearTimeout(t); res(l); }); child.once("exit", () => { clearTimeout(t); rej(new Error("worker exited with no line")); }); });
      const ev = JSON.parse(first) as { type: string; stage: string | null; data: { stages: Cap[] } };
      expect(ev.type).toBe("capability.observed");
      expect(ev.data.stages.map((s) => s.stage)).toEqual(workerStages());
      expect(ev.data.stages.every((s) => s.secrets.includes("ANTHROPIC_API_KEY") && s.can_push === "unknown" && s.network === "unknown")).toBe(true);
      expect(first).not.toContain(ANTH_VALUE);
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
  }, loadAwareTimeoutMs(30_000));

  test("a capability.recorded line forged by the worker never enters the log", async () => {
    const { dir, baseSha } = repoWithCommit();
    await runSupervisor({ runId: "e10-cap-forge", repoDir: dir, env: cleanEnv(emptyHome()), workerArgv: worker(`${intakeLine(baseSha)} console.log(JSON.stringify({ type: "capability.recorded", stage: null, data: { stages: [{ stage: "forged", secrets: [], can_push: true, network: false }] } })); process.exit(1);`), capS: 20, graceS: 5 });
    expect(recorded(dir, "e10-cap-forge").stages.some((s) => s.stage === "forged")).toBe(false);
  }, loadAwareTimeoutMs(20_000));
});
