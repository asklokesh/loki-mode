// FC-23 (L0): a package's module system, read with a parser from the JSON its own directory declares (JSONC comments and trailing commas,
// relative "extends"), by key and never by file name. null when the package declares nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    ? `Package conventions (${decl}): this package compiles as CommonJS. Never use import.meta or top-level await (TS1470, the package's own tsc rejects them); use __dirname, __filename and require() for paths and modules.`
    : `Package conventions (${decl}): this package is ES modules. Use import syntax; use import.meta.url for file locations; never use require(), __dirname or __filename.`;
}

/** A generated Wall file the package's own compiler would reject (import.meta under CommonJS); null when it is fine. Comments and strings are ignored. */
export function conventionViolation(c: PackageConventions | null, fileName: string, content: string): string | null {
  if (!c || c.moduleSystem !== "commonjs" || !/\.[cm]?[jt]sx?$/.test(fileName) || /\.m[jt]s$/.test(fileName)) return null;
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  return /\bimport\.meta\b/.test(code) ? "import.meta is not allowed in a CommonJS package (TS1470)" : null;
}
