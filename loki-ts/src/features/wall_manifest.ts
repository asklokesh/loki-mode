// Known gaps of the example exclusion: a test reaching a named module only through an index re-export, a task naming only a function, a tsconfig alias whose name shares no token with the target, string-concatenated specifiers, and import.meta.glob. Relative specifiers are resolved against the test directory, tests inside a target directory are excluded by location, literal dynamic forms are caught by the content backstop only when they contain a target stem, and a specifier resolving to an ancestor directory of a target is treated as naming it. Also not handled: workspace package-name imports (import from "p5") are not resolved; generic stems (index, main, app) get no content backstop, so a literal dynamic reference such as subprocess.run([..., 'main.py']) is not caught; CommonJS module.exports = function (or function f(){} plus exports.f = f) yields an empty signatures section. Dynamic gap also covers require(require.resolve('..')) and import(/* c */ '..').
// D77 (W1-S1): the sealed base-tree manifest the Wall reads instead of the repo. Pure: a file list in,
// signatures-only text out. It holds the detected runner and config, the test layout, at most two style
// examples that import no module the task names, and public signatures of the named modules. Function
// and method bodies never enter the output. TS/JS: only text before a body's opening brace, and a file whose
// lexing is undecidable emits nothing. Python: heads come from the stdlib ast in an isolated interpreter. Parameter and field defaults are always masked as `= ...`.
import { join } from "node:path";
import { pySignatures } from "../util/python.ts";
import { tsAmbiguous, tsSignatures } from "../util/ts_signatures.ts";
export interface ManifestFile { path: string; content: string }

export const MANIFEST_MAX_LINES = 400;
const MAX_EXAMPLES = 2;
const EXAMPLE_LINES = 40;
const MAX_LAYOUT = 60;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
// A style example needs a test FILENAME and a parseable source extension; a test directory alone never qualifies (W1-S2 r3).
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;
const EXAMPLE_EXT = /\.(py|[cm]?[jt]sx?)$/;
const baseOf = (p: string): string => p.split("/").pop() ?? p;
// One comparison form for stems (W1-S2 r6): lowercase, and "." "-" "_" runs collapse to one ".", so user-service equals user.service.
const normStem = (s: string): string => s.toLowerCase().replace(/[._-]+/g, ".").replace(/^\.|\.$/g, "");
// Content backstop (W1-S2 r7): any example whose text holds a non-generic target stem as a whole token is excluded.
const GENERIC_STEMS = ["index", "init", "mod", "main"];
const mentionsStem = (content: string, stems: string[]): boolean => {
  const c = content.toLowerCase().replace(/[._-]+/g, ".");
  return stems.some((s) => new RegExp(`(?<![a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(c));
};
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const resolveRel = (dir: string, spec: string): string => {
  const out = dir ? dir.split("/") : [];
  for (const seg of spec.split("/")) { if (seg === "" || seg === ".") continue; if (seg === "..") out.pop(); else out.push(seg); }
  return out.join("/");
};
const stemsOfTarget = (m: string): string[] => {
  const raw = stemOf(m).toLowerCase(), parent = m.split("/").slice(-2, -1)[0];
  return [normStem(raw), ...(["index", "__init__", "mod", "main"].includes(raw) && parent ? [normStem(parent)] : [])];
};
const norm = (s: string): string => s.replace(/\r\n?/g, "\n");
const stemOf = (p: string): string => (p.split("/").pop() ?? p).replace(/\.[^.]*$/, "");
const byPath = (a: ManifestFile, b: ManifestFile): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.content < b.content ? -1 : a.content > b.content ? 1 : 0;

function packageRunner(content: string): string | null {
  try {
    const pkg = JSON.parse(content) as { scripts?: { test?: string }; devDependencies?: Record<string, string> };
    const test = pkg.scripts?.test ?? "";
    const dev = Object.keys(pkg.devDependencies ?? {});
    const named = ["vitest", "jest", "mocha"].find((n) => test.includes(n) || dev.includes(n));
    return test.includes("bun test") ? "bun test" : (named ?? (test || null));
  } catch { return null; }
}
function pytestSection(content: string, header: RegExp): string[] {
  const lines = norm(content).split("\n");
  const at = lines.findIndex((l) => header.test(l));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const stop = rest.findIndex((l) => /^\s*\[/.test(l));
  return [lines[at]!, ...(stop < 0 ? rest : rest.slice(0, stop))].filter((l) => l.trim());
}

function runnerSection(files: ManifestFile[]): string[] {
  const out: string[] = [];
  const get = (re: RegExp): ManifestFile[] => files.filter((f) => re.test(f.path));
  const pkg = get(/^package\.json$/)[0];
  const js = pkg ? packageRunner(pkg.content) : null;
  if (js) out.push(`runner: ${js}`, "config: package.json (scripts.test only)");
  for (const f of get(/^(bunfig\.toml|(vitest|jest)\.config\.[cm]?[jt]s)$/)) out.push(`config: ${f.path}`, ...norm(f.content).split("\n").slice(0, 20));
  const py = [
    ...get(/^pytest\.ini$/).map((f) => ({ f, lines: norm(f.content).split("\n").filter((l) => l.trim()) })),
    ...get(/^pyproject\.toml$/).map((f) => ({ f, lines: pytestSection(f.content, /^\[tool\.pytest/) })),
    ...get(/^(setup\.cfg|tox\.ini)$/).map((f) => ({ f, lines: pytestSection(f.content, /^\[(tool:)?pytest\]/) })),
  ].filter((x) => x.lines.length);
  if (py.length || get(/(^|\/)test_[^/]*\.py$/).length) out.push("runner: pytest");
  for (const { f, lines } of py) out.push(`config: ${f.path}`, ...lines.slice(0, 20));
  if (get(/^go\.mod$/).length) out.push("runner: go test", "config: go.mod");
  if (get(/^Cargo\.toml$/).length) out.push("runner: cargo test", "config: Cargo.toml");
  return out.length ? out : ["runner: none detected"];
}

// True when a test file imports a module whose stem matches one the task names.
function importsNamed(path: string, raw: string, stems: Set<string>, importStems: Set<string> = stems, hits: (resolved: string) => boolean = () => false): boolean {
  const content = raw.replace(/^\uFEFF/, "").replace(/\\\n[ \t]*/g, " "); // one leading UTF-8 BOM is dropped (W1-S2 r14)
  // Whole-stem naming (W1-S2 r5): the test stem minus a .test/.spec suffix or a test_/_test affix equals a target stem or
  // extends it after a dot, so dotted and dashed stems (user.service, my-parser) match. Compared case-insensitively.
  const ts = stemOf(path).toLowerCase(), core = normStem(ts.replace(/[._-]?(test|spec)$/, "").replace(/^test[._-]/, ""));
  if ([...stems].some((s) => core === s || core.startsWith(`${s}.`) || ts.split(/[._-]/).includes(s))) return true;
  // PEP 263 (W1-S2 r14, r15): fail closed on a python file whose bytes we cannot trust to read like Python does. The wire decodes every file as UTF-8, so a latin-1/cp1252 body (or any U+FFFD) can hide a name that Python's NFKC reads as the target. Only utf-8 and ascii cookies (CPython aliases included) pass; [^\n]*? so U+2028/U+2029 cannot hide the cookie.
  if (/\.py$/i.test(path)) {
    if (content.includes("\uFFFD")) return true;
    const okCoding = new Set(["utf-8", "utf8", "utf", "u8", "ascii", "us-ascii", "646", "ansi-x3.4-1968", "ansi-x3.4-1986", "cp367", "csascii", "ibm367", "iso646-us", "iso-ir-6", "us"]);
    for (const line of content.split("\n", 2)) {
      const cookie = /^[ \t\f]*#[^\n]*?coding[:=][ \t]*([-\w.]+)/.exec(line);
      if (cookie && !okCoding.has(cookie[1]!.toLowerCase().replace(/_/g, "-"))) return true;
    }
  }
  const specs: string[] = [];
  for (const m of content.matchAll(/\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) specs.push(m[1]!);
  for (const m of content.matchAll(/\.(?:mock|doMock|unmock|importActual|requireActual|importMock|requireMock)\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) specs.push(m[1]!);
  // Python statement views (W1-S2 r10, r11): view 1 strips # comments outside quotes (backslash escapes skipped, triple quotes one token), view 2 is not comment-stripped (fail closed); both split on ; so each statement matches on its own.
  const stripComment = (l: string): string => {
    let q = "";
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      if (q) { if (c === "\\") i++; else if (l.startsWith(q, i)) { i += q.length - 1; q = ""; } continue; }
      if (c === '"' || c === "'") { q = l.startsWith(c.repeat(3), i) ? c.repeat(3) : c; i += q.length - 1; } else if (c === "#") return l.slice(0, i);
    }
    return l;
  };
  const pyText = content.normalize("NFKC"); // Python NFKC-normalises identifiers (W1-S2 r13)
  const views = [pyText.split("\n").map(stripComment).join("\n").replace(/;/g, "\n"), pyText.replace(/;/g, "\n")];
  const names = (list: string): string[] => list.split(",").map((n) => n.replace(/#.*$/gm, "").trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
  for (const py of views) {
    for (const m of py.matchAll(/(?:^|:)[ \t\f]*from[ \t\f]+([\w.]+?)(?:[ \t\f]+|(?<=\.)[ \t\f]*)import\b[ \t\f]*(?:\(([^)]*)\)|([^\n]*))/gm)) specs.push(m[1]!, ...names(m[2] ?? m[3] ?? ""));
    for (const m of py.matchAll(/(?:^|:)[ \t\f]*import[ \t\f]+([^\n#;]+?)[ \t\f]*(?:#.*)?$/gm)) specs.push(...names(m[1]!));
  }
  // Resolve every relative specifier against the test directory (JS ./ ../ . .. and Python leading dots).
  const dir = dirOf(path);
  if (specs.some((s) => s.trim().startsWith(".") && hits(resolveRel(dir, s.trim())))) return true;
  for (const py of views) for (const m of py.matchAll(/(?:^|:)[ \t\f]*from[ \t\f]+(\.+)([\w.]*?)[ \t\f]*\bimport\b[ \t\f]*(?:\(([^)]*)\)|([^\n]*))/gm)) {
    let base = dir;
    for (let i = 1; i < m[1]!.length; i++) base = dirOf(base);
    const r = resolveRel(base, (m[2] ?? "").replace(/\./g, "/"));
    if (hits(r) || names(m[3] ?? m[4] ?? "").some((n) => hits(resolveRel(r, n)))) return true;
  }
  const lastSeg = (s: string): string => normStem((s.trim().split(/[\\/]/).pop() ?? "").replace(/\.([cm]?[jt]sx?|py)$/i, "").replace(/^[#@~]+/, ""));
  return specs.some((s) => importStems.has(lastSeg(s)) || s.trim().replace(/\.(ts|js|py)$/, "").split(/[./\\]/).some((seg) => importStems.has(normStem(seg))));
}

function safeTs(content: string, path: string): string[] {
  const jsx = /\.[jt]sx$/.test(path);
  try { return tsAmbiguous(norm(content), jsx) ? [] : tsSignatures(content, jsx); } catch { return []; }
}

// taskModules: the (capped) modules whose signatures print. alsoNamed: EVERY task-matched path before any cap; it only
// feeds the example exclusion (basenames, stems, import checks), never the signature list (W1-S2 r4).
export function buildWallManifest(files: readonly ManifestFile[], taskModules: readonly string[], alsoNamed: readonly string[] = []): string {
  const all = [...files].sort(byPath).map((f) => ({ path: f.path.replace(/^\.\//, ""), content: norm(f.content) }));
  const mods = [...new Set(taskModules.map((m) => m.replace(/^\.\//, "")))].sort();
  const excl = [...new Set([...mods, ...alsoNamed.map((m) => m.replace(/^\.\//, ""))])];
  const stems = new Set(excl.flatMap(stemsOfTarget));
  const tests = all.filter((f) => TEST_PATH.test(f.path));
  const out: string[] = ["# wall manifest (D77): signatures only, from the base tree", "", "## runner", ...runnerSection(all)];
  out.push("", "## test layout", ...tests.slice(0, MAX_LAYOUT).map((f) => f.path));
  if (tests.length > MAX_LAYOUT) out.push(`... ${tests.length - MAX_LAYOUT} more test files`);
  for (const path of mods) {
    const f = all.find((x) => x.path === path);
    if (!f) continue;
    out.push("", `## signatures: ${path}`, ...(path.endsWith(".py") ? pySignatures(f.content) : safeTs(f.content, path)));
  }
  out.push("", "## style examples");
  const named = new Set(excl.flatMap((m) => [baseOf(m).toLowerCase(), ...stemsOfTarget(m)]));
  // A directory module is named by its parent in specifiers; a bare "./index" alone does not name an unrelated target.
  const importStems = new Set(excl.flatMap((m) => { const s = stemsOfTarget(m); return s.length > 1 ? s.slice(1) : s; }));
  // Resolved-path and location checks (W1-S2 r8, r9): a resolved import equal to a target minus extension, to a directory module's directory, or to any ancestor directory of a target (including the repo root) names it; over-exclusion is accepted.
  const info = excl.map((m) => ({ noext: m.replace(/\.[^./]*$/, "").toLowerCase(), dir: dirOf(m).toLowerCase(), mod: !!dirOf(m) && ["index", "__init__", "mod", "main"].includes(stemOf(m).toLowerCase()), src: !TEST_FILE.test(m) }));
  const hits = (r: string): boolean => {
    const low = r.toLowerCase().replace(/\.(?:[cm]?[jt]sx?|py)$/, "");
    return [low, low.replace(/\/(?:index|__init__|mod|main)$/, "")].some((v) => info.some((t) => v === t.noext || (t.mod && v === t.dir) || v === "" || t.noext.startsWith(`${v}/`)));
  };
  // Location backstop: inside a directory-module target's subtree, or beside a source-file target, is never an example (a task-named test file does not condemn its siblings).
  const inTargetArea = (p: string): boolean => { const d = dirOf(p).toLowerCase(); return info.some((t) => t.src && (d === t.dir || (t.mod && d.startsWith(`${t.dir}/`)))); };
  const backstop = [...stems].filter((s) => !GENERIC_STEMS.includes(s));
  const eligible = (t: ManifestFile): boolean => TEST_FILE.test(t.path) && EXAMPLE_EXT.test(t.path) && !named.has(baseOf(t.path).toLowerCase()) && !named.has(normStem(stemOf(t.path))) && !inTargetArea(t.path) && !importsNamed(t.path, t.content, stems, importStems, hits) && !mentionsStem(t.content, backstop);
  for (const f of tests.filter(eligible).slice(0, MAX_EXAMPLES)) {
    out.push(`--- example: ${f.path}`, ...f.content.split("\n").slice(0, EXAMPLE_LINES));
  }
  const lines = out.join("\n").split("\n");
  if (lines.length <= MANIFEST_MAX_LINES) return lines.join("\n");
  const keep = MANIFEST_MAX_LINES - 1;
  return [...lines.slice(0, keep), `... truncated: ${lines.length - keep} lines omitted`].join("\n");
}
