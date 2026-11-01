import { formatAmount } from "./format";
import { currencyOf, type Order } from "./types";

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV with a header row: id,customer,total,currency */
export function toCsv(orders: Order[]): string {
  const rows = orders.map((o) => [String(o.id), csvField(o.customer), formatAmount(o.totalCents), currencyOf(o)].join(","));
  return ["id,customer,total,currency", ...rows].join("\n");
}
