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

// FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a spec conflict whose reason cites a Wall file (repo-relative path or basename, optional :line) is only a TRIGGER for the Wall referee (util/conflict_resume.ts). No wording is judged; only whether a
// cited location is a Wall file. A mention of a non-Wall file is not an anchor. `line` is null when the citation carried none. The claim never names the check: the referee reads the file itself.
export interface WallDefect { file: string; line: number | null; reason: string; action: "arbitrated" | "reauthored"; }

/** The first Wall file (repo-relative; text order, then Wall order) a conflict reason cites by path or basename, with its :line or null; else null. */
export function wallAnchor(reason: string, wall: readonly string[]): { file: string; line: number | null } | null {
  for (const m of reason.matchAll(/([\w@./-]+\.[A-Za-z]{1,5})(?::(\d+))?(?![\w/-])/g)) {
    const p = m[1]!.replace(/^\.\//, ""), file = wall.find((w) => w === p || w.endsWith(`/${p}`) || p.endsWith(`/${w}`));
    if (file) return { file, line: m[2] ? Number(m[2]) : null };
  }
  return null;
}

// Pure validators for the Wall referee. A proposed replacement of a Wall file is applied only when every one of these holds; none reads the implementer's text.
const DEF = /^[ \t]*(?:(?:export\s+)?(?:async\s+)?function\s+(test\w*)\b|(?:test|it)(?:\.\w+)*\s*\(\s*(["'`])(.+?)\2|(?:async\s+)?def\s+(test\w*)\s*\(|func\s+(Test\w*)\s*\(|(?:#\[test\]\s*)?fn\s+(test_\w+)\s*\()/;
export interface TestSpan { name: string; start: number; end: number; } // lines [start, end)

/** Test definitions of a Wall file in order; a span runs from its definition line to the next definition line (or the end of the file). */
export function testSpans(content: string): TestSpan[] {
  const lines = content.split("\n"), defs: { name: string; start: number }[] = [];
  lines.forEach((l, i) => { const m = DEF.exec(l); if (m) defs.push({ name: m[1] ?? m[3] ?? m[4] ?? m[5] ?? m[6]!, start: i }); });
  return defs.map((d, k) => ({ name: d.name, start: d.start, end: defs[k + 1]?.start ?? lines.length }));
}

/** Assertion-bearing lines: the number a replacement may never lower. */
export const assertionCount = (content: string): number => content.split("\n").filter((l) => /\b(?:expect|assert\w*|should|fail)\s*[(.]|\bself\.assert\w*\(|^\s*assert\b|\bt\.(?:is|true|ok|equal|deepEqual|throws)\b|\bpytest\.(?:raises|fail)\b|\bt\.(?:Error|Fatal)f?\(/.test(l)).length;

/** Null when the edit from `before` to `after` lies entirely inside the body of the one test `name` (same set and order of test definitions, same definition lines); else the reason. */
export function editScopeViolation(before: string, after: string, name: string): string | null {
  const a = testSpans(before), b = testSpans(after), ka = a.map((s) => s.name).join("\n"), kb = b.map((s) => s.name).join("\n");
  if (ka !== kb) return "the replacement adds, removes or renames a test";
  const sp = a.find((s) => s.name === name); if (!sp) return `no test named ${name}`;
  const x = before.split("\n"), y = after.split("\n");
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0; while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  if (p === x.length && p === y.length) return "the replacement is identical to the original";
  const lo = p, hi = x.length - q; // changed original lines [lo, hi)
  if (lo <= sp.start) return "the edit touches the test definition line or lines before it"; // keeping the definition line verbatim is part of the scope
  if (hi > sp.end) return "the edit reaches outside the named test";
  return null;
}

/** A spec quote counts only when it is a verbatim run (whitespace-normalised) of at least 12 characters of the task text. */
export function quoteInSpec(quote: unknown, task: string): boolean {
  if (typeof quote !== "string") return false;
  const n = (s: string): string => s.replace(/\s+/g, " ").trim(), q = n(quote);
  return q.length >= 12 && n(task).includes(q);
}

/** The original lines removed and the replacement lines added by an edit (common prefix and suffix trimmed). */
export function changedRegion(before: string, after: string): { removed: string; added: string } {
  const x = before.split("\n"), y = after.split("\n");
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0; while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return { removed: x.slice(p, x.length - q).join("\n"), added: y.slice(p, y.length - q).join("\n") };
}

/** The first removed and first added line of an edit, for the receipt line. */
export function changedAssertion(before: string, after: string): { old: string; new: string } {
  const r = changedRegion(before, after), one = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 160);
  return { old: one(r.removed), new: one(r.added) };
}
