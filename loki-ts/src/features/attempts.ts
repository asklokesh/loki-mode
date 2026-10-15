// S41-13 two parallel attempts (SCORECARD-PLAN.md S41-13), in features/ because e10ext is at its cap. Behind LOKI_E10_ATTEMPTS=2, default off. A runs in the primary, B in a detached worktree under
// <runDir>/attempts; each is scored by running the shared set S in the PRIMARY tree through treeswap, select.ts picks the winner, core then re-runs verify and Seal on the one tree left in the primary.
// No verdicts, no Wall writes. E-141: treeswap's git children inherit process.env, so runTwoAttempts refuses to start unless that env is already token-scrubbed (the worker's is).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_TOKEN_VARS, SENTINEL_PREFIX } from "../util/credential_env.ts";
import { safeGit } from "../util/safe_git.ts";
import type { RunContext, SessionResult, SessionRunOptions, TestRef } from "../engine10/types.ts";
import { isEarlyAccept, selectAttempt, type AttemptCandidate, type AttemptCheck } from "../e10ext/select.ts";
import { DEFAULT_EXCLUDES, applyDiff, cleanupAttempt, resetToBase, snapshotDiff, swapAttemptIntoWorkingTree } from "../e10ext/treeswap.ts";
type Idx = 0 | 1;
/** LOKI_E10_ATTEMPTS=2, size normal, and a non-empty predicted S (section 4 Gate). With no selector there is no second attempt. */
export const attemptsGate = (a: { size: "small" | "normal"; predictedS: number; env?: NodeJS.ProcessEnv }): boolean =>
  (a.env ?? process.env).LOKI_E10_ATTEMPTS === "2" && a.size === "normal" && a.predictedS > 0;
/** Fail closed, same rule as the worker: a real GitHub token in this env would reach treeswap's git children. */
export function assertScrubbedEnv(env: NodeJS.ProcessEnv): void {
  for (const v of GITHUB_TOKEN_VARS) {
    const val = env[v] ?? "";
    if (val !== "" && !val.startsWith(SENTINEL_PREFIX)) throw new Error(`attempts: ${v} holds a real token; two-attempt mode needs the token-withheld worker env`);
  }
}
export interface AttemptOps {
  run(i: Idx, signal: AbortSignal): Promise<SessionResult>;
  /** Make attempt i's tree the primary's content (it holds A until the first enter(1)). */
  enter(i: Idx): void;
  /** Diff against base and the weakened-test verdict for attempt i; valid for A only before enter(1). */
  inspect(i: Idx): { diff: string; weakensTest: boolean };
  /** Run S in the primary; the caller has entered the attempt's tree. */
  score(i: Idx): Promise<AttemptCheck[]>;
}
export interface TwoAttemptResult { winner: Idx; reason: string; early: boolean; sessions: [SessionResult, SessionResult]; }
const ERRORED: SessionResult = { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
export async function runTwoAttempts(ops: AttemptOps, S: TestRef[], wall: TestRef[], signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<TwoAttemptResult> {
  assertScrubbedEnv(env);
  const ctl = [new AbortController(), new AbortController()];
  const killAll = (): void => ctl.forEach((c) => c.abort());
  if (signal.aborted) killAll(); else signal.addEventListener("abort", killAll, { once: true });
  const start = (i: Idx): Promise<SessionResult> => ops.run(i, ctl[i]!.signal).catch(() => ERRORED); // a throwing session is an errored attempt
  const pA = start(0), pB = start(1);
  const candidate = (i: Idx, s: SessionResult): AttemptCandidate => ({ index: i, killedOrErrored: s.killed || s.exit !== 0, alreadyDoneEvidence: s.markers.alreadyDone !== null, checks: [], ...ops.inspect(i) });
  const scorable = (c: AttemptCandidate): boolean => !c.killedOrErrored && !c.weakensTest && (c.diff.trim() !== "" || c.alreadyDoneEvidence);
  let held: Idx = 0;
  try {
    const a = await pA;
    const cA = candidate(0, a);
    if (scorable(cA)) cA.checks = await ops.score(0);
    if (scorable(cA) && isEarlyAccept(cA, S, wall)) { // the other session is killed, then awaited so its partial usage is priced before we return
      ctl[1]!.abort();
      return { winner: 0, reason: "early accept", early: true, sessions: [a, await pB] };
    }
    const b = await pB;
    const cB = candidate(1, b);
    if (scorable(cB)) { ops.enter(1); held = 1; cB.checks = await ops.score(1); }
    const pick = selectAttempt([cA, cB], S, wall);
    if (held !== pick.index) ops.enter(pick.index as Idx);
    return { winner: pick.index as Idx, reason: pick.reason, early: false, sessions: [a, b] };
  } finally {
    killAll(); // idempotent once both settled; on an error path this stops whatever is still running
    await Promise.allSettled([pA, pB]);
    signal.removeEventListener("abort", killAll);
  }
}
// ---- real wiring ---------------------------------------------------------
const untracked = (root: string): string[] => (safeGit(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...DEFAULT_EXCLUDES.map((e) => `:(exclude)${e}`)]).split("\0").filter((p) => p.length > 0));
/** Builds the real ops over treeswap. `wallPaths` are repo-relative sealed Wall files. */
export function treeswapOps(a: {
  primary: string; runDir: string; base: string; wallPaths: Set<string>;
  runSession: (i: Idx, cwd: string, signal: AbortSignal) => Promise<SessionResult>;
  runOne: (t: TestRef, out: AttemptCheck[]) => Promise<unknown>; S: TestRef[];
}): AttemptOps & { dispose(): void; bDir: string } {
  const attemptsDir = join(a.runDir, "attempts"), bDir = join(attemptsDir, "B");
  mkdirSync(attemptsDir, { recursive: true });
  safeGit(a.primary, ["worktree", "add", "--detach", bDir, a.base]);
  const pre = new Set(untracked(a.primary)); // the user's own untracked files: never dropped between attempts
  let snapA: ReturnType<typeof snapshotDiff> | null = null;
  const dropOwnUntracked = (): void => applyDiff(a.primary, untracked(a.primary).filter((p) => !pre.has(p)).map((path) => ({ path, kind: "delete" as const })));
  return {
    bDir,
    run: (i, signal) => a.runSession(i, (i === 0 ? a.primary : bDir), signal),
    enter(i) {
      if (i === 1) {
        snapA ??= snapshotDiff(a.primary, a.base);
        dropOwnUntracked();
        resetToBase(a.primary, a.base, DEFAULT_EXCLUDES, { keepUntracked: true }); // swap refuses a primary with tracked edits: A's are in snapA
        swapAttemptIntoWorkingTree({ primaryRoot: a.primary, attemptRoot: bDir, base: a.base, runDir: a.runDir });
      } else if (snapA) { dropOwnUntracked(); resetToBase(a.primary, a.base, DEFAULT_EXCLUDES, { keepUntracked: true }); applyDiff(a.primary, snapA); }
    },
    inspect(i) {
      const root = i === 0 ? a.primary : bDir, ex = DEFAULT_EXCLUDES.map((e) => `:(exclude)${e}`);
      const tracked = safeGit(root, ["diff", "--no-ext-diff", a.base, "--", ".", ...ex]);
      const added = untracked(root).filter((p) => !pre.has(p)).map((p) => `diff --git a/${p} b/${p}\n@@ -0,0 +1 @@\n+${p}\n`).join(""); // new files count as changed lines; content size is irrelevant to the empty-diff test
      const touched = snapshotDiff(root, a.base).map((e) => e.path);
      return { diff: tracked + added, weakensTest: touched.some((p) => a.wallPaths.has(p)) };
    },
    async score() { const out: AttemptCheck[] = []; for (const t of a.S) await a.runOne(t, out); return out; },
    dispose: () => { try { cleanupAttempt(a.primary, a.runDir, bDir); } catch { /* best-effort: a leaked worktree is pruned by git worktree prune */ } },
  };
}
/** `check` is verify.ts's runCheck, bound by the caller (this module may not import stages/ at runtime). */
export interface AttemptsDeps { check: (ctx: RunContext, t: TestRef, signal: AbortSignal, out: AttemptCheck[]) => Promise<unknown>; wallPaths: string[]; }
/** Runs the two attempts for implement. Returns the winner's session, every iteration id (winner last) and an event-ready summary. */
export async function runAttemptsOnCtx(ctx: RunContext, first: SessionRunOptions, signal: AbortSignal, impacted: string[], deps: AttemptsDeps): Promise<{ session: SessionResult; ids: string[]; summary: Record<string, unknown> }> {
  assertScrubbedEnv(process.env); // before the worktree exists
  const map = await ctx.tests.detect(ctx.repoDir);
  const S = map.tests.filter((t) => impacted.includes(t.path)), wall = S.filter((t) => deps.wallPaths.includes(t.path));
  const idB = `${first.iterationId}b`;
  const { resumeSessionId: _r, ...fresh } = first; // a provider session resumes into one cwd only
  const ops = treeswapOps({
    primary: ctx.repoDir, runDir: ctx.runDir, base: ctx.baseSha, wallPaths: new Set(deps.wallPaths), S,
    runSession: (i, cwd, sig) => ctx.sessions.run(i === 0 ? { ...first, cwd, signal: sig } : { ...fresh, cwd, iterationId: idB, signal: sig }),
    runOne: (t, out) => deps.check(ctx, t, signal, out),
  });
  try {
    const r = await runTwoAttempts(ops, S, wall, signal);
    const ids = r.winner === 0 ? [idB, first.iterationId] : [first.iterationId, idB];
    return { session: r.sessions[r.winner], ids, summary: { winner: r.winner === 0 ? "A" : "B", reason: r.reason, early_accept: r.early, shared_set: S.length } };
  } finally { ops.dispose(); }
}
