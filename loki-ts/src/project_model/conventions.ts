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

/** The shared re-ask text for files rejected by the out-of-repo checks (Wall and the implement repro test): the lead says what to rewrite, then each rejected name with its reason. */
export const outOfRepoReask = (lead: string, bad: { name: string; why: string }[]): string => [`${lead} Each was rejected:\n${bad.map((b) => `- ${b.name}: ${b.why}`).join("\n")}`, `Point every reference at the repository code with repo-relative paths (for example join(import.meta.dir, "..", "<repo path>") or the equivalent for this runner). Do not read the home directory, $HOME or an environment variable that falls back to one. Write nothing else.`].join("\n\n");

/** TEN-QUALITY-44: the changed test-like files (repo-relative names) that fail outOfRepoTarget. */
export const outOfRepoTests = (repoDir: string, changed: string[]): { name: string; why: string }[] => changed.filter((f) => /(^|[\/._-])(test|spec)s?[\/._-]|_test\./i.test(f) && existsSync(join(repoDir, f))).flatMap((name) => { const why = outOfRepoTarget(readFileSync(join(repoDir, name), "utf8")); return why ? [{ name, why }] : []; });

/** A directory is a package root when the cached project model owns the file there, or it holds a manifest-shaped JSON file (a string "name" plus another key, by shape and never by file name, as readPackageConventions does). No manifest file name is hardcoded (L0). */
function nearestPackageRoot(testDir: string, repoDir: string, fileName: string): string {
  const site = siteFor(loadProjectApi(repoDir), repoDir, relative(repoDir, join(testDir, fileName)));
  if (site) return site.cwd;
  const shaped = (d: string): boolean => { try { return readdirSync(d).some((f) => { if (!f.endsWith(".json")) return false; const j = readJson(join(d, f)); return !!j && typeof j.name === "string" && Object.keys(j).length > 1; }); } catch { return false; } };
  let pkg = testDir; while (pkg !== repoDir && pkg !== dirname(pkg) && !shaped(pkg)) pkg = dirname(pkg);
  return pkg;
}
const CREATORS = /\b(?:mkdirSync|writeFileSync|appendFileSync|cpSync|copyFileSync|renameSync|symlinkSync|mkdir|writeFile|appendFile|cp|copyFile|rename|outputFile|ensureDir|mkdirp)\(/g;

/** FC-WALL-PHANTOM-PATH: repo paths a JS/TS test builds with join/resolve from the test dir, the cwd or a const derived from them (const assignments followed, calls split across lines joined) that do not exist in the base tree. process.cwd() is tried as the nearest package root of the test dir (verify runs a package's tests there) and as the repo root; a path existing under either passes. A path the plan names, creates (mkdir/write/cp/rename target), or that git ignores passes; write/expect/tmp lines are ignored. A path that stays inside the test dir is reported only when its first segment is absent from the test dir but present at the package or repo root (tests/plugins/x for plugins/x); fixtures the test dir lacks stay unreported. Returns repo-relative missing paths (max 3). */
export function phantomRepoPaths(content: string, fileName: string, testDir: string, repoDir: string, planText: string | null): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(fileName)) return [];
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\n\s*/g, ", ").replace(/=\s*\n\s*/g, "= ");
  const pkg = nearestPackageRoot(testDir, repoDir, fileName);
  const split = (s: string): string[] => { const out: string[] = []; let d = 0, q = "", cur = ""; for (let i = 0; i < s.length; i++) { const c = s[i]!; if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === q) q = ""; } else if (c === '"' || c === "'" || c === "`") { q = c; cur += c; } else if ("([{".includes(c)) { d++; cur += c; } else if (")]}".includes(c)) { d--; cur += c; } else if (c === "," && d === 0) { out.push(cur); cur = ""; } else cur += c; } if (cur.trim()) out.push(cur); return out; };
  const close = (line: string, at: number): number => { let d = 0; for (let j = at; j < line.length; j++) { if (line[j] === "(") d++; else if (line[j] === ")" && --d === 0) return j; } return -1; };
  const strayInTestDir = (out: string): boolean => { const first = relative(testDir, out).split("/")[0]!; return !!first && first !== "__self__" && !existsSync(join(testDir, first)) && [pkg, repoDir].some((d) => d !== testDir && existsSync(join(d, first))); }; // inside the test dir but the first segment only exists at a repo root: the author meant a repo path
  const scan = (cwd: string): { reports: Map<string, { out: string; rel: string }>; created: string[] } => {
    const vars = new Map<string, string>(), reports = new Map<string, { out: string; rel: string }>(), created: string[] = []; let ln = 0; // reports are keyed by source line and call text so two cwd runs pair the same call
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
      if (report && (relative(testDir, out).startsWith("..") || strayInTestDir(out)) && parts.some((a) => /^\s*["'`]/.test(a))) reports.set(`${ln}|${e}`, { out, rel: relative(repoDir, out) });
      return out;
    };
    for (const line of code.split("\n")) {
      ln++;
      for (const m of line.matchAll(CREATORS)) { const j = close(line, m.index! + m[0].length - 1); if (j > 0) for (const a of split(line.slice(m.index! + m[0].length, j))) { const v = ev(a, false); if (v) created.push(v); } }
      const skip = /^\s*(?:await\s+)?(?:expect|assert\w*)\b|\b(?:write\w*|mkdir\w*|rm\w*|cp\w*|copy\w*|rename\w*|symlink\w*|mkdtemp\w*|tmpdir|outputFile|touch)\b/.test(line);
      const asg = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+?);?\s*$/.exec(line);
      if (asg) { const v = ev(asg[2]!, !skip); if (v !== null) vars.set(asg[1]!, v); continue; }
      if (skip) continue;
      for (const m of line.matchAll(/(?:path\.)?(?:join|resolve)\(/g)) { const j = close(line, m.index! + m[0].length - 1); if (j > 0) ev(line.slice(m.index!, j + 1), true); }
    }
    return { reports, created };
  };
  const runs = [...new Set([pkg, repoDir])].map(scan);
  const planned = (rel: string): boolean => !!planText && rel.split("/").some((_, i, a) => { const pre = a.slice(0, i + 1).join("/"); return (i > 0 || a.length === 1) && !existsSync(join(repoDir, pre)) && new RegExp(`(?<![\\w-])${pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(planText); }); // only a path named with its parent (plugins/ralph-loop) is planned, never a bare segment or basename
  const phantom = (r: { out: string; rel: string }, created: string[]): boolean => {
    const rel = r.rel; if (!rel || rel.startsWith("..") || isAbsolute(rel) || /(^|\/)(\w*_modules|\.git|\.loki|dist|build|coverage|tmp)(\/|$)/.test(rel) || existsSync(r.out) || planned(rel)) return false;
    if (created.some((c) => c === r.out || c.startsWith(r.out + "/") || r.out.startsWith(c + "/"))) return false;
    return safeGitSpawn(repoDir, ["check-ignore", "-q", "--", rel], { timeout: 5000 }).status !== 0;
  };
  const missing: string[] = [];
  for (const [k, r] of runs[0]!.reports) if (runs.every((x) => x.reports.has(k) && phantom(x.reports.get(k)!, x.created)) && !missing.includes(r.rel)) missing.push(r.rel);
  return missing.slice(0, 3);
}

/** FC-WALL-PHANTOM-PATH: the re-ask text (null when nothing is missing) for a phantom Wall file; the hint names real paths holding a segment with the same name, so a missing directory finds its real home too. */
export function phantomReason(miss: string[], repoFiles: string[]): string | null {
  if (miss.length === 0) return null;
  const hint = (m: string): string => { const n = basename(m), near = [...new Set(repoFiles.flatMap((f) => { const s = f.split("/"), k = s.indexOf(n); return k >= 0 && s.slice(0, k + 1).join("/") !== m ? [s.slice(0, k + 1).join("/")] : []; }))].slice(0, 3); return near.length ? `${m} (a path named ${n} exists at ${near.join(", ")})` : m; };
  return `references repo path(s) that do not exist in the repository and that the plan does not create: ${miss.map(hint).join("; ")}. Locate the real code by searching the repository; do not copy a name from the task text as a path`;
}
