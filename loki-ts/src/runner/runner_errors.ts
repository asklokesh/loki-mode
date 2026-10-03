// FC-02 / Engine Law L5: one shared classifier for "the test runner could not load or collect" versus "a test failed".
// A load or collection error is an ERROR owned by the harness (cwd, config, install, import path), never by the code
// under test, so it must not drive fix rounds or count toward STALLED. Used by verify.ts, wall.ts and deep.ts.
// ponytail: text-pattern based, like failures.ts; a real failed-test count in the same output always wins (mixed output is a code failure).

export interface RunnerOutcome {
  kind: "load_error" | "test_failure";
  owner: "harness" | "code";
  /** Plain reason for NOT PROVEN, set when kind is load_error. */
  reason?: string;
}

/** True when the runner's own output reports at least one genuinely failed test (not a suite that failed to load). */
function hasRealTestFailure(out: string): boolean {
  return /^\s*Tests:?\s+.*\b[1-9]\d* failed\b/m.test(out)             // "Tests  2 failed | 5 passed"
    || /^(?:=+ )?.*\b[1-9]\d* failed\b.* in [\d.]+s/m.test(out)       // summary line
    || /^FAILED \S+::/m.test(out)                                     // FAILED path::name line
    || /^(?:#|ℹ) fail [1-9]/m.test(out)                          // TAP
    || /^\s*[1-9]\d*\s+fail\s*$/m.test(out)                           // count line
    || /^\s*(?:FAIL|×)\s+\S.*\s>\s/m.test(out)                   // per-test "FAIL file > suite > name"
    || /\bAssertionError\b/.test(out);
}

const LOAD_PATTERNS: [RegExp, string][] = [
  [/Failed Suites\s+[1-9]/, "test suite failed to load"],
  [/Test suite failed to run/, "test suite failed to run"],
  [/Failed to load (?:url|config)|failed to load config|Failed to resolve (?:import|entry)/i, "runner config or import could not be loaded"],
  [/^\s*(?:\w*Error: )?Cannot find (?:module|package) '[^']+'/m, "module not found while loading tests"],
  [/ERR_MODULE_NOT_FOUND/, "module not found while loading tests"],
  [/Interrupted: \d+ errors? during collection/, "collection error"],
  [/^_+ ERROR collecting /m, "collection error"],
  [/ImportError while importing test module/, "test module import error"],
  [/^ERROR: (?:file or directory not found|not found:)/m, "test path not found by the runner"],
  [/No test files found, exiting with code [1-9]/, "runner found no test files (wrong cwd or path)"],
  [/\[setup failed\]|cannot find package|no required module provides package/, "go package could not be set up"],
  [/could not determine executable to run/i, "test runner executable not found"],
  [/^(?:\S+: )?(?:line \d+: )?[\w.-]+: command not found$/m, "test runner executable not found"],
];

/** First line carrying the error, capped, for the NOT PROVEN reason. */
function firstLoadLine(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const l = lines.find((x) => /^(?:E\s+)?(?:Error|\w*Error|ERROR|Failed|FAIL)\b|Cannot find|Interrupted:|No test files found/.test(x)) ?? lines[0] ?? "";
  return l.replace(/\s+/g, " ").slice(0, 160);
}

/** Classifies a FAILED run's output (exit nonzero). A passing run must not be passed here. */
export function classifyRunnerOutput(out: string): RunnerOutcome {
  if (!hasRealTestFailure(out)) {
    for (const [re, why] of LOAD_PATTERNS) {
      if (re.test(out)) return { kind: "load_error", owner: "harness", reason: `runner could not load: ${why}: ${firstLoadLine(out)}` };
    }
  }
  return { kind: "test_failure", owner: "code" };
}

export const isRunnerLoadError = (out: string): boolean => classifyRunnerOutput(out).kind === "load_error";
