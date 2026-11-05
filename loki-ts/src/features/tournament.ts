// PROTOTYPE (proto/go-tournament-probes, iterating proto/candidate-tournament): disagreement-adjudicated candidate tournament.
// New file because features/attempts.ts owns two FULL agent sessions scored by pass counts over the shared set S;
// this module owns a different mechanism: patch-only candidates from ONE tool-less model call, behavioral probes
// written from the issue and the base code alone, and a code-blind adjudicator that judges only the concrete inputs on
// which check-passing trees disagree. Repo checks still gate every tree; the tournament never weakens a verdict, it only
// chooses which already-check-passing tree goes to verify and Seal.
//
// Round 2 (this branch):
//   - Go probe runner: the harness writes a fixed helper _test.go (lokiProbe: recover, canonical rendering, address and
//     tree-path scrub, one "LOKIPROBE {json}" line per case); the model writes only the cases inside TestLokiProbe.
//   - Stability guard: the probe runs on two copies of the base tree; a case whose output differs between them is dropped.
//   - Order-swap judge: every disagreement is shown twice with the option order reversed; a verdict counts only when both
//     views pick the same output, so a judge that answers by position cannot score.
//   - Incumbent-safe selection: a check-passing agent tree is displaced only by a challenger that regresses no spec case
//     the agent passes, wins at least `margin` probes on consistent verdicts and loses none. Unknown, inconsistent, missing
//     and tied verdicts keep the agent; cluster size and diff size only order challengers among themselves.
//   - Calls go through sdk_invoker judgeTextOutcome (messages.create, no tools) with thinking disabled.
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainTestEnv, spawnGroupSync, stripAnsi } from "../util/check_result.ts";
import { describeJudgeOutcome, judgeTextOutcome } from "../runner/sdk_invoker.ts";

export interface Usage { inTok: number; outTok: number; cacheRead: number; cacheWrite: number; costUsd: number }
/** One tool-less single-turn completion. `tag` names the call (candidates, probes, judge) for ledgers and stubs. */
export interface LlmCall { (system: string, user: string, tag?: string): Promise<{ text: string; usage: Usage; outcome?: string }> }
export interface Edit { path: string; search: string; replace: string }
export interface CandidateSpec { id: string; lens: string; edits: Edit[] }
export interface ProbeRun { [probeId: string]: string }
export interface Probe { id: string; desc: string }
export type SpecStates = Record<string, "red" | "green" | "error">;
export interface Io {
  /** Materialize the base tree plus edits into a scratch tree; returns its dir or null when an edit does not apply. "agent" is the agent's finished tree. */
  materialize(edits: Edit[] | "agent"): string | null;
  /** The repo's own checks (plus any sealed binding spec) for the files in play; true when all pass in that tree. */
  checks(dir: string): boolean;
  /** Writes the probe program into dir, runs it, returns its stdout (parsed with parseProbeOutput). */
  probe(dir: string, program: string): string;
  /** Optional: per-case states of the full executable spec (binding and advisory) in that tree. */
  spec?(dir: string): SpecStates | null;
}
export interface Context { issue: string; files: Record<string, string>; tests: Record<string, string>; lang: string; /** what the harness told the implementer (spec brief, sealed spec file) */ brief?: string }

export const LENSES = [
  "minimal: the smallest change that makes the issue's expected behavior true",
  "convention: read each whole function you edit first and make the new branch match its sibling branches (raw vs normalized values, error wrapping, return shapes)",
  "coverage: list every site, symbol and example the issue names and make sure each one is handled, preferring the issue's own preferred fix",
] as const;

const SYS_PATCH = "You write code patches. Output only the requested blocks, no prose.";
export function candidatePrompt(c: Context, lenses: readonly string[] = LENSES): string {
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.files).map(([p, s]) => `FILE ${p}:\n${s}`),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`),
    ...(c.brief ? [`WHAT THE HARNESS ALREADY TOLD THE IMPLEMENTER:\n${c.brief}`] : []),
    `Write ${lenses.length} candidate fixes, each one under a different lens. They must differ where the lenses lead to different code; identical candidates waste the slot.`,
    ...lenses.map((l, i) => `Candidate ${i + 1} lens: ${l}`),
    "Format, repeated per candidate:\n=== CANDIDATE <n> ===\n<<<<<<< SEARCH <path>\n<exact lines from the file>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nSEARCH text must match the file exactly and be unique. Do not edit tests.",
  ].join("\n\n");
}

const SYS_PROBE = "You write a small behavioral probe program. Output only one fenced code block.";
export function probePrompt(c: Context): string {
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.files).map(([p, s]) => `FILE ${p} (before any fix):\n${s}`),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p}:\n${s}`),
    `Write a ${c.lang} program that calls the code above on 6 to 10 concrete inputs and prints one JSON line per case: {"id":"p1","desc":"<input in words>","out":<JSON of the result>}.`,
    "Wrap each case in try/catch and print out as \"THROW:\" + message on a throw. Do not assert anything: print what the code returns.",
    "Choose inputs that separate correct from plausible-but-wrong fixes: every example the issue gives, then variants of them (surrounding whitespace, case, normalization, wrapped or nested forms, empty and boundary values), and combinations with neighbouring behavior the existing tests pin.",
    "Import the module with the same relative path the existing test uses, since the program is saved next to it.",
  ].join("\n\n");
}

// ---------- Go probe runner ----------
export const GO_PROBE_TEST = "TestLokiProbe";
export const GO_PROBE_CASES_FILE = "loki_probe_cases_test.go";
export const GO_PROBE_HELPER_FILE = "loki_probe_helper_test.go";
export const PROBE_MARK = "LOKIPROBE ";

/** Fixed text the pre-implement call appends to its rules (cache-stable). The model writes the cases only; the harness owns lokiProbe. */
export const GO_PROBE_RULES = [
  `The probe file is a second Go test file in the same package. It never asserts: it records what the code does. It holds exactly one test function, func ${GO_PROBE_TEST}(t *testing.T), whose body is 6 to 12 calls of the form`,
  '\tlokiProbe("p1", "<the input in words>", func() any { return <call the code and return what it produced> })',
  "lokiProbe is provided by the harness: never define it. Return every observable result of the call: its return values (several as []any{a, b}), an error value as it is, and any output or state the call changes (capture writers and exit hooks with the package's existing test helpers, exactly as the existing test does).",
  "Choose inputs that separate a correct fix from a plausible wrong one: each example in the report, then variants of each (surrounding whitespace, letter case, normalized versus raw spellings, wrapped or nested forms, empty and boundary values), and combinations with the behavior the existing test pins.",
  "Only call identifiers that appear in the definitions or the existing test shown below, and the standard library. No t.Skip, no os.Exit, no network, no sleeps, no subprocesses.",
].join("\n");

/** The harness-owned helper: per-case recover, canonical rendering (errors as error("msg"), JSON when it shows something, else %#v),
 *  hex addresses, the tree root and the per-run test binary path scrubbed, one LOKIPROBE line per case. The binary path leak was
 *  measured on spf13/pflag, whose panics print os.Args[0] (a fresh go-build dir every run): 58 of its 86 generic cases. */
export function goProbeHelper(pkg: string): string {
  return `package ${pkg}

// Written by the Loki harness for the candidate tournament and removed after the probe run.

import (
\t"encoding/json"
\t"fmt"
\t"os"
\t"path/filepath"
\t"regexp"
\t"strings"
)

var lokiProbeAddr = regexp.MustCompile(\`0x[0-9a-fA-F]{5,}\`)
var lokiProbeBuild = regexp.MustCompile(\`go-build[0-9]+\`)

func lokiProbe(id, desc string, f func() interface{}) {
\tout := func() (s string) {
\t\tdefer func() {
\t\t\tif r := recover(); r != nil {
\t\t\t\ts = "PANIC: " + fmt.Sprint(r)
\t\t\t}
\t\t}()
\t\treturn lokiProbeRender(f())
\t}()
\tfor _, root := range strings.Split(os.Getenv("LOKI_PROBE_ROOTS"), string(os.PathListSeparator)) {
\t\tif root != "" {
\t\t\tout = strings.ReplaceAll(out, root, "<ROOT>")
\t\t}
\t}
\tif len(os.Args) > 0 && os.Args[0] != "" {
\t\tout = strings.ReplaceAll(out, os.Args[0], "<BIN>")
\t\tout = strings.ReplaceAll(out, filepath.Dir(os.Args[0]), "<BINDIR>")
\t}
\tout = lokiProbeBuild.ReplaceAllString(out, "go-build?")
\tout = lokiProbeAddr.ReplaceAllString(out, "0x?")
\tb, _ := json.Marshal(map[string]string{"id": id, "desc": desc, "out": out})
\tfmt.Println("${PROBE_MARK}" + string(b))
}

func lokiProbeRender(v interface{}) string {
\tswitch x := v.(type) {
\tcase nil:
\t\treturn "nil"
\tcase error:
\t\treturn fmt.Sprintf("error(%q)", x.Error())
\tcase []interface{}:
\t\tparts := make([]string, len(x))
\t\tfor i, e := range x {
\t\t\tparts[i] = lokiProbeRender(e)
\t\t}
\t\treturn "[" + strings.Join(parts, ", ") + "]"
\t}
\tif b, err := json.Marshal(v); err == nil && string(b) != "{}" {
\t\treturn string(b)
\t}
\treturn fmt.Sprintf("%#v", v)
}
`;
}

const GO_PROBE_BANNED = /\bt\.Skip|\bos\.Exit\b|"net\/http"|"net"|"os\/exec"|time\.Sleep|\bfunc lokiProbe\b/;
/** The probe cases block of a reply: the ```go block holding func TestLokiProbe. Refused by name when it cannot serve as a probe.
 *  Its standard-library imports are repaired (repairGoImports): the first real reply wrote *testing.T with no import of testing. */
export function parseGoProbeCases(reply: string, pkg: string): { file: string; repairedImports: string[] } | { refused: string } {
  const block = [...reply.matchAll(/```go[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => new RegExp(`^func ${GO_PROBE_TEST}\\(t \\*testing\\.T\\)`, "m").test(b));
  if (!block) return { refused: "probe_no_block" };
  if (!block.trimStart().startsWith(`package ${pkg}`)) return { refused: `probe_wrong_package: expected package ${pkg}` };
  if (GO_PROBE_BANNED.test(block)) return { refused: "probe_banned_call" };
  if (!/\blokiProbe\(\s*"/.test(block)) return { refused: "probe_no_cases" };
  const r = repairGoImports(block);
  return { file: r.file, repairedImports: r.changes };
}

// Standard-library packages a model-written test file commonly uses, by the qualifier it writes.
const GO_STD: Record<string, string> = { testing: "testing", fmt: "fmt", errors: "errors", strings: "strings", reflect: "reflect", bytes: "bytes", io: "io", os: "os", strconv: "strconv", sort: "sort", bufio: "bufio", regexp: "regexp", unicode: "unicode", utf8: "unicode/utf8", filepath: "path/filepath", path: "path", json: "encoding/json", math: "math", slices: "slices", maps: "maps", time: "time" };
/** Make a Go file's imports match its use of the standard library: add a std package it qualifies but does not import, drop an
 *  import it never uses (both are build errors). Never touches non-std, blank, dot or aliased imports, and never the code. */
export function repairGoImports(src: string): { file: string; changes: string[] } {
  const imp = /^import\s+(?:\(\s*\n([\s\S]*?)^\)|("[^"\n]+"))[^\n]*\n?/gm;
  const specs: string[] = [];
  for (const m of src.matchAll(imp)) { if (m[1] !== undefined) specs.push(...m[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))); else specs.push(m[2]!); }
  const body = src.replace(imp, "").replace(/\/\/[^\n]*/g, "").replace(/`[^`]*`/g, '""').replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/'(?:\\.|[^'\\\n])*'/g, "''");
  const used = new Set([...body.matchAll(/(?<![\w.])([a-z][a-z0-9]*)\.[A-Za-z_]/g)].map((m) => m[1]!));
  const keep: string[] = [], changes: string[] = [];
  for (const s of specs) {
    const m = /^(?:([\w.]+)\s+)?"([^"]+)"$/.exec(s);
    if (!m) { keep.push(s); continue; }
    const alias = m[1], path = m[2]!, name = alias ?? path.split("/").pop()!;
    if (alias || !Object.values(GO_STD).includes(path) || used.has(name)) keep.push(s); else changes.push(`-${path}`);
  }
  const have = new Set(keep.map((s) => /"([^"]+)"/.exec(s)?.[1]));
  for (const q of [...used].sort()) { const p = GO_STD[q]; if (p && !have.has(p) && !new RegExp(`\\b(?:var|const|func)\\s+${q}\\b|\\b${q}\\s*:=`).test(body)) { keep.push(`"${p}"`); have.add(p); changes.push(`+${p}`); } }
  if (changes.length === 0) return { file: src, changes };
  const stripped = src.replace(imp, ""), at = /^package\s+\w+[^\n]*\n/m.exec(stripped);
  if (!at) return { file: src, changes: [] };
  const block = keep.length ? `\nimport (\n${keep.map((s) => `\t${s}`).join("\n")}\n)\n` : "";
  return { file: stripped.slice(0, at.index + at[0].length) + block + stripped.slice(at.index + at[0].length), changes };
}

export interface ProbeRunResult { built: boolean; stdout: string; error?: string; durationS: number }
/** A module whose go directive is below 1.18 rejects the predeclared any: rewrite the cases' any tokens (outside string and rune
 *  literals and comments) to interface{}. Measured on real repos: 8 of 14 non-corpus modules declare go 1.12 to 1.16. */
export function goBefore118(treeDir: string): boolean {
  try { const m = /^go\s+1\.(\d+)/m.exec(readFileSync(join(treeDir, "go.mod"), "utf8")); return !!m && Number(m[1]) < 18; } catch { return false; }
}
export function anyToInterface(src: string): string {
  return src.split(/("(?:\\.|[^"\\\n])*"|`[^`]*`|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/(?<![\w.])any(?!\w)/g, "interface{}"))).join("");
}
/** Write the helper and the cases into the package dir, run go test -run ^TestLokiProbe$ -v, remove both files. Built means the
 *  test binary started (its === RUN line printed): a case that panics, exits or hangs still leaves the cases printed before it. */
export function runGoProbe(treeDir: string, pkgRel: string, pkg: string, cases: string, timeoutMs = 60_000): ProbeRunResult {
  const dir = join(treeDir, pkgRel), helper = join(dir, GO_PROBE_HELPER_FILE), file = join(dir, GO_PROBE_CASES_FILE), t0 = Date.now();
  let real = treeDir; try { real = realpathSync(treeDir); } catch { /* keep the given path */ }
  writeFileSync(helper, goProbeHelper(pkg)); writeFileSync(file, goBefore118(treeDir) ? anyToInterface(cases) : cases);
  try {
    const env = { ...plainTestEnv(), LOKI_PROBE_ROOTS: [real, treeDir].join(process.platform === "win32" ? ";" : ":") };
    const r = spawnGroupSync("go", ["test", "-count=1", "-v", "-run", `^${GO_PROBE_TEST}$`, `-timeout=${Math.max(5, Math.ceil(timeoutMs / 1000))}s`, `./${pkgRel || "."}`], { cwd: treeDir, env, timeoutMs: timeoutMs + 15_000 });
    const out = stripAnsi(r.output), durationS = (Date.now() - t0) / 1000;
    return out.includes(`=== RUN   ${GO_PROBE_TEST}`) ? { built: true, stdout: out, durationS } : { built: false, stdout: out, error: out.slice(-1500), durationS };
  } finally { rmSync(helper, { force: true }); rmSync(file, { force: true }); }
}

/** Probe ids whose output is identical in two runs on two copies of the same tree; everything else is unstable and never compared. */
export function stableIds(a: ProbeRun, b: ProbeRun): Set<string> {
  return new Set(Object.keys(a).filter((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]));
}

// ---------- diff-directed probes ----------
// Round-2 finding: probes written from the issue and the base code share the spec writer's blind spot (same information, and in the
// merged pre-implement call the same completion): on the incomplete-site fixture neither the 9 spec cases nor the 11 probes wrapped
// a Batch, although all 3 candidates fixed that site. When check-passing trees differ in code but no probe separates them, one more
// tool-less call sees ONLY the differing functions, unlabeled, and writes inputs on which they behave differently. It never decides
// which version is right; the code-blind judge still does.
export interface GoFuncDiff { name: string; file: string; versions: string[] }
const goFuncs = (src: string): Map<string, string> => {
  const out = new Map<string, string>(), lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^func\s+(?:\(([^)]*)\)\s*)?(\w+)\s*[(\[]/.exec(lines[i]!);
    if (!m) continue;
    let j = i; while (j < lines.length && lines[j] !== "}" && !/^func .*\}\s*$/.test(lines[j]!)) j++; // gofmt: a top-level func ends at a column-0 "}"
    out.set(`${(m[1] ?? "").replace(/^\s*\w+\s+/, "").trim()}${m[1] ? "." : ""}${m[2]}`, lines.slice(i, j + 1).join("\n"));
    i = j;
  }
  return out;
};
/** Top-level Go functions whose text differs between the base-relative file sets of two or more trees (same files, same names). */
export function differingGoFuncs(trees: Record<string, string>[]): GoFuncDiff[] {
  const first = trees[0] ?? {}, out: GoFuncDiff[] = [];
  for (const file of Object.keys(first).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).sort()) {
    const maps = trees.map((t) => goFuncs(t[file] ?? ""));
    for (const name of maps[0]!.keys()) {
      const vs = [...new Set(maps.map((m) => m.get(name)).filter((v): v is string => v !== undefined))];
      if (vs.length > 1 && maps.every((m) => m.has(name))) out.push({ name, file, versions: vs });
    }
  }
  return out;
}
const SYS_DIFFPROBE = "You write probe inputs that make different versions of the same code behave differently. Output only one fenced code block.";
export function diffProbePrompt(c: Context, diffs: GoFuncDiff[], pkg: string): string {
  return [
    GO_PROBE_RULES,
    `The probe file starts with: package ${pkg}`,
    "The functions below exist in several versions. Write cases whose inputs make the versions return, print or change state differently. Do not decide which version is right and do not assert anything. Every case must compile against every version: call only exported or package-level identifiers that all versions share.",
    `ISSUE:\n${c.issue}`,
    ...diffs.map((d) => d.versions.map((v, i) => `VERSION ${i + 1} of ${d.name} (${d.file}):\n${v}`).join("\n\n")),
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p} (helpers you may reuse):\n${s}`),
  ].join("\n\n");
}

// ---------- judge ----------
export interface JudgeView { viewId: string; probeId: string; desc: string; options: { label: string; out: string }[] }
const label = (i: number): string => String.fromCharCode(65 + i);
/** Every disagreement twice: view .1 lists the options in cluster order, view .2 in reverse. All first views come before all second views. */
export function judgeViews(d: Disagreement[]): JudgeView[] {
  const view = (x: Disagreement, n: 1 | 2): JudgeView => ({ viewId: `${x.probeId}.${n}`, probeId: x.probeId, desc: x.desc, options: (n === 1 ? x.options : [...x.options].reverse()).map((o, i) => ({ label: label(i), out: o.out })) });
  return [...d.map((x) => view(x, 1)), ...d.map((x) => view(x, 2))];
}

const SYS_JUDGE = "You decide which observed behavior an issue requires. You never see code. Answer only in the requested format.";
export function judgePrompt(c: Context, views: JudgeView[], base: ProbeRun): string {
  const rows = views.map((v) => [`PROBE ${v.viewId}: ${v.desc}`, `  before the fix: ${base[v.probeId] ?? "(not run)"}`, ...v.options.map((o) => `  option ${o.label}: ${o.out}`)].join("\n"));
  return [
    `ISSUE:\n${c.issue}`,
    ...Object.entries(c.tests).map(([p, s]) => `EXISTING TEST ${p} (pins the repo's conventions):\n${s}`),
    "Several candidate fixes disagree on the probes below. For each probe, pick the option the issue and the existing tests' conventions require. Say unknown when neither the issue nor the tests decide it. Some probes appear twice with the options in another order: judge every line by the outputs, never by the letters.",
    rows.join("\n\n"),
    "Answer one line per probe: <probe id>: <option label or unknown> - <at most 12 words why>",
  ].join("\n\n");
}

export function parseVerdicts(text: string): Map<string, string> {
  const v = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]?\s*\**\s*(?:PROBE\s+)?([A-Za-z0-9_.-]+?)\s*\**\s*:\s*\**\s*(?:option\s+)?([A-Z]|unknown)\b/i.exec(line); // Haiku answered "p4: option B" in round 1
    if (m && !v.has(m[1]!)) v.set(m[1]!, m[2]!.length === 1 ? m[2]!.toUpperCase() : "unknown");
  }
  return v;
}

/** probeId -> the output BOTH views picked. Absent when either view is unknown, missing, or names a different output. */
export function resolveVerdicts(views: JudgeView[], raw: Map<string, string>): Map<string, string> {
  const pick = new Map<string, (string | null)[]>();
  for (const v of views) {
    const l = raw.get(v.viewId), out = l && l !== "unknown" ? v.options.find((o) => o.label === l)?.out ?? null : null;
    pick.set(v.probeId, [...(pick.get(v.probeId) ?? []), out]);
  }
  const res = new Map<string, string>();
  for (const [p, outs] of pick) if (outs.length >= 2 && outs.every((o) => o !== null && o === outs[0])) res.set(p, outs[0]!);
  return res;
}

export function parseCandidates(text: string): CandidateSpec[] {
  const out: CandidateSpec[] = [];
  const parts = text.split(/^=== CANDIDATE (\d+) ===\s*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const n = Number(parts[i]), body = parts[i + 1]!, edits: Edit[] = [];
    const re = /<<<<<<< SEARCH ([^\n]+)\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
    for (let m = re.exec(body); m; m = re.exec(body)) edits.push({ path: m[1]!.trim(), search: m[2]!, replace: m[3]! });
    out.push({ id: `c${n}`, lens: LENSES[n - 1] ?? `lens ${n}`, edits });
  }
  return out;
}

export function applyEdits(files: Record<string, string>, edits: Edit[]): Record<string, string> | null {
  const next = { ...files };
  for (const e of edits) {
    const src = next[e.path];
    if (src === undefined) return null;
    const at = src.indexOf(e.search);
    if (at < 0 || src.indexOf(e.search, at + 1) >= 0) return null; // missing or ambiguous
    next[e.path] = src.slice(0, at) + e.replace + src.slice(at + e.search.length);
  }
  return next;
}

export function extractProgram(text: string): string {
  const m = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  return m ? m[1]! : text;
}

/** Parse probe stdout into id -> canonical output and id -> desc. With `mark`, only lines carrying the mark count (Go: code under
 *  test may print its own JSON); without it, bare JSON lines (the JS runner). The first line of an id wins. */
export function parseProbeOutput(stdout: string, mark?: string): { run: ProbeRun; probes: Probe[] } {
  const run: ProbeRun = {}, probes: Probe[] = [];
  for (const line of stdout.split("\n")) {
    const at = mark ? line.indexOf(mark) : 0;
    if (at < 0) continue;
    const t = line.slice(at + (mark?.length ?? 0)).trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as { id?: unknown; desc?: unknown; out?: unknown };
      if (typeof o.id !== "string" || Object.prototype.hasOwnProperty.call(run, o.id)) continue;
      run[o.id] = typeof o.out === "string" ? o.out : JSON.stringify(o.out);
      probes.push({ id: o.id, desc: typeof o.desc === "string" ? o.desc : o.id });
    } catch { /* not a probe line */ }
  }
  return { run, probes };
}

export interface Entrant { id: string; lens: string; dir: string; checksPass: boolean; run: ProbeRun; diffLines: number; spec?: SpecStates | null }
export interface Disagreement { probeId: string; desc: string; options: { label: string; out: string; entrants: string[] }[] }

/** Probes on which check-passing entrants print different outputs. An entrant with no output for a probe is left out of that probe. */
export function disagreements(entrants: Entrant[], probes: Probe[]): Disagreement[] {
  const live = entrants.filter((e) => e.checksPass);
  const out: Disagreement[] = [];
  for (const p of probes) {
    const groups = new Map<string, string[]>();
    for (const e of live) { const o = e.run[p.id]; if (o === undefined) continue; groups.set(o, [...(groups.get(o) ?? []), e.id]); }
    if (groups.size < 2) continue;
    out.push({ probeId: p.id, desc: p.desc, options: [...groups.entries()].map(([o, ids], i) => ({ label: label(i), out: o, entrants: ids })) });
  }
  return out;
}

/** A spec case the agent passes and the challenger does not: the challenger is never allowed to displace the agent over it. */
export function specRegression(agent: Entrant, c: Entrant): string | null {
  if (!agent.spec || !c.spec) return null;
  for (const [n, st] of Object.entries(agent.spec)) if (st === "green" && c.spec[n] !== "green") return n;
  return null;
}

export interface Pick { winner: string; reason: string; scores: Record<string, number>; displaced: boolean }
/** anchor: the base tree's probe outputs. With it, a win counts at `margin` only on a probe where the agent's output equals the
 *  pre-fix output (the agent left that input untouched: the missed-site signature); otherwise the challenger needs margin + 1. */
export interface SelectOpts { agentId?: string; margin?: number; anchor?: ProbeRun }
/** picks: probeId -> the output the judge chose on BOTH views (resolveVerdicts).
 *  With a check-passing agent: the agent is the incumbent and is displaced only by a check-passing challenger that regresses no
 *  spec case the agent passes and, over the probes where the two differ, wins >= margin consistent verdicts and loses none.
 *  Without one (no agent, or the agent fails its checks): rank by wins minus losses, then behavior-cluster size, then smaller diff. */
export function select(entrants: Entrant[], d: Disagreement[], picks: Map<string, string>, opts: SelectOpts = {}): Pick {
  const margin = Math.max(1, opts.margin ?? 1), live = entrants.filter((e) => e.checksPass);
  const agent = opts.agentId ? entrants.find((e) => e.id === opts.agentId) : undefined;
  if (live.length === 0) return { winner: agent?.id ?? entrants[0]?.id ?? "agent", reason: "no entrant passes checks; agent tree kept", scores: {}, displaced: false };
  const cluster: Record<string, number> = {};
  for (const e of live) cluster[e.id] = 0;
  for (const x of d) for (const o of x.options) for (const id of o.entrants) cluster[id] = (cluster[id] ?? 0) + o.entrants.length;
  const versus = (a: Entrant, c: Entrant): { w: number; l: number; wa: number } => {
    let w = 0, l = 0, wa = 0;
    for (const x of d) {
      const v = picks.get(x.probeId), ao = a.run[x.probeId], co = c.run[x.probeId];
      if (v === undefined || ao === undefined || co === undefined || ao === co) continue;
      if (co === v) { w++; if (opts.anchor && opts.anchor[x.probeId] === ao) wa++; } else if (ao === v) l++;
    }
    return { w, l, wa };
  };
  const order = (xs: { e: Entrant; s: number }[]): { e: Entrant; s: number }[] => [...xs].sort((a, b) => (b.s - a.s) || (cluster[b.e.id]! - cluster[a.e.id]!) || (a.e.diffLines - b.e.diffLines) || a.e.id.localeCompare(b.e.id));
  if (agent && agent.checksPass) {
    const scores: Record<string, number> = { [agent.id]: 0 }, notes: string[] = [];
    const eligible: { e: Entrant; s: number }[] = [];
    for (const c of live) {
      if (c.id === agent.id) continue;
      const reg = specRegression(agent, c), { w, l, wa } = versus(agent, c);
      scores[c.id] = w - l;
      if (reg) { notes.push(`${c.id} regresses ${reg}`); continue; }
      if (l === 0 && (opts.anchor ? wa >= margin || w >= margin + 1 : w >= margin)) eligible.push({ e: c, s: w });
    }
    const best = order(eligible)[0], need = opts.anchor ? `${margin} anchored or ${margin + 1}` : `${margin}`;
    if (!best) return { winner: agent.id, reason: d.length === 0 ? "no behavioral disagreement" : `agent kept: no challenger wins ${need}+ consistent verdicts without a loss${notes.length ? ` (${notes.join("; ")})` : ""}`, scores, displaced: false };
    return { winner: best.e.id, reason: `${best.e.id} displaces the agent: ${best.s} consistent verdict(s), 0 against, needed ${need}`, scores, displaced: true };
  }
  const scores: Record<string, number> = {};
  for (const e of live) {
    let s = 0;
    for (const x of d) { const v = picks.get(x.probeId), o = e.run[x.probeId]; if (v === undefined || o === undefined) continue; s += o === v ? 1 : -1; }
    scores[e.id] = s;
  }
  const w = order(live.map((e) => ({ e, s: scores[e.id]! })))[0]!.e;
  return { winner: w.id, reason: `${agent ? "agent fails its checks; " : ""}ranked on ${picks.size}/${d.length} consistent verdicts`, scores, displaced: !!agent && w.id !== agent.id };
}

export interface TournamentResult { pick: Pick; entrants: Entrant[]; disagreements: Disagreement[]; verdicts: Record<string, string>; picks: Record<string, string>; usage: Usage[]; calls: number; baseRun: ProbeRun; probes: Probe[]; unstable: string[] }

const diffLines = (edits: Edit[]): number => edits.reduce((n, e) => n + e.search.split("\n").length + e.replace.split("\n").length, 0);

/** Runs the tournament. With `agent`, Io.materialize("agent") yields the agent session's finished tree, entered as the incumbent.
 *  With `program`, the probe program written earlier (by the pre-implement call) is reused and no probe call is made. `mark` is the
 *  probe output mark (Go: PROBE_MARK). */
export async function runTournament(c: Context, llm: LlmCall, io: Io, opts: { agent?: boolean; lenses?: readonly string[]; program?: string; mark?: string; margin?: number; anchored?: boolean } = {}): Promise<TournamentResult> {
  const usage: Usage[] = [];
  const [candRes, probeRes] = await Promise.all([llm(SYS_PATCH, candidatePrompt(c, opts.lenses), "candidates"), opts.program !== undefined ? Promise.resolve(null) : llm(SYS_PROBE, probePrompt(c), "probes")]); // independent: probes never see candidates
  usage.push(candRes.usage); if (probeRes) usage.push(probeRes.usage);
  const specs = parseCandidates(candRes.text), program = opts.program ?? extractProgram(probeRes!.text);
  const baseA = io.materialize([]), baseB = io.materialize([]);
  const pa = baseA ? parseProbeOutput(io.probe(baseA, program), opts.mark) : { run: {}, probes: [] };
  const pb = baseB ? parseProbeOutput(io.probe(baseB, program), opts.mark) : { run: {}, probes: [] };
  const stable = stableIds(pa.run, pb.run), unstable = Object.keys(pa.run).filter((k) => !stable.has(k));
  const keep = (r: ProbeRun): ProbeRun => Object.fromEntries(Object.entries(r).filter(([k]) => stable.has(k)));
  const entrants: Entrant[] = [];
  const enter = (id: string, lens: string, edits: Edit[] | "agent"): void => {
    if (edits !== "agent" && applyEdits(c.files, edits) === null) { entrants.push({ id, lens, dir: "", checksPass: false, run: {}, diffLines: 0 }); return; }
    const dir = io.materialize(edits);
    if (!dir) { entrants.push({ id, lens, dir: "", checksPass: false, run: {}, diffLines: 0 }); return; }
    const ok = io.checks(dir), run = ok ? keep(parseProbeOutput(io.probe(dir, program), opts.mark).run) : {};
    entrants.push({ id, lens, dir, checksPass: ok, run, diffLines: edits === "agent" ? 0 : diffLines(edits), spec: io.spec ? io.spec(dir) : null });
  };
  if (opts.agent) enter("agent", "agent session", "agent");
  for (const s of specs) enter(s.id, s.lens, s.edits);
  const probes: Probe[] = pa.probes.filter((p) => stable.has(p.id));
  const d = disagreements(entrants, probes);
  let raw = new Map<string, string>(), picks = new Map<string, string>();
  if (d.length > 0) {
    const views = judgeViews(d), j = await llm(SYS_JUDGE, judgePrompt(c, views, keep(pa.run)), "judge");
    usage.push(j.usage);
    raw = parseVerdicts(j.text); picks = resolveVerdicts(views, raw);
  }
  return { pick: select(entrants, d, picks, { ...(opts.agent ? { agentId: "agent" } : {}), ...(opts.margin ? { margin: opts.margin } : {}), ...(opts.anchored ? { anchor: keep(pa.run) } : {}) }), entrants, disagreements: d, verdicts: Object.fromEntries(raw), picks: Object.fromEntries(picks), usage, calls: usage.length, baseRun: keep(pa.run), probes, unstable };
}

export const SYSTEM_PROMPTS = { patch: SYS_PATCH, probe: SYS_PROBE, judge: SYS_JUDGE, diffProbe: SYS_DIFFPROBE } as const;

// ---------- the call path ----------
/** One tool-less Haiku turn through sdk_invoker judgeTextOutcome (messages.create: no tools, no CLI overhead) with thinking
 *  disabled. Usage is read back from the cost ledger lines this call appended (a truncation retry appends a second line). */
export function toollessCall(o: { lokiDir: string; model?: string; maxTokens?: number }): LlmCall {
  const ledger = join(o.lokiDir, "metrics", "child-sessions.jsonl");
  const lines = (): string[] => { try { return readFileSync(ledger, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; } };
  return async (system, user, tag = "tournament") => {
    const before = lines().length;
    const out = await judgeTextOutcome({ prompt: user, system, model: o.model ?? "claude-haiku-5-5", thinking: { type: "disabled" }, maxTokens: o.maxTokens ?? 8192, timeoutMs: 180_000, ledger: { lokiDir: o.lokiDir, phase: `tournament-${tag}` } });
    const usage: Usage = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    for (const l of lines().slice(before)) {
      try { const r = JSON.parse(l) as Record<string, number>; usage.inTok += r.input_tokens ?? 0; usage.outTok += r.output_tokens ?? 0; usage.cacheRead += r.cache_read_tokens ?? 0; usage.cacheWrite += r.cache_creation_tokens ?? 0; usage.costUsd += r.usd ?? 0; } catch { /* torn line */ }
    }
    return { text: out.kind === "ok" ? out.value : "", usage, outcome: describeJudgeOutcome(out) };
  };
}

/** The same tool-less turn through the Agent SDK query() (the claude CLI's own login), for a machine whose subscription token is
 *  refused on direct messages.create (measured here: HTTP 429 rate_limit_error while count_tokens works). One turn, no tools, no
 *  setting sources, no MCP, a plain system string that replaces the claude_code preset, thinking disabled. The outcome names the
 *  thinking blocks seen, so "thinking off" is measured, not assumed. TODO(PR0): replace both with the shared primitive. */
export function agentSdkToollessCall(o: { cwd: string; model?: string }): LlmCall {
  return async (system, user) => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const env: Record<string, string> = {}; // options.env replaces the child env: keep PATH/HOME, drop this session's bridge ids
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !/^CLAUDE_CODE_(SESSION_ID|MESSAGING_|BRIDGE_|CHILD_SESSION)/.test(k)) env[k] = v;
    let text = "", thinking = 0, res: Record<string, unknown> | null = null;
    // title: without one the SDK makes an extra model request to name the session (PR0 found it; the SDK docs say it auto-generates)
    for await (const m of query({ prompt: user, options: { model: o.model ?? "claude-haiku-5-5", cwd: o.cwd, tools: [], maxTurns: 1, systemPrompt: system, settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, title: "loki-tournament", thinking: { type: "disabled" }, env } })) {
      const msg = m as { type: string; message?: { content?: { type: string; text?: string }[] } };
      if (msg.type === "assistant") for (const b of msg.message?.content ?? []) { if (b.type === "thinking" || b.type === "redacted_thinking") thinking++; else if (b.type === "text") text += b.text ?? ""; }
      if (msg.type === "result") res = m as unknown as Record<string, unknown>;
    }
    const u = (res?.["usage"] ?? {}) as Record<string, number>;
    const usage: Usage = { inTok: u["input_tokens"] ?? 0, outTok: u["output_tokens"] ?? 0, cacheRead: u["cache_read_input_tokens"] ?? 0, cacheWrite: u["cache_creation_input_tokens"] ?? 0, costUsd: typeof res?.["total_cost_usd"] === "number" ? (res["total_cost_usd"] as number) : 0 };
    const final = res?.["subtype"] === "success" && typeof res["result"] === "string" ? (res["result"] as string) : text;
    const mu = (res?.["modelUsage"] ?? {}) as Record<string, Record<string, number>>; // every model request the session made, by model
    const models = Object.entries(mu).map(([k, v]) => `${k}:in=${v["inputTokens"] ?? 0},out=${v["outputTokens"] ?? 0},thinking=${v["thinkingTokens"] ?? "n/a"},usd=${v["costUSD"] ?? "n/a"}`).join("|");
    return { text: final, usage, outcome: `${String(res?.["subtype"] ?? "no-result")}; thinking_blocks=${thinking}; turns=${String(res?.["num_turns"] ?? "?")}; models=${models}` };
  };
}
