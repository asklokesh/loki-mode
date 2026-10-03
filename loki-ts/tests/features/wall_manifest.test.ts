// D77 / W1-S1: the Wall manifest is signatures only, never bodies, never a named module import.
import { describe, expect, test } from "bun:test";
import { buildWallManifest, MANIFEST_MAX_LINES, type ManifestFile } from "../../src/features/wall_manifest.ts";

const CANARY = "BODY_CANARY_7f3a";

const TS_SRC = `import { x } from "./x";
export interface Opts { a: number; b?: string }
export type Mode = "fast" | "slow";
export const LIMIT = 5;
export const run = async (opts: Opts, n: number): Promise<string> => {
  const v = "${CANARY}_arrow";
  return v;
};
export function add(
  a: number,
  b: number,
): number {
  const s = "${CANARY}_fn { } }";
  return a + b;
}
export const table = { go() { return "${CANARY}_obj"; } };
export class Box<T> {
  private secret = "${CANARY}_prop";
  constructor(public item: T) { this.item = item; }
  get(key: string): T { return "${CANARY}_method" as never; }
  private hidden(): void { /* ${CANARY}_hidden */ }
}
export { a, b } from "./ab";
function notExported() { return "${CANARY}_internal"; }
`;

const PY_SRC = `import os
LIMIT = 5

@decorator
def add(a: int,
        b: int = 2) -> int:
    """doc ${CANARY}_doc"""
    return "${CANARY}_py"

async def fetch(url: str) -> str:
    return "${CANARY}_async"

def _private():
    return "${CANARY}_private"

class Box:
    """${CANARY}_cdoc"""
    def __init__(self, item):
        self.item = "${CANARY}_init"

    def get(self, key: str) -> str:
        return "${CANARY}_get"

    def _hidden(self):
        return "${CANARY}_h"
`;

const TS_TEST = (name: string, imp: string) => `import { test, expect } from "bun:test";
${imp}
test("${name}", () => { expect(1).toBe(1); });
`;

function fixture(): ManifestFile[] {
  return [
    { path: "package.json", content: JSON.stringify({ scripts: { test: "bun test" }, secret: CANARY }) },
    { path: "src/mod.ts", content: TS_SRC },
    { path: "pkg/mod.py", content: PY_SRC },
    { path: "pytest.ini", content: "[pytest]\ntestpaths = tests\n" },
    { path: "tests/mod.test.ts", content: TS_TEST("named", 'import { add } from "../src/mod.ts";') },
    { path: "tests/other.test.ts", content: TS_TEST("other", 'import { z } from "../src/other.ts";') },
    { path: "tests/third.test.ts", content: TS_TEST("third", "") },
    { path: "tests/test_mod.py", content: "from pkg.mod import add\n\ndef test_a():\n    assert add(1, 2) == 3\n" },
    { path: "tests/test_util.py", content: "import os\n\ndef test_u():\n    assert os\n" },
  ];
}

const MODULES = ["src/mod.ts", "pkg/mod.py"];

describe("buildWallManifest (D77)", () => {
  test("every exported TypeScript signature is present", () => {
    const out = buildWallManifest(fixture(), MODULES);
    for (const sig of [
      "export interface Opts { a: number; b?: string }",
      'export type Mode = "fast" | "slow";',
      "export const LIMIT",
      "export const run = async (opts: Opts, n: number): Promise<string> =>",
      "export function add(\n  a: number,\n  b: number,\n): number",
      "export const table",
      "export class Box<T>",
      "constructor(public item: T)",
      "get(key: string): T",
      'export { a, b } from "./ab";',
    ]) expect(out).toContain(sig);
    expect(out).not.toContain("notExported");
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("secret");
  });

  test("every public Python signature is present", () => {
    const out = buildWallManifest(fixture(), MODULES);
    for (const sig of ["LIMIT = ...", "@decorator", "def add(a: int, b: int = ...) -> int:", "async def fetch(url: str) -> str:", "class Box:", "    def __init__(self, item):", "    def get(self, key: str) -> str:"]) {
      expect(out).toContain(sig);
    }
    expect(out).not.toContain("_private");
    expect(out).not.toContain("_hidden");
  });

  test("the body canary never appears, in TS or Python", () => {
    expect(buildWallManifest(fixture(), MODULES)).not.toContain("BODY_CANARY");
  });

  test("a module the task does not name contributes no signatures", () => {
    const out = buildWallManifest(fixture(), ["src/mod.ts"]);
    expect(out).toContain("export function add(");
    expect(out).not.toContain("def add");
  });

  test("detects the runner and its config, without leaking unrelated package.json content", () => {
    const out = buildWallManifest(fixture(), MODULES);
    expect(out).toMatch(/runner: bun test/);
    expect(out).toContain("pytest.ini");
    expect(out).toContain("testpaths = tests");
    expect(out).toContain("tests/test_util.py");
  });

  test("style examples never import a named module and number at most two", () => {
    const out = buildWallManifest(fixture(), MODULES);
    const ex = out.slice(out.indexOf("## style examples"));
    expect(ex).not.toContain("../src/mod.ts");
    expect(ex).not.toContain("from pkg.mod");
    expect(ex).not.toContain("tests/mod.test.ts");
    expect(ex).not.toContain("tests/test_mod.py");
    expect((ex.match(/^--- example: /gm) ?? []).length).toBe(2);
  });

  test("no example is offered when every test file imports a named module", () => {
    const files = fixture().filter((f) => !/other|third|util/.test(f.path));
    const out = buildWallManifest(files, MODULES);
    expect(out).not.toContain("--- example:");
  });

  test("output is capped at 400 lines and truncated deterministically", () => {
    const big = Array.from({ length: 600 }, (_, i) => `export function f${i}(a: number): number { return a; }`).join("\n");
    const files = [...fixture(), { path: "src/big.ts", content: big }];
    const out = buildWallManifest(files, [...MODULES, "src/big.ts"]);
    const lines = out.split("\n");
    expect(MANIFEST_MAX_LINES).toBe(400);
    expect(lines.length).toBeLessThanOrEqual(400);
    expect(lines[lines.length - 1]).toMatch(/^\.\.\. truncated: \d+ lines omitted$/);
    expect(buildWallManifest(files, [...MODULES, "src/big.ts"])).toBe(out);
  });

  test("byte-identical for the same tree regardless of file or module order", () => {
    const a = buildWallManifest(fixture(), MODULES);
    const b = buildWallManifest([...fixture()].reverse(), [...MODULES].reverse());
    expect(b).toBe(a);
  });

  test("pure: does not mutate its inputs", () => {
    const files = fixture();
    const copy = JSON.stringify(files);
    buildWallManifest(files, MODULES);
    expect(JSON.stringify(files)).toBe(copy);
  });

  test("CRLF sources produce the same manifest as LF sources", () => {
    const crlf = fixture().map((f) => ({ ...f, content: f.content.replace(/\n/g, "\r\n") }));
    expect(buildWallManifest(crlf, MODULES)).toBe(buildWallManifest(fixture(), MODULES));
  });

  test("a statement without a trailing semicolon cannot smuggle the next body", () => {
    const src = `export const a = 1\nexport function f(): void {\n  "${CANARY}"\n}\n`;
    const out = buildWallManifest([{ path: "m.ts", content: src }], ["m.ts"]);
    expect(out).toContain("export function f(): void");
    expect(out).not.toContain("BODY_CANARY");
  });

  test("one-line Python bodies and TS expression arrows leak nothing", () => {
    const py = `def f(a): return "${CANARY}"\nclass K: x = "${CANARY}"\n`;
    const ts = `export const g = (a: number): string => "${CANARY}";\n`;
    const out = buildWallManifest([{ path: "m.py", content: py }, { path: "m.ts", content: ts }], ["m.py", "m.ts"]);
    expect(out).toContain("def f(a):");
    expect(out).toContain("export const g = (a: number): string =>");
    expect(out).not.toContain("BODY_CANARY");
  });
});

const ts = (content: string, path = "m.ts"): string => buildWallManifest([{ path, content }], [path]);
const MARKERS = /LEAK_/;

describe("round 2 review findings (B1-B7)", () => {
  test("B1: export default arrow expression bodies are cut", () => {
    const out = ts("export default (x: number) => x * LEAK_1;\n");
    expect(out).toContain("export default (x: number) =>");
    expect(out).not.toMatch(MARKERS);
    const obj = ts("export default () => ({ k: LEAK_12 });\n");
    expect(obj).toContain("export default () =>");
    expect(obj).not.toMatch(MARKERS);
  });

  test("B2: no-semicolon export-from, star and type alias do not pull in the next line", () => {
    for (const src of [
      'export { a } from "./a"\nfunction helper() { return "LEAK_3" }',
      'export * from "./a"\nfunction helper() { return "LEAK_4" }',
      'export type T = Base & { a: 1 }\nfunction helper() { return "LEAK_a" }',
      'export type ID = string\nconst secret = "LEAK_5"',
    ]) expect(ts(src)).not.toMatch(MARKERS);
    expect(ts('export { a } from "./a"\nfunction h() {}')).toContain('export { a } from "./a"');
    expect(ts("export type ID = string\nconst s = 1")).toContain("export type ID = string");
    expect(ts("export type U =\n  | A\n  | B\nconst s = 1")).toContain("| B");
  });

  test("B3: brace desync inside a class emits no body fragments", () => {
    for (const body of [
      "foo(): { a: number } { return { a: LEAK_6 }; }",
      'm() { const r = /\\}/; return "LEAK_7"; }',
      "m(c) { return `a${c ? `}` : ''}b` + 'LEAK_10'; }",
    ]) expect(ts(`export class K {\n  ${body}\n  ok(): void {}\n}\n`)).not.toMatch(MARKERS);
    expect(ts("export class K {\n  foo(): { a: number } { return 1; }\n}\n")).toContain("foo(): { a: number }");
    expect(ts('export class K {\n  m() { return "}" ; }\n  ok(): void {}\n}\n')).toContain("ok(): void");
    expect(ts('export class K {\n  m() { return "LEAK_u"; \n')).not.toMatch(MARKERS);
  });

  test("B4: >= with no space before an initializer is cut", () => {
    expect(ts("export class K {\n  x: Array<number>= [LEAK_8];\n}\n")).not.toMatch(MARKERS);
    const out = ts("export const x: Record<string, number>= mk(LEAK_9);\n");
    expect(out).not.toMatch(MARKERS);
    expect(out).toContain("export const x: Record<string, number>");
  });

  test("B5: Python header brackets inside strings are ignored", () => {
    const a = ts('def f(x="("):\n    return "LEAK_p1"\n\ndef g():\n    pass\n', "m.py");
    expect(a).not.toMatch(MARKERS);
    expect(a).toContain("def g():");
    expect(a).toContain('def f(x=...):');
    const b = ts('def f(sep=")"):\n    return "LEAK_p2"\n', "m.py");
    expect(b).not.toMatch(MARKERS);
    expect(b).toContain("def f(sep=...):");
  });

  test("B6: style examples never import a named module in any form", () => {
    const base = [{ path: "src/calc.ts", content: "export const a = 1;" }, { path: "pkg/calc.py", content: "X = 1\n" }];
    const cases: [string, string][] = [
      ["tests/a_dyn.test.ts", 'test("a", async () => { await import("../src/calc"); });'],
      ["tests/b_req.test.ts", 'const c = require("../src/calc");'],
      ["tests/test_b.py", "from pkg import calc\n"],
      ["tests/test_c.py", "import pkg.calc as c\n"],
      ["tests/test_d.py", "from pkg import (\n    other,\n    calc,\n)\n"],
      ["tests/test_e.py", "from pkg import other, calc as c\n"],
    ];
    for (const [path, content] of cases) {
      const out = buildWallManifest([...base, { path, content }], ["src/calc.ts", "pkg/calc.py"]);
      expect(out.slice(out.indexOf("## style examples"))).not.toContain(`--- example: ${path}`);
    }
    const ok = buildWallManifest([...base, { path: "tests/test_ok.py", content: "from pkg import other\n" }], ["pkg/calc.py"]);
    expect(ok).toContain("--- example: tests/test_ok.py");
  });

  test("B7: a pathological arrow head finishes in linear time", () => {
    const t0 = performance.now();
    const out = ts(`export const f = (a): ${" ".repeat(50000)}x;\n`);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out).toContain("export const f");
    const arrow = ts("export const g = async <T,>(a: T): Promise<T> => a;\n");
    expect(arrow).toContain("export const g = async <T,>(a: T): Promise<T> =>");
  });

  test("no output line carries a LEAK_ marker across every repro", () => {
    const src = [
      "export default (x: number) => x * LEAK_1;",
      'export { a } from "./a"\nfunction helper() { return "LEAK_3" }',
      "export type ID = string\nconst secret = \"LEAK_5\"",
      "export class K {\n  foo(): { a: number } { return { a: LEAK_6 }; }\n  x: Array<number>= [LEAK_8];\n}",
      "export const y: Record<string, number>= mk(LEAK_9);",
    ].join("\n");
    for (const line of ts(src).split("\n")) expect(line).not.toMatch(MARKERS);
  });

  test("A5/A6: duplicate paths sort by content; multi-declarator exports keep every name", () => {
    const a = { path: "m.ts", content: "export const a = 1;" };
    const b = { path: "m.ts", content: "export const b = 2;" };
    expect(buildWallManifest([a, b], ["m.ts"])).toBe(buildWallManifest([b, a], ["m.ts"]));
    const out = ts("export let a = 1, b = 2;\n");
    expect(out).toContain("export let a, b");
    expect(out).not.toMatch(/= [12]/);
  });
});

const SECRETS = /LEAK_|SECRET|TOKEN_SECRET/;
const R3_INPUTS: [string, string][] = [
  ["m.tsx", "export class V {\n  render() { return <div><p>{a} / {b} {c && <b>ok</b>}</p></div>; }\n  track() { analytics.track(SECRET_EVENT_KEY); }\n}\n"],
  ["m.tsx", "export class V {\n  render() { return <p>{a} isn't {b && <i>it's</i>}</p>; sendToken(TOKEN_SECRET); }\n}\n"],
  ["m.ts", "export class K {\n  m() { let y = i++ / 2; if (y) { /* c */ } SECRET_DIV(); return 1 }\n  ok(): void {}\n}\n"],
  ["m.ts", "export class K {\n  render() { return 1 }\n  analytics.track(SECRET_EVENT_KEY);\n  ok(): void {}\n}\n"],
  ["m.ts", "export class K {\n  doIt() { return 1 }\n  track(SECRET_CALL);\n}\n"],
  ["m.py", 'def quote(sep="\\""):\n    return "SECRET_P1"\n\ndef after():\n    pass\n'],
  ["m.py", 'def quote(sep=r"\\""):\n    return "SECRET_P2"\n'],
  ["m.py", 'def m(s="""a:\nb"""):\n    return "SECRET_P3"\n'],
  ["m.py", 'def broken(a, b\n    return "SECRET_P4"\n'],
  ["m.ts", "export function h<T = () => void>(cb: T, n: number): Promise<T> { return SECRET_H(); }\n"],
];

describe("round 3 review findings", () => {
  test("B1: } and postfix ++ never start a regex; JSX text and division leak nothing", () => {
    for (const [p, src] of R3_INPUTS.slice(0, 3)) expect(ts(src, p)).not.toMatch(SECRETS);
    expect(ts(R3_INPUTS[2]![1], "m.ts")).not.toContain("export class K");
  });

  test("B1: a lexer desync that slips through is caught by the member grammar", () => {
    const out = ts(R3_INPUTS[3]![1], "m.ts");
    expect(out).not.toMatch(SECRETS);
    expect(out).toContain("export class K {");
    expect(ts(R3_INPUTS[4]![1], "m.ts")).not.toMatch(SECRETS);
  });

  test("fail closed: tsx and jsx emit no class members, only the head", () => {
    const out = ts("export class V {\n  render(): void { return 1 }\n}\nexport function f(a: number): number { return a }\n", "m.tsx");
    expect(out).toContain("export class V {");
    expect(out).not.toContain("render");
    expect(out).toContain("export function f(a: number): number");
  });

  test("fail closed: one non-signature member drops every member of the class", () => {
    const out = ts("export class K {\n  a(): void {}\n  b(): void {}\n  foo.bar(1);\n}\n");
    expect(out).toContain("export class K {");
    expect(out).not.toContain("a(): void");
  });

  test("a well-formed class keeps its members, including plain property initializers", () => {
    const out = ts("export class K {\n  static readonly n = 1;\n  async go<T>(x: T): Promise<T> { return x }\n  get v(): number { return 1 }\n  #p = 1;\n  [Symbol.iterator](): void {}\n}\n");
    for (const m of ["static readonly n", "async go<T>(x: T): Promise<T>", "get v(): number"]) expect(out).toContain(m);
  });

  test("B2: Python escaped quotes, raw quotes and triple-quoted defaults", () => {
    const a = ts(R3_INPUTS[5]![1], "m.py");
    expect(a).not.toMatch(SECRETS);
    expect(a).toContain("def quote(sep=...):");
    expect(a).toContain("def after():");
    expect(ts(R3_INPUTS[6]![1], "m.py")).not.toMatch(SECRETS);
    const t = ts(R3_INPUTS[7]![1], "m.py");
    expect(t).not.toMatch(SECRETS);
    expect(t).toContain("def m(s=...):");
  });

  test("B2: an unclosed Python header emits nothing", () => {
    const out = ts(R3_INPUTS[8]![1], "m.py");
    expect(out).not.toMatch(SECRETS);
    expect(out).not.toContain("def broken");
  });

  test("B3: generic defaults containing => keep the whole signature", () => {
    const out = ts("export function h<T = () => void>(cb: T, n: number): Promise<T> { return SECRET_H(); }\nexport class K {\n  m<T = (a: number) => string>(x: T): T { return x }\n}\n");
    expect(out).toContain("export function h<T = () => void>(cb: T, n: number): Promise<T>");
    expect(out).toContain("m<T = (a: number) => string>(x: T): T");
    expect(out).not.toMatch(SECRETS);
  });

  test("advisories: export type { T } from keeps its from clause; backslash and template imports count", () => {
    expect(ts('export type { T } from "./t"\nconst z = 1\n')).toContain('export type { T } from "./t"');
    const base = [{ path: "pkg/widget.py", content: "X = 1\n" }, { path: "src/widget.ts", content: "export const a = 1;" }];
    const cases: [string, string][] = [
      ["tests/test_bs.py", "from pkg import other, \\\n    widget\n"],
      ["tests/tpl.test.ts", "await import(`../src/widget`);"],
    ];
    for (const [path, content] of cases) {
      const out = buildWallManifest([...base, { path, content }], ["pkg/widget.py", "src/widget.ts"]);
      expect(out.slice(out.indexOf("## style examples"))).not.toContain(`--- example: ${path}`);
    }
  });

  test("a deeply nested template does not throw", () => {
    const src = "export const a = 1;\nexport const b = " + "`${".repeat(20000) + "1" + "}`".repeat(20000) + ";\n";
    expect(() => ts(src)).not.toThrow();
  });

  test("every SECRET and LEAK input from both reviews leaks nothing", () => {
    for (const [p, src] of R3_INPUTS) expect(ts(src, p)).not.toMatch(SECRETS);
  });
});

const X_INPUTS: [string, string][] = [
  ["m.ts", 'export function f(a: string) {\n  if (a) /}`/.test(a);\n  const t = `\nexport function leaked(k = "SECRET_DESYNC_1") {}\nexport interface Creds { pw: "SECRET_DESYNC_2" }\n`;\n  return t;\n}'],
  ["m.ts", 'export function f(a: string) {\n  if (a) { a = a.trim(); }\n  /}`/.test(a);\n  const t = `\nexport type Leak = "SECRET_DESYNC_3";\n`;\n  return t;\n}'],
  ["m.tsx", "export function C() {\n  return <p>Press ` to open</p>;\n}\nexport const a = `\n}\nexport function leaked(pw = \"SECRET_JSX2\") {}\n`;\nexport const b = `x`;"],
  ["m.py", "DELIM = '\"\"\"'\ndef f():\n    pass\nTEMPLATE = \"\"\"\ndef leaked(pw=\"SECRET_PY_1\"):\nclass Leaked(SECRET_PY_2):\n\"\"\""],
  ["m.py", "def f():\n    x = \"'''\"\n    return 1\nDOC = '''\ndef leaked2(token=\"SECRET_PY_3\"):\n'''"],
  ["m.py", "class A:\n    s = '\"\"\"'\n    def m(self):\n        pass\nT = \"\"\"\n    def leaked3(self, k=\"SECRET_PY_4\"):\n\"\"\""],
];

describe("round 4 review findings (X1-X6) and fail-closed extraction", () => {
  test("X1-X6: string-content desync leaks nothing", () => {
    for (const [p, src] of X_INPUTS) expect(ts(src, p)).not.toMatch(SECRETS);
  });

  test("Python signatures come from the AST: defaults masked, classes and decorators kept", () => {
    const out = ts("@dec(SECRET_ARG)\ndef f(a: int, b: str = 'SECRET_D', *args, k=1, **kw) -> int:\n    return 1\n\nclass B(Base, metaclass=M):\n    def m(self, x=SECRET_E): pass\n    def _p(self): pass\nLIMIT = 5\n", "m.py");
    expect(out).not.toMatch(SECRETS);
    for (const s of ["@dec(...)", "def f(a: int, b: str = ..., *args, k=..., **kw) -> int:", "class B(Base, metaclass=M):", "    def m(self, x=...):", "LIMIT = ..."]) expect(out).toContain(s);
    expect(out).not.toContain("_p");
  });

  test("a Python file that does not parse emits nothing", () => {
    const out = ts('def ok():\n    pass\ndef bad(:\n    return "SECRET_BAD"\n', "m.py");
    expect(out).not.toContain("def ok");
    expect(out).not.toMatch(SECRETS);
  });

  test("TS: a file with an undecidable slash or any tsx backtick is omitted whole", () => {
    expect(ts("export function a(): number { return 1 }\nexport const r = (x: number) => x / 2;\n")).not.toContain("export function a");
    expect(ts("export function a(): number { return 1 }\nconst s = `x`;\n", "m.tsx")).not.toContain("export function a");
    expect(ts("export function a(): number { return 1 }\nconst s = `x`;\n")).toContain("export function a");
    expect(ts("export function a(): number { return 1 }\nconst s = \"unterminated;\n")).not.toContain("export function a");
    expect(ts("export function a(): number { return 1 }\nfunction g() {\n")).not.toContain("export function a");
  });

  test("A1: parameter defaults are masked and enum members keep names only", () => {
    const out = ts('export function f(k = "SECRET_K", o: { a?: string } = { a: "SECRET_O" }, n: number = 5): void {}\nexport enum E { A = "SECRET_A", B, C = 1 << 2 }\nexport class K {\n  m(x = "SECRET_M"): void {}\n}\n');
    expect(out).not.toMatch(SECRETS);
    expect(out).toContain("export function f(k = ..., o: { a?: string } = ..., n: number = ...): void");
    expect(out).toContain("export enum E { A, B, C }");
    expect(out).toContain("m(x = ...): void");
  });

  test("every X input is in the all-inputs regression", () => {
    for (const [p, src] of [...R3_INPUTS, ...X_INPUTS]) expect(ts(src, p)).not.toMatch(SECRETS);
  });
});

const R5_INPUTS: [string, string][] = [
  ["m.ts", "export function f() {}\nconst r = /* c */ /}`/;\nconst t = `\nexport function leaked(k = \"SECRET_B1a\") {}\n`;\n"],
  ["m.ts", "export function f() {}\nconst r = // c\n  /}`/;\nconst t = `\nexport function leaked(k = \"SECRET_B1b\") {}\n`;\n"],
  ["m.ts", 'export function f(a: Array<string>= ["SECRET_B2a"], m: Map<string, Set<number>>= mk("SECRET_B2b")): void {}\nexport class K {\n  m(a: Array<string>= ["SECRET_B2c"]): void {}\n}\n'],
  ["m.ts", 'export class S {\n  constructor(@Inject("SECRET_B3a") private c: Cfg) {}\n  @HostListener("SECRET_B3b") on(): void {}\n}\n'],
  ["m.ts", 'export @Component({ selector: "SECRET_B3c" }) class C { m(): void {} }\n'],
  ["m.ts", 'export class D extends mixin(Base, "SECRET_B3d") { m(): void {} }\n'],
  ["m.py", '@app.route("SECRET_B4a")\ndef f(): pass\n@d["SECRET_B4b"]\ndef g(): pass\n@d("x")("SECRET_B4c")\ndef h(): pass\n@(lambda f: f("SECRET_B4d"))\ndef i(): pass\n@pkg.mod\ndef j(): pass\n'],
  ["m.py", 'def f(a: Annotated[int, "SECRET_B5a"], b: "SECRET_B5b", c: Literal["ok"], d: foo("SECRET_B5c") = 1) -> Annotated[str, make("SECRET_B5d")]:\n    pass\nclass K(make("SECRET_B5e"), Base[int]): pass\n'],
  ["m.ts", "export interface I {\n  // SECRET_A1a\n  a: number; /* SECRET_A1b */\n}\nexport enum E {\n  A, // SECRET_A1c\n  /* SECRET_A1d */ B,\n}\n"],
];

describe("round 5 review findings", () => {
  test("every round-5 input leaks no SECRET marker", () => {
    for (const [p, src] of R5_INPUTS) expect(ts(src, p)).not.toMatch(SECRETS);
  });

  test("B1: a comment before a slash makes the file ambiguous", () => {
    expect(ts(R5_INPUTS[0]![1])).not.toContain("export function f");
    expect(ts(R5_INPUTS[1]![1])).not.toContain("export function f");
  });

  test("B2: >= defaults are masked", () => {
    const out = ts(R5_INPUTS[2]![1]);
    expect(out).toContain("a: Array<string> = ...");
    expect(out).toContain("m: Map<string, Set<number>> = ...");
    expect(out).toContain("m(a: Array<string> = ...): void");
  });

  test("B3: decorator arguments and non-trivial extends clauses are dropped", () => {
    const a = ts(R5_INPUTS[3]![1]);
    expect(a).toContain("@Inject(...) private c: Cfg");
    expect(a).toContain("@HostListener(...) on(): void");
    expect(ts(R5_INPUTS[4]![1])).toContain("@Component(...)");
    expect(ts(R5_INPUTS[5]![1])).toContain("extends ...");
    expect(ts("export class E extends Base<T> implements I { m(): void {} }\n")).toContain("extends Base<T> implements I");
    expect(ts("@Bare\nexport class Z { @Input x: number; }\n")).not.toMatch(SECRETS);
  });

  test("B4: Python decorators keep only dotted names", () => {
    const out = ts(R5_INPUTS[6]![1], "m.py");
    for (const d of ["@app.route(...)", "@...", "@pkg.mod"]) expect(out).toContain(d);
  });

  test("B5: Python annotations are whitelisted; calls and metadata become ...", () => {
    const out = ts(R5_INPUTS[7]![1], "m.py");
    expect(out).toContain('def f(a: Annotated[int, ...], b: ..., c: Literal[\'ok\'], d: ... = ...) -> Annotated[str, ...]:');
    expect(out).toContain("class K(..., Base[int]):");
    expect(ts("def g(a: Dict[str, List[int]], b: int | None, c: Callable[[int], str]) -> Optional[Foo.Bar]:\n    pass\n", "m.py"))
      .toContain("def g(a: Dict[str, List[int]], b: int | None, c: Callable[[int], str]) -> Optional[Foo.Bar]:");
  });

  test("A1: comments inside interface and enum bodies are stripped", () => {
    const out = ts(R5_INPUTS[8]![1]);
    expect(out).not.toMatch(SECRETS);
    expect(out).toContain("export enum E { A, B }");
  });

  test("A2: python is resolved from absolute PATH entries only", () => {
    const saved = process.env.PATH;
    process.env.PATH = ":relative/bin:" + (saved ?? "");
    try { expect(ts("def a(): pass\n", "m.py")).toContain("def a():"); } finally { process.env.PATH = saved; }
    process.env.PATH = ":relative/bin";
    try { expect(ts("def a(): pass\n", "m.py")).not.toContain("def a"); } finally { process.env.PATH = saved; }
  });
});
