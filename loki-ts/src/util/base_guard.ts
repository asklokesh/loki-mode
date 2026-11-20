// loki-ts/src/util/base_guard.ts -- FC-15: the one place the PR target is resolved and a claim is checked against it.
// A run starts from the base the user asked for; only the ALREADY_SATISFIED claim must rest on the PR target, never on
// commits that exist only in target..HEAD (Loki's own unmerged work or the user's own).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCheck, fileHashes, goRunner, sealedWallCopy } from "./check_result.ts";
import { LEGACY_BRANCHES_DIR, listRunIds } from "../commands/run_status.ts";
import { runOwnerAlive } from "./run_pid.ts";
import { findInterrupted } from "./run_outputs.ts";
import { migrateSessionFiles } from "../runner/session_resume.ts";
import { safeGit } from "./safe_git.ts";
import { addedManifestOk } from "./lock_ecosystems.ts";
import { isTestFile } from "./test_file_text.ts";
import { currentBranch } from "../e10ext/stop_restore.ts";
import { escapeRegex } from "./regex_escape.ts";
import { splitDirty } from "../e10ext/preexisting_dirty.ts";

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
  // A leftover run branch with no commits of its own (a cancelled run) sits on the PR target's tip: name the target, which is what the run builds on.
  const same = !sk && t && /^loki\//.test(b) && git(repoDir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]) === git(repoDir, ["rev-parse", "-q", "--verify", `${t.ref}^{commit}`]);
  return `PR target: ${t ? t.ref : "unresolved"}, base: ${sk ? `${sk.target} (${sk.message})` : same ? t!.ref : b}`;
}

// ---- PR-BASE begin: the label must describe exactly what the pull request merges (FireLater#19, pull request 70: a run started on a
// feature branch whose tip was not in main measured 12 files against that tip and opened a pull request into main that merged 40).
/** What the run starts from and what its pull request targets, decided once by the supervisor before any model spend (PR mode only). */
export interface PrBasePlan {
  action: "keep" | "target-tip" | "current-branch" | "refuse";
  target: string | null; // the ref the pull request is compared against (origin/main)
  start_sha: string | null; // target-tip: the commit intake creates the run branch from
  pr_base: string | null; // current-branch: the branch the pull request targets (LOKI_PR_BASE)
  line: string | null; // one plain line for the user (the refusal text when action is refuse)
  header: string | null; // the start line's target and base fragment; null keeps baseLine()
}
const short = (sha: string | null): string => (sha ?? "").slice(0, 7);
const trackedDirt = (repoDir: string): string[] | null => { const o = git(repoDir, ["status", "--porcelain", "--untracked-files=no"]); return o === null ? null : o.split("\n").filter((l) => l !== "" && !/^.{0,2} "?\.loki\//.test(l)); };
/** Paths the checkout of `target` would create that already exist in the working tree (untracked or ignored there): git would refuse or overwrite them. */
function checkoutCollisions(repoDir: string, target: string): string[] | null {
  const added = git(repoDir, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "HEAD", target]);
  if (added === null) return null;
  return added.split("\n").filter((p) => p !== "" && ((): boolean => { try { lstatSync(join(repoDir, p)); return true; } catch { return false; } })());
}
/** The ref a pull request is really opened against: LOKI_PR_BASE when set (a stacked slice or --base-current; a loki/* parent is a valid one here,
 *  unlike in resolveBase), else the default branch. Fetches that one branch best effort. Null: nothing to compare with. */
export function prTargetRef(repoDir: string, prBase: string | undefined, fetchRemote = true): string | null {
  if (!prBase) return resolveBase(repoDir, "", fetchRemote)?.ref ?? null;
  if (fetchRemote && process.env.LOKI_E10_NO_FETCH !== "1" && git(repoDir, ["remote", "get-url", "origin"]) !== null) git(repoDir, ["fetch", "-q", "origin", prBase], 10000, { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  return exists(repoDir, `origin/${prBase}`) ? `origin/${prBase}` : exists(repoDir, prBase) ? prBase : null;
}
/** PR-BASE rule 1. Nothing changes, and nothing is fetched, when HEAD is already in the target. Otherwise, in this order: (a) a clean tree starts
 *  from the target tip; (b) --base-current (LOKI_BASE_CURRENT=1) targets the current branch when origin has it and HEAD is in it; (c) refuse with the
 *  two commands that work. A dirty tracked tree and a detached HEAD keep what intake does today (refusal; start from that commit). Never writes. */
export function prBasePlan(repoDir: string, o: { baseCurrent: boolean; env?: NodeJS.ProcessEnv }): PrBasePlan {
  const env = o.env ?? process.env, keep = (target: string | null, line: string | null = null): PrBasePlan => ({ action: "keep", target, start_sha: null, pr_base: null, line, header: null });
  const anc = (ref: string): boolean => ok(repoDir, ["merge-base", "--is-ancestor", "HEAD", ref]);
  if (env.LOKI_PR_BASE) return keep(prTargetRef(repoDir, env.LOKI_PR_BASE, false)); // a stacked slice (loki issues run): the caller chose the target
  let t = resolveBase(repoDir, "", false); // "" and not LOKI_E10_BASE: the push opens the pull request into the default branch unless LOKI_PR_BASE names another
  if (!t || !t.ref.startsWith("origin/")) return keep(null); // no origin, or origin has no default branch: there is no pull request target to compare with, so nothing is recorded or measured
  if (anc(t.ref)) return keep(t.ref); // the normal run: no fetch, nothing printed
  t = resolveBase(repoDir, "") ?? t; // HEAD is not in the local view of the target: look at the real one, once
  if (!t.ref.startsWith("origin/")) return keep(null);
  if (anc(t.ref) || stackedOnLokiRun(repoDir, t)) return keep(t.ref); // intake already moves an all-Loki run branch to the target tip
  const branch = git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"]) || null, head = git(repoDir, ["rev-parse", "HEAD"]), tname = t.ref.replace(/^origin\//, "");
  const n = Number(git(repoDir, ["rev-list", "--count", `${t.ref}..HEAD`]) ?? "0") || 0, commits = (k: number): string => `${k} other commit${k === 1 ? "" : "s"}`;
  const refuse = (why: string, cmds: [string, string]): PrBasePlan => ({ action: "refuse", target: t!.ref, start_sha: null, pr_base: null, header: null, line: `${why}. Nothing was run. Either: ${cmds[0]}; or: ${cmds[1]}` });
  const stackCmd = branch ? `git push -u origin ${branch}, then rerun with --base-current (pull request into ${branch})` : `git switch -c <branch>, git push -u origin <branch>, then rerun with --base-current`;
  const wtCmd = `git worktree add ../${basename(repoDir)}-${tname.replace(/[^A-Za-z0-9._-]+/g, "-")} ${t.ref}, then rerun there (pull request into ${tname})`;
  if (o.baseCurrent) {
    if (!branch) return refuse(`--base-current needs a branch, and HEAD is detached at ${short(head)}: a pull request into ${tname} would carry ${commits(n)}`, [stackCmd, wtCmd]);
    if (git(repoDir, ["remote", "get-url", "origin"]) !== null && env.LOKI_E10_NO_FETCH !== "1") git(repoDir, ["fetch", "-q", "origin", branch], 10000, { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    const remote = `origin/${branch}`;
    if (exists(repoDir, remote) && anc(remote)) return { action: "current-branch", target: remote, start_sha: null, pr_base: branch, header: `PR target: ${remote}, base: ${branch}`, line: `building on your branch ${branch}: the pull request targets ${branch}, not ${tname} (stacked pull request)` };
    const un = exists(repoDir, remote) ? Number(git(repoDir, ["rev-list", "--count", `${remote}..HEAD`]) ?? "0") || 0 : n;
    return refuse(exists(repoDir, remote) ? `your branch ${branch} has ${un} commit${un === 1 ? "" : "s"} that origin/${branch} does not, so the pull request would carry ${commits(un)}` : `your branch ${branch} is not on origin, so the pull request would go into ${tname} and carry ${commits(n)}`,
      [stackCmd, `rerun without --base-current to start from ${t.ref} (pull request into ${tname}, this change only)`]);
  }
  if (!branch) return keep(t.ref, `detached HEAD ${short(head)} is not in ${t.ref}: the pull request would carry ${commits(n)}, so the label is held at PARTIAL and the pull request opens as a draft (check out a branch, or pass --no-pr)`);
  const dirt = trackedDirt(repoDir);
  if (dirt === null) return refuse(`cannot read the working tree state, so the run cannot safely start from ${t.ref} instead of your branch ${branch}`, [stackCmd, wtCmd]);
  if (dirt.length > 0) { // intake refuses a dirty tracked tree itself (unchanged); only a modified lockfile passes it, and that cannot be carried to another commit
    const { blocking } = splitDirty(repoDir, dirt);
    return blocking.length > 0 ? keep(t.ref) : refuse(`your branch ${branch} is not in ${t.ref} and the working tree has uncommitted changes (${dirt.map((l) => l.slice(3)).slice(0, 3).join(", ")}), so the run cannot start from ${t.ref} without touching them`, [stackCmd, wtCmd]);
  }
  const hit = checkoutCollisions(repoDir, t.ref), sha = git(repoDir, ["rev-parse", "--verify", "-q", `${t.ref}^{commit}`]);
  if (hit === null || !sha || !/^[0-9a-f]{40}$/.test(sha)) return refuse(`${t.ref} cannot be read, so the run cannot start from it instead of your branch ${branch}`, [stackCmd, wtCmd]);
  if (hit.length > 0) return refuse(`your branch ${branch} is not in ${t.ref}, and starting from ${t.ref} would overwrite ${hit.length} file${hit.length === 1 ? "" : "s"} in your working tree that ${branch} does not track (${hit.slice(0, 3).join(", ")}${hit.length > 3 ? `, +${hit.length - 3} more` : ""})`, [stackCmd, wtCmd]);
  return { action: "target-tip", target: t.ref, start_sha: sha, pr_base: null, header: `PR target: ${t.ref}, base: ${t.ref}`, line: `starting from ${t.ref}, not from your branch ${branch}, so the pull request holds only this change (use --base-current to build on your branch)` };
}
/** The refusal intake gives when the checkout of the target tip fails after all (case c, before any session). */
export const startFromRefusal = (target: string, branch: string | null, repoDir: string): string =>
  `cannot start from ${target}: git could not create the run branch there without touching your working tree. Nothing was run. Either: ${branch ? `git push -u origin ${branch}, then rerun with --base-current (pull request into ${branch})` : "check out a branch and rerun with --base-current"}; or: git worktree add ../${basename(repoDir)}-base ${target}, then rerun there`;

/** What a pull request into `target` would hold, against what the run measured (base_sha..head). GitHub's own semantics: files are the diff
 *  from the merge base, commits are target..head, so a target that only moved forward changes nothing. Any git error is `ok: false`: never green. */
export interface PrScope { target: string; target_sha: string | null; merge_base: string | null; base_sha: string; head_sha: string | null; pr_files: number | null; measured_files: number | null; pr_commits: number | null; measured_commits: number | null; unmeasured_files: number; ok: boolean; reason: string | null }
export function prScope(repoDir: string, a: { target: string | null; baseSha: string | null; head?: string }): PrScope {
  const headRef = a.head ?? "HEAD", target = a.target ?? "unresolved", base = a.baseSha ?? "";
  const none: PrScope = { target, target_sha: null, merge_base: null, base_sha: base, head_sha: null, pr_files: null, measured_files: null, pr_commits: null, measured_commits: null, unmeasured_files: 0, ok: false, reason: `the pull request target ${target} could not be read, so what it would merge was not compared with what the label measured` };
  if (!a.target || !/^[0-9a-f]{40}$/.test(base)) return a.target ? { ...none, reason: "the run recorded no base commit, so what the pull request would merge was not compared with what the label measured" } : none;
  const tsha = git(repoDir, ["rev-parse", "--verify", "-q", `${a.target}^{commit}`]), head = git(repoDir, ["rev-parse", "--verify", "-q", `${headRef}^{commit}`]);
  if (!tsha || !head) return none;
  const mb = git(repoDir, ["merge-base", tsha, head]);
  const list = (args: string[]): string[] | null => { const o = git(repoDir, args); return o === null ? null : o.split("\n").filter((l) => l !== ""); };
  const files = (from: string): string[] | null => list(["diff", "--name-only", "--no-renames", from, head, "--", ".", ":(exclude).loki"]);
  const prF = mb ? files(mb) : null, mF = files(base), prC = list(["rev-list", `${tsha}..${head}`]), mC = list(["rev-list", `${base}..${head}`]);
  if (!mb || !prF || !mF || !prC || !mC) return { ...none, target_sha: tsha, head_sha: head, merge_base: mb };
  const measured = new Set(mF), mine = new Set(mC), extraF = prF.filter((f) => !measured.has(f)).length, extraC = prC.filter((c) => !mine.has(c)).length;
  const same = extraF === 0 && extraC === 0 && prF.length === mF.length && prC.length === mC.length;
  const reason = same ? null : extraF > 0 ? `the pull request would merge ${extraF} file${extraF === 1 ? "" : "s"} the label did not measure (${prF.length} files and ${prC.length} commits into ${target}; the label measured ${mF.length} files and ${mC.length} commits from ${short(base)})`
    : `the pull request into ${target} would not hold what the label measured (${prF.length} files and ${prC.length} commits, ${extraC} of them not this run's; the label measured ${mF.length} files and ${mC.length} commits from ${short(base)})`;
  return { target, target_sha: tsha, merge_base: mb, base_sha: base, head_sha: head, pr_files: prF.length, measured_files: mF.length, pr_commits: prC.length, measured_commits: mC.length, unmeasured_files: extraF, ok: same, reason };
}
/** Intake's record of the plan (PR mode only: the supervisor exports LOKI_E10_PR_TARGET); absent otherwise, so other receipts keep their keys. */
export function intakePrBase(repoDir: string, env: NodeJS.ProcessEnv, startBranch: string | null, fromTarget: boolean): { pr_base?: { target: string; target_sha: string | null; start_branch: string | null; mode: "target-tip" | "current-branch" | "head" } } {
  const target = env.LOKI_E10_PR_TARGET;
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/.test(target)) return {};
  return { pr_base: { target, target_sha: git(repoDir, ["rev-parse", "--verify", "-q", `${target}^{commit}`]), start_branch: startBranch, mode: fromTarget ? "target-tip" : env.LOKI_PR_BASE ? "current-branch" : "head" } };
}
/** Seal time (the worker, no network): the same measurement, as one open note that holds the label at PARTIAL and one receipt block. Both empty when intake recorded no target. */
export function sealPrScope(repoDir: string, intake: Record<string, unknown> | undefined, baseSha: string, head: string): { notes: string[]; receipt: Record<string, unknown> } {
  const pb = intake?.["pr_base"] as { target?: unknown; mode?: unknown; start_branch?: unknown } | undefined;
  if (!pb || typeof pb.target !== "string") return { notes: [], receipt: {} };
  const s = prScope(repoDir, { target: pb.target, baseSha, head });
  return { notes: s.ok ? [] : [s.reason!], receipt: { pr_base: { target: s.target, target_sha: s.target_sha, merge_base: s.merge_base, base_sha: s.base_sha, pr_files: s.pr_files, measured_files: s.measured_files, pr_commits: s.pr_commits, measured_commits: s.measured_commits, mode: typeof pb.mode === "string" ? pb.mode : "head", start_branch: typeof pb.start_branch === "string" ? pb.start_branch : null, line: prScopeLine(s) } } };
}
/** The one line the receipt and the pull request body carry: base and target. */
export const prScopeLine = (s: PrScope): string => `Base and target: built from ${short(s.base_sha) || "an unrecorded base"}, pull request into ${s.target.replace(/^origin\//, "")}${s.target_sha ? ` at ${short(s.target_sha)}` : ""}; ${s.pr_files ?? "unknown"} file${s.pr_files === 1 ? "" : "s"} and ${s.pr_commits ?? "unknown"} commit${s.pr_commits === 1 ? "" : "s"} against that target, ${s.measured_files ?? "unknown"} file${s.measured_files === 1 ? "" : "s"} measured.`;
// ---- PR-BASE end

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
export function lazyZeroBaseline(repoDir: string): { lazy: true; since_ms: number; ignored: string[] | null; deps?: Record<string, string[] | null> } {
  const raw = git(repoDir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const ignored = raw === null ? null : raw.split("\0").map((p) => p.replace(/\/$/, "")).filter((p) => p !== "" && p !== ".loki" && !p.startsWith(".loki/"));
  const deps: Record<string, string[] | null> = {};
  for (const rel of ignored ?? []) if (/(?:^|\/)(?:node_modules|\.venv)$/.test(rel)) deps[rel] = depsListing(join(repoDir, rel));
  return { lazy: true, since_ms: Date.now(), ignored: ignored && ignored.length <= IGNORED_CAP ? ignored : null, deps };
}
/** The intake record as verify's candidate filter: an eager `zero` list (runs from before the lazy form) admits only its names; the lazy record
 *  admits every candidate and hands zeroOnBase the guard inputs. A missing or malformed record admits nothing. */
export interface ZeroGate { has: (name: string) => boolean; sinceMs?: number; ignored?: string[] | null; deps?: Record<string, string[] | null> }
export function zeroGate(rec: unknown): ZeroGate {
  const z = (rec && typeof rec === "object" ? rec : {}) as { zero?: unknown; lazy?: unknown; since_ms?: unknown; ignored?: unknown; deps?: unknown };
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  if (z.lazy === true && typeof z.since_ms === "number") return { has: () => true, sinceMs: z.since_ms, ignored: Array.isArray(z.ignored) ? strs(z.ignored) : null, ...(z.deps && typeof z.deps === "object" ? { deps: z.deps as Record<string, string[] | null> } : {}) };
  const names = new Set(strs(z.zero));
  return { has: (n) => names.has(n) };
}
// Test runners write their own caches inside node_modules and .venv on every run (Loki's verify included); they hold no dependency code.
const RUNNER_CACHE_DIRS = [".vite", ".vite-temp", ".vitest", ".vitest-cache", ".cache", "__pycache__", ".pytest_cache"]; // FireLater#21: vitest 5.1 writes node_modules/.vitest-cache on every run
// fl24 (FireLater#24, v11.139.0): an ignored file a typecheck, linter or Finder rewrites as its own output, never something a test imports. The implement
// session's `tsc --noEmit` rewrote frontend/tsconfig.tsbuildinfo, so every base rerun ran without node_modules, parsed no ids, and 22 page tests red on base blocked.
const TOOL_OUTPUT_FILE = /(?:^|\/)(?:[^/]*\.tsbuildinfo|\.eslintcache|\.stylelintcache|\.DS_Store|next-env\.d\.ts)$/; // next-env.d.ts: Next rewrites this ignored file on every dev or build start; a proof script that started `next dev` changed it and the base rerun lost its node_modules (FireLater#24)
/** TOOL-OUTPUT-IN-DEPS (LOKI_E10_TOOL_OUTPUT_IN_DEPS, default on; =0/off/false/no opts out). True for a dot-named directory that holds nothing but tool
 *  output files (TOOL_OUTPUT_FILE), at most 64 entries deep and wide together. A project can point its typecheck's build info inside node_modules
 *  (opencode's packages/core: "tsBuildInfoFile": "node_modules/.ts-dist/source.tsbuildinfo"), so Loki's own `tsc --noEmit` lint creates that directory
 *  after intake. No test imports it and a dot name is never a package name, yet it read as "the environment changed since intake": the base tree got no
 *  dependencies for that package and its suite was "not measured on base" in every closed-set-2 run of oc63960. Anything else in the directory (an emitted
 *  .d.ts, a script) makes it an ordinary entry again. */
export const toolOutputInDepsOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_TOOL_OUTPUT_IN_DEPS"] ?? "").trim());
export function toolOutputDir(dir: string): boolean {
  if (!toolOutputInDepsOn() || !basename(dir).startsWith(".")) return false;
  let n = 0;
  const only = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (++n > 64) return false;
      if (e.isDirectory()) { if (!only(join(d, e.name))) return false; } else if (!e.isFile() || !TOOL_OUTPUT_FILE.test(e.name)) return false;
    }
    return true;
  };
  try { return lstatSync(dir).isDirectory() && only(dir) && n > 0; } catch { return false; }
}
/** The packages a dependency dir holds (names, "@scope/name" for scoped ones; a venv's site-packages entries as "py/<name>"), runner caches left out; null
 *  past the bound. A deleted or renamed package changes this list and nothing a files-only walk can see (the parent directory's ctime also moves when a
 *  runner adds its cache entry, so directories alone cannot tell the two apart). */
export function depsListing(root: string): string[] | null {
  const out: string[] = [], skip = (n: string): boolean => RUNNER_CACHE_DIRS.includes(n) || n === "__pycache__";
  const list = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip(e.name) || (e.isDirectory() && toolOutputDir(join(dir, e.name)))) continue; // TOOL-OUTPUT-IN-DEPS
      if (e.name.startsWith("@") && (e.isDirectory() || e.isSymbolicLink())) { try { list(join(dir, e.name), `${prefix}${e.name}/`); continue; } catch { /* a link to nowhere is listed as itself */ } }
      out.push(prefix + e.name);
      if (out.length > 50000) throw new RangeError("bound");
    }
  };
  try {
    list(root, "");
    for (const lib of ["lib", "lib64", "Lib"]) {
      const l = join(root, lib);
      if (!existsSync(l)) continue;
      if (lib === "Lib") { if (existsSync(join(l, "site-packages"))) list(join(l, "site-packages"), "py/"); continue; } // case-insensitive volumes (macOS) answer existsSync("Lib") for "lib"
      for (const py of readdirSync(l)) if (/^python/.test(py) && existsSync(join(l, py, "site-packages"))) list(join(l, py, "site-packages"), "py/");
    }
  } catch { return null; }
  return out.sort();
}
/** EXOGENOUS-RED: the first installed package intake listed under `pkgDir`'s node_modules or .venv that is gone now ("<dir>: <name>"), or null. A package
 *  that was there at intake and is missing after the run is the run's doing: a test that fails for it is blamed on the change, though no base run can show
 *  it (the base tree gets no dependencies once the environment changed). An added package says nothing here: an install step adds them. */
export function depsGoneSince(repoDir: string, pkgDir: string, deps?: Record<string, string[] | null>): string | null {
  if (!deps) return null;
  for (const d of ["node_modules", ".venv"]) {
    const rel = relative(repoDir, join(pkgDir, d)), was = deps[rel]; if (!was?.length) continue;
    let now: string[] | null = null; try { now = existsSync(join(pkgDir, d)) ? depsListing(join(pkgDir, d)) : []; } catch { now = null; }
    if (!now) continue;
    const have = new Set(now), gone = was.find((n) => !have.has(n));
    if (gone !== undefined) return `${rel}: ${gone}`;
  }
  return null;
}
/** True (withhold) unless the environment is as intake left it at `sinceMs`: every ignored entry intake listed still exists, and no entry under
 *  `pkgDir`'s node_modules or .venv, and no ignored file intake listed, had its status changed since (ctime, which a process cannot set back;
 *  one `find` walk that never follows symlinks; runner cache dirs pruned). Additions count as changes: an added nested package or .pth file can
 *  change what runs. Ignored directories other than dependency dirs are checked for existence only. Any error withholds. */
export function envChangedSince(repoDir: string, pkgDir: string, sinceMs: number, ignored: string[] | null, deps?: Record<string, string[] | null>): boolean {
  if (ignored === null) return true;
  let stampDir = "";
  try {
    const roots: string[] = [];
    for (const rel of ignored) {
      const st = statSync(join(repoDir, rel), { throwIfNoEntry: false }); // a dangling link reads as missing, which withholds
      if (!st) return true;
      if (!st.isDirectory() && !TOOL_OUTPUT_FILE.test(rel)) roots.push(join(repoDir, rel));
    }
    const depRoots: string[] = [];
    for (const d of ["node_modules", ".venv"]) if (existsSync(join(pkgDir, d))) { roots.push(join(pkgDir, d)); depRoots.push(join(pkgDir, d)); }
    if (deps) for (const r of depRoots) { // a package deleted or renamed since intake (a record from before this field skips the check)
      const was = deps[relative(repoDir, r)], now = depsListing(r);
      if (!was || !now || was.length !== now.length || was.some((n, i) => n !== now[i])) return true;
    }
    if (roots.length === 0) return false;
    stampDir = mkdtempSync(join(tmpdir(), "loki-zero-stamp-"));
    const stamp = join(stampDir, "since");
    writeFileSync(stamp, "");
    utimesSync(stamp, sinceMs / 1000, sinceMs / 1000);
    const prune = RUNNER_CACHE_DIRS.flatMap((n, i) => [...(i ? ["-o"] : []), "-name", n]);
    const out = execFileSync("find", ["-P", ...new Set(roots), "(", ...prune, ")", "-prune", "-o", "(", "-type", "f", "-o", "-type", "l", ")", "-cnewer", stamp, "-print"] /* files and links only: a runner adding a cache entry changes its parent directory's ctime, which is not a dependency change */, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000 });
    if (out.split("\n").some((f) => f !== "" && !(TOOL_OUTPUT_FILE.test(f) && toolOutputDir(dirname(f))))) return true; // TOOL-OUTPUT-IN-DEPS: a tool's own output in a directory that holds nothing else
    // directories: a changed directory is a dependency change unless it is a dependency root or site-packages (the listing above covers them) or holds a runner cache
    const dirs = execFileSync("find", ["-P", ...new Set(roots), "(", ...prune, ")", "-prune", "-o", "-type", "d", "-cnewer", stamp, "-print"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000, maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
    return dirs.some((d) => !(roots.includes(d) || /(?:^|\/)site-packages$/.test(d) || RUNNER_CACHE_DIRS.concat("__pycache__").some((c) => existsSync(join(d, c))) || toolOutputDir(d)));
  } catch { return true; } finally { if (stampDir) rmSync(stampDir, { recursive: true, force: true }); }
}

/** FC-ZERO-ON-BASE: for each zero-executed candidate run its command once in the base worktree `baseDir` (deps linked from the head checkout, never
 *  copied) and return the names that also execute zero tests there. A candidate whose deps can see head sources, or whose base run is cut, missing
 *  or not a zero, is left out (stays NOT PROVEN). `note` is called per excused name. With a lazy `gate` (sinceMs set) a candidate is also left
 *  out when envChangedSince finds the environment changed since intake: the base run then no longer stands for the untouched base. */
export async function zeroOnBase(
  cands: { name: string; cmd: string; args: string[]; cwd: string }[], baseDir: string, repoDir: string,
  run: (c: { cmd: string; args: string[]; cwd: string }) => Promise<{ ok: boolean; cut: boolean; missing: boolean; out: string }>, note: (name: string) => void,
  gate: Pick<ZeroGate, "sinceMs" | "ignored" | "deps"> = {},
): Promise<string[]> {
  const zero: string[] = [], link = baseDepsLinker(baseDir, repoDir, gate);
  for (const c of cands) {
    if (!link(c.cwd)) continue;
    if (isZeroRun(c, await run(c))) { zero.push(c.name); note(c.name); }
  }
  return zero;
}

/** Links the head checkout's dependency dirs (node_modules, .venv) into a package dir of the base worktree `baseDir`, never copied, so a base run
 *  of a suite that needs its dependencies can run at all. The returned function answers false (nothing linked, the base run stays without
 *  dependencies: fail closed) when the head's deps can see head sources (depsSeeHead) or, with a lazy `gate`, when envChangedSince finds the
 *  environment changed since intake. One guard walk per package dir. Shared by zeroOnBase and verify's base-red subtraction. */
/** BASE-LINK-SCOPE (LOKI_E10_BASE_LINK_SCOPE, default on, =0 opts out; FireLater#18 on 11.164.0): a changed dependency manifest stops the head's dependency dirs
 *  being linked into the base worktree only for the packages it can affect: the package whose root holds it, every package above it (a root manifest or lockfile
 *  blocks everything) and every package inside its directory (a workspace root). A manifest in a sibling package does not. The failure: backend/package.json
 *  changed, so the frontend's vitest files also ran on a bare base, gave no ids, could not be compared, and 22 page tests red on base were fed to the fix rounds
 *  as the change's own until a fix round called them a spec conflict. `cwdRel` is the check's working directory relative to the repository ("." for the root). */
export const baseLinkScopeOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_LINK_SCOPE"] ?? "").trim());
export function manifestBlocksBaseLink(changed: readonly string[], cwdRel: string, isManifest: (f: string) => boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const ms = changed.filter(isManifest); if (ms.length === 0) return false;
  const cwd = cwdRel.replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (!baseLinkScopeOn(env) || cwd === "" || cwd.startsWith("..")) return true; // off, the root package, or a directory outside the repo: any changed manifest blocks
  return ms.some((m) => { const d = m.includes("/") ? m.slice(0, m.lastIndexOf("/")) : ""; return d === "" || d === cwd || cwd.startsWith(`${d}/`) || d.startsWith(`${cwd}/`); });
}
export function baseDepsLinker(baseDir: string, repoDir: string, gate: Pick<ZeroGate, "sinceMs" | "ignored" | "deps"> = {}): (cwd: string) => boolean {
  const seen = new Map<string, boolean>();
  return (cwd) => {
    const src = join(repoDir, relative(baseDir, cwd));
    if (!seen.has(src)) seen.set(src, !(depsSeeHead(src, repoDir) || (gate.sinceMs !== undefined && envChangedSince(repoDir, src, gate.sinceMs, gate.ignored ?? null, gate.deps))));
    if (!seen.get(src)) return false;
    for (const d of ["node_modules", ".venv"]) { try { if (existsSync(join(src, d)) && !existsSync(join(cwd, d))) symlinkSync(join(src, d), join(cwd, d)); } catch { /* no deps on base: stays fail-closed */ } }
    return true;
  };
}

/** RW-01: a base worktree's node_modules for a workspace whose packages link to each other (npm, yarn, bun and pnpm workspaces put a symlink to each
 *  member in node_modules, so baseDepsLinker refuses the whole directory: a base run through it would import the head's copy of a sibling package).
 *  Instead of linking the head's node_modules as one directory, this builds a node_modules directory in the base package dir whose entries (top level,
 *  one level under an @scope, and .bin) are symlinks: an entry that is a symlink to a workspace member points at that member in the base worktree, every
 *  other entry points at the head's. Nothing is copied. Refused (false, nothing built: fail closed) when the environment changed since intake (the same
 *  gate as baseDepsLinker), the dir has a .venv, a node_modules already exists on base, or any symlink below those levels leaves the node_modules for
 *  the checkout (it cannot be re-pointed), or the walk passes its entry or time bound. A dir with no dependency dir at all answers true. */
const VIEW_WALK_BOUND = 1_500_000, VIEW_WALK_MS = 5000;
export function baseDepsView(baseDir: string, repoDir: string, gate: Pick<ZeroGate, "sinceMs" | "ignored" | "deps"> = {}): (cwd: string) => boolean {
  const seen = new Map<string, boolean>();
  let roots: string[] = []; try { roots = [...new Set([resolve(repoDir), realpathSync(repoDir)])]; } catch { /* no roots: every call refuses */ }
  const member = (rt: string): string | null => { for (const r of roots) if (rt.startsWith(r + sep) && !rt.slice(r.length).split(sep).includes("node_modules")) return relative(r, rt); return null; };
  const levelDir = (name: string): boolean => name.startsWith("@") || name === ".bin";
  const build = (src: string, cwd: string): boolean => {
    const nm = join(src, "node_modules"), out = join(cwd, "node_modules");
    if (existsSync(join(src, ".venv"))) return false;
    if (!existsSync(nm)) return true;
    if (roots.length === 0 || existsSync(out)) return false;
    if (gate.sinceMs !== undefined && envChangedSince(repoDir, src, gate.sinceMs, gate.ignored ?? null, gate.deps)) return false;
    const own = [...new Set([resolve(nm), realpathSync(nm)])], t0 = Date.now(); let n = 0;
    const leaks = (dir: string, level: boolean): boolean => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (++n > VIEW_WALK_BOUND || Date.now() - t0 > VIEW_WALK_MS) return true;
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) { if (level) continue; const t = resolve(dir, readlinkSync(p)); let rt = t; try { rt = realpathSync(t); } catch { /* dangling */ } if (insideAny(t, roots) && !own.some((r) => rt === r || rt.startsWith(r + sep))) return true; }
        else if (e.isDirectory() && leaks(p, dir === nm && levelDir(e.name))) return true;
      }
      return false;
    };
    if (leaks(nm, true)) return false;
    const one = (p: string, q: string): void => { let target = p; try { if (lstatSync(p).isSymbolicLink()) { const rt = realpathSync(p), m = member(rt); target = m !== null ? join(baseDir, m) : rt; } } catch { return; /* dangling: left out */ } symlinkSync(target, q); };
    mkdirSync(out);
    for (const e of readdirSync(nm, { withFileTypes: true })) { const p = join(nm, e.name), q = join(out, e.name); if (e.isDirectory() && levelDir(e.name)) { mkdirSync(q); for (const s of readdirSync(p)) one(join(p, s), join(q, s)); } else one(p, q); }
    return true;
  };
  return (cwd) => { const src = join(repoDir, relative(baseDir, cwd)); if (!seen.has(src)) { let ok = false; try { ok = build(src, cwd); } catch { ok = false; } seen.set(src, ok); } return seen.get(src)!; };
}

/** BASE-TREE-MEMBERS (LOKI_E10_BASE_TREE_MEMBERS, default on; =0/off/false/no opts out). A suite in a workspace imports its sibling packages from source, and
 *  a sibling resolves its own dependencies from its own node_modules. Linking only the suite's package and the root left every sibling in the base worktree
 *  without one: on opencode the cli suite ran 123 tests with 84 failures in the base tree ("Cannot find package 'effect' from packages/util/src/...") against
 *  408 with 8 in the checkout, so 7 of the 8 tests red on base read "not red on base". Every tracked directory with a package.json that has a node_modules in
 *  the checkout gets its dependencies in the base worktree through the same `link` (baseDepsLinker, else baseDepsView): the base tree then resolves what the
 *  checkout resolves. `manifests` are the tracked package.json paths (repo-relative). Returns how many member directories there were and the ones `link`
 *  refused (fail closed: nothing is linked for those, and the caller discloses them). */
export const baseTreeMembersOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_BASE_TREE_MEMBERS"] ?? "").trim());
export const BASE_TREE_MEMBER_MAX = 400;
export function linkWorkspaceMembers(baseDir: string, repoDir: string, link: (cwd: string) => boolean, manifests: readonly string[]): { members: number; refused: string[] } {
  if (!baseTreeMembersOn()) return { members: 0, refused: [] };
  const dirs = [...new Set(manifests.filter((f) => f === "package.json" || f.endsWith("/package.json")).map((f) => dirname(f)))]
    .filter((d) => d !== "." && !d.split("/").includes("node_modules") && existsSync(join(repoDir, d, "node_modules")) && existsSync(join(baseDir, d)))
    .sort().slice(0, BASE_TREE_MEMBER_MAX);
  const refused = dirs.filter((d) => { try { return !link(join(baseDir, d)); } catch { return true; } });
  return { members: dirs.length, refused };
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
  const named = (f: string): boolean => new RegExp(`${f.includes("/") ? `(?<![\\w./-])${escapeRegex(f)}(?![\\w-])|` : ""}[/"'\`]${escapeRegex(basename(f))}(?=["'\`\\s);]|$)`).test(wall());
  const linkOk = (f: string): boolean => {
    try {
      const root = realpathSync(c.repoDir), t = realpathSync(join(c.repoDir, f)), rel = relative(root, t);
      return !rel.startsWith("..") && !rel.split(sep).includes(".git") && statSync(t).isFile() && changed.has(rel.split(sep).join("/")) && !isTestFile(rel) && !c.wallPaths.includes(rel);
    } catch { return false; }
  };
  const capping: string[] = [], disclosed: string[] = [], extra: string[] = [];
  for (const n of notes) {
    const m = ADVISORY_PATH.exec(n), f = m?.[1] ?? m?.[2];
    const ok = !!m && !!f && added.has(f) && c.wallPassedN && ((m[2] !== undefined && linkOk(f) && (c.planFiles.includes(f) || named(f))) || (m[1] !== undefined && addedManifestOk(f, c, wall(), escapeRegex, extra)));
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
export interface BranchRecord { branch: string; head_sha: string; pushed: boolean; bundle: string | null; orig_branch?: string | null; deferred?: boolean; start_sha?: string } // start_sha: a deferred run that started on a detached HEAD returns to that commit (PR-BASE)

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

/** The pid of this run's detached post-PR deep verify (its deep.started event) while it is alive, else null; it posts the loki/deep-verify status when it ends. */
export const deepPid = (runDir: string): number | null => {
  let pid: number | undefined;
  try {
    pid = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"deep.started"')).map((l) => Number((JSON.parse(l) as { data?: { pid?: unknown } }).data?.pid)).pop();
    if (!pid || !Number.isInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0); return pid;
  } catch (e) { return pid && (e as NodeJS.ErrnoException).code === "EPERM" ? pid : null; }
};
export const deepAlive = (runDir: string): boolean => deepPid(runDir) !== null;
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

/** Puts the checkout back on `orig` when it sits on the run branch and the tracked tree is clean apart from `.loki/` (Loki's own state dir, never
 *  committed by a run: FireLater tracks four legacy .loki files deleted from its tree long before any current run). Never discards an edit: a plain
 *  `git checkout` carries such changes along and refuses when one would be overwritten. */
function returnCheckout(repoDir: string, branch: string, orig: string | null, startSha: string | null = null): string | null {
  const cur = currentBranch(repoDir);
  if (cur !== branch) return null; // already back (a stop restores it) or the user moved on: left where it is
  const detached = !orig && !!startSha && /^[0-9a-f]{40}$/.test(startSha); // RW-01: the run started on a detached HEAD checkout (no branch to record): it returns to that commit, detached
  if (!detached && (!orig || orig === branch)) return `engine10: the checkout stays on ${branch}: the run did not record the branch it started from\n`;
  let dirty: string | null; // raw, never trimmed: a porcelain entry starts with a status column that may be a space
  try { dirty = safeGit(repoDir, ["status", "--porcelain", "-z", "--untracked-files=no", "--no-renames"], { timeout: 20000 }); } catch { dirty = null; }
  if (dirty === null || dirty.split("\0").filter(Boolean).some((l) => !l.slice(3).startsWith(".loki/"))) return `engine10: the checkout stays on ${branch}: it has uncommitted changes; return with: git checkout ${detached ? `--detach ${startSha}` : orig}\n`;
  if (detached) return git(repoDir, ["checkout", "-q", "--detach", startSha!]) === null ? `engine10: the checkout stays on ${branch}: git checkout --detach ${startSha} failed; return with: git checkout --detach ${startSha}\n` : null;
  return git(repoDir, ["checkout", "-q", orig!]) === null ? `engine10: the checkout stays on ${branch}: git checkout ${orig} failed; return with: git checkout ${orig}\n` : null;
}

/** Removes this run's Wall test files that are still untracked in the user's tree at run end (a run that published no Wall commit leaves them
 *  there, and the next run inherits them as untracked files). Only a file whose bytes hash to the sealed sha256 in this run's receipt is removed,
 *  so an edit the user made is never lost; the sealed copy stays under .loki/runs/<id>/wall/. Returns the repo-relative paths removed. */
export function removeOwnWallFiles(repoDir: string, runId: string): string[] {
  let files: { path?: unknown; sha256?: unknown }[] = [];
  try { files = (JSON.parse(readFileSync(join(repoDir, ".loki", "runs", runId, "receipt.json"), "utf8")) as { wall?: { files?: typeof files } }).wall?.files ?? []; } catch { return []; }
  const gone: string[] = [];
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.sha256 !== "string") continue;
    const abs = resolve(repoDir, f.path), rel = relative(repoDir, abs);
    if (rel.startsWith("..") || rel.startsWith(".loki/") || !basename(rel).startsWith("loki_wall_")) continue;
    if (git(repoDir, ["ls-files", "--error-unmatch", "--", rel]) !== null) continue; // tracked: committed on purpose (a published Wall), never removed
    try { if (createHash("sha256").update(readFileSync(abs)).digest("hex") !== f.sha256) continue; rmSync(abs); gone.push(rel); } catch { /* missing or unreadable: nothing to remove */ }
  }
  return gone;
}

/** The one line naming where a kept run branch's work is and how to look at it; "" when the branch is gone (settleBranch named the bundle) or still checked out. */
function workLine(repoDir: string, branch: string, orig: string | null): string {
  if (!tipOf(repoDir, `refs/heads/${branch}`) || currentBranch(repoDir) === branch) return "";
  return `engine10: the run's work is on branch ${branch}; your checkout is back on ${orig ?? "the starting branch"}; see it with: git diff ${orig ?? "HEAD"}...${branch}\n`;
}

/** True when the run's last run.completed is SPEC_CONFLICT (outcome BLOCKED): `loki answer <run>` resumes it on its local run branch. */
function answerable(runDir: string): boolean {
  try {
    const last = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.completed"')).pop();
    return !!last && (JSON.parse(last) as { data?: { verdict?: unknown } }).data?.verdict === "SPEC_CONFLICT";
  } catch { return false; }
}

/**
 * The end of one run: return the checkout, remove leftover base worktrees, delete the run branch once its history is safe, migrate loose
 * session files and sweep earlier runs' branches. Returns the lines to print. `deferred`: a detached deep verify still runs on the branch,
 * so only a record is written and finishDeferredRun does the rest when it ends. `keepWork`: a run that published nothing (whatever its verdict) keeps
 * its branch, since that branch is the result (a later run's sweep saves and removes it). Every outcome puts the checkout back on the
 * start branch and prints one line naming where the run's work is.
 */
export function finishRunBranch(repoDir: string, runId: string, end: RunEnd, env: NodeJS.ProcessEnv = process.env): string {
  if (keepRunBranch(env) || !/^e10-[A-Za-z0-9-]+$/.test(runId)) return "";
  const branch = `loki/${runId}`, runDir = join(repoDir, ".loki", "runs", runId), tip = tipOf(repoDir, `refs/heads/${branch}`);
  try {
    if (end.deferred && tip) {
      mkdirSync(runDir, { recursive: true });
      const detachedAt = !end.orig && end.baseSha && /^[0-9a-f]{40}$/.test(end.baseSha) ? end.baseSha : null; // a detached start has no branch to record: keep its commit so the deferred end can return to it
      writeFileSync(join(runDir, "branch.json"), JSON.stringify({ branch, head_sha: tip, pushed: end.pushed, bundle: null, orig_branch: end.orig, deferred: true, ...(detachedAt ? { start_sha: detachedAt } : {}) } satisfies BranchRecord, null, 2) + "\n");
      return `engine10: the checkout stays on ${branch} while the background deep verify runs, then returns to ${end.orig ?? (detachedAt ? `commit ${detachedAt.slice(0, 7)}, detached` : "the starting branch")}\n`;
    }
    removeRunWorktrees(repoDir, end.baseSha);
    migrateSessionFiles(repoDir, runLive);
    let notes = "";
    const wallGone = removeOwnWallFiles(repoDir, runId); // the run's own untracked Wall files never stay behind in the user's tree
    if (wallGone.length) notes += `engine10: removed Loki's own acceptance test ${wallGone.join(", ")} from your tree; its sealed copy is under .loki/runs/${runId}/wall/\n`;
    const keepHere = (end.keepWork === true || answerable(runDir)) && tip !== null && tipOf(repoDir, end.baseSha ?? "") !== tip; // DELIVER-WHAT-EXISTS: a BLOCKED run with a draft pull request keeps its local branch, `loki answer` resumes on it
    const stay = tip ? returnCheckout(repoDir, branch, end.orig, end.baseSha ?? null) : null; // run safety: every outcome returns the checkout to the start branch, a kept branch included
    if (stay) notes += stay;
    if (tip && !keepHere) {
      if (!stay && findInterrupted(repoDir, runId, true) === null) notes += settleBranch(repoDir, branch, runDir, "branch", end.pushed && tip !== null, { orig_branch: end.orig }).note; // a resumable run keeps its branch for `loki start`
    }
    if (!stay) notes += workLine(repoDir, branch, end.orig);
    return notes + sweepRunBranches(repoDir, env, runId);
  } catch (e) { return `engine10: run-end cleanup skipped: ${(e as Error).message}\n`; }
}

/** Called by the deep worker when it ends: finishes the cleanup finishRunBranch deferred for this run. */
export function finishDeferredRun(repoDir: string, runId: string, env: NodeJS.ProcessEnv = process.env): string {
  const rec = readRecord(join(repoDir, ".loki", "runs", runId, "branch.json"));
  if (!rec?.deferred || rec.branch !== `loki/${runId}`) return "";
  const tip = tipOf(repoDir, `refs/heads/${rec.branch}`);
  return finishRunBranch(repoDir, runId, { orig: rec.orig_branch ?? null, pushed: rec.pushed === true && tip === rec.head_sha, ...(!rec.orig_branch && typeof rec.start_sha === "string" && /^[0-9a-f]{40}$/.test(rec.start_sha) ? { baseSha: rec.start_sha } : {}) }, env);
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

// ---- WORK-RECOVERY: finished work is never lost -----------------------------------------------------------------------------------
// opencode 63310 (Loki 11.152.0): a fix session ran `git stash -q; <look at the base>; git stash pop -q` and was stopped between the two.
// The whole correct change sat in stash@{0}; the commit stage saw a clean tree ("committed false") and the run delivered nothing.
// The record is one file in the run directory (work-ledger.jsonl; its name matches config_fence.ts RUN_RECORD, so Edit and Write never
// reach it). Line 1 is the stash list at run start. A stash entry is the run's own only when it is absent from that list AND was made
// on the run branch (the stash stack is shared by every worktree of the repository, so "new" alone could be the user's own entry made
// elsewhere during the run). No record, an unreadable record, or an entry that fails either test: nothing is applied and nothing is
// dropped. Nothing here ever discards work: a restore that cannot be clean keeps the entry and names it.
const WORK_LEDGER = "work-ledger.jsonl";
export const workLedgerPath = (runDir: string): string => join(runDir, WORK_LEDGER);
type LedgerLine = { k: string; sha?: string; stashes?: string[]; at?: number; files?: number; paths?: string[]; reason?: string; stage?: string; where?: string; subject?: string; note?: string };
function readLedger(runDir: string): LedgerLine[] | null {
  let text: string;
  try { text = readFileSync(workLedgerPath(runDir), "utf8"); } catch { return null; }
  const out: LedgerLine[] = [];
  for (const l of text.split("\n")) { if (!l.trim()) continue; try { const o = JSON.parse(l) as LedgerLine; if (o && typeof o === "object" && typeof o.k === "string") out.push(o); else return null; } catch { return null; } }
  return out;
}
const appendLedger = (runDir: string, line: LedgerLine): void => { try { mkdirSync(runDir, { recursive: true }); writeFileSync(workLedgerPath(runDir), `${JSON.stringify(line)}\n`, { flag: "a" }); } catch { /* the restore already happened or was skipped; a lost line only loses the note */ } };
/** The record's first line when it is a well-formed baseline, else null (then nothing is ever touched). */
function baselineOf(lines: LedgerLine[] | null): { stashes: Set<string>; at: number } | null {
  const b = lines?.[0];
  if (!b || b.k !== "baseline" || !Array.isArray(b.stashes) || !b.stashes.every((s) => typeof s === "string" && /^[0-9a-f]{40,64}$/.test(s)) || typeof b.at !== "number") return null;
  return { stashes: new Set(b.stashes), at: b.at };
}
const stashList = (repoDir: string): { sha: string; subject: string }[] | null => {
  const out = git(repoDir, ["stash", "list", "--format=%H %gs"]);
  if (out === null) return null;
  return out.split("\n").filter(Boolean).map((l) => ({ sha: l.slice(0, l.indexOf(" ")), subject: l.slice(l.indexOf(" ") + 1) })).filter((e) => /^[0-9a-f]{40,64}$/.test(e.sha));
};
/** Writes the stash list at run start, once per run directory. Called at the first session start of a run; a repository git cannot read writes nothing. */
export function recordStashBaseline(repoDir: string, runDir: string): void {
  if (existsSync(workLedgerPath(runDir))) return;
  const list = stashList(repoDir);
  if (list === null) return;
  appendLedger(runDir, { k: "baseline", stashes: list.map((e) => e.sha), at: Date.now() });
}
export interface WorkRecovery { recovered: { sha: string; files: number; paths: string[] }[]; kept: { sha: string; reason: string }[]; foreign: { sha: string; subject: string }[]; moved: string | null }
const NO_RECOVERY = (): WorkRecovery => ({ recovered: [], kept: [], foreign: [], moved: null });
/** True when `subject` is the reflog line `git stash` writes on `branch` ("WIP on <branch>: ..." or, with -m, "On <branch>: ..."). */
export const stashMadeOn = (subject: string, branch: string): boolean => subject.startsWith(`WIP on ${branch}: `) || subject.startsWith(`On ${branch}: `);
const chunks = <T>(xs: T[], n = 200): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
/** One stash entry back onto the work tree. Returns the file count, or the reason it was kept. Applies only when the apply cannot conflict:
 *  HEAD is the commit the stash was made on and none of its files has another change in the tree. Verified against the stash commit before the entry is dropped. */
function restoreStash(repoDir: string, sha: string): { files: number; paths: string[] } | { reason: string } {
  const head = git(repoDir, ["rev-parse", "HEAD"]), base = git(repoDir, ["rev-parse", "--verify", "-q", `${sha}^1`]);
  if (!head || !base) return { reason: "its base commit could not be read" };
  if (head !== base) return { reason: `the checkout moved to ${head.slice(0, 12)} after the stash was made on ${base.slice(0, 12)}` };
  const z = (args: string[]): string[] | null => { try { return safeGit(repoDir, args, { timeout: 20000 }).split("\0").filter(Boolean); } catch { return null; } };
  const tracked = z(["diff", "--name-only", "--no-renames", "-z", base, sha]);
  const hasUntracked = git(repoDir, ["rev-parse", "--verify", "-q", `${sha}^3`]) !== null, untracked = hasUntracked ? z(["ls-tree", "-r", "--name-only", "-z", `${sha}^3`]) : [];
  if (tracked === null || untracked === null) return { reason: "its file list could not be read" };
  if (tracked.length + untracked.length === 0) return { reason: "it holds no file change" };
  for (const part of chunks(tracked)) { // a file of the stash with another change in the tree or the index: git would refuse or merge, so nothing is tried
    const dirty = z(["--literal-pathspecs", "status", "--porcelain", "-z", "--untracked-files=no", "--no-renames", "--", ...part]);
    if (dirty === null) return { reason: "the work tree state could not be read" };
    if (dirty.length > 0) return { reason: `the work tree has other changes to the same file(s): ${dirty.map((l) => l.slice(3)).slice(0, 5).join(", ")}` };
  }
  const there = untracked.filter((f) => { try { lstatSync(join(repoDir, f)); return true; } catch { return false; } });
  if (there.length > 0) return { reason: `the work tree already has the untracked file(s) it would restore: ${there.slice(0, 5).join(", ")}` };
  try { safeGit(repoDir, ["stash", "apply", "-q", sha], { timeout: 120000, repoDrivers: true, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) {
    return { reason: `git stash apply failed (${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "no error output"})` };
  }
  // applied: the tree must now hold exactly the stash's content for every file it names, with no unmerged entry, before the entry may go
  if ((git(repoDir, ["ls-files", "-u"]) ?? "x") !== "") return { reason: "the apply left unmerged files" };
  for (const part of chunks(tracked)) { try { safeGit(repoDir, ["--literal-pathspecs", "diff", "--quiet", sha, "--", ...part], { timeout: 60000, repoDrivers: true, stdio: "ignore" }); } catch { return { reason: "the restored files do not match the stash" }; } }
  if (untracked.some((f) => { try { lstatSync(join(repoDir, f)); return false; } catch { return true; } })) return { reason: "an untracked file of the stash was not restored" };
  // drop by SHA: the stack can shift under another worktree, so stash@{n} is resolved again right before the drop and the list is compared after it
  const before = stashList(repoDir), idx = before?.findIndex((e) => e.sha === sha) ?? -1;
  const done = { files: tracked.length + untracked.length, paths: [...tracked, ...untracked] };
  if (before === null || idx < 0) return done; // already gone: the work is in the tree either way
  if (git(repoDir, ["rev-parse", "--verify", "-q", `stash@{${idx}}`]) !== sha) return { reason: "the stash list changed while restoring; the entry is applied to the work tree and kept on the stack" };
  if (git(repoDir, ["stash", "drop", "-q", `stash@{${idx}}`]) === null) return { reason: "the entry is applied to the work tree but could not be dropped" };
  const after = new Set((stashList(repoDir) ?? []).map((e) => e.sha));
  for (const e of [...before].reverse()) if (e.sha !== sha && !after.has(e.sha)) git(repoDir, ["stash", "store", "-q", "-m", e.subject, e.sha]); // another entry vanished in the same instant: put it back (its commit still exists)
  return done;
}
/** Puts the checkout back on the run branch when a session left it elsewhere, without touching a file and without moving any other branch.
 *  Same commit: HEAD is re-pointed. Commits made during the run on top of the run branch: the run branch is fast-forwarded to them. A plain
 *  `git checkout` otherwise (it carries edits and refuses to overwrite one). Returns the line to disclose, or null when nothing was off. */
export function returnToRunBranch(repoDir: string, branch: string, sinceMs: number): { moved: boolean; note: string } | null {
  const tip = tipOf(repoDir, `refs/heads/${branch}`);
  if (!tip) return null; // no run branch (a unit fixture, or intake never ran): today's behaviour
  const cur = currentBranch(repoDir);
  if (cur === branch) return null;
  const head = git(repoDir, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const where = cur ? `branch ${cur}` : `a detached HEAD at ${head.slice(0, 12)}`, repoint = (): boolean => git(repoDir, ["symbolic-ref", "-m", `loki: return to ${branch}`, "HEAD", `refs/heads/${branch}`]) !== null;
  if (head === tip) return repoint() ? { moved: true, note: `a session left the checkout on ${where}; Loki put it back on ${branch} (same commit, every edit kept)` } : { moved: false, note: `a session left the checkout on ${where} and Loki could not return it to ${branch}; the run's work may be there` };
  const isAncestor = (a: string, b: string): boolean => { try { safeGit(repoDir, ["merge-base", "--is-ancestor", a, b], { stdio: "ignore" }); return true; } catch { return false; } };
  if (isAncestor(tip, head)) {
    const times = (git(repoDir, ["log", "--format=%ct", `${tip}..${head}`]) ?? "").split("\n").filter(Boolean).map(Number);
    const own = times.length > 0 && times.length <= 200 && times.every((t) => Number.isFinite(t) && t * 1000 >= sinceMs - 2000); // every stray commit was made during this run: the run's own, never the user's earlier work
    if (own && git(repoDir, ["update-ref", "-m", `loki: commits a session made on ${where}`, `refs/heads/${branch}`, head, tip]) !== null && repoint()) return { moved: true, note: `a session made ${times.length} commit(s) on ${where}; Loki fast-forwarded ${branch} to ${head.slice(0, 12)} so they are part of this run (${cur ? `${cur} is unchanged` : "no other branch moved"})` };
    return { moved: false, note: `a session left the checkout on ${where}, ${times.length} commit(s) ahead of ${branch}${own ? "" : " and not all made during this run"}: left untouched; see them with: git log ${branch}..${head.slice(0, 12)}` };
  }
  const ahead = Number(git(repoDir, ["rev-list", "--count", `${tip}..${head}`]) ?? NaN);
  if (ahead === 0) { // HEAD is behind the run branch: a plain checkout carries the edits forward or refuses
    try { safeGit(repoDir, ["checkout", "-q", branch], { repoDrivers: true, stdio: "ignore", timeout: 120000 }); return { moved: true, note: `a session left the checkout on ${where}; Loki put it back on ${branch} (edits carried over)` }; } catch { /* disclosed below */ }
  }
  return { moved: false, note: `a session left the checkout on ${where}${ahead > 0 ? `, with ${ahead} commit(s) that are not on ${branch}` : ""}: left untouched; the run's work may be there (git log ${branch}..${head.slice(0, 12)}; git diff ${branch} ${head.slice(0, 12)})` };
}
/**
 * Restores the run's own set-aside work onto the work tree of `repoDir`: called at every session end (engine10/session.ts), at the top of the commit
 * stage (stages/seal.ts) and before the run-end WIP and backstop commits (e10ext/commit_filter.ts). `branch` is the run branch; `moveBranch`
 * also returns the checkout to it (never while a session may still be running). Never throws; returns what it did for the event and the receipt.
 */
export function recoverRunWork(o: { repoDir: string; runDir: string; branch: string; stage?: string; where: "session" | "commit" | "run-end"; moveBranch?: boolean }): WorkRecovery {
  const res = NO_RECOVERY();
  try {
    const lines = readLedger(o.runDir), base = baselineOf(lines);
    if (!base) return res; // no record of the start state: nothing is the run's for sure, so nothing is touched
    if (o.moveBranch) { const m = returnToRunBranch(o.repoDir, o.branch, base.at); if (m) { res.moved = m.note; if (!lines!.some((l) => l.k === "branch" && l.note === m.note)) appendLedger(o.runDir, { k: "branch", note: m.note, where: o.where }); } }
    const list = stashList(o.repoDir);
    if (list === null) return res;
    const said = (k: string, sha: string, reason?: string): boolean => lines!.some((l) => l.k === k && l.sha === sha && (reason === undefined || l.reason === reason));
    for (const e of list) { // newest first, the order a repeated `git stash pop` would take
      if (base.stashes.has(e.sha)) continue; // existed before the run: the user's, never read further
      if (!stashMadeOn(e.subject, o.branch)) { res.foreign.push(e); if (!said("foreign", e.sha)) appendLedger(o.runDir, { k: "foreign", sha: e.sha, subject: e.subject.slice(0, 200), where: o.where }); continue; }
      const r = restoreStash(o.repoDir, e.sha);
      if ("files" in r) { res.recovered.push({ sha: e.sha, files: r.files, paths: r.paths }); appendLedger(o.runDir, { k: "recovered", sha: e.sha, files: r.files, paths: r.paths.length > RECOVERED_PATHS_MAX ? [...r.paths.slice(0, RECOVERED_PATHS_MAX), MORE_PATHS] : r.paths, where: o.where, ...(o.stage ? { stage: o.stage } : {}) }); }
      else { res.kept.push({ sha: e.sha, reason: r.reason }); if (!said("kept", e.sha, r.reason)) appendLedger(o.runDir, { k: "kept", sha: e.sha, reason: r.reason, where: o.where }); }
    }
  } catch { /* a recovery bug never fails a session or a commit */ }
  return res;
}
export const WORK_RECOVERED_NOTE = "work recovered";
const RECOVERED_PATHS_MAX = 2000, MORE_PATHS = "(more files than the record lists)"; // a path that is no file: it never has a verify hash, so an over-long list always reads as not checked
/** LATE-RECOVERY: the restored files no check saw. A file counts as checked only when the last verify recorded a hash for it (file_hashes, taken when verify starts)
 *  and the file still has those bytes; no verify output, or one without hashes (a stopped verify), means none was. Empty when nothing was restored. */
export function unverifiedRecovered(runDir: string, repoDir: string, verify: Record<string, unknown> | undefined): string[] {
  const lines = readLedger(runDir);
  if (!baselineOf(lines)) return [];
  const paths = [...new Set(lines!.filter((l) => l.k === "recovered").flatMap((l) => (Array.isArray(l.paths) ? l.paths.filter((p): p is string => typeof p === "string") : [MORE_PATHS])))];
  if (paths.length === 0) return [];
  const seen = verify && verify["file_hashes"] !== null && typeof verify["file_hashes"] === "object" ? (verify["file_hashes"] as Record<string, unknown>) : null;
  if (!seen) return paths;
  const now = fileHashes(repoDir, paths);
  return paths.filter((p) => typeof seen[p] !== "string" || seen[p] !== now[p]);
}
/** LATE-RECOVERY: a run whose restored work no check saw is never VERIFIED (or ALREADY_SATISFIED): the label is held at PARTIAL, and workRecoveryNotes names the files. */
export const capLateRecovery = <V extends string>(verdict: V, unverified: readonly string[]): V | "PARTIAL" => (unverified.length > 0 && (verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED") ? "PARTIAL" : verdict);
/** The receipt lines of this run's record: what was restored, what was kept and where it is, and a branch a session left the checkout on. `repoDir` drops a
 *  kept or foreign line whose entry is no longer on the stash stack (restored by a later pass, or taken back by its owner). */
export function workRecoveryNotes(runDir: string, repoDir: string, unverified: readonly string[] = []): string[] {
  const lines = readLedger(runDir);
  if (!baselineOf(lines)) return [];
  const live = new Set((stashList(repoDir) ?? []).map((e) => e.sha)), recovered = new Set(lines!.filter((l) => l.k === "recovered").map((l) => l.sha)), out: string[] = [];
  const lastKept = new Map<string, LedgerLine>(); for (const l of lines!) if (l.k === "kept" && l.sha) lastKept.set(l.sha, l); // one line per entry: the latest reason
  for (const l of lines!) {
    const id = String(l.sha ?? "").slice(0, 12);
    if (l.k === "recovered") {
      const unseen = (Array.isArray(l.paths) ? l.paths : [MORE_PATHS]).filter((p) => unverified.includes(p)), what = `${WORK_RECOVERED_NOTE}: ${l.files} file(s) ${l.where === "session" ? `a ${l.stage ?? "stage"} session had set aside with git stash` : "set aside with git stash during the run"} were put back on the work tree (stash ${id})`;
      out.push(unseen.length > 0 ? `${what} after the last check ran: no check saw ${unseen.slice(0, 5).join(", ")}${unseen.length > 5 ? ` (+${unseen.length - 5} more)` : ""}; the label is held at PARTIAL` : `${what}; the checks ran on the restored files (disclosed, does not cap)`);
    }
    else if (l.k === "kept" && l.sha && lastKept.get(l.sha) === l && live.has(l.sha) && !recovered.has(l.sha)) out.push(`work NOT restored: stash ${id} was made during this run on its branch and is kept, not dropped: ${l.reason}; it is not in the delivered change; restore it with: git stash apply ${l.sha}`);
    else if (l.k === "foreign" && l.sha && live.has(l.sha)) out.push(`a stash entry made during the run was left untouched because it was not made on this run's branch: ${id} (${l.subject}); if it holds this run's work, restore it with: git stash apply ${l.sha}`);
    else if (l.k === "branch" && l.note) out.push(l.note);
  }
  return [...new Set(out)];
}
