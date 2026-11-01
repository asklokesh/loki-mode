import { expect, test } from "bun:test";
import { paginate } from "../src/paginate";

test("rejects a non-positive page size", () => {
  expect(() => paginate([1, 2, 3], 1, 0)).toThrow(RangeError);
});

test("rejects page 0", () => {
  expect(() => paginate([1, 2, 3], 0, 2)).toThrow(RangeError);
});

test("first page of an evenly divided list", () => {
  const p = paginate([1, 2, 3, 4], 1, 2);
  expect(p.page).toBe(1);
  expect(p.totalPages).toBe(2);
});
