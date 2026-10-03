// FC-16 (D86, L3/L5): the ONE place a check result is classified. A test check that executed zero tests is never a pass: it is
// not_run (NOT PROVEN, owned by the harness) with reason "no tests executed". A runner whose count cannot be parsed is the same,
// reported as unknown. A success verdict (VERIFIED or ALREADY_SATISFIED) needs at least one Loki-executed check with n>0 and a
// pass (hasExecutedProof). Every site that sets result "pass" for a test run routes through classifyCheck.

import { basename } from "node:path";

export const NO_TESTS_REASON = "no tests executed";
export const UNMEASURED_REASON = "executed count unmeasured (Loki could not parse the runner summary, harness-owned)";

/** Executed-test count from the runner's FINAL summary only (node TAP/spec trailer, pytest last line, jest/vitest "Tests"
 *  line, cargo "test result:", go "[no test"), never test names or captured stdout above it; null = no summary. 0 = empty or
 *  all skipped, never a pass (A-111). Node counts a testless file as one pseudo-test named after the file: discounted only when its name is the path under test (A-111b). */
export function ran(raw: string, path?: string): number | null {
  const out = stripAnsi(raw);
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const blk = out.trimEnd().match(/(?:^|\n)((?:(?:#|\u2139) \w+ [\d.]+(?:\n|$)){5,})$/)?.[1];
  if (blk) { const c = n(blk, /(?:#|\u2139) pass (\d+)/) + n(blk, /(?:#|\u2139) fail (\d+)/); const nm = out.match(/^(?:ok \d+ - |\u2714 )(\S+\.[cm]?[jt]s)(?: \(|$)/m)?.[1]; return c === 1 && nm && (!path || basename(nm) === basename(path)) ? 0 : c; }
  const cg = out.split("\n").filter((l) => l.startsWith("test result: "));
  if (cg.length) return cg.reduce((t, l) => t + n(l, /(\d+) passed/) + n(l, /(\d+) failed/), 0);
  const g = goCount(out);
  if (g !== undefined) return g;
  const tail = tailLines(out);
  const l = tail.filter((x) => /^(?:=+ )?(?:\d+ \w+.*|no tests ran) in [\d.]+s|^\s*Tests?:?\s+\d|^No tests found/.test(x) && (!/^\s*Tests?:?\s+\d/.test(x) || tail.some((y) => /^\s*Test (?:Files|Suites):?\s+\d/.test(y)))).pop(); // forge guard: a bare "Tests: 5 passed" needs its "Test Files|Suites" sibling in the trailer
  if (!l) return null;
  return /^(?:=+ )?no tests (?:ran|found)|^No tests found|skipped/i.test(l) || /\d+ (?:passed|failed|errors?)/.test(l) ? n(l, /(\d+) passed/) + n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : null;
}
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "");
/** The runner's own trailer: the last 12 non-empty lines. Earlier lines are test output and never a summary (forged-summary guard, M1). */
const tailLines = (out: string): string[] => out.split("\n").filter((x) => x.trim()).slice(-12);
const GO_PKG_RE = /^(?:ok|FAIL|\?)\s+\S+\s+(?:\(cached\)|[\d.]+s\b|\[(?:no test files|build failed|setup failed)\])/;
/** go test (-v): executed tests = top-level "--- PASS|FAIL" across every package. "[no test files]" is 0 only when no package ran tests.
 *  Non-verbose "ok pkg 0.1s" carries no count: null (unmeasured). undefined = not go output. */
function goCount(out: string): number | null | undefined {
  const lines = out.split("\n");
  if (!lines.some((x) => GO_PKG_RE.test(x))) return undefined;
  const t = lines.filter((x) => /^--- (?:PASS|FAIL): /.test(x)).length;
  if (t > 0) return t;
  if (lines.some((x) => /^(?:=== RUN|PASS$|FAIL$|testing: warning: no tests to run)/.test(x))) return 0;
  return lines.filter((x) => GO_PKG_RE.test(x)).every((x) => /\[no tests? (?:files|to run)\]/.test(x)) ? 0 : null;
}
/** Skipped or deselected tests from the runner's FINAL summary lines only: pytest "N skipped|deselected", jest/vitest "Tests: N skipped",
 *  node "# skipped N". Test names and captured output above the summary never count (A-115). */
export function skipped(raw: string): number {
  return stripAnsi(raw).split("\n").filter((l) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^\s*Tests?:?\s+\d|^(?:#|ℹ) skipped \d/.test(l.trim()))
    .reduce((t, l) => t + [...l.matchAll(/(\d+) (?:skipped|deselected|xfailed)|skipped (\d+)/g)].reduce((u, m) => u + +(m[1] ?? m[2]!), 0), 0);
}

/** Count for the runners we support: vitest, jest, bun test ("N pass"), pytest, go test (-v; non-verbose is unmeasured), unittest, playwright, cargo test, node --test, mocha.
 *  null = unknown (never a pass). A vitest run with no files and no "Tests" summary is a real 0. */
export function testCount(raw: string, path?: string): number | null {
  const out = stripAnsi(raw);
  if (/^\s*(?:Test Files\s+0\b|No test files found)/m.test(out) && !/^\s*Tests?\s+\d/m.test(out)) return 0;
  const r = ran(out, path);
  if (r !== null) return r;
  const bp = /^\s*(\d+) pass\s*$/m.exec(out), bf = /^\s*(\d+) fail\s*$/m.exec(out); // bun test
  if (bp || bf) return +(bp?.[1] ?? 0) + +(bf?.[1] ?? 0);
  const tl = tailLines(out);
  const ut = tl.findIndex((x) => /^Ran \d+ tests? in [\d.]+s$/.test(x)); // python -m unittest: "Ran N tests" then OK / FAILED
  if (ut >= 0 && tl.slice(ut + 1).some((x) => /^(?:OK|FAILED)\b/.test(x))) return +tl[ut]!.match(/^Ran (\d+)/)![1]!;
  const pw = tl.filter((x) => /^\s*\d+ (?:passed|failed|flaky)\b/.test(x)); // Playwright: "N passed (2s)" trailer
  if (pw.length && tl.some((x) => /^\s*\d+ passed \([\d.]+m?s\)/.test(x) || /^\s*\d+ failed$/.test(x))) return pw.reduce((t, x) => t + +x.trim().split(" ")[0]!, 0);
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
  if (n === null) return { result: "not_run", reason: UNMEASURED_REASON };
  return { result: "pass", n };
}
/** True when a check is Loki-executed proof: a pass with n>0. */
export const isExecutedProof = (c: { result?: unknown; n?: unknown }): boolean => c.result === "pass" && typeof c.n === "number" && c.n > 0;
/** Success-verdict gate: at least one executed check with n>0 and a pass. */
export const hasExecutedProof = (checks: ReadonlyArray<{ result?: unknown; n?: unknown }>): boolean => checks.some(isExecutedProof);
