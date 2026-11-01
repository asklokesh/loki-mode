// Sales tax rates by country code, as fractions.
import type { Customer } from "./customers";

const RATES: Record<string, number> = {
  US: 0.07,
  GB: 0.2,
  DE: 0.19,
};

export function rateFor(customer: Customer): number {
  return RATES[customer.country] ?? 0;
}

export function isTaxExempt(customer: Customer): boolean {
  return customer.exempt === true;
}
