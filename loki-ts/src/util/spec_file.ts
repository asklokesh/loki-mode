// SPEC-FIRST-INTENT: the intent card's acceptance criteria as an editable file, .loki/specs/<slug>.md.
// L0: the model emits schema-checked JSON; this module only renders it and reads the edited file back.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { taskBlock } from "../engine10/types.ts";
import { stripTemplate } from "./intent_card.ts";
import type { SessionRunner } from "../engine10/types.ts";

export const SPEC_MARKER = "<!-- loki-spec v1: edit the intent and criteria; keep the three headings. -->";
export const SPEC_DIR = join(".loki", "specs");
const MAX_CRITERIA = 20;
const MAX_FIELD = 400;
export const MAX_CLAUSES = 40;
const H_TASK = "## Task", H_INTENT = "## Intent", H_CRIT = "## Acceptance criteria";

/** A spec that fails to parse; `line` is 1-based and reported to the user (exit 2). */
export class SpecError extends Error {
  constructor(readonly line: number, detail: string, readonly file?: string) {
    super(`${file ? `${file}: ` : ""}line ${line}: ${detail}`);
  }
}

export interface SpecCriteria { intent: string; criteria: string[] }
export interface ParsedSpec extends SpecCriteria { task: string }
export interface LoadedSpec extends ParsedSpec { sha256: string; path: string; raw: string }

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export function slugify(task: string): string {
  const full = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= 40) return full || "task";
  // Truncated: append a task hash so two long tasks sharing a prefix never collide (31 + "-" + 8 = 40).
  return `${full.slice(0, 31).replace(/-+$/g, "")}-${sha256Hex(task).slice(0, 8)}`;
}

/** Schema check for the model's JSON: {intent: string, criteria: string[1..MAX_CRITERIA]}. Returns an error string or null. */
export function checkCriteriaJson(x: unknown): string | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return "not a JSON object";
  const o = x as Record<string, unknown>;
  const one = (v: unknown): boolean => typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD && !/[\r\n]/.test(v);
  if (!one(o.intent)) return "intent must be a non-empty single-line string";
  if (!Array.isArray(o.criteria) || o.criteria.length < 1 || o.criteria.length > MAX_CRITERIA) return `criteria must be an array of 1 to ${MAX_CRITERIA} strings`;
  if (!o.criteria.every(one)) return "every criterion must be a non-empty single-line string";
  return null;
}

// Acceptance clauses: generic extraction from any spec text (markdown, numbered items, Acceptance headings, Given/When/Then, RFC 2119 prose). Ids are source order and a pure function of the text, so the same spec gives the same ids.
export interface Clause { id: string; text: string; text_sha256: string; anchor: string }
export interface ClauseSet { clauses: Clause[]; dropped: number }
// A heading of this class holds scope exclusions or background, never acceptance clauses; a heading that also names acceptance still counts.
const SKIP_HEAD = /^(?:#+\s*)?(?:\d+(?:\.\d+)*[.)]?\s*)?(?:\*\*|__)?\s*(?:(?:non[- ]?goals?|out[- ]of[- ]scope|not (?:required|in scope)|won'?t do|will not do|future work|future)(?:\s*\([^)]*\))?(?:\s*:\s+\S.*)?|(?:background|context|references?|rationale|motivation|glossary|appendix|alternatives?(?:\s+(?:considered|explored|rejected))?|considered alternatives)(?:\s*\([^)]*\))?)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i; // the whole heading is the title; only the exclusion titles may carry "Title: text", so "Will not crash", "Future-dated payments" and "Context: Billing" keep their clauses
const CLAUSE_HEAD = /accept|criteria|requirement|must/i, RFC2119 = /\b(?:MUST|SHALL)(?: NOT)?\b/, GWT = /^(?:given|when|then|and|but)\b/i;
// A markdown heading that states a requirement is a clause too: a must/should/shall verb (not the bare "Must have" title), implements/implementing, or a colon then a full sentence. A bare title ("Errors", "API") is not.
const HEAD_REQ = /\b(?:must|should|shall)\s+(?!haves?\b)[a-z]|\bimplements\s+\S|\w[^\n]*?\bimplementing\s+\S/i;
// Question-led headings ("What should happen"; "When ...?" or "Where ...?" only with the trailing "?") and label or standard-title headings ("Step 2: ...", "Example: ...", "RFC 4180: ...") describe or introduce; they do not state a requirement.
const HEAD_QUESTION = /^#+\s+(?:\d+(?:\.\d+)*[.)]?\s*)?(?:(?:what|how|why|who|which)\b|(?:when|where|if)\b[^\n]*\?\s*$)/i;
const HEAD_LABEL = /^#+\s+(?:\d+(?:\.\d+)*[.)]?\s*)?(?:step|example|examples|goal|goals|note|notes|usage|overview|summary|task|tip|rfc|iso|ieee|ecma|w3c|ansi)\b/i;
const LIST_ITEM = /^(?:[-*+]\s+|\d+[.)]\s+)/;
const isHeadLine = (l: string): boolean => /^#+\s/.test(l) || (/:$/.test(l) && l.length <= 60 && !/^[-*+\d]/.test(l));
const HEAD_SENTENCE = /:\s+\S+(?:\s+\S+){3,}[.!?]$/;
const headStatesRequirement = (line: string): boolean => !HEAD_QUESTION.test(line) && (HEAD_REQ.test(line) || (!HEAD_LABEL.test(line) && HEAD_SENTENCE.test(line)));
const normClause = (t: string): string => t.replace(/\s+/g, " ").trim();

const OAS_METHOD = /^ {4}(get|put|post|delete|patch|head|options):\s*$/;
/** OpenAPI YAML: one clause per operation and one per HTTP status code its text names, e.g. "operation POST /links" and "POST /links returns 404". */
function openApiClauses(lines: string[]): { text: string; anchor: string }[] {
  const out: { text: string; anchor: string }[] = [];
  if (!lines.some((l) => /^openapi:\s*["']?3/.test(l))) return out;
  let inPaths = false, path = "", op = "";
  lines.forEach((l, i) => {
    if (/^\S/.test(l)) { inPaths = /^paths:/.test(l); path = op = ""; return; }
    if (!inPaths) return;
    const p = /^ {2}["']?(\/[^"':\s]*)["']?:\s*$/.exec(l), m = OAS_METHOD.exec(l);
    if (p) { path = p[1]!; op = ""; } else if (m && path) { op = `${m[1]!.toUpperCase()} ${path}`; out.push({ text: `operation ${op}`, anchor: `l${i + 1}` }); }
    else if (op) for (const c of l.matchAll(/(?<![\w.\/-])([1-5]\d\d)(?![\w\/-]|\.\d)/g)) out.push({ text: `${op} returns ${c[1]!}`, anchor: `l${i + 1}` });
  });
  return out;
}

export function extractClauses(text: string): ClauseSet {
  const pages = text.replace(/\r\n/g, "\n").split("\f"), paged = pages.length > 1, out: { text: string; anchor: string }[] = [];
  pages.forEach((page, pi) => {
    const lines = page.split("\n"), keep = new Set<number>();
    // stripTemplate only calls filter(); a filter-only view lets it report which line indexes survive, so anchors stay exact.
    stripTemplate({ filter: (fn: (l: string) => boolean) => { lines.forEach((l, i) => { if (fn(l)) keep.add(i); }); return []; } });
    let under = false, skip = false, fence = false, gwt = -1;
    const anchorOf = (i: number): string => `${paged ? `p${pi + 1}:` : ""}l${i + 1}`;
    // A heading over list items is a container: the items are the clauses. Only a leaf heading (no list item before the next heading) can be a clause itself.
    const listFollows = (i: number): boolean => { for (let j = i + 1; j < lines.length; j++) { if (!keep.has(j)) continue; const t = lines[j]!.trim(); if (LIST_ITEM.test(t)) return true; if (t !== "" && isHeadLine(t)) return false; } return false; };
    for (const [i, raw] of lines.entries()) {
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
      if (fence || !keep.has(i)) continue;
      const line = raw.trim();
      if (line === "") { gwt = -1; continue; }
      if (isHeadLine(line)) { under = CLAUSE_HEAD.test(line); skip = !under && SKIP_HEAD.test(line); gwt = -1; if (!skip && /^#+\s/.test(line) && headStatesRequirement(line) && !listFollows(i)) out.push({ text: line.replace(/^#+\s+/, "").replace(/\*\*|__/g, ""), anchor: anchorOf(i) }); continue; }
      if (skip) continue;
      const item = /^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.*)$/.exec(line);
      const body = (item ? item[1]! : line).replace(/\*\*|__/g, "");
      if (GWT.test(body) && /^given\b/i.test(body) || (gwt >= 0 && GWT.test(body))) {
        if (/^given\b/i.test(body)) { gwt = out.length; out.push({ text: body, anchor: anchorOf(i) }); } else out[gwt]!.text += ` ${body}`;
        continue;
      }
      gwt = -1;
      if (item || under) out.push({ text: body, anchor: anchorOf(i) }); // every bullet or numbered item is a clause under ANY heading; a prose line counts only under a criteria heading or as an RFC 2119 sentence
      else for (const sent of body.split(/(?<=[.!?])\s+/)) if (RFC2119.test(sent)) out.push({ text: sent, anchor: anchorOf(i) });
    }
  });
  out.push(...openApiClauses(text.replace(/\r\n/g, "\n").split("\n")));
  const seen = new Set<string>(), uniq: { text: string; anchor: string }[] = [];
  for (const c of out) { const t = normClause(c.text).slice(0, MAX_FIELD); if (t === "") continue; const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push({ text: t, anchor: c.anchor }); } }
  const clauses = uniq.slice(0, MAX_CLAUSES).map((c, i) => ({ id: `C${i + 1}`, text: c.text, text_sha256: sha256Hex(c.text), anchor: c.anchor }));
  return { clauses, dropped: Math.max(0, uniq.length - MAX_CLAUSES) };
}
export const clauseLine = (c: Clause): string => `${c.id}: ${c.text} [${c.anchor}]`;
export const clauseDroppedNote = (n: number): string => `not_proven: ${n} further acceptance clause${n === 1 ? "" : "s"} beyond the first ${MAX_CLAUSES} were not extracted`;

/** Wall brief lines for the extracted clauses; empty for a spec with none, so that brief is unchanged. */
export function clauseBriefBlock(set: ClauseSet | null | undefined): string[] {
  if (!set || set.clauses.length === 0) return [];
  return [
    `Acceptance clauses extracted from the spec, each with its source line (each must be covered by a test):\n${set.clauses.map((c) => `Acceptance: ${clauseLine(c)}`).join("\n")}`,
    "At every assertion block put a marker comment `clause: C3` (the clause id it proves) in the test language's own comment syntax, within a few lines of a real assertion. Every listed clause needs its own marker and assertion; a clause with none is reported NOT PROVEN and caps the run at PARTIAL.",
  ];
}

/** Which clause ids and which authored files carry no `clause: Cn` marker; never silently counted as covered. */
export function untaggedClauses(set: ClauseSet | null | undefined, files: Map<string, string>): { untagged: string[]; untagged_files: string[] } {
  if (!set || set.clauses.length === 0) return { untagged: [], untagged_files: [] };
  const found = new Set<string>(), untagged_files: string[] = [];
  for (const [name, body] of files) { let any = false; for (const m of body.matchAll(/\bclause:\s*(C\d+)\b/g)) { found.add(m[1]!); any = true; } if (!any) untagged_files.push(name); }
  return { untagged: set.clauses.map((c) => c.id).filter((id) => !found.has(id)), untagged_files };
}

// One generic assertion-token table, matched on every Wall file whatever its language: Go t.Error/t.Fatal, Rust assert!/panic/expect, Python assert and raises(, JS/TS expect( and assert, bats [ and status checks, Java assert*.
const ASSERT_TOKENS: RegExp[] = [/\bt\.(?:Error|Errorf|Fatal|Fatalf)\(/, /\b(?:debug_)?assert(?:_eq|_ne)?!\s*[(\[{]/, /#\[should_panic|\bpanic!|\.(?:expect|expect_err|unwrap_err)\(/, /^\s*assert\b/m, /\braises\(/, /\bexpect\(/, /\bassert(?:\.\w+|\w*)\s*\(/, /^\s*\[\[?\s/m, /\$status\b|\$\{status\}/, /\bassert_\w+/];
const MARKER_BEFORE = 4, MARKER_AFTER = 6; // lines around a `clause: Cn` marker searched for an assertion token

/** Clause ids a set of PASSING sealed Wall files covers: a `clause: Cn` marker with an assertion token within a few lines of it. A marker in a comment alone never counts. */
export function coveredClauses(files: Iterable<string>): Set<string> {
  const covered = new Set<string>();
  for (const body of files) {
    const lines = body.split("\n");
    lines.forEach((l, i) => {
      const ids = [...l.matchAll(/\bclause:\s*(C\d+)\b/g)].map((m) => m[1]!);
      if (ids.length === 0) return;
      const near = lines.slice(Math.max(0, i - MARKER_BEFORE), i + MARKER_AFTER + 1).filter((x) => !/\bclause:\s*C\d+\b/.test(x) || !/^\s*(?:#|\/\/|--|\/\*|\*)/.test(x)).join("\n");
      if (ASSERT_TOKENS.some((re) => re.test(near))) for (const id of ids) covered.add(id);
    });
  }
  return covered;
}

/** NOT PROVEN reasons for every extracted clause no passing sealed Wall file covers; empty for a spec with no clauses. */
export function clauseGapOf(set: ClauseSet | null | undefined, files: Iterable<string>): string[] {
  if (!set || set.clauses.length === 0) return [];
  const covered = coveredClauses(files);
  return set.clauses.filter((c) => !covered.has(c.id)).map((c) => `spec clause not covered: ${c.id}: ${c.text}`);
}

// WALL-ASSERT-STRENGTH: assertion lines that check an error occurred without naming which one on that line or the 3 lines after it. Disclosure only, never a verdict cap: a bare error check is sometimes all a spec states.
const WEAK_TOKENS: RegExp[] = [
  /\b(?:debug_)?assert!\s*\(\s*(?!!)[^;]*?\.is_err\(\)\s*(?:,[^;]*)?\)/, // Rust: assert!(x.is_err()) with or without a message; a negated !x.is_err() is not an error check
  /\b(?:raises|assertRaises)\(\s*(?:Exception|BaseException)\s*[,)]/, // Python: raises or assertRaises with the bare base Exception (a match= on the line pins it)
  /\.toThrow(?:Error)?\(\s*\)|\.to\.throw\(\s*\)/, // JS/TS: toThrow() / rejects.toThrow() / chai .to.throw() with no message or class
  /\b(?:assert|require)\.Error\(\s*t\s*,\s*err\s*(?:,[^()]*)?\)/, // Go testify: only checks that err is non-nil (the bare `if err == nil {` failure branch is goNilFailure)
  /\[\[?\s*"?\$\{?status\}?"?\s+-ne\s+0\s*\]|^\s*assert_failure\s*(?:#.*)?$|^\s*run\s+!\s/, // bats: any failure code accepted
];
const WEAK_PIN = /\berrors\.Is\b|\bErrorIs\b|\bErrorContains\b|\bEqualError\b|\bunwrap_err\b|\bcm\.exception\b|\bexcinfo\b|\$\{?output\b|\bmatch=|\bassert_output\b|\bErr\(|\bmatches!|\berr\s*!=\s*[A-Z]\w*Err\b|\berr\s*!=\s*Err\w*|\.Error\(\)\s*[!=]=|\.value\b|\.message\b/;
const TEST_START = /^\s*(?:#\[test\]|@test\b|def test|func Test|(?:it|test|describe)\()/;
const COMMENT_LINE = /^\s*(?:#(?!\[)|\/\/|--|\/\*|\*)/;
/** Go `if err == nil {` whose body is a bare failure (t.Fatal/t.Error/t.Fail/panic, same line or next line); a body that goes on to compare values is the success branch. */
function goNilFailure(lines: string[], i: number): boolean {
  const m = /\bif\s+err\s*==\s*nil\s*\{(.*)$/.exec(lines[i]!); if (!m) return false;
  let rest = m[1]!.trim();
  for (let k = i + 1; rest === "" && k < lines.length; k++) rest = lines[k]!.trim();
  return /^(?:t\.(?:Fatal|Error|Fail)\w*\b|panic\()/.test(rest);
}
/** node:test assert.throws(fn) / assert.rejects(p) closed on one line with no validator argument. */
function nodeBareThrow(l: string): boolean {
  const m = /\bassert\.(?:throws|rejects)\(/.exec(l); if (!m) return false;
  let depth = 1;
  for (let k = m.index + m[0].length; k < l.length; k++) { const c = l[k]!; if (c === "(" || c === "{" || c === "[") depth++; else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return true; } else if (c === "," && depth === 1) return false; }
  return false; // not closed on this line: a validator may follow, so it is not counted
}

/** NOT PROVEN line for Wall error assertions that do not pin the error on the line or the 3 lines after, or null when there are none. Files are {rel, body}. */
export function weakAssertionNote(files: Iterable<{ rel: string; body: string }>): string | null {
  const at: string[] = []; let n = 0;
  for (const f of files) {
    const lines = f.body.split("\n"), hit: number[] = [];
    lines.forEach((l, i) => {
      if (COMMENT_LINE.test(l) || !(WEAK_TOKENS.some((re) => re.test(l)) || nodeBareThrow(l) || goNilFailure(lines, i))) return;
      for (let k = i; k <= i + 3 && k < lines.length; k++) { if (k > i && TEST_START.test(lines[k]!)) break; if (!COMMENT_LINE.test(lines[k]!) && WEAK_PIN.test(lines[k]!)) return; }
      hit.push(i + 1);
    });
    if (hit.length > 0) { n += hit.length; at.push(`${f.rel}:${hit.join(",")}`); }
  }
  return n === 0 ? null : `Wall assertion strength not measured: ${n} error assertion(s) do not name the expected error on the same line or the 3 lines after (${at.join("; ")}); the Wall is model-authored`;
}

export function renderSpec(task: string, c: SpecCriteria, set?: ClauseSet | null): string {
  const quoted = task.split("\n").map((l) => `> ${l}`.trimEnd());
  const cl = set ? [...set.clauses.map((x) => `- ${clauseLine(x)}`), ...(set.dropped ? [`- ${clauseDroppedNote(set.dropped)}`] : [])] : [];
  return [SPEC_MARKER, "", H_TASK, "", ...quoted, "", H_INTENT, "", c.intent.trim(), "", H_CRIT, "", ...c.criteria.map((x) => `- ${x.trim()}`), ...cl, ""].join("\n");
}

export function parseSpec(text: string, file?: string): ParsedSpec {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fail = (line: number, detail: string): never => { throw new SpecError(line, detail, file); };
  if ((lines[0] ?? "").trim() !== SPEC_MARKER) fail(1, "missing the loki-spec v1 marker comment on the first line");
  const at: Record<string, number> = {};
  lines.forEach((l, i) => { const h = l.trim(); if (h === H_TASK || h === H_INTENT || h === H_CRIT) { if (h in at) fail(i + 1, `duplicate heading "${h}"`); at[h] = i; } });
  for (const h of [H_TASK, H_INTENT, H_CRIT]) if (!(h in at)) fail(lines.length, `missing the "${h}" section`);
  const bounds = Object.entries(at).sort((a, b) => a[1] - b[1]);
  const body = (h: string): { from: number; to: number } => {
    const idx = bounds.findIndex(([k]) => k === h);
    return { from: at[h]! + 1, to: idx + 1 < bounds.length ? bounds[idx + 1]![1] : lines.length };
  };
  const t = body(H_TASK), taskLines: string[] = [];
  for (let i = t.from; i < t.to; i++) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    if (!l.startsWith(">")) fail(i + 1, "task lines must start with \"> \"");
    taskLines.push(l.replace(/^> ?/, ""));
  }
  if (taskLines.length === 0) fail(at[H_TASK]! + 1, "the Task section is empty");
  const n = body(H_INTENT), intentLines: string[] = [];
  for (let i = n.from; i < n.to; i++) { const l = lines[i]!.trim(); if (l !== "") intentLines.push(l); }
  if (intentLines.length === 0) fail(at[H_INTENT]! + 1, "the Intent section is empty");
  const c = body(H_CRIT), criteria: string[] = [];
  for (let i = c.from; i < c.to; i++) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    if (!/^[-*]\s/.test(l) && !/^[-*]$/.test(l.trim())) fail(i + 1, "criteria must be bullet lines starting with \"- \"");
    const v = l.replace(/^[-*]\s*/, "").trim();
    if (v === "") fail(i + 1, "empty criterion");
    if (v.length > MAX_FIELD) fail(i + 1, `criterion longer than ${MAX_FIELD} characters`);
    criteria.push(v);
  }
  if (criteria.length === 0) fail(at[H_CRIT]! + 1, "no acceptance criteria");
  const maxLines = MAX_CRITERIA + MAX_CLAUSES + 1;
  if (criteria.length > maxLines) fail(at[H_CRIT]! + 1, `more than ${maxLines} criteria`);
  return { task: taskLines.join("\n"), intent: intentLines.join(" "), criteria };
}

/** Reads and parses a spec file; the sha256 is over the exact bytes read. Throws SpecError (line 1 for an unreadable file). */
export function loadSpecFile(path: string): LoadedSpec {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { throw new SpecError(1, "cannot read the spec file", path); }
  return { ...parseSpec(raw, path), sha256: sha256Hex(raw), path, raw };
}

/** Brief paragraph making the edited spec the authoritative intent. Null/undefined adds nothing. */
export function specBriefBlock(s: LoadedSpec | null | undefined): string | null {
  if (!s) return null;
  return [
    `Authoritative spec (written or edited by the user; where it differs from the task text, the spec wins), sha256 ${s.sha256}:`,
    `Intent: ${s.intent}`,
    "Acceptance criteria (hold every one):",
    ...s.criteria.map((c) => `- ${c}`),
  ].join("\n");
}

/** Additive receipt block; empty (key omitted, receipt hashes stay stable) unless a spec drove the run. */
export function specReceiptBlock(env: NodeJS.ProcessEnv): { spec?: { path: string; sha256: string } } {
  const p = env.LOKI_E10_SPEC_PATH, sha = env.LOKI_E10_SPEC_SHA256;
  if (!p || !sha) return {};
  const rel = isAbsolute(p) && env.LOKI_E10_REPO_DIR ? relative(env.LOKI_E10_REPO_DIR, p) : p;
  return { spec: { path: rel, sha256: sha } };
}

/** PR body line linking the spec; empty without a spec. */
export function specPrLine(env: NodeJS.ProcessEnv): string {
  const b = specReceiptBlock(env).spec;
  return b ? `\nSpec: \`${b.path}\` (sha256 ${b.sha256.slice(0, 12)})\n` : "";
}

export function specJsonBrief(task: string, outputPath: string): string {
  return [
    "You are the Loki spec stage.",
    ...taskBlock(task),
    `State what you think the user wants and the acceptance criteria you will hold the change to. Write ONLY a JSON object {"intent":"<one sentence>","criteria":["<one checkable criterion>", ...]} with 2 to 6 criteria, each a single line, to this exact file path: ${outputPath}`,
    "Do not edit any other file. Do not run tests. Do not commit.",
  ].join("\n\n");
}

export interface GenerateOpts { task: string; repoDir: string; sessions: SessionRunner; force?: boolean; limitS?: number; signal?: AbortSignal }
export interface GeneratedSpec { path: string; sha256: string }

export async function generateSpec(o: GenerateOpts): Promise<GeneratedSpec> {
  const slug = slugify(o.task);
  const path = join(o.repoDir, SPEC_DIR, `${slug}.md`);
  if (existsSync(path) && !o.force) throw new Error(`spec exists: ${relative(o.repoDir, path)} (edit it, delete it, or pass --force to regenerate)`);
  const runDir = join(o.repoDir, ".loki", "runs", `spec-${slug}`);
  mkdirSync(runDir, { recursive: true });
  const jsonPath = join(runDir, "spec-criteria.json");
  const res = await o.sessions.run({
    stage: "plan", brief: specJsonBrief(o.task, jsonPath), tier: "fast", iterationId: `spec-${slug}`,
    limitS: o.limitS ?? 90, signal: o.signal ?? new AbortController().signal, cwd: o.repoDir,
  });
  if (res.killed || res.exit !== 0) throw new Error(`spec session failed (exit ${res.exit ?? "killed"})`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(jsonPath, "utf8")); } catch { throw new Error("the model did not write valid JSON (schema check failed)"); }
  const bad = checkCriteriaJson(parsed);
  if (bad) throw new Error(`the model output failed the schema check: ${bad}`);
  const text = renderSpec(o.task, parsed as SpecCriteria, extractClauses(o.task));
  mkdirSync(join(o.repoDir, SPEC_DIR), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { path, sha256: sha256Hex(text) };
}
