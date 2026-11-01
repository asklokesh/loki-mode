import { expect, test } from "bun:test";
import { toCsv } from "../src/export";
import { formatOrder } from "../src/format";
import { summarize } from "../src/report";
import type { Currency, Order } from "../src/types";

const eur: Currency = "EUR";
const orders: Order[] = [
  { id: 1, customer: "Alice", totalCents: 1234, currency: "USD" },
  { id: 2, customer: "Bob, Jr.", totalCents: 500, currency: eur },
  { id: 3, customer: "Cara", totalCents: 999, currency: "GBP" },
  { id: 4, customer: "Dev", totalCents: 1000 },
  { id: 5, customer: "Eve", totalCents: 250, currency: "EUR" },
];

test("formatOrder prints the currency code after the amount", () => {
  expect(formatOrder(orders[1])).toBe("#2 Bob, Jr. 5.00 EUR");
  expect(formatOrder(orders[2])).toBe("#3 Cara 9.99 GBP");
  expect(formatOrder(orders[0])).toBe("#1 Alice 12.34 USD");
});

test("a missing currency is USD", () => {
  expect(formatOrder(orders[3])).toBe("#4 Dev 10.00 USD");
});

test("CSV has a currency column after total", () => {
  expect(toCsv(orders.slice(0, 4))).toBe(
    'id,customer,total,currency\n1,Alice,12.34,USD\n2,"Bob, Jr.",5.00,EUR\n3,Cara,9.99,GBP\n4,Dev,10.00,USD',
  );
  expect(toCsv([])).toBe("id,customer,total,currency");
});

test("summarize totals per currency", () => {
  expect(summarize(orders)).toEqual({
    count: 5,
    totalsByCurrency: { USD: 2234, EUR: 750, GBP: 999 },
  });
});

test("summarize only lists currencies that appear", () => {
  expect(summarize([orders[2]])).toEqual({ count: 1, totalsByCurrency: { GBP: 999 } });
  expect(summarize([])).toEqual({ count: 0, totalsByCurrency: {} });
});
