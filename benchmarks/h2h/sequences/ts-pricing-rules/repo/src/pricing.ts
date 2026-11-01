import { type Cart, subtotalCents } from "./cart";
import type { Adjustment, PricingRule } from "./rules/types";

export interface Quote {
  subtotalCents: number;
  adjustments: Adjustment[];
  totalCents: number;
}

/**
 * Applies rules in order. Each rule sees the running total after the earlier rules;
 * rules that return null or a zero amount leave no adjustment. The total never goes below 0.
 */
export function priceCart(cart: Cart, rules: PricingRule[]): Quote {
  const subtotal = subtotalCents(cart);
  let running = subtotal;
  const adjustments: Adjustment[] = [];
  for (const rule of rules) {
    const adj = rule(cart, running);
    if (!adj || adj.amountCents === 0) continue;
    adjustments.push(adj);
    running += adj.amountCents;
  }
  return { subtotalCents: subtotal, adjustments, totalCents: Math.max(0, running) };
}
