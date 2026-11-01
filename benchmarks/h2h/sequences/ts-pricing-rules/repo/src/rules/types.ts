import type { Cart } from "../cart";

/** One line on the receipt. A discount has a negative amountCents. */
export interface Adjustment {
  rule: string;
  amountCents: number;
}

/**
 * A pricing rule looks at the cart and the running total (subtotal plus every earlier
 * adjustment) and returns its adjustment, or null when it does not apply.
 */
export type PricingRule = (cart: Cart, runningCents: number) => Adjustment | null;
