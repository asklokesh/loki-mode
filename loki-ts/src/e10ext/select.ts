// S41-05 attempt-selection rule (docs/v10/SCORECARD-PLAN.md section 4 "Attempt selection (two
// attempts)", docs/v10/DECISIONS.md D42 (1)). Pure function: it reads results core already
// computed by scoring each attempt's diff against the shared set S in the primary tree, and
// returns a choice only. It never runs a test, never decides pass/fail for Seal, and never
// touches stages/ at runtime (D42 (1); the import-graph guard lives in tests/engine10/budget.test.ts
// next to the modernize cap). Core re-runs verify and Seal on whichever tree this picks.
import type { TestRef } from "../engine10/types.ts";
// D42 (1): seal.ts/verify.ts/wall.ts/verify_cmd.ts may be referenced only as `import type`.
import type { VerifyCheck } from "../engine10/stages/verify.ts";

/** verify.ts's VerifyCheck plus S41-08's exit_code, which isn't recorded on main yet;
 *  condition 5 below treats a missing exit_code as "not a pytest collection-error exit". */
export type AttemptCheck = VerifyCheck & { exit_code?: number };

export interface AttemptCandidate {
  /** 0 is "A", 1 is "B"; also the final tie-break (rank key 7). */
  index: number;
  /** Session was killed or ended in error. */
  killedOrErrored: boolean;
  /** Unified diff of this attempt against baseSha, used for the empty-diff disqualifier and
   *  for rank key 6 (added + deleted non-blank lines). */
  diff: string;
  /** LOKI_ALREADY_DONE evidence: an empty diff is disqualified unless this is set. */
  alreadyDoneEvidence: boolean;
  /** seal.ts's weakened-test rule (an existing test function or a Wall file was edited or
   *  deleted): computed upstream, since select.ts may not import seal.ts at runtime. */
  weakensTest: boolean;
  /** Every check from scoring this attempt's diff against S in the primary tree, plus any lint
   *  checks. A check whose name is outside S and outside `wall` is ignored (an attempt-authored
   *  test never counts, section 4 note under the Deterministic failure definition). */
  checks: AttemptCheck[];
}

export interface SelectResult {
  index: number;
  reason: string;
}

const PYTEST_COLLECTION_EXITS = new Set([2, 3, 4, 5]);

function refName(t: TestRef): string {
  return `${t.runner}:${t.path}`;
}

/** Added + deleted non-blank lines of a unified diff, skipping the `+++`/`---` file headers. */
function diffChangedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line[0] === "+" || line[0] === "-") {
      if (line.slice(1).trim() !== "") n++;
    }
  }
  return n;
}

function isDisqualified(a: AttemptCandidate): boolean {
  if (a.killedOrErrored) return true;
  if (a.diff.trim() === "" && !a.alreadyDoneEvidence) return true;
  if (a.weakensTest) return true;
  return false;
}

/** The rank tuple for one attempt, each entry already oriented so lower is better
 *  (section 4 "Rank lexicographically", keys 1-7). */
function rankTuple(a: AttemptCandidate, sNames: Set<string>, wallNames: Set<string>): number[] {
  let wallPasses = 0;
  let deterministicFails = 0;
  let passesInS = 0;
  let flakyInS = 0;
  let lintFails = 0;
  for (const c of a.checks) {
    if (c.name.startsWith("lint:") && c.result === "fail") lintFails++;
    // wallPasses (key 1) reads `wall` directly, independent of S: a sealed Wall file is written
    // after baseSha and left uncommitted (wall.ts), so S's "exists at baseSha" filter can drop a
    // Wall test out of S while it still must count at key 1 -- an attempt that fails the Wall
    // must never win because the caller happened to build S without it (R1, reproduced: with the
    // Wall test outside S, a Wall failure used to be invisible everywhere).
    const inWall = wallNames.has(c.name);
    if (inWall && c.result === "pass") wallPasses++;
    // Every count below this line is an S-based count (keys 2-4): a check outside S -- whether
    // attempt-authored or a Wall test the caller left out of S -- never feeds them; only wallPasses
    // above sees it. This line is the sole S gate; do not also gate wallPasses on it.
    if (!sNames.has(c.name)) continue;
    if (c.result === "pass" && c.interpreter === "project") passesInS++;
    if (c.result === "flaky") flakyInS++;
    if (
      c.result === "fail" &&
      c.interpreter !== "system" &&
      (c.exit_code === undefined || !PYTEST_COLLECTION_EXITS.has(c.exit_code))
    ) {
      deterministicFails++;
    }
  }
  return [-wallPasses, deterministicFails, -passesInS, flakyInS, lintFails, diffChangedLines(a.diff), a.index];
}

function compareTuples(x: number[], y: number[]): number {
  for (let i = 0; i < x.length; i++) {
    if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  }
  return 0;
}

const RANK_LABELS = ["wallPasses", "deterministicFails", "passesInS", "flakyInS", "lintFails", "diffLines", "index"];

/** Section 4 "Early accept": true only when S is non-empty and every check named in S or in
 *  `wall` has a "pass" entry in this one attempt's checks. The caller (S41-13) uses this to
 *  decide whether to accept a finished attempt and kill the other session before it even
 *  finishes. selectAttempt itself does not implement early accept: called with a single,
 *  all-failing attempt it still returns that attempt's index (nothing better was offered), so the
 *  caller must check isEarlyAccept before deciding to call selectAttempt with just one attempt. */
export function isEarlyAccept(attempt: AttemptCandidate, S: TestRef[], wall: TestRef[]): boolean {
  if (S.length === 0) return false;
  const required = new Set([...S.map(refName), ...wall.map(refName)]);
  const passed = new Set(attempt.checks.filter((c) => c.result === "pass").map((c) => c.name));
  for (const name of required) {
    if (!passed.has(name)) return false;
  }
  return true;
}

/** Section 4 "Attempt selection (two attempts)". `S` is the shared set (sealed Wall tests plus
 *  impacted(changed_A + changed_B), already filtered to tests existing at baseSha); `wall` is its
 *  sealed-Wall subset, used for rank key 1. This function only ranks and disqualifies -- it never
 *  decides early accept (see isEarlyAccept above): given one all-failing attempt it still returns
 *  that attempt, since nothing better is on offer in this call. */
export function selectAttempt(attempts: AttemptCandidate[], S: TestRef[], wall: TestRef[]): SelectResult {
  if (attempts.length === 0) throw new Error("selectAttempt: no attempts given");
  const sNames = new Set(S.map(refName));
  const wallNames = new Set(wall.map(refName));
  const qualified = attempts.filter((a) => !isDisqualified(a));
  if (qualified.length === 0) {
    const a = [...attempts].sort((x, y) => x.index - y.index)[0]!;
    return { index: a.index, reason: `fallback: every attempt disqualified, keeping the lowest-index attempt (index ${a.index})` };
  }
  const scored = qualified.map((a) => ({ a, tuple: rankTuple(a, sNames, wallNames) }));
  scored.sort((x, y) => compareTuples(x.tuple, y.tuple));
  const winner = scored[0]!;
  let decidedBy = "index";
  if (scored.length > 1) {
    const runnerUp = scored[1]!;
    for (let i = 0; i < winner.tuple.length; i++) {
      if (winner.tuple[i] !== runnerUp.tuple[i]) {
        decidedBy = RANK_LABELS[i]!;
        break;
      }
    }
  }
  return { index: winner.a.index, reason: `rank: ${decidedBy}` };
}
