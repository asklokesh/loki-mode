// REQTRACE: requirement-to-check map, .loki/state/requirements-map.json. Contract: docs/contracts/requirements.md.
// Requirements come from existing extractors only: the PRD checklist (.loki/checklist/checklist.json), a loki-spec file
// (spec_file.ts parseSpec), or the requirements_contract.py unit extractor. Checks are what actually ran: checklist
// verification entries, or engine10 test.result events. A requirement is covered only by a check that ran and passed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteJson } from "./atomic.ts";
import { parseSpec } from "./spec_file.ts";
import { REPO_ROOT } from "./paths.ts";
import { safeGit } from "./safe_git.ts";

export const REQ_MAP_REL = join(".loki", "state", "requirements-map.json");
export interface Requirement { id: string; text: string; links: string[] }
export interface RanCheck { id: string; label: string; passed: boolean }
export interface MapEntry { id: string; text: string; checks: string[]; status: "covered" | "uncovered"; method: "explicit" | "heuristic" }
export interface RequirementsMap { version: 1; revision: string; requirements: MapEntry[] }

const STOP = new Set(["with", "that", "this", "from", "have", "will", "should", "must", "when", "then", "into", "each", "every", "user", "users", "page", "able", "allow", "support", "ensure", "using", "their", "there", "which", "shall"]);
const MAX_REQ = 40, MIN_REQ_CHARS = 12;
const LINK_RE = /\s*\[checks?:\s*([^\]]+)\]\s*$/i;

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t)));
}

/** Splits a trailing "[check: a, b]" annotation (explicit link) from a requirement text. */
export function splitLinks(raw: string): { text: string; links: string[] } {
  const m = LINK_RE.exec(raw);
  if (!m) return { text: raw.trim(), links: [] };
  return { text: raw.slice(0, m.index).trim(), links: m[1]!.split(",").map((x) => x.trim()).filter(Boolean) };
}

const numbered = (texts: string[]): Requirement[] => texts.map((t, i) => ({ id: `R${i + 1}`, ...splitLinks(t) }));

/** Requirements from a loki-spec file's acceptance criteria. Null when the text is not a spec. */
export function fromSpecText(raw: string): Requirement[] | null {
  try { const r = numbered(parseSpec(raw).criteria); return r.length ? r : null; } catch { return null; }
}

/** Requirements from PRD or task text, via the existing requirements_contract.py extractor. Fewer than 2 units (a one-line brief) is not a PRD: null. */
export function fromPrdText(text: string, python = "python3"): Requirement[] | null {
  const script = join(REPO_ROOT, "autonomy", "lib", "requirements_contract.py");
  if (!existsSync(script)) return null;
  const code = "import sys,json,importlib.util as u\ns=u.spec_from_file_location('rc',sys.argv[1]);m=u.module_from_spec(s);sys.modules['rc']=m;s.loader.exec_module(m)\nprint(json.dumps(m.extract_bound_requirement_units(sys.stdin.read())))";
  const r = spawnSync(python, ["-I", "-c", code, script], { input: text, encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH ?? "", LC_ALL: "C.UTF-8" } });
  if (r.status !== 0) return null;
  let units: unknown;
  try { units = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(units)) return null;
  const kept = units.filter((u): u is string => typeof u === "string" && u.length >= MIN_REQ_CHARS && u.length <= 400).slice(0, MAX_REQ);
  return kept.length >= 2 ? numbered(kept) : null;
}

/** Pure mapping. Explicit link ids win; otherwise at least 2 shared significant words (or all of them when the requirement has one) between the requirement and a passing check's label. */
export function mapRequirements(reqs: Requirement[], ran: RanCheck[], revision: string): RequirementsMap {
  const byId = new Map(ran.map((c) => [c.id, c] as const));
  const out: MapEntry[] = reqs.map((r) => {
    if (r.links.length) {
      const hit = r.links.filter((l) => byId.get(l)?.passed === true);
      return { id: r.id, text: r.text, checks: hit, status: hit.length ? "covered" : "uncovered", method: "explicit" };
    }
    const rt = tokens(r.text), need = Math.min(2, rt.size);
    const hit = need === 0 ? [] : ran.filter((c) => {
      if (!c.passed) return false;
      const ct = tokens(`${c.id} ${c.label}`);
      let n = 0; for (const t of rt) if (ct.has(t)) n++;
      return n >= need;
    }).map((c) => c.id);
    return { id: r.id, text: r.text, checks: hit, status: hit.length ? "covered" : "uncovered", method: "heuristic" };
  });
  return { version: 1, revision, requirements: out };
}

/** Checklist source: every item is an explicit requirement, every verification entry a check; only passed === true counts. */
export function fromChecklist(lokiDir: string): { reqs: Requirement[]; ran: RanCheck[] } | null {
  const p = join(lokiDir, "checklist", "checklist.json");
  if (!existsSync(p)) return null;
  let doc: { categories?: { items?: Record<string, unknown>[] }[] };
  try { doc = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  const reqs: Requirement[] = [], ran: RanCheck[] = [];
  for (const cat of doc.categories ?? []) for (const it of cat.items ?? []) {
    const id = String(it.id ?? ""), title = String(it.title ?? "").trim();
    if (!id || !title) continue;
    const ver = Array.isArray(it.verification) ? (it.verification as Record<string, unknown>[]) : [];
    const links = ver.map((v, i) => `${id}:${String(v.type ?? "check")}:${i + 1}`);
    ver.forEach((v, i) => { if (v.passed === true || v.passed === false) ran.push({ id: links[i]!, label: title, passed: v.passed === true }); });
    reqs.push({ id: `R${reqs.length + 1}`, text: title, links: links.length ? links : [`${id}:none`] });
  }
  return reqs.length ? { reqs, ran } : null;
}

export function currentRevision(repoDir: string): string {
  try { return safeGit(repoDir, ["rev-parse", "HEAD"]).trim(); } catch { return "unknown"; }
}

/** Writes the map and returns it; null (nothing written, never a throw) when there is no requirement source. */
export function writeRequirementsMap(repoDir: string, lokiDir: string, reqs: Requirement[] | null, ran: RanCheck[]): RequirementsMap | null {
  try {
    if (!reqs || reqs.length === 0) return null;
    const m = mapRequirements(reqs, ran, currentRevision(repoDir));
    atomicWriteJson(join(lokiDir, "state", "requirements-map.json"), m);
    return m;
  } catch { return null; }
}

/** Runner and legacy-shaped runs: the checklist is both the requirement source and the check record. */
export function writeFromChecklist(repoDir: string, lokiDir: string): RequirementsMap | null {
  const c = fromChecklist(lokiDir);
  return c ? writeRequirementsMap(repoDir, lokiDir, c.reqs, c.ran) : null;
}

/** engine10: spec snapshot criteria, else multi-unit task text; checks are the run's test.result events. */
export function writeFromEngine10(repoDir: string, lokiDir: string, runDir: string, task: string | null, events: { type: string; data: Record<string, unknown> }[]): RequirementsMap | null {
  let reqs: Requirement[] | null = null;
  const snap = join(runDir, "spec.snapshot.md");
  if (existsSync(snap)) { try { reqs = fromSpecText(readFileSync(snap, "utf8")); } catch { reqs = null; } }
  if (!reqs && task) reqs = fromPrdText(task);
  if (!reqs) return null;
  const last = new Map<string, RanCheck>();
  for (const e of events) if (e.type === "test.result" && typeof e.data.name === "string") {
    const name = e.data.name, cmd = typeof e.data.cmd === "string" ? e.data.cmd : "";
    last.set(name, { id: name, label: cmd, passed: e.data.result === "pass" });
  }
  return writeRequirementsMap(repoDir, lokiDir, reqs, [...last.values()]);
}

export function uncoveredCount(m: RequirementsMap | null): number { return m ? m.requirements.filter((r) => r.status === "uncovered").length : 0; }

/** Reads the written map for the summary line; null when absent or malformed. */
export function readRequirementsMap(lokiDir: string): RequirementsMap | null {
  try {
    const m = JSON.parse(readFileSync(join(lokiDir, "state", "requirements-map.json"), "utf8")) as RequirementsMap;
    return m.version === 1 && Array.isArray(m.requirements) ? m : null;
  } catch { return null; }
}

export function renderRequirementsMap(m: RequirementsMap): string {
  const cov = m.requirements.filter((r) => r.status === "covered").length;
  const lines = [`Requirements: ${cov}/${m.requirements.length} covered (revision ${m.revision.slice(0, 12)})`];
  for (const r of m.requirements) lines.push(`  ${r.id} ${r.status.padEnd(9)} ${r.method.padEnd(9)} ${r.text.slice(0, 80)}${r.checks.length ? `  <- ${r.checks.join(", ")}` : ""}`);
  return `${lines.join("\n")}\n`;
}
