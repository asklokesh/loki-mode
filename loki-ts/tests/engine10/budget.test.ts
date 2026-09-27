// E-02 wall check: engine10 stays under 5,000 lines of TypeScript (docs/v10/ENGINE.md section 3).
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "src", "engine10");

describe("engine10 size budget", () => {
  it("counts machine.ts and stays under 5,000 lines", () => {
    const files = (readdirSync(ROOT, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("machine.ts");
    const lines = files.reduce((n, f) => n + readFileSync(join(ROOT, f), "utf8").split("\n").length, 0);
    expect(lines).toBeLessThan(5000);
  });
});
