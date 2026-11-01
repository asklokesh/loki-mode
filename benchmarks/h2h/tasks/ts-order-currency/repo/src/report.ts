import type { Order } from "./types";

export interface Summary {
  count: number;
  totalCents: number;
}

export function summarize(orders: Order[]): Summary {
  return {
    count: orders.length,
    totalCents: orders.reduce((sum, o) => sum + o.totalCents, 0),
  };
}
