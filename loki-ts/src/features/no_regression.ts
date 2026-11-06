// The no-regression differential (LOKI_E10_NRD, default on, =0 opts out). A fix can pass every check it was given and still change output
// nobody asked to change (lh-1474: a shared git-log helper lost --no-merges for the authors list too). After the implement session, keep cases
// (inputs the issue does NOT ask to change) run on a scratch copy of the base and a scratch copy of the patched tree; a keep case whose output
// changes, stably, and that a code-blind judge (plus a deterministic override) calls unrequested becomes ONE FailureGroup, which verify hands
// to one fix round through buildFixBrief. "unknown" is a receipt note; nothing here ever weakens a verdict, and the user's tree is only read.
// New file because no module compares base and patched behavior on inputs the issue never mentions: the tournament compares candidate trees
// with each other (features/tournament.ts, whose probe format, Go runner and scratch cleanup this file reuses) and verify runs pass/fail checks.
//
// Calls (tool-less, single turn): the keep cases ride inside exec-spec's one pre-implement call (nrdProbeIntake), so the default path adds no
// call before implement. A post-implement probe call fires only when an edited function has same-package callers the issue does not name.
// The judge call fires only when a keep case or a base-test replay result changed. A fix that changes only what the issue asks costs no call.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FailureGroup } from "../engine10/failures.ts";
import { isTestFile } from "../engine10/testmap.ts";
import type { RunContext, SessionResult } from "../engine10/types.ts";
import { applyDiff, snapshotDiff } from "../e10ext/treeswap.ts";
import { plainTestEnv, spawnGroupSync, stripAnsi } from "../util/check_result.ts";
import { symbolSpans } from "../util/context_pack.ts";
import { safeGit, safeGitArgs, safeGitEnv } from "../util/safe_git.ts";
import { ATTEMPT_EXCLUDES } from "./attempts.ts";
import type { ResolvedSite } from "./exec_spec.ts";
import { GO_PROBE_FORMAT, baseText, parseGoProbeCases, parseProbeOutput, probeIntake, readTournamentInput, runGoProbe, splitProbeBlock, toolLessLlm, type LlmCall, type ProbeRunResult } from "./tournament.ts";
import { escapeRegex } from "../util/regex_escape.ts";

export const nrdEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_NRD !== "0";
const MAX_EDITED = 8, MAX_PKG_BYTES = 120_000, SCRATCH_PREFIX = "loki-nrd-";
// ---------------- the mechanical keep list: output sites in the edited functions and their callers ----------------
export interface OutputSite { id: string; fn: string; text: string; kind: "literal" | "format" }
const FORMAT_CALL = /\b(?:fmt\.(?:Sprintf|Fprintf|Printf|Errorf|Sprint|Sprintln|Fprint|Fprintln)|strings\.(?:ToLower|ToUpper|Title|ToTitle|TrimSpace|Trim\w*|Replace\w*|Join|Repeat|Fields|Split\w*)|strconv\.(?:Format\w+|Quote\w*|Itoa|Append\w+)|errors\.New)\s*\(/g;
/** String literals with a letter pair (outside comment lines) inside one definition's text. */
export function goStringLiterals(body: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const m of body.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (body.slice(Math.max(0, m.index! - 1), m.index!) === "`" || !/[A-Za-z]{2}/.test(m[1]!) || /^%\w$/.test(m[1]!)) continue;
    const line = body.slice(body.lastIndexOf("\n", m.index!) + 1, body.indexOf("\n", m.index!));
    if (/^\s*\/\//.test(line)) continue;
    out.push({ at: m.index!, text: m[1]! });
  }
  return out;
}
/** Every string literal and formatting call in the BASE text of `names` (edited definitions first, then callers). A format call is listed as its source line, a
 *  literal already inside a listed format line is not listed again. Capped at `cap`, taken round-robin so no one function takes the whole budget. */
export function outputSites(files: Record<string, string>, names: string[], cap = 14): OutputSite[] {
  const per: OutputSite[][] = [];
  for (const n of names) {
    const sites: OutputSite[] = [];
    for (const [p, src] of Object.entries(files)) {
      const lines = src.split("\n");
      for (const s of symbolSpans(p, src)) {
        if (s.container || s.name !== n) continue;
        const body = lines.slice(s.start - 1, s.end).join("\n"), fmtLines = new Set<string>();
        for (const m of body.matchAll(FORMAT_CALL)) {
          const line = body.slice(body.lastIndexOf("\n", m.index!) + 1, body.indexOf("\n", m.index!) < 0 ? undefined : body.indexOf("\n", m.index!)).trim();
          if (line.startsWith("//") || fmtLines.has(line)) continue;
          fmtLines.add(line); sites.push({ id: "", fn: n, text: line.slice(0, 160), kind: "format" });
        }
        for (const l of goStringLiterals(body)) if (![...fmtLines].some((f) => f.includes(`"${l.text}"`)) && !sites.some((x) => x.text === `"${l.text}"`)) sites.push({ id: "", fn: n, text: `"${l.text.slice(0, 120)}"`, kind: "literal" });
      }
    }
    per.push(sites);
  }
  const out: OutputSite[] = [];
  for (let i = 0; out.length < cap && per.some((x) => x.length > i); i++) for (const x of per) if (x[i] && out.length < cap) out.push(x[i]!);
  return out.map((x, i) => ({ ...x, id: `s${i + 1}` }));
}
/** Same-package definitions that call one of `names` (a Go method is matched by its method name). */
export function callersOf(names: string[], files: Record<string, string>): string[] {
  const esc = escapeRegex;
  const calls = names.map((n) => (n.includes(".") ? new RegExp(`\\.${esc(n.split(".").pop()!)}\\s*\\(`) : new RegExp(`(?:^|[^\\w.])${esc(n)}\\s*\\(`, "m")));
  const out = new Set<string>();
  for (const [path, src] of Object.entries(files)) {
    const lines = src.split("\n");
    for (const s of symbolSpans(path, src)) {
      if (s.container || names.includes(s.name)) continue;
      const whole = lines.slice(s.start - 1, s.end).join("\n"), at = whole.indexOf("{"), body = at < 0 ? whole : whole.slice(at + 1); // after the signature, so a function never calls itself by its own name
      if (calls.some((re) => re.test(body))) out.add(s.name);
    }
  }
  return [...out].sort();
}
/** Names of the definitions whose text differs between base and patched (added and removed ones included). */
export function editedSymbols(path: string, baseSrc: string, patchedSrc: string): string[] {
  const body = (src: string): Map<string, string> => {
    const lines = src.split("\n"), m = new Map<string, string>();
    for (const s of symbolSpans(path, src)) if (!s.container) m.set(s.name, lines.slice(s.start - 1, s.end).join("\n"));
    return m;
  };
  const a = body(baseSrc), b = body(patchedSrc);
  return [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();
}
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w])${name.split(".").pop()!.replace(/[$]/g, "\\$")}(?![\\w])`).test(text);

// ---------------- the keep list: one required probe case per output site ----------------
const STD_PKG = new Set(["strings", "fmt", "strconv", "math", "reflect", "errors", "sort", "time", "os", "bytes", "filepath", "json", "regexp", "unicode", "utf8", "io", "bufio", "path", "slices", "maps"]);
const NOT_CALLS = new Set(["lokiProbe", "func", "any", "return", "len", "append", "make", "string", "int", "int64", "float64", "bool", "byte", "error", "interface", "new", "cap", "copy", "delete"]);
/** Functions and methods a probe case calls (standard library qualifiers and builtins left out). */
export function calledNames(snippet: string): string[] {
  const out = new Set<string>();
  for (const m of snippet.matchAll(/(?:\b(\w+)\.)?\b([A-Za-z_]\w*)\s*\(/g)) if (!NOT_CALLS.has(m[2]!) && !(m[1] && STD_PKG.has(m[1]))) out.add(m[2]!);
  return [...out];
}
const unq = (s: string): string => s.trim().replace(/^"(.*)"$/s, "$1");
const KEEP_WORDS = /\b(?:stays?|unchanged|keeps?|kept|still|as it is|as is|remains?|untouched|must not change|should not change|not change|leave|leaves)\b/i;
const sentencesOf = (issue: string): string[] => issue.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim().length > 0);
/** A function the issue asks to change: named in it, and in no "stays / unchanged / keep" sentence (a function named only as one that stays is keep-only). */
export function askedToChange(issue: string, fn: string): boolean {
  return mentions(issue, fn) && !sentencesOf(issue).some((x) => KEEP_WORDS.test(x) && mentions(x, fn));
}
/** True when the case calls at least one function and every function it calls is one the issue asks to change. */
export const callsOnlyAskedFunctions = (issue: string, snippet: string): boolean => { const fns = calledNames(snippet); return fns.length > 0 && fns.every((n) => askedToChange(issue, n)); };
/** Decided in code, never by the model's naming: a case is a "change" case only when EVERY function it calls is one the issue asks to change AND the issue states its new
 *  output, or states its input while NOT stating the old output as staying ("flags without a short alias keep printing ..."). A case touching any other function is a keep case. */
export function isChangeCase(issue: string, snippet: string, before: string, after: string): boolean {
  if (!callsOnlyAskedFunctions(issue, snippet)) return false;
  const stated = (v: string): boolean => { const t = unq(v); return t.length >= 2 && issue.includes(t); };
  if (stated(after)) return true;
  const lits = [...snippet.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).filter((l) => l.length >= 2 && !/^k?p?\d+$/.test(l));
  // an input the issue states, the old output not stated as staying: still judged when the new output adds a word found in neither the old output nor the issue (an extra change in the asked function)
  const known = new Set([...toks(before), ...toks(issue)]);
  return lits.some((l) => issue.includes(l)) && !stated(before) && toks(after).every((t) => known.has(t));
}
/** Per-run text appended after the fixed probe rules in the exec-spec call (never in the cache-stable prefix). Empty when there is no site. */
export function ledgerText(sites: OutputSite[]): string {
  if (!sites.length) return "";
  return [`Also cover what must NOT change. Each line below is a string or formatting call the named code or its callers produce output through. For EACH line add one lokiProbe case whose returned value passes through it, its desc starting with the line's tag (for example "[s1] ..."). Prefer the report's own example values as inputs. These count toward the 6 to 12 cases (up to 16 with them).`, ...sites.map((x) => `[${x.id}] in ${x.fn}: ${x.text}`)].join("\n");
}
const goSources = (repoDir: string, dirRel: string): Record<string, string> => {
  const out: Record<string, string> = {}; let total = 0;
  try {
    for (const f of safeGit(repoDir, ["ls-files", "-z", "--", dirRel === "" ? "." : dirRel]).split("\0")) {
      if (!f.endsWith(".go") || isTestFile(f) || dirname(f).replace(/^\.$/, "") !== dirRel) continue;
      const s = readFileSync(join(repoDir, f), "utf8"); if (total + s.length > MAX_PKG_BYTES) break;
      out[f] = s; total += s.length;
    }
  } catch { /* an unreadable package gets no ledger */ }
  return out;
};
/** Passed to execSpecAuthor in place of probeIntake: the same fixed rules (cache-stable) plus the keep list for the code the issue names and its same-package callers. */
export const nrdProbeIntake = {
  ...probeIntake,
  ledger(sites: ResolvedSite[], repoDir: string): string {
    const go = sites.filter((s) => s.file.endsWith(".go")); if (!go.length) return "";
    const dir = dirname(go[0]!.file).replace(/^\.$/, ""), files = goSources(repoDir, dir), names = go.filter((s) => dirname(s.file).replace(/^\.$/, "") === dir).map((s) => s.symbol.split(".").pop()!);
    return ledgerText(outputSites(files, [...names, ...callersOf(names, files)]));
  },
};

export const SYS_NRD_PROBE = "You write a small behavioral probe program. Output only one fenced code block.";
/** The post-implement probe call fires only when an edited function has a same-package caller the issue does not name: the exec-spec call wrote its
 *  cases before the diff existed and could only aim at what the issue names. A method name several types define cannot be traced to its callers by name. */
export function postProbeNeeded(issue: string, edited: string[], files: Record<string, string>): string[] {
  const defs = Object.entries(files).flatMap(([p, src]) => symbolSpans(p, src).filter((s) => !s.container).map((s) => s.name)), short = (n: string): string => n.split(".").pop()!;
  const traceable = edited.filter((n) => !n.includes(".") || defs.filter((d) => short(d) === short(n)).length < 2);
  return callersOf(traceable, files).filter((c) => !mentions(issue, c));
}
/** The post-implement probe call: the issue, the BASE code of the edited functions and their callers, never the patch. */
export function nrdProbePrompt(c: { issue: string; pkg: string; files: Record<string, string>; tests: Record<string, string>; edited: string[]; callers: string[]; unnamed: string[]; sites: OutputSite[] }): string {
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.files).map(([p, s]) => `FILE ${p} (before the fix):\n${s}`),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`),
    `A fix for this issue edited ${c.edited.join(", ")}. These same-package callers reach the edited code but the issue never names them: ${c.unnamed.join(", ")}. Write the cases for THEM: give each caller the report's own example values and boundary inputs, so a change that leaks into them shows. A correct fix leaves their output exactly as it was.`,
    `Reply with one \`\`\`go fenced block and nothing else: a probe file in package ${c.pkg}. ${GO_PROBE_FORMAT} Every case here is a keep case: name the ids k1, k2, ...`,
    ...(c.sites.length ? [ledgerText(c.sites)] : []),
  ].join("\n\n");
}
/** What the probe writer sees: each file defining one of `names` (a small file whole, a large one as its head plus those definitions) and, from the tests, the test functions that mention one. */
export function probeContext(pkgFiles: Record<string, string>, testFiles: Record<string, string>, names: string[], o = { wholeBytes: 12_000, testBytes: 8_000, testsPerFile: 3 }): { files: Record<string, string>; tests: Record<string, string> } {
  const files: Record<string, string> = {}, tests: Record<string, string> = {};
  for (const [p, src] of Object.entries(pkgFiles)) {
    const all = symbolSpans(p, src), spans = all.filter((s) => !s.container && names.includes(s.name)), lines = src.split("\n");
    if (spans.length === 0) continue;
    if (src.length <= o.wholeBytes) { files[p] = src; continue; }
    const head = lines.slice(0, Math.max(0, Math.min(...all.map((s) => s.start)) - 1)).join("\n").slice(0, 1500);
    files[p] = [head, ...spans.map((s) => lines.slice(s.start - 1, s.end).join("\n"))].join("\n\n// ...\n\n");
  }
  let budget = o.testBytes;
  for (const [p, src] of Object.entries(testFiles)) {
    const lines = src.split("\n"), hits = symbolSpans(p, src).filter((s) => !s.container && names.some((n) => mentions(lines.slice(s.start - 1, s.end).join("\n"), n))).slice(0, o.testsPerFile);
    const text = hits.map((s) => lines.slice(s.start - 1, s.end).join("\n")).join("\n\n");
    if (!text || text.length > budget) continue;
    tests[p] = text; budget -= text.length;
  }
  return { files, tests };
}

// ---------------- the code-blind judge and the deterministic corrections ----------------
export type Verdict = "requested" | "unrequested" | "unknown";
export interface Finding { id: string; desc: string; before: string; after: string; source: "replay" | "probe"; testEdit?: string; /** every function the case calls is one the issue asks to change: its change follows from the requested one */ named?: boolean }
const clip = (s: string, max = 400): string => (s.length > max ? `${s.slice(0, max)}...(${s.length - max} more chars)` : s);
export const SYS_NRD_JUDGE = "You decide whether an issue asks for an observed behavior change. You never see code. Answer only in the requested format.";
export function nrdJudgePrompt(issue: string, cases: (Finding & { label: string })[]): string {
  const row = (x: Finding & { label: string }): string => [`CASE ${x.label}: ${x.desc}`, `  before the change: ${clip(x.before)}`, `  after the change:  ${clip(x.after)}`, ...(x.testEdit ? [`  the change also rewrote this test's lines (- old, + new):\n${x.testEdit.split("\n").map((l) => `    ${l}`).join("\n")}`] : [])].join("\n");
  return [
    `ISSUE:\n${issue}`,
    "Each case below behaved one way before the change and another way after it. For each case, decide whether the issue asks for that change:\n- requested: the issue asks for it, or it follows directly and necessarily from what the issue asks.\n- unrequested: the issue neither asks for it nor implies it; a maintainer would expect it to stay as it was. A test the change rewrote to expect the new behavior is still unrequested when the issue does not ask for that behavior.\n- unknown: the issue does not decide it.",
    cases.map(row).join("\n\n"),
    "Answer one line per case: <case id>: requested|unrequested|unknown",
  ].join("\n\n");
}
export function parseNrdVerdicts(text: string): Map<string, Verdict> {
  const v = new Map<string, Verdict>();
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]*\s*\**\s*(?:case\s+)?([A-Za-z0-9_#.-]+)\s*\**\s*[:=-]\s*\**\s*(unrequested|requested|unknown)\b/i.exec(line);
    if (m && !v.has(m[1]!)) v.set(m[1]!, m[2]!.toLowerCase() as Verdict);
  }
  return v;
}
const TOK = /[^\s"'`,;()[\]{}<>|]+/g;
const toks = (s: string): string[] => [...s.replace(/\\[tnr]/g, " ").matchAll(TOK)].map((m) => m[0]!.replace(/[.:!?]+$/, "").toLowerCase()).filter((t) => t.length >= 3 || /\d|-/.test(t)); // probe outputs are rendered: an escaped tab or newline separates words too
const REMOVAL = /\b(?:stop(?:s|ped)?|drop(?:s|ped)?|remov(?:e|es|ed|ing)|strip(?:s|ped)?|without|no longer|omit(?:s|ted)?|delet(?:e|es|ed)|hide|skip)\b/i;
/** True when the issue mentions the change a case shows: the issue quotes the new output, a token the new output adds appears in the issue, the output only
 *  reordered the same words (only the judge can tell), or a token it drops appears within six words after a removal word in a sentence that asks for something
 *  ("Preferred fix: stop passing --no-merges"). The title (first line) never counts: it describes the bug. */
export function issueMentionsChange(issue: string, before: string, after: string): boolean {
  const b = new Set(toks(before)), a = new Set(toks(after)), it = new Set(toks(issue));
  const lit = after.trim().replace(/^"(.*)"$/s, "$1");
  if (lit.length >= 2 && issue.includes(lit)) return true;
  if ([...a].some((t) => !b.has(t) && it.has(t))) return true;
  const removed = [...b].filter((t) => !a.has(t));
  if (removed.length === 0 && [...a].every((t) => b.has(t))) return true;
  const asks = askSentences(issue);
  for (const s of asks) { const w = s.split(/\s+/); for (let i = 0; i < w.length; i++) if (REMOVAL.test(w[i]!) && w.slice(i + 1, i + 7).some((x) => removed.some((r) => toks(x).includes(r)))) return true; }
  return false;
}
/** Sentences of the issue body (the title never counts) that ask for something. */
const askSentences = (issue: string): string[] => issue.split("\n").slice(1).join("\n").split(/(?<=[.!?])\s+|\n+/).filter((x) => /\b(?:should|expected|expect|prefer(?:red)?|fix|please|must|want|instead)\b/i.test(x));
const issueQuoted = (issue: string): string[] => [...issue.matchAll(/`([^`\n]+)`|"([^"\n]{1,200})"/g)].map((m) => (m[1] ?? m[2])!);
/** A replayed test whose rewritten (+) lines assert a value that the issue states, quoted, inside a sentence that asks for it, was rewritten toward what the issue asks: requested. A string that merely occurs somewhere in the issue is not enough. */
export function rewriteAssertsIssueValue(issue: string, testEdit: string | undefined): boolean {
  if (!testEdit) return false;
  const q = new Set(issueQuoted(issue).map((x) => x.trim())), asks = askSentences(issue);
  return testEdit.split("\n").filter((l) => l.startsWith("+ ")).some((l) => [...l.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).some((v) => v.length >= 2 && q.has(v) && asks.some((x) => x.includes(v))));
}
const statedInRequest = (issue: string, v: string): boolean => { const t = unq(v); return t.length >= 3 && askSentences(issue).some((x) => x.includes(t)); };
/** The corrections only ever move a verdict toward "requested", or a doubtful "requested" to advisory "unknown"; they never turn a judge's "requested" into a block (a
 *  block sends a fix round that could revert a correct fix). Replay findings: "requested" when the rewritten test asserts a value quoted in a request sentence.
 *  Probe findings: a judge "requested" on a function the issue never names, with the change not mentioned in the issue, becomes "unknown" (advisory); "unrequested" or
 *  "unknown" becomes "requested" when every function the case calls is one the issue asks to change and the new output itself is stated in a request sentence. */
export function overrideVerdict(issue: string, f: Finding, v: Verdict): Verdict {
  if (f.source === "replay") return rewriteAssertsIssueValue(issue, f.testEdit) ? "requested" : v;
  if (v === "requested") return !f.named && !issueMentionsChange(issue, f.before, f.after) ? "unknown" : v;
  return f.named && statedInRequest(issue, f.after) ? "requested" : v; // only for a case whose every called function the issue asks to change
}

// ---------------- the differential ----------------
export type CaseStatus = "same" | "changed" | "flaky" | "missing_base" | "missing_patched";
export interface CaseDiff { id: string; desc: string; before: string; after: string; status: CaseStatus }
/** Run `program` on the base and the patched tree. A case that differs is run once more on both trees and counts as changed only when both reruns agree with the first runs. */
export function differential(run: (state: "base" | "patched") => ProbeRunResult, notes: string[]): { cases: CaseDiff[]; unbuilt: string | null } {
  const b0 = run("base"), p0 = run("patched");
  for (const [s, r] of [["base", b0], ["patched", p0]] as const) {
    if (!r.built) notes.push(`${s}: the probe did not build (${r.error?.split("\n").slice(-2).join(" ").slice(0, 160) ?? "no output"})`);
    for (const x of r.pruned) notes.push(`${s}: case ${x.id} dropped (${x.error})`);
  }
  const unbuilt = !b0.built || !p0.built ? `the probe program did not build in the scratch copy of the ${!b0.built ? "base" : "patched"} tree (${(!b0.built ? b0 : p0).error?.split("\n").slice(-2).join(" ").slice(0, 160) ?? "no output"})` : null;
  const pb = parseProbeOutput(b0.stdout), pp = parseProbeOutput(p0.stdout);
  const suspect = pb.probes.some((p) => pp.run[p.id] !== undefined && pp.run[p.id] !== pb.run[p.id]);
  const b1 = suspect ? parseProbeOutput(run("base").stdout).run : null, p1 = suspect ? parseProbeOutput(run("patched").stdout).run : null;
  return { unbuilt, cases: pb.probes.map((p) => {
    const row = { id: p.id, desc: p.desc, before: pb.run[p.id]!, after: pp.run[p.id] ?? "" };
    if (pp.run[p.id] === undefined) return { ...row, status: "missing_patched" as const };
    if (pp.run[p.id] === pb.run[p.id]) return { ...row, status: "same" as const };
    return { ...row, status: b1?.[p.id] === pb.run[p.id] && p1?.[p.id] === pp.run[p.id] ? "changed" as const : "flaky" as const };
  }) };
}

export type GoTestRun = Map<string, { ok: boolean; out: string }>;
/** Per-test results of one `go test -json` run of a package. Subtests are folded into their parent. */
export function goTestResults(dir: string, pkgRel: string, timeoutMs = 120_000): GoTestRun {
  const r = spawnGroupSync("go", ["test", "-count=1", "-vet=off", "-json", `./${pkgRel || "."}`], { cwd: dir, env: plainTestEnv(), timeoutMs });
  const res: GoTestRun = new Map(), outs = new Map<string, string[]>();
  for (const l of r.output.split("\n")) {
    try {
      const e = JSON.parse(l) as { Action: string; Test?: string; Output?: string };
      if (!e.Test || e.Test.includes("/")) continue;
      if (e.Action === "output") outs.set(e.Test, [...(outs.get(e.Test) ?? []), e.Output ?? ""]);
      if (e.Action === "pass" || e.Action === "fail") res.set(e.Test, { ok: e.Action === "pass", out: stripAnsi((outs.get(e.Test) ?? []).filter((x) => !/^(=== (RUN|PAUSE|CONT)|--- (FAIL|PASS))/.test(x.trim())).join("").trim()).slice(0, 300) });
    } catch { /* not a json line */ }
  }
  return res;
}
/** The lines of test function `name` the change rewrote: removed lines prefixed "-", added "+", assertion-looking lines first. */
export function testEditOf(baseSrc: string, patchedSrc: string, name: string, max = 6): string {
  const fn = (src: string): string[] => { const m = new RegExp(`^func ${name}\\(t \\*testing\\.T\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(src); return m ? m[1]!.split("\n").map((l) => l.trim()).filter(Boolean) : []; };
  const a = fn(baseSrc), b = fn(patchedSrc), rm = a.filter((l) => !b.includes(l)), add = b.filter((l) => !a.includes(l));
  const rank = (l: string): number => (/want|expect|:=\s*"|==|!=|Equal|Fatal|Error/.test(l) ? 0 : 1);
  return [...rm.sort((x, y) => rank(x) - rank(y)).slice(0, max / 2).map((l) => `- ${l.slice(0, 160)}`), ...add.sort((x, y) => rank(x) - rank(y)).slice(0, max / 2).map((l) => `+ ${l.slice(0, 160)}`)].join("\n");
}
/** Base-test replay (zero calls): tests that passed on the base tree and fail in the patched tree with the original versions of the edited test files, shown with the expectation lines the change rewrote. */
export function replayFindings(base: GoTestRun, now: GoTestRun, tests: { base: string; patched: string }[]): Finding[] {
  const out: Finding[] = [];
  for (const [t, r] of now) {
    if (r.ok || !base.get(t)?.ok) continue;
    const edit = tests.map((f) => testEditOf(f.base, f.patched, t)).find(Boolean);
    out.push({ id: `T_${t}`, desc: `existing test ${t}, as it was before the change, run against the changed code`, before: "PASS", after: `FAIL: ${r.out || "(no output)"}`, source: "replay", ...(edit ? { testEdit: edit } : {}) });
  }
  return out;
}

/** The probe case's source line(s). */
export function caseSnippet(program: string, id: string, max = 600): string {
  const lines = program.split("\n"), at = lines.findIndex((l) => new RegExp(`^\\s*lokiProbe\\(\\s*"${escapeRegex(id)}"`).test(l));
  if (at < 0) return "";
  let end = at + 1; while (end < lines.length && !/^\s*lokiProbe\(/.test(lines[end]!) && !/^\}\s*$/.test(lines[end]!)) end++;
  return lines.slice(at, end).map((l) => l.trim()).join(" ").slice(0, max);
}
export interface NrdFinding extends Finding { verdict: Verdict }
export interface NrdResult { incomplete?: string; notRun?: string; cases: CaseDiff[]; findings: NrdFinding[]; blocking: NrdFinding[]; groups: FailureGroup[]; notes: string[]; calls: number; usd: number }
/** The fix-round input: ONE FailureGroup holding every blocking finding with its before and after output. */
export function nrdFailureGroups(blocking: NrdFinding[]): FailureGroup[] {
  if (!blocking.length) return [];
  const lines = blocking.slice(0, 4).map((f) => f.source === "replay" ? `${f.desc} now fails (${clip(f.after, 300)}); keep this test's original expectation true.` : `${f.desc}: printed ${clip(f.before, 300)} before your change and prints ${clip(f.after, 300)} now.`);
  return [{ signature: "no-regression: behavior the issue does not ask to change", count: blocking.length, sample: `${lines.join("\n   ")}${blocking.length > 4 ? `\n   (${blocking.length - 4} more)` : ""}\n   Keep the change the issue asks for and make each case above behave as it did before.` }];
}

export interface NrdProgram { src: string; /** written after the diff existed (the post-implement call): every case is a keep case */ post?: boolean }
export interface NrdInput { issue: string; programs: NrdProgram[]; run: (program: string, state: "base" | "patched") => ProbeRunResult; replay?: () => Finding[]; llm: LlmCall }
/** Cases, judge, corrections, group. Pure over its inputs: the trees live behind `run` and `replay`. Only changed keep cases (and replay findings) are judged; which case is a change case is decided in code by isChangeCase, and post-implement cases are always keep cases. An empty or unreadable judge reply is "incomplete", never a pass and never a block. */
export async function runNoRegression(i: NrdInput): Promise<NrdResult> {
  const notes: string[] = []; let calls = 0, usd = 0;
  const diffs = i.programs.map((p) => ({ p, d: differential((s) => i.run(p.src, s), notes) })), unbuilt = diffs.filter((x) => x.d.unbuilt).map((x) => x.d.unbuilt!), notRun = diffs.length > 0 && unbuilt.length === diffs.length ? unbuilt[0] : undefined;
  const tagged = diffs.flatMap(({ p, d }) => d.cases.map((x) => ({ ...x, post: !!p.post, src: p.src }))), cases: CaseDiff[] = tagged.map(({ post: _p, src: _s, ...x }) => x);
  for (const x of cases) if (x.status === "missing_patched") notes.push(`case ${x.id} ran on base but not on the patched tree (an API it calls changed)`);
  const flaky = cases.filter((x) => x.status === "flaky").length;
  if (flaky) notes.push(`${flaky} case(s) printed different output on two runs of the same tree and were ignored`);
  const probe = tagged.filter((x) => x.status === "changed").map((x): Finding | null => {
    const snippet = caseSnippet(x.src, x.id);
    if (!x.post && isChangeCase(i.issue, snippet, x.before, x.after)) return null; // the issue asks for exactly this change
    return { id: x.id, desc: x.desc, before: x.before, after: x.after, source: "probe", named: callsOnlyAskedFunctions(i.issue, snippet) };
  }).filter((f): f is Finding => f !== null);
  const all: (Finding & { label: string })[] = [...probe, ...(i.replay?.() ?? []).slice(0, 6)].map((f, n, a) => ({ ...f, label: a.slice(0, n).some((y) => y.id === f.id) ? `${f.id}#${n}` : f.id }));
  if (!all.length) return { ...(notRun ? { notRun } : {}), cases, findings: [], blocking: [], groups: [], notes, calls, usd };
  const j = await i.llm(SYS_NRD_JUDGE, nrdJudgePrompt(i.issue, all), "judge");
  calls++; usd += j.usage.costUsd;
  const v = parseNrdVerdicts(j.text);
  const incomplete = v.size === 0 ? "the judge reply was empty or unreadable, so the changed cases were not judged" : undefined;
  if (incomplete) notes.push(incomplete);
  const findings = all.map(({ label, ...f }): NrdFinding => {
    const raw = v.get(label) ?? "unknown", verdict = overrideVerdict(i.issue, f, raw);
    if (verdict !== raw) notes.push(`case ${f.id}: judged ${raw}, ${verdict === "unknown" ? "but the issue never mentions this change: advisory only" : `corrected to ${verdict} by the issue text`}`);
    if (verdict === "unknown") notes.push(`case ${f.id} changed and the judge could not decide whether the issue asks for it`);
    return { ...f, verdict };
  });
  const blocking = findings.filter((f) => f.verdict === "unrequested");
  return { ...(incomplete ? { incomplete } : {}), ...(notRun ? { notRun } : {}), cases, findings, blocking, groups: nrdFailureGroups(blocking), notes, calls, usd };
}

// ---------------- scratch trees: the user's tree is only read ----------------
function extractBase(repoDir: string, sha: string, dir: string): void {
  const tar = execFileSync("git", safeGitArgs(["archive", "--format=tar", sha], false, repoDir), { cwd: repoDir, env: safeGitEnv(process.env), maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("tar", ["-x", "-C", dir], { input: tar, maxBuffer: 1 << 20 });
  if (r.status !== 0) throw new Error("tar could not unpack the base tree");
}
/** <tmp>/loki-nrd-XXXX/{base,patched}: base is `git archive` of the base commit plus the user's own untracked files, patched is base plus the agent's diff (sealed files left out). Removed by exact validated path. */
export function makeScratch(repoDir: string, baseSha: string, skip: Set<string>, userUntracked: string[] = []): { base: string; patched: string; replay(editedTests: string[], baseTest: (p: string) => string | null): string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)), base = join(root, "base"), patched = join(root, "patched"), replay = join(root, "replay");
  const dispose = (): void => { try { if (basename(root).startsWith(SCRATCH_PREFIX) && dirname(realpathSync(root)) === realpathSync(tmpdir()) && !lstatSync(root).isSymbolicLink()) rmSync(root, { recursive: true, force: true }); } catch { /* a leaked temp dir goes with the temp root */ } };
  try {
    extractBase(repoDir, baseSha, base);
    for (const f of userUntracked) { // the user's own untracked files exist in both copies or in neither: a probe that reads one must not show a spurious change
      const src = join(repoDir, f);
      try { if (!f.startsWith("..") && !f.startsWith("/") && lstatSync(src).isFile()) { mkdirSync(dirname(join(base, f)), { recursive: true }); cpSync(src, join(base, f)); } } catch { /* gone or unreadable: left out of both */ }
    }
    cpSync(base, patched, { recursive: true });
    applyDiff(patched, snapshotDiff(repoDir, baseSha, ATTEMPT_EXCLUDES).filter((e) => !skip.has(e.path)), ATTEMPT_EXCLUDES);
  } catch (e) { dispose(); throw e; }
  return {
    base, patched, dispose,
    replay(editedTests, baseTest) { // the patched tree with the original version of every edited test file (a deleted one is restored, an added one is left)
      cpSync(patched, replay, { recursive: true });
      for (const f of editedTests) { const t = baseTest(f); if (t !== null) { mkdirSync(dirname(join(replay, f)), { recursive: true }); writeFileSync(join(replay, f), t); } }
      return replay;
    },
  };
}

// ---------------- the implement-stage gate ----------------
export interface NrdSummary { status: "skipped" | "clean" | "fired" | "error"; reason: string; calls: number; usd: number; groups?: FailureGroup[]; receipt?: string[] }
const skip = (reason: string, extra: Partial<NrdSummary> = {}): NrdSummary => ({ status: "skipped", reason, calls: 0, usd: 0, ...extra });
const nrdBudgetS = (env: NodeJS.ProcessEnv): number => { const n = Number(env.LOKI_E10_NRD_BUDGET_S); return env.LOKI_E10_NRD_BUDGET_S !== undefined && env.LOKI_E10_NRD_BUDGET_S !== "" && Number.isFinite(n) && n >= 0 ? n : 120; };
class NrdBudgetError extends Error {}
/** Receipt line for a differential that could not complete: NOT PROVEN, never a block. */
const notProven = (why: string): string => `NOT PROVEN: regression check incomplete: ${why}`;
const notRunLine = (why: string): string => `NOT PROVEN: regression check not run: ${why}`;
const pkgOf = (src: string): string | null => /^package\s+(\w+)/m.exec(src)?.[1] ?? null;
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ");

/** Called from implement.ts after the session (and the tournament) on the lean path. Default on; LOKI_E10_NRD=0 opts out (null, no work). Go only in this slice.
 *  Never throws: any error is a receipt-only skip, and the tree is never written (scratch copies only). */
export async function runNrdGate(ctx: RunContext, signal: AbortSignal, session: SessionResult, wallPaths: string[], llm: LlmCall = toolLessLlm(), env: NodeJS.ProcessEnv = process.env): Promise<NrdSummary | null> {
  if (!nrdEnabled(env)) return null;
  if (signal.aborted || session.killed || session.exit !== 0 || !session.markers.done || session.markers.specConflict || session.markers.alreadyDone) return skip("the implement session did not finish clean");
  if ((ctx.implementLeftS?.() ?? Infinity) < 150) return skip("not enough implement time left for the scratch probe runs");
  let scratch: ReturnType<typeof makeScratch> | null = null;
  const deadline = Date.now() + nrdBudgetS(env) * 1000, left = (): number => deadline - Date.now();
  const check = (): void => { if (left() <= 0) throw new NrdBudgetError(`the ${nrdBudgetS(env)} s wall budget for the whole differential ran out`); };
  const timed = <T,>(f: () => Promise<T>): Promise<T> => { check(); return Promise.race([f(), new Promise<never>((_, rej) => setTimeout(() => rej(new NrdBudgetError(`the ${nrdBudgetS(env)} s wall budget for the whole differential ran out`)), left()).unref())]); };
  const tl: LlmCall = (sys, user, tag) => timed(() => llm(sys, user, tag));
  try {
    const sealed = new Set(wallPaths), issue = String(ctx.outputs().intake?.task ?? "");
    if (!issue) return skip("the task text is not readable");
    const diff = snapshotDiff(ctx.repoDir, ctx.baseSha, ATTEMPT_EXCLUDES).filter((e) => !sealed.has(e.path));
    const goSrc = diff.filter((e) => e.path.endsWith(".go") && !isTestFile(e.path) && e.kind === "file");
    if (goSrc.length === 0) return skip("the diff holds no Go source file");
    const edited: { name: string; dir: string }[] = [];
    for (const e of goSrc) for (const name of editedSymbols(e.path, baseText(ctx, e.path), e.content?.toString("utf8") ?? "")) edited.push({ name, dir: dirname(e.path).replace(/^\.$/, "") });
    if (edited.length === 0) return skip("no function body changed");
    if (edited.length > MAX_EDITED) return skip(`${edited.length} functions edited, over the ${MAX_EDITED} limit`);
    const dir = [...edited.map((x) => x.dir)].sort((a, b) => edited.filter((x) => x.dir === b).length - edited.filter((x) => x.dir === a).length)[0]!;
    const names = edited.filter((x) => x.dir === dir).map((x) => x.name), files = goSources(ctx.repoDir, dir), pkg = pkgOf(Object.values(files)[0] ?? "");
    if (!pkg) return skip("the package of the edited functions is not readable");
    const baseFiles = Object.fromEntries(Object.keys(files).map((p) => [p, baseText(ctx, p)]));
    const callers = callersOf(names, baseFiles), unnamed = postProbeNeeded(issue, names, baseFiles);
    const pre = readTournamentInput(ctx.runDir), programs: NrdProgram[] = []; let calls = 0, usd = 0, incompleteNote: string | undefined;
    if (pre && pre.pkg === pkg && pre.pkgRel === dir&& /\blokiProbe\(\s*"/.test(pre.program)) programs.push({ src: pre.program });
    if (unnamed.length > 0) { // the post-implement probe call: written from the issue and the BASE code only
      const tests: Record<string, string> = {};
      for (const f of safeGit(ctx.repoDir, ["ls-files", "-z", "--", dir === "" ? "." : dir]).split("\0")) if (f.endsWith("_test.go") && dirname(f).replace(/^\.$/, "") === dir) { const s = baseText(ctx, f); if (s) tests[f] = s; }
      const ctxPack = probeContext(baseFiles, tests, [...names, ...callers]);
      const r = await tl(SYS_NRD_PROBE, nrdProbePrompt({ issue, pkg, files: ctxPack.files, tests: ctxPack.tests, edited: names, callers, unnamed, sites: outputSites(baseFiles, [...names, ...callers]) }), "nrd-probe");
      calls++; usd += r.usage.costUsd;
      const p = parseGoProbeCases(splitProbeBlock(r.text).probe, pkg);
      if ("file" in p) programs.push({ src: p.file, post: true }); else incompleteNote = `the post-implement probe call wrote no usable cases (${p.refused}) for the callers ${unnamed.join(", ")}`;
    }
    if (programs.length === 0) return skip(`no probe program: ${pre ? "the pre-implement program is for another package" : "the exec-spec call left none"}, and every caller of the edited functions is named by the issue`, { calls, usd, ...(incompleteNote ? { receipt: [oneLine(notProven(incompleteNote))] } : {}) });
    check();
    const intakeOut = ctx.outputs().intake ?? {}, mine = [...(Array.isArray(intakeOut.preexisting_untracked) ? intakeOut.preexisting_untracked as string[] : []), ...Object.keys((intakeOut.preexisting_untracked_blobs ?? {}) as object)];
    scratch = makeScratch(ctx.repoDir, ctx.baseSha, sealed, mine);
    const tree = scratch, editedTests = diff.filter((e) => e.path.endsWith("_test.go") && dirname(e.path).replace(/^\.$/, "") === dir && baseText(ctx, e.path) !== "").map((e) => e.path);
    const r = await runNoRegression({
      issue, programs, llm: tl,
      run: (program, state) => { check(); return runGoProbe(state === "base" ? tree.base : tree.patched, dir, pkg, program, Math.max(5_000, Math.min(45_000, left()))); },
      ...(editedTests.length ? { replay: () => { check(); return replayFindings(goTestResults(tree.base, dir), goTestResults(tree.replay(editedTests, (p) => baseText(ctx, p) || null), dir), editedTests.map((p) => ({ base: baseText(ctx, p), patched: diff.find((e) => e.path === p)?.content?.toString("utf8") ?? "" }))); } } : {}),
    });
    calls += r.calls; usd += r.usd;
    const ran = r.cases.filter((x) => x.status !== "missing_base").length;
    const receipt = [
      ...(r.notRun ? [notRunLine(r.notRun)] : []), ...(incompleteNote ? [notProven(incompleteNote)] : []), ...(r.incomplete ? [notProven(r.incomplete)] : []),
      `no-regression: ${ran} probe case(s) compared on the base and the patched tree, ${r.cases.filter((x) => x.status === "changed").length} changed, ${r.blocking.length} unrequested${r.blocking.length ? " (one fix round was asked to restore them)" : ""}`,
      ...r.findings.filter((f) => f.verdict === "unknown").map((f) => `advisory: ${f.desc} changed and the issue does not decide it (printed ${clip(f.before, 80)}, now ${clip(f.after, 80)})`),
      ...r.blocking.map((f) => `unrequested change: ${f.desc}: printed ${clip(f.before, 80)}, now ${clip(f.after, 80)}`),
    ].map(oneLine);
    return { status: r.blocking.length ? "fired" : r.notRun ? "skipped" : "clean", reason: r.notes.join("; ") || "no unrequested change", calls, usd: Number(usd.toFixed(6)), ...(r.groups.length ? { groups: r.groups } : {}), receipt };
  } catch (e) {
    const why = oneLine(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    if (e instanceof NrdBudgetError) return { status: "skipped", reason: `not run: ${why}`.slice(0, 300), calls: 0, usd: 0, receipt: [oneLine(notRunLine(why)).slice(0, 300)] };
    return { status: "error", reason: `no-regression skipped: ${why}`.slice(0, 300), calls: 0, usd: 0, receipt: [oneLine(notProven(why)).slice(0, 300)] };
  } finally { scratch?.dispose(); }
}

/** verify.ts: the first verify (no fix round yet) carries the finding as one more failure group, so the fix loop gives it one round; the re-verify never repeats it. */
export function nrdGroupsFor(implement: Record<string, unknown> | undefined, fixRounds: number): FailureGroup[] {
  const g = (implement?.no_regression as { groups?: unknown } | undefined)?.groups;
  return fixRounds === 0 && Array.isArray(g) ? g.filter((x): x is FailureGroup => typeof (x as FailureGroup)?.signature === "string" && typeof (x as FailureGroup)?.sample === "string") : [];
}
/** seal.ts: the receipt block for the implement output; {} (key omitted, receipt hash unchanged) when no differential ran. */
export function nrdReceiptBlock(implement: Record<string, unknown> | undefined): { no_regression?: string[] } {
  const t = implement?.no_regression as { receipt?: unknown } | undefined;
  return Array.isArray(t?.receipt) && t.receipt.length > 0 ? { no_regression: t.receipt.map(String) } : {};
}
