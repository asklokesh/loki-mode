// loki-ts/src/util/base_guard.ts -- FC-15: the one place the PR target is resolved and a claim is checked against it.
// A run starts from the base the user asked for; only the ALREADY_SATISFIED claim must rest on the PR target, never on
// commits that exist only in target..HEAD (Loki's own unmerged work or the user's own).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCheck, goRunner, sealedWallCopy } from "./check_result.ts";
import { LEGACY_BRANCHES_DIR, listRunIds } from "../commands/run_status.ts";
import { runOwnerAlive } from "./run_pid.ts";
import { findInterrupted } from "./run_outputs.ts";
import { migrateSessionFiles } from "../runner/session_resume.ts";
import { safeGit } from "./safe_git.ts";
import { addedManifestOk } from "./lock_ecosystems.ts";
import { isTestFile } from "./test_file_text.ts";
import { currentBranch } from "../e10ext/stop_restore.ts";

function git(repoDir: string, args: string[], timeout = 20000, extraEnv: Record<string, string> = {}): string | null {
  try {
    return safeGit(repoDir, args, { env: { ...process.env, ...extraEnv }, timeout, allowToken: args[0] === "fetch" }).trim(); // fetch may need credentials; everything else is token-free
  } catch { return null; }
}
const exists = (repoDir: string, ref: string): boolean => git(repoDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null;

export interface ResolvedBase { ref: string; source: "flag" | "remote-default" | "local-default" }

/** PR-target precedence: explicit (LOKI_E10_BASE) fetched from origin, else origin's default branch, else a local main/master.
 *  Never a loki/* branch and never the working HEAD (this is the PR target, not the run's base). Fetches best effort, one 10s non-interactive fetch per resolved name
 *  (LOKI_E10_NO_FETCH=1 skips). Null: nothing resolvable. */
export function resolveBase(repoDir: string, explicit: string | undefined = process.env.LOKI_E10_BASE, fetchRemote = true): ResolvedBase | null {
  const fetch = (b: string): void => {
    if (!fetchRemote || process.env.LOKI_E10_NO_FETCH === "1" || git(repoDir, ["remote", "get-url", "origin"]) === null) return;
    git(repoDir, ["fetch", "-q", "origin", b], 10000, { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  };
  const ex = explicit?.trim();
  if (ex && !ex.startsWith("loki/")) {
    fetch(ex);
    for (const c of [`origin/${ex}`, ex]) if (exists(repoDir, c)) return { ref: c, source: "flag" };
    return null;
  }
  const head = git(repoDir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  const names = [head ? head.replace(/^origin\//, "") : "", "main", "master"].filter((n) => n !== "");
  for (const n of names) if (exists(repoDir, `origin/${n}`) || exists(repoDir, n)) {
    fetch(n);
    if (exists(repoDir, `origin/${n}`)) return { ref: `origin/${n}`, source: "remote-default" };
  }
  for (const n of names) if (exists(repoDir, n)) return { ref: n, source: "local-default" };
  return null;
}

export interface UnmergedEvidence { branch: string | null; lokiOwn: boolean; commits: number; target: string; paths: string[] }

const ok = (repoDir: string, args: string[]): boolean => git(repoDir, args) !== null;

/** True when the commits on HEAD that are not on the target are really Loki's: one carries the engine's "Loki-Run:" commit
 *  trailer (stages/seal.ts), or a local receipt sealed head_sha != base_sha with commits of its own there. A branch merely
 *  named loki/*, or a zero-commit receipt (head_sha is the user's own tip), does not count. */
function lokiCommitsOnHead(repoDir: string, target: string): boolean {
  if ((git(repoDir, ["log", `${target}..HEAD`, "--format=%(trailers:key=Loki-Run,valueonly)"]) ?? "").trim() !== "") return true;
  const runsDir = join(repoDir, ".loki", "runs");
  for (const id of listRunIds(runsDir)) {
    try {
      const rc = JSON.parse(readFileSync(join(runsDir, id, "receipt.json"), "utf8")) as { head_sha?: unknown; base_sha?: unknown };
      const sha = typeof rc.head_sha === "string" ? rc.head_sha : "", from = typeof rc.base_sha === "string" ? rc.base_sha : "";
      if (!/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(from) || sha === from) continue;
      if (ok(repoDir, ["merge-base", "--is-ancestor", sha, "HEAD"]) && !ok(repoDir, ["merge-base", "--is-ancestor", sha, target])
        && (Number(git(repoDir, ["rev-list", "--count", sha, `^${from}`, `^${target}`]) ?? "0") || 0) > 0) return true;
    } catch { /* no receipt: not a run record */ }
  }
  return false;
}

/** The ALREADY_SATISFIED claim must rest on the PR target. Null when none of the evidence paths differs between the target
 *  and HEAD (or no target resolves: cannot judge, keep the claim). Otherwise the evidence lives only in target..HEAD and the
 *  claim must not stand. startBranch is the branch the user started on (intake has since moved HEAD to the run branch); lokiOwn says those commits are really Loki's (a Loki-Run trailer or a receipt with commits). */
export function unmergedEvidence(repoDir: string, evidencePaths: string[], startBranch: string | null, target: ResolvedBase | null = resolveBase(repoDir)): UnmergedEvidence | null {
  if (!target) return null;
  const changed = new Set((git(repoDir, ["diff", "--name-only", target.ref, "HEAD"]) ?? "").split("\n").filter((l) => l !== ""));
  const paths = [...new Set(evidencePaths)].filter((p) => changed.has(p));
  if (paths.length === 0) return null;
  const branch = startBranch;
  const lokiOwn = lokiCommitsOnHead(repoDir, target.ref);
  return { branch, lokiOwn, commits: Number(git(repoDir, ["rev-list", "--count", `${target.ref}..HEAD`]) ?? "0") || 0, target: target.ref, paths };
}

/** Harness-owned informational reason (L5): never a refusal, never VERIFIED. */
export function unmergedEvidenceNote(u: UnmergedEvidence): string {
  return `work exists on ${u.branch ?? "HEAD"}, not on ${u.target} (${u.commits} commit(s)); open or resume it. The task is not reported as already satisfied because its evidence (${u.paths.slice(0, 3).join(", ")}${u.paths.length > 3 ? ` (+${u.paths.length - 3} more)` : ""}) is not on the PR target`;
}

export interface StackedSkip { branch: string; target: string; commits: number; base_sha: string; message: string }

/** FC-STACKED-ON-LOKI-RUN: when every commit in target..HEAD carries the Loki-Run trailer, HEAD is an earlier run's unaccepted output and a
 *  new run must not inherit it. Returns the PR target tip to branch from instead (not the merge-base: a squash-merged run must see its work on the target). Null (keep HEAD as the base) when the range is empty,
 *  holds any commit without the trailer (the operator built on it deliberately), the target does not resolve, or the target tip cannot be read. */
export function stackedOnLokiRun(repoDir: string, target: ResolvedBase | null = resolveBase(repoDir)): StackedSkip | null {
  if (!target || process.env.LOKI_PR_BASE) return null; // a stacked slice (loki issues run) builds on its parent's run branch on purpose
  const branch = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!branch || !/^loki\/e10-/.test(branch)) return null; // only an engine run branch (loki/${runId}, supervisor.ts); never main (fast-forward accept), loki/epic-*, loki/group-*, loki/unit-* or a user branch
  const log = git(repoDir, ["log", `${target.ref}..HEAD`, "--format=%x01%(trailers:key=Loki-Run,valueonly)"]);
  if (log === null) return null;
  const chunks = log.split("\x01").slice(1);
  if (chunks.length === 0 || chunks.some((c) => c.trim() === "")) return null;
  const mb = git(repoDir, ["rev-parse", "--verify", "-q", `${target.ref}^{commit}`]);
  if (!mb || !/^[0-9a-f]{40}$/.test(mb)) return null;
  return { branch, target: target.ref, commits: chunks.length, base_sha: mb, message: `skipped ${chunks.length} unaccepted Loki commit(s) on ${branch}; merge them first to build on them; base moved to the ${target.ref} tip, which may include upstream commits not yet pulled locally` };
}

/** Start-line fragment naming the PR target and the base the run starts from (no network). Agrees with intake via stackedOnLokiRun. */
export function baseLine(repoDir: string): string {
  const t = resolveBase(repoDir, undefined, false);
  const sk = stackedOnLokiRun(repoDir, t);
  const b = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? "detached HEAD";
  return `PR target: ${t ? t.ref : "unresolved"}, base: ${sk ? `${sk.target} (${sk.message})` : b}`;
}

/** The recorded note from an intake stage.completed data object (null when absent). */
export function noteOf(intake: Record<string, unknown> | undefined): string | null {
  const m = (intake?.["unmerged_loki_work"] as { message?: unknown } | undefined)?.message ?? (intake?.["stacked_loki_skip"] as { message?: unknown } | undefined)?.message;
  return typeof m === "string" && m !== "" ? m : null;
}

// FC-ZERO-ON-BASE. A zero-executed test is excused only if a base rerun cannot observe head code. Linking the head checkout's dependency
// dirs into the base worktree is only safe when nothing in them resolves back into the repo, so the dirs are scanned first.
const WALK_BOUND = 50000;
const REPO_LINK_FILE = /\.pth$|\.egg-link$|^direct_url\.json$|^__editable___.*_finder\.py$/;

/** True when `p` (as spelled, or resolved when it exists) lies inside one of `roots`. */
function insideAny(p: string, roots: string[]): boolean {
  const under = (q: string): boolean => roots.some((r) => q === r || q.startsWith(r + sep));
  if (under(resolve(p))) return true;
  try { return under(realpathSync(p)); } catch { return false; }
}

/** Paths a .pth, .egg-link, direct_url.json or editable finder names: every line and, for a file:// URL, its decoded path. */
function namedPaths(file: string, text: string): string[] {
  const out = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (basename(file) !== "direct_url.json") return out;
  const url = (JSON.parse(text) as { url?: unknown }).url;
  return typeof url === "string" && url.startsWith("file:") ? [...out, fileURLToPath(url)] : out;
}

/** True when dependency dirs under `pkgDir` (node_modules, .venv) can resolve into `repoDir`: any symlink anywhere in them whose target is inside the
 *  repo (nested workspace links included; symlinks are inspected, never followed), or an editable-install file naming the repo. The repo is compared
 *  as given and as realpath. Exceeding the entry bound, or any read error other than a missing dir, withholds (fail closed). */
export function depsSeeHead(pkgDir: string, repoDir: string): boolean {
  let roots: string[];
  try { roots = [...new Set([resolve(repoDir), realpathSync(repoDir)])]; } catch { return true; }
  let seen = 0;
  const walk = (dir: string, own: string[]): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > WALK_BOUND) return true;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        // self-contained only if the REAL target stays in its own dependency dir (npm .bin, pnpm store); the spelled path is used only when dangling
        const t = resolve(dir, readlinkSync(p)); let rt = t; try { rt = realpathSync(t); } catch { /* dangling */ }
        if (insideAny(t, roots) && !own.some((r) => rt === r || rt.startsWith(r + sep))) return true;
      } else if (e.isDirectory()) {
        if (walk(p, own)) return true;
      } else if (REPO_LINK_FILE.test(e.name)) {
        const text = readFileSync(p, "utf8");
        if (roots.some((r) => text.includes(r)) || namedPaths(p, text).some((n) => insideAny(n, roots))) return true;
      }
    }
    return false;
  };
  try {
    return ["node_modules", ".venv"].some((d) => { try { const top = join(pkgDir, d); return walk(top, [...new Set([resolve(top), realpathSync(top)])]); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } });
  } catch { return true; }
}

/** FC-REPO-SKIPPED-TEST-DOWNGRADES, lazy form. Intake no longer runs every test file once on the untouched base (that probe cost FireLater#24
 *  120 of its 122 intake seconds). It records the moment the agent could first touch the environment (`since_ms`, after Loki's own install and
 *  baseline) and the ignored entries that existed then; verify measures only its zero-run candidates, on the base worktree, and trusts that base run
 *  as the pre-change measurement only while envChangedSince finds the environment as intake left it. Ignored entries are listed collapsed (one line
 *  per wholly ignored directory); over IGNORED_CAP entries the list is null and every lazy candidate is withheld. Never throws. */
const IGNORED_CAP = 5000;
export function lazyZeroBaseline(repoDir: string): { lazy: true; since_ms: number; ignored: string[] | null } {
  const raw = git(repoDir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const ignored = raw === null ? null : raw.split("\0").map((p) => p.replace(/\/$/, "")).filter((p) => p !== "" && p !== ".loki" && !p.startsWith(".loki/"));
  return { lazy: true, since_ms: Date.now(), ignored: ignored && ignored.length <= IGNORED_CAP ? ignored : null };
}
/** The intake record as verify's candidate filter: an eager `zero` list (runs from before the lazy form) admits only its names; the lazy record
 *  admits every candidate and hands zeroOnBase the guard inputs. A missing or malformed record admits nothing. */
export interface ZeroGate { has: (name: string) => boolean; sinceMs?: number; ignored?: string[] | null }
export function zeroGate(rec: unknown): ZeroGate {
  const z = (rec && typeof rec === "object" ? rec : {}) as { zero?: unknown; lazy?: unknown; since_ms?: unknown; ignored?: unknown };
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  if (z.lazy === true && typeof z.since_ms === "number") return { has: () => true, sinceMs: z.since_ms, ignored: Array.isArray(z.ignored) ? strs(z.ignored) : null };
  const names = new Set(strs(z.zero));
  return { has: (n) => names.has(n) };
}
// Test runners write their own caches inside node_modules and .venv on every run (Loki's verify included); they hold no dependency code.
const RUNNER_CACHE_DIRS = [".vite", ".vitest", ".cache", "__pycache__", ".pytest_cache"];
/** True (withhold) unless the environment is as intake left it at `sinceMs`: every ignored entry intake listed still exists, and no entry under
 *  `pkgDir`'s node_modules or .venv, and no ignored file intake listed, had its status changed since (ctime, which a process cannot set back;
 *  one `find` walk that never follows symlinks; runner cache dirs pruned). Additions count as changes: an added nested package or .pth file can
 *  change what runs. Ignored directories other than dependency dirs are checked for existence only. Any error withholds. */
export function envChangedSince(repoDir: string, pkgDir: string, sinceMs: number, ignored: string[] | null): boolean {
  if (ignored === null) return true;
  let stampDir = "";
  try {
    const roots: string[] = [];
    for (const rel of ignored) {
      const st = statSync(join(repoDir, rel), { throwIfNoEntry: false }); // a dangling link reads as missing, which withholds
      if (!st) return true;
      if (!st.isDirectory()) roots.push(join(repoDir, rel));
    }
    for (const d of ["node_modules", ".venv"]) if (existsSync(join(pkgDir, d))) roots.push(join(pkgDir, d));
    if (roots.length === 0) return false;
    stampDir = mkdtempSync(join(tmpdir(), "loki-zero-stamp-"));
    const stamp = join(stampDir, "since");
    writeFileSync(stamp, "");
    utimesSync(stamp, sinceMs / 1000, sinceMs / 1000);
    const prune = RUNNER_CACHE_DIRS.flatMap((n, i) => [...(i ? ["-o"] : []), "-name", n]);
    const out = execFileSync("find", ["-P", ...new Set(roots), "(", ...prune, ")", "-prune", "-o", "-cnewer", stamp, "-print", "-quit"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000 });
    return out.trim() !== "";
  } catch { return true; } finally { if (stampDir) rmSync(stampDir, { recursive: true, force: true }); }
}

/** FC-ZERO-ON-BASE: for each zero-executed candidate run its command once in the base worktree `baseDir` (deps linked from the head checkout, never
 *  copied) and return the names that also execute zero tests there. A candidate whose deps can see head sources, or whose base run is cut, missing
 *  or not a zero, is left out (stays NOT PROVEN). `note` is called per excused name. With a lazy `gate` (sinceMs set) a candidate is also left
 *  out when envChangedSince finds the environment changed since intake: the base run then no longer stands for the untouched base. */
export async function zeroOnBase(
  cands: { name: string; cmd: string; args: string[]; cwd: string }[], baseDir: string, repoDir: string,
  run: (c: { cmd: string; args: string[]; cwd: string }) => Promise<{ ok: boolean; cut: boolean; missing: boolean; out: string }>, note: (name: string) => void,
  gate: Pick<ZeroGate, "sinceMs" | "ignored"> = {},
): Promise<string[]> {
  const zero: string[] = [], envMoved = new Map<string, boolean>(); // one guard walk per package dir per call
  const moved = (src: string): boolean => { if (!envMoved.has(src)) envMoved.set(src, envChangedSince(repoDir, src, gate.sinceMs!, gate.ignored ?? null)); return envMoved.get(src)!; };
  for (const c of cands) {
    const src = join(repoDir, relative(baseDir, c.cwd));
    if (depsSeeHead(src, repoDir) || (gate.sinceMs !== undefined && moved(src))) continue;
    for (const d of ["node_modules", ".venv"]) { try { if (existsSync(join(src, d)) && !existsSync(join(c.cwd, d))) symlinkSync(join(src, d), join(c.cwd, d)); } catch { /* no deps on base: not zero, stays fail-closed */ } }
    if (isZeroRun(c, await run(c))) { zero.push(c.name); note(c.name); }
  }
  return zero;
}

/** True when one finished run of a test command executed zero tests (the shared mapping of 0 tests to not_run; a cut or missing run never counts). */
export function isZeroRun(c: { cmd: string; args: string[] }, b: { ok: boolean; cut: boolean; missing: boolean; out: string }): boolean {
  const last = c.args[c.args.length - 1] ?? "";
  const k = classifyCheck({ kind: "test", ok: b.ok, cut: b.cut, missing: b.missing, out: b.out, ...goRunner(c.cmd, c.args), path: /\.[cm]?[jt]s$/.test(last) ? last : undefined });
  return k.result === "not_run" && k.n === 0 && !b.cut && !b.missing;
}

/** FC-WALL-PHANTOM-PATH: a symlink ADDED by the change (status A, or T where a regular file became a link; a retargeted link, M, is not) or an added submodule pointer (mode 160000) makes a missing path appear without implementing anything. NOT PROVEN by name unless the plan asks for one: only the words symlink(s) / submodule(s), and not negated ("no symlink", "do not add a symlink", "without a submodule"). Input is the raw diff-tree -z list (meta, path pairs). */
export function addedSymlinkNotes(rawDiff: string[], planText: string | null): string[] {
  const asks = (w: string): boolean => [...(planText ?? "").matchAll(new RegExp(`\\b${w}s?\\b`, "gi"))].some((m) => !/\b(?:no|not|never|without|avoid|don'?t|cannot|can'?t)\b[^.\n]{0,40}$/i.test(planText!.slice(Math.max(0, m.index! - 45), m.index!)));
  const out: string[] = [];
  for (let i = 0; i + 1 < rawDiff.length; i += 2) {
    const f = rawDiff[i]!.trim().split(" "), oldMode = f[0]!.replace(/^:/, ""), st = f[f.length - 1]!, p = rawDiff[i + 1]!;
    if (f[1] === "120000" && (st === "A" || (st === "T" && oldMode !== "120000")) && !asks("symlink")) out.push(`symlink added by the change (a link can stand in for missing work; the plan did not ask for one): ${p}`);
    else if (f[1] === "160000" && (st === "A" || st === "T") && !asks("submodule")) out.push(`submodule pointer added by the change (it can stand in for missing work; the plan did not ask for one): ${p}`);
  }
  return out;
}

export interface DeclaredAdvisoryCtx {
  repoDir: string; runDir: string; baseSha: string;
  rawDiff: string[]; // diff-tree -z --raw list (meta, path pairs)
  planFiles: string[]; // plan-scope.json "files"
  wallPaths: string[]; // repo-relative Wall test paths
  wallPassedN: boolean; // the Wall ran and passed with n > 0 in verify's raw checks
  task?: string; // the user's task text (an added manifest may be named there instead of in the plan)
  head?: string; // the sealed head commit: an added manifest is read from this blob, not from the working tree
}
const ADVISORY_PATH = /^(?:test configuration changed|runner config changed): (.+?)(?: \(.*\))?$|^symlink added by the change .*?\): (.+)$/;
/** An advisory about a change the plan declared, or that a passing Wall requires, is disclosed and does not cap the verdict. Only ADDED paths qualify, so an edit to an existing file still caps,
 *  and so does anything the plan never declared. A config advisory caps, except an ADDED workspace manifest that passes every addedManifestOk condition. Symlink: it resolves, through every hop, to a regular file inside the repo that THIS diff added or modified and that is neither a test nor a Wall file, AND the
 *  plan declared the link or a passing Wall names its path (or quotes its name). Everything else stays capping. */
export function splitDeclaredAdvisories(notes: string[], c: DeclaredAdvisoryCtx): { capping: string[]; disclosed: string[]; extra?: string[] } {
  const added = new Set<string>(), changed = new Set<string>();
  for (let i = 0; i + 1 < c.rawDiff.length; i += 2) { const st = c.rawDiff[i]!.trim().split(" ").pop(); if (st === "A") added.add(c.rawDiff[i + 1]!); if (st === "A" || st === "M") changed.add(c.rawDiff[i + 1]!); }
  let wallText: string | null = null;
  const wall = (): string => wallText ??= c.wallPaths.map((w) => { for (const f of [sealedWallCopy(c.runDir, w), join(c.repoDir, w)]) try { return readFileSync(f, "utf8"); } catch { /* try next */ } return ""; }).join("\n");
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = (f: string): boolean => new RegExp(`${f.includes("/") ? `(?<![\\w./-])${esc(f)}(?![\\w-])|` : ""}[/"'\`]${esc(basename(f))}(?=["'\`\\s);]|$)`).test(wall());
  const linkOk = (f: string): boolean => {
    try {
      const root = realpathSync(c.repoDir), t = realpathSync(join(c.repoDir, f)), rel = relative(root, t);
      return !rel.startsWith("..") && !rel.split(sep).includes(".git") && statSync(t).isFile() && changed.has(rel.split(sep).join("/")) && !isTestFile(rel) && !c.wallPaths.includes(rel);
    } catch { return false; }
  };
  const capping: string[] = [], disclosed: string[] = [], extra: string[] = [];
  for (const n of notes) {
    const m = ADVISORY_PATH.exec(n), f = m?.[1] ?? m?.[2];
    const ok = !!m && !!f && added.has(f) && c.wallPassedN && ((m[2] !== undefined && linkOk(f) && (c.planFiles.includes(f) || named(f))) || (m[1] !== undefined && addedManifestOk(f, c, wall(), esc, extra)));
    (ok ? disclosed : capping).push(n);
  }
  return extra.length ? { capping, disclosed, extra } : { capping, disclosed };
}

// Run-end cleanup. Every run ends with the user's checkout back on the branch it started from and no loki/e10-* branch left behind:
// a branch is deleted only once its history is safe (pushed, reachable from another branch, remote or tag, or saved as a verified
// git bundle under .loki/runs/<id>/). LOKI_KEEP_RUN_BRANCH=1 turns all of it off (the --attempts and issues-run worktree flows set it:
// they manage their own branches). Never touches a non-loki branch, a branch checked out in any worktree, a live run's branch, or a run `loki start` can still resume.
const E10_BRANCH_RE = /^loki\/(e10-[A-Za-z0-9-]+)$/;
const RUN_TMP_WORKTREE_RE = /^(?:e10-base-|e10-loadown-|loki-mutproof-)/; // verify, load-owner and mutation-proof base worktrees (removed in their own finally; a SIGKILL leaks them)
const NOT_ELSEWHERE = ["--not", "--remotes", "--tags", "--exclude=loki/*", "--branches"]; // commits only loki/ branches hold
const tipOf = (repoDir: string, ref: string): string | null => {
  try { return safeGit(repoDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
};
export const keepRunBranch = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_KEEP_RUN_BRANCH === "1";
export interface RunEnd { orig: string | null; pushed: boolean; deferred?: boolean; keepWork?: boolean; baseSha?: string | null }
export interface BranchRecord { branch: string; head_sha: string; pushed: boolean; bundle: string | null; orig_branch?: string | null; deferred?: boolean }

function checkedOut(repoDir: string): { branches: Set<string>; trees: { path: string; head: string; detached: boolean }[] } {
  const branches = new Set<string>(), trees: { path: string; head: string; detached: boolean }[] = [];
  for (const block of (git(repoDir, ["worktree", "list", "--porcelain"]) ?? "").split("\n\n")) {
    const f = Object.fromEntries(block.split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]));
    if (f.branch) branches.add(f.branch.replace(/^refs\/heads\//, ""));
    if (f.worktree) trees.push({ path: f.worktree, head: f.HEAD ?? "", detached: "detached" in f });
  }
  return { branches, trees };
}

/** Removes base worktrees a killed verify left in the temp dir: detached at this run's base and named by the engine's own prefixes. */
function removeRunWorktrees(repoDir: string, baseSha: string | null | undefined): void {
  if (!baseSha) return;
  const roots = [tmpdir()]; try { roots.push(realpathSync(tmpdir())); } catch { /* tmpdir only */ }
  for (const t of checkedOut(repoDir).trees.slice(1)) {
    const named = RUN_TMP_WORKTREE_RE.test(basename(t.path)) || RUN_TMP_WORKTREE_RE.test(basename(dirname(t.path)));
    if (t.detached && t.head === baseSha && named && roots.some((r) => t.path.startsWith(r + sep))) git(repoDir, ["worktree", "remove", "--force", "--force", t.path]);
  }
}

const deepAlive = (runDir: string): boolean => {
  try {
    const pid = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"deep.started"')).map((l) => Number((JSON.parse(l) as { data?: { pid?: unknown } }).data?.pid)).pop();
    if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0); return true;
  } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const runLive = (runDir: string): boolean => runOwnerAlive(runDir) || deepAlive(runDir);
const readRecord = (file: string): Partial<BranchRecord> | null => { try { return JSON.parse(readFileSync(file, "utf8")) as Partial<BranchRecord>; } catch { return null; } };

/** Saves (when needed) and deletes one loki/ branch. `dir`/`stem` name the record and bundle files. Returns the restore line, a keep note, or "". */
function settleBranch(repoDir: string, branch: string, dir: string, stem: string, pushed: boolean, extra: Partial<BranchRecord> = {}): { note: string; deleted: boolean } {
  const tip = tipOf(repoDir, `refs/heads/${branch}`);
  if (!tip) return { note: "", deleted: false };
  const unique = pushed ? 0 : Number(git(repoDir, ["rev-list", "--count", `refs/heads/${branch}`, ...NOT_ELSEWHERE]) ?? NaN);
  if (!Number.isInteger(unique)) return { note: `engine10: kept ${branch}: could not tell whether its commits exist elsewhere\n`, deleted: false };
  let bundle: string | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    if (unique > 0) {
      const file = join(dir, `${stem}.bundle`);
      if (git(repoDir, ["bundle", "create", file, `refs/heads/${branch}`, ...NOT_ELSEWHERE], 120000) === null || git(repoDir, ["bundle", "verify", file], 120000) === null) throw new Error("bundle");
      bundle = relative(repoDir, file);
    }
    writeFileSync(join(dir, `${stem}.json`), JSON.stringify({ ...extra, branch, head_sha: tip, pushed, bundle } satisfies BranchRecord, null, 2) + "\n");
  } catch { return { note: `engine10: kept ${branch}: its ${unique} unpushed commit(s) could not be saved under ${relative(repoDir, dir)}\n`, deleted: false }; }
  if (git(repoDir, ["update-ref", "-d", `refs/heads/${branch}`, tip]) === null) return { note: `engine10: could not delete ${branch}; remove it with: git branch -D ${branch}\n`, deleted: false };
  return { note: bundle ? `engine10: run branch ${branch} removed, its history is saved; restore it with: git fetch ${bundle} ${branch}:${branch}\n` : "", deleted: true };
}

/** Puts the checkout back on `orig` when it sits on the run branch and the tracked tree is clean; never discards an edit. */
function returnCheckout(repoDir: string, branch: string, orig: string | null): string | null {
  const cur = currentBranch(repoDir);
  if (cur !== branch) return null; // already back (a stop restores it) or the user moved on: left where it is
  if (!orig || orig === branch) return `engine10: the checkout stays on ${branch}: the run did not record the branch it started from\n`;
  if (git(repoDir, ["status", "--porcelain", "--untracked-files=no"]) !== "") return `engine10: the checkout stays on ${branch}: it has uncommitted changes; return with: git checkout ${orig}\n`;
  return git(repoDir, ["checkout", "-q", orig]) === null ? `engine10: the checkout stays on ${branch}: git checkout ${orig} failed; return with: git checkout ${orig}\n` : null;
}

/**
 * The end of one run: return the checkout, remove leftover base worktrees, delete the run branch once its history is safe, migrate loose
 * session files and sweep earlier runs' branches. Returns the lines to print. `deferred`: a detached deep verify still runs on the branch,
 * so only a record is written and finishDeferredRun does the rest when it ends. `keepWork`: a passing run that published nothing keeps
 * its branch checked out, since that branch is the result (a later run's sweep saves and removes it once the user has moved off it).
 */
export function finishRunBranch(repoDir: string, runId: string, end: RunEnd, env: NodeJS.ProcessEnv = process.env): string {
  if (keepRunBranch(env) || !/^e10-[A-Za-z0-9-]+$/.test(runId)) return "";
  const branch = `loki/${runId}`, runDir = join(repoDir, ".loki", "runs", runId), tip = tipOf(repoDir, `refs/heads/${branch}`);
  try {
    if (end.deferred && tip) {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "branch.json"), JSON.stringify({ branch, head_sha: tip, pushed: end.pushed, bundle: null, orig_branch: end.orig, deferred: true } satisfies BranchRecord, null, 2) + "\n");
      return `engine10: the checkout stays on ${branch} while the background deep verify runs, then returns to ${end.orig ?? "the starting branch"}\n`;
    }
    removeRunWorktrees(repoDir, end.baseSha);
    migrateSessionFiles(repoDir, runLive);
    let notes = "";
    const keepHere = end.keepWork === true && tip !== null && tipOf(repoDir, end.baseSha ?? "") !== tip;
    if (tip && !keepHere) {
      const stay = returnCheckout(repoDir, branch, end.orig);
      if (stay) notes += stay;
      else if (findInterrupted(repoDir, runId, true) === null) notes += settleBranch(repoDir, branch, runDir, "branch", end.pushed && tip !== null, { orig_branch: end.orig }).note; // a resumable run keeps its branch for `loki start`
    }
    return notes + sweepRunBranches(repoDir, env, runId);
  } catch (e) { return `engine10: run-end cleanup skipped: ${(e as Error).message}\n`; }
}

/** Called by the deep worker when it ends: finishes the cleanup finishRunBranch deferred for this run. */
export function finishDeferredRun(repoDir: string, runId: string, env: NodeJS.ProcessEnv = process.env): string {
  const rec = readRecord(join(repoDir, ".loki", "runs", runId, "branch.json"));
  if (!rec?.deferred || rec.branch !== `loki/${runId}`) return "";
  const tip = tipOf(repoDir, `refs/heads/${rec.branch}`);
  return finishRunBranch(repoDir, runId, { orig: rec.orig_branch ?? null, pushed: rec.pushed === true && tip === rec.head_sha }, env);
}

/** Saves and removes loki/e10-* branches earlier runs left: never a branch checked out anywhere, a live run's, or the resumable run's. */
export function sweepRunBranches(repoDir: string, env: NodeJS.ProcessEnv = process.env, skipRunId?: string): string {
  if (keepRunBranch(env)) return "";
  const names = (git(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/loki/"]) ?? "").split("\n").filter((b) => E10_BRANCH_RE.test(b));
  if (names.length === 0) return "";
  const busy = checkedOut(repoDir).branches, runs = join(repoDir, ".loki", "runs"), resumable = findInterrupted(repoDir, undefined, true)?.runId;
  let removed = 0, saved = 0; const kept: string[] = [];
  for (const branch of names) {
    const id = E10_BRANCH_RE.exec(branch)![1]!, runDir = join(runs, id), own = existsSync(runDir);
    if (id === skipRunId || id === resumable || busy.has(branch) || (own && runLive(runDir))) continue;
    const rec = own ? readRecord(join(runDir, "branch.json")) : null, tip = tipOf(repoDir, `refs/heads/${branch}`);
    const r = own ? settleBranch(repoDir, branch, runDir, "branch", rec?.pushed === true && rec.head_sha === tip) : settleBranch(repoDir, branch, join(runs, LEGACY_BRANCHES_DIR), id, false);
    if (r.deleted) { removed++; if (r.note) saved++; } else if (r.note) kept.push(r.note);
  }
  if (removed === 0) return kept.join("");
  return `engine10: removed ${removed} run branch(es) left by earlier runs${saved ? `; ${saved} with unpushed commits saved as bundles under .loki/runs/ (restore one with: git fetch <bundle> <branch>:<branch>)` : ""}\n${kept.join("")}`;
}
