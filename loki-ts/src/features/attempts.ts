// EXP-0010 best-of-N implement attempts, in features/ because e10ext is at its cap. LOKI_E10_ATTEMPTS=N is N TOTAL attempts (unset, 0 and 1 are off; `on` is 2; before 11.140 it meant N EXTRA
// attempts after a red verify). When the first attempt (the incumbent, in the primary tree, fix rounds included) is not clean (verify red, a spec conflict, or a NOT PROVEN line from verify or a fix
// round), N-1 more independent attempts run IN PARALLEL on the same model (LOKI_E10_ATTEMPT_MODELS sets one per attempt), each in a detached worktree in its own temp directory (never inside the repo: a test runner run in the primary would
// discover the attempts' copies) with a different instruction. Each finished attempt is swapped into the primary and gets Loki's normal verify (the caller's score); the first clean one stops the
// others. Otherwise select.ts rankAttempts ranks on what a real user can see (verify green, no spec conflict, fewer NOT PROVEN lines) and a tie at the top goes to one order-swapped review of the
// tied diffs against the issue, the repo's CONTRIBUTING, PR template and style configs and the pre-fix text of the touched files (reviewTie). No hidden test or benchmark file is ever read.
// Core Seals only the one tree left in the primary: this module writes no verdict and no Wall file; the receipt's `attempts` lines name every attempt and the selection reason.
// E-141: treeswap's git children inherit process.env, so attempts refuse to start unless that env is already token-scrubbed (the worker's is).
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GITHUB_TOKEN_VARS, SENTINEL_PREFIX } from "../util/credential_env.ts";
import { safeGit } from "../util/safe_git.ts";
import { testFileWeakened } from "../util/test_guard.ts";
import { readPlanScope } from "../util/run_cap.ts";
import { installOwned } from "../project_model/install.ts";
import { isTestFile } from "../engine10/testmap.ts";
import { FINISH_LINE, type Obj, type RunContext, type SessionResult, type SessionRunOptions, type TestRef } from "../engine10/types.ts";
import { rankAttempts, type AttemptCandidate, type AttemptCheck, type AttemptSignal } from "../e10ext/select.ts";
import { consultCallFor } from "./opus_consult.ts";
import { resolveClaudeModel } from "../util/claude_model.ts";
import { anchoredPlanScope, outsideScope } from "../e10ext/scope.ts";
import { parseStaged, type Staged } from "../e10ext/commit_filter.ts";
import { DEFAULT_EXCLUDES, applyDiff, resetToBase, snapshotDiff, swapAttemptIntoWorkingTree } from "../e10ext/treeswap.ts";

export const DEFAULT_ATTEMPTS = 2, MAX_ATTEMPTS = 6, MIN_ATTEMPT_WINDOW_S = 90; // totals: `on` is 2, the cap is 6 (five extra sessions)
/** The extra attempts' tree excludes: the linked dependency dir is the primary's own and never part of an attempt's diff. */
export const ATTEMPT_EXCLUDES = [...DEFAULT_EXCLUDES, "node_modules"];

/** LOKI_E10_ATTEMPTS_EARLY=1 (off by default): on Haiku, run the extra attempts right after the first red verify, before any fix round, and skip the fix rounds when one goes green. */
export const attemptsEarly = (env: NodeJS.ProcessEnv = process.env): boolean => (env.LOKI_E10_ATTEMPTS_EARLY ?? "").trim() === "1";
/** Total attempts N, opt-in: unset, `0` and `1` are 1 (the single attempt), a whole number 2..6 sets N, `on`/`true`/`yes` is 2. Anything else is 1 (fail safe: never more spend than asked).
 *  The model matters only for the early switch, which implies N=2 on Haiku unless LOKI_E10_ATTEMPTS says otherwise. */
export function attemptsTotal(model: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.LOKI_E10_ATTEMPTS ?? "").trim().toLowerCase() || (attemptsEarly(env) && /haiku/i.test(model ?? "") ? "on" : "");
  if (["on", "true", "yes"].includes(raw)) return DEFAULT_ATTEMPTS;
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? Math.min(n, MAX_ATTEMPTS) : 1;
}
/** The extra sessions, N - 1 (0 is off). */
export const attemptsK = (model: string | undefined, env: NodeJS.ProcessEnv = process.env): number => attemptsTotal(model, env) - 1;
/** LOKI_E10_ATTEMPT_MODELS (unset by default: every attempt runs on the session model): a comma list naming one model per attempt in order, so `haiku,sonnet` runs
 *  attempt 1 (the first, in the primary tree) on Haiku and the extra attempt on Sonnet. An attempt past the end of the list reuses its last entry. Family aliases go
 *  through the model catalog (a bare alias is rejected on the API route). */
export const attemptModels = (env: NodeJS.ProcessEnv = process.env): string[] => (env.LOKI_E10_ATTEMPT_MODELS ?? "").split(",").map((m) => m.trim()).filter((m) => m !== "").map(resolveClaudeModel);
/** The model attempt `i` (0 is the first attempt) runs on: its LOKI_E10_ATTEMPT_MODELS entry, else `fallback` (the session model). */
export const attemptModel = (i: number, fallback: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined => { const l = attemptModels(env); return l.length ? l[Math.min(i, l.length - 1)] : fallback; };

/** An attempt's NOT PROVEN lines for ranking. `pre red:` lines name checks that also fail on base; they are the same for every attempt, so they never rank one over another. */
export const signalNotProven = (lines: unknown[]): string[] => [...new Set(lines.map(String).filter((l) => l !== "" && !l.startsWith("pre red:")))];
/** Clean: verify green, no conflict, nothing NOT PROVEN. A clean first attempt starts no extra session; a clean extra one stops the rest. */
export const isClean = (s: AttemptSignal | undefined): boolean => !!s && !s.red && !s.conflict && s.notProven.length === 0;

/** One distinct instruction per extra attempt (cycled past three), added before the brief's closing line so the cache-stable prefix is untouched. */
export const VARIANTS = [
  "Attempt style: make the smallest change that fixes the task. Touch as few files as you can and do not refactor.",
  "Attempt style: write the failing test first. Add a test that reproduces the task, run it and see it fail, then change the code until it passes.",
  "Attempt style: read the tests that cover this code first. Work out what they expect before you edit, then make the code meet them.",
] as const;
export const variantBrief = (brief: string, i: number): string => {
  const v = VARIANTS[(i - 1) % VARIANTS.length]!;
  return brief.endsWith(FINISH_LINE) ? `${brief.slice(0, -FINISH_LINE.length)}${v}\n\n${FINISH_LINE}` : `${brief}\n\n${v}`;
};

/** Fail closed, same rule as the worker: a real GitHub token in this env would reach treeswap's git children. */
export function assertScrubbedEnv(env: NodeJS.ProcessEnv): void {
  for (const v of GITHUB_TOKEN_VARS) {
    const val = env[v] ?? "";
    if (val !== "" && !val.startsWith(SENTINEL_PREFIX)) throw new Error(`attempts: ${v} holds a real token; parallel attempts need the token-withheld worker env`);
  }
}

/** The incumbent's tree could not be put back: the primary holds an unknown mix, so the caller must not let this run seal as delivered work. */
export class AttemptsRestoreError extends Error { constructor(msg: string) { super(msg); this.name = "AttemptsRestoreError"; } }
export interface AttemptInspect { diff: string; weakensTest: boolean; outsideFiles: number; /** The diff with new files' text, for the tie review; absent: `diff`. */ reviewDiff?: string }
export interface AttemptOps {
  /** Run extra attempt i (1..k) in its own tree. */
  run(i: number, signal: AbortSignal): Promise<SessionResult>;
  /** Make attempt i's tree the primary's content; 0 restores the incumbent. */
  enter(i: number): void;
  /** Diff against base, the weakened-test verdict and the outside-scope count for attempt i; the incumbent (0) is valid only before any enter(). */
  inspect(i: number): AttemptInspect;
  /** Loki's normal verify on attempt i's tree in the primary (the caller has entered it; 0 needs no enter before the first one, it reads the first attempt's own verify). */
  score(i: number): Promise<AttemptSignal>;
  /** Breaks a tie at the top of the rank between these attempts (lowest index first); index null keeps the lowest. Absent: the lowest index wins the tie. */
  review?(tied: { index: number; diff: string }[]): Promise<{ index: number | null; reason: string }>;
}
export type { AttemptSignal };
export interface AttemptScore { index: number; red: boolean | null; conflict: boolean | null; not_proven: number | null; diff_lines: number; outside_files: number; disqualified: boolean }
export interface AttemptsResult { winner: number; reason: string; early: boolean; launched: number; sessions: SessionResult[]; scored: AttemptScore[] }
const diffLines = (d: string): number => d.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length;
const ERRORED: SessionResult = { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
const INCUMBENT: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };

/** Scores the incumbent first (a clean one leaves nothing to select, and no extra session starts), then runs k extras in parallel, verifying each as it finishes and stopping the rest
 *  at the first clean one. Otherwise rankAttempts picks, and a tie at the top goes to ops.review. Leaves the winner's tree in the primary. A treeswap or scoring error restores the incumbent. */
export async function runAttempts(ops: AttemptOps, k: number, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<AttemptsResult> {
  assertScrubbedEnv(env);
  const candidate = (i: number, s: SessionResult): AttemptCandidate => ({ index: i, killedOrErrored: s.killed || s.exit !== 0, alreadyDoneEvidence: s.markers.alreadyDone !== null, ...ops.inspect(i) });
  const scorable = (c: AttemptCandidate): boolean => !c.killedOrErrored && !c.weakensTest && (c.diff.trim() !== "" || c.alreadyDoneEvidence);
  const scoreOf = async (c: AttemptCandidate, s: SessionResult): Promise<void> => { const g = await ops.score(c.index); c.signal = { ...g, conflict: g.conflict || s.markers.specConflict !== null }; };
  const sessions: SessionResult[] = [INCUMBENT];
  const cands: AttemptCandidate[] = [];
  const inc = candidate(0, INCUMBENT);
  cands.push(inc);
  const summary = (winner: number, reason: string, early: boolean, launched: number): AttemptsResult => ({
    winner, reason, early, launched, sessions,
    scored: cands.map((c) => ({ index: c.index, red: c.signal?.red ?? null, conflict: c.signal?.conflict ?? null, not_proven: c.signal?.notProven.length ?? null, diff_lines: diffLines(c.diff), outside_files: c.outsideFiles ?? 0, disqualified: !scorable(c) })),
  });
  let held = 0;
  const ctl = Array.from({ length: k }, () => new AbortController());
  const killAll = (): void => ctl.forEach((c) => c.abort());
  const pend = new Map<number, Promise<{ i: number; s: SessionResult }>>();
  const all: Promise<unknown>[] = [];
  try {
    if (scorable(inc)) await scoreOf(inc, INCUMBENT);
    if (scorable(inc) && isClean(inc.signal)) return summary(0, "the first attempt is clean (verify green, nothing NOT PROVEN); no extra attempt started", true, 0);
    if (signal.aborted) return summary(0, "stopped before the extra attempts started", false, 0);
    signal.addEventListener("abort", killAll, { once: true });
    for (let i = 1; i <= k; i++) { const p = ops.run(i, ctl[i - 1]!.signal).catch(() => ERRORED).then((s) => ({ i, s })); pend.set(i, p); all.push(p); }
    let early: number | null = null;
    while (pend.size > 0 && early === null) {
      const { i, s } = await Promise.race(pend.values());
      pend.delete(i); sessions[i] = s;
      const c = candidate(i, s);
      if (scorable(c)) { ops.enter(i); held = i; await scoreOf(c, s); }
      cands.push(c);
      if (scorable(c) && isClean(c.signal)) { early = i; killAll(); }
    }
    for (const r of await Promise.all(all) as { i: number; s: SessionResult }[]) sessions[r.i] ??= r.s; // a stopped attempt is awaited so its partial usage is priced before we return
    let pick: { index: number; reason: string } = { index: early ?? 0, reason: "early accept: verify green, nothing NOT PROVEN" };
    if (early === null) {
      const r = rankAttempts(cands);
      pick = r;
      if (r.tied.length > 1 && ops.review && !signal.aborted) {
        const rv = await ops.review(r.tied.map((i) => { const c = cands.find((x) => x.index === i)!; return { index: i, diff: c.reviewDiff ?? c.diff }; }));
        pick = { index: rv.index !== null && r.tied.includes(rv.index) ? rv.index : r.tied[0]!, reason: `${r.reason}; review: ${rv.reason}` };
      }
    }
    if (held !== pick.index) { ops.enter(pick.index); held = pick.index; }
    return summary(pick.index, pick.reason, early !== null, k);
  } catch (e) {
    killAll();
    await Promise.allSettled(all);
    try { ops.enter(0); } catch (e2) { throw new AttemptsRestoreError(`the first attempt's tree could not be restored (${(e2 as Error).message.split("\n")[0]}) after: ${(e as Error).message.split("\n")[0]}`); }
    return summary(0, `attempts error, incumbent kept: ${(e as Error).message.split("\n")[0]}`, false, k);
  } finally {
    killAll();
    signal.removeEventListener("abort", killAll);
  }
}

// ---- real wiring ---------------------------------------------------------
const untracked = (root: string): string[] => (safeGit(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...ATTEMPT_EXCLUDES.map((e) => `:(exclude)${e}`)]).split("\0").filter((p) => p.length > 0));
const ATTEMPTS_TMP_PREFIX = "loki-attempts-";
/** Removes the worktrees and the temp dir this run created, by exact path: only a direct child of the temp root that carries our prefix is ever deleted. */
function removeAttemptTrees(primary: string, root: string, dirs: string[]): void {
  for (const d of dirs) { try { safeGit(primary, ["worktree", "remove", "--force", "--", d]); } catch { /* already gone or never added */ } }
  try { safeGit(primary, ["worktree", "prune"]); } catch { /* best effort */ }
  try { if (basename(root).startsWith(ATTEMPTS_TMP_PREFIX) && dirname(realpathSync(root)) === realpathSync(tmpdir()) && !lstatSync(root).isSymbolicLink()) rmSync(root, { recursive: true, force: true }); } catch { /* a leaked temp dir is removed with the temp root */ }
}
/** Builds the real ops over treeswap. `wallPaths` are repo-relative sealed Wall files. Attempt i runs in <temp>/loki-attempts-<random>/B<i>, a detached worktree of `base` with the primary's node_modules linked in. */
export function treeswapOps(a: {
  primary: string; runDir: string; base: string; k: number; wallPaths: Set<string>; wallContent?: Map<string, string>; // wallContent: sealed bytes per Wall path; a Wall file is weakened only if it differs from these or is deleted
  outputs: () => Partial<Record<string, Obj>>; // outsideScope reads the plan, task and contract
  keep: (path: string) => boolean; // untracked files that are not the first attempt's work: the user's own (recorded at intake), the installed Wall, install-owned dependency files
  runSession: (i: number, cwd: string, signal: AbortSignal) => Promise<SessionResult>;
  score?: (i: number) => Promise<AttemptSignal>; // Loki's verify on the entered tree (machine.ts); the tournament scores its own way and never calls it
}): AttemptOps & { dispose(): void; dirs: string[] } {
  const EX = ATTEMPT_EXCLUDES, attemptsDir = mkdtempSync(join(tmpdir(), ATTEMPTS_TMP_PREFIX));
  const dirs = [a.primary];
  const dispose = (): void => removeAttemptTrees(a.primary, attemptsDir, dirs.slice(1));
  try {
    for (let i = 1; i <= a.k; i++) {
      const dir = join(attemptsDir, `B${i}`);
      safeGit(a.primary, ["worktree", "add", "--detach", dir, a.base]); dirs.push(dir);
      const nm = join(a.primary, "node_modules");
      if (existsSync(nm) && !lstatSync(nm).isSymbolicLink() && !existsSync(join(dir, "node_modules"))) { try { symlinkSync(nm, join(dir, "node_modules")); } catch { /* an attempt without deps still edits; scoring runs in the primary */ } }
    }
  } catch (e) { dispose(); throw e; }
  const pre = new Set(untracked(a.primary).filter(a.keep)); // never dropped between attempts; every other untracked file now in the primary is the first attempt's own work (this runs after it finished), dropped when another attempt's tree is entered and counted in its diff
  let snapInc: ReturnType<typeof snapshotDiff> | null = null;
  // installWall leaves the sealed Wall files untracked in the primary, so presence in a diff proves nothing: judge by bytes.
  const wallWeakened = (root: string, isPrimary: boolean, p: string, touched: Set<string>): boolean => {
    const sealed = a.wallContent?.get(p), f = join(root, p);
    if (!existsSync(f)) return isPrimary ? sealed !== undefined || touched.has(p) : false; // an attempt worktree never held the untracked sealed file
    if (sealed === undefined) return touched.has(p);
    try { return readFileSync(f, "utf8") !== sealed; } catch { return true; }
  };
  const dropOwnUntracked = (): void => applyDiff(a.primary, untracked(a.primary).filter((p) => !pre.has(p)).map((path) => ({ path, kind: "delete" as const })), EX);
  return {
    dirs, dispose,
    run: (i, signal) => a.runSession(i, dirs[i]!, signal),
    enter(i) {
      if (i === 0 && !snapInc) return; // no swap yet: the primary still holds the incumbent
      if (i > 0) snapInc ??= snapshotDiff(a.primary, a.base, EX); // the incumbent's tree is held in memory before the first swap
      dropOwnUntracked();
      resetToBase(a.primary, a.base, EX, { keepUntracked: true }); // swap refuses a primary with tracked edits
      if (i > 0) swapAttemptIntoWorkingTree({ primaryRoot: a.primary, attemptRoot: dirs[i]!, base: a.base, runDir: a.runDir, excludes: EX });
      else if (snapInc) applyDiff(a.primary, snapInc, EX);
    },
    inspect(i) {
      const root = dirs[i]!, ex = EX.map((e) => `:(exclude)${e}`);
      const tracked = safeGit(root, ["diff", "--no-ext-diff", a.base, "--", ".", ...ex]);
      const fresh = untracked(root).filter((p) => !pre.has(p));
      const added = fresh.map((p) => `diff --git a/${p} b/${p}\n@@ -0,0 +1 @@\n+${p}\n`).join(""); // new files count as changed lines; content size is irrelevant to the empty-diff test
      const touched = new Set(snapshotDiff(root, a.base, EX).map((e) => e.path).filter((p) => !pre.has(p)));
      const staged: Staged[] = parseStaged(safeGit(root, ["diff", "--name-status", "--no-renames", "-z", a.base, "--", ".", ...ex]));
      const editedTests = staged.filter(({ st, f }) => st !== "A" && isTestFile(f) && testFileWeakened(root, a.base, null, f, st)); // seal's weakened-test rule: an attempt that loosens an existing test never wins by passing it
      const out = outsideScope(a.outputs(), staged, anchoredPlanScope(readPlanScope(a.runDir), String(a.outputs().intake?.task ?? ""), root)); // R3: the same plan-scope anchor seal applies
      return { diff: tracked + added, reviewDiff: tracked + fresh.map((p) => newFileDiff(root, p)).join(""), weakensTest: editedTests.length > 0 || [...a.wallPaths].some((p) => wallWeakened(root, i === 0, p, touched)), outsideFiles: out?.length ?? 0 };
    },
    score: (i) => a.score ? a.score(i) : Promise.reject(new Error("attempts: no verify bound to score an attempt")),
  };
}

/** `check` is verify.ts's runCheck, bound by the caller (this module may not import stages/ at runtime). */
export interface ExtraAttemptsDeps {
  k: number; brief: string; model?: string; limitS: number; impacted: string[];
  check: (ctx: RunContext, t: TestRef, signal: AbortSignal, out: AttemptCheck[]) => Promise<unknown>;
  wallPaths: string[]; wallContent?: Record<string, string>;
}
export interface ExtraAttemptsOutcome { winner: number; launched: number; summary: Record<string, unknown>; ids: string[]; tookExtra: boolean }

// ---- the tie review --------------------------------------------------------
/** Sonnet by default (cost is secondary to picking the mergeable attempt); LOKI_E10_SELECT_REVIEW_MODEL overrides (`opus` gives a reviewer independent of a Sonnet
 *  judge), LOKI_E10_ATTEMPTS_REVIEW_MODEL is its older name, LOKI_E10_ATTEMPTS_REVIEW=0 turns the review off (lowest index wins a tie). Aliases go through the model catalog. */
export const attemptsReviewModel = (env: NodeJS.ProcessEnv = process.env): string => { const m = (env.LOKI_E10_SELECT_REVIEW_MODEL || env.LOKI_E10_ATTEMPTS_REVIEW_MODEL || "").trim(); return m ? resolveClaudeModel(m) : "claude-sonnet-5-5"; };
export const attemptsReviewOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_ATTEMPTS_REVIEW !== "0";
/** The repo's own statements of how a change should look: contribution guide and PR template first, then style configs. Read at the base commit, so no attempt can write them. */
export const CONVENTION_FILES = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md", "CONTRIBUTING.rst", "CONTRIBUTING", ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md"];
export const STYLE_FILES = [".editorconfig", ".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.yml", "biome.json", "biome.jsonc", ".eslintrc.json", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs", "ruff.toml", ".ruff.toml", ".golangci.yml", ".golangci.yaml", "rustfmt.toml", ".rubocop.yml", ".clang-format"];
const CAP = { issue: 12_000, convention: 8_000, style: 5_000, prefixFile: 12_000, prefixTotal: 60_000, diff: 40_000, tree: 4_000 } as const;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[... truncated at ${n} characters]` : s);
const NEW_FILE_MAX = 64_000;
/** A new file as an added-lines diff, so the review reads its text (inspect's `diff` keeps only its path). Binary or oversized files are named only. */
function newFileDiff(root: string, p: string): string {
  let text = "";
  try { const b = readFileSync(join(root, p)); text = b.length > NEW_FILE_MAX || b.includes(0) ? "" : b.toString("utf8"); } catch { /* unreadable: named only */ }
  const body = text === "" ? "+[binary, empty or oversized file]\n" : text.replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n") + "\n";
  return `diff --git a/${p} b/${p}\nnew file\n--- /dev/null\n+++ b/${p}\n${body}`;
}
export const touchedPaths = (diff: string): string[] => [...new Set([...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!))];
export interface ReviewContext { issue: string; conventions: { path: string; text: string }[]; tree: string[]; prefix: { path: string; text: string }[] }
/** Everything the review reads besides the diffs, all from the base commit: the issue, the convention and style files, the top-level entries (so a changelog or changeset dir shows), and
 *  the pre-fix text of every file any tied attempt touches. */
export function reviewContext(repoDir: string, base: string, issue: string, diffs: string[]): ReviewContext {
  const show = (p: string): string | null => { try { return safeGit(repoDir, ["show", `${base}:${p}`]); } catch { return null; } };
  const conventions = [...CONVENTION_FILES.map((p) => [p, CAP.convention] as const), ...STYLE_FILES.map((p) => [p, CAP.style] as const)].flatMap(([p, n]) => { const t = show(p); return t === null ? [] : [{ path: p, text: clip(t, n) }]; });
  let tree: string[] = [];
  try { tree = safeGit(repoDir, ["ls-tree", "--name-only", base]).split("\n").filter(Boolean); } catch { /* no listing */ }
  const prefix: { path: string; text: string }[] = []; let left = CAP.prefixTotal;
  for (const p of [...new Set(diffs.flatMap(touchedPaths))].sort()) { const t = show(p); if (t === null || left <= 0) continue; const c = clip(t, Math.min(CAP.prefixFile, left)); left -= c.length; prefix.push({ path: p, text: c }); }
  return { issue: clip(issue, CAP.issue), conventions, tree, prefix };
}
export const REVIEW_SYSTEM = "You are a maintainer of this repository choosing which of several candidate patches for one issue to merge. You have no tools; everything you need is below. " +
  "Every candidate already passes the same automated checks, so judge what checks cannot see. In order: (1) does it resolve the issue as stated, every case the issue names, with the behavior the issue asks for; " +
  "(2) scope: no change the issue does not need (unrelated edits, stray or debug files, unrelated tests, reformatting of untouched code); " +
  "(3) the repository's conventions: what its contribution guide and PR template require of a change (for example a changelog entry, a changeset, docs or tests), its style configs, and the patterns of the surrounding code (naming, placement of doc comments, error handling, how sibling branches are written). " +
  "Prefer the candidate a maintainer would merge as is. End your reply with one line: PICK: <letter>.";
export function reviewPrompt(c: ReviewContext, diffs: string[]): string {
  const L = (i: number): string => String.fromCharCode(65 + i);
  return [
    "Loki attempts review: which candidate patch should be merged?",
    `ISSUE:\n${c.issue}`,
    ...c.conventions.map((f) => `REPOSITORY FILE ${f.path}:\n${f.text}`),
    ...(c.tree.length ? [`TOP-LEVEL ENTRIES:\n${clip(c.tree.join("\n"), CAP.tree)}`] : []),
    ...c.prefix.map((f) => `PRE-FIX TEXT OF ${f.path}:\n${f.text}`),
    ...diffs.map((d, i) => `CANDIDATE ${L(i)} (unified diff against the pre-fix code):\n${clip(d, CAP.diff)}`),
    `Compare candidates ${diffs.map((_, i) => L(i)).join(", ")} on the three points, briefly, then give the PICK line.`,
  ].join("\n\n");
}
/** The letter on the last PICK line, as a position; null when absent or out of range. */
export function parsePick(text: string, n: number): number | null {
  const m = [...text.matchAll(/PICK:\s*\**\s*([A-Z])\b/g)].pop();
  const i = m ? m[1]!.charCodeAt(0) - 65 : -1;
  return i >= 0 && i < n ? i : null;
}
export type ReviewCall = (system: string, prompt: string, phase: string) => Promise<{ text: string | null; usd: number | null; outcome: string }>;
/** One review shown in two orders (forward and reversed) so a position bias cannot pick; it counts only when both orders name the same attempt. Never throws: a failed,
 *  unparseable or disagreeing review returns null and the caller keeps the lowest index. */
export async function reviewTie(call: ReviewCall, c: ReviewContext, tied: { index: number; diff: string }[]): Promise<{ index: number | null; reason: string }> {
  try {
    const fwd = tied, rev = [...tied].reverse();
    const [a, b] = await Promise.all([fwd, rev].map((o, j) => call(REVIEW_SYSTEM, reviewPrompt(c, o.map((t) => t.diff)), `attempts-review-${j === 0 ? "fwd" : "rev"}`)));
    const pa = a!.text ? parsePick(a!.text, tied.length) : null, pb = b!.text ? parsePick(b!.text, tied.length) : null;
    const ia = pa === null ? null : fwd[pa]!.index, ib = pb === null ? null : rev[pb]!.index;
    const name = (i: number): string => (i === 0 ? "the first attempt" : `attempt x${i}`);
    if (ia === null || ib === null) return { index: null, reason: `no usable pick (${a!.outcome}/${b!.outcome}); the lowest index wins the tie` };
    if (ia !== ib) return { index: null, reason: `the two orders disagreed (${name(ia)} vs ${name(ib)}); the lowest index wins the tie` };
    return { index: ia, reason: `${name(ia)} picked in both orders` };
  } catch (e) { return { index: null, reason: `review failed (${(e as Error).message.split("\n")[0]}); the lowest index wins the tie` }; }
}

/** The receipt's `attempts` lines (seal.ts): one per attempt and the selection. Omitted (hash unchanged) when no extra attempt ran. */
export function attemptsReceiptLines(r: AttemptsResult, total: number, models: (string | undefined)[] = []): string[] {
  if (r.launched === 0) return [];
  const name = (i: number): string => `${i === 0 ? "attempt 1 (first)" : `attempt ${i + 1} (x${i})`}${models[i] ? ` on ${models[i]}` : ""}`; // models: only with LOKI_E10_ATTEMPT_MODELS set, so the default receipt is unchanged
  return [
    ...r.scored.map((s) => `${name(s.index)}: ${s.disqualified ? "disqualified (killed, errored, empty diff or a weakened test)" : s.red === null ? "not verified" : `verify ${s.red ? "red" : "green"}${s.conflict ? ", spec conflict" : ""}, ${s.not_proven} NOT PROVEN`}, ${s.diff_lines} changed lines`),
    `selected ${name(r.winner)} of ${r.scored.length} scored (${total} requested): ${r.reason}`,
  ];
}
export function attemptsReceiptBlock(implement: Record<string, unknown> | undefined): { attempts?: string[] } {
  const a = implement?.attempts as { receipt?: unknown } | undefined;
  return Array.isArray(a?.receipt) && a.receipt.length > 0 ? { attempts: a.receipt.map(String) } : {};
}

/** Runs the extra attempts after a first attempt that is not clean. `score` is Loki's verify on the entered tree (machine.ts binds it; this module may not import stages/ at runtime). */
export async function runExtraAttempts(ctx: RunContext, signal: AbortSignal, deps: ExtraAttemptsDeps, score: (i: number) => Promise<AttemptSignal>, call?: ReviewCall): Promise<ExtraAttemptsOutcome> {
  assertScrubbedEnv(process.env); // before any worktree exists
  const intake = ctx.outputs().intake ?? {}, owned = installOwned(ctx.repoDir, intake.install_created);
  const userUntracked = new Set([...(Array.isArray(intake.preexisting_untracked) ? intake.preexisting_untracked as string[] : []), ...Object.keys((intake.preexisting_untracked_blobs ?? {}) as object)]); // the same record commit and discard trust for "the user's own untracked files"
  const ids = Array.from({ length: deps.k }, (_, n) => `${ctx.runId}-impl-x${n + 1}`);
  const ops = treeswapOps({
    primary: ctx.repoDir, runDir: ctx.runDir, base: ctx.baseSha, k: deps.k, wallPaths: new Set(deps.wallPaths), ...(deps.wallContent ? { wallContent: new Map(Object.entries(deps.wallContent)) } : {}), outputs: () => ctx.outputs(),
    keep: (p) => userUntracked.has(p) || deps.wallPaths.includes(p) || owned(p),
    runSession: (i, cwd, sig): Promise<SessionResult> => { const o: SessionRunOptions = { stage: "implement", brief: variantBrief(deps.brief, i), tier: "development", iterationId: ids[i - 1]!, limitS: deps.limitS, signal: sig, cwd, ...(attemptModel(i, deps.model) ? { model: attemptModel(i, deps.model) } : {}) }; return ctx.sessions.run(o); }, // LOKI_E10_ATTEMPT_MODELS: entry i+1, else the session model
    score,
  });
  const reviewCall = call ?? (attemptsReviewOn() ? consultCallFor(attemptsReviewModel(), process.env.LOKI_DIR ?? join(ctx.repoDir, ".loki"), process.env, 180_000, { maxTokens: 1500, thinking: "off" }) : undefined);
  const review = reviewCall ? (tied: { index: number; diff: string }[]) => reviewTie(reviewCall, reviewContext(ctx.repoDir, ctx.baseSha, String(ctx.outputs().intake?.task ?? ""), tied.map((t) => t.diff)), tied) : undefined;
  try {
    const r = await runAttempts({ ...ops, ...(review ? { review } : {}) }, deps.k, signal);
    const total = deps.k + 1, models = attemptModels().length ? Array.from({ length: total }, (_, i) => attemptModel(i, deps.model) ?? "session model") : [];
    return { winner: r.winner, launched: r.launched, ids: ids.slice(0, r.launched), tookExtra: r.winner > 0, summary: { total, launched: r.launched, winner: r.winner === 0 ? "incumbent" : `x${r.winner}`, reason: r.reason, early_accept: r.early, scored: r.scored, receipt: attemptsReceiptLines(r, total, models), ...(models.length ? { models, winner_model: models[r.winner] } : {}), ...(r.winner > 0 ? { winner_site_lines: (r.sessions[r.winner]?.summary ?? "").match(/^\W*SITE\s.*$/gim) ?? [] } : {}) } }; // R2: seal reads the winner's own SITE lines (util/conflict_resume.ts namedUnchangedOf; not imported here, it would close an import cycle)
  } finally { ops.dispose(); }
}
