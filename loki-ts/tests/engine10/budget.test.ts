// E-02/D33 wall check: engine10 core and modernize/ stay under their own line budgets
// (docs/v10/ENGINE.md section 3, docs/v10/DECISIONS.md D29, D33).
// D42 item 1: e10ext/ gets its own 1,500-line cap here, plus the stages/ and
// seal/verify/wall/verify_cmd import restrictions that keep verdict logic out of it.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "src", "engine10");
const E10EXT_ROOT = join(import.meta.dir, "..", "..", "src", "e10ext");

function count(list: string[], root: string = ROOT): number {
  return list.reduce((n, f) => n + readFileSync(join(root, f), "utf8").split("\n").length, 0);
}

/** Per-file line counts, largest first, so a cap failure names its owner. */
function breakdown(list: string[], root: string = ROOT): string {
  return list
    .map((f) => [f, readFileSync(join(root, f), "utf8").split("\n").length] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${n} ${f}`)
    .join("\n");
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
    const n = count(core);
    if (n >= 5000) throw new Error(`core is ${n} lines (cap 5000); per file:\n${breakdown(core)}`);
    expect(n).toBeLessThan(5000);
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
const RE_SIDE_EFFECT = /^[ \t]*import\s+["']([^"']+)["'];?/gm;
// [^;] (not [^;\n]) so a multi-line binding list (`import {\n  x,\n} from "x";`) is still matched:
// a newline inside the braces must not let the specifier escape the fence.
const RE_IMPORT_FROM = /^[ \t]*import\s+(type\s+(?!from\b))?[^;]*?\bfrom\s+["']([^"']+)["'];?/gm;
const RE_EXPORT_FROM = /^[ \t]*export\s+(?:type\s+)?[^;]*?\bfrom\s+["']([^"']+)["'];?/gm;
const RE_DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

// Third regex gap of the same class (template-literal and comment-inside-call dynamic imports), so
// the regexes are no longer the only fence: Bun's own scanner sees every real specifier. It drops
// type-only imports (the correct D42 meaning) but hides `import { type X }`, which the regexes
// above still flag as a whole-statement violation. A dynamic import() whose argument is not a
// single string/template literal (for example "a/" + "stages/fix.ts") cannot be resolved
// statically (same for require(), and createRequire is banned outright), so it fails closed: e10ext has no legitimate need for one.
const RE_NONLITERAL_DYNAMIC = /\b(?:import|require)\s*\(\s*(?!\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:"[^"\\\n]*"|'[^'\\\n]*'|`[^`$\\]*`)\s*\))/g;

function scanImportPaths(src: string): string[] {
  return new Bun.Transpiler({ loader: "ts" }).scanImports(src).map((i) => i.path);
}

function findImports(src: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const path of scanImportPaths(src)) refs.push({ path, typeOnly: false });
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

// Bun resolves "x", "x.js" and "x.ts" to the same file, so compare the basename minus extension.
function stem(path: string): string {
  return path.split("/").pop()!.replace(/\.(ts|js)$/, "");
}

function importViolations(file: string, src: string): string[] {
  const violations: string[] = [];
  for (const { path, typeOnly } of findImports(src)) {
    if (path.includes("/stages/")) {
      const base = stem(path);
      const allowed = base === "seal" || base === "verify" || base === "wall";
      if (!allowed) violations.push(`${file} imports banned stages/ module: ${path}`);
      else if (!typeOnly) violations.push(`${file} imports ${path} without a whole-statement 'import type'`);
    }
    if (stem(path) === "verify_cmd" && !typeOnly) {
      violations.push(`${file} imports verify_cmd.ts without a whole-statement 'import type'`);
    }
  }
  RE_NONLITERAL_DYNAMIC.lastIndex = 0;
  if (RE_NONLITERAL_DYNAMIC.test(src)) violations.push(`${file} has a non-literal dynamic import(), which cannot be fenced`);
  if (/\bcreateRequire\b/.test(src)) violations.push(`${file} uses createRequire, which cannot be fenced`);
  return [...new Set(violations)];
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

  it("B1: a runtime import of verify_cmd with no extension, .js, or .ts is caught", () => {
    for (const ext of ["", ".js", ".ts"]) {
      const src = `import { computeReceiptHash } from "../engine10/verify_cmd${ext}";\n`;
      expect(importViolations("f.ts", src)).toEqual(["f.ts imports verify_cmd.ts without a whole-statement 'import type'"]);
    }
  });

  it("B1: an extensionless or .js stages/ banned import is caught; allowed ones need import type", () => {
    expect(importViolations("f.ts", `import { x } from "../engine10/stages/fix";\n`)).toEqual(["f.ts imports banned stages/ module: ../engine10/stages/fix"]);
    expect(importViolations("f.ts", `import { x } from "../engine10/stages/seal.js";\n`)).toEqual(["f.ts imports ../engine10/stages/seal.js without a whole-statement 'import type'"]);
    expect(importViolations("f.ts", `import type { x } from "../engine10/stages/seal";\n`)).toEqual([]);
  });

  it("an indented import is caught, and `import type from \"x\"` is a runtime default import", () => {
    expect(importViolations("f.ts", `  import { x } from "../engine10/verify_cmd";\n`)).toHaveLength(1);
    expect(importViolations("f.ts", `import type from "../engine10/verify_cmd";\n`)).toHaveLength(1);
  });

  it("dynamic `require(\"x\")` is caught and never exempted as type-only", () => {
    const src = `const m = require("${BANNED}");\n`;
    expect(importViolations("f.ts", src)).toEqual([`f.ts imports ${BANNED} without a whole-statement 'import type'`]);
  });

  it("B1r4: a template-literal dynamic import is caught", () => {
    const src = "const m = await import(`../engine10/stages/fix.ts`);\n";
    expect(importViolations("f.ts", src)).toEqual(["f.ts imports banned stages/ module: ../engine10/stages/fix.ts"]);
  });

  it("B1r4: a comment inside the import() call is caught", () => {
    const src = `const m = await import(/* x */ "../engine10/stages/fix.ts");\n`;
    expect(importViolations("f.ts", src)).toEqual(["f.ts imports banned stages/ module: ../engine10/stages/fix.ts"]);
  });

  it("B1r4: a concatenated dynamic import cannot be resolved statically and fails closed", () => {
    const src = `const m = await import("../engine10/" + "stages/fix.ts");\n`;
    expect(importViolations("f.ts", src)).toEqual(["f.ts has a non-literal dynamic import(), which cannot be fenced"]);
  });

  it("B1r5: a concatenated require() is caught", () => {
    const src = `const m = require("../engine10/" + "stages/fix.ts");\n`;
    expect(importViolations("f.ts", src)).toEqual(["f.ts has a non-literal dynamic import(), which cannot be fenced"]);
  });

  it("B1r5: a variable require() is caught", () => {
    const src = `const p = "../engine10/stages/fix.ts";\nconst m = require(p);\n`;
    expect(importViolations("f.ts", src)).toEqual(["f.ts has a non-literal dynamic import(), which cannot be fenced"]);
  });

  it("B1r5: createRequire is banned outright", () => {
    const src = `import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\n`;
    expect(importViolations("f.ts", src)).toEqual(["f.ts uses createRequire, which cannot be fenced"]);
  });

  it("B1r4: a plain literal dynamic import of an allowed path is not a non-literal violation", () => {
    expect(importViolations("f.ts", `const m = await import("./other.ts");\n`)).toEqual([]);
  });
});

// D66: features/ is the home for new modules, with its own 3,000-line cap. It may not import
// stages/ or seal/verify/wall/verify_cmd except as a whole-statement `import type`.
const FEATURES_ROOT = join(import.meta.dir, "..", "..", "src", "features");

function featuresFiles(): string[] {
  try {
    return (readdirSync(FEATURES_ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  } catch {
    return [];
  }
}

function featuresViolations(file: string, src: string): string[] {
  const out: string[] = [];
  for (const { path, typeOnly } of findImports(src)) {
    const s = stem(path);
    const banned = path.includes("/stages/") || ["seal", "verify", "wall", "verify_cmd"].includes(s);
    if (banned && !typeOnly) out.push(`${file} imports ${path} without a whole-statement 'import type'`);
  }
  return [...new Set(out)];
}

describe("features size and import budget (D66)", () => {
  it("features stays under 3,000 lines", () => {
    expect(count(featuresFiles(), FEATURES_ROOT)).toBeLessThan(3000);
  });

  it("never imports stages/ or seal/verify/wall/verify_cmd except whole-statement `import type`", () => {
    for (const f of featuresFiles()) {
      expect(featuresViolations(f, readFileSync(join(FEATURES_ROOT, f), "utf8"))).toEqual([]);
    }
  });

  it("the fence flags a value import and allows an import type", () => {
    expect(featuresViolations("x.ts", 'import { a } from "../engine10/stages/verify.ts";\n').length).toBe(1);
    expect(featuresViolations("x.ts", 'import type { A } from "../engine10/verify_cmd.ts";\n')).toEqual([]);
  });
});

// D91 item 3 (docs/v11/REGISTRIES.md rule 5): contrib/ is the home for extracted non-verdict code, with its
// own 1,200-line cap and the same fence as features/.
const CONTRIB_ROOT = join(import.meta.dir, "..", "..", "src", "contrib");

function contribFiles(): string[] {
  const files = (readdirSync(CONTRIB_ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  return files;
}

describe("contrib size and import budget (D91)", () => {
  it("contrib stays under 1,200 lines", () => {
    const files = contribFiles();
    const n = count(files, CONTRIB_ROOT);
    if (n >= 1200) throw new Error(`contrib is ${n} lines (cap 1200); per file:\n${breakdown(files, CONTRIB_ROOT)}`);
    expect(n).toBeLessThan(1200);
  });

  it("never imports stages/ or seal/verify/wall/verify_cmd except whole-statement `import type`", () => {
    for (const f of contribFiles()) {
      expect(featuresViolations(f, readFileSync(join(CONTRIB_ROOT, f), "utf8"))).toEqual([]);
    }
  });

  it("the fence flags a planted value import of a stages/ module", () => {
    expect(featuresViolations("x.ts", 'import { x } from "../engine10/stages/seal";\n').length).toBe(1);
    expect(featuresViolations("x.ts", 'import type { X } from "../engine10/stages/seal";\n')).toEqual([]);
  });
});

// CTO RG-06 condition 1: core never imports contrib/. contrib/index.ts registers into core's hook slots and lazy
// registry at startup, called from the CLI entry (src/cli.ts) and tests/preload.ts.
function contribImports(src: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']*)["']/g;
  const out: string[] = [];
  for (const m of src.matchAll(re)) if (/(^|\/)contrib(\/|$)/.test(m[1]!)) out.push(m[1]!);
  return out;
}

describe("core never imports contrib (RG-06 condition 1)", () => {
  it("no file under engine10 (modernize included) imports contrib/", () => {
    const files = (readdirSync(ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const bad = files.filter((f) => contribImports(readFileSync(join(ROOT, f), "utf8")).length > 0);
    expect(bad).toEqual([]);
  });

  it("the scan flags static, dynamic, type and require forms of a contrib import", () => {
    expect(contribImports('import { x } from "../contrib/forecast.ts";')).toHaveLength(1);
    expect(contribImports('const m = await import("../contrib/eta.ts");')).toHaveLength(1);
    expect(contribImports('import type { T } from "../../contrib/index.ts";')).toHaveLength(1);
    expect(contribImports('const m = require("../contrib/x");')).toHaveLength(1);
    expect(contribImports('export { y } from "../contrib";')).toHaveLength(1);
    expect(contribImports('import { x } from "./hooks.ts";')).toEqual([]);
  });

  it("the bootstrap exists and is wired from the CLI entry and the test preload", () => {
    const src = join(import.meta.dir, "..", "..", "src");
    expect(readFileSync(join(src, "cli.ts"), "utf8")).toContain("registerContrib()");
    expect(readFileSync(join(import.meta.dir, "..", "preload.ts"), "utf8")).toContain("registerContrib()");
  });
});
