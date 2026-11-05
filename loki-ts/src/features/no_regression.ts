// PROTOTYPE (proto/no-regression-differential): the no-regression differential. After the implement session, probe
// cases for behavior the issue does NOT ask to change run on the base tree and on the patched tree. A keep case whose
// output changes, stably, and that a code-blind judge calls unrequested becomes a blocking finding, handed to the next
// fix round as FailureGroups (engine10/failures.ts), the shape buildFixBrief already takes.
// New file because no module compares base and patched behavior on inputs the issue never mentions: the tournament
// compares candidate trees with each other (features/tournament.ts) and verify runs pass/fail checks. The probe
// machinery is shared with the tournament (features/probes.ts).
//
// Calls, tool-less and single-turn: (1) probes, written from the issue and the BASE code only (the program never sees
// the patch, so it cannot bend to it); (2) the judge, only when a keep case changed. It sees the issue and observed
// outputs, never code. A fix that changes only what the issue asks costs one call.
import type { FailureGroup } from "../engine10/failures.ts";
import { symbolSpans } from "../util/context_pack.ts";
import { caseSnippet, normalizeOut, parseProbeOutput, extractProgram, type Probe, type ProbeExec, type ProbeRun } from "./probes.ts";
import type { LlmCall, Usage } from "./tournament.ts";

export interface NrdContext {
  issue: string;
  lang: "go" | "js";
  pkg?: string; // Go: the package the probe file joins
  files: Record<string, string>; // base text the probe writer sees
  tests: Record<string, string>; // existing tests, which show how to build inputs
  edited?: string[]; // names of the functions the patch edited (never their new text)
  callers?: string[]; // same-package callers of the edited functions
  sites?: OutputSite[]; // round 3: string literals and format calls in the edited functions and callers, one required keep case each
  repoTests?: Record<string, string>; // round 3: every test file of the package, read only to decide whether an edge value (Inf, NaN) is tested
}

export const SYS_NRD_PROBE = "You write a small behavioral probe program. Output only one fenced code block.";
export function nrdProbePrompt(c: NrdContext): string {
  const focus = c.edited?.length
    ? `A fix for this issue edited: ${c.edited.join(", ")}.${c.callers?.length ? ` Callers in the same package: ${c.callers.join(", ")}.` : ""} The code below is the version BEFORE the fix.`
    : "A fix for this issue will edit the code below. It is the version BEFORE the fix.";
  const kinds = [
    "Write probe cases that record what this code returns, so its output can be compared before and after the fix. Two kinds:",
    '- "change": each input the issue says must behave differently, starting with its own examples. 2 to 3 cases.',
    '- "keep": inputs that reach the same code but that the issue does NOT ask to change: the other functions and branches that share code with what the issue names, other options and flags, default, empty and boundary inputs, and the messages, commands and formatted strings the code builds. Give the other functions the issue\'s own example values too, since after the fix those values reach them, and inputs that differ only in letter case, surrounding whitespace, order or repetition. 8 to 12 cases. A correct fix leaves every keep output exactly as it was.',
  ].join("\n");
  const go = [
    `Output one Go code block: a file in package ${c.pkg ?? "main"}, saved next to the existing test, so unexported identifiers and the existing test helpers are in scope. It declares func lokiCases() and no TestXxx function. Each case is one self-contained statement, with no setup shared between cases:`,
    '    lokiCase("k1", "keep", "<input in words>", func() any { return <call> })',
    "Already defined, do not redeclare: lokiCase(id, kind, desc string, f func() any); lokiAll(vs ...any) any packs several return values, as in lokiAll(strconv.Atoi(\"7\")); lokiStdout(f func()) string returns what f prints.",
    "Return values; never assert, never call t.Fatal. Do not return pointers, times, random values, temp paths or channels. Import only what the cases use, and use only identifiers that exist in the code above.",
  ].join("\n");
  const js = [
    'Output one JavaScript (ES module, Node 22+) code block that prints one JSON line per case: {"id":"k1","kind":"keep","desc":"<input in words>","out":<JSON of the result>}.',
    'Wrap each case in try/catch and print out as "THROW:" + message on a throw. Never assert. Import the module with the same relative path the existing test uses, since the program is saved next to it.',
  ].join("\n");
  const ledger = c.sites?.length
    ? [`REQUIRED KEEP COVERAGE. Each line below is a string or a formatting call that the edited code or its callers produce output through. For EACH line write at least one keep case whose returned value passes through it, and start that case's desc with the line's tag, for example "[s1] ${"<input in words>"}". Prefer the issue's own example values as inputs. These cases count toward the keep cases.`, ...c.sites.map((x) => `[${x.id}] in ${x.fn}: ${x.text}`)].join("\n")
    : "";
  return [
    `ISSUE:\n${c.issue}`,
    focus,
    ...Object.entries(c.files).map(([p, s]) => `FILE ${p} (before the fix):\n${s}`),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`),
    kinds,
    ...(ledger ? [ledger] : []),
    c.lang === "go" ? go : js,
  ].join("\n\n");
}

// ---- round 3: the mechanical output-site ledger and the edge-value rule (deterministic, no model) ----
export interface OutputSite { id: string; fn: string; text: string; kind: "literal" | "format" }
const FORMAT_CALL = /\b(?:fmt\.(?:Sprintf|Fprintf|Printf|Errorf|Sprint|Sprintln|Fprint|Fprintln)|strings\.(?:ToLower|ToUpper|Title|ToTitle|TrimSpace|Trim\w*|Replace\w*|Join|Repeat|Fields|Split\w*)|strconv\.(?:Format\w+|Quote\w*|Itoa|Append\w+)|errors\.New)\s*\(/g;
/** String literals with a letter pair (outside comments) inside one definition's text: [offset, text] pairs. Shared with mutants.ts. */
export function goStringLiterals(body: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const m of body.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (body.slice(Math.max(0, m.index! - 1), m.index!) === "`" || !/[A-Za-z]{2}/.test(m[1]!) || /^%\w$/.test(m[1]!)) continue;
    const line = body.slice(body.lastIndexOf("\n", m.index!) + 1, body.indexOf("\n", m.index!));
    if (/^\s*\/\//.test(line)) continue; // a comment line
    out.push({ at: m.index!, text: m[1]! });
  }
  return out;
}
/** Every string literal and formatting call in the BASE text of `names` (edited definitions first, then callers), as one
 *  ledger of sites the probe writer must reach. Format calls are listed as their source line; a literal already inside a
 *  listed format line is not listed again. Capped at `cap` sites, taken round-robin across definitions so no one function
 *  takes the whole budget. */
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
/** Sites with no keep case tagged for them that ran on base. */
export function uncoveredSites(sites: OutputSite[], cases: CaseDiff[]): OutputSite[] {
  return sites.filter((s) => !cases.some((c) => c.kind === "keep" && c.status !== "missing_base" && new RegExp(`\\[${s.id}\\](?![0-9])`).test(c.desc)));
}
const EDGE = /\bmath\.(?:Inf|NaN|MaxFloat\d+|SmallestNonzeroFloat\d+)\b|[+-]?\bInf\b|\bNaN\b/;
const PROBE_HELPERS = new Set(["lokiCase", "lokiAll", "lokiStdout", "func", "any", "return", "len", "append", "make", "string", "int", "float64", "Inf", "NaN"]);
/** A changed keep case that feeds a fixed edge value (Inf, NaN, the float limits) is advisory unless a repo test line calls one of
 *  the same functions with an edge value: the repo never pinned that output, so a maintainer fix may legitimately move it. */
export function edgeAdvisory(snippet: string, desc: string, repoTests: Record<string, string> | undefined): boolean {
  if (!EDGE.test(snippet) && !EDGE.test(desc)) return false;
  const called = [...new Set([...snippet.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!).filter((n) => !PROBE_HELPERS.has(n) && !/^(?:math|strconv|strings|fmt)$/.test(n)))];
  const tested = Object.values(repoTests ?? {}).some((t) => t.split("\n").some((l) => EDGE.test(l) && called.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(l))));
  return !tested;
}

export interface JudgeCase { label: string; desc: string; before: string; after: string }
export const SYS_NRD_JUDGE = "You decide whether an issue asks for an observed behavior change. You never see code. Answer only in the requested format.";
export function nrdJudgePrompt(issue: string, cases: JudgeCase[], requested: JudgeCase[] = []): string {
  const row = (x: JudgeCase): string => `CASE ${x.label}: ${x.desc}\n  before the fix: ${clip(x.before)}\n  after the fix:  ${clip(x.after)}`;
  return [
    `ISSUE:\n${issue}`,
    ...(requested.length ? [`For reference, the fix changed these inputs the issue itself names:\n${requested.slice(0, 3).map(row).join("\n")}`] : []),
    "Each case below printed one thing before the fix and another after it. For each case, decide whether the issue asks for that change:\n- requested: the issue asks for it, or it follows directly and necessarily from what the issue asks.\n- unrequested: the issue neither asks for it nor implies it; a maintainer would expect this output to stay as it was.\n- unknown: the issue does not decide it.",
    cases.map(row).join("\n\n"),
    "Answer one line per case: <case id>: requested|unrequested|unknown",
  ].join("\n\n");
}

export type Verdict = "requested" | "unrequested" | "unknown";
export function parseNrdVerdicts(text: string): Map<string, Verdict> {
  const v = new Map<string, Verdict>();
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]*\s*\**\s*(?:case\s+)?([A-Za-z0-9_#.-]+)\s*\**\s*[:=-]\s*\**\s*(unrequested|requested|unknown)\b/i.exec(line);
    if (m && !v.has(m[1]!)) v.set(m[1]!, m[2]!.toLowerCase() as Verdict);
  }
  return v;
}

function clip(s: string, max = 400): string { return s.length > max ? `${s.slice(0, max)}...(${s.length - max} more chars)` : s; }

// ---- what the patch edited, from symbol spans (deterministic, no model) ----
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

/** A definition's text after its signature (from the first brace), so a one-line function keeps its body and loses its own name. */
function bodyOf(lines: string[], s: { start: number; end: number }): string {
  const whole = lines.slice(s.start - 1, s.end).join("\n"), at = whole.indexOf("{");
  return at < 0 ? whole : whole.slice(at + 1);
}

/** Same-package definitions that call one of `names` (Go methods are matched by their method name). */
export function callersOf(names: string[], files: Record<string, string>): string[] {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const calls = names.map((n) => (n.includes(".") ? new RegExp(`\\.${esc(n.split(".").pop()!)}\\s*\\(`) : new RegExp(`(?:^|[^\\w.])${esc(n)}\\s*\\(`, "m")));
  const out = new Set<string>();
  for (const [path, src] of Object.entries(files)) {
    const lines = src.split("\n");
    for (const s of symbolSpans(path, src)) {
      if (s.container || names.includes(s.name)) continue;
      if (calls.some((re) => re.test(bodyOf(lines, s)))) out.add(s.name);
    }
  }
  return [...out].sort();
}

/** What the probe writer sees: each changed file and each file defining one of `names` (the edited definitions and their
 *  callers), a small file whole and a large one as its head plus those definitions; from the tests, the test functions that
 *  mention one of `names`, within a budget. */
export function probeContext(pkgFiles: Record<string, string>, testFiles: Record<string, string>, names: string[], changed: string[] = [], o = { wholeBytes: 12_000, testBytes: 8_000, testsPerFile: 3 }): { files: Record<string, string>; tests: Record<string, string> } {
  const files: Record<string, string> = {}, tests: Record<string, string> = {};
  const short = names.map((n) => n.split(".").pop()!);
  const mentions = (s: string): boolean => short.some((n) => new RegExp(`\\b${n.replace(/[$]/g, "\\$")}\\b`).test(s));
  for (const [p, src] of Object.entries(pkgFiles)) {
    const spans = symbolSpans(p, src).filter((s) => !s.container && names.includes(s.name)), lines = src.split("\n");
    if (spans.length === 0 && !changed.includes(p)) continue; // a changed file is always shown: an added function has no base span
    if (src.length <= o.wholeBytes) { files[p] = src; continue; }
    const head = lines.slice(0, Math.max(0, Math.min(...symbolSpans(p, src).map((s) => s.start)) - 1)).join("\n").slice(0, 1500);
    files[p] = [head, ...spans.map((s) => lines.slice(s.start - 1, s.end).join("\n"))].join("\n\n// ...\n\n");
  }
  let budget = o.testBytes;
  for (const [p, src] of Object.entries(testFiles)) {
    const lines = src.split("\n");
    const hits = symbolSpans(p, src).filter((s) => !s.container && mentions(bodyOf(lines, s))).slice(0, o.testsPerFile);
    const text = hits.map((s) => lines.slice(s.start - 1, s.end).join("\n")).join("\n\n");
    if (!text || text.length > budget) continue;
    tests[p] = text; budget -= text.length;
  }
  return { files, tests };
}

// ---- the differential ----
export type CaseStatus = "same" | "changed" | "flaky" | "missing_base" | "missing_patched";
export interface CaseDiff { id: string; kind: string; desc: string; before: string; after: string; status: CaseStatus }

/** Compare two base runs and two patched runs case by case. A case counts only when both runs of each tree agree. */
export function compareRuns(base: [ProbeRun, ProbeRun], patched: [ProbeRun, ProbeRun], probes: Probe[]): CaseDiff[] {
  return probes.map((p) => {
    const [b0, b1] = base.map((r) => r[p.id]), [p0, p1] = patched.map((r) => r[p.id]);
    const row = { id: p.id, kind: p.kind ?? "", desc: p.desc, before: b0 ?? "", after: p0 ?? "" };
    if (b0 === undefined || b1 === undefined) return { ...row, status: "missing_base" as const };
    if (b0 !== b1) return { ...row, status: "flaky" as const };
    if (p0 === undefined || p1 === undefined) return { ...row, status: "missing_patched" as const };
    if (p0 !== p1) return { ...row, status: "flaky" as const };
    return { ...row, status: b0 === p0 ? "same" as const : "changed" as const };
  });
}

export interface NrdFinding { id: string; desc: string; before: string; after: string; verdict: Verdict }
export interface NrdResult {
  program: string;
  cases: CaseDiff[];
  findings: NrdFinding[]; // every changed keep case with its verdict
  blocking: NrdFinding[]; // verdict unrequested
  groups: FailureGroup[]; // what the fix round receives
  notes: string[]; // advisory only: never blocks
  calls: number;
  usage: Usage[];
  uncovered?: string[]; // round 3: ledger sites no keep case reached
  advisory?: string[]; // round 3: unrequested edge-value changes kept out of blocking
}

export interface NrdIo {
  /** Run the probe program on the base tree or on the patched tree, with the same path for both where possible. */
  run(state: "base" | "patched", program: string): ProbeExec & { roots?: string[] };
}

const verdictKey = (f: { id: string; before: string; after: string }): string => `${f.id}\u0000${f.before}\u0000${f.after}`;

/** The fix-round input: one FailureGroup per blocking finding, with the probe case that shows it. */
export function nrdFailureGroups(blocking: NrdFinding[], program: string): FailureGroup[] {
  return blocking.map((f) => {
    const code = caseSnippet(program, f.id);
    return {
      signature: `no-regression ${f.id}: behavior the issue does not ask to change`,
      count: 1,
      sample: `${f.desc}: printed ${clip(f.before, 300)} before your change and prints ${clip(f.after, 300)} now. Keep the change the issue asks for and make this case print what it printed before.${code ? `\n   probe case: ${code}` : ""}`,
    };
  });
}

/** Runs the differential. `program` reuses an earlier probe program (a later fix round, or another patch of the same task)
 *  with no probe call; `verdicts` reuses earlier judge answers for identical (case, before, after) triples with no judge call. */
export async function runNoRegression(c: NrdContext, llm: LlmCall, io: NrdIo, opts: { program?: string; verdicts?: Map<string, Verdict> } = {}): Promise<NrdResult> {
  const usage: Usage[] = [], notes: string[] = [];
  let program = opts.program;
  if (program === undefined) {
    const r = await llm(SYS_NRD_PROBE, nrdProbePrompt(c));
    usage.push(r.usage);
    program = extractProgram(r.text);
  }
  const exec = (state: "base" | "patched", prog: string): { e: ProbeExec; run: ProbeRun; probes: Probe[] } => {
    const e = io.run(state, prog), parsed = parseProbeOutput(normalizeOut(e.stdout, e.roots ?? []));
    if (e.error) notes.push(`${state}: ${e.error}`);
    for (const p of e.pruned) notes.push(`${state}: case ${p.id} dropped (${p.error})`);
    return { e, ...parsed };
  };
  const b0 = exec("base", program), b1 = exec("base", b0.e.program);
  const p0 = exec("patched", b0.e.program), p1 = exec("patched", p0.e.program);
  const cases = compareRuns([b0.run, b1.run], [p0.run, p1.run], b0.probes);
  for (const x of cases) if (x.status === "missing_patched" && x.kind === "keep") notes.push(`case ${x.id} ran on base but not on the patched tree (an API it calls changed)`);
  const flaky = cases.filter((x) => x.status === "flaky").length;
  if (flaky) notes.push(`${flaky} case(s) printed different output on two runs of the same tree and were ignored`);
  const changedKeep = cases.filter((x) => x.status === "changed" && x.kind === "keep");
  const changedAsked = cases.filter((x) => x.status === "changed" && x.kind !== "keep");
  if (cases.length && !cases.some((x) => x.kind !== "keep" && x.status === "changed")) notes.push("no change case changed output: the probes may not reach the requested change");
  const verdicts = new Map(opts.verdicts ?? []);
  const ask = changedKeep.filter((x) => !verdicts.has(verdictKey(x)));
  if (ask.length) {
    const j = await llm(SYS_NRD_JUDGE, nrdJudgePrompt(c.issue, ask.map((x) => ({ label: x.id, desc: x.desc, before: x.before, after: x.after })), changedAsked.map((x) => ({ label: x.id, desc: x.desc, before: x.before, after: x.after }))));
    usage.push(j.usage);
    const v = parseNrdVerdicts(j.text);
    for (const x of ask) verdicts.set(verdictKey(x), v.get(x.id) ?? "unknown");
  }
  const findings = changedKeep.map((x) => ({ id: x.id, desc: x.desc, before: x.before, after: x.after, verdict: verdicts.get(verdictKey(x)) ?? "unknown" as Verdict }));
  for (const f of findings) if (f.verdict === "unknown") notes.push(`case ${f.id} changed and the judge could not decide whether the issue asks for it`);
  const edge = new Set(findings.filter((f) => f.verdict === "unrequested" && edgeAdvisory(caseSnippet(b0.e.program, f.id), f.desc, c.repoTests)).map((f) => f.id));
  for (const id of edge) notes.push(`case ${id} changed on an edge value (Inf, NaN or a float limit) no repo test pins: advisory, not blocking`);
  const uncovered = c.sites?.length ? uncoveredSites(c.sites, cases) : [];
  if (uncovered.length) notes.push(`${uncovered.length} output site(s) have no keep case: ${uncovered.map((x) => `${x.id} ${x.fn}`).join(", ")}`);
  const blocking = findings.filter((f) => f.verdict === "unrequested" && !edge.has(f.id));
  return { program: b0.e.program, cases, findings, blocking, groups: nrdFailureGroups(blocking, b0.e.program), notes, calls: usage.length, usage, uncovered: uncovered.map((x) => x.id), advisory: [...edge] };
}
