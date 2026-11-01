import { expect, test } from "bun:test";
import { paginate } from "../src/paginate";
import { listUsers } from "../src/users";

const ten = Array.from({ length: 10 }, (_, i) => i + 1);

test("a full page has pageSize items", () => {
  expect(paginate(ten, 1, 3).items).toEqual([1, 2, 3]);
  expect(paginate(ten, 2, 3).items).toEqual([4, 5, 6]);
});

test("the partial last page is counted and returned", () => {
  const last = paginate(ten, 4, 3);
  expect(last.items).toEqual([10]);
  expect(last.totalPages).toBe(4);
  expect(last.hasNext).toBe(false);
});

test("hasNext is true before the last page", () => {
  expect(paginate(ten, 3, 3).hasNext).toBe(true);
  expect(paginate(ten, 3, 3).totalPages).toBe(4);
});

test("an evenly divided list", () => {
  const p = paginate([1, 2, 3, 4], 2, 2);
  expect(p.items).toEqual([3, 4]);
  expect(p.totalPages).toBe(2);
  expect(p.hasNext).toBe(false);
});

test("a page past the end is empty, not an error", () => {
  const p = paginate(ten, 9, 3);
  expect(p.items).toEqual([]);
  expect(p.hasNext).toBe(false);
  expect(p.page).toBe(9);
});

test("an empty list has zero pages", () => {
  const p = paginate([], 1, 5);
  expect(p.items).toEqual([]);
  expect(p.totalPages).toBe(0);
  expect(p.hasNext).toBe(false);
});

test("a page size larger than the list", () => {
  const p = paginate([1, 2], 1, 50);
  expect(p.items).toEqual([1, 2]);
  expect(p.totalPages).toBe(1);
});

test("listUsers sorts and pages correctly", () => {
  const users = [5, 3, 1, 4, 2].map((id) => ({ id, name: `u${id}` }));
  const p = listUsers(users, 2, 2);
  expect(p.items.map((u) => u.id)).toEqual([3, 4]);
  expect(listUsers(users, 3, 2).items.map((u) => u.id)).toEqual([5]);
  expect(p.totalPages).toBe(3);
});

test("validation still applies", () => {
  expect(() => paginate(ten, 1, -1)).toThrow(RangeError);
  expect(() => paginate(ten, 0, 3)).toThrow(RangeError);
});
