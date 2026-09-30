// E-02/D33 wall check: engine10 core and modernize/ stay under their own line budgets
// (docs/v10/ENGINE.md section 3, docs/v10/DECISIONS.md D29, D33).
// D42 item 1: e10ext/ gets its own 1,500-line cap here, plus the stages/ and
// seal/verify/wall/verify_cmd import restrictions that keep verdict logic out of it.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "src", "engine10");
const E10EXT_ROOT = join(import.meta.dir, "..", "..", "src", "e10ext");

function count(list: string[]): number {
  return list.reduce((n, f) => n + readFileSync(join(ROOT, f), "utf8").split("\n").length, 0);
}

function e10extFiles(): string[] {
  return (readdirSync(E10EXT_ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
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

describe("e10ext size budget and import fence (D42)", () => {
  it("stays under 1,500 lines", () => {
    const files = e10extFiles();
    expect(files.length).toBeGreaterThan(0);
    const n = files.reduce((sum, f) => sum + readFileSync(join(E10EXT_ROOT, f), "utf8").split("\n").length, 0);
    expect(n).toBeLessThan(1500);
  });

  it("never imports stages/, and only imports TYPES from seal/verify/wall/verify_cmd", () => {
    const isGuardedFile = (spec: string) => /(?:^|\/)(seal|verify|wall|verify_cmd)\.ts$/.test(spec);
    const assertSpec = (spec: string, typeOnly: boolean) => {
      if (isGuardedFile(spec)) {
        expect(typeOnly).toBe(true); // D42's one carve-out: import type only
        return;
      }
      // Everything else under stages/ is banned outright, even import type.
      expect(spec).not.toMatch(/\/stages\//);
    };
    const files = e10extFiles();
    for (const f of files) {
      const src = readFileSync(join(E10EXT_ROOT, f), "utf8");
      // Whole-file scan (not line-by-line): a wrapped `import {\n x,\n} from` has
      // its "from" on a different line than its "import" keyword, so a per-line
      // regex would never see the two together.
      const fromRe = /\bfrom\s+["']([^"']+)["']/g;
      for (const m of src.matchAll(fromRe)) {
        const spec = m[1] as string;
        const before = src.slice(0, m.index);
        // Nearest import/export keyword before this "from", within the same
        // statement (no unescaped ";" in between); "type" right after it means
        // a type-only static import/re-export.
        const stmt = before.match(/(?:^|;)[^;]*$/)?.[0] ?? before;
        const kw = stmt.match(/\b(import|export)\s+(type\s+)?[^;]*$/);
        assertSpec(spec, Boolean(kw?.[2]));
      }
      // Dynamic import("spec") is always a value import at runtime -- never type-only.
      const dynRe = /\bimport\s*\(\s*["']([^"']+)["']/g;
      for (const m of src.matchAll(dynRe)) assertSpec(m[1] as string, false);
    }
  });
});
