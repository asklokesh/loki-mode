// D50-F2-S1 Wall check: humanize-174-shaped fixture, naturaldelta floors encoded in parametrize rows.
import { describe, expect, it } from "bun:test";
import { classifyAssertDelta } from "../../src/e10ext/assert_delta.ts";

const BASE = `import pytest
from humanize import naturaldelta, naturalsize


@pytest.mark.parametrize("seconds, expected", [
    (59, "59 seconds"),
    (60, "a minute"),
    (119, "a minute"),
    (120, "2 minutes"),
])
def test_naturaldelta(seconds, expected):
    assert naturaldelta(seconds) == expected


def test_naturalsize():
    assert naturalsize(1000) == "1.0 kB"
    assert naturalsize(1) == "1 Byte"
`;
const C = { run: 5, skipped: 0 };
const run = (head: string, over: Partial<Parameters<typeof classifyAssertDelta>[0]> = {}) =>
  classifyAssertDelta({ path: "tests/test_time.py", base: BASE, head, names: ["naturaldelta"], baseCounts: C, headCounts: C, ...over });
const swap = (a: string, b: string) => BASE.replace(a, b);

describe("assert_delta classifier", () => {
  it("1. literal swap in a test calling the named symbol is a value-change with its line", () => {
    const r = run(swap('(119, "a minute")', '(119, "2 minutes")'));
    expect(r.verdict).toBe("value-change");
    expect(r.changes).toEqual(["tests/test_time.py:8 'a minute' -> '2 minutes'"]);
  });
  it("2. deleting a parametrize row is weakened", () => {
    expect(run(swap('    (119, "a minute"),\n', "")).verdict).toBe("weakened");
  });
  it("3. replacing an assert with assert True is weakened", () => {
    expect(run(swap("assert naturaldelta(seconds) == expected", "assert True")).verdict).toBe("weakened");
  });
  it("4. adding a skip marker is weakened", () => {
    expect(run(swap("def test_naturaldelta", "@pytest.mark.skip\ndef test_naturaldelta")).verdict).toBe("weakened");
  });
  it("5. literal change in a test that does not call the named symbol is weakened", () => {
    expect(run(swap('"1.0 kB"', '"2.0 kB"')).verdict).toBe("weakened");
  });
  it("6a. appending or True is weakened", () => {
    expect(run(swap("== expected", "== expected or True")).verdict).toBe("weakened");
  });
  it("6b. x == x is weakened", () => {
    expect(run(swap("naturaldelta(seconds) == expected", "expected == expected")).verdict).toBe("weakened");
  });
  it("6c. a type change (str to int) is weakened", () => {
    expect(run(swap('(60, "a minute")', "(60, 1)")).verdict).toBe("weakened");
  });
  it("run or skip count not exactly equal to base is weakened", () => {
    const h = swap('(119, "a minute")', '(119, "2 minutes")');
    expect(run(h, { headCounts: { run: 6, skipped: 0 } }).verdict).toBe("weakened");
    expect(run(h, { headCounts: { run: 5, skipped: 1 } }).verdict).toBe("weakened");
  });
  it("non-pytest file and parse failure are weakened", () => {
    const h = swap('(119, "a minute")', '(119, "2 minutes")');
    expect(run(h, { path: "src/humanize/time.py" }).verdict).toBe("weakened");
    expect(run("def test_x(:\n").verdict).toBe("weakened");
  });
});
