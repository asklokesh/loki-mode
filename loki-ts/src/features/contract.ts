// D65-SPEC (ROADMAP-D63 pillar 6): spec to delivery contract. On by default; LOKI_CONTRACT=0 turns it off.
// parseContract turns a spec/PRD markdown into acceptance criteria; traceContract maps each criterion
// to changed files and checks by keyword overlap. The `loki contract <spec.md>` subcommand prints the
// contract and writes .loki/contract.json. The receipt field is strictly additive (seal.ts).
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { atomicWriteJson } from "../util/atomic.ts";
import { parseSpec } from "../util/spec_file.ts";
import { REPO_ROOT } from "../util/paths.ts";
import { safeGit } from "../util/safe_git.ts";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Unit } from "./decompose.ts";
export interface Criterion { id: string; text: string; source_line: number }
export interface Contract { source: string; criteria: Criterion[]; constraints?: Constraint[] }
export const CONSTRAINT_KINDS = ["perf", "api", "security"] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];
/** P12-43: a typed constraint, traced to the Wall case ids that prove it. */
export interface Constraint { id: string; kind: ConstraintKind; text: string; wall_cases: string[] }
export interface TracedCriterion { id: string; text: string; files: string[]; checks: string[]; status: "keyword_match" | "no_match" }
export interface ContractTrace { criteria: TracedCriterion[]; sha256?: string }
export const MAX_CRITERIA = 50;
export const MAX_TEXT = 500;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const SECTION = /(acceptance\s+criteria|requirements?|must(\s+have)?)\b/i;
const CHECKLIST = /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
export function contractEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_CONTRACT"] !== "0";
}
function clean(s: string): string {
  return s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
}
export function parseContract(markdown: string, source = ""): Contract {
  const found: { text: string; line: number }[] = [];
  const seen = new Set<string>();
  const add = (raw: string, line: number): void => {
    const text = clean(raw);
    const key = text.toLowerCase();
    if (text.length < 3 || seen.has(key) || found.length >= MAX_CRITERIA) return;
    seen.add(key);
    found.push({ text, line });
  };
  let inSection = false;
  let sectionLevel = 0;
  let inFence = false;
  markdown.split(/\r?\n/).forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = HEADING.exec(ln);
    if (h) {
      const level = ln.trimStart().match(/^#+/)![0].length;
      if (SECTION.test(h[1]!)) { inSection = true; sectionLevel = level; }
      else if (inSection && level <= sectionLevel) inSection = false;
      return;
    }
    const c = CHECKLIST.exec(ln);
    if (c) { add(c[1]!, i + 1); return; }
    if (inSection) {
      const b = BULLET.exec(ln);
      if (b) add(b[1]!, i + 1);
    }
  });
  return { source, criteria: found.map((f, n) => ({ id: `AC-${n + 1}`, text: f.text, source_line: f.line })) };
}
// CONTRACT (v11.7.0): per-unit acceptance for a parallel group. Criteria are frozen to .loki/groups/<id>/contract.json before any
// worker spawns; a criterion no unit owns fails the group closed (nothing is spawned, nothing is guessed).
export interface GroupContract { group: string; units: { id: string; criteria: Criterion[] }[]; orphans: Criterion[] }
const norm = (s: string): string => clean(s).toLowerCase();
/** A criterion belongs to every unit one of whose items equals it or contains it (or is contained by it), after cleaning. Exact text only: no keyword guessing. */
export function assignCriteria(units: Pick<Unit, "id" | "items">[], criteria: Criterion[]): { units: { id: string; criteria: Criterion[] }[]; orphans: Criterion[] } {
  const owned = new Set<string>();
  const out = units.map((u) => {
    const items = u.items.map(norm).filter((i) => i.length >= 3);
    const mine = criteria.filter((c) => { const t = norm(c.text); return items.some((i) => i === t || i.includes(t) || t.includes(i)); });
    for (const c of mine) owned.add(c.id);
    return { id: u.id, criteria: mine };
  });
  return { units: out, orphans: criteria.filter((c) => !owned.has(c.id)) };
}
export function groupContractPath(repoDir: string, groupId: string): string {
  return join(repoDir, ".loki", "groups", groupId.replace(/[^A-Za-z0-9._-]/g, "_"), "contract.json");
}
/** Assign, then write the frozen group contract atomically. ok false (nothing written) when any criterion is orphaned. */
export function freezeGroupContract(repoDir: string, groupId: string, units: Pick<Unit, "id" | "items">[], contract: Contract): { ok: true; path: string; contract: GroupContract } | { ok: false; reason: string; orphans: Criterion[] } {
  const a = assignCriteria(units, contract.criteria);
  if (a.orphans.length > 0) return { ok: false, reason: `NOT PROVEN: group contract has ${a.orphans.length} criterion owned by no unit: ${a.orphans.map((o) => `${sanitizeCriterion(o.id)} ${sanitizeCriterion(o.text)}`).join("; ")}`, orphans: a.orphans };
  const gc: GroupContract = { group: groupId, units: a.units, orphans: [] };
  const path = groupContractPath(repoDir, groupId);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, gc);
  return { ok: true, path, contract: gc };
}
/** Freeze first, then call launch with each unit's own criteria. A failed freeze never calls spawn. */
export async function spawnWithContract<T>(repoDir: string, groupId: string, units: Pick<Unit, "id" | "items">[], contract: Contract, launch: (unitId: string, acceptance: string[]) => Promise<T> | T): Promise<{ ok: true; results: T[] } | { ok: false; reason: string }> {
  const f = freezeGroupContract(repoDir, groupId, units, contract);
  if (!f.ok) return { ok: false, reason: f.reason };
  const results: T[] = [];
  for (const u of f.contract.units) results.push(await launch(u.id, u.criteria.map((c) => c.text)));
  return { ok: true, results };
}
/** Problems with typed constraints, empty when valid: known kind, and at least one wall case id that exists in wallCaseIds. */
export function validateConstraints(constraints: Constraint[], wallCaseIds: Iterable<string>): string[] {
  const known = new Set(wallCaseIds);
  const errs: string[] = [];
  for (const c of constraints) {
    const id = sanitizeCriterion(String(c.id));
    if (!(CONSTRAINT_KINDS as readonly string[]).includes(c.kind)) errs.push(`constraint ${id} has unknown kind ${sanitizeCriterion(String(c.kind))}`);
    if (!Array.isArray(c.wall_cases) || c.wall_cases.length === 0) { errs.push(`constraint ${id} names no wall case id`); continue; }
    const missing = c.wall_cases.filter((w) => !known.has(w));
    if (missing.length > 0) errs.push(`constraint ${id} names unknown wall case id: ${missing.map(sanitizeCriterion).join(", ")}`);
  }
  return errs;
}
const STOP = new Set(["the", "and", "for", "with", "that", "this", "must", "should", "shall", "when", "then", "are", "was", "all", "any", "can", "not", "has", "have", "from", "into", "each", "user", "users"]);
function words(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}
function overlaps(criterionWords: string[], target: string): boolean {
  const tw = new Set(words(target));
  return criterionWords.some((w) => tw.has(w) || (w.length > 4 && w.endsWith("s") && tw.has(w.slice(0, -1))));
}
/** Simple keyword overlap between criterion text and changed file paths / check names. */
export function traceContract(contract: Contract, changedFiles: string[], checkNames: string[]): ContractTrace {
  return {
    criteria: contract.criteria.map((c) => {
      const cw = words(c.text);
      const files = changedFiles.filter((f) => overlaps(cw, f));
      const checks = checkNames.filter((n) => overlaps(cw, n));
      // Checks only count together with a changed file: a generic check name alone proves nothing.
      const traced = files.length > 0;
      return { id: c.id, text: c.text, files, checks: traced ? checks : [], status: traced ? "keyword_match" : "no_match" } as TracedCriterion;
    }),
  };
}
/** Criterion text is spec-derived and lands in the receipt and PR body: collapse control chars, escape
 *  <, > and #, strip backticks, cap length (same shape as seal.ts sanitizeReason, E-120). */
export function sanitizeCriterion(s: string): string {
  const collapsed = s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const capped = collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT)}...` : collapsed;
  return capped.replace(/`/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/#/g, "&#35;");
}
export function untracedLines(trace: ContractTrace): string[] {
  return trace.criteria.filter((c) => c.status === "no_match").map((c) => `contract ${sanitizeCriterion(c.id)} untraced (no keyword match in changed files): ${sanitizeCriterion(c.text)}`);
}
export function contractPath(repoDir: string): string {
  return join(repoDir, ".loki", "contract.json");
}
export const MAX_CONTRACT_BYTES = 1024 * 1024;
export interface ContractRead { contract: Contract | null; notes: string[]; sha256: string | null }
/** The contract as intake saw it (D65-SPEC-F2): sha256 of the raw file bytes (null when no readable file), the parsed contract, and read notes. */
export type ContractSnapshot = ContractRead
/** Read .loki/contract.json safely: lstat first so a FIFO, directory, symlink or device is never opened
 *  (a FIFO would block the event loop forever), cap the size, and report why a contract is unusable. */
export function readContract(repoDir: string): ContractRead {
  const p = contractPath(repoDir);
  let st;
  try { st = lstatSync(p); } catch { return { contract: null, notes: [], sha256: null }; }
  if (!st.isFile()) return { contract: null, notes: ["contract unreadable: not a regular file"], sha256: null };
  if (st.size > MAX_CONTRACT_BYTES) return { contract: null, notes: ["contract unreadable: too large"], sha256: null };
  let raw: Buffer;
  try { raw = readFileSync(p); } catch { return { contract: null, notes: ["contract unreadable: read failed"], sha256: null }; }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let j: { source?: unknown; criteria?: unknown } | null;
  try {
    j = JSON.parse(raw.toString("utf8")) as { source?: unknown; criteria?: unknown } | null;
  } catch {
    return { contract: null, notes: ["contract unreadable: invalid JSON"], sha256 };
  }
  if (!Array.isArray(j?.criteria)) return { contract: null, notes: [], sha256 };
  const criteria: Criterion[] = [];
  let malformed = 0;
  for (const c of j.criteria as unknown[]) {
    const o = c as { id?: unknown; text?: unknown; source_line?: unknown } | null;
    if (typeof o?.id !== "string" || typeof o.text !== "string" || o.id === "" || o.text === "") { malformed++; continue; }
    if (criteria.length >= MAX_CRITERIA) continue;
    criteria.push({ id: o.id.slice(0, 40), text: o.text.slice(0, MAX_TEXT), source_line: typeof o.source_line === "number" ? o.source_line : 0 });
  }
  const notes = malformed > 0 ? [`contract: ${malformed} malformed criteria dropped`] : [];
  return { contract: { source: typeof j.source === "string" ? j.source : "", criteria }, notes, sha256 };
}
/** Intake hook (D65-SPEC-F2): freeze the contract before the implement session can edit it. undefined when LOKI_CONTRACT=0. */
export function snapshotContract(repoDir: string, env: NodeJS.ProcessEnv = process.env): ContractSnapshot | undefined {
  if (!contractEnabled(env)) return undefined;
  try { return readContract(repoDir); } catch { return { contract: null, notes: ["contract unreadable: snapshot failed"], sha256: null }; }
}
export function loadContract(repoDir: string): Contract | null {
  return readContract(repoDir).contract;
}
export function renderContract(c: Contract): string {
  if (c.criteria.length === 0) return "No acceptance criteria found.\n";
  return `${c.criteria.map((x) => `${x.id}  ${x.text}  (line ${x.source_line})`).join("\n")}\n`;
}
/** seal reads ctx.repoDir/.loki/contract.json, so write to the repo root, not the bare cwd. */
export function repoRoot(cwd: string): string {
  let top = "";
  try { top = safeGit(cwd, ["rev-parse", "--show-toplevel"]).trim(); } catch { /* not a repo */ }
  return top !== "" ? top : cwd;
}
export function main(args: string[]): number {
  const file = args[0];
  if (!contractEnabled()) { process.stderr.write("contract: disabled by LOKI_CONTRACT=0\n"); return 2; }
  if (!file || file === "--help" || file === "-h") {
    process.stderr.write("Usage: loki contract <spec.md>   print the delivery contract and write .loki/contract.json (traced at run end unless LOKI_CONTRACT=0)\n");
    return file ? 0 : 2;
  }
  if (!existsSync(file)) { process.stderr.write(`contract: no such file: ${file}\n`); return 2; }
  const contract = parseContract(readFileSync(file, "utf8"), file);
  const out = contractPath(repoRoot(process.cwd()));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(contract, null, 2) + "\n");
  process.stdout.write(renderContract(contract));
  return 0;
}
/** Seal hook: unless LOKI_CONTRACT=0, trace the contract frozen at intake (never the live file, D65-SPEC-F2), attach the optional
 *  `contract` field to the receipt body (additive) and return NOT PROVEN lines: untraced criteria plus any change made to the file
 *  after intake. Advisory only, never changes the verdict. */
export function sealContract(repoDir: string, body: object, rawDiff: string[], checks: { name: string }[], env: NodeJS.ProcessEnv = process.env, snap?: ContractSnapshot): string[] {
  if (!contractEnabled(env)) return [];
  try {
    const live = readContract(repoDir);
    let exists = true;
    try { lstatSync(contractPath(repoDir)); } catch { exists = false; }
    if (!snap) return exists ? ["contract not snapshotted at intake; ignored"] : [];
    const drift: string[] = [];
    if (snap.sha256 !== null) {
      const short = (h: string | null): string => (h === null ? "unreadable" : h.slice(0, 12));
      if (!exists) drift.push("contract removed after intake; traced the intake copy");
      else if (live.sha256 !== snap.sha256) drift.push(`contract changed after intake (sha ${short(snap.sha256)} -> ${short(live.sha256)}); traced the intake copy`);
    } else if (exists && (snap.notes.length === 0 || live.sha256 !== null)) drift.push("contract created after intake; ignored");
    const ct = snap.contract;
    if (!ct) return [...snap.notes, ...drift];
    const trace = traceContract(ct, rawDiff.filter((_, i) => i % 2 === 1), checks.map((c) => c.name));
    (body as { contract?: ContractTrace }).contract = { ...trace, ...(snap.sha256 ? { sha256: snap.sha256 } : {}) };
    return [...snap.notes, ...drift, ...untracedLines(trace)];
  } catch (e) {
    delete (body as { contract?: ContractTrace }).contract;
    return [`contract trace failed: ${sanitizeCriterion(e instanceof Error ? e.message : String(e))}`];
  }
}
// REQTRACE: requirement-to-check map, .loki/state/requirements-map.json. Requirements come from existing extractors only:
// the PRD checklist (.loki/checklist/checklist.json), a loki-spec file (spec_file.ts parseSpec), or the requirements_contract.py
// unit extractor. Checks are what actually ran. A requirement is covered only by a check that ran and passed. Doc: docs/spec-first-intent.md.
export interface Requirement { id: string; text: string; links: string[] }
export interface RanCheck { id: string; label: string; passed: boolean }
export interface MapEntry { id: string; text: string; checks: string[]; status: "covered" | "uncovered"; method: "explicit" | "heuristic" }
export interface RequirementsMap { version: 1; revision: string; requirements: MapEntry[] }
const REQ_STOP = new Set(["with", "that", "this", "from", "have", "will", "should", "must", "when", "then", "into", "each", "every", "user", "users", "page", "able", "allow", "support", "ensure", "using", "their", "there", "which", "shall"]);
const MAX_REQ = 40, MIN_REQ_CHARS = 12;
const LINK_RE = /\s*\[checks?:\s*([^\]]+)\]\s*$/i;
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !REQ_STOP.has(t)));
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
  const mapPath = join(lokiDir, "state", "requirements-map.json");
  if (!reqs || reqs.length === 0) { try { rmSync(mapPath, { force: true }); } catch { /* best effort */ } return null; } // a prior run's map must never read as this run's
  const last = new Map<string, RanCheck>();
  for (const e of events) if (e.type === "test.result" && typeof e.data.name === "string") {
    const name = e.data.name, cmd = typeof e.data.cmd === "string" ? e.data.cmd : "";
    last.set(name, { id: name, label: cmd, passed: e.data.result === "pass" });
  }
  const m = writeRequirementsMap(repoDir, lokiDir, reqs, [...last.values()]);
  if (!m) { try { rmSync(mapPath, { force: true }); } catch { /* best effort */ } }
  return m;
}
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
