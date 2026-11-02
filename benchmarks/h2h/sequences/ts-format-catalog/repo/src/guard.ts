export function assertFiniteNumber(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name}: expected a finite number`);
}
