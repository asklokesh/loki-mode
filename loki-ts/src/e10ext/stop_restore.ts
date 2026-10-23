// D50-F1c: on SIGINT/SIGTERM the supervisor puts the user's checkout back on the branch they started on.
import { safeGit } from "../util/safe_git.ts";
export function currentBranch(repoDir: string): string | null {
  try {
    const b = safeGit(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]).trim();
    return b || null;
  } catch { return null; }
}

/** Never resets or discards: a plain `git checkout`, which refuses when it would overwrite edits. The run branch and its commits stay. */
export function restoreBranch(repoDir: string, orig: string | null): void {
  if (!orig) return;
  const run = currentBranch(repoDir);
  if (run === orig) return;
  try {
    // a checkout would carry the run's uncommitted edits onto the user's branch, so switch back only when the tracked tree is clean
    if (safeGit(repoDir, ["status", "--porcelain", "--untracked-files=no"], { stdio: ["ignore", "pipe", "pipe"] }).trim()) throw new Error("dirty");
    safeGit(repoDir, ["checkout", orig], { stdio: "ignore" });
  } catch { process.stderr.write(`engine10: stopped; tree left on run branch ${run ?? "(detached)"}, return with: git checkout ${orig}\n`); }
}

/** End of a run: back to the user's branch when the run failed or kept nothing, then drop the run branch only if its tip is still the base (zero commits). A branch with commits is never deleted; `-d` also refuses an unmerged one. */
export function restoreAfterRun(repoDir: string, orig: string | null, runBranch: string, baseSha: string | null, failed: boolean): void {
  if (!orig || orig === runBranch) return;
  let tip = "";
  try { tip = safeGit(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/${runBranch}`], { stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return; }
  const empty = baseSha !== null && tip === baseSha;
  if (currentBranch(repoDir) !== runBranch) { if (empty) dropEmpty(repoDir, runBranch); return; }
  if (!failed && !empty) return;
  restoreBranch(repoDir, orig);
  if (empty && currentBranch(repoDir) === orig) dropEmpty(repoDir, runBranch);
}
function dropEmpty(repoDir: string, runBranch: string): void {
  try { safeGit(repoDir, ["branch", "-d", runBranch], { stdio: "ignore" }); } catch { /* unmerged or gone: leave it */ }
}
