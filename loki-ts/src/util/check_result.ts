// FC-16 (D86, L3/L5): the ONE place a check result is classified. A test check that executed zero tests is never a pass: it is
// not_run (NOT PROVEN, owned by the harness) with reason "no tests executed". A runner whose count cannot be parsed is the same,
// reported as unknown. A success verdict (VERIFIED or ALREADY_SATISFIED) needs at least one Loki-executed check with n>0 and a
// pass (hasExecutedProof). Every site that sets result "pass" for a test run routes through classifyCheck.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const NO_TESTS_REASON = "no tests executed";
export const UNCONFIRMED_REASON = "test count could not be confirmed";
/** Real failure evidence in a failed run: a failed test line, a go build or setup failure, a go compiler error line, or "N failed|errors". */
const FAIL_EVIDENCE = /\[(?:build|setup) failed\]|^--- FAIL|^[\w./-]+\.go:\d+:\d+: \S|\b[1-9]\d* (?:failed|errors?)\b/m;
/** Extra failure evidence honoured only for a Go runner under a non-zero exit: a package FAIL line (log.Fatal, init panic, timeout) or a panic. */
const GO_FAIL_EVIDENCE = /^FAIL\t\S+\t[\d.]+s$|^panic: /m;
export const UNMEASURED_REASON = "executed count unmeasured (Loki could not parse the runner summary, harness-owned)";

/** Executed-test count from the runner's FINAL summary only (node TAP/spec trailer, pytest last line, jest/vitest "Tests"
 *  line, cargo "test result:", go "[no test"), never test names or captured stdout above it; null = no summary. 0 = empty or
 *  all skipped, never a pass (A-111). Node counts a testless file as one pseudo-test named after the file: discounted only when its name is the path under test (A-111b). */
export function ran(raw: string, path?: string, ok?: boolean): number | null {
  const out = stripAnsi(raw);
  const n = (s: string, re: RegExp): number => +(s.match(re)?.[1] ?? 0);
  const blk = out.trimEnd().match(/(?:^|\n)((?:(?:#|\u2139) \w+ [\d.]+(?:\n|$)){5,})$/)?.[1];
  if (blk) { const c = n(blk, /(?:#|\u2139) pass (\d+)/) + n(blk, /(?:#|\u2139) fail (\d+)/); const nm = out.match(/^(?:ok \d+ - |\u2714 )(\S+\.[cm]?[jt]s)(?: \(|$)/m)?.[1]; return c === 1 && nm && (!path || basename(nm) === basename(path)) ? 0 : c; }
  const cg = cargoTrailer(out);
  if (cg.length) return cg.reduce((t, l) => t + n(l, /(\d+) passed/) + n(l, /(\d+) failed/), 0);
  const g = goCount(out, ok);
  if (g !== undefined) return g;
  const tail = tailLines(out);
  const l = tail.filter((x) => /^(?:=+ )?(?:\d+ \w+.*|no tests ran) in [\d.]+s|^\s*Tests?:?\s+\d|^No tests found/.test(x) && (!/^\s*Tests?:?\s+\d/.test(x) || tail.some((y) => /^\s*Test (?:Files|Suites):?\s+\d/.test(y)))).pop(); // forge guard: a bare "Tests: 5 passed" needs its "Test Files|Suites" sibling in the trailer
  if (!l) return null;
  return /^(?:=+ )?no tests (?:ran|found)|^No tests found|skipped/i.test(l) || /\d+ (?:passed|failed|errors?)/.test(l) ? n(l, /(\d+) passed/) + n(l, /(\d+) failed/) + n(l, /(\d+) errors?/) : null;
}
const stripAnsi = (s: string): string => s.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/(?:\u001b\[|\u009b)[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
/** The runner's own trailer: the last 12 non-empty lines. Earlier lines are test output and never a summary (forged-summary guard, M1). */
const tailLines = (out: string): string[] => out.split("\n").filter((x) => x.trim()).slice(-12);
/** cargo test: one segment per "running N tests" header; a segment counts only through its LAST line being "test result:" (the real
 *  trailer). A "test result:" printed by a test (--nocapture) is followed by "test x ... ok" lines, so it never counts. The final
 *  segment must qualify, else nothing does. */
function cargoTrailer(out: string): string[] {
  const ls = out.split("\n").filter((x) => x.trim());
  while (ls.length && /^error: /.test(ls[ls.length - 1]!)) ls.pop();
  const segs: string[][] = [];
  for (const l of ls) {
    if (/^running \d+ tests?\b/.test(l)) segs.push([]);
    else if (segs.length && !/^\s*(?:Running |Doc-tests |Doctest)/.test(l)) segs[segs.length - 1]!.push(l);
  }
  const lastOf = (g: string[]): string | undefined => g[g.length - 1]?.startsWith("test result: ") ? g[g.length - 1] : undefined;
  if (!segs.length) { const g: string[] = []; for (let k = ls.length - 1; k >= 0 && ls[k]!.startsWith("test result: "); k--) g.push(ls[k]!); return g; } // headerless trailer
  if (!lastOf(segs[segs.length - 1]!)) return [];
  return segs.flatMap((g) => lastOf(g) ?? []);
}
/** bun test: only when the final line is "Ran N tests across", the nearest " N pass" / " N fail" lines above it. null = not bun output. */
function bunCount(out: string): number | null {
  const ls = out.split("\n").filter((x) => x.trim());
  if (!/^Ran \d+ tests? across \d+ files?\./.test(ls[ls.length - 1] ?? "")) return null;
  const blk = ls.slice(-9, -1);
  const last = (k: string): number => +(blk.map((x) => x.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`))?.[1]).filter(Boolean).pop() ?? 0);
  return last("pass") + last("fail");
}
/** python -m unittest: "Ran N tests in Xs" then OK / FAILED as the last two lines. Skipped and expected failures did not execute.
 *  L3: user code (an atexit handler) can print a forged trailer after a real one, so the trailer is never trusted alone: an
 *  second "Ran" block, or a verdict that contradicts the exit code, makes the count unknown (null). */
function unittestCount(out: string, ok?: boolean): number | null {
  const ls = out.split("\n").filter((x) => x.trim()), v = ls[ls.length - 1] ?? "", r = ls[ls.length - 2]?.match(/^Ran (\d+) tests? in [\d.]+s$/);
  if (!r || !/^(?:OK|FAILED)\b/.test(v)) return null;
  if (ls.filter((x) => /^Ran \d+ tests? in [\d.]+s$/.test(x)).length > 1) return null; // a second block may be an atexit forgery (also of an all-skipped "OK (skipped=N)")
  if ((ok === true && v.startsWith("FAILED")) || (ok === false && v.startsWith("OK"))) return null; // verdict contradicts the exit code
  return Math.max(0, +r[1]! - +(v.match(/skipped=(\d+)/)?.[1] ?? 0) - +(v.match(/expected failures=(\d+)/)?.[1] ?? 0));
}
const GO_PKG_RE = /^(?:ok|FAIL|\?)\s+\S+\s+(?:\(cached\)|[\d.]+s\b|\[(?:no test files|build failed|setup failed)\])/;
/** go test (-v): executed tests = top-level "--- PASS|FAIL" across every package. "[no test files]" is 0 only when no package ran tests.
 *  Non-verbose "ok pkg 0.1s" carries no count: null (unmeasured). undefined = not go output. */
function goCount(out: string, ok?: boolean): number | null | undefined {
  const lines = out.split("\n");
  if (!lines.some((x) => GO_PKG_RE.test(x))) return undefined;
  // a result line counts only after its own "=== RUN name"; a name that ever reports SKIP never counts (a forged PASS then t.Skip); the LAST status wins
  const last = new Map<string, string>(), seen = new Set<string>(), skip = new Set<string>(), failPkg = ok !== true && lines.some((x) => /^FAIL\s+\S+\s+[\d.]+s\b/.test(x));
  for (const x of lines) {
    const r = x.match(/^=== RUN\s+(\S+)/), m = x.match(/^--- (PASS|FAIL|SKIP): (\S+)/);
    if (r) seen.add(r[1]!); else if (m && (seen.has(m[2]!) || (m[1] === "FAIL" && failPkg))) { last.set(m[2]!, m[1]!); if (m[1] === "SKIP") skip.add(m[2]!); } // non-verbose go prints a FAIL line without "=== RUN"; a failing package line vouches for it, only when the run failed
  }
  for (const k of skip) last.set(k, "SKIP");
  if (ok === true && [...last.values()].includes("FAIL")) return null; // a FAIL line contradicts exit 0: forged (TestMain os.Exit(0)), unmeasured
  const t = [...last.values()].filter((v) => v !== "SKIP").length;
  if (t > 0) return t;
  if (lines.some((x) => /^(?:=== RUN|PASS$|FAIL$|testing: warning: no tests to run)/.test(x))) return 0;
  return lines.filter((x) => GO_PKG_RE.test(x)).every((x) => /\[no tests? (?:files|to run)\]/.test(x)) ? 0 : null;
}
/** One shared Go-runner detection for every caller (verify, deep, per-package suites): a shell command line or an argv, with
 *  leading env / command / exec / time wrappers, VAR=val assignments and a path to go (/usr/local/go/bin/go) all resolving to go.
 *  Any `&&`, `;`, `||` or `|` segment that runs go counts. Chosen from the command, never from output. Detecting go too often
 *  only fails closed (exit 0 is not_run), so a doubtful wrapper is classified as go. */
export function goRunner(cmd: string, args?: readonly string[]): { runner: "go" } | Record<string, never> {
  const segs = args ? [[cmd, ...args]] : cmd.split(/&&|\|\||[;|\n]/).map((x) => x.trim().split(/\s+/).filter(Boolean));
  for (const t0 of segs) {
    const t = t0.map((x) => x.replace(/^["']|["']$/g, ""));
    let k = 0;
    for (; k < t.length; k++) {
      const x = t[k]!;
      if (/^[A-Za-z_]\w*=/.test(x) || /^(?:env|command|exec|time|nohup)$/.test(basename(x))) continue;
      if (/^-/.test(x) && k > 0 && basename(t[k - 1]!) === "env") { if (x === "-u" || x === "-C" || x === "-S") k++; continue; }
      break;
    }
    if (t[k] !== undefined && basename(t[k]!) === "go") return { runner: "go" };
  }
  return {};
}
interface GoJson { tests: Array<{ pk: string; name: string }>; failed: boolean; pkgPass: boolean; doubt: boolean; noTests: Set<string> }
/** go test -json: every non-empty line is a test2json event (or a "go: " tool note); anything else is parse doubt (null). A test
 *  counts through its own top-level "run" then "pass" events (never a test that skipped). The stream itself is NOT trusted: the test
 *  binary can print the framing marker (\x16) and forge run and pass events for a test that does not exist, so goConfirm() checks
 *  every counted name against the package's *_test.go source, and a package whose Output says "no tests to run", or a name with more
 *  than one run event, is never counted (L2/L3). */
function goJson(out: string): GoJson | null {
  const last = new Map<string, string>(), runs = new Map<string, number>(), skip = new Set<string>(), pkgs = new Map<string, string>(), noTests = new Set<string>();
  let any = false, doubt = false;
  for (const x of out.split("\n")) {
    if (!x.trim() || /^go: /.test(x)) continue;
    let e: { Action?: unknown; Package?: unknown; Test?: unknown; Output?: unknown };
    try { e = JSON.parse(x) as typeof e; } catch { return null; }
    if (!e || typeof e !== "object" || typeof e.Action !== "string") return null;
    any = true;
    const a = e.Action, pk = typeof e.Package === "string" ? e.Package : "";
    if (a === "output" && typeof e.Output === "string" && /no tests to run/.test(e.Output)) noTests.add(pk);
    if (typeof e.Test === "string") {
      const key = `${pk}\u0000${e.Test}`;
      if (a === "run" && !e.Test.includes("/")) { runs.set(key, (runs.get(key) ?? 0) + 1); if (runs.get(key)! > 1) doubt = true; }
      else if (a === "pass" || a === "fail" || a === "skip") { if (!e.Test.includes("/") && (runs.has(key) || a === "fail")) last.set(key, a); if (a === "skip") skip.add(key); }
    } else if (a === "pass" || a === "fail" || a === "skip") pkgs.set(pk, a);
  }
  if (!any) return null;
  for (const k of skip) last.set(k, "skip");
  const entries = [...last.entries()];
  return {
    tests: entries.filter(([, v]) => v === "pass").map(([k]) => { const [pk, name] = k.split("\u0000"); return { pk: pk!, name: name! }; }),
    failed: entries.some(([, v]) => v === "fail") || [...pkgs.values()].includes("fail"),
    pkgPass: pkgs.size > 0 && [...pkgs.values()].every((x) => x === "pass" || x === "skip"), doubt, noTests,
  };
}
/** Static, harness-owned check of a Go pass: the number of counted tests that are real top-level `func TestX(` declarations in a
 *  *_test.go file of their package directory (package path resolved through the go.mod above root). null = not confirmable. */
function goConfirm(j: GoJson, root: string | undefined): number | null {
  if (!root || j.doubt) return null;
  const mods: Array<{ dir: string; mod: string }> = [], seenDir = new Set<string>();
  const addMod = (dir: string): void => { if (seenDir.has(dir)) return; seenDir.add(dir); try { const m = readFileSync(join(dir, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1]?.replace(/^"|"$/g, ""); if (m) mods.push({ dir, mod: m }); } catch { /* none here */ } };
  for (let d = resolve(root); ; d = dirname(d)) { addMod(d); if (dirname(d) === d) break; } // go.mod at or above root
  const down = (d: string, depth: number): void => { if (depth > 3) return; try { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !/^(?:\.|node_modules$|vendor$)/.test(e.name)) { addMod(join(d, e.name)); down(join(d, e.name), depth + 1); } } catch { /* unreadable */ } };
  down(resolve(root), 1); // a nested module (backend/go.mod) when root is the repo
  if (!mods.length) return null;
  const declared = new Map<string, Set<string>>();
  const namesIn = (pk: string): Set<string> | null => {
    if (declared.has(pk)) return declared.get(pk)!;
    const m = mods.filter((x) => pk === x.mod || pk.startsWith(`${x.mod}/`)).sort((p, q) => q.mod.length - p.mod.length)[0];
    if (!m) return null;
    const dir = join(m.dir, pk.slice(m.mod.length + 1)), set = new Set<string>();
    try { for (const f of readdirSync(dir)) if (f.endsWith("_test.go")) for (const mm of readFileSync(join(dir, f), "utf8").matchAll(/^func (Test\w*)\(/gm)) set.add(mm[1]!); } catch { return null; }
    declared.set(pk, set); return set;
  };
  let n = 0;
  for (const t of j.tests) {
    if (j.noTests.has(t.pk)) continue; // the package itself said no tests ran: its events are forged
    const d = namesIn(t.pk);
    if (!d || !d.has(t.name)) return null; // a pass for a name no *_test.go declares
    n++;
  }
  return n;
}
/** Skipped or deselected tests from the runner's FINAL summary lines only: pytest "N skipped|deselected", jest/vitest "Tests: N skipped",
 *  node "# skipped N". Test names and captured output above the summary never count (A-115). */
export function skipped(raw: string): number {
  return stripAnsi(raw).split("\n").filter((l) => /^(?:=+ )?\d+ \w+.* in [\d.]+s|^\s*Tests?:?\s+\d|^(?:#|ℹ) skipped \d/.test(l.trim()))
    .reduce((t, l) => t + [...l.matchAll(/(\d+) (?:skipped|deselected|xfailed)|skipped (\d+)/g)].reduce((u, m) => u + +(m[1] ?? m[2]!), 0), 0);
}

/** Count for the runners we support: vitest, jest, bun test ("N pass"), pytest, go test (-v; non-verbose is unmeasured), unittest, playwright, cargo test, node --test, mocha.
 *  null = unknown (never a pass). A vitest run with no files and no "Tests" summary is a real 0. */
export function testCount(raw: string, path?: string, ok?: boolean): number | null {
  const out = stripAnsi(raw);
  const bu = bunCount(out), ut = unittestCount(out, ok);
  if (bu !== null) return bu;
  if (ut !== null) return ut;
  if (/^\s*(?:Test Files\s+0\b|No test files found)/m.test(out) && !/^\s*Tests?\s+\d/m.test(out)) return 0;
  const r = ran(out, path, ok);
  if (r !== null) return r;
  const tl = tailLines(out);
  const pw = tl.filter((x) => /^\s*\d+ (?:passed|failed|flaky)\b/.test(x)); // Playwright: "N passed (2s)" trailer
  if (pw.length && tl.some((x) => /^\s*\d+ passed \([\d.]+m?s\)/.test(x) || /^\s*\d+ failed$/.test(x))) return pw.reduce((t, x) => t + +x.trim().split(" ")[0]!, 0);
  const lastNum = (re: RegExp): number | null => { const m = [...out.matchAll(re)].pop(); return m ? +m[1]! : null; };
  const mp = lastNum(/^\s*(\d+) passing\b/gm), mf = lastNum(/^\s*(\d+) failing\b/gm); // mocha: the LAST summary, never an earlier stdout line
  if (mp !== null || mf !== null) return (mp ?? 0) + (mf ?? 0);
  return null;
}

export interface ClassifyInput { kind: "test" | "static"; ok: boolean; cut?: boolean; missing?: boolean; out: string; path?: string; runner?: "go"; goRoot?: string }
export interface Classified { result: "pass" | "fail" | "not_run"; n?: number; reason?: string }
/** One attempt of one check. static = lint/typecheck/scan (exit code decides, no count). test = a test runner: pass needs n>0. */
export function classifyCheck(i: ClassifyInput): Classified {
  if (i.missing) return { result: "not_run", reason: "tool not found on PATH" };
  if (i.cut) return { result: "not_run", reason: "timed out or aborted" };
  if (i.kind === "static") return { result: i.ok ? "pass" : "fail" };
  const text = stripAnsi(i.out);
  // Go: the count comes from text a test can forge, so it is never trusted. Exit 0 is never a pass from parsing; a failed run is a
  // fail only when the output shows real failure evidence, else unconfirmed. A parse problem never fails the code and never passes.
  if (i.runner === "go") { // chosen from the command, never from output text a test can print
    const j = goJson(text); // go test -json: a count that only go's own event stream can produce
    if (j) {
      const zero = { result: "not_run" as const, n: 0, reason: `${NO_TESTS_REASON} (ran 0 tests, empty or all skipped)` };
      if (i.ok) {
        if (j.failed || !j.pkgPass || j.doubt) return { result: "not_run", reason: UNCONFIRMED_REASON };
        if (j.tests.length === 0) return zero;
        const n = goConfirm(j, i.goRoot);
        return n === null ? { result: "not_run", reason: UNCONFIRMED_REASON } : n > 0 ? { result: "pass", n } : zero;
      }
      return j.failed ? { result: "fail" } : { result: "not_run", reason: UNCONFIRMED_REASON };
    }
    // no usable -json stream (plain or -v output): exit 0 is never a pass from parsing; a failed run is a fail only with real failure evidence
    if (i.ok) return { result: "not_run", reason: UNCONFIRMED_REASON };
    return FAIL_EVIDENCE.test(text) || GO_FAIL_EVIDENCE.test(text) ? { result: "fail" } : { result: "not_run", reason: UNCONFIRMED_REASON };
  }
  const n = testCount(i.out, i.path, i.ok);
  if (!i.ok && FAIL_EVIDENCE.test(text)) return { result: "fail", ...(n !== null ? { n } : {}) }; // L2: a failure is never downgraded by a zero count
  if (n === 0) return { result: "not_run", n: 0, reason: `${NO_TESTS_REASON} (ran 0 tests, empty or all skipped)` };
  if (!i.ok) return { result: "fail", ...(n !== null ? { n } : {}) };
  if (n === null) return { result: "not_run", reason: UNMEASURED_REASON };
  return { result: "pass", n };
}
/** True when a check is Loki-executed proof: a pass with n>0. */
export const isExecutedProof = (c: { result?: unknown; n?: unknown }): boolean => c.result === "pass" && typeof c.n === "number" && c.n > 0;
/** Success-verdict gate: at least one executed check with n>0 and a pass. */
export const hasExecutedProof = (checks: ReadonlyArray<{ result?: unknown; n?: unknown }>): boolean => checks.some(isExecutedProof);
