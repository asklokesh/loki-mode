// A-119b: base paths whose change, deletion or rename weakens the proof: anything in a test/fixture/snapshot dir, test files
// outside the testmap name patterns, and helper modules a base test file imports.
import { execFileSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";

const DIR = /(^|\/)(tests?|__tests__|__snapshots__|__fixtures__|fixtures)\//;
// ponytail: a helper outside a test dir is recognised by name only (a source file a test imports is NOT a helper, so an honest fix stays VERIFIED)
const HELPER = /(^|\/)[^/]*(helper|util|fixture|mock|stub|setup|support|common)[^/]*\.[cm]?[jt]sx?$/i;
const IMPORT = /(?:require\(\s*|from\s+|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
const EXT = ["", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", "/index.js", "/index.ts"];
const gitOut = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], env: process.env });

/** `paths`: base-tree paths the diff changed or deleted. Returns those that count as test weakening. */
export function weakBasePaths(repoDir: string, baseSha: string, paths: string[], isTest: (p: string) => boolean): string[] {
  const inDir = paths.filter((p) => DIR.test(p) || isTest(p));
  const rest = paths.filter((p) => !inDir.includes(p) && HELPER.test(p));
  if (!rest.length) return inDir;
  try {
    const files = new Set(gitOut(repoDir, ["ls-tree", "-r", "--name-only", baseSha]).split("\n"));
    const imported = new Set<string>();
    for (const t of files) {
      if (!/\.[cm]?[jt]sx?$/.test(t) || !(DIR.test(t) || isTest(t))) continue;
      for (const m of gitOut(repoDir, ["show", `${baseSha}:${t}`]).matchAll(IMPORT)) {
        const base = normalize(join(dirname(t), m[1]!));
        const hit = EXT.map((e) => base + e).find((c) => files.has(c));
        if (hit) imported.add(hit);
      }
    }
    return [...inDir, ...rest.filter((p) => imported.has(p))];
  } catch { return inDir; }
}
