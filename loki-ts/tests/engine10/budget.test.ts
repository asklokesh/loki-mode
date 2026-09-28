// E-02/D33 wall check: engine10 core and modernize/ stay under their own line budgets
// (docs/v10/ENGINE.md section 3, docs/v10/DECISIONS.md D29, D33).
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "src", "engine10");
const E10EXT_ROOT = join(import.meta.dir, "..", "..", "src", "e10ext");

function count(list: string[], root: string = ROOT): number {
  return list.reduce((n, f) => n + readFileSync(join(root, f), "utf8").split("\n").length, 0);
}

function splitFiles(): { core: string[]; mod: string[] } {
  const files = (readdirSync(ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  expect(files).toContain("machine.ts");
  return {
    core: files.filter((f) => !f.startsWith("modernize/")),
    mod: files.filter((f) => f.startsWith("modernize/")),
  };
}

describe("engine10 size budget", () => {
  it("core engine stays under 5,000 lines (D29, D33)", () => {
    const { core } = splitFiles();
    expect(count(core)).toBeLessThan(5000);
  });

  it("modernize stays under 4,000 lines (D33)", () => {
    const { mod } = splitFiles();
    expect(mod.length).toBeGreaterThan(0);
    expect(count(mod)).toBeLessThan(4000);
  });

  it("core never imports modernize (D33)", () => {
    const { core } = splitFiles();
    for (const f of core) {
      if (f === "cli.ts") continue;
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src).not.toMatch(/from\s+["'][^"']*modernize\//);
    }
  });
});

// D42 (1): e10ext/ gets its own 1,500-line cap; core may import it, it may not import stages/,
// and even seal.ts/verify.ts/wall.ts/verify_cmd.ts may be referenced only as a whole-statement
// `import type` (never `export ... from`, a side-effect import, or a dynamic import(), none of
// which are exempted even when the referenced bindings are types-only in spirit).
interface ImportRef {
  path: string;
  typeOnly: boolean;
}

// Four independent forms, each scanned separately so one doesn't have to parse the others:
// `import "x"` (side effect, never type-only), `import <bindings> from "x"` (default, named,
// namespace, mixed, or `import type ... from`), `export {..} from "x"` / `export type {..} from
// "x"` (a re-export is never treated as the exempted `import type`), and dynamic `import("x")`.
const RE_SIDE_EFFECT = /^import\s+["']([^"']+)["'];?/gm;
// [^;] (not [^;\n]) so a multi-line binding list (`import {\n  x,\n} from "x";`) is still matched:
// a newline inside the braces must not let the specifier escape the fence.
const RE_IMPORT_FROM = /^import\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["'];?/gm;
const RE_EXPORT_FROM = /^export\s+(?:type\s+)?[^;]*?\bfrom\s+["']([^"']+)["'];?/gm;
const RE_DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function findImports(src: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const re of [RE_SIDE_EFFECT, RE_EXPORT_FROM, RE_DYNAMIC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) refs.push({ path: m[1]!, typeOnly: false });
  }
  RE_IMPORT_FROM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_IMPORT_FROM.exec(src))) refs.push({ path: m[2]!, typeOnly: Boolean(m[1]) });
  return refs;
}

function importViolations(file: string, src: string): string[] {
  const violations: string[] = [];
  for (const { path, typeOnly } of findImports(src)) {
    if (path.includes("/stages/")) {
      const base = path.split("/").pop();
      const allowed = base === "seal.ts" || base === "verify.ts" || base === "wall.ts";
      if (!allowed) violations.push(`${file} imports banned stages/ module: ${path}`);
      else if (!typeOnly) violations.push(`${file} imports ${path} without a whole-statement 'import type'`);
    }
    if (path.endsWith("verify_cmd.ts") && !typeOnly) {
      violations.push(`${file} imports verify_cmd.ts without a whole-statement 'import type'`);
    }
  }
  return violations;
}

function e10extFiles(): string[] {
  const files = (readdirSync(E10EXT_ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  return files;
}

describe("e10ext size and import budget (D42 (1))", () => {
  it("e10ext stays under 1,500 lines", () => {
    expect(count(e10extFiles(), E10EXT_ROOT)).toBeLessThan(1500);
  });

  it("never imports stages/ except `import type` of seal.ts, verify.ts or wall.ts, and never imports verify_cmd.ts except `import type`", () => {
    for (const f of e10extFiles()) {
      const src = readFileSync(join(E10EXT_ROOT, f), "utf8");
      expect(importViolations(f, src)).toEqual([]);
    }
  });
});

describe("e10ext import fence: findImports catches every import form (D42 (1) B3)", () => {
  const BANNED = "../engine10/stages/verify.ts";

  it("a side-effect import (`import \"x\"`) is caught and never exempted as type-only", () => {
    const src = `import "${BANNED}";\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });

  it("a re-export (`export {..} from \"x\"`) is caught and never exempted, even as `export type`", () => {
    const src = `export type { VerifyCheck } from "${BANNED}";\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });

  it("a mixed default+named import (`import d, { x } from \"x\"`) is caught", () => {
    const src = `import Def, { VerifyCheck } from "${BANNED}";\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });

  it("a dynamic import (`import(\"x\")`) is caught and never exempted as type-only", () => {
    const src = `const m = await import("${BANNED}");\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });

  it("a whole-statement `import type ... from` of an allowed stages/ file is not a violation", () => {
    const src = `import type { VerifyCheck } from "${BANNED}";\n`;
    expect(importViolations("f.ts", src)).toEqual([]);
  });

  it("a whole-statement `import type ... from` of a banned stages/ file (not seal/verify/wall) is still a violation", () => {
    const src = `import type { PlanOutput } from "../engine10/stages/plan.ts";\n`;
    expect(importViolations("f.ts", src)).toEqual(["f.ts imports banned stages/ module: ../engine10/stages/plan.ts"]);
  });

  it("R3: a multi-line `import { .. } from \"x\"` does not escape the fence", () => {
    const banned = "../engine10/stages/fix.ts";
    const src = `import {\n  fix,\n} from "${banned}";\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports banned stages/ module: ${banned}`]);
  });

  it("R3: a multi-line `export { .. } from \"x\"` does not escape the fence", () => {
    const src = `export {\n  VerifyCheck,\n} from "${BANNED}";\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });

  it("dynamic `require(\"x\")` is caught and never exempted as type-only", () => {
    const src = `const m = require("${BANNED}");\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });
});
