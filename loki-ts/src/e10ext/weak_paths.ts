// A-119b: base paths whose change, deletion or rename weakens the proof: anything in a test/fixture/snapshot dir, test files
// outside the testmap name patterns, and helper modules a base test file imports.
// ponytail: follow-ups, not covered: re-export chains, lazy dynamic imports, testdata/ and __mocks__/, vite test.include, jest roots, vitest.workspace.
import { execFileSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";

const DIR = /(^|\/)(tests?|__tests__|__snapshots__|__fixtures__|fixtures)\//;
const JS = /\.[cm]?[jt]sx?$/;
const IMPORT = /(?:require\(\s*|from\s+|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
const EXT = ["", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", "/index.js", "/index.ts"];
// a source file a test imports is a helper only if its BASE content asserts (a plain `utils.js` stays a source file)
const ASSERTS = /\bexpect\(|\bassert\b|\.should\b|\bt\.(?:equal|ok)\b/;
const run = (cwd: string, args: string[], input?: string): Buffer =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, input, maxBuffer: 256 << 20, stdio: ["pipe", "pipe", "ignore"], env: process.env });

/** One `git cat-file --batch` for many base blobs (never one process per file). */
function blobs(repoDir: string, baseSha: string, paths: string[]): Map<string, string> {
  const out = run(repoDir, ["cat-file", "--batch"], paths.map((p) => `${baseSha}:${p}\n`).join(""));
  const m = new Map<string, string>();
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(10, at);
    const [, type, size] = out.subarray(at, nl).toString().split(" ");
    const n = type === "blob" ? +size! : 0;
    if (type === "blob") m.set(p, out.subarray(nl + 1, nl + 1 + n).toString("utf8"));
    at = nl + 1 + n + (type === "blob" ? 1 : 0);
  }
  return m;
}

/** `paths`: base-tree paths the diff changed or deleted. Returns those that count as test weakening. */
export function weakBasePaths(repoDir: string, baseSha: string, paths: string[], isTest: (p: string) => boolean): string[] {
  const inDir = paths.filter((p) => DIR.test(p) || isTest(p));
  const rest = paths.filter((p) => !inDir.includes(p) && JS.test(p));
  if (!rest.length) return inDir;
  try {
    const hits = run(repoDir, ["grep", "-z", "-l", "-e", "require", "-e", "import", baseSha, "--", "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs", "*.mts", "*.cts"]).toString().split("\0").filter(Boolean)
      .map((h) => h.slice(baseSha.length + 1)).filter((t) => DIR.test(t) || isTest(t));
    const imported = new Set<string>();
    for (const [t, src] of blobs(repoDir, baseSha, hits)) {
      for (const m of src.matchAll(IMPORT)) {
        const b = normalize(join(dirname(t), m[1]!));
        const hit = EXT.map((e) => b + e).find((c) => rest.includes(c));
        if (hit) imported.add(hit);
      }
    }
    if (!imported.size) return inDir;
    const body = blobs(repoDir, baseSha, [...imported]);
    return [...inDir, ...[...imported].filter((p) => ASSERTS.test(body.get(p) ?? ""))];
  } catch { return inDir; }
}
