// SPEC-FIRST-INTENT: the intent card's acceptance criteria as an editable file, .loki/specs/<slug>.md.
// L0: the model emits schema-checked JSON; this module only renders it and reads the edited file back.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { taskBlock } from "../engine10/types.ts";
import type { SessionRunner } from "../engine10/types.ts";

export const SPEC_MARKER = "<!-- loki-spec v1: edit the intent and criteria; keep the three headings. -->";
export const SPEC_DIR = join(".loki", "specs");
const MAX_CRITERIA = 20;
const MAX_FIELD = 400;
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
  const s = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s || "task";
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

export function renderSpec(task: string, c: SpecCriteria): string {
  const quoted = task.split("\n").map((l) => `> ${l}`.trimEnd());
  return [SPEC_MARKER, "", H_TASK, "", ...quoted, "", H_INTENT, "", c.intent.trim(), "", H_CRIT, "", ...c.criteria.map((x) => `- ${x.trim()}`), ""].join("\n");
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
  if (criteria.length > MAX_CRITERIA) fail(at[H_CRIT]! + 1, `more than ${MAX_CRITERIA} criteria`);
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
  const text = renderSpec(o.task, parsed as SpecCriteria);
  mkdirSync(join(o.repoDir, SPEC_DIR), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { path, sha256: sha256Hex(text) };
}
