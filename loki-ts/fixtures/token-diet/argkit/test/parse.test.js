import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/parse.js";

const OPTS = [
  { name: "verbose", alias: "v" },
  { name: "out", alias: "o", type: "string" },
  { name: "level", type: "number", default: 1 },
  { name: "tag", alias: "t", type: "list" },
];

test("positionals and long options mix", () => {
  const r = parseArgs(["a", "--verbose", "b", "--out", "x.txt"], OPTS);
  assert.deepEqual(r.positionals, ["a", "b"]);
  assert.equal(r.values.verbose, true);
  assert.equal(r.values.out, "x.txt");
});

test("double dash keeps the rest verbatim", () => {
  const r = parseArgs(["--verbose", "--", "--out", "y"], OPTS);
  assert.deepEqual(r.positionals, ["--out", "y"]);
  assert.equal(r.values.out, undefined);
});

test("equals form and negation", () => {
  const r = parseArgs(["--level=3", "--no-verbose"], OPTS);
  assert.equal(r.values.level, 3);
  assert.equal(r.values.verbose, false);
});

test("short clusters with an inline value", () => {
  const r = parseArgs(["-vofile.txt"], OPTS);
  assert.equal(r.values.verbose, true);
  assert.equal(r.values.out, "file.txt");
});

test("numeric-looking tokens end option parsing", () => {
  const r = parseArgs(["-3", "--verbose"], OPTS);
  assert.deepEqual(r.positionals, ["-3", "--verbose"]);
});

test("list options accumulate", () => {
  const r = parseArgs(["-t", "a,b", "--tag", "c"], OPTS);
  assert.deepEqual(r.values.tag, ["a", "b", "c"]);
});

test("stopAtPositional keeps the remainder", () => {
  const r = parseArgs(["run", "--verbose"], OPTS, { stopAtPositional: 1 });
  assert.deepEqual(r.positionals, ["run", "--verbose"]);
  assert.equal(r.values.verbose, false);
});
