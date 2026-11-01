// All money is integer cents.
export interface LineItem {
  sku: string;
  priceCents: number;
  qty: number;
}

export const SHIPPING_CENTS = 499;
export const FREE_SHIPPING_MIN_CENTS = 5000;

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, it) => sum + it.priceCents * it.qty, 0);
}

export function shipping(items: LineItem[]): number {
  if (items.length === 0) return 0;
  return subtotal(items) >= FREE_SHIPPING_MIN_CENTS ? 0 : SHIPPING_CENTS;
}

export function cartTotal(items: LineItem[]): number {
  return subtotal(items) + shipping(items);
}
