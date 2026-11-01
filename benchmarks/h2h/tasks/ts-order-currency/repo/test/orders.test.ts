import { expect, test } from "bun:test";
import { toCsv } from "../src/export";
import { formatOrder } from "../src/format";
import { summarize } from "../src/report";

const orders = [
  { id: 1, customer: "Alice", totalCents: 1234 },
  { id: 2, customer: "Bob, Jr.", totalCents: 500 },
];

test("formatOrder", () => {
  expect(formatOrder(orders[0])).toBe("#1 Alice $12.34");
});

test("toCsv quotes fields with commas", () => {
  expect(toCsv(orders)).toBe('id,customer,total\n1,Alice,12.34\n2,"Bob, Jr.",5.00');
});

test("summarize", () => {
  expect(summarize(orders)).toEqual({ count: 2, totalCents: 1734 });
});
