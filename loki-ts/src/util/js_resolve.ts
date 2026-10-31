// util/js_resolve.ts -- tsconfig/jsconfig import-alias resolution (baseUrl, paths, one-level extends), split out of engine10/testmap.ts to keep the core line budget. Reads config files inside the repo only; never throws.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export const posix = (p: string): string => normalize(p).split("\\").join("/").replace(/^\.\//, "");
/** tsconfig/jsconfig resolution: `base` is the repo-relative baseUrl (null when unset), `paths` the compilerOptions.paths entries. */
export interface JsResolve { base: string | null; paths: [string, string[]][] }
export const inRepo = (p: string): boolean => p !== ".." && !p.startsWith("../") && !isAbsolute(p);
// JSONC to JSON: drop // and /* */ comments outside strings, then trailing commas.
function stripJsonc(t: string): string {
  let o = "", i = 0;
  while (i < t.length) {
    const c = t[i]!, n = t[i + 1];
    if (c === '"') { let j = i + 1; while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1; o += t.slice(i, j + 1); i = j + 1; }
    else if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? t.length : e + 2; }
    else { o += c; i++; }
  }
  return o.replace(/,(\s*[}\]])/g, "$1");
}
interface CO { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string }
// A config or extends target must sit in the repo by path AND by realpath (a symlink to an outside file is refused).
function realInRepo(repoDir: string, rel: string): boolean {
  const root = realpathSync(repoDir), rp = realpathSync(join(repoDir, rel));
  return rp === root || rp.startsWith(root + sep);
}
function readCompilerOptions(repoDir: string, rel: string, depth: number): CO | null {
  try {
    if (!inRepo(rel) || !realInRepo(repoDir, rel)) return null;
    const cfg = JSON.parse(stripJsonc(readFileSync(join(repoDir, rel), "utf8"))) as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
    const co = cfg.compilerOptions ?? {}, here = dirname(rel);
    // extends: a single relative file level only; package names, arrays and deeper chains are not followed.
    const ext = cfg.extends, parent = depth === 0 && typeof ext === "string" && ext.startsWith(".") ? readCompilerOptions(repoDir, posix(join(here, /\.json$/.test(ext) ? ext : `${ext}.json`)), 1) : null;
    const out: CO = { ...(parent ?? {}) };
    if (typeof co.baseUrl === "string") out.baseUrl = posix(join(here, co.baseUrl));
    if (co.paths && typeof co.paths === "object") { out.paths = co.paths as Record<string, string[]>; out.pathsDir = here; }
    return out;
  } catch { return null; }
}
/** Reads the repo-root tsconfig.json, else jsconfig.json; null when absent, unparsable or declaring neither baseUrl nor paths. Never throws. */
export function readJsResolve(repoDir: string): JsResolve | null {
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    const co = readCompilerOptions(repoDir, f, 0); if (!co) continue;
    // A baseUrl outside the repo disables alias resolution entirely (its paths would be relative to that outside directory).
    if (co.baseUrl !== undefined && !inRepo(co.baseUrl)) return null;
    const base = co.baseUrl ?? null;
    // paths without a baseUrl resolve from the directory of the config that declares them.
    const pbase = base ?? co.pathsDir ?? ".";
    const paths = Object.entries(co.paths ?? {}).filter((e): e is [string, string[]] => Array.isArray(e[1])).map(([k, v]): [string, string[]] => [k, v.filter((x) => typeof x === "string").map((x) => posix(join(pbase, x)))]);
    return base === null && paths.length === 0 ? null : { base, paths };
  }
  return null;
}
export function aliasCandidates(spec: string, cfg: JsResolve): string[] {
  const out: string[] = [];
  if (cfg.base !== null) out.push(posix(join(cfg.base, spec)));
  for (const [pat, targets] of cfg.paths) {
    const star = pat.indexOf("*"); let sub: string | null = null;
    if (star < 0) sub = pat === spec ? "" : null;
    else if (spec.length >= pat.length - 1 && spec.startsWith(pat.slice(0, star)) && spec.endsWith(pat.slice(star + 1))) sub = spec.slice(star, spec.length - (pat.length - star - 1));
    if (sub !== null) { const v: string = sub; for (const t of targets) out.push(posix(t.replace("*", () => v))); }
  }
  return out.filter(inRepo);
}
