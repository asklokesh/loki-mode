// Shared by the commit stage and the supervisor backstop: which staged paths a run must never publish.
import { dirname } from "node:path";
import { untouchedSinceIntake } from "./preexisting_dirty.ts"; import { untouchedUntracked } from "../features/untouched_untracked.ts";
import { installOwned } from "../project_model/install.ts"; import { toolchainOutputs } from "../util/lock_ecosystems.ts";
import { runFormatters } from "../runner/repo_profile.ts";
import { safeGit, tokenFreeEnv } from "../util/safe_git.ts";

export const WALL_FILE = /(^|\/)loki_wall_[^/]*$/; // a Wall test file: the commit stage never publishes it
export type Staged = { st: string; f: string };

/** Parses `git diff --cached --name-status --no-renames -z` output. */
export const parseStaged = (out: string): Staged[] => out.split("\0").reduce<Staged[]>((a, t, i, all) => (i % 2 === 0 && t ? [...a, { st: t, f: all[i + 1]! }] : a), []);

/** .loki/, intake-time dirt the run left untouched ("L"), Wall files, and a NEW lockfile with no manifest change in its own directory. */
export function dropSet(repoDir: string, staged: Staged[], preexistingDirty: unknown, env: NodeJS.ProcessEnv = process.env, installCreated?: unknown, untrackedBlobs?: unknown, baseSha?: string): Staged[] {
  const owned = installOwned(repoDir, installCreated, env), made: object = (installCreated as { files?: object } | null | undefined)?.files ?? {}, tc = toolchainOutputs(repoDir, staged.filter(({ st }) => st === "A").map(({ f }) => f), baseSha); // FC-DEPS-NOT-INSTALLED: what the install made and the run left alone is dropped; an edited one is the run's change, lockfile rule included
  return staged.concat(untouchedSinceIntake(repoDir, preexistingDirty, env).map((f) => ({ st: "L", f })), untouchedUntracked(repoDir, untrackedBlobs, env).map((f) => ({ st: "L", f })), staged.filter(({ f }) => owned(f)).map(({ f }) => ({ st: "L", f }))).filter(({ st, f }) => f.startsWith(".loki/") || st === "L" || WALL_FILE.test(f) || (st === "A" && tc.has(f)) || (st === "A" && !Object.hasOwn(made, f) && !staged.some(({ f: m }) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod)$/.test(m) && dirname(m) === dirname(f)) && /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum)$/.test(f)));
}

/** TEN-QUALITY-16: format only the files the run added or modified and kept (not dropped, deleted or under .loki/) with the repo's own configured formatter; returns them for re-staging. */
export const formatChanged = (repoDir: string, staged: Staged[], dropped: Set<string>, env: NodeJS.ProcessEnv = process.env): string[] =>
  runFormatters(repoDir, staged.filter(({ st, f }) => (st === "A" || st === "M") && !dropped.has(f) && !f.startsWith(".loki/")).map(({ f }) => f), tokenFreeEnv(env));

/** Commits whatever a killed or crashed worker left uncommitted or untracked (minus .loki), so it
 *  reaches the pushed branch: `git diff` alone misses untracked files, and nothing pushes a tree
 *  that was never committed. Withheld-token env, hooks/fsmonitor off (repoDir/.git is agent-writable).
 *  A clean tree, or add/reset failing, is a no-op: best-effort, never the reason a run fails. */
export function backstopCommit(repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: string, preexistingDirty: unknown, installCreated?: unknown, untrackedBlobs?: unknown): void {
  const g = (args: string[]) => safeGit(repoDir, args, { env: workerEnv, stdio: "ignore" });
  try {
    g(["add", "-A", "--", "."]);
    // same exclusions as the commit stage (A-104c): pre-run dirt, Wall files, stray lockfiles, .loki
    const staged = parseStaged(safeGit(repoDir, ["diff", "--cached", "--name-status", "--no-renames", "-z", base], { env: workerEnv }));
    const drop = dropSet(repoDir, staged, preexistingDirty, workerEnv, installCreated, untrackedBlobs);
    if (drop.length > 0) g(["--literal-pathspecs", "reset", "-q", base, "--", ...drop.map(({ f }) => f)]);
    g(["diff", "--cached", "--quiet"]);
  } catch (err) {
    if ((err as { status?: number }).status !== 1) return; // add/reset failed, or truly nothing staged
    try { g(["commit", "-q", "-m", `loki: backstop commit (${runId})`, "-m", `Loki-Run: ${runId}`]); } catch { /* best-effort */ }
  }
}

/** D50-F4b: base comes from the worker-written event log, so it must be a full object id before any git call (no option, no ref). */
export const validBase = (b: unknown): string | null => (typeof b === "string" && /^[0-9a-f]{40,64}$/.test(b) ? b : null);

/** Runs backstopCommit only when the log verified intact and base is valid; otherwise fails closed with no git spawn and returns why. */
export function guardedBackstop(intact: boolean, repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: unknown, preexistingDirty: unknown, installCreated?: unknown, untrackedBlobs?: unknown): string | null {
  if (!intact) return "backstop commit skipped: event log failed verification";
  const b = validBase(base);
  if (b === null) return base === null || base === undefined ? null : "backstop commit skipped: base is not a full object id";
  backstopCommit(repoDir, workerEnv, runId, b, preexistingDirty, installCreated, untrackedBlobs);
  return null;
}
