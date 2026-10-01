// Shared by the commit stage and the supervisor backstop: which staged paths a run must never publish.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { untouchedSinceIntake } from "./preexisting_dirty.ts";

export type Staged = { st: string; f: string };

/** Parses `git diff --cached --name-status --no-renames -z` output. */
export const parseStaged = (out: string): Staged[] => out.split("\0").reduce<Staged[]>((a, t, i, all) => (i % 2 === 0 && t ? [...a, { st: t, f: all[i + 1]! }] : a), []);

/** .loki/, intake-time dirt the run left untouched ("L"), Wall files, and a NEW lockfile with no manifest change in its own directory. */
export function dropSet(repoDir: string, staged: Staged[], preexistingDirty: unknown, env: NodeJS.ProcessEnv = process.env): Staged[] {
  return staged.concat(untouchedSinceIntake(repoDir, preexistingDirty, env).map((f) => ({ st: "L", f }))).filter(({ st, f }) => f.startsWith(".loki/") || st === "L" || /(^|\/)loki_wall_[^/]*$/.test(f) || (st === "A" && !staged.some(({ f: m }) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod)$/.test(m) && dirname(m) === dirname(f)) && /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum)$/.test(f)));
}

/** Commits whatever a killed or crashed worker left uncommitted or untracked (minus .loki), so it
 *  reaches the pushed branch: `git diff` alone misses untracked files, and nothing pushes a tree
 *  that was never committed. Withheld-token env, hooks/fsmonitor off (repoDir/.git is agent-writable).
 *  A clean tree, or add/reset failing, is a no-op: best-effort, never the reason a run fails. */
export function backstopCommit(repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: string, preexistingDirty: unknown): void {
  const gArgs = (args: string[]) => ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
  const g = (args: string[]) => execFileSync("git", gArgs(args), { cwd: repoDir, env: workerEnv, stdio: "ignore" });
  try {
    g(["add", "-A", "--", "."]);
    // same exclusions as the commit stage (A-104c): pre-run dirt, Wall files, stray lockfiles, .loki
    const staged = parseStaged(execFileSync("git", gArgs(["diff", "--cached", "--name-status", "--no-renames", "-z", base]), { cwd: repoDir, env: workerEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const drop = dropSet(repoDir, staged, preexistingDirty, workerEnv);
    if (drop.length > 0) g(["--literal-pathspecs", "reset", "-q", base, "--", ...drop.map(({ f }) => f)]);
    g(["diff", "--cached", "--quiet"]);
  } catch (err) {
    if ((err as { status?: number }).status !== 1) return; // add/reset failed, or truly nothing staged
    try { g(["commit", "-q", "-m", `loki: backstop commit (${runId})`, "-m", `Loki-Run: ${runId}`]); } catch { /* best-effort */ }
  }
}
