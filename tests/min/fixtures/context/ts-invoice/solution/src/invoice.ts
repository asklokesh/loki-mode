import type { Customer } from "./customers";
import { roundCents, sumCents, type Cents } from "./money";
import { isTaxExempt, rateFor } from "./tax";

export interface LineItem {
  sku: string;
  unitCents: Cents;
  qty: number;
}

export function lineSubtotal(item: LineItem): Cents {
  return item.unitCents * item.qty;
}

export function invoiceTotal(customer: Customer, items: LineItem[]): Cents {
  const rate = isTaxExempt(customer) ? 0 : rateFor(customer);
  return sumCents(items.map((item) => {
    const sub = lineSubtotal(item);
    return sub + roundCents(sub * rate);
  }));
}
