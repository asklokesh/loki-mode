// Shared helpers for the D91 finding guards (loki-ts/tests/util/*guard*.test.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const SRC = join(REPO, "loki-ts", "src");

export function walk(d: string, exts: string[] = [".ts"], out: string[] = []): string[] {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === "dist") continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

export const rel = (f: string): string => relative(REPO, f);

// Allowlist file format: one entry per line, `<repo-relative path> | <reason>`; `#` starts a comment line.
export function loadAllowlist(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  const f = join(import.meta.dir, "guard-allowlists", name);
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(" | ");
    out[i < 0 ? t : t.slice(0, i)] = i < 0 ? "" : t.slice(i + 3).trim();
  }
  return out;
}

export function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

// Files (repo-relative) with at least one non-comment line matching `re`.
export function filesMatching(files: string[], re: RegExp): string[] {
  return files.filter((f) => readFileSync(f, "utf8").split("\n").some((l) => !isComment(l) && re.test(l))).map(rel);
}

// Asserts: no unlisted hit, no stale allowlist entry, every entry carries a reason.
export function checkAllowlist(hits: string[], allow: Record<string, string>): { unlisted: string[]; stale: string[]; noReason: string[] } {
  const set = new Set(hits);
  return {
    unlisted: hits.filter((h) => !(h in allow)),
    stale: Object.keys(allow).filter((k) => !set.has(k)),
    noReason: Object.entries(allow).filter(([, v]) => v.length < 10).map(([k]) => k),
  };
}
