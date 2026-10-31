// FC-23 (L0): a package's module system, read with a parser from the JSON its own directory declares (JSONC comments and trailing commas,
// relative "extends"), by key and never by file name. null when the package declares nothing.
import { safeGitSpawn } from "../util/safe_git.ts";
import { loadProjectApi, siteFor } from "./resolve.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface PackageConventions {
  moduleSystem: "commonjs" | "esm";
  packageType: string | null; // the manifest "type" key, as written
  tsModule: string | null; // tsconfig compilerOptions.module, lowercased, following relative extends
  runner: string | null; // the Project Model's label for the package's test runner
}

/** JSONC to JSON: string-aware removal of // and block comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
const readJson = (p: string): Record<string, unknown> | null => {
  try { const v = parseJsonc(readFileSync(p, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
};

function moduleOf(file: string, depth = 0): string | null {
  const j = readJson(file);
  if (!j || depth > 4) return null;
  const m = (j.compilerOptions as Record<string, unknown> | undefined)?.module;
  if (typeof m === "string") return m.toLowerCase();
  const ext = typeof j.extends === "string" ? j.extends : null;
  if (!ext || !ext.startsWith(".")) return null;
  const next = join(dirname(file), ext.endsWith(".json") ? ext : `${ext}.json`);
  return existsSync(next) ? moduleOf(next, depth + 1) : null;
}

/** Reads what the package's own JSON files declare, by key and never by file name: a "type" key on a manifest-shaped file (it also has "name"),
 *  and compilerOptions.module on the shortest-named file that declares one. No declaration, no convention (null): the Wall is never told a guess. */
export function readPackageConventions(pkgDir: string, runner: string | null = null): PackageConventions | null {
  let names: string[] = [];
  try { names = readdirSync(pkgDir).filter((f) => f.endsWith(".json")).sort((x, y) => x.length - y.length || x.localeCompare(y)); } catch { return null; }
  let packageType: string | null = null, tsModule: string | null = null;
  for (const n of names) {
    const j = readJson(join(pkgDir, n));
    if (!j) continue;
    if (packageType === null && typeof j.type === "string" && typeof j.name === "string") packageType = j.type;
    if (tsModule === null && j.compilerOptions !== undefined) tsModule = moduleOf(join(pkgDir, n));
  }
  if (packageType === null && tsModule === null) return null;
  const esmType = packageType === "module";
  // node16/nodenext follow the manifest type; commonjs, amd, umd and system emit CommonJS-style output, where import.meta is TS1470.
  const moduleSystem = tsModule === null || tsModule === "node16" || tsModule === "nodenext" ? (esmType ? "esm" : "commonjs") : /^(commonjs|amd|umd|system)$/.test(tsModule) ? "commonjs" : "esm";
  return { moduleSystem, packageType, tsModule, runner };
}

/** The Wall brief paragraph for a package; empty when nothing is declared. */
export function conventionsBrief(c: PackageConventions | null): string {
  if (!c) return "";
  const decl = `manifest type: ${c.packageType ?? "(unset)"}, compiler module: ${c.tsModule ?? "(unset)"}${c.runner ? `, test runner: ${c.runner}` : ""}`;
  return c.moduleSystem === "commonjs"
    ? `Package conventions (${decl}): this package compiles as CommonJS. Never use import.meta or top-level await (TS1470, the package's own tsc rejects them); use __dirname and __filename for paths. In files the package's own compiler processes write import statements (they compile to CommonJS) and never require(): a package lint config commonly forbids require() and runs over your file; use require() only in plain .js or .cjs files.`
    : `Package conventions (${decl}): this package is ES modules. Use import syntax; use import.meta.url for file locations; never use require(), __dirname or __filename.`;
}

/** A generated Wall file the package's own compiler would reject (import.meta under CommonJS); null when it is fine. Comments and strings are ignored. */
export function conventionViolation(c: PackageConventions | null, fileName: string, content: string): string | null {
  if (!c || c.moduleSystem !== "commonjs" || !/\.[cm]?[jt]sx?$/.test(fileName) || /\.m[jt]s$/.test(fileName)) return null;
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  return /\bimport\.meta\b/.test(code) ? "import.meta is not allowed in a CommonJS package (TS1470)" : null;
}

/** FC-WALL-OUT-OF-REPO-TARGET: a test that locates the code under test through the user home (an installed copy) instead of the repo. Flags a home-derived value (homedir, Path.home, expanduser, $HOME, ~/) that is joined into an import/require/source/spawn/exec target or a dot-directory path, outside expect/assert lines. A quoted absolute home literal (/Users, /home, /root, C:\\Users) that is itself the target of a from/import/require/source line is also flagged; plain string literals are not. Lines from the first HOME assignment on are sandboxed and not flagged. Comments ignored; null when clean. */
export function outOfRepoTarget(content: string): string | null {
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/(^|\s)#.*$/gm, "$1");
  const lines = code.split("\n"), at = lines.findIndex((l) => /\bprocess\.env\.(HOME|USERPROFILE)\s*=(?!=)|\benv\[\s*["'](HOME|USERPROFILE)["']\s*\]\s*=(?!=)|^\s*(export\s+)?(HOME|USERPROFILE)=|\bexport\s+(HOME|USERPROFILE)\b|\bsetenv\(\s*["'](HOME|USERPROFILE)["']|\benv\s*:\s*\{[^}]*\b(HOME|USERPROFILE)\s*:|\bpatch\.dict\([^)]*["'](HOME|USERPROFILE)["']/.test(l)); // the exemption starts at the HOME assignment
  const home = /\bhomedir\s*\(|\bPath\.home\s*\(|\bexpanduser\s*\(|\$\{?HOME\b|\$\{?USERPROFILE\b|\bprocess\.env\.(HOME|USERPROFILE)\b|["'`]~\//;
  const HOMELIT = String.raw`(?:file:\/\/)?(?:\/(?:Users|home|root)\/|[A-Za-z]:\\+Users\\)`;
  const literalTarget = new RegExp(String.raw`\b(?:from|import|require)\s*\(?\s*["'`+"`"+String.raw`]${HOMELIT}|^\s*(?:source|\.)\s+["']?${HOMELIT}`);
  const locates = /["'`\/]\.[A-Za-z][\w-]*(?:[\/"'`]|$)|\b(?:import|require|source|spawn\w*|exec\w*|pathToFileURL|readFile\w*)\b/;
  for (const line of lines.slice(0, at < 0 ? lines.length : at)) {
    if (/^\s*(?:await\s+)?(?:expect|assert\w*)\b/.test(line)) continue;
    if ((home.test(line) && locates.test(line)) || literalTarget.test(line)) return "resolves the code under test outside the repo via a home-directory path; target repo-relative paths (relative to this test file or the repo root) so the check exercises the change";
  }
  return null;
}

/** Go: true when the file has Test funcs, every body is empty or only t.Log/t.Skip calls, and nothing in the file can fail a test. Linear brace scan, no backtracking regex over the body. */
function goVacuous(code: string): boolean {
  if (/\b\w+\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow|Run)\b/.test(code)) return false;
  const head = /func\s+(?:Test|Fuzz)\w*\(\s*\w+\s+\*testing\.[TF]\s*\)\s*\{/g, trivialStmt = /^\w+\.(?:Log|Logf|Skip|Skipf|SkipNow)\(.*\)$/;
  let m: RegExpExecArray | null, n = 0;
  while ((m = head.exec(code))) {
    let d = 1, i = head.lastIndex, q = "";
    for (; i < code.length && d > 0; i++) { const c = code[i]!; if (q) { if (c === "\\" && q !== "`") i++; else if (c === q) q = ""; } else if (c === '"' || c === "'" || c === "`") q = c; else if (c === "{") d++; else if (c === "}") d--; }
    if (d > 0) return false;
    const body = code.slice(head.lastIndex, i - 1);
    if (/[{}]/.test(body.replace(/"(?:\\.|[^"\\\n])*"|`[^`]*`|'(?:\\.|[^'\\\n])*'/g, ""))) return false;
    if (!body.split(/[\n;]/).map((x) => x.trim()).filter(Boolean).every((x) => trivialStmt.test(x))) return false;
    head.lastIndex = i; n++;
  }
  return n > 0;
}

/** One lexical pass over Go source, in source order: comments are blanked and each string, raw string and rune literal is replaced by a numbered placeholder (`"\u0001N"`), so a comment marker inside a string, or a quote inside a comment, can never be misread. */
function goLex(src: string): { masked: string; strs: string[] } {
  const strs: string[] = []; let out = "", i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2), end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; }
    else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1; while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) j += c !== "`" && src[j] === "\\" ? 2 : 1;
      out += c === "'" ? "0" : `"\u0001${strs.push(src.slice(i + 1, j))}"`;
      i = j + 1;
    } else { out += c; i++; }
  }
  return { masked: out, strs };
}
const goClose = (t: string, at: number): number => { const o = t[at]!, c = o === "(" ? ")" : o === "[" ? "]" : "}"; let d = 0; for (let j = at; j < t.length; j++) { if (t[j] === o) d++; else if (t[j] === c && --d === 0) return j; } return -1; };
/** Names declared by one Go parameter, result or type-parameter list: in the named form a lone entry shares the type that follows (`a, b int`), in the unnamed form every entry is a type. */
function goGroupNames(list: string): string[] {
  const segs: string[] = []; let d = 0, cur = "";
  for (const ch of list) { if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--; if (ch === "," && d === 0) { segs.push(cur); cur = ""; } else cur += ch; }
  segs.push(cur);
  const toks = segs.map((s) => s.trim().split(/\s+/).filter(Boolean)), named = toks.some((t) => t.length >= 2);
  return toks.flatMap((t) => (named || t.length >= 2) && /^[A-Za-z_]\w*$/.test(t[0] ?? "") ? [t[0]!] : []);
}
/** Go: a Test or Fuzz file with a package clause that never references the package under test. An external `package x_test` must import the package it tests and use it (a dot import of that package is not judged); a same-package test must use an identifier it does not itself declare (its imports, parameters and results, type parameters, locals, var/const names, fields and keywords excluded; with a dot import present only lowercase names count, since a dot import brings in exported names only). Comments and string/rune literals are removed in one pass first. Files without a package clause or a Test/Fuzz func are not judged. */
function goUnreferenced(src: string): boolean {
  const { masked, strs } = goLex(src), code = masked.replace(/"\u0001\d+"/g, '""');
  const pkg = /^\s*package\s+(\w+)/m.exec(code);
  if (!pkg || !/\bfunc\s+(?:Test|Fuzz)\w*\s*\(/.test(code)) return false;
  const specs: { alias: string; path: string }[] = [];
  for (const d of masked.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)|^[ \t]*import[ \t]+([^\n(]*)$/gm)) for (const l of (d[1] ?? d[2] ?? "").split("\n")) { const m = /^[ \t]*(?:([\w.]+)[ \t]+)?"\u0001(\d+)"[ \t;]*$/.exec(l); if (m) specs.push({ alias: m[1] ?? "", path: strs[Number(m[2]) - 1]! }); }
  const lastOf = (p: string): string => { const parts = p.split("/"); let l = parts.pop()!; if (/^v\d+$/.test(l) && parts.length) l = parts.pop()!; return l; };
  const norm = (l: string): string => l.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const body = code.replace(/^\s*import\s*\([\s\S]*?\)/gm, " ").replace(/^\s*import\b.*$/gm, " ");
  const dots = specs.filter((s) => s.alias === ".");
  if (pkg[1]!.endsWith("_test")) {
    const x = pkg[1]!.slice(0, -5), named = (p: string): boolean => [x, "go" + x, x + "go"].includes(norm(lastOf(p))); // go-x, x-go, x.go, x/v2 all name package x
    const mine = specs.filter((s) => s.alias === x || (s.alias !== "_" && named(s.path)));
    if (mine.some((s) => s.alias === ".")) return false;
    return !mine.some((s) => { const nm = s.alias || x; return new RegExp(String.raw`(?<![\w.])${nm}\s*\.\s*[A-Za-z_]`).test(body); });
  }
  const own = new Set<string>(["_", pkg[1]!, "true", "false", "nil", "iota"]);
  for (const w of "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr append cap clear close complex copy delete imag len make max min new panic print println real recover".split(" ")) own.add(w);
  for (const s of specs) if (s.alias !== ".") own.add(s.alias && s.alias !== "_" ? s.alias : norm(lastOf(s.path)) || lastOf(s.path)), own.add(lastOf(s.path).replace(/[^\w]/g, "")), own.add(norm(lastOf(s.path).replace(/^go-|-go$|\.go$/g, "")));
  const names = (t: string): string[] => t.match(/[A-Za-z_]\w*/g) ?? [];
  for (const m of body.matchAll(/\b(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g)) own.add(m[1]!);
  for (const m of body.matchAll(/\b(?:var|const)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/g)) names(m[1]!).forEach((n) => own.add(n));
  for (const m of body.matchAll(/^\s*(?:var|const)\s*\(([\s\S]*?)\n\s*\)/gm)) for (const l of m[1]!.split("\n")) { const d = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/.exec(l); if (d) names(d[1]!).forEach((n) => own.add(n)); }
  for (const m of body.matchAll(/([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/g)) names(m[1]!).forEach((n) => own.add(n));
  for (const m of body.matchAll(/^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+[\w*\[\]{}.]+\s*$/gm)) names(m[1]!).forEach((n) => own.add(n)); // struct field declarations
  for (const m of body.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*:(?!=)/gm)) own.add(m[1]!); // keyed literal fields and labels
  const bracket = (at: number): number => { let j = at; while (/\s/.test(body[j] ?? "")) j++; if (body[j] === "[") { const e = goClose(body, j); if (e > 0) { goGroupNames(body.slice(j + 1, e)).forEach((n) => own.add(n)); return e + 1; } } return at; }; // type parameters
  for (const m of body.matchAll(/\btype\s+[A-Za-z_]\w*/g)) bracket(m.index! + m[0].length);
  for (const m of body.matchAll(/\bfunc\b/g)) {
    let j = m.index! + 4; while (/\s/.test(body[j] ?? "")) j++;
    const grab = (at: number): number => { const e = goClose(body, at); if (e < 0) return body.length; goGroupNames(body.slice(at + 1, e)).forEach((n) => own.add(n)); return e + 1; };
    if (body[j] === "(") {
      let k = grab(j); while (/\s/.test(body[k] ?? "")) k++;
      if (/[A-Za-z_]/.test(body[k] ?? "")) { const nm = /^[A-Za-z_]\w*/.exec(body.slice(k))![0]; k = bracket(k + nm.length); while (/\s/.test(body[k] ?? "")) k++; if (body[k] === "(") k = grab(k); } // receiver, name, params
      while (/\s/.test(body[k] ?? "")) k++; if (body[k] === "(") grab(k); // results
    } else if (/[A-Za-z_]/.test(body[j] ?? "")) {
      const nm = /^[A-Za-z_]\w*/.exec(body.slice(j))![0]; let k = bracket(j + nm.length); while (/\s/.test(body[k] ?? "")) k++;
      if (body[k] === "(") { k = grab(k); while (/\s/.test(body[k] ?? "")) k++; if (body[k] === "(") grab(k); }
    }
  }
  const lowerOnly = dots.length > 0;
  for (const m of body.matchAll(/(?<![\w.])([A-Za-z_]\w*)/g)) if (!own.has(m[1]!) && !(lowerOnly && /^[A-Z]/.test(m[1]!))) return false;
  return true;
}

/** TEN-MOAT-26: a generated Wall file that asserts nothing: its only assertions are tautologies (expect(true).toBe(true), assert True), its tests have empty bodies, or a shell file holds only true / exit 0 / ":". Such a file can never fail, so it proves nothing about the change. A JS/Python file with no tautology and no assertion but real calls is NOT flagged (it can still be red by throwing); a file that holds a tautology and no real assertion is flagged even if it also calls code. Go is judged per file: flagged only when every Test func body is empty or only t.Log/t.Skip and nothing can fail a test. Comments are ignored. Returns the reason, or null when the file is acceptable or its language is not recognised. */
export function vacuousCheck(fileName: string, content: string): string | null {
  const reason = "asserts nothing (no assertion, or only an always-true one such as true or exit 0); write a check that fails when the behavior is absent";
  const strip = (re: RegExp): string => content.replace(/\/\*[\s\S]*?\*\//g, "").replace(re, "$1");
  if (/\.[cm]?[jt]sx?$/.test(fileName)) {
    const code = strip(/(^|[^:])\/\/.*$/gm);
    const lit = String.raw`(?:true|false|null|undefined|\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*')`;
    const taut = new RegExp(String.raw`\b(?:expect\(\s*(${lit})\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)|expect\(\s*(?:true|[1-9]\d*|"[^"\n]+"|'[^'\n]+')\s*\)\s*\.\s*(?:toBeTruthy|toBeDefined)\(\s*\)|expect\(\s*false\s*\)\s*\.\s*toBeFalsy\(\s*\)|(?:assert|assert\.ok|assert\.equal|assert\.strictEqual)\(\s*(?:true|1|(${lit})\s*,\s*\2)\s*\))`);
    const tautAll = new RegExp(taut.source, "g"); // judged per assertion: a tautology is removed and what remains on the line must still hold a real assertion
    const real = code.split("\n").some((l) => /\b(?:expect|assert\w*|should|fail)\s*[(.]|\bt\.(?:is|true|ok|equal|deepEqual|throws)\b|\bthrow\b/.test(l.replace(tautAll, "")));
    return !real && (code.split("\n").some((l) => taut.test(l)) || /(?:=>|function\s*\([^)]*\))\s*\{\s*\}\s*\)/.test(code)) ? reason : null;
  }
  if (/\.py$/.test(fileName)) {
    const code = strip(/(^|\s)#.*$/gm);
    const pylit = String.raw`(?:True|[1-9]\d*|"[^"\n]+"|'[^'\n]+')`;
    const wrap = (x: string): string => String.raw`(?:\(\s*)*${x}(?:\s*\))*`; // CCR-06: a rendered `assert (True)` or `assert (1) == (1)` is the same tautology; each starts with a literal paren so there is no ambiguity
    const PYTAUT0 = new RegExp(String.raw`^(?:assert(?:\s+|(?=\())(?:${wrap(pylit)}|${wrap("([1-9]\\d*)")}\s*==\s*${wrap("\\1")})(?:\s*,.*)?|(?:self\.)?assertTrue\(\s*${wrap(pylit)}\s*\)|(?:self\.)?assertEqual\(\s*${wrap("(" + pylit + ")")}\s*,\s*${wrap("\\2")}\s*\))$`);
    const PYTAUT = { test: (l: string): boolean => PYTAUT0.test(l.trim()) }; // lines are trimmed first so no pattern carries adjacent whitespace quantifiers (quadratic on a near-miss)
    const real = code.split("\n").some((l) => /\bassert\b|\bself\.assert\w*\(|\bpytest\.(?:raises|fail)\b|\braise\b|\bfail\(/.test(l) && !PYTAUT.test(l));
    return !real && (code.split("\n").some((l) => PYTAUT.test(l)) || /def\s+test\w*\([^)]*\):\s*(?:pass|\.\.\.)\s*$/m.test(code)) ? reason : null;
  }
  if (/\.(?:sh|bash)$/.test(fileName)) {
    const lines = strip(/(^|\s)#.*$/gm).split("\n").map((l) => l.trim()).filter((l) => l && !/^set\s+-/.test(l));
    const tok = String.raw`(?:"[^"$\x60\\\n]*"|'[^'\n]*'|[^\s"'$\x60\\|&;<>(){}*?~-][^\s"'$\x60\\|&;<>(){}*?]*)`; // one quoted or bare literal word: no expansion, glob, redirect or option
    const trivial = new RegExp(String.raw`^(?:true|:|exit\s+0|return\s+0|(?:/usr)?/bin/true|(?:echo|printf)(?:\s+${tok})*|test\s+(?:[1-9]\d*|${tok})|\[\[?\s+(?:[1-9]\d*|${tok})\s+\]\]?)$`);
    return lines.length === 0 || lines.every((l) => l.split(/&&|\|\||;/).map((x) => x.trim()).every((x) => x === "" || trivial.test(x))) ? reason : null;
  }
  if (/_test\.go$/.test(fileName)) return goVacuous(strip(/(^|[^:])\/\/.*$/gm)) ? reason : goUnreferenced(content) ? "never references the package under test (an external _test package must import and use it; a same-package test must use an identifier the package declares outside this file); write a check that calls the changed code" : null;
  return null;
}

/** The shared re-ask text for files rejected by the out-of-repo checks (Wall and the implement repro test): the lead says what to rewrite, then each rejected name with its reason. */
export const outOfRepoReask = (lead: string, bad: { name: string; why: string }[]): string => [`${lead} Each was rejected:\n${bad.map((b) => `- ${b.name}: ${b.why}`).join("\n")}`, `Point every reference at the repository code with repo-relative paths (for example join(import.meta.dir, "..", "<repo path>") or the equivalent for this runner). Do not read the home directory, $HOME or an environment variable that falls back to one. Write nothing else.`].join("\n\n");

/** TEN-QUALITY-44: the changed test-like files (repo-relative names) that fail outOfRepoTarget. */
export const outOfRepoTests = (repoDir: string, changed: string[]): { name: string; why: string }[] => changed.filter((f) => /(^|[\/._-])(test|spec)s?[\/._-]|_test\./i.test(f) && existsSync(join(repoDir, f))).flatMap((name) => { const why = outOfRepoTarget(readFileSync(join(repoDir, name), "utf8")); return why ? [{ name, why }] : []; });

/** The package root verify runs a test file in. A known project model is trusted fully (its package cwd, else the repo root). Without one, the nearest directory at or above the test dir holding a manifest-shaped JSON file (a string "name" plus another key, by shape and never by file name, as readPackageConventions does); config files (compiler, linter, test-runner) are never roots, so they cannot hide a real phantom. No manifest file name is hardcoded (L0). */
function nearestPackageRoot(testDir: string, repoDir: string, fileName: string): string {
  const api = loadProjectApi(repoDir);
  if (api) return siteFor(api, repoDir, relative(repoDir, join(testDir, fileName)))?.cwd ?? repoDir;
  const shaped = (d: string): boolean => { try { return readdirSync(d).some((f) => { if (!f.endsWith(".json")) return false; const j = readJson(join(d, f)); return !!j && typeof j.name === "string" && Object.keys(j).length > 1; }); } catch { return false; } };
  let pkg = testDir; while (pkg !== repoDir && pkg !== dirname(pkg) && !shaped(pkg)) pkg = dirname(pkg);
  return pkg;
}
const CREATORS = /\b(?:mkdirSync|writeFileSync|appendFileSync|cpSync|copyFileSync|renameSync|symlinkSync|mkdir|writeFile|appendFile|cp|copyFile|rename|outputFile|ensureDir|mkdirp)\(/g;

/** FC-WALL-PHANTOM-PATH: repo paths a JS/TS test builds with join/resolve from the test dir, the cwd or a const derived from them (const assignments followed, calls split across lines joined) that do not exist in the base tree. process.cwd() is tried as the nearest package root of the test dir (verify runs a package's tests there) and as the repo root; a path existing under either passes. A path the plan names, creates (mkdir/write/cp/rename target), or that git ignores passes; write/expect/tmp lines are ignored. A path that stays inside the test dir is reported only when its first segment is absent from the test dir but present at the package or repo root (tests/plugins/x for plugins/x); fixtures the test dir lacks stay unreported. Returns repo-relative missing paths (max 3). */
export function phantomRepoPaths(content: string, fileName: string, testDir: string, repoDir: string, planText: string | null): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(fileName)) return [];
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\n\s*/g, ", ").replace(/=\s*\n\s*/g, "= ");
  const walkCode = /\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+of\s*\[/.test(code) ? code.replace(/([;{])[ \t]*(?=(?:const|let|var)\s)/g, "$1\n") : code; // a walk-up loop: statements sharing a line are split so each binding is followed
  const pkg = nearestPackageRoot(testDir, repoDir, fileName);
  const split = (s: string): string[] => { const out: string[] = []; let d = 0, q = "", cur = ""; for (let i = 0; i < s.length; i++) { const c = s[i]!; if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = ""; } else if (c === '"' || c === "'" || c === "`") { q = c; cur += c; } else if ("([{".includes(c)) { d++; cur += c; } else if (")]}".includes(c)) { d--; cur += c; } else if (c === "," && d === 0) { out.push(cur); cur = ""; } else cur += c; } if (cur.trim()) out.push(cur); return out; };
  const close = (line: string, at: number): number => { let d = 0; for (let j = at; j < line.length; j++) { if (line[j] === "(") d++; else if (line[j] === ")" && --d === 0) return j; } return -1; };
  const strayInTestDir = (out: string): boolean => { const first = relative(testDir, out).split("/")[0]!; return !!first && first !== "__self__" && !existsSync(join(testDir, first)) && [pkg, repoDir].some((d) => d !== testDir && existsSync(join(d, first))); }; // inside the test dir but the first segment only exists at a repo root: the author meant a repo path
  const scan = (cwd: string): { reports: Map<string, { out: string; rel: string; tail?: string }>; created: string[] } => {
    const vars = new Map<string, string>(), walk = new Set<string>(), taint = new Set<string>(), reports = new Map<string, { out: string; rel: string; tail?: string }>(), created: string[] = []; let ln = 0; // reports are keyed by source line and call text so two cwd runs pair the same call
    const ev = (raw: string, report: boolean): string | null => {
      const e = raw.trim().replace(/^await\s+/, "").replace(/\s+as\s+\w+$/, "").replace(/!$/, "");
      if (/^import\.meta\.(dir|dirname)$|^__dirname$/.test(e)) return testDir;
      if (e === "process.cwd()") return cwd;
      const env = /^process\.env(?:\.[\w$]+|\[[^\]]+\])\s*(?:\?\?|\|\|)\s*([\s\S]+)$/.exec(e); if (env) return ev(env[1]!, report); // an env override is unset in the run: the fallback is the value
      if (e === "fileURLToPath(import.meta.url)" || e === "__filename") return join(testDir, "__self__");
      const url = /^fileURLToPath\(new URL\((["'])([^"']*)\1\s*,\s*import\.meta\.url\)\)$/.exec(e); if (url) return resolve(testDir, url[2]!);
      const lit = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(e); if (lit) return lit[2]!.includes("${") ? null : lit[2]!;
      if (/^[A-Za-z_$][\w$]*$/.test(e)) return vars.get(e) ?? null;
      const call = /^(?:path\.)?(join|resolve|dirname)\(([\s\S]*)\)$/.exec(e); if (!call) return null;
      const parts = split(call[2]!), args = parts.map((a) => ev(a, report)); if (args.some((a) => a === null)) return null;
      if (call[1] === "dirname") return dirname(args[0]!);
      const out = resolve(...(args as string[]));
      const first = parts.slice(1).map((a) => /^\s*["'`]([^"'`]*)["'`]\s*$/.exec(a)?.[1]).find((x) => x), viaWalk = !!first && walk.has(parts[0]!.trim()) && [pkg, repoDir].some((d) => existsSync(join(d, first.split("/").filter(Boolean)[0] ?? "\0"))); // a walk-up base reaches the repo root: the first literal segment is checked there (absent everywhere keeps the old silence)
      if (report && (viaWalk || (!parts.some((a) => walk.has(a.trim()) || taint.has(a.trim())) && (relative(testDir, out).startsWith("..") || strayInTestDir(out)))) && parts.some((a) => /^\s*["'`]/.test(a))) reports.set(`${ln}|${e}`, { out, rel: relative(repoDir, out), tail: viaWalk ? join(...(args.slice(1) as string[])) : undefined });
      return out;
    };
    for (const line of walkCode.split("\n")) {
      ln++;
      for (const m of line.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g)) { const seeds = split(m[2]!).map((x) => ev(x, false)); if (seeds.length && seeds.every((x) => x === cwd || x === testDir)) { vars.set(m[1]!, cwd); walk.add(m[1]!); } } // loop variable whose every item is the cwd or the test dir: a walk-up start (repo-relative strings and joins stay unresolved)
      const wasg = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?\s*$/.exec(line); if (wasg && walk.has(wasg[2]!)) walk.add(wasg[1]!); // dir = resolve(start) keeps the walk base
      for (const m of line.matchAll(CREATORS)) { const j = close(line, m.index! + m[0].length - 1); if (j > 0) for (const a of split(line.slice(m.index! + m[0].length, j))) { const v = ev(a, false); if (v) created.push(v); } }
      const skip = /^\s*(?:await\s+)?(?:expect|assert\w*)\b|\b(?:write\w*|mkdir\w*|rm\w*|cp\w*|copy\w*|rename\w*|symlink\w*|mkdtemp\w*|tmpdir|outputFile|touch)\b/.test(line);
      const asg = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+?);?\s*$/.exec(line);
      if (asg && /[A-Za-z_$][\w$]*/.test(asg[2]!) && [...asg[2]!.matchAll(/[A-Za-z_$][\w$]*/g)].some((w) => walk.has(w[0]) || taint.has(w[0]))) taint.add(asg[1]!); // built on a walk-up base: only the walk rule reports it
      if (asg) { const v = ev(asg[2]!, !skip); if (v !== null) vars.set(asg[1]!, v); continue; }
      if (skip) continue;
      for (const m of line.matchAll(/(?:path\.)?(?:join|resolve)\(/g)) { const j = close(line, m.index! + m[0].length - 1); if (j > 0) ev(line.slice(m.index!, j + 1), true); }
    }
    return { reports, created };
  };
  const runs = [...new Set([pkg, repoDir])].map(scan);
  const planned = (rel: string): boolean => !!planText && rel.split("/").some((_, i, a) => { const pre = a.slice(0, i + 1).join("/"); return (i > 0 || a.length === 1) && !existsSync(join(repoDir, pre)) && new RegExp(`(?<![\\w-])${pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(planText); }); // only a path named with its parent (plugins/ralph-loop) is planned, never a bare segment or basename
  const phantom = (r: { out: string; rel: string; tail?: string }, created: string[]): boolean => {
    const rel = r.rel; if (!rel || rel.startsWith("..") || isAbsolute(rel) || /(^|\/)(\.git|\.loki|dist|build|coverage|tmp)(\/|$)/.test(rel) || existsSync(r.out) || planned(rel)) return false;
    if (r.tail) { const seen = (from: string): boolean => { let d = from; for (let i = 0; i < 64; i++) { if (existsSync(join(d, r.tail!))) return true; if (d === repoDir || d === dirname(d)) return false; d = dirname(d); } return false; }; if ([testDir, pkg, repoDir].some(seen)) return false; } // a walk-up path found at any directory the walk passes (test dir or package root, up to the repo root) is real
    if (created.some((c) => c === r.out || c.startsWith(r.out + "/") || r.out.startsWith(c + "/"))) return false;
    return safeGitSpawn(repoDir, ["check-ignore", "-q", "--", rel], { timeout: 5000 }).status !== 0;
  };
  const missing: string[] = [];
  for (const [k, r] of runs[0]!.reports) if (runs.every((x) => x.reports.has(k) && phantom(x.reports.get(k)!, x.created)) && !missing.includes(r.rel)) missing.push(r.rel);
  return missing.filter((m) => !missing.some((o) => o !== m && m.startsWith(o + "/"))).slice(0, 3);
}

/** FC-WALL-PHANTOM-PATH: the re-ask text (null when nothing is missing) for a phantom Wall file; the hint names real paths holding a segment with the same name, so a missing directory finds its real home too. */
export function phantomReason(miss: string[], repoFiles: string[], testDir = "", pkgRoot = ""): string | null {
  if (miss.length === 0) return null;
  const real = (r: string): boolean => !!r && repoFiles.some((f) => f === r || f.startsWith(`${r}/`)), pkg = pkgRoot === "." ? "" : pkgRoot; // FC-WALL-LOCATION-BLIND: a phantom that is the test dir plus a path real at the repo root or the package root
  const at = (m: string): string | null => { const r = testDir && m.startsWith(`${testDir}/`) ? m.slice(testDir.length + 1) : ""; return !r ? null : real(r) ? `${r} exists relative to the repo root` : pkg && real(`${pkg}/${r}`) ? `${r} exists relative to the package root ${pkg}/` : null; };
  const own = miss.map((m) => [m, at(m)] as const), loc = own.filter(([, w]) => w).map(([, w]) => w!), rest = own.filter(([, w]) => !w).map(([m]) => m);
  const hint = (m: string): string => { const n = basename(m), near = [...new Set(repoFiles.flatMap((f) => { const s = f.split("/"), k = s.indexOf(n); return k >= 0 && s.slice(0, k + 1).join("/") !== m ? [s.slice(0, k + 1).join("/")] : []; }))].slice(0, 3); return near.length ? `${m} (a path named ${n} exists at ${near.join(", ")})` : m; };
  const wrong = loc.length ? `references repo path(s) built from the wrong directory: your test file is copied to ${testDir}/, so __dirname and import.meta.dir are that directory, not the repo root; ${loc.join("; ")}. Compute the root from ${testDir}/ (go up ${testDir.split("/").length} level(s)) or use process.cwd() only if the runner starts at the root, and build every repo path from it` : "", typo = rest.length ? `references repo path(s) that do not exist in the repository and that the plan does not create: ${rest.map(hint).join("; ")}. Locate the real code by searching the repository; do not copy a name from the task text as a path` : "";
  return [wrong, typo].filter(Boolean).join(". Also, it ");
}
