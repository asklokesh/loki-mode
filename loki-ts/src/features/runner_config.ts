// D86 FC-09r: the one registry of files that steer how tests run or resolve code. A run that changes the runner-relevant part of one
// cannot seal VERIFIED (the agent could be mocking the code under test). Shared files (package.json, go.mod, Cargo.toml, ...) are
// compared base vs head by section, so a dependency bump is not config but a pretest edit, a go.mod replace or a tsconfig path is.
import { createHash } from "node:crypto"; import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { safeGit } from "../util/safe_git";
import { exportConds } from "../util/lock_ecosystems";
type Sections = RegExp | readonly string[] | "go" | "tsconfig" | "cargo"; interface Spec { re: RegExp; shared?: Sections }
const PKG_KEYS = ["scripts", "jest", "overrides", "resolutions", "imports", "pnpm", "mocha", "vitest", "ava", "c8", "nyc", "babel", "bun", "patchedDependencies"] as const; // scripts is compared whole: pretest, posttest and test:* all count
// FC-09w: macOS filesystems are case-insensitive, so PNPM-Workspace.yaml is read by pnpm. Every row is forced case-insensitive below, in one place.
const RAW_CONFIGS: Spec[] = [
  { re: /(^|\/)(conftest\.py|(site|user)customize\.py|tox\.ini|bunfig\.toml|\.?pytest\.(ini|toml)|\.mocharc[\w.]*)$/ },
  { re: /(^|\/)(vitest|vite|jest)\.(config|workspace)\.[\w.]+$/ },
  { re: /(^|\/)\.cargo\/config(\.toml)?$/ },
  { re: /(^|\/)(site|dist)-packages\/[^/]+\.pth$/ }, // Python runs import lines in a site-packages .pth at startup; a .pth elsewhere (model weights) is not config
  { re: /(^|\/)(babel\.config\.[\w.]+|\.babelrc(\.[\w]+)?|\.pnpmfile\.(cjs|mjs))$/ },
  { re: /(^|\/)package\.json$/, shared: PKG_KEYS },
  { re: /(^|\/)(pnpm-workspace\.yaml|\.yarnrc\.yml|\.npmrc)$/ }, // D101: YAML parsers disagree (Bun.YAML vs js-yaml 4), so any byte change caps, no parsed comparison
  { re: /(^|\/)patches\/|\.patch$/ }, // patchedDependencies targets: a changed patch rewrites installed dependency code
  { re: /(^|\/)pyproject\.toml$/, shared: /^\[tool\.pytest/ },
  { re: /(^|\/)setup\.cfg$/, shared: /^\[tool:pytest\]/ },
  { re: /(^|\/)go\.(mod|work)$/, shared: "go" },
  { re: /(^|\/)Cargo\.toml$/, shared: "cargo" },
  { re: /(^|\/)[jt]sconfig(\.[\w-]+)?\.json$/, shared: "tsconfig" },
];
export const RUNNER_CONFIGS: Spec[] = RAW_CONFIGS.map((s) => ({ ...s, re: new RegExp(s.re.source, "i") }));
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
  if (Array.isArray(shared)) { const j = JSON.parse(text) as Record<string, unknown>; return JSON.stringify([shared.map((k) => j[k]), depGuard(j), exportConds(j["exports"])]); }
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
const REFS = /["']?\b(?:preload|setupFiles|setupFilesAfterEnv|setupFilesAfterFramework|globalSetup|globalTeardown)\b["']?\s*[:=]\s*(\[[^\]]*\]|"[^"\n]*"|'[^'\n]*')/g, MAPPER = /moduleNameMapper["']?\s*[:=]\s*\{([^}]*)\}/g, ROOT_DIR = /\brootDir["']?\s*[:=]\s*(?:["']([^"'\n]*)["'])?/, QUOTED = /["']([^"'\n]+)["']/g;
const EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".py", "/index.ts", "/index.js"];
/** FC-09w: pnpm patchedDependencies targets (package.json top-level or pnpm key; pnpm-workspace.yaml block or flow map), relative to the config's folder. Absolute targets are skipped. A malformed manifest is already failed closed by relevant(). */
function patchedTargets(cfg: string, text: string): string[] {
  const out: string[] = [], unq = (v: string): string => v.replace(/^["']|["']$/g, "");
  if (/package\.json$/i.test(cfg)) {
    try { const j = JSON.parse(text) as { pnpm?: { patchedDependencies?: unknown }; patchedDependencies?: unknown }; for (const m of [j.patchedDependencies, j.pnpm?.patchedDependencies]) if (m && typeof m === "object") for (const v of Object.values(m)) if (typeof v === "string") out.push(v); } catch { /* relevant() fails closed */ }
  } else if (/pnpm-workspace\.yaml$/i.test(cfg)) {
    let on = false, flow = 0; // flow: open braces of a (possibly multi-line) flow map
    const pairs = (t: string): void => { for (const m of t.matchAll(/:\s*("[^"]*"|'[^']*'|[^\s,}#]+)/g)) out.push(unq(m[1]!)); }, depth = (t: string): number => (t.match(/{/g) ?? []).length - (t.match(/}/g) ?? []).length;
    for (const l of text.split(/\r?\n/)) {
      if (flow) { const c = l.replace(/#.*$/, ""); pairs(c); flow = Math.max(0, flow + depth(c)); continue; }
      const h = /^patchedDependencies\s*:(.*)$/.exec(l);
      if (h) { const rest = h[1]!.trim(), c = rest.replace(/#.*$/, ""); on = !rest || rest.startsWith("#"); pairs(c); if (c.startsWith("{")) flow = Math.max(0, depth(c)); continue; }
      if (!on) continue;
      if (/^\S/.test(l)) { on = false; continue; }
      const m = /^\s+(?:"[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:\s*("[^"]*"|'[^']*'|[^\s#]+)/.exec(l);
      if (m) out.push(unq(m[1]!));
    }
  }
  return out.filter((t) => t && !t.startsWith("/"));
}
/** Repo-relative candidates for every file a config loads (preload, setupFiles, globalSetup, exact-file moduleNameMapper target). Wildcard mapper targets map a tree, not a mock, so they are skipped.
 *  Jest's rootDir is the folder holding the config; an explicit rootDir is unknowable here, so every plausible root is tried (fail closed). */
function referenced(cfg: string, text: string): string[] {
  const raw = [...text.matchAll(REFS)].flatMap((m) => [...m[1]!.matchAll(QUOTED)].map((q) => q[1]!));
  for (const m of text.matchAll(MAPPER)) for (const kv of m[1]!.split(",")) { const v = [...kv.matchAll(QUOTED)][1]?.[1]; if (v && !/[$*]/.test(v)) raw.push(v); }
  const dir = dirname(cfg), explicit = ROOT_DIR.exec(text), roots = [dir];
  if (explicit) roots.push("", ...(explicit[1] ? [join(dir, explicit[1])] : []));
  return [...raw.flatMap((r) => r.startsWith("/") ? [normalize(r.slice(1))] : roots.map((root) => normalize(join(root, r.replace(/^<rootDir>\/?/, ""))))), ...patchedTargets(cfg, text).map((t) => normalize(join(dir, t)))];
}
const gitOut = (dir: string, args: string[], signal?: AbortSignal): string => safeGit(dir, args, { timeout: 20000, maxBuffer: 64 << 20, ...(signal ? { signal } : {}) }); const NON_SOURCE = /(^|\/)(tests?|__tests__|spec|\.loki)\/|\.(test|spec)\.[\w.]+$|(^|\/)test_[^/]*\.py$|_test\.(go|py)$/;
/** FC-09 seal side: NOT PROVEN lines for every runner config, and every file one loads, that the run added, changed or deleted between base and head
 *  (`changed` = repo-relative paths from the base..head diff). Shared files count only when their runner section differs. A config whose git blob is identical on both sides is read and parsed once. An unparseable config loads an unknown set, so it caps when it changed or when any non-test file in its directory tree did. */
export function runnerConfigNotes(repoDir: string, baseSha: string, head: string, changed: string[], signal?: AbortSignal): string[] {
  const notes = new Set<string>(), ch = new Set(changed.map((c) => normalize(c)));
  for (const c of ch) if (/(^|\/)__mocks__\//.test(c)) notes.add(`runner setup file changed: ${c} (jest/vitest manual mock)`);
  const trees = new Map<string, Map<string, string>>();
  try { for (const rev of [baseSha, head]) trees.set(rev, new Map(gitOut(repoDir, ["ls-tree", "-r", rev], signal).split("\n").filter(Boolean).map((l): [string, string] => { const t = l.indexOf("\t"); return [l.slice(t + 1), l.slice(0, t).split(" ")[2] ?? ""]; }))); } catch { if (ch.size) notes.add("runner config not inspected: tree listing failed"); return [...notes]; }
  const cfgs = new Set<string>();
  for (const tree of trees.values()) for (const f of tree.keys()) if (RUNNER_CONFIGS.some((s) => s.re.test(f))) cfgs.add(f);
  for (const cfg of [...cfgs].sort()) {
    const spec = RUNNER_CONFIGS.find((s) => s.re.test(cfg))!, refs = new Set<string>(), texts: string[] = [], bo = trees.get(baseSha)!.get(cfg), same = bo !== undefined && bo === trees.get(head)!.get(cfg);
    let changedHere = false, bad = false;
    try {
      for (const rev of same ? [head] : [baseSha, head]) {
        const tree = trees.get(rev)!, t = tree.has(cfg) ? gitOut(repoDir, ["show", `${rev}:${cfg}`], signal) : "";
        texts.push(t);
        if (spec.shared && t) try { relevant(spec.shared, t); } catch (x) { bad = true; } // this side is malformed: fail closed below
        for (const c of referenced(cfg, t)) refs.add(EXT.map((e) => c + e).find((p) => tree.has(p)) ?? c);
      }
      const e = typeof spec.shared === "string" && spec.shared !== "tsconfig" ? "" : "{}";
      if (!bad && !same) changedHere = !spec.shared || /conftest\.py$/i.test(cfg) || relevant(spec.shared, texts[0] || e) !== relevant(spec.shared, texts[1] || e);
    } catch { bad = true; }
    if (bad) {
      const dir = dirname(cfg), loaded = [...ch].find((c) => c !== cfg && (dir === "." || c.startsWith(dir + "/")) && !NON_SOURCE.test(c));
      if (ch.has(cfg) || loaded) notes.add(`runner config unparseable, trust capped: ${cfg}${loaded ? ` (${loaded} changed and may be loaded by it)` : ""}`);
    }
    if (ch.has(cfg) && changedHere) notes.add(`runner config changed: ${cfg} (the run could mock the code under test)`);
    for (const r of [...refs].sort()) if (ch.has(r)) notes.add(`runner setup file changed: ${r} (loaded by ${cfg} as a preload, setup or mapper target)`);
  }
  return [...notes];
}
// Dependency trees are not project config: no runner reads a manifest nested in node_modules (this relies on pytest's default norecursedirs, which skips it; a project norecursedirs override that lets pytest into node_modules is a known gap; jest and vitest read the root config), so the listing excludes it.
// bower_components and vendor are skipped except conftest.py, which pytest does load there (its default norecursedirs names neither). In a site-packages or dist-packages dir the import hooks count: top-level
// .pth, sitecustomize.py, usercustomize.py and a dist-info entry_points.txt with a [pytest11] plugin section. A hook a sibling *.dist-info/RECORD lists with its current sha256 is exempt, as is the stock virtualenv and uv _virtualenv.pth.
// Residuals, not checked: a RECORD the agent writes or edits to list a hook's new sha256; a tsconfig.json in node_modules that a project tsconfig extends; the modules a .pth imports (_virtualenv.py, __editable__ finders, _distutils_hack); a pytest-plugin entry_points.txt in a .dist-info at the repo root; an .egg-info entry_points.txt; edits to the module an installed plugin entry loads; a node_modules conftest.py when norecursedirs leaves node_modules in.
const DEP_TREE = /(^|\/)node_modules\//, PY_LOADED_TREE = /(^|\/)(bower_components|vendor)\//, SITE = /^((?:.*\/)?(?:site|dist)-packages)\/(.+)$/, HOOK = /^([^/]+\.pth|(site|user)customize\.py|[^/]+\.dist-info\/entry_points\.txt)$/;
function pipRecorded(repoDir: string, site: string, rel: string, sha: string, memo: Map<string, Set<string>>): boolean {
  let s = memo.get(site);
  if (!s) { s = new Set(); try { for (const d of readdirSync(join(repoDir, site))) if (d.endsWith(".dist-info")) try { for (const l of readFileSync(join(repoDir, site, d, "RECORD"), "utf8").split(/\r?\n/)) { const m = /^"?(.*?)"?,sha256=([\w-]+),/.exec(l); if (m) s.add(`${m[1]}\0${m[2]}`); } } catch { /* no RECORD */ } } catch { /* unreadable dir */ } memo.set(site, s); }
  return s.has(`${rel}\0${Buffer.from(sha, "hex").toString("base64url")}`); // RECORD: urlsafe base64 sha256, padding stripped
}
/** SEAL-CONFTEST-01: path -> sha256 of every untracked runner config with ignore rules NOT applied, so a conftest.py listed in .git/info/exclude or a nested
 *  .gitignore (invisible to changedFiles and to the committed tree the seal reads) is still seen. One listing per call: intake snapshots it, verify compares. Throws when git fails. */
export function hiddenRunnerConfigs(repoDir: string): Record<string, string> {
  const out: Record<string, string> = {}, memo = new Map<string, Set<string>>();
  for (const f of gitOut(repoDir, ["-c", "core.quotePath=false", "ls-files", "-o", "-z", "--", ":(exclude,glob)**/node_modules/**"]).split("\0")) {
    const site = SITE.exec(f);
    if (!f || f.startsWith(".loki/") || (site ? !HOOK.test(site[2]!) : DEP_TREE.test(f) || (PY_LOADED_TREE.test(f) && !/(^|\/)conftest\.py$/i.test(f)) || !RUNNER_CONFIGS.some((s) => s.re.test(f)))) continue;
    let b: Buffer; try { b = readFileSync(join(repoDir, f)); } catch { out[f] = "!unreadable"; continue; }
    const h = createHash("sha256").update(b).digest("hex"), t = site ? b.toString("utf8") : "", stock = site?.[2] === "_virtualenv.pth" && /^import _virtualenv\r?\n?$/.test(t); // the one line virtualenv and uv write
    if (stock || (site?.[2]!.endsWith("/entry_points.txt") && !/^\s*\[pytest11\]\s*$/m.test(t))) continue; // entry points without a pytest plugin section load nothing into the test run
    if (!site || !pipRecorded(repoDir, site[1]!, site[2]!, h, memo)) out[f] = h;
  }
  return out;
}
/** Untracked runner configs added, changed or removed since the intake snapshot (`snap`), at most 5 named then "(+N more)". A failed listing, or configs present with no snapshot to compare, is one named entry: fail closed. */
export function hiddenConfigChanged(repoDir: string, snap: unknown): string[] {
  let now: Record<string, string>; try { now = hiddenRunnerConfigs(repoDir); } catch { return ["untracked runner configs (listing failed)"]; }
  if (!snap || typeof snap !== "object") return Object.keys(now).length ? ["untracked runner configs (no intake snapshot to compare)"] : [];
  const was = snap as Record<string, unknown>;
  const d = [...new Set([...Object.keys(now), ...Object.keys(was)])].filter((f) => now[f] !== was[f]).sort();
  return d.length > 5 ? [...d.slice(0, 5), `(+${d.length - 5} more)`] : d;
}
