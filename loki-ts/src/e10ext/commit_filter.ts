// Shared by the commit stage and the supervisor backstop: which staged paths a run must never publish.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { untouchedSinceIntake } from "./preexisting_dirty.ts"; import { untouchedUntracked } from "../features/untouched_untracked.ts";
import { installOwned } from "../project_model/install.ts"; import { LOCKFILE_RE as LOCKFILE, toolchainOutputs } from "../util/lock_ecosystems.ts"; export { LOCKFILE };
import { runFormattersRecord, type FormatRecord } from "../runner/repo_profile.ts";
import { safeGit, safeGitSpawn, tokenFreeEnv } from "../util/safe_git.ts";
import { commitWallEnabled } from "../util/check_result.ts";
import { recoverRunWork } from "../util/base_guard.ts";
/** WORK-RECOVERY: before a run-end commit (backstop or WIP), the run's own set-aside work returns to the tree and the checkout to the run branch (util/base_guard.ts). */
const rescueRunWork = (repoDir: string, runId: string): void => { if (/^e10-[A-Za-z0-9-]+$/.test(runId)) recoverRunWork({ repoDir, runDir: join(repoDir, ".loki", "runs", runId), branch: `loki/${runId}`, where: "run-end", moveBranch: true }); };
import { escapeRegex } from "../util/regex_escape.ts";

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
  const art = buildArtifactDropEnabled(env) ? buildArtifacts(repoDir, staged.filter(({ st }) => st === "A").map(({ f }) => f), baseSha, task) : new Set<string>(); // GB
  if (runOutputDropEnabled(env)) for (const f of runOutputs(repoDir, staged.filter(({ st }) => st === "A").map(({ f }) => f), baseSha, task)) art.add(f); // RO
  return staged.concat(untouchedSinceIntake(repoDir, preexistingDirty, env).map((f) => ({ st: "L", f })), untouchedUntracked(repoDir, untrackedBlobs, env).map((f) => ({ st: "L", f })), staged.filter(({ f }) => owned(f)).map(({ f }) => ({ st: "L", f }))).filter(({ st, f }) => f.startsWith(".loki/") || st === "L" || WALL_FILE.test(f) || (st === "A" && (tc.has(f) || art.has(f))) || ((st === "A" || st === "M") && !Object.hasOwn(made, f) && LOCKFILE.test(f) && !manifestChanged(staged, f) && !taskWantsLockChange(task, f)));
}

/** GB LOKI_E10_BUILD_ARTIFACT_DROP (default on, =0 opts out): a file the run ADDED is never delivered when it is a generated or build artifact: a path the repo's ignore
 *  rules match (`git check-ignore --no-index`, so a force-added file counts), a byte-compiled or incremental-build file anywhere (*.pyc, *.pyo, *.tsbuildinfo, __pycache__/,
 *  <name>.egg-info/), or a file under dist/, build/, coverage/, .nyc_output/ or target/ at the repo root or beside a package manifest. Kept: the task names the file, or the
 *  output directory already holds a file tracked at the run's base (the repo commits it). The failure: on new repos two delivered diffs carried build output a reviewer
 *  failed as unrelated edits. The ignore rules are the tree's at commit time; they equal the base's unless the run edited a .gitignore. */
export const buildArtifactDropEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BUILD_ARTIFACT_DROP"] ?? "").trim());
const BYTECODE = /\.py[co]$|\.tsbuildinfo$/, CACHE_DIR = /^(?:.*\/)?(?:__pycache__|[^/]+\.egg-info)\//;
const OUT_DIR = /^(?:dist|build|coverage|\.nyc_output|target)$/;
const PKG_MANIFEST = ["package.json", "pyproject.toml", "setup.py", "setup.cfg", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "tsconfig.json"];
/** The build output directory a path sits in (repo root or beside a manifest), or null. */
function outDirOf(repoDir: string, f: string): string | null {
  const parts = f.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (!OUT_DIR.test(parts[i]!)) continue;
    const parent = parts.slice(0, i).join("/");
    if (parent === "" || PKG_MANIFEST.some((m) => existsSync(join(repoDir, parent, m)))) return parts.slice(0, i + 1).join("/");
  }
  return null;
}
export function buildArtifacts(repoDir: string, added: string[], baseSha?: string, task = ""): Set<string> {
  const out = new Set<string>(); if (added.length === 0) return out;
  const named = (f: string): boolean => task.includes(f) || new RegExp(`(?<![\\w./-])${escapeRegex(basename(f))}(?![\\w-])`).test(task);
  let ignored = new Set<string>();
  try { const r = safeGitSpawn(repoDir, ["check-ignore", "--no-index", "--stdin", "-z"], { input: added.join("\0") + "\0", encoding: "utf8", timeout: 20_000 }); if (r.status === 0 || r.status === 1) ignored = new Set(String(r.stdout ?? "").split("\0").filter(Boolean)); } catch { /* no ignore check: patterns only */ }
  const trackedDir = new Map<string, boolean>();
  const dirTracked = (d: string): boolean => { if (!trackedDir.has(d)) { try { trackedDir.set(d, !baseSha || safeGit(repoDir, ["ls-tree", "-r", "--name-only", baseSha, "--", `${d}/`], { stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""); } catch { trackedDir.set(d, true); } } return trackedDir.get(d)!; };
  for (const f of added) {
    if (f.startsWith(".loki/") || named(f)) continue;
    const od = outDirOf(repoDir, f) ?? CACHE_DIR.exec(f)?.[0]?.replace(/\/$/, "") ?? null;
    if (od !== null) { if (!dirTracked(od)) out.add(f); continue; } // a dist/, build/, __pycache__/ or egg-info/ the repo commits is the repo's
    if (BYTECODE.test(f) || ignored.has(f)) out.add(f);
  }
  return out;
}
/** RO LOKI_E10_RUN_OUTPUT_DROP (default on, =0 opts out): output the run's own commands write never reaches the delivered diff. An ADDED file under a .loki/ or .loki-*
 *  directory at any depth (the root one is always dropped), or under test-results/, playwright-report/, blob-report/, coverage/, htmlcov/, .nyc_output/, .pytest_cache/,
 *  .mypy_cache/, .ruff_cache/, .tox/ or .hypothesis/ anywhere, or a JUnit report, *.log, .coverage, lcov.info, coverage.xml or nohup.out file, is left out. Kept: the task
 *  names the file, or that directory already holds a file tracked at base. A deterministic filter, not a model judgment: on held-out repos the top review-fail class was
 *  stray committed run artifacts (test-results output and nested .loki logs). */
export const runOutputDropEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_RUN_OUTPUT_DROP"] ?? "").trim());
const RUN_DIR = /^(.*?(?:^|\/)(?:\.loki(?:-[^/]*)?|test-results|playwright-report|blob-report|coverage|htmlcov|\.nyc_output|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.hypothesis))\//;
const RUN_FILE = /(?:^|\/)(?:junit[^/]*\.xml|[^/]+\.junit\.xml|[^/]+\.log|\.coverage(?:\.[^/]*)?|lcov\.info|coverage\.xml|nohup\.out)$/;
export function runOutputs(repoDir: string, added: string[], baseSha?: string, task = ""): Set<string> {
  const out = new Set<string>(), named = (f: string): boolean => task.includes(f) || new RegExp(`(?<![\\w./-])${escapeRegex(basename(f))}(?![\\w-])`).test(task);
  const tracked = new Map<string, boolean>(), dirTracked = (d: string): boolean => { if (!tracked.has(d)) { try { tracked.set(d, !!baseSha && safeGit(repoDir, ["ls-tree", "-r", "--name-only", baseSha, "--", `${d}/`], { stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""); } catch { tracked.set(d, false); } } return tracked.get(d)!; };
  for (const f of added) {
    if (f.startsWith(".loki/") || named(f)) continue;
    const d = RUN_DIR.exec(f)?.[1];
    if (d !== undefined) { if (!dirTracked(d)) out.add(f); continue; }
    if (RUN_FILE.test(f)) out.add(f);
  }
  return out;
}
/** RD LOKI_E10_REGEN_DROP (default on, =0 opts out): a file only Loki's own checks rewrote is left out of the delivered diff. The machine snapshots the tree around
 *  every verify run; a path a verify run changed joins <runDir>/regenerated.json, and a path a model stage (wall, implement, fix) later writes leaves it again. At
 *  commit, a staged path still in that set is left out unless the task names it or one of its changed lines carries a task keyword (a backticked span, or an
 *  identifier of 5 or more characters the task uses), so a doc a test run regenerated in step with the change stays. The failure: a test run regenerated an
 *  unrelated doc page with a machine-specific path, the commit shipped it, and review failed the diff as an unrelated edit on a run that read VERIFIED. */
export const regenDropOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_REGEN_DROP"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
const REGEN_FILE = "regenerated.json";
export function noteRegenerated(runDir: string, stage: string, paths: string[]): void {
  if (!paths.length || !["verify", "wall", "implement", "fix"].includes(stage)) return;
  const p = join(runDir, REGEN_FILE); let set = new Set<string>();
  try { set = new Set((JSON.parse(readFileSync(p, "utf8")) as { paths?: string[] }).paths ?? []); } catch { /* none yet */ }
  for (const f of paths) { if (stage === "verify") set.add(f); else set.delete(f); }
  try { mkdirSync(runDir, { recursive: true }); writeFileSync(p, JSON.stringify({ paths: [...set].sort() })); } catch { /* best effort: no record, nothing dropped */ }
}
export const regeneratedPaths = (runDir: string): string[] => { try { return (JSON.parse(readFileSync(join(runDir, REGEN_FILE), "utf8")) as { paths?: string[] }).paths ?? []; } catch { return []; } };
/** Task keywords a MODIFIED regenerated file's change must carry to stay (see regenDropOn). A new check-written file never stays by keyword (acc-170):
 *  only an exact path or file name in the task keeps it, since a plain word such as "components" matched a test-run cache file. */
export function taskKeywords(task: string): Set<string> {
  const k = new Set<string>([...task.matchAll(/`([^`\n]{2,60})`/g)].map((m) => m[1]!.trim()));
  for (const m of task.matchAll(/[A-Za-z_][A-Za-z0-9_]{4,}/g)) if (/[_0-9]|[a-z][A-Z]/.test(m[0]) || m[0].length >= 8) k.add(m[0]);
  return k;
}
/** True when the task names the path exactly (as written, or by its file name). */
export const taskNamesPath = (task: string, f: string): boolean => task.includes(f) || task.includes(basename(f));
/** The staged paths to leave out as check-regenerated (RD). `changedLines(f)` gives the added and removed lines of f against base. */
export function regenDrops(runDir: string, staged: Staged[], task: string, changedLines: (f: string) => string[], env: NodeJS.ProcessEnv = process.env): Staged[] {
  if (!regenDropOn(env)) return [];
  const regen = new Set(regeneratedPaths(runDir)); if (!regen.size) return [];
  const kw = [...taskKeywords(task)];
  return staged.filter(({ st, f }) => {
    if (!(st === "A" || st === "M") || !regen.has(f) || f.startsWith(".loki/") || taskNamesPath(task, f)) return false;
    if (st === "A") return true; // acc-170: a NEW file only a check run wrote (a fixture cache, a snapshot file) stays only when the task names its path
    const lines = changedLines(f).join("\n");
    return !kw.some((w) => lines.includes(w));
  });
}
export const regenDropNote = (f: string): string => `rewritten only by Loki's own check run, not by the change, and left out of the commit: ${f}`;
export const regenKeptNote = (f: string): string => `rewritten by Loki's own check run and kept: a targeted test fails without it: ${f}`;
/** acc-170 guard: the check-written paths regenDrops picked go back to base ON DISK (a modified file is checked out from base, a new one removed), then `breaks`
 *  reruns the targeted tests. When one turns red (or none could run), every picked path is restored byte for byte and kept: a snapshot or fixture the change
 *  needs. The paths that stay dropped are at base in the tree too, so no later step (the run-end WIP commit) can bring them back. */
export function guardRegenDrops(repoDir: string, baseSha: string, picked: Staged[], breaks: () => boolean): { dropped: Staged[]; kept: Staged[] } {
  if (!picked.length) return { dropped: [], kept: [] };
  const saved = picked.map(({ f }) => { try { return { f, b: readFileSync(join(repoDir, f)) }; } catch { return { f, b: null as Buffer | null }; } });
  const toBase = (): void => { for (const { st, f } of picked) { try { if (st === "M") safeGit(repoDir, ["--literal-pathspecs", "checkout", "-q", baseSha, "--", f]); else rmSync(join(repoDir, f), { force: true }); } catch { /* left as is */ } } };
  toBase();
  let red = true; try { red = breaks(); } catch { red = true; }
  if (!red) return { dropped: picked, kept: [] };
  for (const { f, b } of saved) { if (b === null) continue; try { mkdirSync(dirname(join(repoDir, f)), { recursive: true }); writeFileSync(join(repoDir, f), b); } catch { /* best effort */ } }
  return { dropped: [], kept: picked };
}
/** DN LOKI_E10_DIFF_NEED (default on, =0 opts out): deliver only what the fix needs, deterministically and with no model call. A staged non-test file the task does not
 *  name is left out when (1) its change is formatting only: base and head are equal once whitespace, quote style, semicolons and trailing commas are normalized
 *  (Python, YAML and other whitespace-significant files keep their indentation, so only trailing space, blank lines and quotes are normalized), unless the task asks
 *  for formatting; or (2) its change only adds or removes lint-suppression comments (noqa, type: ignore, eslint-disable, @ts-ignore, @ts-expect-error, nolint,
 *  pylint: disable, rubocop:disable, #[allow(..)], @SuppressWarnings) in a file outside the change's stated scope, unless the task is about lint or warnings.
 *  The failures: a 177 KB delivered diff of reformatted generated route trees and schema files (the raw run's was 4.5 KB), and a drive-by suppression removal in
 *  an unrelated file. `scopeOutside` lists the staged paths outside the stated scope, or null when no scope signal exists (treated as outside). */
export const diffNeedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_DIFF_NEED"] ?? "").trim()) /* on by default since 11.141.3 (dev2 2-seed A3.2), =0 opts out */;
const WS_SIGNIFICANT = /\.(?:py|pyi|ya?ml|haml|pug|coffee|nim|mk)$|(^|\/)Makefile$/;
export function formattingOnly(f: string, base: string, head: string): boolean {
  if (base === head) return false;
  const quotes = (t: string): string => t.replace(/["'`]/g, "'");
  const norm = WS_SIGNIFICANT.test(f)
    ? (t: string): string => quotes(t).split("\n").map((l) => l.replace(/[ \t]+$/, "")).filter((l) => l.trim() !== "").join("\n")
    : (t: string): string => quotes(t).replace(/[\s;]+/g, "").replace(/,([\]})])/g, "$1");
  return norm(base) === norm(head);
}
const SUPPRESS = /\s*(?:#\s*(?:noqa\b[^\n]*|type:\s*ignore\b[^\n]*|pylint:\s*disable[^\n]*|rubocop:disable[^\n]*)|\/\/\s*(?:eslint-disable[^\n]*|@ts-(?:ignore|expect-error|nocheck)[^\n]*|nolint\b[^\n]*|NOLINT[^\n]*)|\/\*\s*eslint-disable[^*]*\*\/|#\[allow\([^)]*\)\]|@SuppressWarnings\([^)]*\))/g;
export const suppressionOnly = (base: string, head: string): boolean => base !== head && base.replace(SUPPRESS, "").replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n") === head.replace(SUPPRESS, "").replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n");
export function needDrops(staged: Staged[], task: string, read: (f: string) => { base: string | null; head: string | null }, scopeOutside: string[] | null, env: NodeJS.ProcessEnv = process.env): { st: string; f: string; why: string }[] {
  if (!diffNeedOn(env)) return [];
  const asksFormat = /\b(?:format(?:ting|ter)?|re-?format|prettier|black|ruff format|gofmt|rustfmt|whitespace|indent(?:ation)?)\b/i.test(task), asksLint = /\b(?:lint(?:er|ing)?|noqa|eslint|suppress(?:ion)?|warnings?|type:\s*ignore|ts-ignore)\b/i.test(task);
  const out: { st: string; f: string; why: string }[] = [];
  for (const { st, f } of staged) {
    if (st !== "M" || f.startsWith(".loki/") || task.includes(f) || task.includes(basename(f))) continue;
    const { base, head } = read(f); if (base === null || head === null) continue;
    if (!asksFormat && formattingOnly(f, base, head)) { out.push({ st, f, why: "formatting-only change" }); continue; }
    if (!asksLint && (scopeOutside === null || scopeOutside.includes(f)) && suppressionOnly(base, head)) out.push({ st, f, why: "lint-suppression-only change outside the fix" });
  }
  return out;
}
export const needDropNote = (d: { f: string; why: string }): string => `${d.why} left out of the delivered diff: ${d.f}`;
/** One receipt line per build artifact or run output the commit left out. */
export const buildArtifactNotes = (repoDir: string, droppedAdded: string[], baseSha?: string, task?: string): string[] => {
  const s = new Set<string>([...(buildArtifactDropEnabled() ? buildArtifacts(repoDir, droppedAdded, baseSha, task) : []), ...(runOutputDropEnabled() ? runOutputs(repoDir, droppedAdded, baseSha, task) : [])]);
  return [...s].map((f) => `generated or build file left out of the commit: ${f}`);
};

/** TEN-QUALITY-16: format only the files the run added or modified and kept (not dropped, deleted or under .loki/) with the repo's own configured formatter; returns them for re-staging. */
export const formatChanged = (repoDir: string, staged: Staged[], dropped: Set<string>, env: NodeJS.ProcessEnv = process.env, baseSha?: string): string[] => formatChangedRecord(repoDir, staged, dropped, env, baseSha).formatted;
/** The same pass with its per-formatter record (J1 LOKI_E10_FORMAT_RESOLVE: which formatter ran on which files, and why a file or a formatter was skipped); baseSha enables the base-clean check. */
export const formatChangedRecord = (repoDir: string, staged: Staged[], dropped: Set<string>, env: NodeJS.ProcessEnv = process.env, baseSha?: string): { formatted: string[]; records: FormatRecord[] } =>
  runFormattersRecord(repoDir, staged.filter(({ st, f }) => (st === "A" || st === "M") && !dropped.has(f) && !f.startsWith(".loki/")).map(({ f }) => f), tokenFreeEnv(env), baseSha);

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
  rescueRunWork(repoDir, runId);
  backstopCommit(repoDir, workerEnv, runId, b, preexistingDirty, installCreated, untrackedBlobs, task);
  return null;
}

/** DELIVER-WHAT-EXISTS: which runs that are not VERIFIED or PARTIAL still open a DRAFT pull request for the change they produced (the supervisor's push
 *  condition calls this). A FAILED run, sealed or not (a killed or crashed worker leaves no receipt; the backstop commit holds its work), and a
 *  SPEC_CONFLICT run (the draft leads with the question and `loki answer`). Never a label rule: the verdict and the outcome are untouched, the pull
 *  request is always a draft, and the security-scan secret match still refuses the push. LOKI_E10_DELIVER_UNSEALED=0 restores the rule before this
 *  change (a FAILED run with a sealed receipt only). */
export const deliverUnsealedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_DELIVER_UNSEALED"] ?? "").trim());
export const deliverAsDraft = (verdict: string, sealed: boolean, env: NodeJS.ProcessEnv = process.env): boolean => (deliverUnsealedOn(env) ? verdict === "FAILED" || verdict === "SPEC_CONFLICT" : verdict === "FAILED" && sealed);
/** A deep verify follows a VERIFIED or PARTIAL pull request only: a FAILED or blocked draft has nothing to deep-verify and must not carry a pending status. */
export const deepAfterPr = (verdict: string): boolean => verdict === "VERIFIED" || verdict === "PARTIAL";

/** Run safety: before the checkout returns to the user's branch, whatever the run left uncommitted (any outcome without a PR: FAILED,
 *  STALLED, BLOCKED, BUDGET_STOP, a SIGINT/SIGTERM cancel) becomes one WIP commit on its own branch, so `git checkout <start>` neither
 *  refuses nor carries the run's edits onto the user's branch. Only on loki/<runId>, with an intact log and a valid intake base. Every
 *  path that was dirty or untracked at intake, and everything under .loki/ (a deletion included), stays exactly where it is, edited or not: those are
 *  the user's files. True when it committed. */
export function commitUnsealedWork(intact: boolean, repoDir: string, workerEnv: NodeJS.ProcessEnv, runId: string, intake: Record<string, unknown> | undefined): boolean {
  if (!intact || !intake || validBase(intake["base_sha"]) === null) return false;
  const g = (args: string[]) => safeGit(repoDir, args, { env: workerEnv });
  rescueRunWork(repoDir, runId); // a paused or cancelled run's work in a stash or on a branch a session switched to is committed too
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
    const runDir = join(repoDir, ".loki", "runs", runId), regenWip = regenDrops(runDir, staged.filter(({ f }) => !mine.has(f)), task ?? "", (f) => { try { return safeGit(repoDir, ["diff", "--no-color", "-U0", base, "--", f], { env: workerEnv }).split("\n").filter((l) => /^[+-](?![+-]{2})/.test(l)); } catch { return []; } }); // acc-170 F1: the WIP commit honors the RD drop set too
    const churn = [...dropSet(repoDir, staged, intake["preexisting_dirty"], workerEnv, intake["install_created"], intake["preexisting_untracked_blobs"], base, task), ...regenWip.filter(({ f }) => !mine.has(f))].filter(({ st, f }) => st !== "L" && !f.startsWith(".loki/") && (!commitWallEnabled() || !WALL_FILE.test(f)) && !mine.has(f) && staged.some((s) => s.f === f && (s.st === "M" || s.st === "A")));
    if (churn.length > 0) g(["--literal-pathspecs", "reset", "-q", base, "--", ...churn.map(({ f }) => f)]);
    const modified = churn.filter(({ f }) => staged.find((x) => x.f === f)?.st === "M").map(({ f }) => f);
    if (modified.length > 0) g(["--literal-pathspecs", "checkout", "-q", base, "--", ...modified]);
    for (const { f } of churn) { if (staged.find((x) => x.f === f)?.st === "A" && (LOCKFILE.test(f) || WALL_FILE.test(f) || regenWip.some((r) => r.f === f))) { try { const p = join(repoDir, f); if (lstatSync(p).isFile()) rmSync(p); } catch { /* already gone */ } } } // a lockfile the run created (absent at intake: none of `keep`) must not stay untracked on the user's branch
    try { g(["diff", "--cached", "--quiet"]); return false; } catch (e) { if ((e as { status?: number }).status !== 1) return false; }
    g(["commit", "-q", "-m", `loki: work in progress, not verified (${runId})`, "-m", `Loki-Run: ${runId}`]);
    return true;
  } catch { return false; }
}
