import { currencyOf, type Order } from "./types";

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** One line for the order list, e.g. "#12 Alice 12.34 USD". */
export function formatOrder(order: Order): string {
  return `#${order.id} ${order.customer} ${formatAmount(order.totalCents)} ${currencyOf(order)}`;
}
