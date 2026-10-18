// Identical-action stall. The verify loop already stops on the same failure signature
// three times (machine.ts). This catches a fix that repeats the same diff and the
// same failure, so the next verify is not spent on a no-op.

export function repeatedNoopFix(
  prior: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): boolean {
  if (!prior || !next) return false;
  const a = prior.diff_stat;
  const b = next.diff_stat;
  const sa = prior.signatures;
  const sb = next.signatures;
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || a !== b) return false;
  if (a === "(diff stat is not available)") return false;
  return typeof sa === "string" && sa.length > 0 && sa === sb;
}
