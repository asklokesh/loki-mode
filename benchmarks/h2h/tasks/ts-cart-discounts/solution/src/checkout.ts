import { cartTotal, type LineItem } from "./cart";

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function checkoutSummary(items: LineItem[], code?: string): string {
  return `Total: ${formatCents(cartTotal(items, code))}`;
}
