import type { PricingRule } from "./types";

/** For every buy + free units of sku in the cart, free of them cost nothing (priced at the lowest unit price). */
export function buyXGetYRule(sku: string, buy: number, free: number): PricingRule {
  if (!Number.isInteger(buy) || buy < 1 || !Number.isInteger(free) || free < 1) {
    throw new RangeError("buy and free must be positive integers");
  }
  return (cart) => {
    let qty = 0;
    let unit = Infinity;
    for (const item of cart.items) {
      if (item.sku !== sku) continue;
      qty += item.qty;
      unit = Math.min(unit, item.unitCents);
    }
    const freeUnits = Math.floor(qty / (buy + free)) * free;
    const off = freeUnits * (qty > 0 ? unit : 0);
    return off > 0 ? { rule: `buy-${buy}-get-${free}:${sku}`, amountCents: -off } : null;
  };
}
