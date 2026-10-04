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
