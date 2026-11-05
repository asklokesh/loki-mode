// EXP-0010 parallel attempts after a red first attempt, in features/ because e10ext is at its cap. When the first implement attempt (the incumbent, in the primary tree) ends with the repo's own checks red,
// k more independent attempts run IN PARALLEL on the same model, each in a detached worktree in its own temp directory (never inside the repo: a test runner run in the primary would discover the attempts' copies) with a different instruction. Every finished attempt is scored by running the shared set S
// in the PRIMARY tree through treeswap; the first one that passes all of S and the Wall stops the others; otherwise select.ts ranks (checks green, fail-then-pass proof, fewest files outside the task, smallest
// diff, incumbent last). Core then re-verifies and Seals the one tree left in the primary: this module writes no verdicts and no Wall files. Opt-in: LOKI_E10_ATTEMPTS=on is k=2, a number sets k, unset or 0 is off.
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
import { isEarlyAccept, selectAttempt, type AttemptCandidate, type AttemptCheck } from "../e10ext/select.ts";
import { outsideScope } from "../e10ext/scope.ts";
import { parseStaged, type Staged } from "../e10ext/commit_filter.ts";
import { DEFAULT_EXCLUDES, applyDiff, resetToBase, snapshotDiff, swapAttemptIntoWorkingTree } from "../e10ext/treeswap.ts";

export const DEFAULT_ATTEMPTS = 2, MAX_ATTEMPTS = 5, MIN_ATTEMPT_WINDOW_S = 90;
/** The extra attempts' tree excludes: the linked dependency dir is the primary's own and never part of an attempt's diff. */
export const ATTEMPT_EXCLUDES = [...DEFAULT_EXCLUDES, "node_modules"];

/** LOKI_E10_ATTEMPTS_EARLY=1 (off by default): on Haiku, run the extra attempts right after the first red verify, before any fix round, and skip the fix rounds when one goes green. */
export const attemptsEarly = (env: NodeJS.ProcessEnv = process.env): boolean => (env.LOKI_E10_ATTEMPTS_EARLY ?? "").trim() === "1";
/** k extra attempts, opt-in: unset is off (even on Haiku), `0` off, a whole number 1..5 sets k, `on`/`true`/`yes` is k=2 (the default k). Anything else is off (fail safe: never more spend than asked). The model matters only for the early switch, which implies k=2 on Haiku. */
export function attemptsK(model: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.LOKI_E10_ATTEMPTS ?? "").trim().toLowerCase() || (attemptsEarly(env) && /haiku/i.test(model ?? "") ? "on" : ""); // the early switch implies k=2 on Haiku unless LOKI_E10_ATTEMPTS says otherwise
  if (["on", "true", "yes"].includes(raw)) return DEFAULT_ATTEMPTS;
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? Math.min(n, MAX_ATTEMPTS) : 0;
}

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
export interface AttemptInspect { diff: string; weakensTest: boolean; outsideFiles: number }
export interface AttemptOps {
  /** Run extra attempt i (1..k) in its own tree. */
  run(i: number, signal: AbortSignal): Promise<SessionResult>;
  /** Make attempt i's tree the primary's content; 0 restores the incumbent. */
  enter(i: number): void;
  /** Diff against base, the weakened-test verdict and the outside-scope count for attempt i; the incumbent (0) is valid only before any enter(). */
  inspect(i: number): AttemptInspect;
  /** Run S in the primary; the caller has entered the attempt's tree (0 needs no enter before the first one). */
  score(i: number): Promise<AttemptCheck[]>;
  /** FC-LINT-PRE-RED: names in attempt i's verify pre_red_checks (checks that also fail on base); absent means none. Valid right after score(i). */
  preRed?(i: number): string[];
}
export interface AttemptsResult {
  winner: number; reason: string; early: boolean; launched: number; sessions: SessionResult[];
  scored: { index: number; failed: string[]; passes: number; diff_lines: number; outside_files: number; disqualified: boolean }[];
}
const ERRORED: SessionResult = { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
const INCUMBENT: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };

/** Scores the incumbent first (if it already passes S there is nothing to select, and no extra session starts), then runs k extras in parallel, scoring each as it finishes
 *  and stopping the rest at the first early accept. Leaves the winner's tree in the primary. A treeswap or scoring error restores the incumbent and returns it. */
export async function runAttempts(ops: AttemptOps, k: number, S: TestRef[], wall: TestRef[], signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<AttemptsResult> {
  assertScrubbedEnv(env);
  const candidate = (i: number, s: SessionResult): AttemptCandidate => ({ index: i, killedOrErrored: s.killed || s.exit !== 0, alreadyDoneEvidence: s.markers.alreadyDone !== null, checks: [], ...ops.inspect(i) });
  const scorable = (c: AttemptCandidate): boolean => !c.killedOrErrored && !c.weakensTest && (c.diff.trim() !== "" || c.alreadyDoneEvidence);
  const sessions: SessionResult[] = [INCUMBENT];
  const cands: AttemptCandidate[] = [];
  const inc = candidate(0, INCUMBENT);
  cands.push(inc);
  const summary = (winner: number, reason: string, early: boolean, launched: number): AttemptsResult => ({
    winner, reason, early, launched, sessions,
    scored: cands.map((c) => ({ index: c.index, failed: c.checks.filter((x) => x.result === "fail").map((x) => x.name), passes: c.checks.filter((x) => x.result === "pass").length, diff_lines: c.diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length, outside_files: c.outsideFiles ?? 0, disqualified: !scorable(c) })),
  });
  let held = 0;
  const ctl = Array.from({ length: k }, () => new AbortController());
  const killAll = (): void => ctl.forEach((c) => c.abort());
  const pend = new Map<number, Promise<{ i: number; s: SessionResult }>>();
  const all: Promise<unknown>[] = [];
  try {
    if (scorable(inc)) { inc.checks = await ops.score(0); inc.preRedChecks = ops.preRed?.(0) ?? []; }
    if (scorable(inc) && isEarlyAccept(inc, S, wall)) return summary(0, "incumbent already passes the shared set; no extra attempt started", true, 0);
    if (signal.aborted) return summary(0, "stopped before the extra attempts started", false, 0);
    signal.addEventListener("abort", killAll, { once: true });
    for (let i = 1; i <= k; i++) { const p = ops.run(i, ctl[i - 1]!.signal).catch(() => ERRORED).then((s) => ({ i, s })); pend.set(i, p); all.push(p); }
    let early: number | null = null;
    while (pend.size > 0 && early === null) {
      const { i, s } = await Promise.race(pend.values());
      pend.delete(i); sessions[i] = s;
      const c = candidate(i, s);
      if (scorable(c)) { ops.enter(i); held = i; c.checks = await ops.score(i); c.preRedChecks = ops.preRed?.(i) ?? []; }
      cands.push(c);
      if (scorable(c) && isEarlyAccept(c, S, wall)) { early = i; killAll(); }
    }
    for (const r of await Promise.all(all) as { i: number; s: SessionResult }[]) sessions[r.i] ??= r.s; // a stopped attempt is awaited so its partial usage is priced before we return
    const pick = early !== null ? { index: early, reason: "early accept" } : selectAttempt(cands, S, wall);
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
  runOne: (t: TestRef, out: AttemptCheck[]) => Promise<unknown>; S: TestRef[];
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
      const out = outsideScope(a.outputs(), staged, readPlanScope(a.runDir));
      return { diff: tracked + added, weakensTest: editedTests.length > 0 || [...a.wallPaths].some((p) => wallWeakened(root, i === 0, p, touched)), outsideFiles: out?.length ?? 0 };
    },
    async score() { const out: AttemptCheck[] = []; for (const t of a.S) await a.runOne(t, out); return out; },
  };
}

/** `check` is verify.ts's runCheck, bound by the caller (this module may not import stages/ at runtime). */
export interface ExtraAttemptsDeps {
  k: number; brief: string; model?: string; limitS: number; impacted: string[];
  check: (ctx: RunContext, t: TestRef, signal: AbortSignal, out: AttemptCheck[]) => Promise<unknown>;
  wallPaths: string[]; wallContent?: Record<string, string>;
}
export interface ExtraAttemptsOutcome { winner: number; launched: number; summary: Record<string, unknown>; ids: string[]; tookExtra: boolean }
/** Runs the extra attempts for a red incumbent. Null when there is nothing to score against (no impacted test exists at the base), so no session starts. */
export async function runExtraAttempts(ctx: RunContext, signal: AbortSignal, deps: ExtraAttemptsDeps): Promise<ExtraAttemptsOutcome | null> {
  assertScrubbedEnv(process.env); // before any worktree exists
  const map = await ctx.tests.detect(ctx.repoDir);
  const S = map.tests.filter((t) => deps.impacted.includes(t.path)), wall = S.filter((t) => deps.wallPaths.includes(t.path));
  if (S.length === 0) return null;
  const intake = ctx.outputs().intake ?? {}, owned = installOwned(ctx.repoDir, intake.install_created);
  const userUntracked = new Set([...(Array.isArray(intake.preexisting_untracked) ? intake.preexisting_untracked as string[] : []), ...Object.keys((intake.preexisting_untracked_blobs ?? {}) as object)]); // the same record commit and discard trust for "the user's own untracked files"
  const ids = Array.from({ length: deps.k }, (_, n) => `${ctx.runId}-impl-x${n + 1}`);
  const ops = treeswapOps({
    primary: ctx.repoDir, runDir: ctx.runDir, base: ctx.baseSha, k: deps.k, wallPaths: new Set(deps.wallPaths), ...(deps.wallContent ? { wallContent: new Map(Object.entries(deps.wallContent)) } : {}), S, outputs: () => ctx.outputs(),
    keep: (p) => userUntracked.has(p) || deps.wallPaths.includes(p) || owned(p),
    runSession: (i, cwd, sig): Promise<SessionResult> => { const o: SessionRunOptions = { stage: "implement", brief: variantBrief(deps.brief, i), tier: "development", iterationId: ids[i - 1]!, limitS: deps.limitS, signal: sig, cwd, ...(deps.model ? { model: deps.model } : {}) }; return ctx.sessions.run(o); },
    runOne: (t, out) => deps.check(ctx, t, signal, out),
  });
  try {
    const r = await runAttempts(ops, deps.k, S, wall, signal);
    return { winner: r.winner, launched: r.launched, ids: ids.slice(0, r.launched), tookExtra: r.winner > 0, summary: { k: deps.k, launched: r.launched, winner: r.winner === 0 ? "incumbent" : `x${r.winner}`, reason: r.reason, early_accept: r.early, shared_set: S.length, scored: r.scored } };
  } finally { ops.dispose(); }
}
