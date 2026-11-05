import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsage } from "../src/format.js";

test("usage lists every option with its alias", () => {
  const text = formatUsage("tool", [{ name: "verbose", alias: "v", describe: "talk more" }, { name: "out", type: "string" }]);
  assert.match(text, /-v, --verbose/);
  assert.match(text, /--out <string>/);
});
