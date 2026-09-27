// Fixture test. Imports bun:test (vitest-compatible API) because the loki-ts
// suite discovers and typechecks this file; runner detection reads package.json.
import { expect, test } from "bun:test";
import { search } from "./search.ts";

test("search matches case-insensitively", () => {
  expect(search("AB", ["abc", "xyz"])).toEqual(["abc"]);
});
