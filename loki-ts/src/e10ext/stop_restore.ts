// D50-F1c: on SIGINT/SIGTERM the supervisor puts the user's checkout back on the branch they started on.
import { execFileSync } from "node:child_process";

export function currentBranch(repoDir: string): string | null {
  try {
    const b = execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoDir, encoding: "utf8" }).trim()) throw new Error("dirty");
    execFileSync("git", ["checkout", orig], { cwd: repoDir, stdio: "ignore" });
  } catch { process.stderr.write(`engine10: stopped; tree left on run branch ${run ?? "(detached)"}, return with: git checkout ${orig}\n`); }
}
