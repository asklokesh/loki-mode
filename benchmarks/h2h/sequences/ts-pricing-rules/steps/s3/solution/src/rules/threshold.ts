import type { PricingRule } from "./types";

/** offCents off once the running total reaches minCents, never taking the total below 0. */
export function thresholdRule(minCents: number, offCents: number): PricingRule {
  if (!Number.isInteger(minCents) || minCents < 0 || !Number.isInteger(offCents) || offCents < 1) {
    throw new RangeError("minCents must be a non-negative integer and offCents a positive integer");
  }
  return (_cart, runningCents) => {
    if (runningCents < minCents) return null;
    const off = Math.min(offCents, runningCents);
    return off > 0 ? { rule: `threshold:${minCents}`, amountCents: -off } : null;
  };
}
