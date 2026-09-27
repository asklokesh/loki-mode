// Fixture standing in for eta.ts (E-20), which is not part of this slice.
// Used only to prove output.ts's dynamic import picks up a module when present.
export function estimate(targetS: number | null, elapsedS: number): number | null {
  if (targetS === null) return null;
  return Math.max(0, targetS - elapsedS);
}
