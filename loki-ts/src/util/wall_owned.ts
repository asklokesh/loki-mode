// FC-23 (L5): a lint or type error whose every location is inside a Wall-authored file is harness-owned. The Wall file is read-only
// to the fix session, so a fix round on it buys nothing. Parsed from tsc (plain and pretty) and eslint (stylish and compact) output;
// any error with no file location (a config error, an unparsed format) is never claimed, so a real failure keeps its fix rounds.
import { isAbsolute, join, relative } from "node:path";

export const WALL_COMPILE_REASON = "wall test did not compile under the package config";
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Repo-relative paths named as failing locations; null when any failure line carries no location. */
export function failingLocations(raw: string, cwd: string, repoDir: string): string[] | null {
  const out = raw.replace(ANSI, "").replace(/\r\n?/g, "\n"), files = new Set<string>();
  let located = 0, errors = 0, header: string | null = null;
  for (const line of out.split("\n")) {
    const m = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line) ?? /^(.+?):\d+:\d+ - error TS\d+:/.exec(line) ?? /^(.+?):\d+:\d+: .*\berror\b/.exec(line);
    if (m) { files.add(m[1]!); located++; errors++; continue; }
    if (/\berror TS\d+:/.test(line)) { errors++; continue; } // tsc error without a file
    if (/^\S/.test(line) && /^[^\s:]+\.[cm]?[jt]sx?$/.test(line.trim())) { header = line.trim(); continue; } // eslint stylish file header
    if (/^\s+\d+:\d+\s+error\b/.test(line)) { errors++; if (header) { files.add(header); located++; } }
  }
  if (errors === 0 || located !== errors) return null;
  return [...files].map((f) => relative(repoDir, isAbsolute(f) ? f : join(cwd, f)));
}

/** True only when the output has failure locations and every one is a Wall file (repo-relative paths). */
export function wallOwnedFailure(raw: string, cwd: string, repoDir: string, wall: ReadonlySet<string>): boolean {
  const locs = failingLocations(raw, cwd, repoDir);
  return !!locs && locs.length > 0 && locs.every((l) => wall.has(l));
}

// FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a spec conflict whose reason cites a Wall file as path:line is a harness defect (Loki wrote that test), never the user's contradiction.
// No wording is judged; only whether a cited location is a Wall file. A bare mention without a line is not an anchor.
export interface WallDefect { file: string; line: number; reason: string; action: "reauthored" | "dropped"; }
export const WALL_DROPPED = "Wall assertion dropped (harness-owned conflict persisted after one re-author)";

/** The Wall file (repo-relative) and line a conflict reason cites as path:line, else null. */
export function wallAnchor(reason: string, wall: readonly string[]): { file: string; line: number } | null {
  for (const m of reason.matchAll(/([\w@./-]+\.[A-Za-z]{1,5}):(\d+)/g)) {
    const p = m[1]!.replace(/^\.\//, ""), file = wall.find((w) => w === p || w.endsWith(`/${p}`) || p.endsWith(`/${w}`));
    if (file) return { file, line: Number(m[2]) };
  }
  return null;
}

/** NOT PROVEN lines for every dropped Wall assertion recorded by implement or fix; a non-empty result caps the verdict at PARTIAL. */
export function wallDropped(o: Record<string, Record<string, unknown> | undefined>): string[] {
  return [...new Set([o.implement, o.fix].flatMap((s) => { const d = s?.wall_defect as WallDefect | undefined; return d?.action === "dropped" ? [`${WALL_DROPPED}: ${d.file}:${d.line}: ${d.reason}`] : []; }))];
}
