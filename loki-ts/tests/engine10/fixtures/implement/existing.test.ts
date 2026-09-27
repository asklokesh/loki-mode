// Fixture: a pre-existing test file. During the implement stage this file
// (and any Wall test) is read-only; the stage must restore it if the
// provider session edits or deletes it, and list it in tests_reverted.
import { expect, test } from "bun:test";

test("existing behavior stays covered", () => {
  expect(1).toBe(1);
});
