// engine10/failures.ts -- groups test failures into normalized reasons (E-17,
// docs/v10/ENGINE.md sections 4 and 16).
//
// Fast verify (E-09, not in this slice) runs pytest/vitest/jest and captures
// each failing invocation's raw output. This module extracts one failure per
// test from that output and folds them into at most 5 signatures, so a fix
// round (fix.ts) gets a short, deduplicated list instead of raw noise.
import type { RunnerName } from "./types.ts";
export interface RawFailure {
  runner: RunnerName;
  output: string; // raw stdout+stderr of one failing test-runner invocation
}
export interface Failure {
  testId: string; // e.g. "tests/test_x.py::test_y" or "src/x.test.ts > suite > case"
  reason: string; // the raw assertion/error text for that test
}
export interface FailureGroup {
  signature: string; // normalized reason: numbers and quoted values collapsed
  count: number;
  sample: string; // one raw (unnormalized) reason from the group
}
const MAX_GROUPS = 5;
/** Collapses numbers and quoted values so "expected 1 to be 2" and
 *  "expected 3 to be 4" group together. Never used for display: `sample`
 *  keeps the original text. */
function normalize(reason: string): string {
  return reason
    .replace(/'[^']*'/g, "<val>")
    .replace(/"[^"]*"/g, "<val>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}
function parsePytest(output: string): Failure[] {
  // pytest -q short summary info: "FAILED path::test - Reason text".
  const out: Failure[] = [];
  for (const line of output.split("\n")) {
    const m = /^FAILED\s+(\S+)\s*-\s*(.+)$/.exec(line.trim());
    if (m) out.push({ testId: m[1]!, reason: m[2]!.trim() });
  }
  return out;
}
/** Shared by vitest/jest: both mark a failing test with a one-line header
 *  (`marker` regex), then print the error a line or few below it. Takes the
 *  first non-empty, non-marker line as the reason. */
function parseMarkedBlocks(output: string, marker: RegExp, stopAt: RegExp): Failure[] {
  const out: Failure[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = marker.exec(line);
    if (!m) continue;
    const testId = m[1]!.trim();
    let reason = "";
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw === undefined) break;
      const cand = raw.trim().replace(/^→\s*/, ""); // strip a leading "-> "
      if (cand === "") continue;
      if (stopAt.test(cand)) break;
      reason = cand;
      break;
    }
    if (reason) out.push({ testId, reason });
  }
  return out;
}
const VITEST_MARKER = /^\s*(?:FAIL|×)\s+(.+)$/;
const VITEST_STOP = /^(?:FAIL|×|✓|❯)/;
const JEST_MARKER = /^\s*●\s+(.+)$/;
const JEST_STOP = /^●/;
const PARSERS: Partial<Record<RunnerName, (output: string) => Failure[]>> = {
  pytest: parsePytest,
  vitest: (output) => parseMarkedBlocks(output, VITEST_MARKER, VITEST_STOP),
  jest: (output) => parseMarkedBlocks(output, JEST_MARKER, JEST_STOP),
};
/** Extracts one Failure per failing test from a runner's raw output. Returns
 *  [] for a runner with no parser (go/cargo/npm/bun: not required by E-17). */
export function parseFailures(runner: RunnerName, output: string): Failure[] {
  const parser = PARSERS[runner];
  return parser ? parser(output) : [];
}
/** Groups failures by normalized reason, largest group first, capped at
 *  MAX_GROUPS (ties keep first-seen order: JS array sort is stable). */
export function groupFailures(raw: RawFailure[]): FailureGroup[] {
  const groups = new Map<string, { count: number; sample: string }>();
  for (const rf of raw) {
    for (const f of parseFailures(rf.runner, rf.output)) {
      const sig = normalize(f.reason);
      const g = groups.get(sig);
      if (g) g.count++;
      else groups.set(sig, { count: 1, sample: f.reason });
    }
  }
  return [...groups.entries()]
    .map(([signature, g]) => ({ signature, count: g.count, sample: g.sample }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_GROUPS);
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
export function failIds(output: string): string[] {
  const ids = [...new Set(output.split("\n").map((l) => ID_LINE.exec(l.trim())).flatMap((m) => (m ? [(m.slice(1).find(Boolean) ?? "").trim()] : [])).filter(Boolean))];
  const c = failCount(output);
  return c && ids.length >= c ? ids : [];
}
