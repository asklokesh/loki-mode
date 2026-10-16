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
const tomlKey = (s: string): string => s.replace(/["']/g, "").replace(/\s*\.\s*/g, ".").trim().replace(/\b(dev|build)_dependencies\b/g, "$1-dependencies");
/** Split `key = rest` at the first `=` outside quotes: [normalized dotted key, index after `=`]. Throws when there is none. */
function tomlKey2(s: string, i = 0): [string, number] { let q = ""; for (let j = i; j < s.length; j++) { const c = s[j]!; if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === "=") return [tomlKey(s.slice(i, j)), j + 1]; } throw new Error("toml key"); }
/** Track bracket depth and open triple-quoted strings across physical lines. */
function tomlScan(l: string, st: { d: number; t: string }): void { let q = ""; for (let i = 0; i < l.length; i++) { const c = l[i]!; if (st.t) { if (l.startsWith(st.t, i)) { st.t = ""; i += 2; } } else if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; } else if (c === '"' || c === "'") { if (l.startsWith(c.repeat(3), i)) { st.t = c.repeat(3); i += 2; } else q = c; } else if (c === "#") return; else if (c === "[" || c === "{") st.d++; else if (c === "]" || c === "}") st.d--; } }
/** Logical TOML statements: a line joined with its continuation lines while a [ or { or triple-quoted string is open. */
function cargoStmts(text: string): string[] { const out: string[] = [], st = { d: 0, t: "" }; let buf = ""; for (const raw of text.split("\n")) { const l = st.t ? raw : stripToml(raw.trim()); if (!buf && !l) continue; tomlScan(l, st); buf += (buf ? "\n" : "") + l; if (st.d < 0) throw new Error("toml depth"); if (!st.d && !st.t) { out.push(buf); buf = ""; } }
  if (buf) throw new Error("toml unterminated"); return out; }
/** Flatten one TOML value into [dotted path, scalar text] leaves; inline tables extend the path, arrays share it. */
function tomlLeaves(path: string, s: string): [string, string][] {
  const o: [string, string][] = []; let i = 0; const ws = (): void => { while (i < s.length && /[\s,]/.test(s[i]!)) i++; };
  const val = (p: string): void => {
    ws(); const c = s[i];
    if (c === "{" || c === "[") { i++; for (;;) { ws(); if (i >= s.length) throw new Error("toml open"); if (s[i] === (c === "{" ? "}" : "]")) { i++; return; } if (c === "{") { const [k, j] = tomlKey2(s, i); i = j; val(p + "." + k); } else val(p); } }
    const t = s.startsWith('"""', i) || s.startsWith("'''", i) ? s.slice(i, i + 3) : s[i] === '"' || s[i] === "'" ? s[i]! : "", from = i;
    if (t) { i += t.length; while (i < s.length && !s.startsWith(t, i)) i += s[i] === "\\" && t[0] === '"' ? 2 : 1; if (i >= s.length) throw new Error("toml string"); i += t.length; } else while (i < s.length && !/[\s,\]}]/.test(s[i]!)) i++;
    if (i === from) throw new Error("toml value");
    o.push([p, s.slice(from, i)]);
  };
  val(path); ws(); if (i < s.length) throw new Error("toml trailing"); return o;
}
const jsonc = (t: string): unknown => JSON.parse(t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1"));
/** The runner-relevant part of a shared file as a comparable string. Throws on malformed input: the caller fails closed. */
function relevant(shared: Sections, text: string): string {
  if (shared === "go") { // replace and (go.work) use directives, single-line or in a block
    let blk = false;
    return lines(text).map((l) => l.replace(/\s*\/\/.*$/, "")).filter(Boolean).filter((l) => { if (blk) { if (l === ")") blk = false; return true; } if (/^(replace|use)\s*\($/.test(l)) { blk = true; return true; } return /^(replace|use)\s/.test(l); }).join("\n");
  }
  if (shared === "cargo") { // flatten every statement (multi-line arrays and inline tables included) to dotted leaf paths and judge each: patch/replace, dependency path=, dev/build-dependency git/package/registry, test-steering keys
    const dep = /(^|\.)(dev-|build-)?dependencies(\.|$)/, pr = /^(patch|replace)(\.|$)/, TK = /^(test\.(path|harness|test|required-features)|lib\.(test|path|harness|doctest)|bin\.test|package\.autotests)$/, out: string[] = []; let sec = "";
    for (const st of cargoStmts(text)) {
      const h = /^\[\[?([^\]]+)\]\]?$/.exec(st); if (h) { sec = tomlKey(h[1]!); if (pr.test(sec) || dep.test(sec) || KW.test(st)) out.push(`[${sec}]`); continue; }
      const [k, i] = tomlKey2(st);
      for (const [f, v] of tomlLeaves((sec ? sec + "." : "") + k, st.slice(i))) { const last = f.slice(f.lastIndexOf(".") + 1); if (KW.test(f + "=" + v) || pr.test(f) || TK.test(f) || (dep.test(f) && (last === "path" || (/(dev|build)-dependencies/.test(f) && /^(git|package|registry)$/.test(last))))) out.push(`${f}=${v}`); }
    }
    return out.join("\n"); }
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
