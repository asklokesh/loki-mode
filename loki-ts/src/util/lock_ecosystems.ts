// loki-ts/src/util/lock_ecosystems.ts -- D106: the one ecosystem table behind lockedInstall (lockfile to frozen install form, workspace
// declarations). It lives here, not in src/project_model, because it must name package managers and manifests; project_model sources
// name no language or framework (tests/project_model L0 self-check). Entries in tests/engine10/l0_guard.allowlist move with it. No existing util owns package-manager and lockfile names, so a new file is justified.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { safeGit } from "./safe_git.ts";

export interface LockRule {
  tool: string; subs: string[]; locks: string[];
  locked: (sub: string, rest: string[], env: string[]) => boolean; // the command is already a lock-honoring form
  build: (sub: string, rest: string[], ctx: { berry: boolean }) => string[]; // words of the locked form, the model's flags kept
  /** Glob patterns of the workspace an ancestor directory declares; absent: the ecosystem has no workspace lockfile sharing. */
  ws?: (ancestor: string) => string[];
}
export const has = (rest: string[], ...f: string[]): boolean => rest.some((x) => f.includes(x));
export const withFlag = (rest: string[], flag: string): string[] => (rest.includes(flag) ? rest : [...rest, flag]);
export const text = (dir: string, file: string): string | null => { try { return readFileSync(join(dir, file), "utf8"); } catch { return null; } };
export const quoted = (s: string): string[] => [...s.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
/** package.json `workspaces` (array, or {packages: []}): npm, yarn and bun. */
export const pkgWorkspaces = (dir: string): string[] => {
  try {
    const w = (JSON.parse(text(dir, "package.json") ?? "{}") as { workspaces?: unknown }).workspaces;
    const l = Array.isArray(w) ? w : (w as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
/** pnpm-workspace.yaml `packages:` list (a leading ! excludes): block (indented or not) and inline lists. */
export const pnpmWorkspaces = (dir: string): string[] => {
  const out: string[] = []; let inBlock = false;
  for (const l of (text(dir, "pnpm-workspace.yaml") ?? "").split("\n")) {
    const top = /^packages\s*:\s*(.*)$/.exec(l);
    if (top) {
      const v = top[1]!.replace(/\s+#.*$/, "").trim();
      inBlock = v === "" || v.startsWith("#");
      if (v.startsWith("[")) out.push(...v.slice(1, v.includes("]") ? v.indexOf("]") : undefined).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      continue;
    }
    if (inBlock && /^[^\s#-]/.test(l)) inBlock = false;
    const m = inBlock ? /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(l) : null;
    if (m) out.push(m[1]!);
  }
  return out;
};
/** `members` (and `exclude`, as ! patterns) of one TOML table such as [workspace] or [tool.uv.workspace]. */
export const tomlWorkspace = (dir: string, file: string, header: string): string[] => {
  const t = text(dir, file); if (!t) return [];
  const at = t.indexOf(`[${header}]`); if (at < 0) return [];
  const body = t.slice(at + header.length + 2).split(/^\[/m)[0]!;
  const list = (k: string): string[] => quoted(new RegExp(`^\\s*${k}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body)?.[1] ?? "");
  return [...list("members"), ...list("exclude").map((x) => `!${x}`)];
};

/** The ecosystem table: one row per package manager, its official frozen form. `poetry install` already honors poetry.lock, so it is kept
 *  as written (`--no-root` would skip installing the project itself and break src-layout imports; `--sync` would delete environment
 *  packages the lock lacks). */
export const LOCK_RULES: LockRule[] = [
  { tool: "npm", subs: ["install", "i", "ci"], locks: ["package-lock.json", "npm-shrinkwrap.json"], locked: (s) => s === "ci", build: (_s, r) => ["npm", "ci", ...r], ws: pkgWorkspaces },
  { tool: "pnpm", subs: ["install", "i"], locks: ["pnpm-lock.yaml"], locked: (_s, r) => has(r, "--frozen-lockfile") && !has(r, "--no-frozen-lockfile"), build: (_s, r) => ["pnpm", "install", ...withFlag(r.filter((x) => x !== "--no-frozen-lockfile"), "--frozen-lockfile")], ws: pnpmWorkspaces },
  { tool: "yarn", subs: ["", "install"], locks: ["yarn.lock"], locked: (_s, r) => has(r, "--immutable", "--frozen-lockfile"), build: (_s, r, c) => ["yarn", "install", ...withFlag(r, c.berry ? "--immutable" : "--frozen-lockfile")], ws: pkgWorkspaces },
  { tool: "bun", subs: ["install", "i", "ci"], locks: ["bun.lock", "bun.lockb"], locked: (s, r) => s === "ci" || has(r, "--frozen-lockfile"), build: (_s, r) => ["bun", "install", ...withFlag(r, "--frozen-lockfile")], ws: pkgWorkspaces },
  { tool: "uv", subs: ["sync"], locks: ["uv.lock"], locked: (_s, r, e) => has(r, "--locked") || e.some((x) => /^UV_(FROZEN|LOCKED)=(?!0$|false$|$)/i.test(x)), build: (_s, r) => ["uv", "sync", ...withFlag(r.filter((x) => x !== "--frozen"), "--locked")], ws: (d) => tomlWorkspace(d, "pyproject.toml", "tool.uv.workspace") },
  { tool: "poetry", subs: ["install"], locks: ["poetry.lock"], locked: () => true, build: (_s, r) => ["poetry", "install", ...r] },
  { tool: "pipenv", subs: ["install", "sync"], locks: ["Pipfile.lock"], locked: (_s, r) => has(r, "--deploy"), build: (_s, r) => ["pipenv", "install", ...withFlag(r, "--deploy")] },
  { tool: "cargo", subs: ["fetch", "build"], locks: ["Cargo.lock"], locked: (_s, r) => has(r, "--locked", "--frozen"), build: (s, r) => ["cargo", s, ...withFlag(r, "--locked")], ws: (d) => tomlWorkspace(d, "Cargo.toml", "workspace") },
  { tool: "bundle", subs: ["", "install"], locks: ["Gemfile.lock"], locked: (_s, r, e) => e.includes("BUNDLE_FROZEN=true") || has(r, "--frozen", "--deployment"), build: (_s, r) => ["bundle", "install", ...r] },
  { tool: "composer", subs: ["install", "update"], locks: ["composer.lock"], locked: (s) => s === "install", build: (_s, r) => ["composer", "install", ...r] },
];

/** Yarn Berry (2+): .yarnrc.yml beside the lockfile or package.json packageManager yarn@>=2; anything else is Classic. */
export function isYarnBerry(dir: string): boolean {
  if (existsSync(join(dir, ".yarnrc.yml"))) return true;
  try { return /^yarn@([2-9]|\d{2,})/.test(String((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager ?? "")); } catch { return false; }
}

const PY_SKIP_DIR = /^(\.|(node_modules|venv|__pycache__|dist|build|site-packages)$)/;
const PY_MANIFEST = /^(requirements[^/]*\.txt|pyproject\.toml|setup\.cfg|setup\.py|Pipfile)$/;
const depKey = (s: string): string => s.toLowerCase().replace(/[-_.]+/g, "_");
/** Python dependency manifests under repoDir (at most 5000 directory entries); dot, vendored and build directories are never entered. */
function pythonManifests(repoDir: string): string[] {
  const out: string[] = [], stack = [""]; let seen = 0;
  while (stack.length && seen < 5000) {
    const dir = stack.pop()!; let ents;
    try { ents = readdirSync(join(repoDir, dir), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      seen++; const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!PY_SKIP_DIR.test(e.name)) stack.push(rel); continue; }
      if (PY_MANIFEST.test(e.name) || (e.name.endsWith(".txt") && /(^|\/)requirements$/.test(dir))) out.push(rel);
    }
  }
  return out;
}
/** Distribution names the manifests declare, normalized by depKey: requirements lists; pyproject and Pipfile dependency tables and arrays; setup.cfg install_requires, tests_require and extras_require; the quoted strings after those keys in the setup script. */
function declaredPythonDeps(repoDir: string, manifests: string[]): Set<string> {
  const out = new Set<string>(), add = (s: string): void => { const m = /^\s*([A-Za-z0-9][\w.-]*)/.exec(s); if (m) out.add(depKey(m[1]!)); };
  const strings = (v: string): string[] => [...v.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
  const open = (x: string): number => (x.match(/[[{]/g) ?? []).length - (x.match(/[\]}]/g) ?? []).length;
  for (const f of manifests) {
    let t: string; try { t = readFileSync(join(repoDir, f), "utf8"); } catch { continue; }
    const base = basename(f), lines = t.split("\n");
    if (base.endsWith(".txt")) { for (const l of lines) if (!/^\s*-/.test(l)) add(l.replace(/(^|\s)#.*$/, "")); }
    else if (/^setup\.py$/.test(base)) { for (const m of t.matchAll(/\b(?:install_requires|tests_require|extras_require)\s*=\s*([[{][^]*?[\]}])\s*[,)]/g)) strings(m[1]!).forEach(add); }
    else if (base === "setup.cfg") {
      let sec = "", key = "";
      const wanted = (): boolean => sec === "options.extras_require" || (sec === "options" && /^(install|tests)_requires?$/.test(key));
      for (const l of lines) {
        const h = /^\[([^\]]+)\]/.exec(l), kv = /^(\w[\w.-]*)\s*[=:]\s*(.*)$/.exec(l);
        if (h) { sec = h[1]!; key = ""; } else if (kv) { key = kv[1]!; if (wanted()) add(kv[2]!); } else if (/^\s+\S/.test(l) && wanted()) add(l.replace(/\s*[#;].*$/, ""));
      }
    } else {
      let table = "";
      for (let i = 0; i < lines.length; i++) {
        const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(lines[i]!); if (h) { table = h[1]!.replace(/["']/g, ""); continue; }
        const a = /^\s*("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/.exec(lines[i]!); if (!a) continue;
        let v = a[2]!; while (open(v) > 0 && i + 1 < lines.length) v += `\n${lines[++i]}`;
        const key = a[1]!.replace(/["']/g, ""), depTable = /(^|\.)(dependencies|dev-dependencies|optional-dependencies|dependency-groups|extras|packages|dev-packages)$/.test(table);
        if (depTable || /^(optional-)?dependencies$|^dev-dependencies$/.test(key)) { if (v.trimStart().startsWith("[")) strings(v).forEach(add); else if (depTable) add(key); }
      }
    }
  }
  return out;
}
/** Does any Python dependency manifest under repoDir declare the distribution `name` (case, dash, dot and underscore insensitive)? Unreadable manifests declare nothing. */
export function declaresPythonDep(repoDir: string, name: string): boolean { return declaredPythonDeps(repoDir, pythonManifests(repoDir)).has(depKey(name)); }

const OUTPUT_DIRS: { dir: string; sigs: string[] }[] = [ // a toolchain's build output dir; `sigs` are files the toolchain itself writes in it (cachedir.org tag, cargo's rustc info), so a user's own `target/` is never matched by name alone
  { dir: "target", sigs: ["CACHEDIR.TAG", ".rustc_info.json"] },
  { dir: ".gradle", sigs: [] }, { dir: "node_modules", sigs: [] }, { dir: "__pycache__", sigs: [] },
];
/** Of the paths a run ADDED, those inside a toolchain's own build output (a signed cargo target/, .gradle, node_modules, __pycache__). An output dir that already holds any file tracked at the run's base commit is the user's: nothing in it is returned, and when the base cannot be read nothing is dropped. */
export function toolchainOutputs(repoDir: string, added: string[], baseSha?: string): Set<string> {
  const dirOf = new Map<string, string>(), tracked = new Map<string, boolean>(), out = new Set<string>();
  for (const f of added) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const o = OUTPUT_DIRS.find((d) => d.dir === parts[i]); if (!o) continue;
      const dir = parts.slice(0, i + 1).join("/");
      if (o.sigs.length === 0 || o.sigs.some((s) => existsSync(join(repoDir, dir, s)))) { dirOf.set(f, dir); break; }
    }
  }
  for (const [f, dir] of dirOf) {
    if (!tracked.has(dir)) { try { tracked.set(dir, !baseSha || safeGit(repoDir, ["ls-tree", "-r", "--name-only", baseSha, "--", `${dir}/`], { stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""); } catch { tracked.set(dir, true); } }
    if (!tracked.get(dir)) out.add(f);
  }
  return out;
}
/** One scope note per output dir the commit left out, so the drop is disclosed in the receipt. */
export function toolchainDropNotes(repoDir: string, dropped: string[], baseSha?: string): string[] {
  const n = new Map<string, number>();
  for (const f of toolchainOutputs(repoDir, dropped, baseSha)) { const p = f.split("/"), i = p.findIndex((x) => OUTPUT_DIRS.some((d) => d.dir === x)), k = p.slice(0, i + 1).join("/"); n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n].map(([d, c]) => `toolchain build output left out of the commit: ${d}/ (${c} file${c === 1 ? "" : "s"})`);
}

export interface AddedManifestCtx { repoDir: string; baseSha: string; rawDiff: string[]; planFiles: string[]; wallPassedN: boolean; task?: string; head?: string }
const MANIFEST_KEYS = new Set(["name", "version", "description", "private", "type", "main", "module", "types", "exports", "files", "license", "author", "repository", "keywords", "engines", "sideEffects", "homepage", "bugs", "scripts", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);
const SAFE_TEST_SCRIPTS = new Set(["node --test", "bun test"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const MAX_BASE_MANIFESTS = 200;
const EXPORT_OK = new Set(["import", "require", "default", "types"]);
/** Every "exports" node keyed by a condition other than a subpath ("." or "./x"), import, require, default or types (bun, node, test, development and so on), as `key:value` strings. Such a condition can send the
 *  test runner different code from production. Nested maps and arrays are walked. */
export function exportConds(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) exportConds(v, out);
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "." || k.startsWith("./") || EXPORT_OK.has(k)) exportConds(v, out); else out.push(`${k}:${JSON.stringify(v)}`); }
  return out;
}
const WORKSPACE_SPEC = /^workspace:(\*|\^|~|[\^~]?\d[\w.+-]*)$/;
/** The module specifiers a source text really imports: comments are removed and every string literal is parked behind a placeholder first, so a specifier named in a comment or inside another string is not seen.
 *  Static `import ... from`, `export ... from`, side-effect `import "x"`, `require("x")` and `import("x")` count. */
export function importSpecifiers(src: string): string[] {
  const lit: string[] = [];
  const t = src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, q: string | undefined) => (q === undefined ? " " : `\u0000${lit.push(q.slice(1, -1)) - 1}\u0000`));
  const out: string[] = [];
  for (const m of t.matchAll(/\bfrom\s*\u0000(\d+)\u0000|\bimport\s*\u0000(\d+)\u0000|\b(?:require|import)\s*\(\s*\u0000(\d+)\u0000\s*\)/g)) out.push(lit[Number(m[1] ?? m[2] ?? m[3])]!);
  return out;
}
/** Class D: a brand-new workspace package.json is disclosed (not capped) only when ALL hold: it is ADDED, in a directory that held no file at base; the plan or task names its path; a passing Wall
 *  imports the package (a static import, require() or import() specifier, comments ignored, naming the package or a path into its directory); its keys are on a plain-metadata allowlist (no runner,
 *  transpiler, imports, workspaces, overrides or bin keys, or any other loader hook); its "exports" use only subpath, import, require, default and types keys; it has no scripts, or only a bare `test` of
 *  "node --test" / "bun test"; and every dependency is a `workspace:` spec (`*`, `^`, `~` or a version, never an alias) naming the package.json name of a base package. file:, link:, relative, registry
 *  and any other spec caps. An unreadable or unparsable manifest, or a package name that shadows a name or dependency any base manifest uses, caps. */
export function addedManifestOk(f: string, c: AddedManifestCtx, wall: string, esc: (x: string) => string): boolean {
  if (basename(f) !== "package.json" || dirname(f) === "." || !c.wallPassedN) return false;
  const dir = dirname(f), g = (a: string[]): string | null => { try { return safeGit(c.repoDir, a, { timeout: 20000 }).trim(); } catch { return null; } };
  const mention = (t: string): boolean => new RegExp(`(?<![\\w./-])${esc(f)}(?![\\w-])`).test(t);
  if (!(c.planFiles.includes(f) || mention(c.task ?? ""))) return false;
  const lsDir = g(["ls-tree", "-r", "--name-only", c.baseSha, "--", dir]);
  if (lsDir === null || lsDir !== "") return false; // a package living beside existing files can change how they resolve or run
  const text = c.head ? g(["show", `${c.head}:${f}`]) : (() => { try { return readFileSync(join(c.repoDir, f), "utf8"); } catch { return null; } })();
  let j: Record<string, unknown>;
  try { const x = JSON.parse(text ?? "") as unknown; if (!x || typeof x !== "object" || Array.isArray(x)) return false; j = x as Record<string, unknown>; } catch { return false; }
  if (Object.keys(j).some((k) => !MANIFEST_KEYS.has(k)) || typeof j["name"] !== "string" || !j["name"]) return false;
  const name = j["name"] as string, sc = j["scripts"];
  if (sc !== undefined) { if (!sc || typeof sc !== "object" || Array.isArray(sc)) return false; if (Object.entries(sc as Record<string, unknown>).some(([k, v]) => k !== "test" || typeof v !== "string" || !SAFE_TEST_SCRIPTS.has(v))) return false; }
  if (exportConds(j["exports"]).length) return false;
  const imported = importSpecifiers(wall).some((sp) => sp === name || sp.startsWith(`${name}/`) || (/^\.\.?\//.test(sp) && sp.replace(/^(?:\.{1,2}\/)+/, "").startsWith(`${dir}/`)));
  if (!imported) return false;
  const all = g(["ls-tree", "-r", "--name-only", c.baseSha]);
  if (all === null) return false;
  const baseManifests = all.split("\n").filter((p) => basename(p) === "package.json" && !p.split("/").includes("node_modules"));
  if (baseManifests.length > MAX_BASE_MANIFESTS) return false;
  const baseNames = new Set<string>(), baseDeps = new Set<string>();
  for (const m of baseManifests) {
    try { const b = JSON.parse(g(["show", `${c.baseSha}:${m}`]) ?? "") as Record<string, unknown>; if (typeof b["name"] === "string") baseNames.add(b["name"]); for (const fld of DEP_FIELDS) if (b[fld] && typeof b[fld] === "object") for (const d of Object.keys(b[fld] as object)) baseDeps.add(d); } catch { return false; }
  }
  if (baseDeps.has(name) || baseNames.has(name)) return false;
  for (const fld of DEP_FIELDS) {
    const d = j[fld]; if (d === undefined) continue;
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    for (const [dn, spec] of Object.entries(d as Record<string, unknown>)) if (typeof spec !== "string" || !WORKSPACE_SPEC.test(spec) || !baseNames.has(dn)) return false;
  }
  return true;
}
