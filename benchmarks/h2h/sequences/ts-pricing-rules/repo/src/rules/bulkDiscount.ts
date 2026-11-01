import type { PricingRule } from "./types";

/** Every line with at least minQty units gets centsOffPerUnit off each of its units. */
export function bulkDiscountRule(minQty: number, centsOffPerUnit: number): PricingRule {
  if (!Number.isInteger(minQty) || minQty < 1 || !Number.isInteger(centsOffPerUnit) || centsOffPerUnit < 1) {
    throw new RangeError("minQty and centsOffPerUnit must be positive integers");
  }
  return (cart) => {
    let off = 0;
    for (const item of cart.items) {
      if (item.qty >= minQty) off += item.qty * Math.min(centsOffPerUnit, item.unitCents);
    }
    return off > 0 ? { rule: `bulk:${minQty}`, amountCents: -off } : null;
  };
}
