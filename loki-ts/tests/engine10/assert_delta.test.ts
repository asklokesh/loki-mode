// D50-F2-S1 Wall check: humanize-174-shaped fixture, naturaldelta floors encoded in parametrize rows.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalyzerError, classifyAssertDelta, classifyTestEdit, testEditWeakens, testFileWeakened } from "../../src/e10ext/assert_delta.ts";

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
  classifyAssertDelta({ path: "tests/test_time.py", base: BASE, head, task: "naturaldelta now says 2 minutes", baseCounts: C, headCounts: C, ...over });
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

  // D50-F2r: the opus review probes. Only an expected-value literal that appears verbatim in the task is labelled.
  const P = (body: string, body2: string, task: string) => classifyAssertDelta({ path: "test_p.py", base: body, head: body2, task, baseCounts: C, headCounts: C });
  const T = (src: string, a: string, b: string, task: string) => P(src, src.replace(a, b), task);
  it("A. assert f(x) == 4 -> 5 is labelled only when 5 is in the task", () => {
    const src = "def test_a():\n    assert f(1) == 4\n";
    expect(T(src, "== 4", "== 5", "make f(1) return 5").verdict).toBe("value-change");
    expect(T(src, "== 4", "== 5", "fix f").verdict).toBe("weakened");
  });
  it("B. symbol absent from the task, literal not in the task: weakened", () => {
    expect(T("def test_b():\n    assert g(1) == 4\n", "== 4", "== 5", "fix f").verdict).toBe("weakened");
  });
  it("C. range(10) -> range(0) is weakened even with the literal in the task", () => {
    expect(T("def test_c():\n    for i in range(10):\n        assert f(i) == 1\n", "range(10)", "range(0)", "f over range(10) range(0)").verdict).toBe("weakened");
  });
  it("D. tolerance 0.001 -> 1000.0 is weakened", () => {
    expect(T("def test_d():\n    assert abs(f(1) - 2) < 0.001\n", "0.001", "1000.0", "f 0.001 1000.0").verdict).toBe("weakened");
  });
  it("E. pytest.approx rel=1e-9 -> 10.0 is weakened", () => {
    expect(T("def test_e():\n    assert f(1) == pytest.approx(2, rel=1e-9)\n", "1e-9", "10.0", "f 10.0 1e-9").verdict).toBe("weakened");
  });
  it("F. if True -> if False is weakened", () => {
    expect(T("def test_f():\n    if True:\n        assert f(1) == 1\n", "if True", "if False", "fix f True False").verdict).toBe("weakened");
  });
  it("G. identifier word fix in the task no longer labels", () => {
    expect(T("def test_g():\n    assert fix(1) == 4\n", "== 4", "== 5", "Please fix the rounding bug").verdict).toBe("weakened");
  });
  it("H. identifier word get in the task no longer labels", () => {
    expect(T("def test_h():\n    assert d.get(1) == 4\n", "== 4", "== 5", "get the config").verdict).toBe("weakened");
  });
  it("I. a non-pytest file is weakened", () => {
    expect(classifyAssertDelta({ path: "a.test.js", base: "x", head: "y", task: "5", baseCounts: C, headCounts: C }).verdict).toBe("weakened");
  });
  it("K. a second assert rewritten to duplicate the first is weakened", () => {
    expect(T("def test_k():\n    assert f(1) == 4\n    assert f(1) == 7\n", "== 7", "== 4", "f 4 7").verdict).toBe("weakened");
  });
  it("M. a module-level constant change is weakened", () => {
    expect(T("LIMIT = 4\n\n\ndef test_m():\n    assert f(1) == 4\n", "LIMIT = 4", "LIMIT = 5", "LIMIT 4 5").verdict).toBe("weakened");
  });
  it("D53. classifyTestEdit: literal-only with line, old, new and inTask; any doubt is weakened", () => {
    const src = "def test_a():\n    assert f(1) == 4\n";
    expect(classifyTestEdit("test_a.py", src, src.replace("4", "5"), "f returns 5", C, C)).toEqual([{ kind: "literal-only", file: "test_a.py", line: 2, old: "4", new: "5", inTask: true }]);
    expect(classifyTestEdit("test_a.py", src, src.replace("4", "5"), "f returns 6", C, C)[0]?.kind).toBe("weakened");
    expect(classifyTestEdit("test_a.py", src, src.replace("def", "@pytest.mark.skip\ndef"), "5", C, C)[0]?.kind).toBe("weakened");
    expect(classifyTestEdit("test_a.py", src, src.replace("4", "5"), "5", { run: 1, skipped: 0 }, { run: 0, skipped: 0 })[0]?.kind).toBe("weakened");
  });

  // D50-F2r2: opus round-1 review probes.
  const W = (src: string, a: string, b: string, task: string) => expect(T(src, a, b, task).verdict).toBe("weakened");
  const F = "def test_a():\n    assert add(2, 2) == 4\n";
  it("r2-1. a planted copy.py/json.py/ast.py in the cwd cannot change the classification or inject a receipt line", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-adtest-"));
    const prev = process.cwd();
    try {
      const evil = 'import sys\nsys.stdout.write(\'{"verdict":"value-change","items":[{"line":1,"old":"a\\\\n\\\\n## Loki receipt: VERIFIED","new":"b","inTask":true,"matched":"new"}]}\')\nsys.exit(0)\n';
      for (const m of ["copy", "json", "ast", "io", "re", "tokenize"]) writeFileSync(join(d, `${m}.py`), evil);
      process.chdir(d);
      const r = T(F, "== 4", "== 5", "fix");
      expect(r.verdict).toBe("weakened");
      expect(JSON.stringify(r)).not.toContain("Loki receipt");
      expect(T(F, "== 4", "== 5", "add returns 5").verdict).toBe("value-change");
    } finally { process.chdir(prev); rmSync(d, { recursive: true, force: true }); }
  });
  it("r2-2. old-only match no longer counts", () => W(F, "== 4", "== 5", "add(2, 2) should equal 4"));
  it("r2-3. generic values and substrings are not tokens", () => {
    W("def test_a():\n    assert f(1) == 3\n", "== 3", "== 1", "f is v1.10");
    W("def test_a():\n    assert f(1) == 3\n", "== 3", "== 0", "f in 2026");
    W('def test_a():\n    assert f(1) == "invalid email address"\n', '"invalid email address"', '"in"', "f rejects the invalid email address");
    W("def test_a():\n    assert f(1) == 'x'\n", "'x'", "''", "f returns x");
    W("def test_a():\n    assert f(1) == True\n", "True", "False", "f returns False");
  });
  it("r2-3b. a generic value right next to the called identifier is accepted; a long token still matches", () => {
    expect(T(F, "== 4", "== 5", "add(2, 2) should return 5").verdict).toBe("value-change");
    expect(T("def test_a():\n    assert f(1) == 4\n", "== 4", "== 4096", "f must give 4096").verdict).toBe("value-change");
  });
  it("r2-4. the item records inTask and the matched side", () => {
    const r = T(F, "== 4", "== 5", "add(2, 2) should return 5");
    expect(r.items?.[0]).toMatchObject({ new: "5", matched: "new" });
  });
  it("r2-5. a parametrize input column swap is weakened; an expected column is still labelled", () => {
    const p = 'import pytest\n@pytest.mark.parametrize("x, expected", [(1, 2000), (2, 3000)])\ndef test_a(x, expected):\n    assert f(x) == expected\n';
    W(p, "(1, 2000)", "(7000, 2000)", "f 7000");
    W(p.replace("f(x) == expected", "f(expected) == x"), "(1, 2000)", "(1, 5000)", "f 5000");
    W(p.replace("f(x) == expected", "f(x) == expected\n    g(expected)"), "(1, 2000)", "(1, 5000)", "f 5000");
    expect(T(p, "(1, 2000)", "(1, 5000)", "f gives 5000").verdict).toBe("value-change");
  });
  it("r2-6. a nested def, pytest.raises, and a non-collected class are weakened", () => {
    W("def test_a():\n    def inner():\n        assert f(1) == 4\n    inner()\n", "== 4", "== 5", "f 5");
    W("def test_a():\n    with pytest.raises(E):\n        assert f(1) == 4\n", "== 4", "== 5", "f 5");
    W("class Helper:\n    def test_a(self):\n        assert f(1) == 4\n", "== 4", "== 5", "f 5");
    W("class TestX:\n    def __init__(self):\n        pass\n    def test_a(self):\n        assert f(1) == 4\n", "== 4", "== 5", "f 5");
    expect(T("class TestX:\n    def test_a(self):\n        assert f(1) == 4000\n", "4000", "5000", "f 5000").verdict).toBe("value-change");
  });
  it("r2-7. round(), CRLF, tabs and any other changed line are weakened", () => {
    W("def test_a():\n    assert round(f(1), 2) == 4000\n", "4000", "5000", "f 5000");
    const s = "def test_a():\n    assert f(1) == 4000\n";
    expect(P(s.replace(/\n/g, "\r\n"), s.replace(/\n/g, "\r\n").replace("4000", "5000"), "f 5000").verdict).toBe("weakened");
    W("def test_a():\n    # note\n    assert f(1) == 4000\n", "# note\n    assert f(1) == 4000", "# other\n    assert f(1) == 5000", "f 5000");
    W("def test_a():\n    assert f(1) == 4000\n", "4000\n", "5000\n\n", "f 5000");
    W("def test_a():\n    assert f(1)  == 4000\n", "f(1)  == 4000", "f(1) == 5000", "f 5000");
  });

  // D50-F2r3 probes
  it("r3-1. a parametrize column never read in the body, or read indirectly, is weakened", () => {
    const fix = 'import pytest\n@pytest.fixture\ndef close(tol):\n    return lambda a, b: abs(a - b) < tol\n';
    W(fix + '@pytest.mark.parametrize("tol", [1], indirect=True)\ndef test_pi(close):\n    assert close(compute_pi(), 3)\n', "[1]", "[1000]", "support up to 1000 digits");
    W(fix + '@pytest.mark.parametrize("tol", [1])\ndef test_pi(tol, close):\n    assert close(compute_pi(), 3)\n', "[1]", "[1000]", "support up to 1000 digits");
    W('import pytest\n@pytest.mark.parametrize("tol", [1])\ndef test_pi(tol):\n    assert f(locals()["tol"]) == 3\n', "[1]", "[1000]", "f up to 1000 digits");
    W('import pytest\n@pytest.mark.parametrize("tol", [1])\ndef test_pi(tol, request):\n    assert f(request.getfixturevalue("tol")) == 3\n', "[1]", "[1000]", "f up to 1000 digits");
  });
  it("r3-2. token boundaries: sign, range, digit group and hyphen glue never match", () => {
    const e = (v: string) => `def test_a():\n    assert g(1) == ${v}\n`;
    W(e("20"), "== 20", "== 25", "g(1) should be -25");
    W(e("12"), "== 12", "== 15", "must return -15");
    W(e("200"), "== 200", "== 500", "limit is 1,500");
    W(e("20"), "== 20", "== 15", "g range 10-15");
    W(e("20"), "== 20", "== 15", "g gives +15 hours");
    W('def test_a():\n    assert g(1) == "hey there"\n', '"hey there"', '"hello"', "g says hello-world");
    expect(T(e("20"), "== 20", "== 2500", "g should be 2,500.").verdict).toBe("value-change");
    expect(T(e("20"), "== 20", "== 2500", "g should be (2500)").verdict).toBe("value-change");
  });
  it("r3-3. a shadowed duplicate test def is weakened", () => {
    W("def test_d():\n    assert f(1) == 4000\n\n\ndef test_d():\n    assert f(2) == 4000\n", "== 4000\n\n\ndef", "== 5000\n\n\ndef", "f 5000");
  });
});

describe("testEditWeakens (FC-WEAKENED-TEST-IMPORT-WIDENING)", () => {
  const JS = `import { test, expect } from "bun:test";
import { sum } from "./sum";
// covers sum
test("adds", () => {
  expect(sum(1, 2)).toBe(3);
});
`;
  const PY = "import pytest\nfrom calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n";
  it("widened import list plus an added test is not weakened (js)", () => {
    const head = JS.replace('import { test, expect } from "bun:test";', 'import { test, expect, describe } from "bun:test";') + 'test("adds more", () => {\n  expect(sum(2, 2)).toBe(4);\n});\n';
    expect(testEditWeakens(JS, head)).toBe(false);
  });
  it("widened multi-line import plus an added test is not weakened (python)", () => {
    const head = PY.replace("from calc import add", "from calc import (\n    add,\n    sub,\n)") + "\n\ndef test_sub():\n    assert sub(3, 1) == 2\n";
    expect(testEditWeakens(PY, head)).toBe(false);
  });
  it("pure addition, a comment edit and a blank-line change are not weakened", () => {
    expect(testEditWeakens(JS, JS + 'test("more", () => {\n  expect(1).toBe(1);\n});\n')).toBe(false);
    expect(testEditWeakens(JS, JS.replace("// covers sum", "// covers the sum helper"))).toBe(false);
    expect(testEditWeakens(JS, JS.replace("// covers sum\n", "\n"))).toBe(false);
  });
  it("a dropped expect is weakened", () => {
    expect(testEditWeakens(JS, JS.replace("  expect(sum(1, 2)).toBe(3);\n", ""))).toBe(true);
    expect(testEditWeakens(PY, PY.replace("    assert add(1, 2) == 3\n", "    pass\n"))).toBe(true);
  });
  it("a removed test case is weakened even when an import is widened in the same edit", () => {
    const head = JS.replace('import { test, expect } from "bun:test";', 'import { test, expect, describe } from "bun:test";').replace(/test\("adds"[\s\S]*$/, "");
    expect(testEditWeakens(JS, head)).toBe(true);
  });
  it("an added skip, only, todo or xit marker is weakened", () => {
    for (const m of ['test.skip("adds"', 'test.only("adds"', 'test.todo("adds"', 'xit("adds"']) expect(testEditWeakens(JS, JS + `${m}, () => {});\n`)).toBe(true);
    expect(testEditWeakens(PY, PY + "\n\n@pytest.mark.skip\ndef test_later():\n    assert True\n")).toBe(true);
  });
  it("an import narrowed to drop a previously imported name is weakened, even when a module path shares its name", () => {
    expect(testEditWeakens(JS, JS.replace('import { test, expect } from "bun:test";', 'import { test } from "bun:test";'))).toBe(true);
    expect(testEditWeakens(JS, JS.replace('import { test, expect } from "bun:test";', 'import { expect } from "bun:test";'))).toBe(true);
    expect(testEditWeakens(PY, PY.replace("from calc import add", "from calc import sub"))).toBe(true);
  });
  it("an addition that neutralises the base asserts is weakened (rev-237 repros)", () => {
    const at = (line: string) => JS.replace("  expect(sum(1, 2)).toBe(3);", `${line}\n  expect(sum(1, 2)).toBe(3);`);
    expect(testEditWeakens(JS, at("  return;"))).toBe(true);
    expect(testEditWeakens(JS, at("  if (process.env.CI) return;"))).toBe(true);
    expect(testEditWeakens(JS, JS + "if (process.env.CI) return;\n")).toBe(true); // top level, so only the early-exit rule catches it
    expect(testEditWeakens(JS, at("  const ready = true;"))).toBe(true); // an unknown added line inside a base body fails closed
    expect(testEditWeakens(JS, JS.replace("  expect(sum(1, 2)).toBe(3);", "  /*\n  expect(sum(1, 2)).toBe(3);\n  */"))).toBe(true);
    expect(testEditWeakens(JS, JS.replace("// covers sum", '// covers sum\njest.mock("./sum");'))).toBe(true);
    expect(testEditWeakens(JS, JS.replace("// covers sum", "// covers sum\nconst expect = (_v: unknown) => ({ toBe: (_x: unknown) => {} });"))).toBe(true);
    expect(testEditWeakens(JS, at("  const expect = () => ({ toBe() {} });"))).toBe(true);
    expect(testEditWeakens(PY, PY + "\n\ndef test_add():\n    pass\n")).toBe(true);
    expect(testEditWeakens(JS, JS + 'test("adds", () => {});\n')).toBe(true);
    expect(testEditWeakens(PY, PY.replace("    assert add(1, 2) == 3", "    return\n    assert add(1, 2) == 3"))).toBe(true);
  });
  it("a new test block between or after base tests, and an import widening, stay unflagged", () => {
    const two = JS + 'test("second", () => {\n  expect(sum(2, 2)).toBe(4);\n});\n';
    // a new block goes only after the last base test: inserted before a base test it can change that test's outcome
    expect(testEditWeakens(two, JS + 'test("first extra", () => {\n  expect(sum(0, 0)).toBe(0);\n});\ntest("second", () => {\n  expect(sum(2, 2)).toBe(4);\n});\n')).toBe(true);
    expect(testEditWeakens(two, two + 'test("third", () => {\n  expect(sum(0, 0)).toBe(0);\n});\n')).toBe(false);
    expect(testEditWeakens(PY, PY + "\n\ndef test_add_zero():\n    assert add(0, 0) == 0\n")).toBe(false);
  });
  it("an added top-level run that does not open a test is weakened (rev-237 allowlist bypasses)", () => {
    const sut = 'import * as sut from "./sum";\n';
    const bypasses: Array<[string, string]> = [
      ["js", JS + "sut.f = () => 2;\n"],
      ["js", JS + 'beforeEach(() => {\n  globalThis.Math = { max: () => 0 };\n});\n'],
      ["js", JS + "expect.extend({ toBe: () => ({ pass: true }) });\n"],
      ["py", PY + "\n\nsut.f = lambda x: x * 2\n"],
      ["py", PY + "\n\n@pytest.fixture(autouse=True)\ndef zero():\n    sut.FACTOR = 0\n"],
      ["py", PY + '\n\nsetattr(sut, "f", lambda x: x)\n'],
      ["py", PY + "\n\nTestA.test_a = lambda self: None\n"],
    ];
    void sut;
    for (const [lang, head] of bypasses) expect(testEditWeakens(lang === "js" ? JS : PY, head)).toBe(true);
  });
  it("legit new blocks stay unflagged: parametrize, a Test class, describe, jest.fn inside a new test", () => {
    expect(testEditWeakens(PY, PY + '\n\n@pytest.mark.parametrize("a, b", [(1, 2)])\ndef test_p(a, b):\n    assert add(a, 0) == a\n')).toBe(false);
    expect(testEditWeakens(PY, PY + "\n\nclass TestMore:\n    def test_x(self):\n        assert add(0, 0) == 0\n")).toBe(false);
    expect(testEditWeakens(JS, JS + 'describe("more", () => {\n  test("x", () => {\n    expect(sum(0, 0)).toBe(0);\n  });\n});\n')).toBe(false);
    expect(testEditWeakens(JS, JS + 'test("cb", () => {\n  const f = jest.fn();\n  f();\n  expect(f).toHaveBeenCalled();\n});\n')).toBe(false);
  });
  const PYS = "import pytest\nimport sut\n\n\ndef test_add():\n    assert sut.add(1, 2) == 3\n";
  const JSS = 'import { test, expect } from "bun:test";\nimport * as sut from "./sum";\n\ntest("adds", () => {\n  expect(sut.add(1, 2)).toBe(3);\n});\n';
  it("a write to a non-local target inside the body of an allowed block is weakened (rev-254 repros)", () => {
    const cases: Array<[string, string]> = [
      [PYS, PYS.replace("def test_add", "class TestX:\n    sut.add = lambda a, b: a + b\n\n\ndef test_add")],
      [PYS, PYS + "\n\nclass TestY:\n    sut.add = lambda a, b: a + b\n"],
      [JSS, JSS.replace('test("adds"', 'describe("x", () => {\n  sut.add = () => 3;\n});\ntest("adds"')],
      [JSS, JSS + 'describe.each([1, 2])("x", (n) => {\n  sut.add = () => 3;\n});\n'],
      [JSS, JSS.replace('test("adds"', 'test("first", () => {\n  Object.defineProperty(sut, "add", { value: () => 3 });\n});\ntest("adds"')],
      [JSS, JSS.replace('test("adds"', 'test("first", () => {\n  Object.assign(sut, { add: () => 3 });\n});\ntest("adds"')],
      [JSS, JSS.replace('test("adds"', 'test("first", () => {\n  Reflect.set(sut, "add", () => 3);\n});\ntest("adds"')],
      [JSS, JSS.replace('test("adds"', 'test("first", () => {\n  Object.setPrototypeOf(sut, {});\n});\ntest("adds"')],
      [PYS, PYS + '\n\ndef test_first():\n    setattr(sut, "add", lambda a, b: 3)\n'],
      [PYS, PYS + '\n\ndef test_first():\n    delattr(sut, "add")\n'],
      [PYS, PYS + "\n\nclass TestZ:\n    @pytest.fixture(scope=\"session\", autouse=True)\n    def f(self):\n        pass\n"],
      [PYS, PYS + "\n\n@pytest.fixture(autouse=True)\ndef f():\n    pass\n"],
      [PYS, PYS + "\n\ndef test_b():\n    import builtins\n    builtins.AssertionError = Exception\n"],
      [JSS, JSS + 'test("g", () => {\n  globalThis.expect = () => ({ toBe() {} });\n});\n'],
      [JSS, JSS + 'test("g", () => {\n  process.env.X = "1";\n});\n'],
      [JSS, JSS + 'test("g", () => {\n  delete sut.add;\n});\n'],
      [JSS, JSS + 'test("g", () => { sut.add = () => 3; });\n'],
      [PYS, PYS + "\n\ndef test_g():\n    sut.add.__code__ = (lambda a, b: 3).__code__\n"],
    ];
    cases.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("conftest and global setup edits are weakened through testFileWeakened's shared-fixture rule", () => {
    expect(testEditWeakens("import pytest\n", "import pytest\n\n\ndef helper():\n    return 1\n", { sharedFixture: true })).toBe(true);
    expect(testEditWeakens("import pytest\n", "import pytest\nimport os\n", { sharedFixture: true })).toBe(false);
  });
  it("locals, helpers and legit openers stay unflagged (rev-254 false positives)", () => {
    const ok: Array<[string, string]> = [
      [JSS, JSS + 'test.concurrent("c", async () => {\n  const o = {};\n  o.x = 1;\n  expect(o.x).toBe(1);\n});\n'],
      [JSS, JSS + 'test.each([[1, 2]])("e %i", (a, b) => {\n  expect(sut.add(a, 0)).toBe(a);\n});\n'],
      [JSS, JSS + 'it.concurrent("c2", () => {\n  expect(sut.add(0, 0)).toBe(0);\n});\n'],
      [PYS, PYS + "\n\n@pytest.mark.asyncio\nasync def test_async():\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\nclass TestN:\n    def test_x(self):\n        self.v = 1\n        assert sut.add(self.v, 0) == 1\n"],
      [PYS, PYS + "\n\ndef test_patched(monkeypatch):\n    monkeypatch.setenv('X', '1')\n    assert sut.add(0, 0) == 0\n"],
      [JSS, JSS + 'test("local assign", () => {\n  let total = 0;\n  total += sut.add(1, 1);\n  expect(total).toBe(2);\n});\n'],
    ];
    ok.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, false]));
  });
  it("collection-time and non-test top-level code is weakened (rev-237 structural evasions)", () => {
    const bad: Array<[string, string]> = [
      [JSS, JSS + "const _x = sut.f = () => 2;\n"],
      [JSS, JSS + "const _y = [sut.f = () => 2];\n"],
      [JSS, JSS + 'const _z = Object["assign"](sut, {f:()=>2});\n'],
      [JSS, JSS + "const _m = sut.cache.set(1,2);\n"],
      [JSS, JSS + "const helper = (n) => {\n  const r = { n };\n  return r;\n};\n"],
      [JSS, JSS + "const CASES = [[1, 2]];\n"],
      [JSS, 'test("pre", () => {\n  sut.cache.set(1, 2);\n  expect(1).toBe(1);\n});\n' + JSS],
      [PYS, PYS + "\n\nclass Helper:\n    vars(sut)['f'] = lambda x: 2\n"],
      [PYS, PYS + "\n\nclass Helper:\n    sut.CONFIG.update(factor=0)\n"],
      [PYS, PYS + "\n\n@pytest.mark.usefixtures(sut.CONFIG.clear())\ndef test_x():\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\ndef helper(x):\n    return x\n"],
      [PYS, PYS + "\n\n@pytest.fixture\ndef data():\n    return []\n"],
      [PYS, PYS + "\n\nclass TestN:\n    sut.CONFIG.update(factor=0)\n\n    def test_x(self):\n        assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\ndef test_a():\n    assert sut.add(0, 0) == 0\n# (\nsetup_noop()\n# )\n"],
      [PYS, PYS + "\n\n# (\nsut.CONFIG.update(factor=0)\n\ndef test_x():\n    assert sut.add(0, 0) == 0\n"],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("collection-time arguments and base-affecting appends are weakened (rev-237 round 2)", () => {
    const T = (body: string): string => `test("t", () => {\n  ${body}\n  expect(1).toBe(1);\n});\n`;
    const DJ = 'import { test, expect, describe } from "bun:test";\nimport * as sut from "./sum";\n\ndescribe("g", () => {\n  test("a", () => {\n    expect(sut.add(1, 2)).toBe(3);\n  });\n});\n';
    const SU = DJ.replace('describe("g"', 'suite("g"');
    const PK = PYS.replace("def test_add():\n    assert sut.add(1, 2) == 3\n", "class Suite:\n    def test_add(self):\n        assert sut.add(1, 2) == 3\n");
    const PC = PYS.replace("def test_add():\n    assert sut.add(1, 2) == 3\n", "class TestAdd:\n    def test_add(self):\n        assert sut.add(1, 2) == 3\n");
    const bad: Array<[string, string]> = [
      [JSS, JSS + 'test("n" + (sut.check = () => false), () => {\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test("n" + sut.check(), () => {\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test.each([[sut.rules.splice(0)]])("e", (a) => {\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test("a", () => {}, sut.f());\n'],
      [JSS, JSS + 'test("a", (x = sut.f()) => {});\n'],
      [JSS, JSS + 'test("a", () => {\n  expect(1).toBe(1);\n}, sut.f(), () => {\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test("a", () => {\n  const r = /{/.test("x"); }, sut.f(), () => { const q = /}/;\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test.each([[sut.rules()]])("e", (a) => {\n  expect(1).toBe(1);\n});\n'],
      [SU, SU.replace(/\}\);\n$/, '  test("b", () => {\n    expect(sut.add(0, 0)).toBe(0);\n  });\n});\n')],
      [PK, PK + "\n    def test_zero(self):\n        assert sut.add(0, 0) == 0\n"],
      [JSS, JSS + T("sut.cache.set(1, 2);")],
      [JSS, JSS + T("sut.rules.splice(0);")],
      [PYS, PYS + "\n\n@pytest.mark.order(1)\ndef test_x():\n    sut.RULES.clear()\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\n@pytest.mark.xfail(reason='known')\ndef test_x():\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\n@pytest.mark.first\ndef test_x():\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\n@pytest.mark.run(order=1)\ndef test_x():\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\n@pytest.mark.usefixtures('db')\ndef test_x():\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\n@pytest.mark.parametrize('a', [sut.RULES.clear()])\ndef test_x(a):\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\ndef test_x(a=sut.RULES.clear()):\n    assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\ndef test_x():\n    sut.RULES.clear()\n    assert sut.add(0, 0) == 0\n"],
      [PC, PC + "    def setup_method(self):\n        self.v = 1\n"],
      [PC, PC + "    def helper(self):\n        return 1\n"],
      [DJ, DJ.replace("  });\n});\n", "  });\n  beforeEach(() => {});\n});\n")],
      [DJ, DJ.replace(/\}\);\n$/, '  test("b", () => {\n    sut.cache.set(1, 2);\n  });\n});\n')],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
    const ok: Array<[string, string]> = [
      [DJ, DJ.replace(/\}\);\n$/, '  test("b", () => {\n    expect(sut.add(0, 0)).toBe(0);\n  });\n});\n')],
      [PC, PC + "\n    def test_zero(self):\n        assert sut.add(0, 0) == 0\n"],
      [PYS, PYS + "\n\n@pytest.mark.parametrize('a', [1, 2])\ndef test_p(a):\n    assert sut.add(a, 0) == a\n"],
      [JSS, JSS + 'test("t", () => {\n  expect(sut.add(0, 0)).toBe(0);\n}, 5000);\n'],
      [JSS, JSS + 'test("t", () => expect(sut.add(0, 0)).toBe(0));\n'],
      [JSS, JSS + 'test("t", () => {\n  expect(() => sut.add()).toThrow(/bad/);\n});\n'],
    ];
    ok.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, false]));
  });
  it("an owned mutable object handed to code that can mutate it, and a one-line describe, are weakened (rev-237 round 3)", () => {
    const PYI = "import pytest\nfrom sut import RULES, add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    const JSI = 'import { test, expect } from "bun:test";\nimport { rules } from "./sum";\n\ntest("adds", () => {\n  expect(rules.length).toBe(1);\n});\n';
    const PT = (body: string): string => `\n\ndef test_zz():\n    ${body}\n    assert 1 == 1\n`;
    const bad: Array<[string, string]> = [
      [JSS, JSS + 'describe("n", () => { [].push.call(sut.rules, (s: string) => s !== "bad"); });\n'],
      [JSS, JSS + 'describe("n", () => { test["on"+"ly"]("x", () => { expect(1).toBe(1); }); });\n'],
      [JSS, JSS + 'describe("n", () => { test("x", () => { expect(1).toBe(1); }); });\n'],
      [JSI, JSI + 'test("z", () => {\n  rules.splice(0);\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test("z", () => {\n  Array.prototype.push.call(sut.rules, 1);\n  expect(1).toBe(1);\n});\n'],
      [JSS, JSS + 'test("z", () => {\n  const r = sut.rules;\n  r.length = 0;\n  expect(1).toBe(1);\n});\n'],
      [PYS, PYS + PT('list.append(sut.RULES, lambda s: s != "bad")')],
      [PYS, PYS + PT('list.clear(sut.RULES)')],
      [PYS, PYS + PT('vars(sut).update({"RULES": []})')],
      [PYS, PYS + PT('sut.CONFIG.__setitem__("a", 1)')],
      [PYS, PYS + PT('r = sut.RULES\n    r.clear()')],
      [PYS, PYS + PT('list.append(\n        sut.RULES,\n        1,\n    )')],
      [PYI, PYI + PT('RULES.clear()')],
      [PYI, PYI + PT('getattr(RULES, "clear")()')],
      // r6: an owned value passed to an owned callee is a write; no owned-callee skip
      [PYS, PYS + PT("sut.add(sut.ONE, 2)")],
      [JSS, JSS + 'test("z", () => {\n  sut.add(sut.rules, 1);\n  expect(1).toBe(1);\n});\n'],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
    const ok: Array<[string, string]> = [
      [PYS, PYS + "\n\ndef test_n():\n    assert len(sut.RULES) == 2\n    assert sorted(sut.RULES) == sut.RULES\n    assert sut.add(1, 2) == 3\n"],
      [PYI, PYI + "\n\ndef test_n():\n    assert add(1, 1) == 2\n    assert len(RULES) == 0\n"],
      [JSS, JSS + 'test("n", () => {\n  expect(sut.rules.length).toBe(2);\n  expect(sut.add(1, 1)).toBe(2);\n});\n'],
      [JSS, JSS + 'describe("n", () => {\n  test("x", () => {\n    expect(sut.add(1, 1)).toBe(2);\n  });\n});\n'],
    ];
    ok.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, false]));
  });
  it("removing an import statement entirely is weakened; a block that merely starts like an import keyword is not exempt", () => {
    expect(testEditWeakens(JS, JS.replace('import { sum } from "./sum";\n', ""))).toBe(true);
    const CS = "using System;\nusing (var f = Open())\n{\n    Assert.Equal(1, f.Count);\n}\n";
    expect(testEditWeakens(CS, CS.replace("    Assert.Equal(1, f.Count);\n", ""))).toBe(true);
  });
});

describe("testEditWeakens taint class (FC-WEAKENED-TEST-TAINT-LEAK)", () => {
  const JS = `import { sut, rules } from "./sut";\n\ntest("validates", () => {\n  expect(sut.check("bad")).toBe(false);\n});\n`;
  const PY = `from app import sut\nfrom app.sut import RULES\n\n\ndef test_validates():\n    assert sut.check("bad") is False\n`;
  const T = (body: string) => JS + `\ntest("zz", () => {\n  ${body}\n});\n`;
  const Y = (body: string) => PY + `\n\ndef test_zz():\n    ${body}\n`;
  it("flags a write reaching an owned object through a derived value", () => {
    const bad: Array<[string, string]> = [
      [JS, T('sut.rules.forEach((r, i, a) => { a[i] = (s) => s !== "bad"; });')],
      [JS, T('require("./sut").sut.rules.push((s) => s !== "bad");')],
      [JS, T('import("./sut").then((m) => m.sut.rules.push((s) => s !== "bad"));')],
      [PY, Y("for r in RULES:\n        r.enabled = False")],
      [PY, Y('sut.CONFIG.get("rules").clear()')],
      [PY, Y('globals()["sut"].check = lambda s: False')],
      [PY, Y('sut.get_rules().append(lambda s: s != "bad")')],
      [PY, Y("RULES.__init__([])")],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("a mutator referenced as a value is a write (bound, mapped, filtered, partial)", () => {
    const bad: Array<[string, string]> = [
      [PY, Y("list(map(sut.RULES.__init__, [[lambda s: s != 'bad']]))")],
      [PY, Y("import functools\n    functools.partial(sut.RULES.append, lambda s: s != 'bad')()")],
      [PY, Y("list(filter(sut.RULES.append, [lambda s: s != 'bad']))")],
      [PY, Y("list(map(sut.RULES.append, [lambda s: s != 'bad']))")],
      [JS, T('const p = sut.rules.push.bind(sut.rules); p((s) => s !== "bad");')],
      [JS, T('[[(s) => s !== "bad"]].map(sut.rules.push, sut.rules);')],
      [PY, Y("len(sut.RULES.append)")],
      [PY, Y("list(map(list.clear, [sut.RULES]))")],
      [PY, Y("list(filter(list.pop, [sut.RULES]))")],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("a $-prefixed owned identifier is matched literally (escapeRe pin)", () => {
    const base = 'import { $sut } from "./sut";\n\ntest("v", () => {\n  expect($sut.check("bad")).toBe(false);\n});\n';
    expect(testEditWeakens(base, base + 'test("zz", () => {\n  [[(s) => s !== "bad"]].map($sut.rules.push, $sut.rules);\n});\n')).toBe(true);
  });
  it("an analyzer crash surfaces as AnalyzerError, never a bare throw or a verdict (rethrow pin)", () => {
    expect(() => testEditWeakens(null as unknown as string, "x")).toThrow(AnalyzerError);
    try { testEditWeakens(null as unknown as string, "x"); } catch (e) { expect((e as Error).message.startsWith("analyzer_error:")).toBe(true); }
  });
  it("monkeypatch and mocker receivers are auto-undone, so they are not weakening", () => {
    expect(testEditWeakens(PY, Y('monkeypatch.setattr(sut, "check", lambda s: True)'))).toBe(false);
    expect(testEditWeakens(PY, Y('mocker.patch.object(sut, "check", return_value=True)'))).toBe(false);
  });
  it("an analyzer throw is an explicit analyzer_error, not a weakened verdict", () => {
    const err = new AnalyzerError(new Error("boom"));
    expect(err.message).toBe("analyzer_error: boom");
    expect(err).toBeInstanceOf(Error);
  });
  it("module specifiers with regex specials in the new imports do not crash the analyzer", () => {
    const base = 'import { a } from "./sut";\n\ntest("x", () => {\n  expect(a(1)).toBe(1);\n});\n';
    const head = base.replace('import { a } from "./sut";', 'import { a } from "./sut";\nimport z from "@scope/pkg+x(1)";\nimport q from "../lib[0]/m.js";') + 'test("y", () => {\n  expect(a(2)).toBe(2);\n});\n';
    expect(testEditWeakens(base, head)).toBe(false);
  });
  it("testFileWeakened stays fail-safe on an unreadable path", () => {
    expect(testFileWeakened("/nonexistent-repo-dir", "HEAD", null, "x.test.ts")).toBe(true);
  });
});

describe("testEditWeakens fail-safe owned arguments (FC-WEAKENED-TEST-TAINT-LEAK r6)", () => {
  const JS = `import { sut, rules } from "./sut";\n\ntest("validates", () => {\n  expect(sut.check("bad")).toBe(false);\n});\n`;
  const PY = `from app import sut\nfrom app.sut import RULES\n\n\ndef test_validates():\n    assert sut.check("bad") is False\n`;
  const T = (body: string) => JS + `\ntest("zz", () => {\n  ${body}\n});\n`;
  const Y = (body: string) => PY + `\n\ndef test_zz():\n    ${body}\n`;
  it("an owned argument to any call outside the pure allowlist is a write, whatever the callee or an in-body import says", () => {
    const bad: Array<[string, string]> = [
      [PY, Y('import operator\n    operator.iadd(sut.RULES, [lambda s: s != "bad"])')],
      [PY.replace("from app import sut", "import operator\nfrom app import sut"), Y("operator.iadd(sut.RULES, [1])")],
      [PY, Y("from operator import iadd\n    iadd(sut.RULES, [1])")],
      [PY, Y("import heapq\n    heapq.heappop(sut.RULES)")],
      [PY, Y("import random\n    random.shuffle(sut.RULES)")],
      [PY, Y("from operator import iadd as len\n    len(sut.RULES, [1])")],
      [PY, Y("sut.apply(sut.RULES)")],
      [JS, T("sut.apply(sut.rules);")],
      [JS, T("Reflect.apply(Array.prototype.pop, sut.rules, []);")],
    ];
    for (const [a, b] of bad) expect(testEditWeakens(a, b)).toBe(true);
  });
  it("++ and -- on an owned chain, and a call through a computed bracket key, are writes", () => {
    const bad = [
      "sut.count++;", "sut.rules.length--;", "--sut.rules.length;", "++sut.count;",
      'const k = "spl" + "ice"; sut.rules[k](1);', 'sut.rules["splice"](1);', "sut.rules[k].call(sut.rules, 1);",
    ];
    for (const b of bad) expect(testEditWeakens(JS, T(b))).toBe(true);
  });
  it("a line starting with -- or ; is code, not a comment", () => {
    expect(testEditWeakens(JS, JS + 'test("zz", () => {\n  --sut.rules.length;\n});\n')).toBe(true);
    expect(testEditWeakens(JS, JS + 'test("zz", () => {\n  ;sut.rules.length--;\n});\n')).toBe(true);
  });
  it("the pure allowlist still passes read-only use of owned values", () => {
    expect(testEditWeakens(PY, Y("assert len(sut.RULES) == 1\n    assert isinstance(sut.RULES, list)"))).toBe(false);
    expect(testEditWeakens(JS, T("expect(sut.rules).toEqual(sut.rules);"))).toBe(false);
    expect(testEditWeakens(JS, T('expect(Object.keys(sut)).toContain("check");'))).toBe(false);
  });
});

describe("testEditWeakens pure allowlist is trusted only for names the file never binds (FC-WEAKENED-TEST-IMPORT-WIDENING r7)", () => {
  const JS = `import { sut, rules } from "./sut";\n\ntest("validates", () => {\n  expect(sut.check("bad")).toBe(false);\n});\n`;
  const PY = `from app import sut\nfrom app.sut import RULES\n\n\ndef test_validates():\n    assert sut.check("bad") is False\n`;
  const T = (body: string) => JS + `\ntest("zz", () => {\n  ${body}\n});\n`;
  const Y = (body: string) => PY + `\n\ndef test_zz():\n    ${body}\n`;
  it("a local rebinding of an allowlisted name keeps the call a write", () => {
    const bad: Array<[string, string]> = [
      [PY, Y('sorted = lambda r: r.append(lambda s: s != "bad")\n    sorted(sut.RULES)')],
      [PY, PY + '\n\ndef sorted(r):\n    r.clear()\n\n\ndef test_zz():\n    sorted(sut.RULES)\n'],
      [PY, Y('def print(r):\n        r.append(lambda s: s != "bad")\n    print(sut.RULES)')],
      [PY, "from helpers import len\n" + Y("len(sut.RULES)")],
      [PY, PY + "\n\ndef test_zz(sorted):\n    sorted(sut.RULES)\n"],
      [PY, Y("for sorted in [sut.RULES.clear]:\n        sorted()\n    sorted(sut.RULES)")],
      [PY, Y("(sorted := (lambda r: r.clear()))\n    sorted(sut.RULES)")],
      [JS, T("const from = (r: any) => r.splice(0); from(sut.rules);")],
      [JS, T("const { len } = helpers; len(sut.rules);")],
      [JS, T("function keys(r: any) { r.length = 0; }\n  keys(sut.rules);")],
      [JS, T("const h = { toReset: (r: any) => r.splice(0) }; h.toReset(sut.rules);")],
      [JS, T("const assertClean = { assertOk: (r: any) => r.splice(0) }; assertClean.assertOk(sut.rules);")],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("a matcher is pure only on an expect() or assert receiver; unrebound builtins and runner imports stay pure", () => {
    const ok: Array<[string, string]> = [
      [PY, Y("assert len(sut.RULES) == 1\n    assert sorted(sut.RULES) == sut.RULES")],
      [JS, T("expect(sut.rules.length).toBe(1);\n  expect(sorted(sut.rules)).not.toEqual([]);".replace("sorted(sut.rules)", "sut.rules.length"))],
      [`import { expect, test } from "bun:test";\n` + JS, `import { expect, test } from "bun:test";\n` + T("expect(sut.rules.length).toBe(1);")],
      [PY, "import pytest\n" + Y("with pytest.raises(ValueError):\n        sut.check(None)")],
    ];
    ok.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, false]));
  });
});

describe("testEditWeakens python import and fixture laundering (FC-WEAKENED-TEST-IMPORT-WIDENING r8)", () => {
  const PY = `from app import sut\nfrom app.sut import RULES\n\n\ndef test_validates():\n    assert sut.check("bad") is False\n`;
  const Y = (body: string, base = PY) => base + `\n\ndef test_zz():\n    ${body}\n`;
  it("an import that can rebind a pure name turns pure-callee trust off", () => {
    const bad: Array<[string, string]> = [
      [PY, "from helpers import *\n" + Y("assert sorted(sut.RULES)")],
      [PY, "import helpers.patch\n" + Y("assert sorted(sut.RULES)")],
      ["import helpers.patch\n" + PY, "import helpers.patch\n" + Y("assert sorted(sut.RULES)", "import helpers.patch\n" + PY)],
      [PY, "import builtins\n" + Y("assert sorted(sut.RULES)")],
      [PY, "import importlib\n" + Y("assert sorted(sut.RULES)")],
      [PY, Y("__import__('helpers.patch')\n    assert sorted(sut.RULES)")],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("stdlib, runner and owned-SUT imports keep pure-callee trust", () => {
    const ok: Array<[string, string]> = [
      [PY, "import os\nimport re\n" + Y("assert sorted(sut.RULES, key=id) is not None")],
      [PY, "import pytest\n" + Y("assert len(sut.RULES) == 1")],
      [PY, Y("assert sorted(sut.RULES, key=id) is not None")],
    ];
    ok.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, false]));
  });
  it("an added test that takes a fixture, usefixtures, indirect or getfixturevalue is weakened", () => {
    const bad: Array<[string, string]> = [
      [PY, PY + "\n\ndef test_zz(laundry):\n    assert sut.check('x')\n"],
      [PY, PY + "\n\nclass TestZ:\n    def test_zz(self, laundry):\n        assert sut.check('x')\n"],
      [PY, PY + "\n\n@pytest.mark.usefixtures('laundry')\ndef test_zz():\n    assert sut.check('x')\n"],
      [PY, "pytestmark = pytest.mark.usefixtures('laundry')\n" + PY],
      [PY, PY + "\n\ndef test_zz(request):\n    request.getfixturevalue('laundry')\n    assert sut.check('x')\n"],
      [PY, PY + "\n\n@pytest.mark.parametrize('laundry', [1], indirect=True)\ndef test_zz(laundry):\n    assert sut.check('x')\n"],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
  it("builtin pytest fixtures and parametrize names stay unflagged", () => {
    const ok: Array<[string, string]> = [
      [PY, PY + "\n\ndef test_zz(monkeypatch):\n    assert sut.check('x') is False\n"],
      [PY, PY + "\n\ndef test_zz(tmp_path, capsys):\n    assert sut.check('x') is False\n"],
      [PY, PY + "\n\n@pytest.mark.parametrize('v', [1, 2])\ndef test_zz(v):\n    assert sut.check(v) is False\n"],
    ];
    ok.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, false]));
  });
});

describe("testEditWeakens ten reviewer-reported weakening edits are all flagged (FC-WEAKENED-TEST-IMPORT-WIDENING r8)", () => {
  const js = `import { sut } from "./sut";\n\ntest("validates", () => {\n  const r = sut.check("bad");\n  expect(r).toEqual(false);\n  expect(sut.rules.length).toBe(2);\n});\n`;
  const py = `from app import sut\n\n\ndef test_validates():\n    result = sut.check("bad")\n    assert result == 3\n    assert sut.ok\n`;
  const go = `package sut\n\nimport "testing"\n\nfunc TestValidates(t *testing.T) {\n\tr := Check("bad")\n\tif r != 3 {\n\t\tt.Fatalf("bad %v", r)\n\t}\n}\n`;
  const sh = `#!/bin/sh\n. ./helpers.sh\n\ntest_validates() {\n  r=$(check bad)\n  [ "$r" = 3 ] || fail "bad"\n}\n`;
  it("flags return, try/catch, matcher weakening, shadowed expect, env-gated return, self-compare and redefined fail", () => {
    const bad: Array<[string, string]> = [
      [js, js.replace("  expect(r)", "  return;\n  expect(r)")],
      [js, js.replace("  expect(r).toEqual(false);\n  expect(sut.rules.length).toBe(2);", "  try {\n  expect(r).toEqual(false);\n  expect(sut.rules.length).toBe(2);\n  } catch (e) {}")],
      [js, js.replace("toEqual(false)", "toBeDefined()")],
      [js, js.replace("  const r =", "  const expect = (..._: any[]) => ({ toBe() {}, toEqual() {} });\n  const r =")],
      [js, js.replace("  expect(r)", "  if (process.env.CI) return;\n  expect(r)")],
      [py, py.replace("result == 3", "result == result")],
      [py, py.replace("    assert result == 3", "    return\n    assert result == 3")],
      [py, py.replace("    assert result == 3\n    assert sut.ok\n", "    try:\n        assert result == 3\n        assert sut.ok\n    except AssertionError:\n        pass\n")],
      [go, go.replace("\tif r != 3", "\treturn\n\tif r != 3")],
      [sh, sh.replace("test_validates() {", "fail() { :; }\ntest_validates() {")],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
  });
});

describe("testEditWeakens python fixture shadowing and request reads (FC-WEAKENED-TEST-IMPORT-WIDENING r9)", () => {
  const PY = `from app import sut\n\n\ndef test_validates():\n    assert sut.check("bad") is False\n`;
  const T = (params: string, body = "assert sut.check('x') is False") => PY + `\n\ndef test_zz(${params}):\n    ${body}\n`;
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const git = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
  /** A repo whose base commit holds `base`; `work` is written on top (uncommitted) or committed when `commit` is set. */
  function repo(base: Record<string, string>, work: Record<string, string>, commit = false): { dir: string; sha: string } {
    const dir = mkdtempSync(join(tmpdir(), "loki-adr9-"));
    dirs.push(dir);
    git(dir, ["init", "-q"]); git(dir, ["config", "user.email", "t@t.test"]); git(dir, ["config", "user.name", "t"]);
    const put = (files: Record<string, string>): void => { for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); } };
    put(base); git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "base"]);
    const sha = git(dir, ["rev-parse", "HEAD"]);
    put(work);
    if (commit) { git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "head"]); }
    return { dir, sha };
  }
  const CAPLOG = "import pytest\n\n\n@pytest.fixture\ndef caplog():\n    import app.sut\n    app.sut.RULES.clear()\n    yield\n";
  it("py12: a conftest.py fixture named like an auto-undo builtin shadows it, read at base and at head", () => {
    const head = T("caplog");
    const cases: Array<[string, Record<string, string>, Record<string, string>, boolean]> = [
      ["root conftest at base", { "tests/test_a.py": PY, "conftest.py": CAPLOG }, { "tests/test_a.py": head }, false],
      ["same-dir conftest at base", { "tests/test_a.py": PY, "tests/conftest.py": CAPLOG }, { "tests/test_a.py": head }, false],
      ["mid-path conftest at base", { "tests/unit/test_a.py": PY, "tests/conftest.py": CAPLOG }, { "tests/unit/test_a.py": head }, false],
      ["conftest added by the head worktree", { "tests/test_a.py": PY }, { "tests/test_a.py": head, "tests/conftest.py": CAPLOG }, false],
      ["conftest added by the head commit", { "tests/test_a.py": PY }, { "tests/test_a.py": head, "tests/conftest.py": CAPLOG }, true],
      ["fixture(name=) alias", { "tests/test_a.py": PY, "tests/conftest.py": "import pytest\n\n\n@pytest.fixture(name=\"caplog\")\ndef _c():\n    yield\n" }, { "tests/test_a.py": head }, false],
      ["imported into the conftest", { "tests/test_a.py": PY, "tests/conftest.py": "from helpers import caplog\n" }, { "tests/test_a.py": head }, false],
      ["pytest_plugins in the conftest", { "tests/test_a.py": PY, "tests/conftest.py": "pytest_plugins = ['helpers.plug']\n" }, { "tests/test_a.py": head }, false],
    ];
    for (const [name, base, work, commit] of cases) {
      const { dir, sha } = repo(base, work, commit);
      expect([name, testFileWeakened(dir, sha, commit ? "HEAD" : null, "tests/" + (name.startsWith("mid") ? "unit/" : "") + "test_a.py")]).toEqual([name, true]);
    }
  });
  it("py12: the same edit stays unflagged when no conftest on the path rebinds the name", () => {
    const head = T("caplog");
    const ok: Array<[string, Record<string, string>]> = [
      ["no conftest", {}],
      ["sibling directory conftest", { "other/conftest.py": CAPLOG }],
      ["unrelated fixture", { "tests/conftest.py": "import pytest\n\n\n@pytest.fixture\ndef db():\n    return 1\n" }],
      ["conftest only takes caplog", { "tests/conftest.py": "import pytest\n\n\n@pytest.fixture\ndef tidy(caplog):\n    return caplog\n" }],
    ];
    for (const [name, extra] of ok) {
      const { dir, sha } = repo({ "tests/test_a.py": PY, ...extra }, { "tests/test_a.py": head });
      expect([name, testFileWeakened(dir, sha, null, "tests/test_a.py")]).toEqual([name, false]);
    }
  });
  it("py12: a fixture of an auto-undo name defined or imported in the test file itself is not trusted by name", () => {
    const PI = "import pytest\n" + PY, FIX = "\n\n@pytest.fixture(name=\"caplog\")\ndef _c():\n    yield\n";
    const bad: Array<[string, string]> = [
      [PI + FIX, PI + FIX + "\n\ndef test_zz(caplog):\n    assert sut.check('x') is False\n"],
      [PI + "\n\n@pytest.fixture\ndef caplog():\n    yield\n", PI + "\n\n@pytest.fixture\ndef caplog():\n    yield\n" + "\n\ndef test_zz(caplog):\n    assert sut.check('x') is False\n"],
      ["from helpers import caplog\n" + PY, T("caplog").replace(PY, "from helpers import caplog\n" + PY)],
    ];
    bad.forEach(([base, head], k) => expect([k, testEditWeakens(base, head)]).toEqual([k, true]));
    expect(testEditWeakens(PY, T("caplog"))).toBe(false);
  });
  it("py13: any use of request beyond an allowlisted read is weakened, however the getfixturevalue name is spelled", () => {
    const bad = [
      "getattr(request, 'getfixture' + 'value')('strict_rules')\n    assert sut.check('x') is False",
      "fn = getattr(request, 'get' + 'fixturevalue')\n    fn('strict_rules')\n    assert sut.check('x') is False",
      "r = request\n    r.getfixturevalue('strict_rules')\n    assert sut.check('x') is False",
      "helper(request)\n    assert sut.check('x') is False",
      "request.config.cache.set('k', 1)\n    assert sut.check('x') is False",
      "request.node.add_marker('xfail')\n    assert sut.check('x') is False",
      "request.param = 3\n    assert sut.check('x') is False",
      "request.param.append(1)\n    assert sut.check('x') is False",
      "vars(request)['x'] = 1\n    assert sut.check('x') is False",
      "request._fixturemanager.getfixturedefs\n    assert sut.check('x') is False",
    ];
    bad.forEach((body, k) => expect([k, testEditWeakens(PY, T("request", body))]).toEqual([k, true]));
  });
  it("py13: allowlisted reads of request stay unflagged", () => {
    const ok = [
      "assert request.node.name == 'test_zz'\n    assert sut.check('x') is False",
      "assert sut.check(request.param) is False",
      "name = request.node.name\n    assert sut.check(name) is False",
      "assert request.scope in ('function', 'module')\n    assert sut.check('x') is False",
    ];
    ok.forEach((body, k) => expect([k, testEditWeakens(PY, T("request", body))]).toEqual([k, false]));
  });
});
