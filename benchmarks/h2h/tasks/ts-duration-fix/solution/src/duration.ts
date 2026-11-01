const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
};

/** Parses a human duration such as "90s", "2h" or "1h30m15s" into milliseconds. */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (!/^(\d+\s*(ms|d|h|m|s)\s*)+$/.test(text)) {
    throw new Error(`invalid duration: ${JSON.stringify(input)}`);
  }
  let total = 0;
  for (const m of text.matchAll(/(\d+)\s*(ms|d|h|m|s)/g)) {
    total += Number(m[1]) * UNIT_MS[m[2]];
  }
  return total;
}
