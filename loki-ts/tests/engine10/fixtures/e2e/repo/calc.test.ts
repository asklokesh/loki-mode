import { expect, test } from "bun:test";
import { add } from "./calc";

test("add", () => {
  expect(add(2, 3)).toBe(5);
});
