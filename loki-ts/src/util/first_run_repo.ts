// TEN-UX-01: first run in a truly empty folder becomes a git repo (init, branch main, empty commit); anything else is never touched.
import { readdirSync } from "node:fs";
import { safeGitRun } from "./safe_git.ts";

export const NOT_A_REPO = (dir: string): string => `not a git repository: ${dir} is not inside a git work tree; run loki from inside a git checkout`;
const NON_EMPTY_FIX = (dir: string): string => `${NOT_A_REPO(dir)}. This folder is not empty, so loki will not initialise it; run: git init && git add . && git commit -m init`;

// OS metadata files Finder/Explorer drop into a folder the user considers empty.
const OS_METADATA = new Set([".DS_Store", ".localized", "Thumbs.db", "desktop.ini"]);

/** Returns the one-line notice when the folder was initialised, or a fatal message when it was left alone. */
export async function initEmptyRepo(dir: string, env: Record<string, string | undefined>): Promise<{ notice?: string; fatal?: string }> {
  if (env["LOKI_AUTO_GIT_INIT"] === "0") return { fatal: NOT_A_REPO(dir) };
  let empty = false;
  try { empty = readdirSync(dir).every((f) => OS_METADATA.has(f)); } catch { /* unreadable: not ours to init */ }
  if (!empty) return { fatal: NON_EMPTY_FIX(dir) };
  const git = (a: string[]) => safeGitRun(dir, a, { env, timeoutMs: 10000 });
  if ((await git(["init", "-q"])).exitCode !== 0) return { fatal: NOT_A_REPO(dir) };
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["commit", "-q", "--allow-empty", "-m", "init"]); // without an identity this fails; the identity check then names the fix
  return { notice: `initialized a new git repository in ${dir} (LOKI_AUTO_GIT_INIT=0 to refuse)` };
}
