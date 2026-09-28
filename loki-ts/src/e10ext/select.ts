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

function isTestCheck(name: string): boolean {
  return !name.startsWith("lint:") && name !== "select-tests";
}

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
    if (c.name.startsWith("lint:")) {
      if (c.result === "fail") lintFails++;
      continue;
    }
    const inS = sNames.has(c.name);
    const inWall = wallNames.has(c.name);
    if (!inS && !inWall) continue; // attempt-authored test: not in S, never counts
    if (inWall && c.result === "pass") wallPasses++;
    if (!inS) continue; // wall-only entries (shouldn't happen: wall subset S) don't feed S counts below
    if (c.result === "pass" && c.interpreter === "project") passesInS++;
    if (c.result === "flaky") flakyInS++;
    if (
      c.result === "fail" &&
      isTestCheck(c.name) &&
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

/** Section 4 "Attempt selection (two attempts)". `S` is the shared set (sealed Wall tests plus
 *  impacted(changed_A + changed_B), already filtered to tests existing at baseSha); `wall` is its
 *  sealed-Wall subset, used for rank key 1 and for the early-accept check (call this with a single
 *  finished attempt to get that behavior: the algorithm below already picks it whenever every S and
 *  Wall check passes, with no need to wait on a second attempt). */
export function selectAttempt(attempts: AttemptCandidate[], S: TestRef[], wall: TestRef[]): SelectResult {
  if (attempts.length === 0) throw new Error("selectAttempt: no attempts given");
  const sNames = new Set(S.map(refName));
  const wallNames = new Set(wall.map(refName));
  const qualified = attempts.filter((a) => !isDisqualified(a));
  if (qualified.length === 0) {
    const a = [...attempts].sort((x, y) => x.index - y.index)[0]!;
    return { index: a.index, reason: "fallback: every attempt disqualified, keeping A" };
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
