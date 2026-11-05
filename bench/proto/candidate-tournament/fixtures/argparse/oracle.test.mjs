import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./argparse.mjs";
test("oracle: lone dash continues", () => {
  assert.deepEqual(parseArgs(["-", "--verbose", "file.txt"]), { flags: { verbose: true }, positional: ["-", "file.txt"] });
});
test("oracle: lone dash is passed verbatim like other positionals", () => {
  assert.deepEqual(parseArgs([" - ", "x"]), { flags: {}, positional: [" - ", "x"] });
});
