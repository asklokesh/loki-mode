// FC-16 (D86, L3/L5): the ONE place a check result is classified. A test check that executed zero tests is never a pass: it is
// not_run (NOT PROVEN, owned by the harness) with reason "no tests executed". A runner whose count cannot be parsed is the same,
// reported as unknown. A success verdict (VERIFIED or ALREADY_SATISFIED) needs at least one Loki-executed check with n>0 and a
// pass (hasExecutedProof). Every site that sets result "pass" for a test run routes through classifyCheck.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { siteFor } from "../project_model/resolve.ts";
import type { ProjectApi } from "../project_model/api.ts";
import { isTestFile } from "../engine10/testmap.ts";
import type { RunnerName, TestRef } from "../engine10/types.ts";
import { safeGit, tokenFreeEnv } from "./safe_git.ts";
import { redactSecrets } from "./redact.ts";

/** FC-69: the ONE child env for every harness-run test or verify command. A user's FORCE_COLOR=3 makes node:test, pytest, jest and
 *  friends emit ANSI that defeats line-anchored result parsers; FORCE_COLOR=0 + NO_COLOR=1 keeps the output plain. CI is left as is.
 *  FC-87: the base is token-filtered (GH_TOKEN family and SSH_AUTH_SOCK dropped), so a test command never carries credentials whatever the parent. */
export function plainTestEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokenFreeEnv(base))) if (typeof v === "string") e[k] = v;
  e["FORCE_COLOR"] = "0"; e["NO_COLOR"] = "1";
  delete e["CLICOLOR_FORCE"];
  return e;
}
export const NO_TESTS_REASON = "no tests executed";
export const GO_EXIT0_REASON = "test count could not be confirmed: go test output is produced by the code under test and cannot confirm execution (a Go exit 0 is never a pass)";
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
/** FC-69: the ONE ANSI stripper every tool-output parser reads through (CSI, 8-bit CSI, OSC; CRLF folded to LF). */
export const stripAnsi = (s: string): string => s.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/(?:\u001b\[|\u009b)[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
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
/** go test -json, used for FAIL evidence only: every non-empty line is a test2json event (or a "go: " tool note), else null (parse
 *  doubt). failed = a test or package reported fail. A pass is never read from this stream (see GO_EXIT0_REASON). */
function goJson(out: string): { failed: boolean } | null {
  let any = false, failed = false;
  for (const x of out.split("\n")) {
    if (!x.trim() || /^go: /.test(x)) continue;
    let e: { Action?: unknown };
    try { e = JSON.parse(x) as typeof e; } catch { return null; }
    if (!e || typeof e !== "object" || typeof e.Action !== "string") return null;
    any = true;
    if (e.Action === "fail") failed = true;
  }
  return any ? { failed } : null;
}
/** Executed-test count for a run whose `ran()` is null: node spec prints its failing-tests section after the summary block, so take the LAST
 *  pass and fail summary lines, not every one (A-112b: moved out of core engine10 verify.ts, no behaviour change). */
export function summaryPassFailCount(out: string): number {
  return (["pass", "fail"] as const).reduce((t, k) => t + +([...out.matchAll(new RegExp(`^(?:#|\\u2139) ${k} (\\d+)$`, "gm"))].pop()?.[1] ?? 0), 0);
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

export interface ClassifyInput { kind: "test" | "static"; ok: boolean; cut?: boolean; missing?: boolean; out: string; path?: string; runner?: "go" }
export interface Classified { result: "pass" | "fail" | "not_run"; n?: number; reason?: string }
/** classifyCheck result plus the rerun-only "flaky" verdict (TEN-QUALITY-17); kept separate so existing classifyCheck callers keep the narrow type. */
export interface ClassifiedRerun extends Omit<Classified, "result"> { result: Classified["result"] | "flaky"; rerun?: { first: "fail"; second: "pass"; n?: number } }
/** One attempt of one check. static = lint/typecheck/scan (exit code decides, no count). test = a test runner: pass needs n>0. */
export function classifyCheck(i: ClassifyInput): Classified {
  if (i.missing) return { result: "not_run", reason: "tool not found on PATH" };
  if (i.cut) return { result: "not_run", reason: "timed out or aborted" };
  if (i.kind === "static") return { result: i.ok ? "pass" : "fail" };
  const text = stripAnsi(i.out);
  // Go: the count comes from text a test can forge, so it is never trusted. Exit 0 is never a pass from parsing; a failed run is a
  // fail only when the output shows real failure evidence, else unconfirmed. A parse problem never fails the code and never passes.
  if (i.runner === "go") { // chosen from the command, never from output text a test can print
    if (i.ok) return { result: "not_run", reason: GO_EXIT0_REASON };
    const j = goJson(text); // go test -json: fail evidence (a fail event) on a red run
    if (j) return j.failed ? { result: "fail" } : { result: "not_run", reason: UNCONFIRMED_REASON };
    // no usable -json stream (plain or -v output): exit 0 is never a pass from parsing; a failed run is a fail only with real failure evidence
    return FAIL_EVIDENCE.test(text) || GO_FAIL_EVIDENCE.test(text) ? { result: "fail" } : { result: "not_run", reason: UNCONFIRMED_REASON };
  }
  const n = testCount(i.out, i.path, i.ok);
  if (!i.ok && FAIL_EVIDENCE.test(text)) return { result: "fail", ...(n !== null ? { n } : {}) }; // L2: a failure is never downgraded by a zero count
  if (n === 0) return { result: "not_run", n: 0, reason: `${NO_TESTS_REASON} (ran 0 tests, empty or all skipped)` };
  if (!i.ok) return { result: "fail", ...(n !== null ? { n } : {}) };
  if (n === null) return { result: "not_run", reason: UNMEASURED_REASON };
  return { result: "pass", n };
}
/** TEN-QUALITY-17: a test check that fails and then passes on ONE immediate rerun is flaky, not fail, so fix rounds are not spent on it.
 *  Only a test whose first attempt classified fail is rerun (static, not_run and pass never are); a rerun that is not a pass keeps the first fail.
 *  flaky carries no n, so it is never executed proof (isExecutedProof needs result "pass"), exogenous or otherwise. */
export function classifyWithRerun(first: ClassifyInput, rerun: () => ClassifyInput): ClassifiedRerun {
  const a = classifyCheck(first);
  if (first.kind !== "test" || a.result !== "fail") return a;
  const b = classifyCheck(rerun());
  if (b.result !== "pass") return a;
  return { result: "flaky", reason: "failed once, passed on one immediate rerun", rerun: { first: "fail", second: "pass", ...(b.n !== undefined ? { n: b.n } : {}) } };
}
/** True when a check is Loki-executed proof: a pass with n>0. */
export const isExecutedProof = (c: { result?: unknown; n?: unknown }): boolean => c.result === "pass" && typeof c.n === "number" && c.n > 0;
/** Success-verdict gate: at least one executed check with n>0 and a pass. */
export const hasExecutedProof = (checks: ReadonlyArray<{ result?: unknown; n?: unknown }>): boolean => checks.some(isExecutedProof);

/** TEN-GATES-01 (FC-AGENT-PROOF): who authored the evidence behind a check. exogenous = lint/typecheck/static, scans, pre-existing suites, boot, probes;
 *  independent = a Wall file or the holdout; agent_authored = a runner on a path ADDED in the diff; llm_judge = council-style reviewers.
 *  Unknown names are exogenous (fail-closed toward the existing behaviour, same direction as proof-generator.py:286-292). Pure, no wiring. */
export type CheckProvenance = "exogenous" | "independent" | "agent_authored" | "llm_judge";
export interface ProvenanceCtx { addedFiles: readonly string[]; wallFiles: readonly string[]; holdout?: boolean; modifiedFiles?: readonly string[] } // modifiedFiles: pre-existing paths the run edited, deleted or renamed (TEN-GATES-17)
const LLM_JUDGES = new Set(["council", "xreview", "code_review", "devils_advocate", "magic_debate"]);
const NON_RUNNER = new Set(["lint", "typecheck", "holdout", "select-tests"]); // heads verify.ts emits that are not test runners
const normPath = (p: string): string => p.replace(/^(?:\.\/)+/, "");
export function checkProvenance(name: string, ctx: ProvenanceCtx): CheckProvenance {
  const head = name.split(":")[0]!;
  if (LLM_JUDGES.has(head)) return "llm_judge";
  if (head === "holdout") return "independent";
  if (!NON_RUNNER.has(head) && name.includes(":")) { // test checks are named `${runner}:${path}` (verify.ts testCheckName); any other head is a runner
    const p = normPath(name.slice(name.indexOf(":") + 1));
    if (ctx.wallFiles.some((w) => normPath(w) === p)) return "independent";
    if (ctx.addedFiles.some((a) => normPath(a) === p)) return "agent_authored";
    if (ctx.modifiedFiles?.some((m) => normPath(m) === p)) return "agent_authored"; // TEN-GATES-17: a pre-existing test the run edited is no longer the original proof (same direction as the A-119 edit rule)
  }
  return "exogenous";
}
/** True when some executed check (pass, n>0) is not backed solely by agent-authored or LLM-judge evidence. */
export const hasExogenousProof = (checks: ReadonlyArray<{ name?: string; result?: unknown; n?: unknown }>, ctx: ProvenanceCtx): boolean =>
  checks.some((c) => isExecutedProof(c) && ((p) => p !== "agent_authored" && p !== "llm_judge")(checkProvenance(c.name ?? "", ctx)));
/** TEN-GATES-14: per-gate legibility for `loki verify --explain`. exogenous/independent evidence is exogenous; agent_authored and llm_judge are agent-influenced; absent or unknown provenance is unrecorded, never exogenous. */
export interface ExplainGate { name: string; class: "exogenous" | "agent-influenced" | "unrecorded"; provenance: string | null; result: string; n: number | null; evidence: string }
export function explainGates(receiptPath: string): ExplainGate[] {
  let checks: Array<Record<string, unknown>> = [];
  try { const c = (JSON.parse(readFileSync(receiptPath, "utf8")) as { checks?: unknown }).checks; if (Array.isArray(c)) checks = c.filter((x): x is Record<string, unknown> => !!x && typeof x === "object"); } catch { /* unreadable: no gates */ }
  return checks.map((c) => {
    const p = typeof c.provenance === "string" ? c.provenance : null;
    return { name: String(c.name ?? ""), class: p === "exogenous" || p === "independent" ? "exogenous" : p === "agent_authored" || p === "llm_judge" ? "agent-influenced" : "unrecorded", provenance: p, result: String(c.result ?? "not_run"), n: typeof c.n === "number" ? c.n : null, evidence: String(c.cmd ?? "") };
  });
}
const printable = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, "?"); // receipt text never drives the terminal
/** What the receipt verifier saw: set once it resolves a run receipt and prints its verdict. */
export interface ExplainRec { runId?: string; receiptPath?: string; verdict?: string; reasons?: string[]; receiptSha256?: string | null; independent?: { k: number; of: number } | null }
/** --explain lists each gate after the verdict; --json prints {run_id, run, verdict, exit_code, receipt_sha256, reasons, agent_independent:{k,of}, gates} on stdout (TEN-GATES-26) with the human lines on stderr. Read-only: the exit code is the verifier's, unchanged; a TAMPERED receipt's gates are never listed. */
export async function withExplain(args: readonly string[], run: (args: readonly string[], rec: ExplainRec) => Promise<number>): Promise<number> {
  const explain = args.includes("--explain"), json = args.includes("--json");
  if (!explain && !json) return run(args, {});
  const mode = args.find((a) => /^--(export-dsse|seal-composite|sign-deploy|sign-provenance|url)(=|$)/.test(a)); // these print their own documents, not a receipt verdict
  if (mode) return (process.stderr.write(`loki verify: --explain and --json are not supported with ${mode.split("=")[0]}\n`), 2);
  const rec: ExplainRec = {}, w = process.stdout.write;
  if (json) process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let code: number;
  try { code = await run(args.filter((a) => a !== "--explain" && a !== "--json"), rec); } finally { if (json) process.stdout.write = w; }
  if (!rec.receiptPath || !rec.verdict) return (process.stderr.write("loki verify: --explain and --json apply to a run receipt only; nothing explained\n"), code);
  const gates = rec.verdict === "TAMPERED" ? null : explainGates(rec.receiptPath);
  if (json) return (process.stdout.write(`${JSON.stringify({ run_id: rec.runId ?? null, run: rec.runId ?? null, verdict: rec.verdict, exit_code: code, receipt_sha256: rec.receiptSha256 ?? null, reasons: rec.reasons ?? [], agent_independent: rec.verdict === "TAMPERED" ? null : rec.independent ?? null, gates })}\n`), code);
  if (!gates) return (process.stdout.write("explain: receipt TAMPERED; its gates are untrusted and not listed\n"), code);
  process.stdout.write(`explain: ${gates.length} gate${gates.length === 1 ? "" : "s"} (exogenous: evidence the agent could not shape; agent-influenced: agent-authored test or LLM judge; unrecorded: no provenance)\n`);
  for (const g of gates) process.stdout.write(`  gate ${printable(g.name)}: ${g.class} (provenance ${g.provenance === null ? "not recorded" : printable(g.provenance)}), result ${printable(g.result)}, n ${g.n ?? "-"}, evidence: ${printable(g.evidence) || "-"}\n`);
  return code;
}

// RISKTIER: classify risk on the ARTIFACT (the actual diff), never the prompt, and map the tier to a verification plan.
// The bash `loki review --risk` scorer (autonomy/lib/review_risk.py) stays a separate 0-100 advisory view.
export type RiskTier = "low" | "medium" | "high";
export interface DiffFile { path: string; added: number; deleted: number; status?: "added" | "modified" | "deleted"; deps?: boolean /* set by diffFiles for a dependency manifest whose dependency set changed */ }
export interface RiskOverride { from: RiskTier; to: RiskTier; reason: string }
export interface RiskAssessment {
  version: 1; tier: RiskTier; computed: RiskTier; reasons: string[];
  stats: { files: number; lines: number; sensitive: string[]; tests_modified: string[]; tests_deleted: string[]; api: string[] };
  checks_selected: string[]; checks_deferred: string[]; // deferred = planned for this tier but NOT run by the fast verify stage; never a pass
  override?: RiskOverride; override_ignored?: string; advisories?: string[]; summary: string;
}

const SENSITIVE: [string, RegExp][] = [
  ["auth", /(^|\/)(auth|oauth|sso|session|login|permission|rbac|acl)[\w.-]*(\/|\.|$)/i],
  ["crypto", /(^|\/)(crypt|crypto|jwt|signing|keys?|secrets?|tokens?|credential|password)[\w.-]*(\/|\.|$)/i],
  ["payments", /(^|\/)(payments?|billing|checkout|stripe|invoice)[\w.-]*(\/|\.|$)/i],
  ["migration", /(^|\/)(migrations?|alembic)\/|\.sql$/i],
  ["ci", /(^|\/)(\.github\/(workflows|actions)|\.gitlab-ci\.yml|\.circleci|Jenkinsfile|azure-pipelines)/i],
  ["lockfile", /(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|go\.sum|[\w-]+\.lock)$/],
  ["infra", /(^|\/)(Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|terraform|helm|k8s|kubernetes|infra|deploy)(\/|\.|$)|\.tf$/i],
  ["env", /(^|\/)\.env[\w.]*$/],
];
const API: RegExp = /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$|\.proto$|\.d\.ts$|(^|\/)(api|routes|public)\/|(^|\/)index\.(ts|js|py)$/i;
const TEST_CFG = /(^|\/)(conftest\.py|\.?pytest\.(ini|toml)|tox\.ini|jest\.config\.[\w.]+|vitest\.config\.[\w.]+)$/;
const RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
const FILES_MEDIUM = 4, FILES_HIGH = 15, LINES_MEDIUM = 100, LINES_HIGH = 500;

// Fast verify always runs targeted tests and lint of changed files; anything else in `selected` is required depth.
const RAN_ALWAYS = ["targeted tests", "lint of changed files"];
const PLAN: Record<RiskTier, { selected: string[] }> = {
  low: { selected: [...RAN_ALWAYS] },
  medium: { selected: [...RAN_ALWAYS, "full test command", "one reviewer"] },
  high: { selected: [...RAN_ALWAYS, "full test command", "full suite", "council", "security scan"] },
};
const LOW_SKIPPED = ["full test command", "reviewer", "council", "security scan"]; // low skips these by design; they are listed so the record never implies they ran
const deferredOf = (tier: RiskTier, selected: string[], executed: string[]): string[] => (tier === "low" ? LOW_SKIPPED : selected).filter((c) => !RAN_ALWAYS.includes(c) && !executed.includes(c));

function summaryOf(a: Pick<RiskAssessment, "tier" | "computed" | "reasons" | "override" | "checks_deferred">): string {
  const why = a.tier === a.computed ? a.reasons.slice(0, 2).join("; ") : `computed ${a.computed}; override ${a.override?.from} to ${a.override?.to}: ${a.override?.reason}`;
  const def = a.checks_deferred;
  return `risk: ${a.tier} (${why}), ${def.length ? def.join(", ") : "no deeper checks"} not run`;
}

/** Marks selected deeper checks that verify really executed (for example the full test command), then rebuilds deferred and summary. */
export function markExecuted(a: RiskAssessment, executed: string[]): RiskAssessment {
  const checks_deferred = deferredOf(a.tier, a.checks_selected, executed);
  return { ...a, checks_deferred, summary: summaryOf({ ...a, checks_deferred }) + (a.advisories?.length ? `; advisory: ${a.advisories.join(", ")}` : "") };
}

// TEN-GATES-18: advisory only. A dependency manifest whose dependency set changed with no lockfile change beside it (same or ancestor dir) is flagged; it never alters the tier.
const MANIFEST_LOCKS: [RegExp, RegExp][] = [
  [/(^|\/)package\.json$/, /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/],
  [/(^|\/)pyproject\.toml$/, /(^|\/)(poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock)$/],
  [/(^|\/)go\.mod$/, /(^|\/)go\.sum$/],
];
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const PKG_DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const PYPROJECT_NONDEP = /^(name|version|description|readme|license|requires-python|python|authors|maintainers|keywords|classifiers|homepage|repository|documentation|packages|include|exclude)$/;

/** Pure: did the dependency set of this manifest change? package.json compares the four dependency maps (scripts-only edits are false); go.mod and pyproject.toml read the -U0 patch. Unparseable package.json counts as changed. */
export function manifestDepsChanged(path: string, oldText: string, newText: string, patch: string): boolean {
  if (/(^|\/)package\.json$/.test(path)) {
    try {
      const o = oldText.trim() ? JSON.parse(oldText) : {}, n = newText.trim() ? JSON.parse(newText) : {};
      return PKG_DEP_KEYS.some((k) => JSON.stringify(o?.[k] ?? {}) !== JSON.stringify(n?.[k] ?? {}));
    } catch { return true; }
  }
  const changed = patch.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (/(^|\/)go\.mod$/.test(path)) return changed.some((l) => { const b = l.slice(1).trim(); return b !== "" && !b.startsWith("//") && !/^(module|go|toolchain)\b/.test(b); });
  return changed.some((l) => {
    const b = l.slice(1).trim();
    if (/^"[A-Za-z][\w.-]*(\[[\w,.-]+\])?\s*([<>=~!]|;|@|"\s*,?\s*$)/.test(b)) return true; // PEP 508 list entry
    const m = /^([A-Za-z][\w.-]*)\s*=\s*("[\^~<>=!*\d]|\{[^}]*version)/.exec(b); // poetry-style name = "^1.0"
    return !!m && !PYPROJECT_NONDEP.test(m[1]!);
  });
}

/** Pure: manifests with changed dependencies and no matching lockfile in the same or an ancestor directory of the diff. */
export function manifestsWithoutLock(files: DiffFile[]): string[] {
  return files.filter((f) => f.deps && f.status !== "deleted").flatMap((f) => {
    const pair = MANIFEST_LOCKS.find(([m]) => m.test(f.path)); if (!pair) return [];
    const d = dirOf(f.path);
    const locked = files.some((g) => pair[1].test(g.path) && (dirOf(g.path) === "" || d === dirOf(g.path) || d.startsWith(dirOf(g.path) + "/")));
    return locked ? [] : [f.path];
  });
}

export function classifyRisk(files: DiffFile[], env: NodeJS.ProcessEnv = process.env): RiskAssessment {
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const sensitive = files.flatMap((f) => { const hit = SENSITIVE.find(([, re]) => re.test(f.path)); return hit && !isTestFile(f.path) ? [`${f.path} (${hit[0]})`] : []; });
  const testFiles = files.filter((f) => isTestFile(f.path));
  const testsDeleted = testFiles.filter((f) => f.status === "deleted").map((f) => f.path);
  const testsModified = [...testFiles.filter((f) => f.status !== "added" && f.status !== "deleted").map((f) => f.path), ...files.filter((f) => TEST_CFG.test(f.path)).map((f) => f.path)];
  const api = files.filter((f) => API.test(f.path) && !isTestFile(f.path)).map((f) => f.path);
  const high: string[] = [], med: string[] = [];
  if (sensitive.length) high.push(`sensitive paths: ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? ` (+${sensitive.length - 5})` : ""}`);
  if (testsDeleted.length) high.push(`test files deleted: ${testsDeleted.join(", ")}`);
  if (api.length) high.push(`public API surface: ${api.slice(0, 3).join(", ")}`);
  if (files.length >= FILES_HIGH) high.push(`${files.length} files >= ${FILES_HIGH}`);
  if (lines >= LINES_HIGH) high.push(`${lines} changed lines >= ${LINES_HIGH}`);
  if (testsModified.length) med.push(`existing tests or test config modified: ${testsModified.slice(0, 3).join(", ")}`);
  if (files.length >= FILES_MEDIUM) med.push(`${files.length} files >= ${FILES_MEDIUM}`);
  if (lines >= LINES_MEDIUM) med.push(`${lines} changed lines >= ${LINES_MEDIUM}`);
  const computed: RiskTier = high.length ? "high" : med.length ? "medium" : "low";
  const reasons = high.length ? [...high, ...med] : med.length ? med : [`${files.length} file${files.length === 1 ? "" : "s"}, no sensitive paths`];

  // A prompt or flag may RAISE the tier freely. Lowering needs an explicit recorded reason; high is never lowered silently.
  let tier = computed, override: RiskOverride | undefined, ignored: string | undefined;
  const asked = (env["LOKI_RISK_TIER"] ?? "").trim().toLowerCase() as RiskTier;
  if (asked in RANK && asked !== computed) {
    const reason = (env["LOKI_RISK_OVERRIDE_REASON"] ?? "").trim();
    if (RANK[asked] > RANK[computed]) { tier = asked; override = { from: computed, to: asked, reason: reason || "raised by LOKI_RISK_TIER" }; }
    else if (reason) { tier = asked; override = { from: computed, to: asked, reason }; }
    else ignored = `LOKI_RISK_TIER=${asked} ignored: lowering from ${computed} needs LOKI_RISK_OVERRIDE_REASON`;
  }
  const plan = PLAN[tier], checks_deferred = deferredOf(tier, plan.selected, []);
  const advisories = manifestsWithoutLock(files).map((p) => `manifest changed without lockfile: ${p}`);
  const summary = summaryOf({ tier, computed, reasons, ...(override ? { override } : {}), checks_deferred }) + (advisories.length ? `; advisory: ${advisories.join(", ")}` : "");
  return {
    version: 1, tier, computed, reasons,
    stats: { files: files.length, lines, sensitive, tests_modified: testsModified, tests_deleted: testsDeleted, api },
    checks_selected: plan.selected, checks_deferred,
    ...(override ? { override } : {}), ...(ignored ? { override_ignored: ignored } : {}), ...(advisories.length ? { advisories } : {}), summary,
  };
}

/** Tracked changes against baseSha, plus untracked new files (commit runs after verify). `.loki/`
 *  is filtered defensively even though intake also excludes it via .git/info/exclude. Throws if
 *  either git command fails: a broken baseSha must never read as "nothing changed" (~ALREADY_SATISFIED). */
export function changedFiles(repoDir: string, baseSha: string, skip?: (f: string) => boolean): string[] {
  const run = (args: string[]): string[] =>
    safeGit(repoDir, args)
      .split("\n").map((l) => l.trim()).filter(Boolean);
  const tracked = run(["diff", "--name-only", baseSha]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith(".loki/") && !skip?.(f)); // skip: install-owned paths (FC-DEPS-NOT-INSTALLED)
}

/** changedFiles enriched with numstat counts and name-status; untracked files get a line count as additions. Throws on git failure. */
export function diffFiles(repoDir: string, baseSha: string, skip?: (f: string) => boolean): DiffFile[] {
  const paths = changedFiles(repoDir, baseSha, skip), stat = new Map<string, DiffFile>();
  for (const l of safeGit(repoDir, ["diff", "--numstat", baseSha]).split("\n")) {
    const [a, d, ...p] = l.split("\t"), path = p.join("\t");
    if (path) stat.set(path, { path, added: Number(a) || 0, deleted: Number(d) || 0 });
  }
  for (const l of safeGit(repoDir, ["diff", "--name-status", baseSha]).split("\n")) {
    const [s, ...p] = l.split("\t"), f = stat.get(p[p.length - 1] ?? "");
    if (f) f.status = s?.startsWith("A") ? "added" : s?.startsWith("D") ? "deleted" : "modified";
  }
  const out = paths.map((path) => {
    const f = stat.get(path);
    if (f) return f;
    let n = 0; try { n = readFileSync(join(repoDir, path), "utf8").split("\n").length; } catch { /* unreadable or binary */ }
    return { path, added: n, deleted: 0, status: "added" as const };
  });
  for (const f of out) { // TEN-GATES-18: tag manifests whose dependency set changed (advisory input; a read failure leaves it untagged)
    if (f.status === "deleted" || !MANIFEST_LOCKS.some(([m]) => m.test(f.path))) continue;
    try {
      const oldText = f.status === "added" ? "" : safeGit(repoDir, ["show", `${baseSha}:${f.path}`]);
      const newText = readFileSync(join(repoDir, f.path), "utf8");
      const patch = f.status === "added" ? newText.split("\n").map((l) => `+${l}`).join("\n") : safeGit(repoDir, ["diff", "-U0", baseSha, "--", f.path]);
      if (manifestDepsChanged(f.path, oldText, newText, patch)) f.deps = true;
    } catch { /* best effort */ }
  }
  return out;
}

/** Writes .loki/state/risk-tier.json atomically; best effort, a recording failure never fails the run. */
export function recordRisk(repoDir: string, a: RiskAssessment): string | null {
  try {
    const dir = join(repoDir, ".loki", "state"), p = join(dir, "risk-tier.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(a, null, 2) + "\n"); renameSync(`${p}.tmp`, p);
    return p;
  } catch { return null; }
}

/** TEN-QUALITY-01: the decisive block of a failed check's output for the fix brief. Pure: ANSI stripped, absolute repo paths made
 *  repo-relative, secrets redacted, capped at `cap` bytes. pytest "E " lines + last frame, jest/vitest Expected/Received, node/bun
 *  AssertionError, go "--- FAIL" + next lines, tsc/ruff diagnostics. Unknown shapes fall back to the last few lines. */
export const EXCERPT_GROUP_CAP = 1500;
export const EXCERPT_TOTAL_CAP = 6144;
/** Cut to at most cap UTF-8 bytes without leaving a partial code point (a trailing U+FFFD from the cut is stripped). */
export function truncateBytes(s: string, cap: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.length <= cap ? s : buf.subarray(0, Math.max(0, cap)).toString("utf8").replace(/\uFFFD$/, "");
}
export function failureExcerpt(out: string, repoDir = "", cap = EXCERPT_GROUP_CAP): string {
  let t = stripAnsi(out.slice(-65536)).replace(/\r/g, "");
  if (repoDir) t = t.split(repoDir.replace(/\/+$/, "") + "/").join("");
  const lines = t.split("\n").map((l) => l.replace(/\s+$/, ""));
  const pick = new Set<number>();
  const take = (i: number, n = 1): void => { for (let k = 0; k < n && i + k < lines.length; k++) if (lines[i + k]!.trim()) pick.add(i + k); };
  lines.forEach((l, i) => {
    if (/^E\s/.test(l)) take(i);
    else if (/^\s*(Expected|Received)\b/.test(l) || /^\s*expect\(.*\)\.\w+/.test(l)) take(i);
    else if (/^[\w./@-]+\.py:\d+: /.test(l)) take(i);
    else if (/AssertionError|^\s*(expected|actual)\b.*[:=]|^\s*(not ok|FAILED)\b/.test(l)) take(i, 3);
    else if (/^\s*--- FAIL/.test(l)) take(i, 4);
    else if (/^[\w./@-]+\.\w+(\(\d+,\d+\)|:\d+(:\d+)?)[:\s].*\b(error|TS\d+|[A-Z]{1,3}\d{3,4})\b/.test(l)) take(i);
  });
  const lastFrame = lines.map((l, i) => (/^[\w./@-]+\.py:\d+: /.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (lastFrame !== undefined && [...pick].some((i) => /^E\s/.test(lines[i]!))) take(lastFrame);
  let body = [...pick].sort((a, b) => a - b).map((i) => lines[i]!).join("\n");
  if (!body) body = lines.filter((l) => l.trim()).slice(-6).join("\n");
  body = redactSecrets(body);
  return truncateBytes(body, cap);
}

// Wall base-run exit classification, moved from engine10/stages/wall.ts (core line budget); this module owns result classification.
// B1/B2/B3/B4 (r3, opus review of E-125): only the short-summary line names the FINAL exception -- immune to a captured stdout/stderr block forging an earlier frame (B3), or an earlier link in a chain (B4).
export function pytestCollectionIsRed(output: string, repoDir: string): boolean {
  if (/ModuleNotFoundError/.test(output)) return false;
  const real = (p: string): string | null => { try { return realpathSync(isAbsolute(p) ? p : join(repoDir, p)); } catch { return null; } };
  const repoReal = real(repoDir); const under = (p: string): boolean => { const r = real(p); return !!repoReal && !!r && (r === repoReal || r.startsWith(`${repoReal}/`)); };
  // pytest reports an ImportError from `from x import y` via its own (short-summary-less) path; the message always carries the module's own (absolute) file, so a direct scan is unambiguous.
  const imp = /ImportError: cannot import name .* from ['"][\w.]+['"] \(([^)]+)\)/.exec(output); if (imp) return under(imp[1]!);
  // B3 (r4): captured stdout prints ABOVE the short summary, so trust only the LAST ERROR line after the final summary header, and E lines only from the first collecting block, cut at its first Captured separator. No header: fail closed.
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop(); if (!hdr) return false;
  const cls = [...output.slice(hdr.index).matchAll(/^ERROR \S+ - (\w+Error): /gm)].pop()?.[1]; if (cls !== "AttributeError" && cls !== "NameError") return false;
  const start = output.search(/^_+ ERROR collecting /m); if (start < 0 || start > hdr.index) return false; const block = output.slice(start, hdr.index).split(/^-+ Captured .*$/m)[0]!;
  const eLines = [...block.matchAll(new RegExp(`^E {3}${cls}: (.*)$`, "gm"))]; const eLine = eLines[eLines.length - 1]; if (!eLine) return false;
  // B1 (r3): an AttributeError's frame is only where the dotted access sits, not who owns the missing attribute -- go by the message instead.
  if (cls === "AttributeError") { const m = /^module ['"]([\w.]+)['"] has no attribute/.exec(eLine[1]!); return !!m && moduleUnderRepo(repoDir, m[1]!); }
  // NameError: the raise site must be repo code, not merely an import line naming an outside module. B2 (r3): a frame path may contain a space.
  const frames = [...block.slice(0, eLine.index).matchAll(/^(.+?):\d+: in \S+\n\s*(.*)$/gm)]; const last = frames[frames.length - 1];
  return !!last && under(last[1]!) && !/^\s*(import\s|from\s\S+\s+import\b)/.test(last[2] ?? "");
}
function moduleUnderRepo(repoDir: string, name: string): boolean { const rel = name.replace(/\./g, "/"); return existsSync(join(repoDir, `${rel}.py`)) || existsSync(join(repoDir, rel, "__init__.py")); }
// E-125 r5: exit-1 output is red only from the real final summary, never captured text. The runner appends -rfE, so a repo's `-q` addopts (stacked to -qq, no footer) still lists FAILED lines.
function pytestExit1IsRed(output: string): boolean {
  if (/^!+ _pytest\.outcomes\.Exit\b/m.test(output)) return false; // pytest.exit(...) can print any text, incl. "1 failed"
  if (/^=*\s*(\d+ \w+(, )?)*\d+ failed\b.* in [\d.]+s/.test(output.trimEnd().split("\n").pop() ?? "")) return true;
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop();
  return !!hdr && /^FAILED \S+/m.test(output.slice(hdr.index));
}
// B2 (r2): jest/vitest/bun red requires a parsed failed-test count above 0; unparseable output stays 0 (not_run).
function parsedFailCount(runner: RunnerName, output: string): number {
  const m = runner === "bun" ? /^\s*(\d+)\s+fail\s*$/m.exec(output)
    : runner === "jest" ? /Tests:\s*(\d+)\s+failed/i.exec(output)
    : runner === "vitest" ? /Tests\s+(\d+)\s+failed/i.exec(output) : null;
  return m ? Number(m[1]) : 0;
}
// A-103 node:test red, mirroring pytest: a missing module inside the repo or an error thrown by code under test is red; a missing bare package, or an error thrown from the Wall file itself (Jest globals), is not. A missing-module crash is not_run only when the file itself failed (no named subtest failed, spec or TAP), and any failing subtest whose error is not a Wall-file Reference/SyntaxError makes the file red, so a child process crash or printed footer cannot hide a real red. Only node's own lines count (col-0 crash text, or a failing-tests block's error line and first frame), never an assertion diff.
function nodeIsRed(f: TestRef, raw: string): boolean {
  // node 20/22 off a TTY print TAP: crash text is "# "-prefixed and a failure is a yaml block (name: 'X', stack: |-). Strip the prefix from non-counter lines so the spec-shape regexes apply.
  const o = raw.replace(/^# (?!(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Subtest)\b)/gm, "");
  const mod = /^Error(?: \[\w+\])?: Cannot find (?:module|package) '([^']+)'(?:(?!\u2716)[\s\S])*?\nNode\.js v/m.exec(o), top = /^(\S+):\d+\n.*\n.*\n\n?(?:ReferenceError|SyntaxError)\b/m.exec(o);
  const named = [...o.matchAll(/^(?:\u2716|\s*not ok \d+ -) (?!failing tests:)(.+?)(?: \(|$)/gm)].some((m) => !f.path.endsWith(m[1]!) && !m[1]!.endsWith(f.path)), blk = o.split("failing tests:")[1] ?? "", esm = /^SyntaxError: The requested module '([^']+)' does not provide an export named/m.exec(o), errs = [...blk.matchAll(/^ {2}(\w+Error): .*\n\s+at (?:.*\()?([^\s()]+?):\d+:\d+/gm), ...o.matchAll(/^ +name: '(\w+Error)'\n(?:.*\n)*? +stack: \|-\n\s+(?:.*\()?([^\s()]+?):\d+:\d+/gm)];
  return /^(?:#|\u2139) fail [1-9]/m.test(raw) && (/^ {2}AssertionError\b/m.test(blk) || /^ +name: 'AssertionError'/m.test(o) || (mod && !named ? /^[./]/.test(mod[1]!) : esm ? /^[./]/.test(esm[1]!) : top ? !top[1]!.endsWith(f.path) : !errs.length || errs.some((e) => !/^(?:Reference|Syntax)Error$/.test(e[1]!) || !(e[2]!.startsWith("node:") || e[2]!.endsWith(f.path))))); // ESM "cannot import name": red for a repo path, not_run for a bare package
}
// D42 (3) exit classification. B4 (r2): any "system"-interpreter result is not_run, same as verify (E-98a).
// Red: pytest exit 1/resolved 2; jest/vitest/bun a parsed failed count>0. npm/go/cargo (B2, coarse): never fail.
/** FC-69: why a base run was not_run, for the receipt and console ("Wall test not executed: <file>: <reason>"). */
export function notRunReason(status: number | null, interpreter?: "project" | "system"): string {
  if (interpreter === "system") return "ran under the system interpreter, not the project's, so the result proves nothing";
  if (status === null) return "the test runner did not start or timed out";
  if (status === 126 || status === 127) return `the test runner command was not found or not executable (exit ${status})`;
  return status === 0 ? "exit 0 but no executed test count could be confirmed" : `exit ${status} but the runner output showed no readable failing test`;
}
export function classify(f: TestRef, status: number | null, output: string, repoDir: string, interpreter?: "project" | "system"): "pass" | "fail" | "not_run" {
  if (interpreter === "system") return "not_run";
  output = stripAnsi(output); // FC-69: every parser below reads plain text, whoever captured it
  if (status === null || status === 126 || status === 127) return "not_run"; if (status === 0) return classifyCheck({ kind: "test", ok: true, out: output, path: f.path, ...(f.runner === "go" ? { runner: "go" as const } : {}) }).result === "pass" ? "pass" : "not_run"; // FC-16: exit 0 with zero or unknown executed tests is not a pass
  if (f.runner === "pytest") return status === 1 ? (pytestExit1IsRed(output) ? "fail" : "not_run") : status === 2 ? (pytestCollectionIsRed(output, repoDir) ? "fail" : "not_run") : "not_run";
  if (f.runner === "jest" || f.runner === "vitest" || f.runner === "bun") return parsedFailCount(f.runner, output) > 0 ? "fail" : "not_run";
  return f.runner === "node" && nodeIsRed(f, output) ? "fail" : "not_run"; // npm/go/cargo: coarse (B2), never a per-file red
}

/** TEN-SPEED-19: LOKI_E10_BASE_JOBS, default 1 (sequential); an invalid value or one below 1 falls back to 1, capped at 16. */
export function baseJobs(): number { const n = Number(process.env.LOKI_E10_BASE_JOBS); return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : 1; }
/** TEN-SPEED-18: LOKI_E10_VERIFY_JOBS, an integer 1..8; unset, invalid or below 1 means 1. */
export const verifyJobs = (): number => { const n = Number.parseInt(process.env["LOKI_E10_VERIFY_JOBS"] ?? "", 10); return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1; };
/** TEN-SPEED-19: map items through an async fn with at most `jobs` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], jobs: number, fn: (item: T) => Promise<R>, stop: () => boolean = () => false): Promise<R[]> { // stop() true: no new item starts; their slots stay empty
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, jobs), items.length) }, async () => { while (next < items.length && !stop()) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}
/** TEN-SPEED-19: async twin of the sync spawn used by RealBaseTestRunner: status is null on spawn error, signal or timeout; output is stdout and stderr merged by arrival. */
export function spawnCollect(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    let out = "", err = "", error = false, done = false; const MAX = 1024 * 1024; // spawnSync parity: stdin EOF, default maxBuffer, "stdout\nstderr" join
    const fin = (status: number | null) => { if (!done) { done = true; resolve({ status: error ? null : status, output: `${out}\n${err}` }); } };
    const c = spawn(cmd, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    const over = () => { if (out.length > MAX || err.length > MAX) { error = true; c.kill("SIGTERM"); } };
    c.stdout?.on("data", (d) => { out += d; over(); }); c.stderr?.on("data", (d) => { err += d; over(); });
    c.on("error", () => { error = true; fin(null); }); c.on("close", (code, sig) => fin(sig ? null : code));
  });
}
// E-98a B2: .venv, then venv, then an in-repo (realpath under repoDir) VIRTUAL_ENV are "project";
// else <fallback> on PATH, or <lastResort> literal, is "system" -- never proven against repo sources.
type Interpreter = "project" | "system";
export function resolveTool(repoDir: string, bin: string, fallback: string, lastResort = fallback): [string, Interpreter, string[]] {
  const inRepo = (p: string): boolean => { try { const r = relative(realpathSync(repoDir), realpathSync(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); } catch { return false; } };
  const venvEnv = process.env["VIRTUAL_ENV"], onPath = (b: string): string | null => Bun.which(b, { PATH: process.env["PATH"] ?? "" }); // Bun.which caches the startup PATH unless given the live one
  const project = [join(repoDir, ".venv", "bin", bin), join(repoDir, "venv", "bin", bin), ...(venvEnv && inRepo(venvEnv) ? [join(venvEnv, "bin", bin)] : [])].find(existsSync);
  return project ? [project, "project", []] : existsSync(join(repoDir, "uv.lock")) && onPath("uv") ? ["uv", "project", ["run", "--", bin]] : [onPath(fallback) ? fallback : lastResort, "system", []]; // TEN-QUALITY-11: uv.lock, no venv: uv run is the project interpreter
}
// Command shapes exactly as ENGINE.md section 8's table names them per runner (npm/cargo are
// "coarse": no per-file selection; go runs per package dir, also coarse below that grain).
export function runnerCmd(t: TestRef, repoDir: string): [string, string[], Interpreter?] {
  switch (t.runner) {
    case "pytest": {
      const [cmd, interpreter, pre] = resolveTool(repoDir, "python", "python3", "python");
      return [cmd, [...pre, "-m", "pytest", "-q", t.path], interpreter];
    }
    case "vitest": return ["npx", ["--no-install", "vitest", "run", t.path]];
    case "jest": return ["npx", ["--no-install", "jest", t.path]];
    case "bun": return ["bun", ["test", t.path]];
    case "node": return ["node", ["--test", `./${t.path}`]];
    case "npm": return ["npm", ["test", "--silent"]];
    case "go": return ["go", ["test", "-json", `./${dirname(t.path)}`]];
    case "cargo": return ["cargo", ["test"]];
  }
}
/** The legacy per-runner full suite (no multi-root model), one check per detected runner: run by deep.ts, baselined via package_suite.ts fullSuiteSpecs. */
export const FULL_SUITE_CMD: Record<RunnerName, { cmd: string; args: string[] }> = {
  pytest: { cmd: "python", args: ["-m", "pytest", "-q"] },
  vitest: { cmd: "npx", args: ["vitest", "run"] },
  jest: { cmd: "npx", args: ["jest"] },
  bun: { cmd: "bun", args: ["test"] },
  node: { cmd: "node", args: ["--test"] },
  npm: { cmd: "npm", args: ["test", "--silent"] },
  go: { cmd: "go", args: ["test", "-json", "./..."] },
  cargo: { cmd: "cargo", args: ["test"] },
};
/** FC-01: the one resolver for a test invocation: a package-owned file runs in its package dir with a package-relative path, else exactly runnerCmd at the root. */
export function commandFor(t: TestRef, repoDir: string, api?: ProjectApi | null): { cwd: string; cmd: string; args: string[]; argv: string[]; interpreter?: Interpreter; pkgRoot: string } {
  const site = siteFor(api, repoDir, t.path);
  const [cmd, args, interpreter] = runnerCmd(site ? { runner: t.runner, path: site.file } : t, repoDir);
  return { cwd: site?.cwd ?? repoDir, cmd, args, argv: [cmd, ...args], ...(interpreter ? { interpreter } : {}), pkgRoot: site?.root ?? "." };
}
export function firstError(out: string): string { // the line naming the failing test, minus what varies between identical failures (A-113 stall signature)
  const goOut = (l: string): string => { try { const e = JSON.parse(l) as { Action?: string; Output?: string }; return typeof e.Action === "string" ? (e.Action === "output" || e.Action === "build-output" ? (e.Output ?? "") : "") : l; } catch { return l; } }; // Go json event stream: the failing line is inside the event's Output
  const lines = out.slice(-65536).split("\n").map((l) => (l.startsWith("{") ? goOut(l) : l).trim()).filter(Boolean), l =lines.find((x) => /^(FAILED\s|\u25cf\s.*\u203a|not ok\s|_{3,}\s.+\s_{3,}$)/.test(x)) ?? lines.find((x) => /^[\w./-]+\.go:\d+:\d+: \S/.test(x)) /* go compiler line, before "FAIL pkg [build failed]" */ ?? lines.find((x) => /fail|error/i.test(x) && !/^(=|\u2713|ok\b|PASS)/.test(x)) ?? "";
  return l.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "").replace(/(^|\s)\/(?:[\w.@-]+\/)*[\w.@-]+/g, "$1<path>").replace(/:\d+(?::\d+)?/g, "").replace(/\[?\d+(?:\.\d+)?m?s\]?/g, "").replace(/\s+/g, " ").slice(0, 160);
}
