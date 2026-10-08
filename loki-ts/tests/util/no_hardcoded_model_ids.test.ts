import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Dated Claude model ids go stale (haiku-4-5 retires). Defaults must use catalog
// aliases (providers/model_catalog.json cli_aliases) so one file owns the ids.
const ROOT = join(import.meta.dir, "../../..");
const SCAN = ["loki-ts/src", "autonomy", "providers"];
const ID = /claude-(haiku|sonnet|opus|fable)-\d/;
// Whole files that legitimately name ids: the catalog itself, and pricing
// tables owned by PRICE-TRUTH (budget.ts).
const ALLOW_FILES = new Set(["providers/model_catalog.json", "loki-ts/src/runner/budget.ts"]);
// Pricing-table rows in run.sh (price object literals), never a default.
const PRICING_ROW = /["']input["']\s*:/;
const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|sh|json|py)$/.test(name) || name === "loki") out.push(p);
  }
}

export function findOffenders(files: string[], root = ROOT): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(root, f);
    if (ALLOW_FILES.has(rel)) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (ID.test(line) && !COMMENT.test(line) && !PRICING_ROW.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

test("no hardcoded dated Claude model id outside the catalog and pricing allowlist", () => {
  const files: string[] = [];
  for (const d of SCAN) walk(join(ROOT, d), files);
  expect(findOffenders(files)).toEqual([]);
});

test("mutation: a planted dated id in a src file is flagged", () => {
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(join(require("node:os").tmpdir(), "loki-run.nohc-"));
  try {
    const f = join(dir, "x.ts");
    fs.writeFileSync(f, 'const m = "claude-haiku-4-5";\n');
    expect(findOffenders([f], dir).length).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
