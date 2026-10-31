// loki-ts/src/util/base_guard.ts -- FC-15: the one place the PR target is resolved and a claim is checked against it.
// A run starts from the base the user asked for; only the ALREADY_SATISFIED claim must rest on the PR target, never on
// commits that exist only in target..HEAD (Loki's own unmerged work or the user's own).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCheck, goRunner, sealedWallCopy } from "./check_result.ts";
import { listRunIds } from "../commands/run_status.ts";
import { safeGit } from "./safe_git.ts";
import { addedManifestOk } from "./lock_ecosystems.ts";
import { isTestFile } from "./test_file_text.ts";
import { currentBranch, restoreBranch } from "../e10ext/stop_restore.ts";

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

/** FC-ZERO-ON-BASE: for each zero-executed candidate run its command once in the base worktree `baseDir` (deps linked from the head checkout, never
 *  copied) and return the names that also execute zero tests there. A candidate whose deps can see head sources, or whose base run is cut, missing
 *  or not a zero, is left out (stays NOT PROVEN). `note` is called per excused name. */
export async function zeroOnBase(
  cands: { name: string; cmd: string; args: string[]; cwd: string }[], baseDir: string, repoDir: string,
  run: (c: { cmd: string; args: string[]; cwd: string }) => Promise<{ ok: boolean; cut: boolean; missing: boolean; out: string }>, note: (name: string) => void,
): Promise<string[]> {
  const zero: string[] = [];
  for (const c of cands) {
    const src = join(repoDir, relative(baseDir, c.cwd));
    if (depsSeeHead(src, repoDir)) continue;
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
export function splitDeclaredAdvisories(notes: string[], c: DeclaredAdvisoryCtx): { capping: string[]; disclosed: string[] } {
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
  const capping: string[] = [], disclosed: string[] = [];
  for (const n of notes) {
    const m = ADVISORY_PATH.exec(n), f = m?.[1] ?? m?.[2];
    const ok = !!m && !!f && added.has(f) && c.wallPassedN && ((m[2] !== undefined && linkOk(f) && (c.planFiles.includes(f) || named(f))) || (m[1] !== undefined && addedManifestOk(f, c, wall(), esc)));
    (ok ? disclosed : capping).push(n);
  }
  return { capping, disclosed };
}

const RUN_BRANCH_RE = /^loki\/[A-Za-z0-9._\/-]+$/;
const tipOf = (repoDir: string, ref: string): string | null => {
  try { return safeGit(repoDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
};

/**
 * FC-EMPTY-RUN-BRANCH-LEFT-CHECKED-OUT: a run that ended with its branch tip still at the run base_sha committed nothing. Put the user back on the
 * branch they started from and delete that empty `loki/` branch. A branch with any commit (the Wall's, a backstop) is never touched, nor is a
 * branch the user is not on or started from (they switched mid-run: left alone, noted). Returns a note to print, or null when nothing needed saying.
 */
export function dropEmptyRunBranch(repoDir: string, orig: string | null, runBranch: unknown, baseSha: string | null): string | null {
  if (!orig || !baseSha || typeof runBranch !== "string" || !RUN_BRANCH_RE.test(runBranch) || runBranch.includes("..") || runBranch === orig) return null;
  const tip = tipOf(repoDir, `refs/heads/${runBranch}`);
  if (tip === null || tip !== tipOf(repoDir, baseSha)) return null;
  const cur = currentBranch(repoDir);
  if (cur !== runBranch && cur !== orig) return `engine10: you moved to ${cur ?? "a detached HEAD"} during the run; left there. The run committed nothing; remove the empty branch with: git branch -D ${runBranch}\n`;
  if (cur === runBranch && !restoreBranch(repoDir, orig)) return null; // restoreBranch already told the user how to return
  try { safeGit(repoDir, ["update-ref", "-d", `refs/heads/${runBranch}`, tip], { stdio: "ignore" }); } catch { return `engine10: could not delete the empty run branch ${runBranch}: git branch -D ${runBranch}\n`; }
  return null;
}
