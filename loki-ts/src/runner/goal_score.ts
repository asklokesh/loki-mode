// loki-ts/src/runner/goal_score.ts -- v8 harness intelligence (3c).
//
// HILL-CLIMBABLE GOAL SCORING.
//
// The premise, from jcode's measured-harness discipline: an agent can only hill
// climb toward a goal it can MEASURE. "Make the app fast" gives the loop no
// gradient -- every iteration can claim progress and none can be checked, which
// is precisely the shape that produces a confident agent and a hollow product.
// "p95 latency under 200ms on the /search endpoint" is climbable: each
// iteration either moved the number or did not.
//
// This scores how quantifiable a goal statement is, so the engine can push back
// on un-measurable goals BEFORE burning iterations on them. It complements the
// evidence gate: the evidence gate asks "did you prove you did it?", this asks
// the earlier question "is this goal even provable?".
//
// DELIBERATELY ADVISORY. Scoring a goal low SURFACES it; it never blocks a
// build, never fails a gate, and never edits the user's goal. A heuristic over
// natural language is not sound enough to gate on, and a scorer that could
// block would make a bad guess expensive. The trust core stays deterministic;
// this only adds a prompt-visible signal.

// A quantifiable goal generally carries at least one of: a number with a unit,
// a comparison operator, a named metric, or a concrete verifiable artifact.
// Each matched dimension adds signal; the score is the fraction present.

const NUMERIC_TARGET =
  /\b\d+(?:\.\d+)?\s*(?:%|ms|s\b|sec|second|min|minute|hour|day|kb|mb|gb|rps|qps|req|x\b|users?|items?|rows?)/i;

const COMPARATOR =
  /\b(?:under|below|less than|no more than|at most|over|above|greater than|at least|within|between|<=?|>=?)\b/i;

const NAMED_METRIC =
  /\b(?:latency|throughput|p50|p95|p99|uptime|error rate|conversion|coverage|score|accuracy|precision|recall|bundle size|load time|response time|memory|cpu|cost)\b/i;

// A goal naming a concrete artifact or checkable state is climbable even
// without a number: "all tests pass", "the /login endpoint returns 200".
const VERIFIABLE_ARTIFACT =
  /\b(?:tests? pass|builds? clean|endpoint|returns? \d{3}|exit code|schema|migration|deploys?|renders?|compiles?)\b/i;

// Vague quality words with no measurement attached. Their PRESENCE is not
// itself disqualifying (a good goal may say "fast, specifically p95<200ms"),
// so this only matters when nothing measurable was found.
const VAGUE_ONLY =
  /\b(?:fast|slow|good|bad|nice|clean|better|best|modern|beautiful|intuitive|robust|scalable|user-friendly|production-ready|polished|seamless)\b/i;

export type GoalScore = {
  /** 0..1. Higher = more hill-climbable. */
  readonly score: number;
  /** Which measurability dimensions were detected. */
  readonly dimensions: readonly string[];
  /** True when the goal reads as purely subjective (vague words, no metric). */
  readonly vagueOnly: boolean;
  /** One-line, human-readable reason. Safe to inject into a prompt. */
  readonly rationale: string;
};

const DIMENSIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["numeric_target", NUMERIC_TARGET],
  ["comparator", COMPARATOR],
  ["named_metric", NAMED_METRIC],
  ["verifiable_artifact", VERIFIABLE_ARTIFACT],
];

export function scoreGoal(goal: string): GoalScore {
  const text = (goal ?? "").trim();
  if (text === "") {
    return {
      score: 0,
      dimensions: [],
      vagueOnly: false,
      rationale: "Empty goal: nothing to measure.",
    };
  }

  const found: string[] = [];
  for (const [name, re] of DIMENSIONS) {
    if (re.test(text)) found.push(name);
  }

  const score = found.length / DIMENSIONS.length;
  const vagueOnly = found.length === 0 && VAGUE_ONLY.test(text);

  let rationale: string;
  if (found.length === 0) {
    rationale = vagueOnly
      ? "Subjective goal with no measurable target: every iteration can claim progress and none can be verified. Add a number, a comparison, or a concrete artifact to check."
      : "No measurable target detected: the loop has no gradient to climb. Add an explicit success threshold.";
  } else if (score < 0.5) {
    rationale = `Partially measurable (${found.join(", ")}): usable, but a concrete threshold would make progress checkable each iteration.`;
  } else {
    rationale = `Measurable (${found.join(", ")}): each iteration can be checked against this.`;
  }

  return { score, dimensions: found, vagueOnly, rationale };
}

// Threshold under which a goal is worth flagging. Tunable, but the default is
// deliberately low: flag only genuinely un-climbable goals, because a scorer
// that cries wolf gets ignored and then it is worse than absent.
//
// An ABSENT goal is not an un-climbable goal. Perpetual mode runs with an empty
// COMPLETION_PROMISE by design ("keep finding improvements"), and telling that
// run to "add a success threshold to your goal" is nonsense advice about a goal
// the user deliberately did not set. Only a goal that EXISTS and cannot be
// measured is worth flagging.
export function goalNeedsSharpening(
  s: GoalScore,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["LOKI_GOAL_SCORING"] === "0") return false;
  if (s.rationale.startsWith("Empty goal")) return false;
  return s.score === 0;
}

// The advisory block injected into the prompt for an un-climbable goal. Returns
// "" when the goal is fine, absent, or scoring is disabled, so callers can push
// unconditionally.
export function goalSharpeningInstruction(
  goal: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if ((goal ?? "").trim() === "") return "";
  const s = scoreGoal(goal);
  if (!goalNeedsSharpening(s, env)) return "";
  return (
    `GOAL_MEASURABILITY: the stated goal is not currently hill-climbable. ${s.rationale} ` +
    `Before implementing, restate it with at least one checkable success condition (a number with a unit, ` +
    `a comparison threshold, or a concrete artifact such as a passing test or an endpoint returning a specific status), ` +
    `and record that restatement so each iteration can be measured against it. Do NOT silently substitute your own ` +
    `easier goal -- if the goal cannot be sharpened from the spec alone, say so explicitly and state the assumption you are proceeding under.`
  );
}
