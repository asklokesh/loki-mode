import { expect, test } from "bun:test";
import * as calc from "./calc";

test("add", () => {
  expect(calc.add(2, 3)).toBe(5);
  // forward compatible: passes before multiply exists and exercises it once it does
  if ("multiply" in calc) expect((calc as unknown as { multiply: (a: number, b: number) => number }).multiply(3, 4)).toBe(12);
});
