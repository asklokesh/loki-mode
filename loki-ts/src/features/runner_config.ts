// D86 FC-09r: the one registry of files that steer how tests run or resolve code. A run that changes the runner-relevant part of one
// cannot seal VERIFIED (the agent could be mocking the code under test). Shared files (package.json, go.mod, Cargo.toml, ...) are
// compared base vs head by section, so a dependency bump is not config but a pretest edit, a go.mod replace or a tsconfig path is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../util/safe_git";
type Sections = RegExp | readonly string[] | "go" | "tsconfig" | "cargo"; interface Spec { re: RegExp; shared?: Sections }
const PKG_KEYS = ["scripts", "jest", "overrides", "resolutions", "imports", "pnpm", "mocha", "vitest", "ava", "c8", "nyc", "babel", "bun"] as const; // scripts is compared whole: pretest, posttest and test:* all count
export const RUNNER_CONFIGS: Spec[] = [
  { re: /(^|\/)(conftest\.py|tox\.ini|bunfig\.toml|\.?pytest\.(ini|toml)|\.mocharc[\w.]*)$/ },
  { re: /(^|\/)(vitest|vite|jest)\.(config|workspace)\.[\w.]+$/ },
  { re: /(^|\/)\.cargo\/config(\.toml)?$/ },
  { re: /(^|\/)(babel\.config\.[\w.]+|\.babelrc(\.[\w]+)?|\.pnpmfile\.(cjs|mjs))$/ },
  { re: /(^|\/)package\.json$/, shared: PKG_KEYS },
  { re: /(^|\/)pyproject\.toml$/, shared: /^\[tool\.pytest/ },
  { re: /(^|\/)setup\.cfg$/, shared: /^\[tool:pytest\]/ },
  { re: /(^|\/)go\.(mod|work)$/, shared: "go" },
  { re: /(^|\/)Cargo\.toml$/, shared: "cargo" },
  { re: /(^|\/)[jt]sconfig(\.[\w-]+)?\.json$/, shared: "tsconfig" },
];
const DEP_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const, RUNNER_DEP = /^(jest|vitest|mocha|ava|c8|nyc|pytest[\w-]*|@jest\/.*|ts-jest|babel-jest)$/, LOCAL_SPEC = /^(file|link|npm|workspace):/;
/** Dependency entries that can swap the runner or redirect code: runner-named keys, or any key resolved to a local or aliased spec. */
const depGuard = (j: Record<string, unknown>): unknown[] => DEP_MAPS.map((m) => Object.entries((j[m] ?? {}) as Record<string, unknown>).filter(([k, v]) => RUNNER_DEP.test(k) || LOCAL_SPEC.test(String(v))));
const KW = /pytest|jest|mocha|vitest|addopts|testpaths/i, lines = (t: string): string[] => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
/** Drop a trailing `#` comment that sits outside quotes (TOML). */
const stripToml = (l: string): string => { let q = ""; for (let i = 0; i < l.length; i++) { const c = l[i]!; if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === "#") return l.slice(0, i).trim(); } return l.trim(); };
const jsonc = (t: string): unknown => JSON.parse(t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1"));
/** The runner-relevant part of a shared file as a comparable string. Throws on malformed input: the caller fails closed. */
function relevant(shared: Sections, text: string): string {
  if (shared === "go") { // replace and (go.work) use directives, single-line or in a block
    let blk = false;
    return lines(text).map((l) => l.replace(/\s*\/\/.*$/, "")).filter(Boolean).filter((l) => { if (blk) { if (l === ")") blk = false; return true; } if (/^(replace|use)\s*\($/.test(l)) { blk = true; return true; } return /^(replace|use)\s/.test(l); }).join("\n");
  }
  if (shared === "cargo") { // every key line is judged on its full dotted path (section + key prefix): patch/replace, dependency path=, dev/build-dependency git/package/registry, test path/harness, lib test
    let sec = "";
    const nz = (s: string): string => s.replace(/["']/g, "").replace(/\s*\.\s*/g, ".").trim(), dep = /(^|\.)(dev-|build-)?dependencies(\.|$)/, pr = /^(patch|replace)(\.|$)/;
    return lines(text).map(stripToml).filter(Boolean).filter((l) => {
      const h = /^\[\[?([^\]]+)\]\]?$/.exec(l);
      if (h) { sec = nz(h[1]!); return pr.test(sec) || dep.test(sec) || KW.test(l); }
      const m = /^((?:"[^"]*"|'[^']*'|[^=])+?)\s*=\s*(.*)$/.exec(l), f = m ? (sec ? sec + "." : "") + nz(m[1]!) : "", v = m?.[2] ?? "";
      return KW.test(l) || pr.test(f) || (dep.test(f) && (/\bpath\s*=/.test(l) || (/(dev|build)-dependencies/.test(f) && /\b(git|package|registry)\s*=/.test(l)))) || /^(test\.(path|harness)|lib\.test)$/.test(f) || (/^(lib|test)$/.test(f) && /\b(test|path|harness)\s*=/.test(v));
    }).join("\n");
  }
  if (shared === "tsconfig") { const j = jsonc(text) as { compilerOptions?: Record<string, unknown>; extends?: unknown }; const o = j.compilerOptions ?? {}; return JSON.stringify(["extends", "baseUrl", "paths", "rootDirs", "moduleSuffixes", "customConditions"].map((k) => (k === "extends" ? j["extends"] : o[k]))); }
  if (Array.isArray(shared)) { const j = JSON.parse(text) as Record<string, unknown>; return JSON.stringify([shared.map((k) => j[k]), depGuard(j)]); }
  let on = false;
  return lines(text).filter((l) => { if (/^\[[^\]]+\]$/.test(l)) on = (shared as RegExp).test(l); return on || KW.test(l); }).join("\n");
}
const baseText = (dir: string, base: string, f: string): string => { try { return safeGit(dir, ["show", `${base}:./${f}`], { timeout: 20000, maxBuffer: 64 << 20 }); } catch { return ""; } };
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
