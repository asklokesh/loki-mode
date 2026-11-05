import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./argparse.mjs";

test("flags and positionals", () => {
  assert.deepEqual(parseArgs(["--verbose", "a", "-xy"]), { flags: { verbose: true, x: true, y: true }, positional: ["a"] });
});
test("string flag takes next value", () => {
  assert.deepEqual(parseArgs(["--out", "f.txt", "b"], { out: "string" }), { flags: { out: "f.txt" }, positional: ["b"] });
});
test("double dash ends flag parsing", () => {
  assert.deepEqual(parseArgs(["a", "--", "--x", "b"]), { flags: {}, positional: ["a", "--x", "b"] });
});
test("positional arguments keep their whitespace verbatim", () => {
  assert.deepEqual(parseArgs(["  spaced  ", "b"]), { flags: {}, positional: ["  spaced  ", "b"] });
});
