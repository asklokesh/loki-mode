// D61 slice 8: deterministic decomposer. Splits a spec into requirement items, maps each to a write set,
// unions units whose write sets overlap, and serializes shared files. Pure: no I/O, no model calls, same input gives a byte-identical DAG. Not wired into any route yet.
import type { RepoMap } from "../engine10/repomap.ts";

export interface DecomposeOpts {
  /** Keyword selection over the repo map (context.ts selectRelevantFiles shape). */
  select: (task: string, map: RepoMap, max: number) => string[];
  /** Package workspace roots (for example "packages/api"); a file inside one belongs to that module. */
  workspaces?: string[];
  maxFilesPerItem?: number;
}
export interface Unit {
  id: string;
  items: string[];
  writeSet: string[];
  modules: string[];
  serialized: string[];
}
export interface Edge { from: string; to: string; via: string }
export interface Dag { units: Unit[]; sharedFiles: string[]; edges: Edge[] }
const SHARED_BASENAME = /^(package\.json|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|poetry\.lock|Pipfile\.lock|requirements\.txt|pyproject\.toml|CHANGELOG(\.md)?|index\.(ts|tsx|js|jsx|mjs)|__init__\.py|mod\.rs)$/i;
const LIST_RE = /^\s*(?:\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?(\S.*)$/;
const HEAD_RE = /^\s{0,3}#{1,6}\s+(\S.*?)\s*#*\s*$/;

export function isSharedFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return SHARED_BASENAME.test(base);
}
/** Requirement items: list lines if any, else headings, else the whole spec as one item. */
export function parseItems(spec: string): string[] {
  const list: string[] = [];
  const heads: string[] = [];
  for (const l of spec.split(/\r?\n/)) {
    const m = LIST_RE.exec(l);
    if (m) { list.push(m[1]!.trim()); continue; }
    const h = HEAD_RE.exec(l);
    if (h) heads.push(h[1]!.trim());
  }
  if (list.length) return list;
  if (heads.length) return heads;
  const t = spec.trim();
  return t ? [t] : [];
}
/** P12-46 large tier, by structure: the task's own lists counted per section. A list item under a solution-like heading or label (Solution,
 *  Implementation, Deliverables, Scope, Requirements, Tasks, Features, Changes, Goals, Plan, TODO) is a part; under an acceptance-like one (Acceptance,
 *  Criteria, Definition of done) it is a criterion, as is a task-list checkbox anywhere else; a list with no heading or label above it counts as parts;
 *  items under any other markdown heading, or under a label naming context (Problem, Steps to reproduce, Expected, Environment), count as nothing.
 *  Only top-level items (indent under 2) count. `stack` is a backend word and a frontend word both present. Large = at least two of: parts >= 4,
 *  criteria >= 4, stack. A declared epic (a label epic, umbrella, tracking or meta) is large on its own. This is the one definition of large:
 *  engine10/sizing.ts sizeTask, commands/issues_run.ts startIssueEpic and the `loki backlog` triage router (features/triage.ts) all call it.
 *  Deterministic and pure: the E-45 sizing path makes no model call, so this only decides whether a split is asked for; the
 *  split itself stays the model's (MASS-2, Engine Law L0). */
export interface Deliverables { parts: number; criteria: number; stack: boolean; large: boolean; reason: string }
const SOLUTION_WORD = /\b(solution|proposal|proposed|implementation|deliverables?|scope|requirements?|tasks?|features?|changes|goals?|plan|todo|work items?)\b/i;
const ACCEPT_WORD = /\b(acceptance|criteria|definition of done|done when)\b/i;
const CONTEXT_WORD = /\b(problem|background|context|motivation|reproduce|steps|expected|actual|observed|environment|notes?|logs?|errors?|trace|screenshots?|current)\b/i;
const LABEL_RE = /^\s{0,3}(?:\*\*|__)?([A-Za-z][\w /&-]{0,60}?)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/;
const kindOf = (t: string): "solution" | "accept" | undefined => (ACCEPT_WORD.test(t) ? "accept" : SOLUTION_WORD.test(t) ? "solution" : undefined);
const BACKEND_WORD = /\b(backend|back-end|server|api|endpoints?|routes?|database|sql|postgres(?:ql)?|mysql|sqlite|migrations?|fastify|express|django|flask|rails|graphql)\b/i;
const FRONTEND_WORD = /\b(frontend|front-end|ui|react|vue|svelte|angular|components?|pages?|css|tailwind|dashboard|autocomplete)\b/i;
export const LARGE_PARTS = 4, LARGE_CRITERIA = 4;
export const EPIC_LABEL_RE = /^(?:epic|umbrella|tracking|meta)$/i;
/** The labels of the issue this engine run works on: the supervisor puts issue.json's labels in LOKI_E10_ISSUE_LABELS (a JSON string array)
 *  for an issue run, so the stages' own sizeTask (plan, Wall, implement) applies the same epic-label signal as triage and startIssueEpic. */
export const ISSUE_LABELS_ENV = "LOKI_E10_ISSUE_LABELS";
export function issueLabelsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  try { const v = JSON.parse(env[ISSUE_LABELS_ENV] ?? "[]") as unknown; return Array.isArray(v) ? v.filter((l): l is string => typeof l === "string") : []; } catch { return []; }
}
export function deliverables(task: string, labels: readonly string[] = issueLabelsFromEnv()): Deliverables {
  let section: "none" | "solution" | "accept" | "other" = "none", parts = 0, criteria = 0;
  for (const l of task.split(/\r?\n/)) {
    const item = LIST_RE.exec(l);
    if (item) {
      if ((/^\s*/.exec(l)?.[0].length ?? 0) >= 2) continue;
      const box = /^\s*(?:\d+[.)]|[-*+])\s+\[[ xX]\]/.test(l);
      if (section === "accept" || (box && section !== "solution")) criteria++;
      else if (section === "solution" || section === "none") parts++;
      continue;
    }
    const head = HEAD_RE.exec(l)?.[1];
    if (head !== undefined) { section = kindOf(head) ?? "other"; continue; }
    const label = /[:*_]\s*$/.test(l) || /^\s*(?:\*\*|__)/.test(l) ? LABEL_RE.exec(l)?.[1] : undefined;
    if (label !== undefined) section = kindOf(label) ?? (CONTEXT_WORD.test(label) ? "other" : section);
  }
  const stack = BACKEND_WORD.test(task) && FRONTEND_WORD.test(task);
  const hits = [parts >= LARGE_PARTS, criteria >= LARGE_CRITERIA, stack].filter(Boolean).length;
  const epic = labels.map((l) => l.trim().toLowerCase()).find((l) => EPIC_LABEL_RE.test(l));
  const structure = `structure: ${parts} solution part(s), ${criteria} acceptance criteria, ${stack ? "backend and frontend" : "one side of the stack"}`;
  return { parts, criteria, stack, large: Boolean(epic) || hits >= 2, reason: epic ? `label ${epic}` : structure };
}
const MS_HEAD_RE = /^\s{0,3}#{1,6}\s+Milestone\s+(\d+)\s*(?:[:.-]\s*(.*?))?\s*#*\s*$/i;
const MS_KEY_RE = /^milestones:\s*$/i;
export interface Milestone { n: number; title: string; body: string }
/** Missions: `## Milestone N[: title]` sections, else a top-level `milestones:` list. Fewer than 2 found returns [] (not a mission). Pure. */
export function parseMilestones(spec: string): Milestone[] {
  const lines = spec.split(/\r?\n/);
  const out: Milestone[] = [];
  let cur: { n: number; title: string; body: string[] } | null = null;
  for (const l of lines) {
    const h = MS_HEAD_RE.exec(l);
    if (h) {
      if (cur) out.push({ n: cur.n, title: cur.title, body: cur.body.join("\n").trim() });
      cur = { n: Number(h[1]), title: (h[2] ?? "").trim(), body: [] };
    } else if (cur) cur.body.push(l);
  }
  if (cur) out.push({ n: cur.n, title: cur.title, body: cur.body.join("\n").trim() });
  if (out.length >= 2) return out.map((m) => ({ ...m, body: m.body || m.title || `Milestone ${m.n}` }));
  const list: Milestone[] = [];
  let inList = false;
  for (const l of lines) {
    if (!inList) { inList = MS_KEY_RE.test(l); continue; }
    const m = LIST_RE.exec(l);
    if (m) { const t = m[1]!.trim(); list.push({ n: list.length + 1, title: t, body: t }); continue; }
    if (l.trim() === "" || /^\s+\S/.test(l)) continue;
    break;
  }
  return list.length >= 2 ? list : [];
}
export function moduleOf(path: string, workspaces: string[]): string {
  const ws = [...workspaces].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).find((w) => path === w || path.startsWith(`${w}/`));
  if (ws) return ws;
  const i = path.indexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}
const uniqSorted = (a: string[]): string[] => [...new Set(a)].sort();

function mentioned(item: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const tok of item.split(/[\s`'"(),;:]+/)) {
    const t = tok.replace(/^\.\//, "").replace(/\.+$/, "");
    if (t && known.has(t)) out.push(t);
  }
  return out;
}
export function decompose(spec: string, map: RepoMap, o: DecomposeOpts): Dag {
  const items = parseItems(spec);
  const known = new Set(map.files);
  const max = o.maxFilesPerItem ?? 8;
  const ws = o.workspaces ?? [];
  const raw = items.map((text) => {
    const files = uniqSorted([...mentioned(text, known), ...o.select(text, map, max).filter((f) => known.has(f))]);
    return { text, files: files.filter((f) => !isSharedFile(f)), shared: files.filter(isSharedFile) };
  });
  // union-find over item indexes; items sharing any write-set file collapse into one unit
  const parent = raw.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const owner = new Map<string, number>();
  raw.forEach((r, i) => {
    for (const f of r.files) {
      const j = owner.get(f);
      if (j === undefined) owner.set(f, i);
      else {
        const a = find(i), b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  // An item that names no file would become a unit with an empty write set, which unit mode refuses (exit 2 before any
  // session). Fold such items into the first unit that owns files; with none, all items form one unit (caller falls back).
  const anchor = raw.findIndex((r) => r.files.length > 0);
  raw.forEach((r, i) => {
    if (r.files.length > 0) return;
    const a = find(i), b = find(anchor < 0 ? 0 : anchor);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  });
  const groups = new Map<number, number[]>();
  raw.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  const ordered = [...groups.keys()].sort((a, b) => a - b);
  const units: Unit[] = ordered.map((root, n) => {
    const idx = groups.get(root)!;
    const writeSet = uniqSorted(idx.flatMap((i) => raw[i]!.files));
    const serialized = uniqSorted(idx.flatMap((i) => raw[i]!.shared));
    return {
      id: `u${n + 1}`,
      items: idx.map((i) => raw[i]!.text),
      writeSet,
      modules: uniqSorted([...writeSet, ...serialized].map((f) => moduleOf(f, ws))),
      serialized,
    };
  });
  const edges: Edge[] = [];
  const sharedFiles = uniqSorted(units.flatMap((u) => u.serialized));
  for (const f of sharedFiles) {
    const users = units.filter((u) => u.serialized.includes(f));
    for (let k = 1; k < users.length; k++) edges.push({ from: users[k - 1]!.id, to: users[k]!.id, via: f });
  }
  const key = (e: Edge): string => `${e.from}\0${e.to}\0${e.via}`;
  edges.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { units, sharedFiles, edges };
}
/** Canonical byte-stable serialization. */
export function dagJson(d: Dag): string {
  return JSON.stringify(d, null, 2);
}
