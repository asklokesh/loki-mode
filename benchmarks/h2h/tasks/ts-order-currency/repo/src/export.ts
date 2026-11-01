import { formatAmount } from "./format";
import type { Order } from "./types";

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV with a header row: id,customer,total */
export function toCsv(orders: Order[]): string {
  const rows = orders.map((o) => [String(o.id), csvField(o.customer), formatAmount(o.totalCents)].join(","));
  return ["id,customer,total", ...rows].join("\n");
}
