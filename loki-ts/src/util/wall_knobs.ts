// RUN5-C1: the Wall's concurrency and output-bound knobs. Kept outside engine10/ because the core is at its line cap (budget.test.ts), as model_rank.ts is.
const noted = new Set<string>();
const off = (v: string | undefined): boolean => ["0", "off", "false"].includes((v ?? "").toLowerCase());

/** Concurrent Wall authoring. Explicit 0/off/false is sequential and 1/on/true is concurrent. Unset is concurrent only where sonnet is already the Wall model (a LOKI_E10_WALL_TIER or LOKI_MODEL_OVERRIDE pin, or LOKI_E10_WALL_FIRST off); otherwise the haiku-first Wall keeps its sequential escalation, since a cheap rung cannot be re-authored blind after implement. */
export const wallConcurrent = (env = process.env): boolean => {
  const v = (env.LOKI_E10_WALL_CONCURRENT ?? "").toLowerCase();
  if (off(v)) return false;
  if (["1", "on", "true"].includes(v)) return true;
  return !!(env.LOKI_E10_WALL_TIER || env.LOKI_MODEL_OVERRIDE || off(env.LOKI_E10_WALL_FIRST));
};

export const WALL_MAX_TOKENS_DEFAULT = 16000;
/** LOKI_E10_WALL_MAX_TOKENS: the output-token ceiling of each Wall author response (default 16000). Handed to the session as the provider's own output limit, so the model stops there; nothing is cut afterwards. Only a plain decimal integer from 1 to Number.MAX_SAFE_INTEGER counts: garbage, zero, signs, fractions, exponents (1e3), hex (0x10), surrounding spaces and larger values fall back with one warning. */
export const wallMaxTokens = (env = process.env): number => {
  const raw = env.LOKI_E10_WALL_MAX_TOKENS, t = raw ?? "", n = Number(t);
  if (/^[0-9]+$/.test(t) && Number.isSafeInteger(n) && n > 0) return n;
  if (raw !== undefined && raw.trim() && !noted.has(raw)) { noted.add(raw); process.stderr.write(`loki: LOKI_E10_WALL_MAX_TOKENS="${raw}" is not a positive decimal integer within the safe range; using ${WALL_MAX_TOKENS_DEFAULT}\n`); }
  return WALL_MAX_TOKENS_DEFAULT;
};
/** What a Wall session is handed: the knob when set; else the user's own inherited CLAUDE_CODE_MAX_OUTPUT_TOKENS (left alone, undefined here); else the default. Other stages never get this option. */
export const wallOutputCap = (env = process.env): number | undefined => (env.LOKI_E10_WALL_MAX_TOKENS === undefined && env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ? undefined : wallMaxTokens(env));
