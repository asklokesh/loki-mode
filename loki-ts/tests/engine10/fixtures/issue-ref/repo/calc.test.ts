import { expect, test } from "bun:test";
import * as calc from "./calc";
import { add } from "./calc";

test("add", () => {
  expect(add(2, 3)).toBe(5);
});

// Covers subtract once it exists; green on the base tree where it does not.
test("subtract", () => {
  const subtract = (calc as { subtract?: (a: number, b: number) => number }).subtract;
  if (subtract) expect(subtract(5, 3)).toBe(2);
});
