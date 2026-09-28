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
// and even seal.ts/verify.ts/wall.ts/verify_cmd.ts may be referenced only as `import type`.
const IMPORT_RE = /^import\s+(type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["'];?/gm;

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
      let m: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(src))) {
        const isTypeOnly = Boolean(m[1]);
        const path = m[2]!;
        if (path.includes("/stages/")) {
          const base = path.split("/").pop();
          const allowed = base === "seal.ts" || base === "verify.ts" || base === "wall.ts";
          expect(allowed, `${f} imports banned stages/ module: ${path}`).toBe(true);
          expect(isTypeOnly, `${f} imports ${path} without 'import type'`).toBe(true);
        }
        if (path.endsWith("verify_cmd.ts")) {
          expect(isTypeOnly, `${f} imports verify_cmd.ts without 'import type'`).toBe(true);
        }
      }
    }
  });
});
