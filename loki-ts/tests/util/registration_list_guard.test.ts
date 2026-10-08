// D91 finding class 3 guard: hand-kept lists that must match a directory. Derived or asserted equal here:
//  (a) every module under src/commands and src/engine10/stages is imported by some other src file (a new command or stage that is
//      never registered is dead code the dispatch silently never reaches); exceptions in guard-allowlists/unregistered-modules.txt
//  (b) every literal (non-glob) entry in package.json files[] exists on disk (a stale copy list ships a missing path without error).
// Test-runner registration and shard coverage are already guarded by scripts/structural-checks.sh and tests/test-shard-coverage.sh.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, SRC, walk, rel, loadAllowlist, checkAllowlist } from "./_guard_lib.ts";

const srcFiles = walk(SRC);
const importRe = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

function importedBasenames(): Set<string> {
  const seen = new Set<string>();
  for (const f of srcFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(importRe)) {
      const spec = m[1] ?? "";
      if (!spec.startsWith(".")) continue;
      seen.add(join(f, "..", spec).replace(/\.(ts|js)$/, ""));
    }
  }
  return seen;
}

test("every command and stage module is imported by another src file", () => {
  const imported = importedBasenames();
  const orphans = srcFiles
    .filter((f) => /\/src\/(commands|engine10\/stages)\//.test(f))
    .filter((f) => !imported.has(f.replace(/\.ts$/, "")))
    .map(rel);
  const r = checkAllowlist(orphans, loadAllowlist("unregistered-modules.txt"));
  expect(r).toEqual({ unlisted: [], stale: [], noReason: [] });
});

test("package.json files[] literal entries exist on disk", () => {
  const files: string[] = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).files;
  expect(files.length).toBeGreaterThan(10);
  // packages/*/dist and ui/dist are generated at prepack, absent from a checkout
  const generated = (e: string) => /^packages\/.*dist\b/.test(e);
  const missing = files.filter((e) => !/[*?[]/.test(e) && !generated(e) && !existsSync(join(REPO, e)));
  expect(missing).toEqual([]);
});
