// D86 FC-09r: the one registry of files that steer how tests run or resolve code. A run that changes the runner-relevant part of one
// cannot seal VERIFIED (the agent could be mocking the code under test). Shared files (package.json, go.mod, Cargo.toml, ...) are
// compared base vs head by section, so a dependency bump is not config but a pretest edit, a go.mod replace or a tsconfig path is.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Sections = RegExp | readonly string[] | "go" | "tsconfig";
interface Spec { re: RegExp; shared?: Sections }
const PKG_KEYS = ["scripts", "jest", "overrides", "resolutions", "imports", "pnpm", "mocha", "vitest", "ava", "c8", "nyc", "babel", "bun"] as const; // scripts is compared whole: pretest, posttest and test:* all count
export const RUNNER_CONFIGS: Spec[] = [
  { re: /(^|\/)(conftest\.py|tox\.ini|bunfig\.toml|\.?pytest\.(ini|toml)|\.mocharc[\w.]*)$/ },
  { re: /(^|\/)(vitest|vite|jest)\.(config|workspace)\.[\w.]+$/ },
  { re: /(^|\/)\.cargo\/config(\.toml)?$/ },
  { re: /(^|\/)package\.json$/, shared: PKG_KEYS },
  { re: /(^|\/)pyproject\.toml$/, shared: /^\[tool\.pytest/ },
  { re: /(^|\/)setup\.cfg$/, shared: /^\[tool:pytest\]/ },
  { re: /(^|\/)go\.mod$/, shared: "go" },
  { re: /(^|\/)Cargo\.toml$/, shared: /^\[(patch|replace)\b/ },
  { re: /(^|\/)[jt]sconfig(\.[\w-]+)?\.json$/, shared: "tsconfig" },
];

const DEP_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const RUNNER_DEP = /^(jest|vitest|mocha|ava|c8|nyc|pytest[\w-]*|@jest\/.*|ts-jest|babel-jest)$/;
const LOCAL_SPEC = /^(file|link|npm|workspace):/;
/** Dependency entries that can swap the runner or redirect code: runner-named keys, or any key resolved to a local or aliased spec. */
const depGuard = (j: Record<string, unknown>): unknown[] => DEP_MAPS.map((m) => Object.entries((j[m] ?? {}) as Record<string, unknown>).filter(([k, v]) => RUNNER_DEP.test(k) || LOCAL_SPEC.test(String(v))));
const KW = /pytest|jest|mocha|vitest|addopts|testpaths/i; // main's original line trigger, kept as a union so no guard is weakened
const lines = (t: string): string[] => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const jsonc = (t: string): unknown => JSON.parse(t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1"));

/** The runner-relevant part of a shared file as a comparable string. Throws on malformed input: the caller fails closed. */
function relevant(shared: Sections, text: string): string {
  if (shared === "go") { // replace directives, single-line or in a block
    let blk = false;
    return lines(text).filter((l) => { if (blk) { if (l === ")") blk = false; return true; } if (/^replace\s*\($/.test(l)) { blk = true; return true; } return /^replace\s/.test(l); }).join("\n");
  }
  if (shared === "tsconfig") { const j = jsonc(text) as { compilerOptions?: Record<string, unknown>; extends?: unknown }; const o = j.compilerOptions ?? {}; return JSON.stringify(["extends", "baseUrl", "paths", "rootDirs", "moduleSuffixes", "customConditions"].map((k) => (k === "extends" ? j["extends"] : o[k]))); }
  if (Array.isArray(shared)) { const j = JSON.parse(text) as Record<string, unknown>; return JSON.stringify([shared.map((k) => j[k]), depGuard(j)]); }
  let on = false;
  return lines(text).filter((l) => { if (/^\[[^\]]+\]$/.test(l)) on = (shared as RegExp).test(l); return on || KW.test(l); }).join("\n");
}

const baseText = (dir: string, base: string, f: string): string => {
  try { return execFileSync("git", ["show", `${base}:./${f}`], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }); } catch { return ""; }
};
const headText = (dir: string, f: string): string => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };

/** Changed files that steer the test runner (working tree vs base). A hit caps the verdict (NOT PROVEN), never decides one. Unparseable and
 *  changed means capped (fail closed). Files with no shared section (runner-only configs) count whenever they are listed as changed. */
export function testConfigChanged(repoDir: string, baseSha: string, changed: string[]): string[] {
  return changed.filter((f) => {
    const spec = RUNNER_CONFIGS.find((s) => s.re.test(f));
    if (!spec) return false;
    if (!spec.shared) return true;
    const b = baseText(repoDir, baseSha, f), h = headText(repoDir, f);
    if (b === h) return false;
    try { return relevant(spec.shared, b || "{}") !== relevant(spec.shared, h || "{}"); } catch { return true; }
  });
}
