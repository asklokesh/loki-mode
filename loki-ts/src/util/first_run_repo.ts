// TEN-UX-01: first run in a truly empty folder becomes a git repo (init, branch main, first commit); anything else is never touched.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
  const isFile = (f: string): boolean => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } }; // a directory never counts as a file Loki wrote
  try { const all = readdirSync(dir); written = all.filter((f) => ours.has(f) && isFile(f)); empty = all.every((f) => OS_METADATA.has(f) || written.includes(f)); } catch { /* unreadable: not ours to init */ }
  if (!empty) return { fatal: NON_EMPTY_FIX(dir) };
  const git = (a: string[]) => safeGitRun(dir, a, { env, timeoutMs: 10000 });
  if ((await git(["init", "-q"])).exitCode !== 0) return { fatal: NOT_A_REPO(dir) };
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  // L009: a machine with no git identity still gets its first run. The identity is set in this new repo only; the user's own config is never touched.
  const [name, email] = await Promise.all([git(["config", "user.name"]), git(["config", "user.email"])]);
  const noName = !name.stdout.trim(), noEmail = !email.stdout.trim(), localId = noName || noEmail; // only the missing half is set: a user's own name is kept
  if (noName) await git(["config", "user.name", "Loki Mode"]);
  if (noEmail) await git(["config", "user.email", "loki@localhost"]);
  if (written.length > 0) { await git(["add", "--", ...written]); await git(["commit", "-q", "-m", "init"]); }
  else await git(["commit", "-q", "--allow-empty", "-m", "init"]);
  return { notice: `initialized a new git repository in ${dir} (LOKI_AUTO_GIT_INIT=0 to refuse)${localId ? `; git had no ${noName && noEmail ? "identity" : noName ? "user.name" : "user.email"}, so this repo sets ${[noName ? 'user.name "Loki Mode"' : "", noEmail ? "user.email loki@localhost" : ""].filter(Boolean).join(" and ")} (git config to change it)` : ""}` };
}
