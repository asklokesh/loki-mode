// Traceability matrix logic (CPE-17): requirement -> plan step -> files changed -> evidence. Pure functions, no I/O.
// Honesty rule: a row is "proven" only when a passing check is linked to it AND the receipt verdict is VERIFIED.
// Everything else (no receipt, no linked check, partial receipt) reads "not proven"; a linked failing check reads "failed".

export type RowStatus = "proven" | "failed" | "not proven";
export interface Check { name: string; cmd?: string; result: string }
export interface Receipt { verdict?: string | null; checks?: Check[]; not_proven?: string[]; wall?: { files?: string[] } }
export interface MatrixRow { criterion: string; steps: string[]; files: string[]; evidence: Check[]; status: RowStatus; note: string | null }
export interface Matrix { rows: MatrixRow[]; unmapped_files: string[]; criteria_source: "checklist" | "title" | "none" }

const STOP = new Set(["that", "this", "with", "from", "when", "should", "must", "will", "have", "into", "then", "than", "each", "which", "their", "there", "about"]);
const tokens = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((t) => !STOP.has(t)));
const overlaps = (a: Set<string>, b: Set<string>): boolean => { for (const t of a) if (b.has(t)) return true; return false; };
const pathTokens = (f: string): Set<string> => tokens(f.replace(/[/.]/g, " "));

export function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Acceptance criteria: checkbox lines, else bullets under an Acceptance/Requirements heading, else the issue title. */
export function criteriaOf(issue: unknown): { list: string[]; source: Matrix["criteria_source"] } {
  const o = (issue && typeof issue === "object" ? issue : {}) as { title?: unknown; body?: unknown };
  const body = typeof o.body === "string" ? o.body : "";
  const lines = body.split(/\r?\n/);
  const boxes = lines.map((l) => /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/.exec(l)?.[1]?.trim()).filter((s): s is string => !!s);
  if (boxes.length) return { list: boxes, source: "checklist" };
  const out: string[] = [];
  let inSection = false;
  for (const l of lines) {
    if (/^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(l)) inSection = /accept|requirement|criteri|expected|done when/i.test(l);
    else if (inSection) { const m = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l); if (m?.[1]) out.push(m[1].trim()); }
  }
  if (out.length) return { list: out, source: "checklist" };
  const title = typeof o.title === "string" ? o.title.trim() : "";
  return title ? { list: [title], source: "title" } : { list: [], source: "none" };
}

export interface PlanStep { text: string; files: string[]; criterion?: string }

/** plan.json is tolerated in several shapes: an array, or { steps | plan }, of strings or objects. */
export function stepsOf(plan: unknown): PlanStep[] {
  const o = plan as { steps?: unknown; plan?: unknown } | null;
  const arr = Array.isArray(plan) ? plan : Array.isArray(o?.steps) ? o.steps : Array.isArray(o?.plan) ? o.plan : typeof o?.plan === "string" ? o.plan.split(/\r?\n/).filter((l) => l.trim()) : [];
  const out: PlanStep[] = [];
  for (const s of arr as unknown[]) {
    if (typeof s === "string") { const t = s.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim(); if (t) out.push({ text: t, files: [] }); continue; }
    if (s && typeof s === "object") {
      const r = s as Record<string, unknown>;
      const text = [r.title, r.step, r.description, r.text].find((v): v is string => typeof v === "string" && v.trim() !== "");
      if (!text) continue;
      const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string") : [];
      out.push({ text: text.trim(), files, ...(typeof r.criterion === "string" ? { criterion: r.criterion } : {}) });
    }
  }
  return out;
}

/** File paths from a unified diff ("diff --git a/x b/x"). */
export function diffFiles(patch: string | null): string[] {
  if (!patch) return [];
  const set = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) set.add(m[2]!);
  return [...set];
}

export function buildMatrix(input: { issue: unknown; plan: unknown; receipt: Receipt | null; changedFiles: string[] }): Matrix {
  const { list, source } = criteriaOf(input.issue);
  const steps = stepsOf(input.plan);
  const checks = input.receipt?.checks ?? [];
  const verified = input.receipt?.verdict === "VERIFIED";
  const changed = [...new Set([...input.changedFiles, ...(input.receipt?.wall?.files ?? [])])];
  const used = new Set<string>();

  const rows = list.map((criterion): MatrixRow => {
    const ct = tokens(criterion);
    const mine = steps.filter((s) => (s.criterion ? s.criterion.trim() === criterion : overlaps(ct, tokens(s.text))));
    const files = new Set<string>();
    for (const s of mine) {
      for (const f of s.files) files.add(f);
      const st = tokens(s.text);
      for (const f of changed) if (overlaps(st, pathTokens(f))) files.add(f);
    }
    for (const f of changed) if (overlaps(ct, pathTokens(f))) files.add(f);
    const fileList = [...files];
    fileList.forEach((f) => used.add(f));
    const evidence = checks.filter((c) => {
      const t = tokens(`${c.name} ${c.cmd ?? ""}`);
      return overlaps(ct, t) || fileList.some((f) => overlaps(pathTokens(f), t));
    });
    let status: RowStatus = "not proven";
    let note: string | null = null;
    if (!input.receipt) note = "no receipt for this run";
    else if (evidence.some((c) => c.result === "fail")) { status = "failed"; note = "a linked check failed"; }
    else if (evidence.length === 0) note = "no check linked to this criterion";
    else if (!evidence.every((c) => c.result === "pass")) note = "a linked check did not run";
    else if (!verified) note = `receipt verdict is ${input.receipt.verdict ?? "unknown"}`;
    else status = "proven";
    return { criterion, steps: mine.map((s) => s.text), files: fileList, evidence, status, note };
  });
  return { rows, unmapped_files: changed.filter((f) => !used.has(f)), criteria_source: source };
}
