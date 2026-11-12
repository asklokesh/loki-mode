// EXP-0010 attempt-selection rule (docs/v10/DECISIONS.md D42 (1)). Pure function: it reads what core already computed for each attempt (Loki's normal verify run on that attempt's tree in
// the primary, plus the session outcome and the diff), and returns a choice only. It never runs a test, never decides pass/fail for Seal, and never touches stages/ at runtime (D42 (1);
// the import-graph guard lives in tests/engine10/budget.test.ts next to the modernize cap). Seal runs on whichever tree this picks. Every rank key is a signal a real user has: no hidden test.
import type { TestRef } from "../engine10/types.ts"; import { changedSince } from "../util/check_result.ts";
// D42 (1): seal.ts/verify.ts/wall.ts/verify_cmd.ts may be referenced only as `import type`.
import type { VerifyCheck } from "../engine10/stages/verify.ts";

/** verify.ts's VerifyCheck plus S41-08's exit_code (features/tournament.ts scores candidates with it). */
export type AttemptCheck = VerifyCheck & { exit_code?: number };

/** What a real user can read off one attempt before seal: verify red, a spec conflict, and the NOT PROVEN lines verify and the fix rounds wrote (features/attempts.ts attemptSignal). */
export interface AttemptSignal { red: boolean; conflict: boolean; notProven: string[] }

export interface AttemptCandidate {
  /** 0 is the incumbent (the first attempt, already in the primary tree), 1.. the extra attempts; also the final tie-break. */
  index: number;
  /** Session was killed or ended in error. */
  killedOrErrored: boolean;
  /** Unified diff of this attempt against baseSha, used for the empty-diff disqualifier and the tie review. */
  diff: string;
  /** The same diff with the text of new files, shown to the tie review; absent: `diff`. */
  reviewDiff?: string;
  /** LOKI_ALREADY_DONE evidence: an empty diff is disqualified unless this is set. */
  alreadyDoneEvidence: boolean;
  /** seal.ts's weakened-test rule (an existing test function or a Wall file was edited or deleted): computed upstream, since select.ts may not import seal.ts at runtime. */
  weakensTest: boolean;
  /** EXP-0010: edited existing (not new) files the task and plan do not name (e10ext/scope.ts outsideScope); recorded, not ranked. */
  outsideFiles?: number;
  /** The attempt's verify outcome; absent when it was never verified (a disqualified attempt). */
  signal?: AttemptSignal;
}

export interface SelectResult {
  index: number;
  reason: string;
}
export interface RankResult extends SelectResult {
  /** Qualified attempts tied with the winner on every rank key, lowest index first (length 1 when the rank decided). */
  tied: number[];
}

function refName(t: TestRef): string {
  return `${t.runner}:${t.path}`;
}

export function isDisqualified(a: AttemptCandidate): boolean {
  if (a.killedOrErrored) return true;
  if (a.diff.trim() === "" && !a.alreadyDoneEvidence) return true;
  if (a.weakensTest) return true;
  return !a.signal;
}

/** Lower is better: verify green first, then no spec conflict, then fewer NOT PROVEN lines. */
const rankKey = (s: AttemptSignal): number[] => [s.red ? 1 : 0, s.conflict ? 1 : 0, s.notProven.length];
const RANK_LABELS = ["verify green", "no spec conflict", "fewer NOT PROVEN lines"];

/** Ranks the attempts on the user-visible verify outcome. A disqualified attempt (killed, errored, empty diff without already-done evidence, a weakened test, never verified) never wins
 *  unless every attempt is, when the lowest index (the incumbent) is kept. `tied` lists the attempts equal to the winner on every key; the caller breaks that tie (attempts.ts reviewTie). */
export function rankAttempts(attempts: AttemptCandidate[]): RankResult {
  if (attempts.length === 0) throw new Error("rankAttempts: no attempts given");
  const byIndex = [...attempts].sort((x, y) => x.index - y.index);
  const qualified = byIndex.filter((a) => !isDisqualified(a));
  if (qualified.length === 0) return { index: byIndex[0]!.index, tied: [byIndex[0]!.index], reason: `fallback: every attempt disqualified, keeping the lowest-index attempt (index ${byIndex[0]!.index})` };
  const scored = qualified.map((a) => ({ a, key: rankKey(a.signal!) }));
  const cmp = (x: number[], y: number[]): number => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return 0; };
  scored.sort((x, y) => cmp(x.key, y.key) || x.a.index - y.a.index);
  const best = scored[0]!, tied = scored.filter((s) => cmp(s.key, best.key) === 0).map((s) => s.a.index);
  if (tied.length > 1) return { index: best.a.index, tied, reason: `tie on verify outcome and NOT PROVEN count (${best.key[2]}) between attempts ${tied.join(", ")}` };
  const next = scored[1];
  const at = next ? best.key.findIndex((v, i) => v !== next.key[i]) : -1;
  return { index: best.a.index, tied, reason: next ? `rank: ${RANK_LABELS[at]}${at === 2 ? ` (${best.key[2]} < ${next.key[2]})` : ""}` : "rank: the only qualified attempt" };
}

/** TEN-SPEED-07: a fix round's verify runs the tests that failed last round first, so a still-red file is reported early and the
 *  rest keep their order (stable partition). Order only: every test still runs and no runner flag changes. `prior` is the previous verify output's checks. */
export function failedFirst<T extends TestRef>(tests: T[], prior: ReadonlyArray<{ name?: unknown; result?: unknown }> | undefined): T[] {
  const red = new Set((prior ?? []).filter((c) => c.result === "fail" && typeof c.name === "string").map((c) => c.name as string));
  if (red.size === 0) return tests;
  return [...tests.filter((t) => red.has(refName(t))), ...tests.filter((t) => !red.has(refName(t)))];
}

/** L025: a fix round's quick verify. `first` holds what can have changed or must prove the task: the checks that blocked the previous verify, the
 *  Wall and task-named tests (`keep`), and tests impacted by files changed since that verify (`since`); `rest` is everything else, run only once
 *  `first` holds no decisive failure, so the complete selection runs once, last. Order is preserved within each part. */
export function quickSplit<T extends TestRef>(tests: T[], keep: ReadonlySet<string>, since: ReadonlyArray<TestRef>): { first: T[]; rest: T[] } {
  const want = new Set([...keep, ...since.map(refName)]), first = tests.filter((t) => want.has(refName(t)));
  return { first, rest: tests.filter((t) => !want.has(refName(t))) };
}

export const QUICK_ONLY_NOTE = "quick re-verify only: the complete verify did not run after the last fix round";
/** L025: verify after a fix round is quick: the previous verify's blocking check names and the paths changed since it (fileHashes). Null on a first
 *  verify, an output without hashes (a stopped verify) or LOKI_E10_QUICK_VERIFY=0, which all run the complete selection. */
export function quickScope(o: Record<string, Record<string, unknown> | undefined>, now: Record<string, string>): { blocking: Set<string>; since: string[] } | null {
  const prev = o.verify, hashes = prev?.file_hashes, blocking = prev?.blocking_checks;
  if (process.env["LOKI_E10_QUICK_VERIFY"] === "0" || typeof o.fix?.round !== "number" || !hashes || typeof hashes !== "object" || !Array.isArray(blocking)) return null;
  return { blocking: new Set(blocking as string[]), since: changedSince(hashes as Record<string, string>, now) };
}
