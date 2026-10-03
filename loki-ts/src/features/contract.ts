// D65-SPEC (ROADMAP-D63 pillar 6): spec to delivery contract. Behind LOKI_CONTRACT=1 (off by default).
// parseContract turns a spec/PRD markdown into acceptance criteria; traceContract maps each criterion
// to changed files and checks by keyword overlap. The `loki contract <spec.md>` subcommand prints the
// contract and writes .loki/contract.json. The receipt field is strictly additive (seal.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Criterion { id: string; text: string; source_line: number }
export interface Contract { source: string; criteria: Criterion[] }
export interface TracedCriterion { id: string; text: string; files: string[]; checks: string[]; status: "traced" | "untraced" }
export interface ContractTrace { criteria: TracedCriterion[] }

export const MAX_CRITERIA = 50;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const SECTION = /(acceptance\s+criteria|requirements?|must(\s+have)?)\b/i;
const CHECKLIST = /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

export function contractEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["LOKI_CONTRACT"] === "1";
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
      return { id: c.id, text: c.text, files, checks: traced ? checks : [], status: traced ? "traced" : "untraced" } as TracedCriterion;
    }),
  };
}

export function untracedLines(trace: ContractTrace): string[] {
  return trace.criteria.filter((c) => c.status === "untraced").map((c) => `contract ${c.id} untraced: ${c.text}`);
}

export function contractPath(repoDir: string): string {
  return join(repoDir, ".loki", "contract.json");
}

export function loadContract(repoDir: string): Contract | null {
  const p = contractPath(repoDir);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Contract;
    return Array.isArray(j?.criteria) ? j : null;
  } catch {
    return null;
  }
}

export function renderContract(c: Contract): string {
  if (c.criteria.length === 0) return "No acceptance criteria found.\n";
  return `${c.criteria.map((x) => `${x.id}  ${x.text}  (line ${x.source_line})`).join("\n")}\n`;
}

export function main(args: string[]): number {
  const file = args[0];
  if (!contractEnabled()) { process.stderr.write("contract: set LOKI_CONTRACT=1 to use spec to contract (off by default)\n"); return 2; }
  if (!file || file === "--help" || file === "-h") {
    process.stderr.write("Usage: loki contract <spec.md>   print the delivery contract and write .loki/contract.json (trace at run end with LOKI_CONTRACT=1)\n");
    return file ? 0 : 2;
  }
  if (!existsSync(file)) { process.stderr.write(`contract: no such file: ${file}\n`); return 2; }
  const contract = parseContract(readFileSync(file, "utf8"), file);
  const out = contractPath(process.cwd());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(contract, null, 2) + "\n");
  process.stdout.write(renderContract(contract));
  return 0;
}

/** Seal hook: when LOKI_CONTRACT=1 and .loki/contract.json exists, attach the optional `contract` field
 *  to the receipt body (additive) and return the untraced criteria lines for the PR body NOT PROVEN list. */
export function sealContract(repoDir: string, body: object, rawDiff: string[], checks: { name: string }[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (!contractEnabled(env)) return [];
  const ct = loadContract(repoDir);
  if (!ct) return [];
  const trace = traceContract(ct, rawDiff.filter((_, i) => i % 2 === 1), checks.map((c) => c.name));
  (body as { contract?: ContractTrace }).contract = trace;
  return untracedLines(trace);
}
