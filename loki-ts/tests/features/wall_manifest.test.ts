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
    for (const sig of ["LIMIT = ...", "@decorator", "def add(a: int,\n        b: int = 2) -> int:", "async def fetch(url: str) -> str:", "class Box:", "    def __init__(self, item):", "    def get(self, key: str) -> str:"]) {
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
