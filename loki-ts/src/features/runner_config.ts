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
const ESC: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
/** Decode TOML basic-string escapes (keys). An invalid escape or code point throws: the caller fails closed. */
const unesc = (s: string): string => s.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/g, (_m, u?: string, U?: string, c?: string) => { if (c !== undefined) { const e = ESC[c]; if (e === undefined) throw new Error("toml escape"); return e; } const n = parseInt((u ?? U)!, 16); if (n > 0x10ffff || (n >= 0xd800 && n < 0xe000)) throw new Error("toml escape"); return String.fromCodePoint(n); });
/** Parse a dotted key (bare, "basic" with escapes decoded, 'literal' raw) and its `=` from index i: [normalized dotted key, index after `=`]. Throws when malformed. */
function tomlKey2(s: string, i = 0, eq = true): [string, number] { const parts: string[] = [], ws = (): void => { while (/\s/.test(s[i] ?? "x")) i++; }; for (;;) { ws(); const c = s[i]; let p: string; if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) j += c === '"' && s[j] === "\\" ? 2 : 1; if (j >= s.length) throw new Error("toml key"); p = c === "'" ? s.slice(i + 1, j) : unesc(s.slice(i + 1, j)); i = j + 1; } else { const m = /^[\w-]+/.exec(s.slice(i)); if (!m) throw new Error("toml key"); p = m[0]; i += p.length; } parts.push(p); ws(); if (s[i] === ".") i++; else break; } if (eq && s[i++] !== "=") throw new Error("toml key"); return [parts.join(".").replace(/\b(dev|build)_dependencies\b/g, "$1-dependencies"), i];
}
/** The one TOML scanner: strings (basic, literal, multi-line) and comments tracked together, so a `#` starts a comment only outside any string. Yields comment-free logical statements (continued while a [ or { is open). Throws on malformed input. */
function cargoStmts(text: string): string[] { const out: string[] = []; let buf = "", d = 0, q = ""; const push = (): void => { if (buf.trim()) out.push(buf.trim()); buf = ""; }; for (let i = 0; i < text.length; i++) { const c = text[i]!; if (q) { if (c === "\\" && q[0] === '"') { buf += c + (text[i + 1] ?? ""); i++; } else if (q.length === 1 && c === "\n") throw new Error("toml string"); else if (text.startsWith(q, i)) { let r = 1; if (q.length === 3) while (text[i + r] === c) r++; if (r > 5) throw new Error("toml string"); buf += c.repeat(r); i += r - 1; q = ""; } else buf += c; } else if (c === '"' || c === "'") { q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c; buf += q; i += q.length - 1; } else if (c === "#") { while (i + 1 < text.length && text[i + 1] !== "\n") i++; } else if (c === "\n" && !d) push(); else { if (c === "[" || c === "{") d++; else if (c === "]" || c === "}") d--; if (d < 0) throw new Error("toml depth"); buf += c; } } if (q || d) throw new Error("toml unterminated"); push(); return out;
}
/** Flatten one TOML value into [dotted path, scalar text] leaves; inline tables extend the path, arrays share it. */
const DT = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?/;
function tomlLeaves(path: string, s: string): [string, string][] { const o: [string, string][] = []; let i = 0; const ws = (): void => { while (i < s.length && /[\s,]/.test(s[i]!)) i++; }; const val = (p: string): void => { ws(); const c = s[i]; if (c === "{" || c === "[") { i++; for (;;) { ws(); if (i >= s.length) throw new Error("toml open"); if (s[i] === (c === "{" ? "}" : "]")) { i++; return; } if (c === "{") { const [k, j] = tomlKey2(s, i); i = j; val(p + "." + k); } else val(p); } } const t = s.startsWith('"""', i) || s.startsWith("'''", i) ? s.slice(i, i + 3) : s[i] === '"' || s[i] === "'" ? s[i]! : "", from = i; if (t) { i += t.length; while (i < s.length && !s.startsWith(t, i)) i += s[i] === "\\" && t[0] === '"' ? 2 : 1; if (i >= s.length) throw new Error("toml string"); i += t.length; if (t.length === 3) while (s[i] === t[0]) i++; } else if (DT.test(s.slice(i))) i += DT.exec(s.slice(i))![0].length; else while (i < s.length && !/[\s,\]}]/.test(s[i]!)) i++; if (i === from) throw new Error("toml value"); o.push([p, s.slice(from, i)]); }; val(path); ws(); if (i < s.length) throw new Error("toml trailing"); return o;
}
const jsonc = (t: string): unknown => JSON.parse(t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1").replace(/,(\s*[}\]])/g, "$1"));
/** The runner-relevant part of a shared file as a comparable string. Throws on malformed input: the caller fails closed. */
function relevant(shared: Sections, text: string): string {
  if (shared === "go") { // replace and (go.work) use directives, single-line or in a block
    let blk = false;
    return lines(text).map((l) => l.replace(/\s*\/\/.*$/, "")).filter(Boolean).filter((l) => { if (blk) { if (l === ")") blk = false; return true; } if (/^(replace|use)\s*\($/.test(l)) { blk = true; return true; } return /^(replace|use)\s/.test(l); }).join("\n");
  }
  if (shared === "cargo") { // flatten every statement (multi-line arrays and inline tables included) to dotted leaf paths and judge each: patch/replace, dependency path=, any dependency git/package/registry/rev/branch/tag/workspace, test-steering keys
    const dep = /(^|\.)(dev-|build-)?dependencies(\.|$)/, pr = /^(patch|replace)(\.|$)/, TK = /^((lib|bin|test|bench|example)\.(test|harness|path|required-features|doctest)|package\.(autotests|build|workspace)|workspace\.(members|default-members|exclude)|profile\.(test\..*|.*\.(debug-assertions|overflow-checks)))$/, out: string[] = []; let sec = "";
    for (const st of cargoStmts(text)) {
      if (st[0] === "[") { const dbl = st.startsWith("[["), [k, j] = tomlKey2(st, dbl ? 2 : 1, false); if (st.slice(j).trim() !== (dbl ? "]]" : "]")) throw new Error("toml header"); sec = k; if (pr.test(sec) || KW.test(st)) out.push(`[${sec}]`); continue; }
      const [k, i] = tomlKey2(st);
      for (const [f, v] of tomlLeaves((sec ? sec + "." : "") + k, st.slice(i))) { const last = f.slice(f.lastIndexOf(".") + 1); if (KW.test(f + "=" + v) || pr.test(f) || TK.test(f) || (dep.test(f) && (last === "path" || /dependencies\..+\.(git|package|registry|rev|branch|tag|workspace)$/.test(f)))) out.push(`${f}=${v}`); }
    }
    return out.join("\n"); }
  if (shared === "tsconfig") { const j = jsonc(text) as { compilerOptions?: Record<string, unknown>; extends?: unknown }; const o = j.compilerOptions ?? {}; return JSON.stringify(["extends", "baseUrl", "paths", "rootDirs", "moduleSuffixes", "customConditions"].map((k) => (k === "extends" ? j["extends"] : o[k]))); }
  if (Array.isArray(shared)) { const j = JSON.parse(text) as Record<string, unknown>; return JSON.stringify([shared.map((k) => j[k]), depGuard(j)]); }
  let on = false;
  return lines(text).filter((l) => { if (/^\[[^\]]+\]$/.test(l)) on = (shared as RegExp).test(l); return on || KW.test(l); }).join("\n");
}
const baseText = (dir: string, base: string, f: string): string => { try { return safeGit(dir, ["show", `${base}:./${f}`], { timeout: 20000, maxBuffer: 64 << 20 }); } catch { return ""; } };
const headText = (dir: string, f: string): string => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };
/** An added or deleted file is an empty document. Changed files that steer the test runner (working tree vs base). A hit caps the verdict (NOT PROVEN), never decides one. Unparseable and
 *  changed means capped (fail closed). Files with no shared section (runner-only configs) count whenever they are listed as changed. */
export function testConfigChanged(repoDir: string, baseSha: string, changed: string[]): string[] {
  return changed.filter((f) => {
    const spec = RUNNER_CONFIGS.find((s) => s.re.test(f));
    if (!spec) return false;
    if (!spec.shared) return true;
    const b = baseText(repoDir, baseSha, f), h = headText(repoDir, f);
    if (b === h) return false;
    const e = typeof spec.shared === "string" && spec.shared !== "tsconfig" ? "" : "{}";
    try { return relevant(spec.shared, b || e) !== relevant(spec.shared, h || e); } catch { return true; }
  });
}
