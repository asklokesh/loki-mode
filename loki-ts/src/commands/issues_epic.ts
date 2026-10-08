// MASS-2: `loki issues run` splits a too-large issue into stacked slices instead of skipping it.
//   1. one Opus planning session returns a JSON split (Engine Law L0: the model decides the slices; the harness only
//      checks the schema, refuses cycles and refuses a slice whose dependencies are not on one stack);
//   2. slices run in dependency order, each as a normal engine10 run in its own worktree started on its stack parent's
//      run branch (roots on HEAD), with the PR base set to that parent branch. The PR itself is the run's own PR stage;
//   3. a slice that is not VERIFIED or PARTIAL with a PR stops its dependents, which are recorded SKIPPED with the reason;
//   4. renderEpicTree prints the epic as a tree of slice, outcome, PR and cost.
import type { GhIssue } from "./issues_run.ts";

export interface Slice {
  id: string;
  title: string;
  acceptance: string[];
  depends_on: string[];
  files: string[];
}

export type Decomposition = { ok: true; slices: Slice[]; parent: Record<string, string | null> } | { ok: false; reason: string };

export interface SliceResult {
  id: string;
  title: string;
  parent: string | null;
  outcome: string;
  pr: string | null;
  cost: string;
  branch?: string | null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_SLICES = 2;
const MAX_SLICES = 15;

const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();

/** The JSON object in the reply: the whole text, else the last fenced block, else first "{" to last "}". */
function extractJson(text: string): unknown {
  const tries = [text.trim()];
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (fences.length) tries.push(fences[fences.length - 1]![1]!.trim());
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

const strList = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.trim() !== "" && x.length <= 500) ? (v as string[]).map(oneLine) : null;

/** Validate the model's split and order it. Never invents, merges or renames a slice. */
export function parseDecomposition(text: string): Decomposition {
  const j = extractJson(text);
  if (j === undefined || j === null || typeof j !== "object" || Array.isArray(j)) return { ok: false, reason: "no JSON object in the reply" };
  const raw = (j as { slices?: unknown }).slices;
  if (!Array.isArray(raw)) return { ok: false, reason: 'the JSON has no "slices" array' };
  if (raw.length < MIN_SLICES) return { ok: false, reason: `a split needs at least ${MIN_SLICES} slices, got ${raw.length}` };
  if (raw.length > MAX_SLICES) return { ok: false, reason: `a split may have at most ${MAX_SLICES} slices, got ${raw.length}` };
  const slices: Slice[] = [];
  const seen = new Set<string>();
  for (const [k, r] of raw.entries()) {
    const at = `slice ${k + 1}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, reason: `${at} is not an object` };
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return { ok: false, reason: `${at}: id must match ${ID_RE.source}` };
    if (seen.has(o.id)) return { ok: false, reason: `duplicate slice id ${o.id}` };
    seen.add(o.id);
    if (typeof o.title !== "string" || !o.title.trim() || o.title.length > 200) return { ok: false, reason: `${o.id}: title must be a non-empty string of at most 200 characters` };
    const acceptance = strList(o.acceptance, 20);
    if (!acceptance || acceptance.length === 0) return { ok: false, reason: `${o.id}: acceptance must be 1-20 non-empty strings` };
    const deps = o.depends_on === undefined ? [] : strList(o.depends_on, MAX_SLICES);
    if (!deps) return { ok: false, reason: `${o.id}: depends_on must be a list of slice ids` };
    const files = o.files === undefined ? [] : strList(o.files, 50);
    if (!files) return { ok: false, reason: `${o.id}: files must be a list of paths` };
    slices.push({ id: o.id, title: oneLine(o.title), acceptance, depends_on: [...new Set(deps)], files });
  }
  for (const s of slices) for (const d of s.depends_on) if (!seen.has(d)) return { ok: false, reason: `${s.id} depends on unknown slice ${d}` };

  // Topological order that keeps the model's own order wherever it is valid: each step takes the first slice whose
  // dependencies are done, so a stack runs bottom to top before the next root. Whatever is left is on a cycle.
  const order: Slice[] = [];
  const done = new Set<string>();
  let rest = [...slices];
  while (rest.length) {
    const next = rest.find((s) => s.depends_on.every((d) => done.has(d)));
    if (!next) return { ok: false, reason: `dependency cycle among ${rest.map((s) => s.id).join(", ")}` };
    order.push(next);
    done.add(next.id);
    rest = rest.filter((s) => s !== next);
  }

  // A stacked PR has one base: the dependency that already contains every other dependency.
  const ancestors = new Map<string, Set<string>>();
  for (const s of order) {
    const a = new Set<string>();
    for (const d of s.depends_on) {
      a.add(d);
      for (const x of ancestors.get(d)!) a.add(x);
    }
    ancestors.set(s.id, a);
  }
  const parent: Record<string, string | null> = {};
  for (const s of order) {
    if (s.depends_on.length === 0) {
      parent[s.id] = null;
      continue;
    }
    const top = s.depends_on.find((d) => s.depends_on.every((o) => o === d || ancestors.get(d)!.has(o)));
    if (!top) return { ok: false, reason: `${s.id} depends on ${s.depends_on.join(" and ")}, which are not on one stack; a stacked PR has one base` };
    parent[s.id] = top;
  }
  return { ok: true, slices: order, parent };
}

export function decomposeBrief(slug: string, i: GhIssue, triageReason: string, outPath: string): string {
  return [
    "You are planning how an autonomous coding agent should deliver one GitHub issue that is too large for a single pull request.",
    `A triage pass judged it too large: ${oneLine(triageReason)}`,
    "Split it into an ordered list of independently verifiable, PR-sized slices. Each slice becomes one pull request, opened as a stack:",
    "a slice that depends on another is built on top of that slice's branch. Prefer a short chain; give a slice several dependencies only when they are already on one chain.",
    "Do not edit, create or delete any repository file. You may read the repository to judge scope.",
    `Write exactly one JSON object to the file ${outPath} and nothing else to that file, in this form:`,
    '{"slices":[{"id":"s1","title":"<short title>","acceptance":["<checkable criterion>"],"depends_on":[],"files":["<path if known>"]}]}',
    `Rules: ${MIN_SLICES}-${MAX_SLICES} slices; id matches ${ID_RE.source}; depends_on lists slice ids; no cycles; files may be empty.`,
    "",
    `Issue ${slug}#${i.number}: ${i.title}`,
    i.labels.length ? `Labels: ${i.labels.join(", ")}` : "",
    "",
    i.body.slice(0, 12000),
  ].join("\n");
}

/** The text of one slice's engine10 run: one paragraph per field, no list or heading lines, so it stays one run. */
export function sliceTask(slug: string, epic: GhIssue, s: Slice, index: number, total: number, parent: string | null): string {
  return [
    `Slice ${s.id} of ${total} for ${slug}#${epic.number}: ${s.title}`,
    `This is slice ${index + 1} of a larger issue that was split into ${total} pull requests. Implement only this slice.` +
      (parent ? ` The branch already contains slice ${parent} and everything it depends on.` : ""),
    `Acceptance criteria: ${s.acceptance.map((a, k) => `(${k + 1}) ${a}`).join("; ")}`,
    s.files.length ? `Likely files: ${s.files.join(", ")}` : "",
    `Parent issue: ${oneLine(epic.title)}`,
  ].filter(Boolean).join("\n\n");
}

export function planComment(triageReason: string, slices: readonly Slice[]): string {
  return [
    `Loki triage: too-large (${oneLine(triageReason)}). Loki split it into ${slices.length} stacked pull requests, run in this order:`,
    "",
    ...slices.map((s, k) => `${k + 1}. ${s.id}: ${s.title}${s.depends_on.length ? ` (after ${s.depends_on.join(", ")})` : ""}`),
  ].join("\n");
}

/** A slice may carry dependents only when it produced a pushed branch with a PR and did not fail or block. */
export const stacksOn = (r: SliceResult | undefined): boolean => !!r && !!r.pr && !!r.branch && !/^(FAILED|BLOCKED|SKIPPED)/.test(r.outcome);

/** Run one epic's slices in order. runSlice gets the parent's run branch (null for a root). */
export async function runEpicSlices(
  d: Extract<Decomposition, { ok: true }>,
  runSlice: (s: Slice, index: number, baseBranch: string | null) => Promise<SliceResult>,
  onSkip: (r: SliceResult) => void,
): Promise<SliceResult[]> {
  const results = new Map<string, SliceResult>();
  for (const [k, s] of d.slices.entries()) {
    const bad = s.depends_on.find((dep) => !stacksOn(results.get(dep)));
    if (bad) {
      const why = results.get(bad)!.outcome.split(/[ ,(]/)[0];
      const r: SliceResult = { id: s.id, title: s.title, parent: d.parent[s.id] ?? null, outcome: `SKIPPED (depends on ${bad}, which was ${why})`, pr: null, cost: "-" };
      results.set(s.id, r);
      onSkip(r);
      continue;
    }
    const p = d.parent[s.id] ?? null;
    results.set(s.id, await runSlice(s, k, p ? results.get(p)!.branch! : null));
  }
  return d.slices.map((s) => results.get(s.id)!);
}

export function renderEpicTree(n: number, title: string, rows: readonly SliceResult[]): string {
  const L = [`### #${n} ${oneLine(title)}`, ""];
  const kids = new Map<string | null, SliceResult[]>();
  for (const r of rows) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
  const walk = (p: string | null, lvl: number): void => {
    for (const r of kids.get(p) ?? []) {
      L.push(`${"  ".repeat(lvl)}- ${r.id} ${r.title}: ${r.outcome}, ${r.pr ?? "no PR"}, ${r.cost}`);
      walk(r.id, lvl + 1);
    }
  };
  walk(null, 0);
  return L.join("\n") + "\n";
}

/** One Opus planning session through the engine's own session runner; returns the JSON text it wrote (or its reply). */
export function makeSessionDecompose(repoDir: string, lokiDir: string, provider: string): (slug: string, issue: GhIssue, triageReason: string) => Promise<string> {
  return async (slug, issue, triageReason) => {
    const { mkdirSync, readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createSessionRunner } = await import("../engine10/session.ts");
    const { envOverride } = await import("../runner/router/decision.ts");
    const dir = join(lokiDir, "issues-run", "decompose");
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `issue-${issue.number}-${Date.now()}.json`);
    const runner = createSessionRunner({ provider, lokiRoot: lokiDir });
    const r = (await runner.run({
      stage: "plan",
      brief: decomposeBrief(slug, issue, triageReason, outPath),
      tier: "planning",
      iterationId: `issues-decompose-${issue.number}-${Date.now()}`,
      limitS: 600,
      signal: new AbortController().signal,
      cwd: repoDir,
      // Opus decides the split (claude only, never over the user's own model override), like the routed plan stage.
      ...(provider === "claude" && envOverride(process.env) === null ? { model: "opus" } : {}),
    })) as { exit: number | null; summary?: string };
    if (existsSync(outPath)) return readFileSync(outPath, "utf8");
    return r.summary ?? "";
  };
}
