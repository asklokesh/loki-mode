// FC-16 (D86, L3/L5): the ONE place a check result is classified. A test check that executed zero tests is never a pass: it is
// not_run (NOT PROVEN, owned by the harness) with reason "no tests executed". A runner whose count cannot be parsed is the same,
// reported as unknown. A success verdict (VERIFIED or ALREADY_SATISFIED) needs at least one Loki-executed check with n>0 and a
// pass (hasExecutedProof). Every site that sets result "pass" for a test run routes through classifyCheck.

import { basename } from "node:path";

export const NO_TESTS_REASON = "no tests executed";

/** Executed-test count from the runner's FINAL summary only (node TAP/spec trailer, pytest last line, jest/vitest "Tests"
 *  line, cargo "test result:", go "[no test"), never test names or captured stdout above it; null = no summary. 0 = empty or
 *  all skipped, never a pass (A-111). Node counts a testless file as one pseudo-test named after the file: discounted only when its name is the path under test (A-111b). */
export function ran(out: string, path?: string): number | null {
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const blk = out.trimEnd().match(/(?:^|\n)((?:(?:#|\u2139) \w+ [\d.]+(?:\n|$)){5,})$/)?.[1];
  if (blk) { const c = n(blk, /(?:#|\u2139) pass (\d+)/) + n(blk, /(?:#|\u2139) fail (\d+)/); const nm = out.match(/^(?:ok \d+ - |\u2714 )(\S+\.[cm]?[jt]s)(?: \(|$)/m)?.[1]; return c === 1 && nm && (!path || basename(nm) === basename(path)) ? 0 : c; }
  const cg = out.split("\n").filter((l) => l.startsWith("test result: "));
  if (cg.length) return cg.reduce((t, l) => t + n(l, /(\d+) passed/) + n(l, /(\d+) failed/), 0);
  const l = out.split("\n").filter((x) => /^(?:=+ )?(?:\d+ \w+.*|no tests ran) in [\d.]+s|^\s*Tests?:?\s+\d|^No tests found|^(?:ok|\?)\s+\S+\s/.test(x)).pop();
  if (!l || /^(?:ok|\?)\s/.test(l)) return l && /\[no test/.test(l) ? 0 : null;
  return /^(?:=+ )?no tests (?:ran|found)|^No tests found|skipped/i.test(l) || /\d+ (?:passed|failed|errors?)/.test(l) ? n(l, /(\d+) passed/) + n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : null;
}
/** Skipped or deselected tests from the runner's FINAL summary lines only: pytest "N skipped|deselected", jest/vitest "Tests: N skipped",
 *  node "# skipped N". Test names and captured output above the summary never count (A-115). */
export function skipped(out: string): number {
  return out.split("\n").filter((l) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^\s*Tests?:?\s+\d|^(?:#|ℹ) skipped \d/.test(l.trim()))
    .reduce((t, l) => t + [...l.matchAll(/(\d+) (?:skipped|deselected|xfailed)|skipped (\d+)/g)].reduce((u, m) => u + +(m[1] ?? m[2]!), 0), 0);
}

/** Count for the runners we support: vitest, jest, bun test ("N pass"), pytest, go test (-v or "[no test"), cargo test, node --test, mocha.
 *  null = unknown (never a pass). A vitest run with no files and no "Tests" summary is a real 0. */
export function testCount(out: string, path?: string): number | null {
  if (/^\s*(?:Test Files\s+0\b|No test files found)/m.test(out) && !/^\s*Tests?\s+\d/m.test(out)) return 0;
  const r = ran(out, path);
  if (r !== null) return r;
  const bp = /^\s*(\d+) pass\s*$/m.exec(out), bf = /^\s*(\d+) fail\s*$/m.exec(out); // bun test
  if (bp || bf) return +(bp?.[1] ?? 0) + +(bf?.[1] ?? 0);
  const gv = [...out.matchAll(/^\s*--- (?:PASS|FAIL):/gm)].length; // go test -v
  if (gv > 0) return gv;
  const mocha = /^\s*(\d+) passing\b/m.exec(out), mf = /^\s*(\d+) failing\b/m.exec(out);
  if (mocha || mf) return +(mocha?.[1] ?? 0) + +(mf?.[1] ?? 0);
  if (/^\s*0 passing\b/m.test(out)) return 0;
  return null;
}

export interface ClassifyInput { kind: "test" | "static"; ok: boolean; cut?: boolean; missing?: boolean; out: string; path?: string }
export interface Classified { result: "pass" | "fail" | "not_run"; n?: number; reason?: string }
/** One attempt of one check. static = lint/typecheck/scan (exit code decides, no count). test = a test runner: pass needs n>0. */
export function classifyCheck(i: ClassifyInput): Classified {
  if (i.missing) return { result: "not_run", reason: "tool not found on PATH" };
  if (i.cut) return { result: "not_run", reason: "timed out or aborted" };
  if (i.kind === "static") return { result: i.ok ? "pass" : "fail" };
  const n = testCount(i.out, i.path);
  if (n === 0) return { result: "not_run", n: 0, reason: `${NO_TESTS_REASON} (ran 0 tests, empty or all skipped)` };
  if (!i.ok) return { result: "fail", ...(n !== null ? { n } : {}) };
  if (n === null) return { result: "not_run", reason: `${NO_TESTS_REASON} (executed count unknown: runner summary not parsed)` };
  return { result: "pass", n };
}
/** True when a check is Loki-executed proof: a pass with n>0. */
export const isExecutedProof = (c: { result?: unknown; n?: unknown }): boolean => c.result === "pass" && typeof c.n === "number" && c.n > 0;
/** Success-verdict gate: at least one executed check with n>0 and a pass. */
export const hasExecutedProof = (checks: ReadonlyArray<{ result?: unknown; n?: unknown }>): boolean => checks.some(isExecutedProof);
