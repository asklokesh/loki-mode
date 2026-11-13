// Shared by the commit stage and the supervisor backstop: which staged paths a run must never publish.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { untouchedSinceIntake } from "./preexisting_dirty.ts"; import { untouchedUntracked } from "../features/untouched_untracked.ts";
import { installOwned } from "../project_model/install.ts"; import { LOCKFILE_RE as LOCKFILE, toolchainOutputs } from "../util/lock_ecosystems.ts"; export { LOCKFILE };
import { runFormattersRecord, type FormatRecord } from "../runner/repo_profile.ts";
import { safeGit, tokenFreeEnv } from "../util/safe_git.ts";
import { commitWallEnabled } from "../util/check_result.ts";
import { RUNNER_CONFIGS, steersRunner } from "../features/runner_config.ts";

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

/** acc-146 LOKI_E10_DIFF_HYGIENE (default on, =0 opts out): a run must not deliver an edit to test-runner or CI config the task does not ask for. The config fence (util/config_fence.ts)
 *  restores fenced files after each implement and fix session, but a config the run CREATES to get its tests running reached the delivered diff on new repos, and seal only labelled it
 *  ("runner config changed"); a reviewer then fails the change on scope. Verify reverts each candidate to the base tree's own config and re-runs the checks that passed (hygieneProbe):
 *  when one of them fails without the edit, the edit is kept (the change needs it); otherwise it is dropped there and the commit leaves it out. A task that names the file or the
 *  setting (util/config_paths.ts taskNamesFenced), and a change that is nothing but such an edit, keep it. Paths only, never a partial file: a package.json is a candidate only when
 *  nothing but its test keys changed. Test helper code (conftest.py), .pth files, dependency patches and package-manager workspace or install config (pnpm-workspace.yaml, .yarnrc.yml, .npmrc, .pnpmfile) stay labelled by seal and are never dropped here. */
export const diffHygieneEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_DIFF_HYGIENE"] ?? "").trim());
export const CI_CONFIG = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|\.travis\.ya?ml|Jenkinsfile|bitbucket-pipelines\.ya?ml|\.buildkite\/[^/]+\.ya?ml)$/i;
const HYGIENE_SKIP = /(^|\/)(node_modules|\.loki|__fixtures__|fixtures?|testdata)\//, NOT_CONFIG = /(^|\/)(conftest\.py|[^/]+\.pth|pnpm-workspace\.yaml|\.yarnrc\.yml|\.npmrc|\.pnpmfile\.[cm]?js)$|(^|\/)patches\/|\.patch$/i;
const TEST_PKG_KEYS = ["scripts", "jest", "mocha", "vitest", "ava", "c8", "nyc"];
export type HygieneEdit = { st: string; f: string; why: string };
/** Why `f` is runner or CI config a run must not deliver unasked, or null. `before`/`after`: base and head text ("" when absent). */
export function hygieneKind(f: string, before: string, after: string, task = ""): string | null {
  if (CI_CONFIG.test(f)) return "CI config";
  if (NOT_CONFIG.test(f)) return null;
  const spec = RUNNER_CONFIGS.find((s) => s.re.test(f));
  if (!spec) return null;
  if (!spec.shared) return "test-runner config";
  if (!/(^|\/)package\.json$/i.test(f) || /\bscripts?\b/i.test(task) || !steersRunner(f, before, after)) return null;
  try { const rest = (t: string): string => { const j = JSON.parse(t || "{}") as Record<string, unknown>; for (const k of TEST_PKG_KEYS) delete j[k]; return JSON.stringify(j); }; return rest(before) === rest(after) ? "test script or runner key in package.json" : null; } catch { return null; }
}
/** The staged edits to drop (see diffHygieneEnabled). `base`/`head` read a path's text at the base commit and in the tree (null when absent); `named` is the task naming the path or its setting. */
export function hygieneCandidates(staged: Staged[], base: (f: string) => string | null, head: (f: string) => string | null, named: (f: string) => boolean, task = ""): HygieneEdit[] {
  const live = staged.filter(({ st, f }) => (st === "A" || st === "M" || st === "D") && !HYGIENE_SKIP.test(f) && !WALL_FILE.test(f) && !LOCKFILE.test(f));
  const out = live.flatMap(({ st, f }) => { const why = hygieneKind(f, base(f) ?? "", head(f) ?? "", task); return why && !named(f) ? [{ st, f, why }] : []; });
  return out.length > 0 && live.some(({ f }) => !out.some((d) => d.f === f)) ? out : []; // nothing else changed: the config edit is the deliverable
}
/** The user's own paths from the intake record (dirty or untracked at intake): never a hygiene candidate, edited or not. */
export const intakeUserPaths = (intake: unknown): Set<string> => { const i = (intake ?? {}) as Record<string, unknown>, keys = (o: unknown): string[] => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []); return new Set([...keys(i["preexisting_dirty"]), ...keys(i["preexisting_untracked_blobs"]), ...(Array.isArray(i["preexisting_untracked"]) ? (i["preexisting_untracked"] as unknown[]).map(String) : [])]); };
export const gitBaseText = (repoDir: string, baseSha: string) => (f: string): string | null => { try { return safeGit(repoDir, ["show", `${baseSha}:./${f}`], { timeout: 20000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
export const treeText = (repoDir: string) => (f: string): string | null => { try { return readFileSync(join(repoDir, f), "utf8"); } catch { return null; } };
export type HygieneRecord = { dropped: { path: string; why: string; proof: string }[]; kept: { path: string; why: string; proof: string }[] };
/** Verify's necessity check: every candidate goes back to its base content (an added one is removed), `rerun` re-runs the checks that passed, and a check that now fails keeps
 *  every candidate (its bytes are written back). A check that cannot run (not_run) is inconclusive and keeps them too. Dropped candidates stay at base in the tree. Never throws. */
export async function hygieneProbe(repoDir: string, cands: HygieneEdit[], base: (f: string) => string | null, rerun: () => Promise<{ name: string; result: string }[]>): Promise<HygieneRecord> {
  const saved = new Map<string, Buffer | null>(), put = (f: string, b: Buffer | string | null): void => { const p = join(repoDir, f); if (b === null) rmSync(p, { force: true }); else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); } };
  const keepAll = (proof: string): HygieneRecord => { for (const [f, b] of saved) { try { put(f, b); } catch { /* best effort */ } } return { dropped: [], kept: cands.map((c) => ({ path: c.f, why: c.why, proof })) }; };
  try { for (const c of cands) { const p = join(repoDir, c.f); saved.set(c.f, existsSync(p) ? readFileSync(p) : null); put(c.f, base(c.f)); } } catch { return keepAll("the base config could not be restored, so it was not checked"); }
  let res: { name: string; result: string }[]; try { res = await rerun(); } catch { return keepAll("the re-run without it failed to start"); }
  const failed = res.find((r) => r.result === "fail"), unrun = res.find((r) => r.result !== "pass" && r.result !== "fail");
  if (failed) return keepAll(`${failed.name} fails without it`);
  if (unrun) return keepAll(`${unrun.name} did not run without it, so the need is unproven`);
  const proof = res.length ? `${res.length} check(s) that passed still pass without it` : "no check passed with it, so none needs it";
  return { dropped: cands.map((c) => ({ path: c.f, why: c.why, proof })), kept: [] };
}
export const hygieneDropNote = (d: { path: string; why: string; proof: string }): string => `runner or CI config edit dropped from the delivered diff: ${d.path} (${d.why} the task does not ask for; ${d.proof})`;
export const hygieneKeptNote = (d: { path: string; why: string; proof: string }): string => `runner or CI config edit kept: ${d.path} (${d.why} the task does not ask for, kept because ${d.proof})`;
/** Puts dropped paths back to base in the index and the tree (an added one is removed). `g` runs git in the repo and throws on failure. */
export function revertToBase(repoDir: string, g: (args: string[]) => unknown, baseSha: string, edits: { st: string; f: string }[]): void {
  if (edits.length === 0) return;
  g(["--literal-pathspecs", "reset", "-q", baseSha, "--", ...edits.map(({ f }) => f)]);
  const back = edits.filter(({ st }) => st !== "A").map(({ f }) => f); if (back.length > 0) g(["--literal-pathspecs", "checkout", "-q", baseSha, "--", ...back]);
  for (const { st, f } of edits) if (st === "A") { try { rmSync(join(repoDir, f), { force: true }); } catch { /* already gone */ } }
}

/** TEN-QUALITY-16: format only the files the run added or modified and kept (not dropped, deleted or under .loki/) with the repo's own configured formatter; returns them for re-staging. */
export const formatChanged = (repoDir: string, staged: Staged[], dropped: Set<string>, env: NodeJS.ProcessEnv = process.env, baseSha?: string): string[] => formatChangedRecord(repoDir, staged, dropped, env, baseSha).formatted;
/** The same pass with its per-formatter record (J1 LOKI_E10_FORMAT_RESOLVE: which formatter ran on which files, and why a file or a formatter was skipped); baseSha enables the base-clean check. */
export const formatChangedRecord = (repoDir: string, staged: Staged[], dropped: Set<string>, env: NodeJS.ProcessEnv = process.env, baseSha?: string): { formatted: string[]; records: FormatRecord[] } =>
  runFormattersRecord(repoDir, staged.filter(({ st, f }) => (st === "A" || st === "M") && !dropped.has(f) && !f.startsWith(".loki/")).map(({ f }) => f), tokenFreeEnv(env), baseSha);

/** Commits whatever a killed or crashed worker left uncommitted or untracked (minus .loki), so it
 *  reaches the pushed branch: `git diff` alone misses untracked files, and nothing pushes a tree
 *  that was never committed. Withheld-token env, hooks/fsmonitor off (repoDir/.git is agent-writable).
 *  A clean tree, or add/reset failing, is a no-op: best-effort, never the reason a run fails. */
export function backstopCommit(repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: string, preexistingDirty: unknown, installCreated?: unknown, untrackedBlobs?: unknown, task?: string, named?: (f: string) => boolean): void {
  const g = (args: string[]) => safeGit(repoDir, args, { env: workerEnv, stdio: "ignore" });
  try {
    g(["add", "-A", "--", "."]);
    // same exclusions as the commit stage (A-104c): pre-run dirt, Wall files, stray lockfiles, .loki
    const staged = parseStaged(safeGit(repoDir, ["diff", "--cached", "--name-status", "--no-renames", "-z", base], { env: workerEnv }));
    const drop0 = dropSet(repoDir, staged, preexistingDirty, workerEnv, installCreated, untrackedBlobs, base, task), drop = named && diffHygieneEnabled(workerEnv) ? [...drop0, ...hygieneCandidates(staged.filter(({ f }) => !drop0.some((d) => d.f === f)), gitBaseText(repoDir, base), treeText(repoDir), named, task ?? "")] : drop0; // acc-146: unasked runner or CI config stays out of the index
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
export function guardedBackstop(intact: boolean, repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, base: unknown, preexistingDirty: unknown, installCreated?: unknown, untrackedBlobs?: unknown, task?: string, named?: (f: string) => boolean): string | null {
  if (!intact) return "backstop commit skipped: event log failed verification";
  const b = validBase(base);
  if (b === null) return base === null || base === undefined ? null : "backstop commit skipped: base is not a full object id";
  backstopCommit(repoDir, workerEnv, runId, b, preexistingDirty, installCreated, untrackedBlobs, task, named);
  return null;
}

/** Run safety: before the checkout returns to the user's branch, whatever the run left uncommitted (any outcome without a PR: FAILED,
 *  STALLED, BLOCKED, BUDGET_STOP, a SIGINT/SIGTERM cancel) becomes one WIP commit on its own branch, so `git checkout <start>` neither
 *  refuses nor carries the run's edits onto the user's branch. Only on loki/<runId>, with an intact log and a valid intake base. Every
 *  path that was dirty or untracked at intake, and everything under .loki/ (a deletion included), stays exactly where it is, edited or not: those are
 *  the user's files. True when it committed. */
export function commitUnsealedWork(intact: boolean, repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, intake: Record<string, unknown> | undefined, named?: (f: string) => boolean): boolean {
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
    const churn = dropSet(repoDir, staged, intake["preexisting_dirty"], workerEnv, intake["install_created"], intake["preexisting_untracked_blobs"], base, task).filter(({ st, f }) => st !== "L" && !f.startsWith(".loki/") && (!commitWallEnabled() || !WALL_FILE.test(f)) && !mine.has(f) && staged.some((s) => s.f === f && (s.st === "M" || s.st === "A")));
    if (churn.length > 0) g(["--literal-pathspecs", "reset", "-q", base, "--", ...churn.map(({ f }) => f)]);
    const modified = churn.filter(({ f }) => staged.find((x) => x.f === f)?.st === "M").map(({ f }) => f);
    if (modified.length > 0) g(["--literal-pathspecs", "checkout", "-q", base, "--", ...modified]);
    for (const { f } of churn) { if (staged.find((x) => x.f === f)?.st === "A" && (LOCKFILE.test(f) || WALL_FILE.test(f))) { try { const p = join(repoDir, f); if (lstatSync(p).isFile()) rmSync(p); } catch { /* already gone */ } } } // a lockfile the run created (absent at intake: none of `keep`) must not stay untracked on the user's branch
    if (named && diffHygieneEnabled(workerEnv)) { const rest = parseStaged(g(["diff", "--cached", "--name-status", "--no-renames", "-z", base])).filter(({ f }) => !mine.has(f)); revertToBase(repoDir, g, base, hygieneCandidates(rest, gitBaseText(repoDir, base), treeText(repoDir), named, task ?? "")); } // acc-146: a stopped run's WIP commit carries no unasked runner or CI config either
    try { g(["diff", "--cached", "--quiet"]); return false; } catch (e) { if ((e as { status?: number }).status !== 1) return false; }
    g(["commit", "-q", "-m", `loki: work in progress, not verified (${runId})`, "-m", `Loki-Run: ${runId}`]);
    return true;
  } catch { return false; }
}
