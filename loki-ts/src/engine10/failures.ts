// engine10/failures.ts -- failing test ids (A-112) and the FailureGroup shape fix.ts consumes (E-17). The per-runner parsers and groupFailures had no production caller (only their own tests) and were deleted by A-115.
import { javaSummary, stripAnsi } from "../util/check_result.ts"; import { dotnetSummary } from "../util/dotnet_test.ts"; import { escapeRegex } from "../util/regex_escape.ts"; export { failureGroup, failureSignature } from "../util/check_result.ts"; // L005: one owner of failure-line normalizing
export interface FailureGroup {
  signature: string; // normalized reason: numbers and quoted values collapsed
  count: number;
  sample: string; // one raw (unnormalized) reason from the group
  carried?: true; // L025: failed in the previous verify and was not rerun by this quick one; shown in the brief, never compared by the stall rule
}
const ID_LINE = /^(?:(?:FAILED|ERROR)\s+(\S+::\S*)(?:\s.*)?|\u25cf\s+(?!Console|Test suite failed)(.+)|not ok \d+ - (.+?)(?:\s+#.*)?|\u2716\s+(?!failing tests:)(.+?)(?:\s+\([\d.]+ms\))?|FAIL\s+(.+)|\u00d7\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?)$/;
/** The runner's own failed-plus-errored count: pytest "N failed, M error", jest/vitest "Tests: N failed", node "fail N". */
function failCount(out: string): number | null {
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const l = out.split("\n").reverse().map((x) => x.trim()).find((x) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^Tests?:?\s+\d/.test(x)), m = /^(?:#|\u2139) fail (\d+)$/m.exec(out);
  return l ? n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : m ? +m[1]! : null;
}
/** A-112: failing test ids (pytest `FAILED|ERROR path::name`, jest `bullet Suite > name` or `bullet name`, node TAP `not ok N - name` or its  spec cross line, vitest `FAIL name`). [] unless the ids cover the runner's reported
 *  count: a partial extraction (collection or install  failure, "Tests: 0 total") can never be subtracted. */
/** go test (-json or plain) and cargo test ids, each with an independently counted failure total so a partial extraction stays fail-closed.  go -json: id "pkg::Test" per Action=fail with a Test, or the package for a package-only fail; the count
 *  is the "--- FAIL:" output lines plus package-only fails.  go plain: id is the "--- FAIL:" name, or the package of a "FAIL\tpkg" line that no test in that package explains. cargo: "test x ... FAILED" against the summed "N failed". */
function goCargoIds(output: string): string[] | null {
  const lines = output.split("\n").map((l) => l.trim()), ids: string[] = [];
  const cargo = lines.filter((l) => /^test result: /.test(l));
  if (cargo.length) {
    const count = cargo.reduce((a, l) => a + +(l.match(/(\d+) failed/)?.[1] ?? 0), 0);
    for (const l of lines) { const m = /^test (.+?) \.\.\. FAILED$/.exec(l); if (m) ids.push(m[1]!); }
    const u = [...new Set(ids)];
    return count && u.length >= count ? u : [];
  }
  const events = lines.flatMap((l) => { try { const e = l.startsWith("{") ? JSON.parse(l) : null; return e && typeof e.Action === "string" ? [e as { Action: string; Package?: string; Test?: string; Output?: string }] : []; } catch { return []; } });
  let count = 0;
  if (events.length) {
    const tested = new Set(events.filter((e) => e.Action === "fail" && e.Test).map((e) => e.Package ?? ""));
    for (const e of events) {
      if (e.Action === "output" && /^\s*--- FAIL: /.test(e.Output ?? "")) count++;
      if (e.Action !== "fail") continue;
      if (e.Test) ids.push(`${e.Package ?? ""}::${e.Test}`);
      else if (!tested.has(e.Package ?? "")) { ids.push(e.Package ?? ""); count++; }
    }
  } else if (lines.some((l) => /^(?:--- FAIL: |FAIL\t|ok\t)/.test(l))) {
    let pending = 0;
    for (const l of lines) {
      const t = /^--- FAIL: (\S+)/.exec(l), p = /^FAIL\t(\S+)(?:\t|\s+\[)/.exec(l);
      if (t) { ids.push(t[1]!); count++; pending++; } else if (p) { if (!pending) { ids.push(p[1]!); count++; } pending = 0; } else if (/^ok\t/.test(l)) pending = 0;
    }
  } else return null;
  const u = [...new Set(ids)];
  return count && u.length >= count ? u : [];
}

/** L005: bun test ids "file::name" from "(fail) name" (or a colored "✗ name") under each "file:" header, against the summed " N fail"; null when not bun output. */
function bunIds(output: string): string[] | null {
  const lines = output.split("\n"), count = lines.reduce((a, l) => a + +(/^\s*(\d+) fail$/.exec(l)?.[1] ?? 0), 0), ids: string[] = []; let file = "";
  if (!lines.some((l) => /^Ran \d+ tests? across \d+ files?\./.test(l.trim()))) return null;
  for (const l of lines) { const f = /^([\w./@-]+\.[cm]?[jt]sx?):$/.exec(l.trim()), m = /^(?:\(fail\)|✗)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/.exec(l.trim()); if (f) file = f[1]!; else if (m) ids.push(`${file}::${m[1]!.trim()}`); }
  const u = [...new Set(ids)];
  return count && u.length >= count ? u : [];
}
/** True when a failure id names the changed repo file `f`: the id carries the repo path (`packages/a/src/x.test.ts > t`), or a vitest project prefix and a path relative to
 *  the project (`|a| src/x.test.ts > t`, printed by a run from a root config with `projects`), which names `f` when `f` ends with that relative path. */
export function idNamesFile(id: string, f: string): boolean {
  if (id.includes(f)) return true;
  const m = /^\|[^|]+\|\s+(\S+?)(?:\s+>\s.*)?$/.exec(id);
  return !!m && (f === m[1] || f.endsWith(`/${m[1]}`));
}
export function failIds(raw: string): string[] {
  const output = stripAnsi(raw), gc = goCargoIds(output);
  if (gc) return gc;
  const bun = bunIds(output); if (bun) return bun;
  const jv = javaSummary(output) ?? dotnetSummary(output); // HV1-03b: surefire / gradle / javac-wrapper ids, only when they cover the vouched failed count
  if (jv) return jv.failed > 0 && jv.ids.length >= jv.failed ? jv.ids : [];
  const ids = [...new Set(output.split("\n").map((l) => ID_LINE.exec(l.trim())).flatMap((m) => (m ? [(m.slice(1).find(Boolean) ?? "").trim()] : [])).filter(Boolean))];
  const c = failCount(output);
  return c && ids.length >= c ? ids : [];
}
/** FireLater#21 (review): what differs between two runs of the same failure and nothing else. Only absolute filesystem paths (under a home, tmp, var, opt,
 *  mount or workspace root, or ending in a source or config file extension with any :line:col) become <path>, only ISO timestamps become <ts>, and a
 *  duration only when it ends the line; text inside quotes is an assertion value ("expected 'GET /p' to be ..."), so it is kept as printed except a
 *  quoted absolute path under one of those roots. "GET /p" and "GET /admin/p", "90 min" and "45 min", "timed out in 5000ms" and "100ms" stay different. */
export function normError(line: string): string {
  const root = "(?:Users|private|var|tmp|home|opt|Volumes|mnt|root|workspace)", file = "[\\w.@-]+\\.(?:[cm]?[jt]sx?|json|py|go|rs|java|kt|cs|rb|php|vue|svelte|mdx?|ya?ml|toml|css|scss|html)(?![\\w])";
  const absPath = new RegExp(`(?<![\\w.@/-])/(?:${root}/(?:[\\w.@+-]+/)*[\\w.@+-]+|(?:[\\w.@+-]+/)*${file})(?::\\d+){0,2}`, "g"), rootPath = new RegExp(`(?<![\\w.@/-])/${root}/(?:[\\w.@+-]+/)*[\\w.@+-]+(?::\\d+){0,2}`, "g");
  const outside = (t: string): string => t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>").replace(absPath, "<path>").replace(/\s\d+(?:\.\d+)?\s?ms\)?$/, " <dur>");
  return line.split(/('[^']*'|"[^"]*"|`[^`]*`)/).map((part, n) => (n % 2 === 0 ? outside(part) : part.replace(rootPath, "<path>"))).join("").replace(/\s+/g, " ").trim();
}
/** Every error line each failing id reports, sorted (a multiset: test.each and duplicate titles give one id several failures): vitest/jest print it
 *  on the first non-blank line after "FAIL  <id>" (consecutive FAIL lines vitest groups under one error share it), pytest after "FAILED <id> - ",
 *  bun above its "(fail) <name>" line (the "error:" line with its Expected/Received lines), jest/TAP/node spec on the line after the result line.
 *  go and cargo output yields no error lines, so their failures are never the same error (fail closed).
 *  Only what differs between two runs of the same failure is normalized: timestamps, durations and absolute paths (with any :line:col), so a base
 *  worktree path never makes two equal errors differ. Every other number is kept: "expected 5 to be 6" and "expected 999 to be 6" differ. */
export function errorsById(out: string): Map<string, string[]> {
  const norm = (l: string): string => normError(l);
  const lines = stripAnsi(out).split("\n").map((l) => l.trim()), m = new Map<string, string[]>(), add = (id: string, e: string): void => { m.set(id, [...(m.get(id) ?? []), e]); };
  // bun test prints a failure's error above its "(fail) name" line, under a "file:" header (bunIds' ids): the "error:" line plus its Expected/Received lines.
  const bun = lines.some((l) => /^Ran \d+ tests? across \d+ files?\./.test(l)); let file = "", err: string[] = [];
  for (const [i, l] of lines.entries()) {
    if (bun) {
      const f = /^([\w./@-]+\.[cm]?[jt]sx?):$/.exec(l), m = /^(?:\(fail\)|✗)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/.exec(l);
      if (f) { file = f[1]!; err = []; } else if (/^error:/.test(l)) err = [l]; else if (err.length && /^(?:Expected|Received)\b/.test(l)) err.push(l);
      else if (m) { if (err.length) add(`${file}::${m[1]!.trim()}`, norm(err.join(" | "))); err = []; } else if (/^\((?:pass|skip|todo)\)|^✓/.test(l)) err = [];
      continue;
    }
    const py = /^FAILED (\S+::\S*) - (.+)$/.exec(l); if (py) { add(py[1]!, norm(py[2]!)); continue; }
    // jest "bullet Suite > name", node TAP "not ok N - name", node spec "cross name" (failIds' ids): the next line that is not another result line, a TAP
    // diagnostic's "message:" value; a TAP failure with no diagnostic at all is recorded as such, so base and head compare on the same footing.
    const g = /^(?:\u25cf\s+(?!Console|Test suite failed)(.+)|not ok \d+ - (.+?)(?:\s+#.*)?|\u2716\s+(?!failing tests:)(.+?)(?:\s+\([\d.]+ms\))?)$/.exec(l);
    if (g) {
      let e = "(no diagnostics)";
      for (const x of lines.slice(i + 1)) { if (x === "" || x === "---") continue; if (/^(?:not ok|ok) \d+|^\u25cf|^\u2716|^\u2714|^1\.\.\d+|^#/.test(x)) break; e = x.replace(/^message:\s*/, ""); break; }
      add((g[1] ?? g[2] ?? g[3]!).trim(), norm(e)); continue;
    }
    const v = /^FAIL\s+(.+)$/.exec(l); if (!v) continue;
    const next = lines.slice(i + 1).find((x) => x !== "" && !/^FAIL\s/.test(x)); if (next !== undefined) add(v[1]!.trim(), norm(next));
  }
  for (const [k, e] of m) m.set(k, e.sort());
  return m;
}
/** FireLater#21 (review): vitest's "Unhandled Errors" block (and its "Errors  N error" summary line), jest's and node's unhandled rejection reports. They name
 *  no failing id, so errorsById cannot see them; a run that has one is the same as base only when base printed the same block. The marker lines plus the
 *  error lines under each header, normalized and sorted; [] when the output has no such block. */
export function unhandledBlock(out: string): string[] {
  const lines = stripAnsi(out).split("\n").map((l) => l.trim()), res: string[] = [];
  for (const [i, l] of lines.entries()) {
    if (/^[\u23af\-=\s]*Unhandled (?:Errors?|Rejections?|Exceptions?)\b/i.test(l) || /\bunhandled (?:promise )?(?:errors?|rejections?)\b/i.test(l) || /^Errors\s+\d+ errors?\b/.test(l)) {
      res.push(normError(l.replace(/^[\u23af\-=\s]+|[\u23af\-=\s]+$/g, "")));
      if (/Unhandled (?:Rejection|Exception|Error)\b/i.test(l) || /Unhandled (?:Errors?|Rejections?)\b/.test(l)) for (const x of lines.slice(i + 1, i + 6)) { if (x === "" || /^[\u23af\-=]{3,}/.test(x)) break; res.push(normError(x)); }
    }
  }
  return [...new Set(res)].sort();
}
/** True when every failing id has error lines on head and fails on base with the same normalized lines, the same number of times (equal sorted
 *  multisets: a test.each case newly failing with another error under the same id is a different error). An id with no head error line (its FAIL
 *  line was never printed or was cut) or none on base is not the same error. failIds also lists a test's bare title (vitest's "× title" line): it
 *  stands for the full ids that end in " > title". `head` and `base` are outputs or their errorsById maps (a baseline stores the map as a record). */
export function sameErrors(head: string | Map<string, string[]>, base: string | Map<string, string[]> | Record<string, string[]>, ids: string[] | undefined): boolean {
  const asMap = (x: string | Map<string, string[]> | Record<string, string[]>): Map<string, string[]> => typeof x === "string" ? errorsById(x) : x instanceof Map ? x : new Map(Object.entries(x));
  const h = asMap(head), b = asMap(base), all = ids ?? [], eq = (x: string[] = [], y: string[] = []): boolean => x.length === y.length && x.every((e, n) => e === y[n]);
  const keys = (i: string): string[] => (h.has(i) ? [i] : [...h.keys()].filter((k) => k.endsWith(` > ${i}`)));
  return all.length > 0 && all.every((i) => { const ks = keys(i); return ks.length > 0 && ks.every((k) => eq(b.get(k), h.get(k))); });
}
/** fl24: half of the second chance when sameErrors says the text differs (noiseOnlyErrors). True when every id has head error lines and none of them
 *  names a changed file (its repo path, or its file name when that has an extension) or a changed symbol (a whole word, 3 characters or more). The
 *  caller has already required the id red on base and the test file untouched; go and cargo output carries no error lines, so it never passes (fail
 *  closed). Excusing on this is listed NOT PROVEN by the caller: the text was not shown equal. */
export function errorsNameNoChange(head: string | Map<string, string[]> | Record<string, string[]>, ids: readonly string[], changed: readonly string[], symbols: readonly string[] = []): boolean {
  const h = typeof head === "string" ? errorsById(head) : head instanceof Map ? head : new Map(Object.entries(head)), names = lineNamesChange(changed, symbols);
  const keys = (i: string): string[] => (h.has(i) ? [i] : [...h.keys()].filter((k) => k.endsWith(` > ${i}`)));
  return ids.length > 0 && ids.every((i) => { const ks = keys(i); return ks.length > 0 && ks.every((k) => (h.get(k) ?? []).length > 0 && !(h.get(k) ?? []).some(names)); });
}
/** fl24: an error line with only its run-to-run noise masked, outside quoted text: the directories of a relative file path (a stack frame read from
 *  another worktree), the :line:col after a file name, hex ids and durations. Quoted values and every other number are kept as printed (normError's rule):
 *  "expected 'GET /admin/p' to be 'GET /p'" and "expected 5 to be 6" are the assertion, never noise; an AssertionError and a TypeError never match. */
export const errorShape = (line: string): string => line.split(/('[^']*'|"[^"]*"|`[^`]*`)/).map((part, n) => (n % 2 === 1 ? part : part
  .replace(/\/?(?:[\w.@-]+\/)+([\w.@-]+\.\w+)/g, "$1").replace(/(\.\w+):\d+(?::\d+)?/g, "$1:<n>").replace(/\b0x[0-9a-f]+\b/gi, "<hex>").replace(/\b\d+(?:\.\d+)?\s?ms\b/g, "<dur>"))).join("").replace(/\s+/g, " ").trim();
/** sameErrors on errorShape: every id has head error lines and fails on base with lines of the same shapes, the same number of times. */
export function sameErrorShape(head: string | Map<string, string[]> | Record<string, string[]>, base: string | Map<string, string[]> | Record<string, string[]>, ids: readonly string[]): boolean {
  const asMap = (x: string | Map<string, string[]> | Record<string, string[]>): Map<string, string[]> => typeof x === "string" ? errorsById(x) : x instanceof Map ? x : new Map(Object.entries(x));
  const h = asMap(head), b = asMap(base), shapes = (x: string[] = []): string => x.map(errorShape).sort().join("\n");
  const keys = (i: string): string[] => (h.has(i) ? [i] : [...h.keys()].filter((k) => k.endsWith(` > ${i}`)));
  return ids.length > 0 && ids.every((i) => { const ks = keys(i); return ks.length > 0 && ks.every((k) => b.has(k) && (h.get(k) ?? []).length === (b.get(k) ?? []).length && shapes(h.get(k)) === shapes(b.get(k))); });
}
/** fl24: the one second-chance rule when sameErrors is false: the same error shapes as base (noise only) and no failure naming the change. */
export const noiseOnlyErrors = (head: string | Map<string, string[]> | Record<string, string[]>, base: string | Map<string, string[]> | Record<string, string[]>, ids: readonly string[], changed: readonly string[], symbols: readonly string[] = []): boolean =>
  sameErrorShape(head, base, ids) && errorsNameNoChange(head, ids, changed, symbols);
/** A predicate: does this error line name a changed file (its repo path, or its file name when that has an extension and 4+ characters) or a changed symbol (a whole word, 3+ characters)? */
export function lineNamesChange(changed: readonly string[], symbols: readonly string[] = []): (line: string) => boolean {
  const word = (l: string, w: string): boolean => new RegExp(`(?<![\\w$])${escapeRegex(w)}(?![\\w$])`).test(l);
  const files = changed.flatMap((f) => { const b = f.slice(f.lastIndexOf("/") + 1); return /\.\w+$/.test(b) && b.length >= 4 ? [f, b] : [f]; }), syms = symbols.filter((s) => s.length >= 3);
  return (l) => files.some((f) => l.includes(f) && word(l, f)) || syms.some((s) => word(l, s));
}
/** FireLater#21: the ids two runs are compared by. vitest prints a test's bare title on its "x" line in one version ("x bg", 5.x) and the describe path in
 *  another ("x page 1 > bg", 2.1.9), and Loki's batched per-file text prints the bare title; only the full "file > describe > title" ids from FAIL
 *  lines agree across them. When a list has full ids, only those are compared; otherwise (pytest, go, cargo) every id is. */
export function comparableIds(ids: readonly string[]): string[] {
  const full = ids.filter((i) => /^[^>]*\.[cm]?[jt]sx? > /.test(i));
  return full.length ? full : [...ids];
}

/** A runner error before any test ran that the change cannot have caused by itself: no tests found, a config that fails to load or resolve, zero items collected.
 *  Deliberately excludes "cannot find module", "error during collection" and "test suite failed to run": those are how a typo'd import, a renamed symbol or a
 *  syntax error in the change's own code surface, and a fix round repairs them cheaply. The one definition of this shape; a group carries no ids, so it reads the text. */
const ENV_SHAPED = /no tests? (?:found|executed|to run)|no test files found|failed to (?:load|resolve) config|collected 0 items/i;
export const environmentShaped = (groups: readonly Pick<FailureGroup, "signature" | "sample">[]): boolean => groups.length > 0 && groups.every((g) => ENV_SHAPED.test(`${g.signature}\n${g.sample ?? ""}`));
