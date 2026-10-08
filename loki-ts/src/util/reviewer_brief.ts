// T4 (11.3.0): "Reviewer brief" section of the PR body. Data only: it reads git, the repo's import
// graph and an lcov file if one exists, and never runs tests or a provider. Opt out with
// LOKI_REVIEWER_BRIEF=0 (the PR body is then byte-identical to before). Coverage is reported only
// from a real lcov file that is not older than the changed files; nothing is inferred from names.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { listRepoFiles } from "../engine10/repomap.ts";
import { safeGit } from "./safe_git.ts";

export const reviewerBriefEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_REVIEWER_BRIEF"] !== "0";

const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;
const MAX_READ = 200_000;
const LCOV_PATHS = ["coverage/lcov.info", "loki-ts/coverage/lcov.info"];

export interface BriefInput {
  repoDir: string;
  baseSha: string;
  plan?: string | null;
  /** V2: recorded seal/plan facts; when given, the decision block leads the brief. */
  facts?: BriefFacts;
}

/** A plan-model-declared risk (plan-scope.json "risky_hunks"). Ranking uses `risk` only, never wording. */
export interface RiskDecl { path: string; risk: number; why: string; line?: number }
export interface BriefFacts {
  runId: string;
  verdict?: string;
  receiptSha256?: string | null;
  /** Parsed receipt.json subset; undefined when the receipt could not be read. */
  receipt?: { checks?: { name?: string; result?: string }[]; mutation_proof?: string; not_proven?: string[] };
  /** The plan's intent card lines; null/undefined when none was recorded. */
  intentCard?: string[] | null;
  /** Files the plan declared (plan-scope.json "files"); null/undefined when none was recorded. */
  declaredFiles?: string[] | null;
  risks?: RiskDecl[] | null;
}

const NR = "NOT RECORDED";
const oneLine = (t: string, n = 100): string => t.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, n);

/** Parses the model-declared risks from plan-scope.json content; null when none are well-formed. */
export function parseRiskDecls(j: unknown): RiskDecl[] | null {
  const raw = (j as { risky_hunks?: unknown } | null)?.risky_hunks;
  if (!Array.isArray(raw)) return null;
  const out: RiskDecl[] = [];
  for (const r of raw) {
    const e = r as { path?: unknown; risk?: unknown; why?: unknown; line?: unknown } | null;
    if (!e || typeof e.path !== "string" || e.path.trim() === "" || typeof e.risk !== "number" || !Number.isFinite(e.risk)) continue;
    out.push({ path: e.path.trim().replace(/^\.\//, ""), risk: e.risk, why: typeof e.why === "string" ? oneLine(e.why) : "", ...(typeof e.line === "number" && Number.isInteger(e.line) ? { line: e.line } : {}) });
  }
  return out.length ? out : null;
}

/** The decision block: verdict, where to look, proven vs not, out-of-scope files, verify command. Every line is a recorded fact or NOT RECORDED. */
export function leadBlock(repoDir: string, baseSha: string, f: BriefFacts): string {
  const out: string[] = ["## Reviewer brief"];
  const lines = baseSha ? changedLines(repoDir, baseSha) : null;
  const rc = f.receipt;
  out.push(`Verdict: ${f.verdict ? `${f.verdict} (seal receipt ${f.receiptSha256 ? f.receiptSha256.slice(0, 12) : NR})` : NR}`);

  const shown: string[] = [];
  if (lines && f.risks) {
    const ranked = f.risks.filter((r) => lines.has(r.path)).map((r, i) => ({ r, i })).sort((a, b) => b.r.risk - a.r.risk || a.i - b.i);
    for (const { r } of ranked.slice(0, 3)) {
      const nums = lines.get(r.path) ?? [];
      const ln = r.line !== undefined && nums.includes(r.line) ? r.line : nums[0];
      shown.push(`- ${r.path}${ln === undefined ? "" : `:${ln}`} (risk ${r.risk})${r.why ? `: ${r.why}` : ""}`);
    }
  }
  if (shown.length) out.push("Look here first (risk as declared by the plan model):", ...shown);
  else out.push(`Look here first: ${NR} (no model-declared risk)`);

  out.push("Proven:");
  const checks = rc?.checks;
  if (!Array.isArray(checks)) out.push(`- checks run: ${NR}`);
  else {
    const n = (k: string): number => checks.filter((c) => c.result === k).length;
    out.push(checks.length === 0 ? "- checks run: 0" : `- checks run: ${checks.length} (${n("pass")} pass, ${n("fail")} fail, ${n("not_run")} not_run)`);
  }
  out.push(`- mutation proof: ${rc?.mutation_proof ? oneLine(rc.mutation_proof) : NR}`);
  const card = f.intentCard;
  if (!Array.isArray(card)) out.push(`- intent card: ${NR}`);
  else { const a = card.filter((l) => /^\s*acceptance/i.test(l)).length; out.push(`- intent card: recorded (${a} acceptance line${a === 1 ? "" : "s"})`); }

  const np = rc?.not_proven;
  if (!Array.isArray(np)) out.push(`NOT PROVEN: ${NR}`);
  else if (np.length === 0) out.push("NOT PROVEN: none recorded");
  else { out.push("NOT PROVEN:", ...np.slice(0, 3).map((l) => `- ${oneLine(l)}`)); if (np.length > 3) out.push(`- +${np.length - 3} more in the receipt`); }

  if (!Array.isArray(f.declaredFiles)) out.push(`Outside the declared scope: ${NR} (no declared scope)`);
  else if (!lines) out.push(`Outside the declared scope: ${NR} (diff unavailable)`);
  else {
    const decl = new Set(f.declaredFiles.map((p) => p.trim().replace(/^\.\//, "")));
    const outside = [...lines.keys()].filter((p) => !decl.has(p));
    out.push(outside.length === 0 ? "Outside the declared scope: none" : `Outside the declared scope (${outside.length}): ${outside.slice(0, 4).join(", ")}${outside.length > 4 ? `, +${outside.length - 4} more` : ""}`);
  }
  out.push(`Verify locally: loki verify ${f.runId}`);
  return out.join("\n") + "\n";
}

/** Added line numbers per changed path, from `git diff -U0 base HEAD`. Null when the diff is unavailable. */
export function changedLines(repoDir: string, base: string): Map<string, number[]> | null {
  let out: string;
  try { out = safeGit(repoDir, ["diff", "-U0", "--no-color", base, "HEAD"]); } catch { return null; }
  const res = new Map<string, number[]>();
  let cur: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) { cur = line.startsWith("+++ b/") ? line.slice(6) : null; if (cur) res.set(cur, res.get(cur) ?? []); continue; }
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur) {
      const start = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]);
      const arr = res.get(cur)!;
      for (let i = 0; i < n; i++) arr.push(start + i);
    }
  }
  return res;
}

/** How many other repo source files import each target (relative specifiers only). */
export function callerCounts(repoDir: string, targets: string[]): Map<string, number> {
  const stem = (p: string): string => p.replace(JS_EXT, "");
  const want = new Map<string, string>(); // stem -> target
  for (const t of targets) if (JS_EXT.test(t)) want.set(stem(t), t);
  const counts = new Map<string, number>();
  for (const t of want.values()) counts.set(t, 0);
  if (want.size === 0) return counts;
  for (const f of listRepoFiles(repoDir, 20000).files) {
    if (!JS_EXT.test(f)) continue;
    let text: string;
    try { text = readFileSync(join(repoDir, f), "utf8").slice(0, MAX_READ); } catch { continue; }
    const seen = new Set<string>();
    for (const m of text.matchAll(IMPORT_RE)) {
      const resolved = normalize(join(dirname(f), m[1]!)).replace(/\/index$/, "");
      for (const key of [stem(resolved), resolved]) {
        const t = want.get(key);
        if (t && t !== f && !seen.has(t)) { seen.add(t); counts.set(t, (counts.get(t) ?? 0) + 1); }
      }
    }
  }
  return counts;
}

/** Parses lcov into path -> (line -> hits). */
export function parseLcov(text: string): Map<string, Map<number, number>> {
  const res = new Map<string, Map<number, number>>();
  let cur: Map<number, number> | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) { cur = new Map(); res.set(line.slice(3).trim(), cur); }
    else if (line.startsWith("DA:") && cur) {
      const [l, h] = line.slice(3).split(",");
      cur.set(Number(l), Number(h));
    } else if (line === "end_of_record") cur = null;
  }
  return res;
}

function lcovFor(repoDir: string, changed: string[]): { cov: Map<string, Map<number, number>> } | { reason: string } {
  const p = LCOV_PATHS.map((r) => join(repoDir, r)).find((x) => existsSync(x));
  if (!p) return { reason: "no coverage report from an executed test run (coverage/lcov.info absent)" };
  const t = statSync(p).mtimeMs;
  for (const f of changed) {
    try { if (statSync(join(repoDir, f)).mtimeMs > t) return { reason: `coverage report is older than ${f}` }; } catch { /* deleted file */ }
  }
  return { cov: parseLcov(readFileSync(p, "utf8")) };
}

function findCov(cov: Map<string, Map<number, number>>, repoDir: string, rel: string): Map<number, number> | null {
  for (const [sf, m] of cov) {
    const norm = sf.startsWith(repoDir + "/") ? sf.slice(repoDir.length + 1) : sf;
    if (norm === rel || rel.endsWith("/" + norm) || norm.endsWith("/" + rel)) return m;
  }
  return null;
}

export function renderBrief(inp: BriefInput): string {
  const out: string[] = inp.facts ? [leadBlock(inp.repoDir, inp.baseSha, inp.facts).trimEnd(), "", "### Details", ""] : ["## Reviewer brief", ""];
  const lines = inp.baseSha ? changedLines(inp.repoDir, inp.baseSha) : null;

  out.push("### Behavior changes");
  const plan = (inp.plan ?? "").trim();
  let subjects = "";
  if (!plan && inp.baseSha) { try { subjects = safeGit(inp.repoDir, ["log", "--format=- %s", `${inp.baseSha}..HEAD`]).trim(); } catch { /* none */ } }
  out.push(plan ? `Plan:\n${plan}` : subjects ? `Commit summary:\n${subjects}` : "not stated");
  out.push("");

  out.push("### Changed files by caller count");
  if (!lines) out.push("not measured (no base commit or diff unavailable)");
  else if (lines.size === 0) out.push("no changed files");
  else {
    const files = [...lines.keys()];
    const counts = callerCounts(inp.repoDir, files);
    const ranked = files.map((f) => ({ f, n: counts.get(f) ?? null })).sort((a, b) => (b.n ?? -1) - (a.n ?? -1) || a.f.localeCompare(b.f));
    for (const r of ranked) out.push(`- ${r.f}: ${r.n === null ? "callers n/a (not a JS/TS module)" : `${r.n} caller${r.n === 1 ? "" : "s"}`}`);
  }
  out.push("");

  out.push("### Changed lines no test covers");
  if (!lines) out.push("uncovered lines: NOT MEASURED (no base commit or diff unavailable)");
  else {
    const l = lcovFor(inp.repoDir, [...lines.keys()]);
    if ("reason" in l) out.push(`uncovered lines: NOT MEASURED (${l.reason})`);
    else {
      const rows: string[] = []; const missing: string[] = [];
      for (const [f, nums] of lines) {
        if (nums.length === 0) continue;
        const m = findCov(l.cov, inp.repoDir, f);
        if (!m) { missing.push(f); continue; }
        const unc = nums.filter((n) => m.get(n) === 0);
        if (unc.length) rows.push(`- ${f}: ${unc.join(", ")}`);
      }
      out.push(...(rows.length ? rows : ["none of the measured changed lines are uncovered"]));
      if (missing.length) out.push(`not measured (absent from the coverage report): ${missing.join(", ")}`);
    }
  }
  return out.join("\n") + "\n";
}
