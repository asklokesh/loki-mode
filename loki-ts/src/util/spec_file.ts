// SPEC-FIRST-INTENT: the intent card's acceptance criteria as an editable file, .loki/specs/<slug>.md.
// L0: the model emits schema-checked JSON; this module only renders it and reads the edited file back.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { taskBlock } from "../engine10/types.ts";
import { parseContract } from "../features/contract.ts";
import type { SessionRunner } from "../engine10/types.ts";

export const SPEC_MARKER = "<!-- loki-spec v1: edit the intent and criteria; keep the three headings. -->";
export const SPEC_DIR = join(".loki", "specs");
const MAX_CRITERIA = 20;
export const MAX_CLAUSES = 40;
const CLAUSE_TEXT_MAX = 380;
const DROPPED_RE = /^<!-- clauses-dropped: (\d+) -->$/;
const CLAUSE_LINE_RE = /^(AC-\d+): (.+?)(?: \[((?:p\d+:)?l\d+)\])?$/;
const MAX_FIELD = 400;
const H_TASK = "## Task", H_INTENT = "## Intent", H_CRIT = "## Acceptance criteria";

/** A spec that fails to parse; `line` is 1-based and reported to the user (exit 2). */
export class SpecError extends Error {
  constructor(readonly line: number, detail: string, readonly file?: string) {
    super(`${file ? `${file}: ` : ""}line ${line}: ${detail}`);
  }
}

/** CW-07: one numbered acceptance clause. `anchor` is `p<page>:l<line>` (page from a form feed) or `l<line>`; absent for model-added criteria. */
export interface Clause { id: string; text: string; anchor?: string; text_sha256: string }
export interface SpecCriteria { intent: string; criteria: string[]; clauses?: Clause[]; clausesDropped?: number }
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

const mkClause = (id: string, text: string, anchor?: string): Clause => ({ id, text, ...(anchor ? { anchor } : {}), text_sha256: sha256Hex(text) });
/** `AC-3: <text> [p3:l12]`, the one rendering shared by the locked spec and the Wall brief. */
export const clauseLine = (k: Clause): string => `${k.id}: ${k.text}${k.anchor ? ` [${k.anchor}]` : ""}`;

const normClause = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clipClause = (t: string): string => (t.length > CLAUSE_TEXT_MAX ? `${t.slice(0, CLAUSE_TEXT_MAX - 3)}...` : t);

/** The clauses parseContract (the one extractor) finds in a task or spec text, capped at MAX_CLAUSES with the overflow counted. */
export function taskClauses(text: string): { clauses: Clause[]; dropped: number } {
  const c = parseContract(text);
  return {
    clauses: c.criteria.slice(0, MAX_CLAUSES).map((k) => mkClause(k.id, clipClause(k.text), k.anchor)),
    dropped: Math.max(0, c.criteria.length - MAX_CLAUSES) + (c.dropped ?? 0),
  };
}

/** Task clauses first (anchored), then the model's criteria as further clauses without an anchor; capped at MAX_CLAUSES, overflow counted; empty when the task has no clauses. */
export function lockClauses(task: string, modelCriteria: string[]): { clauses: Clause[]; dropped: number } {
  const ex = taskClauses(task);
  if (ex.clauses.length === 0) return { clauses: [], dropped: 0 }; // no task clauses: the spec stays exactly as before
  const seen = new Set(ex.clauses.map((c) => normClause(c.text)));
  const extra = modelCriteria.filter((c) => { const k = normClause(c); if (seen.has(k)) return false; seen.add(k); return true; });
  const room = MAX_CLAUSES - ex.clauses.length;
  const more = extra.slice(0, Math.max(0, room)).map((t, i) => mkClause(`AC-${ex.clauses.length + i + 1}`, clipClause(t)));
  return { clauses: [...ex.clauses, ...more], dropped: ex.dropped + Math.max(0, extra.length - Math.max(0, room)) };
}

/** The clause lines a spec contributes to the Wall: tagged `C<n>:` criteria only, so an untagged spec leaves the brief untouched. */
export const specClauseLines = (s: ParsedSpec | null | undefined): string[] => (s?.clauses ?? []).map(clauseLine);

export function renderSpec(task: string, c: SpecCriteria): string {
  const quoted = task.split("\n").map((l) => `> ${l}`.trimEnd());
  return [SPEC_MARKER, "", H_TASK, "", ...quoted, "", H_INTENT, "", c.intent.trim(), "", H_CRIT, "", ...(c.clauses?.length ? [...c.clauses.map((k) => `- ${clauseLine(k)}`), ...(c.clausesDropped ? [`<!-- clauses-dropped: ${c.clausesDropped} -->`] : [])] : c.criteria.map((x) => `- ${x.trim()}`)), ""].join("\n");
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
  let dropped = 0;
  for (let i = c.from; i < c.to; i++) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    const dm = DROPPED_RE.exec(l.trim());
    if (dm) { dropped = Number(dm[1]); continue; }
    if (!/^[-*]\s/.test(l) && !/^[-*]$/.test(l.trim())) fail(i + 1, "criteria must be bullet lines starting with \"- \"");
    const v = l.replace(/^[-*]\s*/, "").trim();
    if (v === "") fail(i + 1, "empty criterion");
    if (v.length > MAX_FIELD) fail(i + 1, `criterion longer than ${MAX_FIELD} characters`);
    criteria.push(v);
  }
  if (criteria.length === 0) fail(at[H_CRIT]! + 1, "no acceptance criteria");
  const clauses = criteria.map((x) => CLAUSE_LINE_RE.exec(x));
  const tagged = clauses.every((m) => m !== null);
  if (tagged) { const ids = new Set<string>(); for (const m of clauses) { if (ids.has(m![1]!)) fail(at[H_CRIT]! + 1, `duplicate clause id ${m![1]}`); ids.add(m![1]!); } } // CW-07: a fully clause-tagged spec may hold up to MAX_CLAUSES lines
  if (criteria.length > (tagged ? MAX_CLAUSES : MAX_CRITERIA)) fail(at[H_CRIT]! + 1, `more than ${tagged ? MAX_CLAUSES : MAX_CRITERIA} criteria`);
  return {
    task: taskLines.join("\n"), intent: intentLines.join(" "), criteria,
    ...(tagged ? { clauses: clauses.map((m) => mkClause(m![1]!, m![2]!, m![3])) } : {}),
    ...(tagged && dropped ? { clausesDropped: dropped } : {}),
  };
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
  const crit = parsed as SpecCriteria, lk = lockClauses(o.task, crit.criteria);
  const text = renderSpec(o.task, lk.clauses.length > 0 ? { ...crit, clauses: lk.clauses, clausesDropped: lk.dropped } : crit);
  mkdirSync(join(o.repoDir, SPEC_DIR), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { path, sha256: sha256Hex(text) };
}
