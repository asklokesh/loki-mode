export type Currency = "USD" | "EUR" | "GBP";

export interface Order {
  id: number;
  customer: string;
  totalCents: number;
  currency?: Currency;
}

export const currencyOf = (order: Order): Currency => order.currency ?? "USD";
