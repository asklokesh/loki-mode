// engine10/failures.ts -- failing test ids (A-112) and the FailureGroup shape fix.ts consumes (E-17). The per-runner parsers and groupFailures had no production caller (only their own tests) and were deleted by A-115.
import { stripAnsi } from "../util/check_result.ts";
export interface FailureGroup {
  signature: string; // normalized reason: numbers and quoted values collapsed
  count: number;
  sample: string; // one raw (unnormalized) reason from the group
}
const ID_LINE = /^(?:(?:FAILED|ERROR)\s+(\S+::\S*)(?:\s.*)?|\u25cf\s+(?!Console|Test suite failed)(.+)|not ok \d+ - (.+?)(?:\s+#.*)?|\u2716\s+(?!failing tests:)(.+?)(?:\s+\([\d.]+ms\))?|FAIL\s+(.+)|\u00d7\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?)$/;
/** The runner's own failed-plus-errored count: pytest "N failed, M error", jest/vitest "Tests: N failed", node "fail N". */
function failCount(out: string): number | null {
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const l = out.split("\n").reverse().map((x) => x.trim()).find((x) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^Tests?:?\s+\d/.test(x)), m = /^(?:#|\u2139) fail (\d+)$/m.exec(out);
  return l ? n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : m ? +m[1]! : null;
}
/** A-112: failing test ids (pytest `FAILED|ERROR path::name`, jest `bullet Suite > name` or `bullet name`, node TAP `not ok N - name` or its
 *  spec cross line, vitest `FAIL name`). [] unless the ids cover the runner's reported count: a partial extraction (collection or install
 *  failure, "Tests: 0 total") can never be subtracted. */
/** go test (-json or plain) and cargo test ids, each with an independently counted failure total so a partial extraction stays fail-closed.
 *  go -json: id "pkg::Test" per Action=fail with a Test, or the package for a package-only fail; the count is the "--- FAIL:" output lines plus package-only fails.
 *  go plain: id is the "--- FAIL:" name, or the package of a "FAIL\tpkg" line that no test in that package explains. cargo: "test x ... FAILED" against the summed "N failed". */
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

export function failIds(raw: string): string[] {
  const output = stripAnsi(raw), gc = goCargoIds(output);
  if (gc) return gc;
  const ids = [...new Set(output.split("\n").map((l) => ID_LINE.exec(l.trim())).flatMap((m) => (m ? [(m.slice(1).find(Boolean) ?? "").trim()] : [])).filter(Boolean))];
  const c = failCount(output);
  return c && ids.length >= c ? ids : [];
}
