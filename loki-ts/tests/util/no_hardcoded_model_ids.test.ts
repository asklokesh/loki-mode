// select: walk-all-src
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkAllowlist, loadAllowlist } from "./_guard_lib.ts";

// Dated Claude model ids go stale (haiku-4-5 retires). Defaults must use catalog
// aliases (providers/model_catalog.json cli_aliases) so one file owns the ids.
const ROOT = join(import.meta.dir, "../../..");
// benchmarks/ is bench data and stays excluded.
const SCAN = ["loki-ts/src", "autonomy", "providers", "mcp", "dashboard"];
const ID = /claude-(haiku|sonnet|opus|fable)-\d/;
// Whole files that legitimately name ids live in guard-allowlists/hardcoded-model-ids.txt (shared FINDING-GUARDS format).
// This guard is about model IDS in defaults; model_output_regex_guard.test.ts is about parsing model OUTPUT, so they do not overlap.
const ALLOW = loadAllowlist("hardcoded-model-ids.txt");
const ALLOW_FILES = new Set(Object.keys(ALLOW));
// Pricing-table rows in other files. The row must START with the quoted id key,
// so an id used as a value (`?? "claude-x"  "input":`) is still flagged.
const ALLOW_ROWS: Record<string, RegExp> = {
  "autonomy/run.sh": /^\s*["']claude-[a-z0-9-]+["']\s*:\s*\{\s*["']input["']/,
  "dashboard/server.py": /^\s*["']claude-[a-z0-9-]+["']\s*:\s*\{\s*["']input["']/,
};
// Whole-line comments only; a trailing or inline comment does not exempt a line.
const COMMENT = /^\s*(#|\/\/)/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__pycache__" || name === "static" || name.startsWith(".")) continue;
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
    const row = ALLOW_ROWS[rel];
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!ID.test(line) || COMMENT.test(line) || (row && row.test(line))) return;
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

test("no hardcoded dated Claude model id outside the catalog and pricing allowlist", () => {
  const files: string[] = [];
  for (const d of SCAN) walk(join(ROOT, d), files);
  expect(findOffenders(files)).toEqual([]);
  // Every allowlisted file must still name an id and carry a reason (no stale entries).
  const naming = Object.keys(ALLOW).filter((f) => ID.test(readFileSync(join(ROOT, f), "utf8")));
  expect(checkAllowlist(naming, ALLOW)).toEqual({ unlisted: [], stale: [], noReason: [] });
});

test("mutation: planted dated ids are flagged, including shapes a loose exemption would hide", () => {
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(join(require("node:os").tmpdir(), "loki-run.nohc-"));
  try {
    const plants = [
      'const m = "claude-haiku-4-5";',
      'const m = x ?? "claude-haiku-4-5"; // {"input": 1}',
      'const m = y ?? "claude-haiku-4-5", z = {"input": 1};',
      '/* a */ const m = "claude-haiku-4-5";',
      ' * "claude-haiku-4-5"',
      'const m = "claude-haiku-4-5"; // trailing comment',
    ];
    plants.forEach((src, i) => {
      const f = join(dir, `p${i}.ts`);
      fs.writeFileSync(f, src + "\n");
      expect({ src, n: findOffenders([f], dir).length }).toEqual({ src, n: 1 });
    });
    fs.writeFileSync(join(dir, "ok.ts"), '// claude-haiku-4-5 in a comment\n# claude-sonnet-5 too\n');
    expect(findOffenders([join(dir, "ok.ts")], dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
