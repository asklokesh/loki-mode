import { expect, test } from "bun:test";
import { formatOrdinal } from "../src/format";
import { formatterNamed } from "../src/catalog";

test("values", () => {
  const want: [number, string][] = [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"],
    [21, "21st"], [22, "22nd"], [23, "23rd"], [102, "102nd"], [111, "111th"], [112, "112th"], [0, "0th"], [1001, "1001st"]];
  for (const [n, s] of want) expect(formatOrdinal(n)).toBe(s);
});

test("bad integers throw RangeError", () => {
  expect(() => formatOrdinal(1.5)).toThrow("n must be a non-negative integer");
  expect(() => formatOrdinal(-1)).toThrow(RangeError);
});

test("non-numbers throw TypeError", () => {
  for (const bad of ["1", NaN, Infinity, undefined]) expect(() => formatOrdinal(bad as never)).toThrow(TypeError);
});

test("in the catalog", () => {
  expect(formatterNamed("formatOrdinal")?.fn).toBe(formatOrdinal);
});
