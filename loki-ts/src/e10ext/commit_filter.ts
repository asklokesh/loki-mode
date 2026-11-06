// Shared by the commit stage and the supervisor backstop: which staged paths a run must never publish.
import { lstatSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { untouchedSinceIntake } from "./preexisting_dirty.ts"; import { untouchedUntracked } from "../features/untouched_untracked.ts";
import { installOwned } from "../project_model/install.ts"; import { LOCKFILE_RE as LOCKFILE, toolchainOutputs } from "../util/lock_ecosystems.ts"; export { LOCKFILE };
import { runFormatters } from "../runner/repo_profile.ts";
import { safeGit, tokenFreeEnv } from "../util/safe_git.ts";

export const WALL_FILE = /(^|\/)loki_wall_[^/]*$/; // a Wall test file: the commit stage never publishes it
export type Staged = { st: string; f: string };

/** Parses `git diff --cached --name-status --no-renames -z` output. */
export const parseStaged = (out: string): Staged[] => out.split("\0").reduce<Staged[]>((a, t, i, all) => (i % 2 === 0 && t ? [...a, { st: t, f: all[i + 1]! }] : a), []);

export const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|Pipfile|Gemfile|composer\.json)$/; // the one manifest list; the lockfile list is util/lock_ecosystems.ts LOCKFILE_RE (imported below); util/config_paths.ts and the config write fence import both
/** A manifest changed in the lockfile's directory or beneath it (a workspace root lockfile legitimately changes when a member's manifest does). */
export const manifestChanged = (staged: Staged[], lock: string): boolean => { const d = dirname(lock); return staged.some(({ f: m }) => MANIFEST.test(m) && (d === "." || dirname(m) === d || dirname(m).startsWith(`${d}/`))); };

/** True when the task itself is a dependency change: it names the lockfile, asks to update, upgrade or bump a dependency or package, or names a CVE. Its lockfile edit is the deliverable. */
export const taskWantsLockChange = (task: string | undefined, lock: string): boolean => !!task && (task.includes(lock) || task.includes(basename(lock)) || /\bCVE-\d{4}-\d+/i.test(task) || /\b(?:update|upgrade|bump)\b[^.\n]{0,60}\b(?:dependenc\w*|packages?|lockfile|lock file|version)\b/i.test(task) || /\b(?:refresh|regenerate|re-generate|sync|rebuild)\b[^.\n]{0,40}\b(?:lockfile|lock file|lock-file)\b/i.test(task) || /\b(?:bump|upgrade)\s+[@\w./-]+\s+(?:to|from)\s+v?\d/i.test(task) || /\bpin\s+[@\w./-]+\s+(?:to|at)\s+v?\d/i.test(task) || /\b(?:lock-?file|lock file)\s+(?:merge\s+)?conflicts?\b/i.test(task) || /\bconflicts?\b[^.\n]{0,20}\b(?:in|on|of)\s+(?:the\s+)?(?:lock-?file|lock file)(?![\w-])/i.test(task) || /\bre-?install\b[^.\n]{0,30}\b(?:fix|repair)\b[^.\n]{0,30}\b(?:lock-?file|lock file)(?![\w-])/i.test(task) || /\b(?:fix|repair)\s+(?:the\s+|our\s+)?(?:lock-?file|lock file)(?![\w-])/i.test(task));

/** .loki/, intake-time dirt the run left untouched ("L"), Wall files, and a NEW or MODIFIED lockfile with no manifest change at or under its directory (install churn), unless the task is a dependency change */
export function dropSet(repoDir: string, staged: Staged[], preexistingDirty: unknown, env: NodeJS.ProcessEnv = process.env, installCreated?: unknown, untrackedBlobs?: unknown, baseSha?: string, task?: string): Staged[] {
  const owned = installOwned(repoDir, installCreated, env), made: object = (installCreated as { files?: object } | null | undefined)?.files ?? {}, tc = toolchainOutputs(repoDir, staged.filter(({ st }) => st === "A").map(({ f }) => f), baseSha); // FC-DEPS-NOT-INSTALLED: what the install made and the run left alone is dropped; an edited one is the run's change, lockfile rule included
  return staged.concat(untouchedSinceIntake(repoDir, preexistingDirty, env).map((f) => ({ st: "L", f })), untouchedUntracked(repoDir, untrackedBlobs, env).map((f) => ({ st: "L", f })), staged.filter(({ f }) => owned(f)).map(({ f }) => ({ st: "L", f }))).filter(({ st, f }) => f.startsWith(".loki/") || st === "L" || WALL_FILE.test(f) || (st === "A" && tc.has(f)) || ((st === "A" || st === "M") && !Object.hasOwn(made, f) && LOCKFILE.test(f) && !manifestChanged(staged, f) && !taskWantsLockChange(task, f)));
}

/** TEN-QUALITY-16: format only the files the run added or modified and kept (not dropped, deleted or under .loki/) with the repo's own configured formatter; returns them for re-staging. */
export const formatChanged = (repoDir: string, staged: Staged[], dropped: Set<string>, env: NodeJS.ProcessEnv = process.env): string[] =>
  runFormatters(repoDir, staged.filter(({ st, f }) => (st === "A" || st === "M") && !dropped.has(f) && !f.startsWith(".loki/")).map(({ f }) => f), tokenFreeEnv(env));

/** Commits whatever a killed or crashed worker left uncommitted or untracked (minus .loki), so it
 *  reaches the pushed branch: `git diff` alone misses untracked files, and nothing pushes a tree
 *  that was never committed. Withheld-token env, hooks/fsmonitor off (repoDir/.git is agent-writable).
 *  A clean tree, or add/reset failing, is a no-op: best-effort, never the reason a run fails. */
export function backstopCommit(repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: string, preexistingDirty: unknown, installCreated?: unknown, untrackedBlobs?: unknown, task?: string): void {
  const g = (args: string[]) => safeGit(repoDir, args, { env: workerEnv, stdio: "ignore" });
  try {
    g(["add", "-A", "--", "."]);
    // same exclusions as the commit stage (A-104c): pre-run dirt, Wall files, stray lockfiles, .loki
    const staged = parseStaged(safeGit(repoDir, ["diff", "--cached", "--name-status", "--no-renames", "-z", base], { env: workerEnv }));
    const drop = dropSet(repoDir, staged, preexistingDirty, workerEnv, installCreated, untrackedBlobs, base, task);
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
export function guardedBackstop(intact: boolean, repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: unknown, preexistingDirty: unknown, installCreated?: unknown, untrackedBlobs?: unknown, task?: string): string | null {
  if (!intact) return "backstop commit skipped: event log failed verification";
  const b = validBase(base);
  if (b === null) return base === null || base === undefined ? null : "backstop commit skipped: base is not a full object id";
  backstopCommit(repoDir, workerEnv, runId, b, preexistingDirty, installCreated, untrackedBlobs, task);
  return null;
}

/** Run safety: before the checkout returns to the user's branch, whatever the run left uncommitted (any outcome without a PR: FAILED,
 *  STALLED, BLOCKED, BUDGET_STOP, a SIGINT/SIGTERM cancel) becomes one WIP commit on its own branch, so `git checkout <start>` neither
 *  refuses nor carries the run's edits onto the user's branch. Only on loki/<runId>, with an intact log and a valid intake base. Every
 *  path that was dirty or untracked at intake, and everything under .loki/ (a deletion included), stays exactly where it is, edited or not: those are
 *  the user's files. True when it committed. */
export function commitUnsealedWork(intact: boolean, repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, intake: Record<string, unknown> | undefined): boolean {
  if (!intact || !intake || validBase(intake["base_sha"]) === null) return false;
  const g = (args: string[]) => safeGit(repoDir, args, { env: workerEnv });
  try {
    if (g(["symbolic-ref", "-q", "--short", "HEAD"]).trim() !== `loki/${runId}`) return false;
    const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o) : []);
    const users = [...keys(intake["preexisting_dirty"]), ...keys(intake["preexisting_untracked_blobs"]), ...(Array.isArray(intake["preexisting_untracked"]) ? (intake["preexisting_untracked"] as unknown[]).map(String) : [])];
    g(["add", "-A", "--", "."]);
    // A deletion is no longer in the index after `add -A`, so ls-files alone misses it: also take every staged change (deletions included) under
    // .loki and the user's paths. Without this the WIP commit deleted a repo's tracked legacy .loki files (FireLater tracks four) on the run branch.
    const spec = ["--", ".loki", ...new Set(users)], keep = [...new Set([...g(["--literal-pathspecs", "ls-files", "--cached", "-z", ...spec]).split("\0"), ...g(["--literal-pathspecs", "diff", "--cached", "--name-only", "--no-renames", "-z", ...spec]).split("\0")].filter(Boolean))];
    if (keep.length > 0) g(["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...keep]);
    // The commit stage's filter applies here too: a lockfile that pnpm, Nx or verify rewrote after the commit stage is install churn, not run work. Dropped paths go back to base in the index and the tree (a modified tracked file only; never a path in `keep`: .loki and anything dirty or untracked at intake), so the checkout back to the user's branch carries no churn.
    const base = intake["base_sha"] as string, task = typeof intake["task"] === "string" ? intake["task"] : undefined;
    const staged = parseStaged(g(["diff", "--cached", "--name-status", "--no-renames", "-z", base])), mine = new Set(keep);
    const churn = dropSet(repoDir, staged, intake["preexisting_dirty"], workerEnv, intake["install_created"], intake["preexisting_untracked_blobs"], base, task).filter(({ st, f }) => st !== "L" && !f.startsWith(".loki/") && !WALL_FILE.test(f) && !mine.has(f) && staged.some((s) => s.f === f && (s.st === "M" || s.st === "A")));
    if (churn.length > 0) g(["--literal-pathspecs", "reset", "-q", base, "--", ...churn.map(({ f }) => f)]);
    const modified = churn.filter(({ f }) => staged.find((x) => x.f === f)?.st === "M").map(({ f }) => f);
    if (modified.length > 0) g(["--literal-pathspecs", "checkout", "-q", base, "--", ...modified]);
    for (const { f } of churn) { if (staged.find((x) => x.f === f)?.st === "A" && LOCKFILE.test(f)) { try { const p = join(repoDir, f); if (lstatSync(p).isFile()) rmSync(p); } catch { /* already gone */ } } } // a lockfile the run created (absent at intake: none of `keep`) must not stay untracked on the user's branch
    try { g(["diff", "--cached", "--quiet"]); return false; } catch (e) { if ((e as { status?: number }).status !== 1) return false; }
    g(["commit", "-q", "-m", `loki: work in progress, not verified (${runId})`, "-m", `Loki-Run: ${runId}`]);
    return true;
  } catch { return false; }
}
