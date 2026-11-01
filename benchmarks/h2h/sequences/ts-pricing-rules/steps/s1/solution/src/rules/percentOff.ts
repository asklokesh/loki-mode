import type { PricingRule } from "./types";

/** percent off the combined price of every line in the category, rounded half up to a cent. */
export function percentOffRule(category: string, percent: number): PricingRule {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new RangeError("percent must be an integer from 1 to 100");
  }
  return (cart) => {
    let base = 0;
    for (const item of cart.items) {
      if (item.category === category) base += item.unitCents * item.qty;
    }
    const off = Math.floor((base * percent + 50) / 100);
    return off > 0 ? { rule: `percent-off:${category}`, amountCents: -off } : null;
  };
}
