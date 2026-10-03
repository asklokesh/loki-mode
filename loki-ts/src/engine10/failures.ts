// engine10/failures.ts -- failing test ids (A-112) and the FailureGroup shape fix.ts consumes (E-17).
// The per-runner parsers and groupFailures had no production caller (only their own tests) and were deleted by A-115.
export interface FailureGroup {
  signature: string; // normalized reason: numbers and quoted values collapsed
  count: number;
  sample: string; // one raw (unnormalized) reason from the group
}
const ID_LINE = /^(?:(?:FAILED|ERROR)\s+(\S+::\S*)(?:\s.*)?|\u25cf\s+(?!Console|Test suite failed)(.+)|not ok \d+ - (.+?)(?:\s+#.*)?|\u2716\s+(?!failing tests:)(.+?)(?:\s+\([\d.]+ms\))?|(?:FAIL|\u00d7)\s+(.+))$/;
/** The runner's own failed-plus-errored count: pytest "N failed, M error", jest/vitest "Tests: N failed", node "fail N". */
function failCount(out: string): number | null {
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const l = out.split("\n").reverse().map((x) => x.trim()).find((x) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^Tests?:?\s+\d/.test(x)), m = /^(?:#|\u2139) fail (\d+)$/m.exec(out);
  return l ? n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : m ? +m[1]! : null;
}
/** A-112: failing test ids (pytest `FAILED|ERROR path::name`, jest `bullet Suite > name` or `bullet name`, node TAP `not ok N - name` or its
 *  spec cross line, vitest `FAIL name`). [] unless the ids cover the runner's reported count: a partial extraction (collection or install
 *  failure, "Tests: 0 total") can never be subtracted. */
import { goJsonText } from "../util/check_result.ts";
export function failIds(raw: string): string[] {
  const output = goJsonText(raw);
  const ids = [...new Set(output.split("\n").map((l) => ID_LINE.exec(l.trim())).flatMap((m) => (m ? [(m.slice(1).find(Boolean) ?? "").trim()] : [])).filter(Boolean))];
  const c = failCount(output);
  return c && ids.length >= c ? ids : [];
}
