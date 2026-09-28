import { expect, test } from "bun:test";
import { search } from "../src/search-command";

test("search", () => {
  expect(search("x")).toEqual(["x"]);
});
