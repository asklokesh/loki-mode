import { currencyOf, type Currency, type Order } from "./types";

export interface Summary {
  count: number;
  totalsByCurrency: Partial<Record<Currency, number>>;
}

export function summarize(orders: Order[]): Summary {
  const totalsByCurrency: Partial<Record<Currency, number>> = {};
  for (const o of orders) {
    const c = currencyOf(o);
    totalsByCurrency[c] = (totalsByCurrency[c] ?? 0) + o.totalCents;
  }
  return { count: orders.length, totalsByCurrency };
}
