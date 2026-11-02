import { expect, test } from "bun:test";
import { formatCurrency } from "../src/format";
import { formatterNamed } from "../src/catalog";

test("values", () => {
  expect(formatCurrency(123456)).toBe("$1,234.56");
  expect(formatCurrency(5)).toBe("$0.05");
  expect(formatCurrency(0)).toBe("$0.00");
  expect(formatCurrency(-500)).toBe("-$5.00");
  expect(formatCurrency(123456789, "€")).toBe("€1,234,567.89");
  expect(formatCurrency(100000)).toBe("$1,000.00");
});

test("non-integer throws RangeError", () => {
  expect(() => formatCurrency(1.5)).toThrow("cents must be an integer");
});

test("non-numbers throw TypeError", () => {
  for (const bad of ["1", NaN, Infinity, undefined]) expect(() => formatCurrency(bad as never)).toThrow(TypeError);
});

test("in the catalog", () => {
  expect(formatterNamed("formatCurrency")?.fn).toBe(formatCurrency);
});
