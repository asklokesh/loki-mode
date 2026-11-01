// All money is integer cents.
import { lookupDiscount } from "./discounts";

export interface LineItem {
  sku: string;
  priceCents: number;
  qty: number;
}

export const SHIPPING_CENTS = 499;
export const FREE_SHIPPING_MIN_CENTS = 5000;

export class InvalidDiscountError extends Error {
  constructor(code: string) {
    super(`unknown discount code: ${code}`);
    this.name = "InvalidDiscountError";
  }
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
}

export function shipping(items: LineItem[]): number {
  if (items.length === 0) return 0;
  return subtotal(items) >= FREE_SHIPPING_MIN_CENTS ? 0 : SHIPPING_CENTS;
}

export function cartTotal(items: LineItem[], code?: string): number {
  if (code === undefined || code.trim() === "") return subtotal(items) + shipping(items);
  const d = lookupDiscount(code);
  if (!d) throw new InvalidDiscountError(code);
  return d.apply(subtotal(items)) + (d.freeShipping ? 0 : shipping(items));
}
