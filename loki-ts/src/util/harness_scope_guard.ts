// FC-19: a LOKI_SPEC_CONFLICT or BLOCKED reason that cites Loki's own rules, stage, scope or limits is a harness failure (L5), never the user's spec conflict.
// Pure data and one regex, no imports; the implement stage and the supervisor both read it.
const HARNESS_SCOPE =
  /\bstage (rules?|scope|limits?|constraints?|prompt|instructions?)\b|\b(rules?|limits?|constraints?) (of|for|on) (this|the) stage\b|\bscope of this stage\b|\bone stage\b|\bnamed files\b|\blimit(s|ed|ing)? me\b|\brestrict(s|ed|ing)? me\b|\b(not allowed|forbidden|prohibited) to run the full\b|\b(brief|harness|loki)'?s? (rules?|limits?|constraints?)\b|\bonly (the )?(named|listed) files\b/i;
export const isHarnessScopeReason = (reason: string | null | undefined): boolean => typeof reason === "string" && HARNESS_SCOPE.test(reason);
const clean = (s: string, n: number): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, n);
/** The implement stage's harness-failure verdict for a conflict reason, or null when the conflict is genuine. */
export const harnessBlock = (reason: string | null): { reason: string; data: Record<string, unknown> } | null =>
  isHarnessScopeReason(reason) ? { reason: harnessScopeFailure(reason as string), data: { harness_failure: true, harness_reason: clean(reason as string, 200) } } : null;
/** The stage.failed reason shown to the user for a harness-caused block. */
export const harnessScopeFailure = (reason: string): string => `harness failure: the model blocked itself on Loki's own stage limits, not on your spec (${clean(reason, 160)})`;
