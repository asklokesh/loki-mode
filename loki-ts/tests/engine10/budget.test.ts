// E-02/D33 wall check: engine10 core and modernize/ stay under their own line budgets
// (docs/v10/ENGINE.md section 3, docs/v10/DECISIONS.md D29, D33).
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "src", "engine10");

function count(list: string[]): number {
  return list.reduce((n, f) => n + readFileSync(join(ROOT, f), "utf8").split("\n").length, 0);
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
