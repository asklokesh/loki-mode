// Go candidate tournament (default on; LOKI_E10_TOURNAMENT=0 opts out; inert unless the exec-spec call left a probe program). New file because features/attempts.ts owns k FULL agent sessions
// scored by pass counts over the shared set; this module owns a different mechanism: patch-only candidates from ONE tool-less call,
// behavioral probes the exec-spec call wrote from the issue and the base code alone, and a code-blind judge that rules only on the
// concrete inputs where check-passing trees disagree. The repo's checks (plus the sealed exec spec) still gate every tree and
// verify and Seal still run on whatever tree is left: the tournament never weakens a verdict, it only chooses between trees that
// already pass. Fires on a lean, done run with a small, check-passing diff (see runTournamentGate).
//   - Go probe runner: the harness writes a fixed helper _test.go (lokiProbe: recover, canonical rendering, address and tree-path
//     scrub, one "LOKIPROBE {json}" line per case); the model writes only the cases inside TestLokiProbe.
//   - Stability guard: the probe runs on two base copies; a case whose output differs between them is dropped.
//   - Order-swap judge: every disagreement is shown twice with the options reversed; a verdict counts only when both views agree.
//   - Incumbent-safe selection: the agent's check-passing tree is displaced only by a challenger that regresses no spec case the
//     agent passes, wins at least `margin` anchored (or margin + 1) consistent verdicts and loses none.
//   - Calls go through sdk_invoker toolLessCall (no tools, thinking off, priced into the run ledger and the dollar cap).
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { plainTestEnv, spawnGroupSync, stripAnsi } from "../util/check_result.ts";
import { toolLessCall } from "../runner/sdk_invoker.ts";
import { safeGit } from "../util/safe_git.ts";
import { editShapeSites, type EditSite } from "../util/edit_shape.ts";
import { applyDiff, snapshotDiff } from "../e10ext/treeswap.ts";
import { ATTEMPT_EXCLUDES, treeswapOps, type ExtraAttemptsDeps } from "./attempts.ts";
import { parseStaged } from "../e10ext/commit_filter.ts";
import { testFileWeakened } from "../util/test_guard.ts";
import { EMITTERS, execSpecBriefOf, extractSpecAtoms, redFilter } from "./exec_spec.ts";
import { isTestFile } from "../engine10/testmap.ts";
import { installOwned } from "../project_model/install.ts";
import type { AttemptCheck } from "../e10ext/select.ts";
import type { RunContext, SessionResult } from "../engine10/types.ts";

export const tournamentEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_TOURNAMENT !== "0"; // default on (incumbent-safe: a check-passing agent tree is never displaced without the anchored margin); =0 opts out
export const TOURNAMENT_INPUT_FILE = "tournament-input.json"; // <runDir>/, written by wall.ts's exec-spec branch, read by the gate
const posInt = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
export const tournamentMaxLines = (env: NodeJS.ProcessEnv = process.env): number => posInt(env.LOKI_E10_TOURNAMENT_MAX_LINES, 60);
export const tournamentMargin = (env: NodeJS.ProcessEnv = process.env): number => posInt(env.LOKI_E10_TOURNAMENT_MARGIN, 1);
export const tournamentModel = (env: NodeJS.ProcessEnv = process.env): string => env.LOKI_E10_TOURNAMENT_MODEL || "claude-haiku-5-5";

export interface Usage { costUsd: number }
/** One tool-less single-turn completion. `tag` names the call (candidates, diffprobe, judge) for the ledger phase and for stubs. */
export interface LlmCall { (system: string, user: string, tag: string): Promise<{ text: string; usage: Usage; outcome?: string }> }
export interface Edit { path: string; search: string; replace: string }
export interface CandidateSpec { id: string; lens: string; edits: Edit[] }
export interface ProbeRun { [probeId: string]: string }
export interface Probe { id: string; desc: string }
export type SpecStates = Record<string, "red" | "green" | "error">;
export interface Io {
  /** A scratch tree (the base plus these edits, "agent" = the agent's finished tree, "base" = the untouched base); null when an edit does not apply or no tree is free. */
  materialize(edits: Edit[] | "agent" | "base"): string | null;
  /** The repo's own checks (plus the sealed exec spec) in that tree: true when all pass. */
  checks(dir: string): Promise<boolean>;
  /** Writes the probe program into dir, runs it, returns its stdout (parsed with parseProbeOutput). */
  probe(dir: string, program: string): string;
  /** Per-case states of the full executable spec (binding and advisory) in that tree, or null when there is none. */
  spec?(dir: string): SpecStates | null;
}
export interface Context { issue: string; files: Record<string, string>; tests: Record<string, string>; /** what the harness told the implementer (spec brief) */ brief?: string }

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

// ---------- Go probe runner ----------
export const GO_PROBE_TEST = "TestLokiProbe";
export const GO_PROBE_CASES_FILE = "loki_probe_cases_test.go";
export const GO_PROBE_HELPER_FILE = "loki_probe_helper_test.go";
export const PROBE_MARK = "LOKIPROBE ";

/** The probe file format both the exec-spec call and the no-regression post-implement call ask for (lokiProbe is harness-owned). */
export const GO_PROBE_FORMAT = [
  `The probe file is a second Go test file in the same package (same package clause). It holds exactly one test function, func ${GO_PROBE_TEST}(t *testing.T), whose body is 6 to 12 calls of the form`,
  '\tlokiProbe("p1", "<the input in words>", func() any { return <call the code and return what it produced> })',
  "lokiProbe is provided by the harness: never define it. Return every observable result of the call: its return values (several as []any{a, b}), an error value as it is, and any output or state the call changes (capture writers and exit hooks with the package's existing test helpers, exactly as the existing test does).",
  "Choose inputs that separate a correct fix from a plausible wrong one: each example in the report, then variants of each (surrounding whitespace, letter case, normalized versus raw spellings, wrapped or nested forms, empty and boundary values), and combinations with the behavior the existing test pins.",
  "Only call identifiers that appear in the definitions or the existing test shown below, and the standard library. No t.Skip, no os.Exit, no network, no sleeps, no subprocesses.",
].join("\n");
/** Fixed text the exec-spec call appends to its rules when the tournament is on (cache-stable). The model writes the cases only; the harness owns lokiProbe. */
export const GO_PROBE_RULES = [
  "ONE EXCEPTION to the single-block rule: after the spec file, reply with a second ```go fenced block, a probe file. It is never run as a check and never asserts: it records what the code does.",
  GO_PROBE_FORMAT,
].join("\n");

/** The harness-owned helper: per-case recover, canonical rendering (errors as error("msg"), JSON when it shows something, else %#v),
 *  hex addresses, the tree root and the per-run test binary path scrubbed, one LOKIPROBE line per case. */
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
const PROBE_BLOCK = new RegExp(`\`\`\`go[^\\n]*\\n([\\s\\S]*?)\`\`\``, "g");
const isProbeBlock = (b: string): boolean => new RegExp(`^func ${GO_PROBE_TEST}\\(t \\*testing\\.T\\)`, "m").test(b);
/** A reply split in two: the reply without its probe block (what the exec-spec parser reads) and the probe block text (null when absent). */
export function splitProbeBlock(reply: string): { spec: string; probe: string | null } {
  let probe: string | null = null;
  const spec = reply.replace(PROBE_BLOCK, (all, body: string) => (probe === null && isProbeBlock(body) ? ((probe = body), "") : all));
  return { spec, probe };
}
/** The probe cases block, refused by name when it cannot serve as a probe. Its standard-library imports are repaired (repairGoImports). */
export function parseGoProbeCases(block: string | null, pkg: string): { file: string; repairedImports: string[] } | { refused: string } {
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

export interface ProbeRunResult { built: boolean; stdout: string; error?: string; durationS: number; pruned: { id: string; error: string }[] }
/** A module whose go directive is below 1.18 rejects the predeclared any: rewrite the cases' any tokens (outside string and rune literals and comments) to interface{}. */
export function goBefore118(treeDir: string): boolean {
  try { const m = /^go\s+1\.(\d+)/m.exec(readFileSync(join(treeDir, "go.mod"), "utf8")); return !!m && Number(m[1]) < 18; } catch { return false; }
}
export function anyToInterface(src: string): string {
  return src.split(/("(?:\\.|[^"\\\n])*"|`[^`]*`|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/(?<![\w.])any(?!\w)/g, "interface{}"))).join("");
}
const CASE_START = /^\s*lokiProbe\(\s*"([^"]+)"/;
/** Line ranges (0-based, inclusive) of each lokiProbe statement of the cases file. */
export function goCaseBlocks(program: string): { id: string; start: number; end: number }[] {
  const lines = program.split("\n"), starts: { id: string; line: number }[] = [];
  lines.forEach((l, i) => { const m = CASE_START.exec(l); if (m) starts.push({ id: m[1]!, line: i }); });
  if (starts.length === 0) return [];
  let close = lines.length;
  for (let i = starts[starts.length - 1]!.line + 1; i < lines.length; i++) if (/^\}\s*$/.test(lines[i]!)) { close = i; break; }
  return starts.map((x, k) => ({ id: x.id, start: x.line, end: (k + 1 < starts.length ? starts[k + 1]!.line : close) - 1 }));
}
const CASE_ERR = new RegExp(`${GO_PROBE_CASES_FILE.replace(/\./g, "\\.")}:(\\d+):\\d+: (.+)$`, "gm");
/** One deterministic repair pass over a cases file that does not compile in a tree: drop unused imports, drop the cases holding the
 *  other error lines. Null when an error sits outside every case (nothing safe to drop). A case that does not compile in one tree
 *  is simply absent from that tree's output, so it is never compared. */
export function pruneGoCases(program: string, output: string): { program: string; pruned: { id: string; error: string }[] } | null {
  const errs = [...output.matchAll(CASE_ERR)].map((m) => ({ line: Number(m[1]) - 1, msg: m[2]!.trim() }));
  if (errs.length === 0) return null;
  const lines = program.split("\n"), drop = new Set<number>(), pruned: { id: string; error: string }[] = [], blocks = goCaseBlocks(program);
  for (const e of errs) {
    if (/^"[^"]+" imported and not used/.test(e.msg)) { drop.add(e.line); continue; }
    const b = blocks.find((x) => e.line >= x.start && e.line <= x.end);
    if (!b) return null;
    if (!pruned.some((q) => q.id === b.id)) pruned.push({ id: b.id, error: e.msg });
    for (let i = b.start; i <= b.end; i++) drop.add(i);
  }
  return { program: lines.filter((_, i) => !drop.has(i)).join("\n"), pruned };
}
/** Write the helper and the cases into the package dir, run go test -run ^TestLokiProbe$ -v, remove both files. Built means the
 *  test binary started (its === RUN line printed): a case that panics, exits or hangs still leaves the cases printed before it.
 *  Cases that do not compile in this tree are pruned and the run repeated, at most 3 passes. */
export function runGoProbe(treeDir: string, pkgRel: string, pkg: string, cases: string, timeoutMs = 60_000): ProbeRunResult {
  const dir = join(treeDir, pkgRel), helper = join(dir, GO_PROBE_HELPER_FILE), file = join(dir, GO_PROBE_CASES_FILE), t0 = Date.now();
  let real = treeDir; try { real = realpathSync(treeDir); } catch { /* keep the given path */ }
  let program = goBefore118(treeDir) ? anyToInterface(cases) : cases;
  const pruned: { id: string; error: string }[] = [];
  writeFileSync(helper, goProbeHelper(pkg));
  try {
    const env = { ...plainTestEnv(), LOKI_PROBE_ROOTS: [real, treeDir].join(process.platform === "win32" ? ";" : ":") };
    for (let pass = 0; ; pass++) {
      writeFileSync(file, program);
      const r = spawnGroupSync("go", ["test", "-count=1", "-vet=off", "-gcflags=-e", "-v", "-run", `^${GO_PROBE_TEST}$`, `-timeout=${Math.max(5, Math.ceil(timeoutMs / 1000))}s`, `./${pkgRel || "."}`], { cwd: treeDir, env, timeoutMs: timeoutMs + 15_000 });
      const out = stripAnsi(r.output), durationS = (Date.now() - t0) / 1000;
      if (out.includes(`=== RUN   ${GO_PROBE_TEST}`)) return { built: true, stdout: out, durationS, pruned };
      const fix = pass < 3 ? pruneGoCases(program, out) : null;
      if (!fix) return { built: false, stdout: out, error: out.slice(-1500), durationS, pruned };
      program = fix.program; pruned.push(...fix.pruned);
    }
  } finally { rmSync(helper, { force: true }); rmSync(file, { force: true }); }
}

/** Probe ids whose output is identical in two runs on two copies of the same tree; everything else is unstable and never compared. */
export function stableIds(a: ProbeRun, b: ProbeRun): Set<string> {
  return new Set(Object.keys(a).filter((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]));
}

// ---------- diff-directed probes ----------
// Probes written from the issue and the base code share the spec writer's blind spot (same information, same completion). When
// check-passing trees differ in code but no probe separates them, one more tool-less call sees ONLY the differing functions,
// unlabeled, and writes inputs on which they behave differently. It never decides which version is right; the code-blind judge does.
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
/** Top-level Go functions whose text differs between the file sets of two or more trees (same files, same names). */
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
    GO_PROBE_RULES.split("\n").slice(1).join("\n"), // the cases-only rules; the exec-spec exception line does not apply here
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
    const m = /^\s*[-*]?\s*\**\s*(?:PROBE\s+)?([A-Za-z0-9_.-]+?)\s*\**\s*:\s*\**\s*(?:option\s+)?([A-Z]|unknown)\b/i.exec(line); // Haiku answered "p4: option B"
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

/** Parse probe stdout into id -> canonical output and the probe list. Only lines carrying the mark count (code under test may print its own JSON). The first line of an id wins. */
export function parseProbeOutput(stdout: string): { run: ProbeRun; probes: Probe[] } {
  const run: ProbeRun = {}, probes: Probe[] = [];
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(PROBE_MARK);
    if (at < 0) continue;
    const t = line.slice(at + PROBE_MARK.length).trim();
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
/** anchor: the base tree's probe outputs. A win counts at `margin` only on a probe where the agent's output equals the pre-fix output
 *  (the agent left that input untouched: the missed-site signature); otherwise the challenger needs margin + 1.
 *  picks: probeId -> the output the judge chose on BOTH views (resolveVerdicts). The agent entrant ("agent") is the incumbent and
 *  is displaced only by a check-passing challenger that regresses no spec case the agent passes and, over the probes where the two
 *  differ, wins >= margin consistent verdicts, at least one of them on an input the issue names, and loses none. Unknown, inconsistent, missing and tied verdicts keep the agent;
 *  cluster size and diff size only order challengers among themselves. */
export interface SelectOpts { margin?: number; anchor?: ProbeRun; /** probes whose input the issue itself names; with it, a displacement needs a win on one of them */ named?: Set<string> }
export function select(entrants: Entrant[], d: Disagreement[], picks: Map<string, string>, opts: SelectOpts = {}): Pick {
  const margin = Math.max(1, opts.margin ?? 1), live = entrants.filter((e) => e.checksPass), agent = entrants.find((e) => e.id === "agent");
  if (!agent || !agent.checksPass) return { winner: "agent", reason: "agent tree does not pass its checks; kept", scores: {}, displaced: false };
  const cluster: Record<string, number> = {};
  for (const e of live) cluster[e.id] = 0;
  for (const x of d) for (const o of x.options) for (const id of o.entrants) cluster[id] = (cluster[id] ?? 0) + o.entrants.length;
  const versus = (c: Entrant): { w: number; l: number; wa: number; wn: number } => {
    let w = 0, l = 0, wa = 0, wn = 0;
    for (const x of d) {
      const v = picks.get(x.probeId), ao = agent.run[x.probeId], co = c.run[x.probeId];
      if (v === undefined || ao === undefined || co === undefined || ao === co) continue;
      if (co === v) { w++; const nm = !opts.named || opts.named.has(x.probeId); if (nm) wn++; if (nm && opts.anchor && opts.anchor[x.probeId] === ao) wa++; } else if (ao === v) l++;
    }
    return { w, l, wa, wn };
  };
  const scores: Record<string, number> = { agent: 0 }, notes: string[] = [], eligible: { e: Entrant; s: number }[] = [];
  for (const c of live) {
    if (c.id === "agent") continue;
    const reg = specRegression(agent, c), { w, l, wa, wn } = versus(c);
    scores[c.id] = w - l;
    if (reg) { notes.push(`${c.id} regresses ${reg}`); continue; }
    if (l === 0 && wn >= 1 && (opts.anchor ? wa >= margin || w >= margin + 1 : w >= margin)) eligible.push({ e: c, s: w });
  }
  const best = [...eligible].sort((a, b) => (b.s - a.s) || (cluster[b.e.id]! - cluster[a.e.id]!) || (a.e.diffLines - b.e.diffLines) || a.e.id.localeCompare(b.e.id))[0];
  const need = opts.anchor ? `${margin} anchored or ${margin + 1}` : `${margin}`;
  if (!best) return { winner: "agent", reason: d.length === 0 ? "no behavioral disagreement" : `agent kept: no challenger wins ${need}+ consistent verdicts (one on an input the issue names) without a loss${notes.length ? ` (${notes.join("; ")})` : ""}`, scores, displaced: false };
  return { winner: best.e.id, reason: `${best.e.id} displaces the agent: ${best.s} consistent verdict(s), 0 against, needed ${need}`, scores, displaced: true };
}

export interface TournamentResult { pick: Pick; entrants: Entrant[]; disagreements: Disagreement[]; picks: Record<string, string>; usd: number; calls: number; unstable: string[]; diffProbe?: { funcs: string[]; cases: number; refused?: string }; candidates: { id: string; applied: boolean }[]; named: string[] }

const diffLinesOf = (edits: Edit[]): number => edits.reduce((n, e) => n + e.search.split("\n").length + e.replace.split("\n").length, 0);

const goUnescape = (s: string): string => s.replace(/\\(["\\tnr])/g, (_m, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c));
/** Probes whose WHOLE input the issue itself names: every string literal of the case's input (after its id and description) that is
 *  two or more characters long (all literals when none is) must be quoted verbatim, in quotes or backticks, in the issue. One quoted
 *  literal beside an invented one is not enough; a one-character operand is incidental. A displacement needs a win on such a probe. */
export function namedProbes(issue: string, program: string, prefix = ""): Set<string> {
  const out = new Set<string>(), lines = program.split("\n");
  for (const b of goCaseBlocks(program)) {
    const lits = [...lines.slice(b.start, b.end + 1).join("\n").matchAll(/"((?:\\.|[^"\\\n])*)"/g)].map((m) => goUnescape(m[1]!)).slice(2).filter((l) => l.length > 0);
    const long = lits.filter((l) => l.length >= 2), need = long.length ? long : lits;
    if (need.length > 0 && need.every((l) => issue.includes(`"${l}"`) || issue.includes(`\`${l}\``))) out.add(`${prefix}${b.id}`);
  }
  return out;
}

/** Runs the tournament over a probe program written earlier (the exec-spec call). Io.materialize("agent") yields the agent session's
 *  finished tree, entered as the incumbent. The agent is evaluated first: when it fails its checks nothing can change and no model
 *  call is made. `treeFiles(dir)` reads the base-relative Go sources of a tree for the diff-directed probe; `tick` throws when the
 *  run's time budget is spent. */
export async function runTournament(c: Context, llm: LlmCall, io: Io, o: { program: string; pkg: string; treeFiles: (dir: string) => Record<string, string>; margin?: number; tick?: () => void }): Promise<TournamentResult> {
  let usd = 0, calls = 0;
  const tick = o.tick ?? ((): void => {});
  const call = async (sys: string, user: string, tag: string): Promise<string> => { tick(); const r = await llm(sys, user, tag); usd += r.usage.costUsd; calls++; return r.text; };
  const probeIn = (dir: string, program: string): { run: ProbeRun; probes: Probe[] } => { tick(); return parseProbeOutput(io.probe(dir, program)); };
  const baseA = io.materialize("base"), baseB = io.materialize("base");
  const pa = baseA ? probeIn(baseA, o.program) : { run: {}, probes: [] }, pb = baseB ? probeIn(baseB, o.program) : { run: {}, probes: [] };
  const stable = stableIds(pa.run, pb.run), unstable = Object.keys(pa.run).filter((k) => !stable.has(k));
  const keep = (r: ProbeRun): ProbeRun => Object.fromEntries(Object.entries(r).filter(([k]) => stable.has(k)));
  const entrants: Entrant[] = [], candidates: { id: string; applied: boolean }[] = [];
  const enter = async (id: string, lens: string, edits: Edit[] | "agent"): Promise<void> => {
    tick();
    const dir = io.materialize(edits);
    if (edits !== "agent") candidates.push({ id, applied: dir !== null });
    if (!dir) { entrants.push({ id, lens, dir: "", checksPass: false, run: {}, diffLines: 0 }); return; }
    const ok = await io.checks(dir);
    entrants.push({ id, lens, dir, checksPass: ok, run: ok ? keep(probeIn(dir, o.program).run) : {}, diffLines: edits === "agent" ? 0 : diffLinesOf(edits), spec: ok && io.spec ? io.spec(dir) : null });
  };
  const done = (pick: Pick, d: Disagreement[], picks: Map<string, string>, named: Set<string>, diffProbe?: TournamentResult["diffProbe"]): TournamentResult => ({ pick, entrants, disagreements: d, picks: Object.fromEntries(picks), usd, calls, unstable, candidates, named: [...named], ...(diffProbe ? { diffProbe } : {}) });
  await enter("agent", "agent session", "agent");
  const agent = entrants[0]!;
  if (!agent.checksPass) return done(select(entrants, [], new Map()), [], new Map(), new Set()); // nothing can change: no candidates call, no judge
  const named = namedProbes(c.issue, o.program);
  if (named.size === 0) return done({ winner: "agent", reason: "no probe case uses an input the issue quotes, so no verdict could displace the agent: no candidates call", scores: {}, displaced: false }, [], new Map(), named); // only a diff-probe case could then differ, and it needs candidates
  const specs = parseCandidates(await call(SYS_PATCH, candidatePrompt(c), "candidates")).slice(0, LENSES.length);
  for (const s of specs) await enter(s.id, s.lens, s.edits);
  const probes: Probe[] = pa.probes.filter((p) => stable.has(p.id)), base = keep(pa.run);
  const live = entrants.filter((e) => e.checksPass);
  // only probes where a challenger differs from the agent can decide anything (challengers disagreeing among themselves cannot)
  const vsAgent = (xs: Disagreement[]): Disagreement[] => xs.filter((x) => x.options.length > 1 && x.options.some((q) => q.entrants.includes("agent")));
  let diffProbe: TournamentResult["diffProbe"];
  if (live.length > 1 && baseA && baseB && vsAgent(disagreements(entrants, probes)).length === 0) { // the issue-derived probes separate nothing: ask for inputs on the code that differs
    const funcs = differingGoFuncs(live.map((e) => o.treeFiles(e.dir)));
    if (funcs.length > 0) {
      const dc = parseGoProbeCases(extractGoBlock(await call(SYS_DIFFPROBE, diffProbePrompt(c, funcs, o.pkg), "diffprobe")), o.pkg);
      diffProbe = { funcs: funcs.map((f) => `${f.file}:${f.name} x${f.versions.length}`), cases: 0, ...("refused" in dc ? { refused: dc.refused } : {}) };
      if ("file" in dc) {
        const tag = (r: ProbeRun): ProbeRun => Object.fromEntries(Object.entries(r).map(([k, v]) => [`d${k}`, v]));
        const da = probeIn(baseA, dc.file), db = tag(probeIn(baseB, dc.file).run), dra = tag(da.run), ds = stableIds(dra, db);
        diffProbe.cases = ds.size;
        for (const n of namedProbes(c.issue, dc.file, "d")) named.add(n);
        for (const p of da.probes) if (ds.has(`d${p.id}`)) { probes.push({ id: `d${p.id}`, desc: p.desc }); base[`d${p.id}`] = dra[`d${p.id}`]!; }
        for (const e of live) for (const [k, v] of Object.entries(tag(probeIn(e.dir, dc.file).run))) if (ds.has(k)) e.run[k] = v;
      }
    }
  }
  const d = vsAgent(disagreements(entrants, probes));
  let picks = new Map<string, string>();
  if (d.some((x) => named.has(x.probeId))) { const views = judgeViews(d); // no named disagreement: no verdict can displace, so no judge call
    picks = resolveVerdicts(views, parseVerdicts(await call(SYS_JUDGE, judgePrompt(c, views, base), "judge"))); }
  return done(select(entrants, d, picks, { ...(o.margin ? { margin: o.margin } : {}), anchor: base, named }), d, picks, named, diffProbe);
}
const extractGoBlock = (text: string): string | null => /```go[^\n]*\n([\s\S]*?)```/.exec(text)?.[1] ?? null;

// ---------- the call path ----------
/** One tool-less Haiku turn through the shared primitive (sdk_invoker toolLessCall: thinking off, ledgered, run-cap aware). A refused,
 *  truncated, over-budget or failed call returns an empty text and the outcome name; callers treat empty text as "no answer". */
export function toolLessLlm(model = tournamentModel(), env: NodeJS.ProcessEnv = process.env): LlmCall {
  return async (system, user, tag) => {
    const lokiDir = env.LOKI_DIR, maxTokens = tag === "judge" ? 2048 : 8192;
    const r = await toolLessCall({ model, system, prompt: user, maxTokens, thinking: "off", timeoutMs: 180_000, ...(lokiDir ? { ledger: { lokiDir, phase: `tournament-${tag}` } } : {}) });
    return { text: r.outcome.kind === "ok" ? r.outcome.value : "", usage: { costUsd: r.usd ?? 0 }, outcome: r.outcome.kind };
  };
}

// ---------- exec-spec intake: the probe rides on the exec-spec call ----------
/** wall.ts hands this to execSpecAuthor when the tournament is on: the rules appended to its generator brief (Go only) and the reply
 *  splitter. take() returns the reply without its probe block (what the spec parser reads) and the repaired probe file or a named refusal. */
export const probeIntake = {
  rules: GO_PROBE_RULES,
  take(reply: string, pkg: string): { reply: string; probe?: string; refused?: string } {
    const s = splitProbeBlock(reply), p = parseGoProbeCases(s.probe, pkg);
    return { reply: s.spec, ...("file" in p ? { probe: p.file } : { refused: p.refused }) };
  },
};
export type ProbeIntake = typeof probeIntake;

// ---------- the gate: wiring into the implement stage ----------
export interface TournamentInput { program: string; spec?: string; targetRel?: string; pkg: string; pkgRel: string; /** named sites no binding spec case covers */ unchecked?: string[]; /** why no probe program exists: the gate reports it on the receipt */ skip?: string }
/** wall.ts calls this from its exec-spec branch with the outcome: the probe cases and the full generated spec file, kept for the gate. No probe, no file. */
export function writeTournamentInput(runDir: string, o: { probe?: string; probeSkip?: string; pkg?: string; specFile?: string; targetRel?: string; unchecked?: string[] }): void {
  if (!o.probe && o.probeSkip) { try { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, TOURNAMENT_INPUT_FILE), JSON.stringify({ program: "", pkg: o.pkg ?? "", pkgRel: "", skip: o.probeSkip } satisfies TournamentInput), "utf8"); } catch { /* best effort */ } return; }
  if (!o.probe || !o.pkg) return;
  const i: TournamentInput = { program: o.probe, pkg: o.pkg, pkgRel: o.targetRel && dirname(o.targetRel) !== "." ? dirname(o.targetRel) : "", ...(o.specFile && o.targetRel ? { spec: o.specFile, targetRel: o.targetRel } : {}), ...(o.unchecked?.length ? { unchecked: o.unchecked } : {}) };
  try { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, TOURNAMENT_INPUT_FILE), JSON.stringify(i), "utf8"); } catch { /* best effort: without it the gate skips */ }
}
export const readTournamentInput = (runDir: string): TournamentInput | null => { try { const i = JSON.parse(readFileSync(join(runDir, TOURNAMENT_INPUT_FILE), "utf8")) as TournamentInput; return typeof i.program === "string" && typeof i.pkg === "string" ? i : null; } catch { return null; } };

export const baseText = (ctx: RunContext, p: string): string => { try { return safeGit(ctx.repoDir, ["show", `${ctx.baseSha}:${p}`]); } catch { return ""; } };
const FILE_CAP = 24_000, TOTAL_CAP = 60_000;
/** Changed lines of the agent tree against base (tracked numstat plus untracked files), excluding the run's own sealed files. */
function agentDiffLines(ctx: RunContext, skip: Set<string>): { lines: number; goFiles: string[] } {
  const ex = ATTEMPT_EXCLUDES.map((e) => `:(exclude)${e}`);
  let lines = 0; const files = new Set<string>();
  for (const row of safeGit(ctx.repoDir, ["diff", "--numstat", "--no-renames", ctx.baseSha, "--", ".", ...ex]).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row); if (!m || skip.has(m[3]!)) continue;
    lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2])); files.add(m[3]!);
  }
  for (const p of safeGit(ctx.repoDir, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...ex]).split("\0")) {
    if (!p || skip.has(p)) continue;
    files.add(p); try { lines += readFileSync(join(ctx.repoDir, p), "utf8").split("\n").length; } catch { lines += 1; }
  }
  return { lines, goFiles: [...files].filter((f) => f.endsWith(".go") && !isTestFile(f)) };
}

/** The cheap warning signs that the agent tree may have missed part of the task; the candidates call fires only when one is present
 *  (target: a minority of runs). A named site no binding spec case covers; an issue-quoted line that is still byte-identical in the
 *  agent's changed files; a residual site from the edit-shape detector (util/edit_shape.ts: an unchanged line still holds the pattern the diff removed). */
export function warningSigns(task: string, unchecked: string[] | undefined, sources: Record<string, string>, residual: EditSite[] = []): string[] {
  const signs: string[] = [];
  const r = residual.find((x) => x.rule === "residual");
  if (r) signs.push(`residual site (edit-shape): ${r.path}:${r.line}`);
  if (unchecked?.length) signs.push(`named site without a binding spec case: ${unchecked.slice(0, 3).join(", ")}`);
  const all = Object.values(sources).join("\n");
  for (const a of extractSpecAtoms(task)) if (a.kind === "location" && a.text.trim().length >= 12 && all.includes(a.text.trim())) { signs.push(`quoted line unchanged: ${a.text.trim().split("\n")[0]!.slice(0, 50)}`); break; }
  return signs;
}

export interface TournamentSummary { status: "skipped" | "kept" | "displaced" | "error"; reason: string; receipt?: string[]; [k: string]: unknown }
const skipped = (reason: string, extra: Record<string, unknown> = {}): TournamentSummary => ({ status: "skipped", reason, ...extra });

// ---------- applying the winner: only its own source edits reach the user's tree ----------
export const TOURNAMENT_UNDO_FILE = "tournament-undo.json"; // <runDir>/: the primary's own bytes of every path about to be overwritten
/** Writes `writes` into the primary. The primary's current bytes of those paths are persisted to <runDir>/tournament-undo.json BEFORE the
 *  first write, so a kill mid-way is recoverable (recoverTournamentUndo runs at the next gate start); the record is removed once every
 *  write landed. Nothing but these paths is touched: the agent's tests, go.mod and non-Go files stay as they are. */
export function applyWinnerFiles(repo: string, runDir: string, writes: { path: string; content: string }[], afterEach?: (i: number) => void): void {
  const undo = writes.map((w) => { const f = join(repo, w.path); return { path: w.path, b64: existsSync(f) ? readFileSync(f).toString("base64") : null }; });
  mkdirSync(runDir, { recursive: true });
  const rec = join(runDir, TOURNAMENT_UNDO_FILE), tmp = `${rec}.tmp`;
  writeFileSync(tmp, JSON.stringify(undo), "utf8"); renameSync(tmp, rec);
  writes.forEach((w, i) => { const f = join(repo, w.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, w.content); afterEach?.(i); });
  rmSync(rec, { force: true });
}
/** Puts the primary's own bytes back from a record a killed or failed apply left. Returns the paths restored (empty when there is no record). */
export function recoverTournamentUndo(repo: string, runDir: string): string[] { // implement.ts calls this at stage start, before any session
  const rec = join(runDir, TOURNAMENT_UNDO_FILE);
  if (!existsSync(rec)) return [];
  const undo = JSON.parse(readFileSync(rec, "utf8")) as { path: string; b64: string | null }[], out: string[] = [];
  for (const u of undo) { const f = join(repo, u.path); if (u.b64 === null) rmSync(f, { force: true }); else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.from(u.b64, "base64")); } out.push(u.path); }
  rmSync(rec, { force: true });
  return out;
}

/** The implement-stage gate (default on, LOKI_E10_TOURNAMENT=0 opts out, lean path only: the caller passes none when a plan ran). Fires only
 *  when the session finished clean (LOKI_DONE, no conflict, no already-done claim), the exec-spec call left a probe program, the diff is
 *  small, a warning sign says the agent may have missed part of the task, and the agent tree passes its checks. Every tree (the agent's copy
 *  and the candidates, each the agent's tree plus the candidate's edits to the agent-changed non-test Go files) lives in a scratch worktree
 *  (treeswap); probes and checks run only there. The user's tree is touched only to displace the agent: the winner's edited source files are
 *  written over the agent's, after the agent's bytes of exactly those paths are on disk. Any throw restores them, records a skip, and the
 *  run goes on. */
export async function runTournamentGate(ctx: RunContext, signal: AbortSignal, session: SessionResult, deps: ExtraAttemptsDeps, llm: LlmCall = toolLessLlm(), env: NodeJS.ProcessEnv = process.env): Promise<TournamentSummary | null> {
  const input = readTournamentInput(ctx.runDir);
  if (!input) return null; // exec spec off or not Go: nothing to report, the run is untouched
  if (input.skip) return { status: "skipped", reason: `tournament skipped: ${input.skip}`, receipt: [`tournament skipped: ${input.skip}`.replace(/[\u0000-\u001f\u007f]+/g, " ")] }; // the exec-spec call left no probe program
  if (signal.aborted || session.killed || session.exit !== 0 || !session.markers.done || session.markers.specConflict || session.markers.alreadyDone) return skipped("the implement session did not finish clean (done, no conflict, no already-done claim)");
  const left = ctx.implementLeftS?.() ?? Infinity;
  if (left < 150) return skipped("not enough implement time left for three tool-less calls and the scratch checks");
  const deadline = Date.now() + 1000 * Math.min(posInt(env.LOKI_E10_TOURNAMENT_BUDGET_S, 240), left - 90);
  const tick = (): void => { if (signal.aborted) throw new Error("aborted"); if (Date.now() > deadline) throw new Error("the tournament time budget ran out"); };
  const remainingMs = (): number => Math.max(5_000, Math.min(60_000, deadline - Date.now()));
  let ops = null as ReturnType<typeof treeswapOps> | null;
  try {
    const map = await ctx.tests.detect(ctx.repoDir), S = map.tests.filter((t) => deps.impacted.includes(t.path));
    if (S.length === 0) return skipped("no impacted test to gate a candidate against");
    const sealed = new Set(deps.wallPaths), { lines, goFiles } = agentDiffLines(ctx, sealed), max = tournamentMaxLines(env);
    if (goFiles.length === 0) return skipped("the agent diff holds no Go source file");
    const weak = parseStaged(safeGit(ctx.repoDir, ["diff", "--name-status", "--no-renames", "-z", ctx.baseSha, "--", ".", ...ATTEMPT_EXCLUDES.map((e) => `:(exclude)${e}`)])).filter(({ st, f }) => st !== "A" && isTestFile(f) && !sealed.has(f) && testFileWeakened(ctx.repoDir, ctx.baseSha, null, f, st)).map(({ f }) => f);
    if (weak.length > 0) return skipped(`the agent edited an existing test the weakened-test rule flags (${weak.slice(0, 2).join(", ")}): candidates would inherit it, so the tournament stands down`);
    if (lines > max) return skipped(`the agent diff is ${lines} changed lines, over the ${max} small-diff limit`);
    const files: Record<string, string> = {}; let total = 0;
    for (const p of goFiles) {
      const s = baseText(ctx, p);
      if (!s || s.length > FILE_CAP || total + s.length > TOTAL_CAP) return skipped(`base file ${p} is ${s.length} chars, over the prompt limit (${FILE_CAP} per file, ${TOTAL_CAP} total): a truncated file would break every candidate`);
      files[p] = s; total += s.length;
    }
    const tests: Record<string, string> = {};
    for (const t of S) if (t.path.endsWith("_test.go") && !sealed.has(t.path)) { const s = baseText(ctx, t.path); if (s) tests[t.path] = s.slice(0, 6_000); }
    const brief = execSpecBriefOf(ctx.runDir) ?? undefined;
    const c: Context = { issue: String(ctx.outputs().intake?.task ?? ""), files, tests, ...(brief ? { brief } : {}) };
    if (!c.issue) return skipped("the task text is not readable");
    const now = Object.fromEntries(goFiles.map((f) => [f, (() => { try { return readFileSync(join(ctx.repoDir, f), "utf8"); } catch { return ""; } })()]));
    let sites: EditSite[] = [];
    try { sites = editShapeSites(safeGit(ctx.repoDir, ["diff", "-U0", "--no-ext-diff", "--no-renames", ctx.baseSha, "--", ...goFiles]), (f) => { try { return readFileSync(join(ctx.repoDir, f), "utf8"); } catch { return null; } }); } catch { /* the other signs still count */ }
    const signs = warningSigns(c.issue, input.unchecked, now, sites);
    if (signs.length === 0) return skipped("no warning sign: every named site has a binding spec case, the issue's quoted lines changed and no residual site remains; no model call");

    const intake = ctx.outputs().intake ?? {}, owned = installOwned(ctx.repoDir, intake.install_created);
    const userUntracked = new Set([...(Array.isArray(intake.preexisting_untracked) ? intake.preexisting_untracked as string[] : []), ...Object.keys((intake.preexisting_untracked_blobs ?? {}) as object)]);
    const ex = ATTEMPT_EXCLUDES, slots = LENSES.length + 3; // candidates, the agent copy, two base copies
    const agentSnap = snapshotDiff(ctx.repoDir, ctx.baseSha, ex); // the agent's whole tree, in memory; never written back whole
    const mk = (): ReturnType<typeof treeswapOps> => treeswapOps({
      primary: ctx.repoDir, runDir: ctx.runDir, base: ctx.baseSha, k: slots, wallPaths: sealed, wallContent: new Map(Object.entries(deps.wallContent ?? {})), S, outputs: () => ctx.outputs(),
      keep: (p) => userUntracked.has(p) || sealed.has(p) || owned(p),
      runSession: () => Promise.reject(new Error("the tournament starts no agent session")), runOne: () => Promise.resolve(),
    });
    let next = 1; const edited = new Map<string, Record<string, string>>(); // scratch dir -> the candidate's edited files (path -> whole text)
    const spec = input.spec && input.targetRel ? { file: input.spec, rel: input.targetRel } : null;
    const readFiles = (dir: string): Record<string, string> => Object.fromEntries(Object.keys(files).map((f) => [f, (() => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } })()]));
    const io: Io = {
      materialize(edits) {
        ops ??= mk();
        if (next > slots) return null;
        const dir = ops.dirs[next++]!;
        if (edits === "base") return dir;
        applyDiff(dir, agentSnap, ex); // every candidate starts from the agent's tree: its tests, go.mod and non-Go changes stay
        if (edits === "agent") return dir;
        const done = applyEdits(files, edits); if (!done) return null;
        const mine: Record<string, string> = {};
        for (const [p, t] of Object.entries(done)) if (t !== files[p]) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); mine[p] = t; } // the candidate's version of a file replaces the agent's
        edited.set(dir, mine);
        return dir;
      },
      async checks(dir) {
        const out: AttemptCheck[] = [], sc = { ...ctx, repoDir: dir, emit: () => {} } as RunContext; // scratch checks are not verify results: no test.result events
        for (const t of S) { tick(); await deps.check(sc, t, signal, out); }
        return out.length > 0 && out.every((x) => x.result === "pass");
      },
      probe: (dir, program) => runGoProbe(dir, input.pkgRel, input.pkg, program, remainingMs()).stdout,
      ...(spec ? { spec: (dir: string): SpecStates | null => { tick(); const r = redFilter(EMITTERS.go, dir, spec.rel, spec.file); return r.built ? r.cases : null; } } : {}),
    };
    const r = await runTournament(c, llm, io, { program: input.program, pkg: input.pkg, treeFiles: readFiles, margin: tournamentMargin(env), tick });
    const winEdits = r.pick.winner === "agent" ? null : edited.get(r.entrants.find((e) => e.id === r.pick.winner)?.dir ?? "") ?? null;
    if (winEdits) applyWinnerFiles(ctx.repoDir, ctx.runDir, Object.entries(winEdits).map(([path, content]) => ({ path, content })));
    const replaced = winEdits ? Object.keys(winEdits) : [], receipt = receiptLines(r, replaced);
    return { status: winEdits ? "displaced" : "kept", reason: r.pick.reason, signs, winner: r.pick.winner, replaced, calls: r.calls, usd: Number(r.usd.toFixed(6)), candidates: r.candidates, entrants: r.entrants.map((e) => ({ id: e.id, checks: e.checksPass, diff_lines: e.diffLines, probes: Object.keys(e.run).length })), disagreements: r.disagreements.length, verdicts: r.picks, named: r.named, unstable: r.unstable, ...(r.diffProbe ? { diff_probe: r.diffProbe } : {}), receipt };
  } catch (e) { // any throw: the agent's own bytes are put back for every path an apply may have touched, the receipt says so, the run goes on
    let why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    try { recoverTournamentUndo(ctx.repoDir, ctx.runDir); } catch (e2) { why += `; restoring the agent's files also failed (${(e2 instanceof Error ? e2.message : String(e2)).split("\n")[0]})`; }
    return { status: "error", reason: `tournament skipped: ${why}`, receipt: [`tournament skipped: ${why}`.replace(/[\u0000-\u001f\u007f]+/g, " ")] };
  } finally {
    try { ops?.dispose(); } catch { /* worktrees removed by exact path; a leak is cleaned with the temp root */ }
  }
}

// ---------- receipt ----------
/** One line per candidate and per disagreement, then the decision. The receipt carries these under "Candidate tournament". */
export function receiptLines(r: TournamentResult, replaced: string[] = []): string[] {
  const out: string[] = [];
  for (const e of r.entrants) out.push(`${e.id}: ${e.dir === "" ? "edit did not apply" : e.checksPass ? `checks pass, ${Object.keys(e.run).length} probes` : "checks fail or a test was edited"}`);
  for (const d of r.disagreements) { const v = r.picks[d.probeId]; out.push(`disagreement ${d.probeId} (${d.desc.slice(0, 80)}): ${d.options.map((o) => `${o.entrants.join("+")} -> ${o.out.slice(0, 60)}`).join(" | ")}; judge: ${v === undefined ? "no consistent verdict" : `backed ${v.slice(0, 60)}`}`); }
  out.push(`decision: ${r.pick.displaced ? `agent tree displaced by ${r.pick.winner}; its version of ${replaced.join(", ")} replaced the agent's, everything else the agent changed (tests, go.mod, other files) stays` : "agent tree kept"} (${r.pick.reason})`);
  return out.map((l) => l.replace(/[\u0000-\u001f\u007f]+/g, " "));
}
/** seal.ts: the receipt block for the implement output; {} (key omitted, receipt hash unchanged) when no tournament ran. */
export function tournamentReceiptBlock(implement: Record<string, unknown> | undefined): { tournament?: string[] } {
  const t = implement?.tournament as { receipt?: unknown } | undefined;
  return Array.isArray(t?.receipt) && t.receipt.length > 0 ? { tournament: t.receipt.map(String) } : {};
}
