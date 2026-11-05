// No-regression differential (proto/nrd-build, off until measured): behavior the issue does not ask to change must print the same
// before and after the change. One Go runner and one probe program are shared with the candidate tournament (features/tournament.ts):
// the probe cases come from the exec-spec call that already runs before implement (probeIntake), with the output-site ledger below
// appended per run, so the default path costs no extra call. A post-implement probe call is made only when an edited function has
// same-package callers the issue does not name (the exec-spec call could not know to cover them).
// New file because no module compares base and patched behavior on inputs the issue never mentions: the tournament compares candidate
// trees with each other, verify runs pass/fail checks.
//
//   1. base-test replay (no call): the original version of every existing test file the change edited runs against the changed code;
//      a test that passed before and fails now is a finding, shown with the expectation lines the change rewrote in it.
//   2. probe differential (no call on the default path): every probe case whose output changed, stably, is a finding.
//   3. one code-blind judge call over all findings: requested | unrequested | unknown; only "unrequested" blocks. A "requested" verdict
//      on a change the issue never mentions is overridden to "unrequested" (overrideVerdict).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureGroup } from "../engine10/failures.ts";
import { symbolSpans } from "../util/context_pack.ts";
import { goCaseBlocks, parseProbeOutput, runGoProbe, type Probe, type ProbeRun } from "./tournament.ts";

// ---------- the output-site ledger (deterministic) ----------
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
/** Every string literal and formatting call in the BASE text of `names`, round-robin across definitions, capped. */
export function outputSites(files: Record<string, string>, names: string[], cap = 14): OutputSite[] {
  const per: OutputSite[][] = [];
  for (const n of names) {
    const sites: OutputSite[] = [];
    for (const [p, src] of Object.entries(files)) {
      const lines = src.split("\n");
      for (const s of symbolSpans(p, src)) {
        if (s.container || s.name !== n) continue;
        const body = lines.slice(s.start - 1, s.end).join("\n"), fmt = new Set<string>();
        for (const m of body.matchAll(FORMAT_CALL)) {
          const end = body.indexOf("\n", m.index!), line = body.slice(body.lastIndexOf("\n", m.index!) + 1, end < 0 ? undefined : end).trim();
          if (line.startsWith("//") || fmt.has(line)) continue;
          fmt.add(line); sites.push({ id: "", fn: n, text: line.slice(0, 160), kind: "format" });
        }
        for (const l of goStringLiterals(body)) if (![...fmt].some((f) => f.includes(`"${l.text}"`)) && !sites.some((x) => x.text === `"${l.text}"`)) sites.push({ id: "", fn: n, text: `"${l.text.slice(0, 120)}"`, kind: "literal" });
      }
    }
    per.push(sites);
  }
  const out: OutputSite[] = [];
  for (let i = 0; out.length < cap && per.some((x) => x.length > i); i++) for (const x of per) if (x[i] && out.length < cap) out.push(x[i]!);
  return out.map((x, i) => ({ ...x, id: `s${i + 1}` }));
}
/** Per-run text appended after GO_PROBE_RULES in the exec-spec call (never in the cache-stable prefix). Empty when there is no site. */
export function keepLedger(sites: OutputSite[]): string {
  if (!sites.length) return "";
  return [`Also cover what must NOT change. Each line below is a string or formatting call the named code or its callers produce output through. For EACH line add one lokiProbe case whose returned value passes through it, its desc starting with the line's tag (for example "[s1] ..."). Prefer the report's own example values as inputs. These count toward the 6 to 12 cases (up to 16 with them).`, ...sites.map((s) => `[${s.id}] in ${s.fn}: ${s.text}`)].join("\n");
}
export const uncoveredSites = (sites: OutputSite[], probes: Probe[]): OutputSite[] => sites.filter((s) => !probes.some((p) => new RegExp(`\\[${s.id}\\](?![0-9])`).test(p.desc)));

// ---------- what the change edited, and whether a post-implement probe is needed ----------
/** Names of the definitions whose text differs between base and patched. */
export function editedSymbols(path: string, baseSrc: string, patchedSrc: string): string[] {
  const body = (src: string): Map<string, string> => { const lines = src.split("\n"), m = new Map<string, string>(); for (const s of symbolSpans(path, src)) if (!s.container) m.set(s.name, lines.slice(s.start - 1, s.end).join("\n")); return m; };
  const a = body(baseSrc), b = body(patchedSrc);
  return [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();
}
function bodyOf(lines: string[], s: { start: number; end: number }): string { const whole = lines.slice(s.start - 1, s.end).join("\n"), at = whole.indexOf("{"); return at < 0 ? whole : whole.slice(at + 1); }
/** Same-package definitions that call one of `names` (Go methods by their method name). */
export function callersOf(names: string[], files: Record<string, string>): string[] {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const calls = names.map((n) => (n.includes(".") ? new RegExp(`\\.${esc(n.split(".").pop()!)}\\s*\\(`) : new RegExp(`(?:^|[^\\w.])${esc(n)}\\s*\\(`, "m")));
  const out = new Set<string>();
  for (const [path, src] of Object.entries(files)) { const lines = src.split("\n"); for (const s of symbolSpans(path, src)) { if (s.container || names.includes(s.name)) continue; if (calls.some((re) => re.test(bodyOf(lines, s)))) out.add(s.name); } }
  return [...out].sort();
}
const short = (n: string): string => n.split(".").pop()!;
/** The post-implement probe call fires only when an edited function has a same-package caller the issue does not name: the exec-spec
 *  call wrote its cases before the diff existed and could only aim at what the issue names. */
export function postProbeNeeded(issue: string, edited: string[], files: Record<string, string>): string[] {
  const named = (n: string): boolean => new RegExp(`\\b${short(n).replace(/[$]/g, "\\$")}\\b`).test(issue);
  // a method whose name several types of the package define (Set, String, Type: an interface) cannot be traced to its callers by name
  const defs = Object.entries(files).flatMap(([p, src]) => symbolSpans(p, src).filter((s) => !s.container).map((s) => s.name));
  const traceable = edited.filter((n) => !n.includes(".") || defs.filter((d) => short(d) === short(n)).length < 2);
  return callersOf(traceable, files).filter((c) => !named(c));
}

/** The post-implement probe brief: the exec-spec probe rules, aimed at the callers the issue does not name (names only, never the diff). */
export function postProbeFocus(edited: string[], callers: string[]): string {
  return `A fix for this issue edited ${edited.join(", ")}. These same-package callers reach the edited code but the issue never names them: ${callers.join(", ")}. Write the cases for THEM: give each caller the report's own example values and the boundary inputs above, so a change that leaks into them shows. A correct fix leaves their output exactly as it was.`;
}

// ---------- 1. base-test replay ----------
export interface Finding { id: string; desc: string; before: string; after: string; source: "replay" | "probe"; testEdit?: string }
/** The lines of test function `name` the change rewrote: removed lines prefixed "-", added "+", assertion-looking lines first. */
export function testEditOf(baseSrc: string, patchedSrc: string, name: string, max = 6): string {
  const fn = (src: string): string[] => { const m = new RegExp(`^func ${name}\\(t \\*testing\\.T\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(src); return m ? m[1]!.split("\n").map((l) => l.trim()).filter(Boolean) : []; };
  const a = fn(baseSrc), b = fn(patchedSrc), rm = a.filter((l) => !b.includes(l)), add = b.filter((l) => !a.includes(l));
  const rank = (l: string): number => (/want|expect|:=\s*"|==|!=|Equal|Fatal|Error/.test(l) ? 0 : 1);
  return [...rm.sort((x, y) => rank(x) - rank(y)).slice(0, max / 2).map((l) => `- ${l.slice(0, 160)}`), ...add.sort((x, y) => rank(x) - rank(y)).slice(0, max / 2).map((l) => `+ ${l.slice(0, 160)}`)].join("\n");
}
export interface GoTestRun { [test: string]: { ok: boolean; out: string } }
/** `base` and `replay` are per-test results of the same original test files on the base tree and on the changed code; `tests` maps each
 *  edited test file to its base and patched text (for the rewritten-expectation lines). */
export function replayFindings(base: GoTestRun, replay: GoTestRun, tests: { base: string; patched: string }[]): Finding[] {
  const out: Finding[] = [];
  for (const [t, r] of Object.entries(replay)) {
    if (r.ok || !base[t]?.ok) continue;
    const edit = tests.map((f) => testEditOf(f.base, f.patched, t)).find(Boolean);
    out.push({ id: `T_${t}`, desc: `existing test ${t}, as it was before the change, run against the changed code`, before: "PASS", after: `FAIL: ${r.out || "(no output)"}`, source: "replay", ...(edit ? { testEdit: edit } : {}) });
  }
  return out;
}

// ---------- 2. probe differential ----------
export type CaseStatus = "same" | "changed" | "flaky" | "missing_base" | "missing_patched";
export interface CaseDiff { id: string; desc: string; before: string; after: string; status: CaseStatus }
/** Two base runs and two patched runs; a case counts only when both runs of each tree agree. */
export function compareRuns(base: [ProbeRun, ProbeRun], patched: [ProbeRun, ProbeRun], probes: Probe[]): CaseDiff[] {
  return probes.map((p) => {
    const [b0, b1] = base.map((r) => r[p.id]), [p0, p1] = patched.map((r) => r[p.id]), row = { id: p.id, desc: p.desc, before: b0 ?? "", after: p0 ?? "" };
    if (b0 === undefined || b1 === undefined) return { ...row, status: "missing_base" as const };
    if (b0 !== b1) return { ...row, status: "flaky" as const };
    if (p0 === undefined || p1 === undefined) return { ...row, status: "missing_patched" as const };
    if (p0 !== p1) return { ...row, status: "flaky" as const };
    return { ...row, status: b0 === p0 ? "same" as const : "changed" as const };
  });
}
/** Runs one probe program twice on each scratch tree with the shared tournament runner. Never the user's tree. */
export function probeDiff(baseDir: string, patchedDir: string, pkgRel: string, pkg: string, program: string): { cases: CaseDiff[]; probes: Probe[]; built: boolean } {
  const run = (d: string) => { const r = runGoProbe(d, pkgRel, pkg, program); return { ...parseProbeOutput(r.stdout), built: r.built }; };
  const b0 = run(baseDir), b1 = run(baseDir), p0 = run(patchedDir), p1 = run(patchedDir);
  return { cases: compareRuns([b0.run, b1.run], [p0.run, p1.run], b0.probes), probes: b0.probes, built: b0.built && p0.built };
}
export const probeFindings = (cases: CaseDiff[]): Finding[] => cases.filter((c) => c.status === "changed").map((c) => ({ id: c.id, desc: c.desc, before: c.before, after: c.after, source: "probe" as const }));

// ---------- 3. the judge and the override ----------
export type Verdict = "requested" | "unrequested" | "unknown";
export const SYS_NRD_JUDGE = "You decide whether an issue asks for an observed behavior change. You never see code. Answer only in the requested format.";
const clip = (s: string, max = 400): string => (s.length > max ? `${s.slice(0, max)}...(${s.length - max} more chars)` : s);
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
  for (const line of text.split("\n")) { const m = /^\s*[-*]*\s*\**\s*(?:case\s+)?([A-Za-z0-9_#.-]+)\s*\**\s*[:=-]\s*\**\s*(unrequested|requested|unknown)\b/i.exec(line); if (m && !v.has(m[1]!)) v.set(m[1]!, m[2]!.toLowerCase() as Verdict); }
  return v;
}
const TOK = /[^\s"'`,;()[\]{}<>|]+/g;
// probe outputs are rendered: an escaped tab or newline separates words too
const toks = (s: string): string[] => [...s.replace(/\\[tnr]/g, " ").matchAll(TOK)].map((m) => m[0]!.replace(/[.:!?]+$/, "").toLowerCase()).filter((t) => t.length >= 3 || /\d|-/.test(t));
const REMOVAL = /\b(?:stop(?:s|ped)?|drop(?:s|ped)?|remov(?:e|es|ed|ing)|strip(?:s|ped)?|without|no longer|omit(?:s|ted)?|delet(?:e|es|ed)|hide|skip)\b/i;
/** True when the issue mentions the change a case shows: a token the new output adds appears in the issue, or a token it drops appears
 *  within six words after a removal word in a sentence that asks for something (the title describes the bug and never counts). */
export function issueMentionsChange(issue: string, before: string, after: string): boolean {
  const b = new Set(toks(before)), a = new Set(toks(after)), it = new Set(toks(issue));
  const lit = after.trim().replace(/^"(.*)"$/s, "$1");
  if (lit.length >= 2 && issue.includes(lit)) return true; // the issue quotes the new output itself ("+Inf x")
  if ([...a].some((t) => !b.has(t) && it.has(t))) return true;
  const removed = [...b].filter((t) => !a.has(t));
  if (removed.length === 0 && [...a].every((t) => b.has(t))) return true; // same words, new order or spacing ("-o, --output"): only the judge can tell
  const asks = issue.split("\n").slice(1).join("\n").split(/(?<=[.!?])\s+|\n+/).filter((x) => /\b(?:should|expected|expect|prefer(?:red)?|fix|please|must|want|instead)\b/i.test(x));
  for (const s of asks) { const w = s.split(/\s+/); for (let i = 0; i < w.length; i++) if (REMOVAL.test(w[i]!) && w.slice(i + 1, i + 7).some((x) => removed.some((r) => toks(x).includes(r)))) return true; }
  return false;
}
/** Values the issue states: code-quoted or double-quoted text (any length), plus every literal of 3 or more characters that appears verbatim. */
const issueQuoted = (issue: string): string[] => [...issue.matchAll(/`([^`\n]+)`|"([^"\n]{1,200})"/g)].map((m) => (m[1] ?? m[2])!);
/** A replayed test whose rewritten (+) lines assert a value the issue states was rewritten toward what the issue asks: requested. */
export function rewriteAssertsIssueValue(issue: string, testEdit: string | undefined): boolean {
  if (!testEdit) return false;
  const q = new Set(issueQuoted(issue).map((x) => x.trim()));
  return testEdit.split("\n").filter((l) => l.startsWith("+ ")).some((l) => [...l.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).some((v) => q.has(v) || (v.length >= 3 && issue.includes(v))));
}
/** Deterministic corrections after the judge. Probe findings: "requested" needs the issue to mention the change. Replay findings: a test
 *  rewritten to assert a value the issue states is requested, whatever the judge said. */
export const overrideVerdict = (issue: string, f: Finding, v: Verdict): Verdict =>
  f.source === "probe" ? (v === "requested" && !issueMentionsChange(issue, f.before, f.after) ? "unrequested" : v) : rewriteAssertsIssueValue(issue, f.testEdit) ? "requested" : v;

/** The fix-round input: one FailureGroup per blocking finding. */
export function nrdFailureGroups(blocking: Finding[], program = ""): FailureGroup[] {
  return blocking.map((f) => {
    const b = goCaseBlocks(program).find((x) => x.id === f.id), code = b ? program.split("\n").slice(b.start, b.end + 1).join("\n").trim().slice(0, 600) : "";
    return { signature: `no-regression ${f.id}: behavior the issue does not ask to change`, count: 1, sample: f.source === "replay" ? `${f.desc} now fails (${clip(f.after, 300)}). Keep the change the issue asks for and keep this test's original expectation true, unless the issue asks for the new behavior.` : `${f.desc}: printed ${clip(f.before, 300)} before your change and prints ${clip(f.after, 300)} now. Keep the change the issue asks for and make this case print what it printed before.${code ? `\n   probe case: ${code}` : ""}` };
  });
}

/** Go per-test results of `go test -json` output (top-level tests only). */
export function parseGoTestJson(stdout: string): GoTestRun {
  const res: GoTestRun = {}, outs = new Map<string, string[]>();
  for (const l of stdout.split("\n")) {
    try { const e = JSON.parse(l) as { Action: string; Test?: string; Output?: string }; if (!e.Test || e.Test.includes("/")) continue;
      if (e.Action === "output") outs.set(e.Test, [...(outs.get(e.Test) ?? []), e.Output ?? ""]);
      if (e.Action === "pass" || e.Action === "fail") res[e.Test] = { ok: e.Action === "pass", out: (outs.get(e.Test) ?? []).filter((x) => !/^(=== RUN|--- (FAIL|PASS))/.test(x.trim())).join("").trim().slice(0, 300) };
    } catch { /* not a json line */ }
  }
  return res;
}

export const nrdEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_NRD === "1"; // off until an L-Haiku arm measures it
/** The ledger for the exec-spec call: the package files beside each resolved site, the sites' own symbols and their callers. */
export function ledgerFor(repoDir: string, sites: { symbol: string; file: string }[]): string {
  const files: Record<string, string> = {};
  for (const s of sites) {
    const dir = s.file.includes("/") ? s.file.slice(0, s.file.lastIndexOf("/")) : ".";
    try { for (const f of readdirSync(join(repoDir, dir)).filter((x) => x.endsWith(".go") && !x.endsWith("_test.go"))) files[dir === "." ? f : `${dir}/${f}`] = readFileSync(join(repoDir, dir, f), "utf8"); } catch { /* unreadable dir: no sites from it */ }
  }
  const names = [...new Set(sites.map((s) => s.symbol))];
  return keepLedger(outputSites(files, [...names, ...callersOf(names, files)]));
}
