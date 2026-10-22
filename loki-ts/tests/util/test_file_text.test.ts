import { expect, test } from "bun:test";
import { coveredStem, detectFromPackageJson, isTestFile, referencedBasenames } from "../../src/util/test_file_text.ts";
import type { RunnerName } from "../../src/engine10/types.ts";

test("isTestFile recognises js, py and go test names", () => {
  expect(isTestFile("a/b.test.ts")).toBe(true);
  expect(isTestFile("test_x.py")).toBe(true);
  expect(isTestFile("h_test.go")).toBe(true);
  expect(isTestFile("src/plain.ts")).toBe(false);
});

test("isTestFile recognises shell tests under tests/ and test-*.sh names, not other shell", () => {
  expect(isTestFile("tests/check-seal.sh")).toBe(true);
  expect(isTestFile("pkg/test/run.bash")).toBe(true);
  expect(isTestFile("scripts/test-gate.sh")).toBe(true);
  expect(isTestFile("scripts/release.sh")).toBe(false);
  expect(isTestFile("tests/fixtures/data.txt")).toBe(false);
});

test("coveredStem maps names to source stems", () => {
  expect(coveredStem("x/search.test.ts")).toBe("search");
  expect(coveredStem("test_ranker.py")).toBe("ranker");
  expect(coveredStem("handler_test.go")).toBe("handler");
});

test("referencedBasenames reads js and python imports", () => {
  const s = referencedBasenames(`const a = require("./lib/search.ts")\nfrom app.ranker import x\nimport pkg.mod`);
  expect([...s].sort()).toEqual(["mod", "ranker", "search"]);
});

test("detectFromPackageJson marks runners", () => {
  const got: Array<[RunnerName, string]> = [];
  detectFromPackageJson(JSON.stringify({ devDependencies: { vitest: "1" }, scripts: { test: "node --test" } }), "package.json", (r, f) => got.push([r, f]));
  expect(got.map((g) => g[0])).toEqual(["vitest", "node"]);
  const bad: string[] = [];
  detectFromPackageJson("{nope", "p", (r) => bad.push(r));
  expect(bad).toEqual([]);
});
