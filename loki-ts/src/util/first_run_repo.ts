// TEN-UX-01: first run in a truly empty folder becomes a git repo (init, branch main, first commit); anything else is never touched.
import { readdirSync } from "node:fs";
import { safeGitRun } from "./safe_git.ts";

export const NOT_A_REPO = (dir: string): string => `not a git repository: ${dir} is not inside a git work tree; run loki from inside a git checkout`;
const NON_EMPTY_FIX = (dir: string): string => `${NOT_A_REPO(dir)}. This folder is not empty, so loki will not initialise it; run: git init && git add . && git commit -m init`;

// OS metadata files Finder/Explorer drop into a folder the user considers empty.
const OS_METADATA = new Set([".DS_Store", ".localized", "Thumbs.db", "desktop.ini"]);

/** Files a Loki command wrote into the folder just before the run (LOKI_FIRST_RUN_FILES, comma-separated names:
 * `loki quickstart` and `loki demo` set it for the PRD they wrote). They still count as empty and go in the first commit. */
const firstRunFiles = (env: Record<string, string | undefined>): Set<string> =>
  new Set((env["LOKI_FIRST_RUN_FILES"] ?? "").split(",").map((f) => f.trim()).filter((f) => f !== "" && !f.includes("/") && f !== "." && f !== ".."));

/** Returns the one-line notice when the folder was initialised, or a fatal message when it was left alone. */
export async function initEmptyRepo(dir: string, env: Record<string, string | undefined>): Promise<{ notice?: string; fatal?: string }> {
  if (env["LOKI_AUTO_GIT_INIT"] === "0") return { fatal: NOT_A_REPO(dir) };
  const ours = firstRunFiles(env);
  let empty = false, written: string[] = [];
  try { const all = readdirSync(dir); written = all.filter((f) => ours.has(f)); empty = all.every((f) => OS_METADATA.has(f) || ours.has(f)); } catch { /* unreadable: not ours to init */ }
  if (!empty) return { fatal: NON_EMPTY_FIX(dir) };
  const git = (a: string[]) => safeGitRun(dir, a, { env, timeoutMs: 10000 });
  if ((await git(["init", "-q"])).exitCode !== 0) return { fatal: NOT_A_REPO(dir) };
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  // L009: a machine with no git identity still gets its first run. The identity is set in this new repo only; the user's own config is never touched.
  const [name, email] = await Promise.all([git(["config", "user.name"]), git(["config", "user.email"])]);
  const localId = !name.stdout.trim() || !email.stdout.trim();
  if (localId) { await git(["config", "user.name", "Loki Mode"]); await git(["config", "user.email", "loki@localhost"]); }
  if (written.length > 0) { await git(["add", "--", ...written]); await git(["commit", "-q", "-m", "init"]); }
  else await git(["commit", "-q", "--allow-empty", "-m", "init"]);
  return { notice: `initialized a new git repository in ${dir} (LOKI_AUTO_GIT_INIT=0 to refuse)${localId ? `; no git identity was set, so this repo uses "Loki Mode <loki@localhost>" (git config user.name/user.email to change it)` : ""}` };
}
