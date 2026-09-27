// loki-ts/tests/engine10/failures.test.ts
//
// E-17 wall check (docs/v10/ENGINE.md section 16): pytest, vitest and jest
// output groups into at most 5 signatures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupFailures, parseFailures } from "../../src/engine10/failures.ts";

const FIX = join(import.meta.dir, "fixtures", "failures");
const read = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("parseFailures", () => {
  test("pytest: extracts testId and reason from the short summary", () => {
    const failures = parseFailures("pytest", read("pytest.txt"));
    expect(failures).toHaveLength(8);
    expect(failures[0]).toEqual({
      testId: "tests/test_a.py::test_one",
      reason: "AssertionError: expected 1 to equal 2",
    });
  });

  test("vitest: extracts the FAIL header and the error line under it", () => {
    const failures = parseFailures("vitest", read("vitest.txt"));
    expect(failures).toHaveLength(3);
    expect(failures[0]).toEqual({
      testId: "src/a.test.ts > suite > test one",
      reason: "AssertionError: expected 1 to be 2",
    });
    expect(failures[2]!.reason).toBe("Error: boom");
  });

  test("jest: extracts the bullet header and the assertion line under it", () => {
    const failures = parseFailures("jest", read("jest.txt"));
    expect(failures).toHaveLength(3);
    expect(failures[0]).toEqual({
      testId: "suite - test one",
      reason: "expect(received).toBe(expected)",
    });
    expect(failures[2]!.reason).toBe("TypeError: cannot read property 'x' of undefined");
  });

  test("a runner with no parser (go) yields no failures, never a throw", () => {
    expect(parseFailures("go", "--- FAIL: TestFoo\n")).toEqual([]);
  });
});

describe("groupFailures", () => {
  test("caps pytest's 6 distinct signatures at 5, largest groups first", () => {
    const groups = groupFailures([{ runner: "pytest", output: read("pytest.txt") }]);
    expect(groups).toHaveLength(5);
    // Two signatures repeat (AssertionError, KeyError) after number/quote
    // normalization collapses the two instances of each into one group.
    expect(groups[0]).toMatchObject({ count: 2, signature: "AssertionError: expected # to equal #" });
    expect(groups[1]).toMatchObject({ count: 2, signature: "KeyError: <val>" });
    for (const g of groups.slice(2)) expect(g.count).toBe(1);
    // The 6th distinct (count-1) signature, IndexError, is the one dropped.
    expect(groups.some((g) => g.signature.includes("IndexError"))).toBe(false);
  });

  test("vitest groups the two numeric AssertionErrors and keeps Error: boom separate", () => {
    const groups = groupFailures([{ runner: "vitest", output: read("vitest.txt") }]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ count: 2, sample: "AssertionError: expected 1 to be 2" });
    expect(groups[1]).toMatchObject({ count: 1, signature: "Error: boom" });
  });

  test("jest groups the two identical expect() reasons and keeps the TypeError separate", () => {
    const groups = groupFailures([{ runner: "jest", output: read("jest.txt") }]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ count: 2, signature: "expect(received).toBe(expected)" });
    expect(groups[1]!.signature).toContain("TypeError: cannot read property");
  });

  test("mixed runners in one call are merged into one grouped list", () => {
    const groups = groupFailures([
      { runner: "vitest", output: read("vitest.txt") },
      { runner: "jest", output: read("jest.txt") },
    ]);
    const total = groups.reduce((n, g) => n + g.count, 0);
    expect(total).toBe(6); // 3 vitest + 3 jest failures
    expect(groups.length).toBeLessThanOrEqual(5);
  });

  test("no failures at all groups to an empty list", () => {
    expect(groupFailures([])).toEqual([]);
  });
});
