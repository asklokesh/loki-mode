const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
};

/** Parses a human duration such as "90s" or "2h" into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^\s*(\d+)\s*(d|h|m|ms|s)/.exec(input);
  if (!match) {
    throw new Error(`invalid duration: ${JSON.stringify(input)}`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}
