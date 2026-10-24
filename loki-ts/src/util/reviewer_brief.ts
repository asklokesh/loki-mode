// T4 (11.3.0): "Reviewer brief" section of the PR body. Data only: it reads git, the repo's import
// graph and an lcov file if one exists, and never runs tests or a provider. Opt out with
// LOKI_REVIEWER_BRIEF=0 (the PR body is then byte-identical to before). Coverage is reported only
// from a real lcov file that is not older than the changed files; nothing is inferred from names.
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { listRepoFiles } from "../engine10/repomap.ts";
import { buildTestMap, impactedRefs } from "../engine10/testmap.ts";
import { safeGit } from "./safe_git.ts";
import { ALREADY_FAILING_ON_BASE } from "./check_result.ts";

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
  receipt?: { checks?: { name?: string; result?: string; pre_red?: boolean }[]; mutation_proof?: string; not_proven?: string[] };
  /** The plan's intent card lines; null/undefined when none was recorded. */
  intentCard?: string[] | null;
  /** Files the plan declared (plan-scope.json "files"); null/undefined when none was recorded. */
  declaredFiles?: string[] | null;
  risks?: RiskDecl[] | null;
}

const NR = "NOT RECORDED";
const oneLine = (t: string, n = 100): string => t.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, n);
/** A whole line up to n characters; a longer one is cut on a word boundary and ends with an ellipsis (FC-PR-BODY-PUBLIC-HYGIENE). */
export const capWhole = (t: string, n: number): string => { const s = t.replace(/\s+/g, " ").trim(); if (s.length <= n) return s; const cut = s.slice(0, n - 3), sp = cut.lastIndexOf(" "); return `${(sp > n / 2 ? cut.slice(0, sp) : cut).trimEnd()}...`; };
const wholeLine = (t: string, n = 240): string => capWhole(t.replace(/[\x00-\x1f\x7f]+/g, " "), n);
/** FC-PR-BODY-PUBLIC-HYGIENE: one flag per top-level reviewer line; a header ending in ":" absorbs the more-indented lines under it, and a header with nothing under it is dropped (a dangling header is not a flag). */
export function reviewFlagLines(text: string): string[] {
  const out: { t: string; indent: number; subs: string[] }[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length, t = raw.replace(/^\s*[-*]\s*/, ""), last = out[out.length - 1];
    if (last && last.t.trimEnd().endsWith(":") && indent > last.indent) last.subs.push(t.trim()); else out.push({ t, indent, subs: [] });
  }
  return out.filter((e) => e.subs.length > 0 || !e.t.trimEnd().endsWith(":")).map((e) => (e.subs.length > 0 ? `${e.t.trim()} ${e.subs.join("; ")}` : e.t));
}

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
    const red = checks.filter((c) => c.result === "fail" && c.pre_red === true).length;
    out.push(checks.length === 0 ? "- checks run: 0" : `- checks run: ${checks.length} (${n("pass")} pass, ${n("fail")} fail, ${n("not_run")} not_run${red > 0 ? `; ${red} fail ${ALREADY_FAILING_ON_BASE}` : ""})`);
  }
  out.push(`- mutation proof: ${rc?.mutation_proof ? oneLine(rc.mutation_proof) : NR}`);
  const card = f.intentCard;
  if (!Array.isArray(card)) out.push(`- intent card: ${NR}`);
  else { const a = card.filter((l) => /^\s*acceptance/i.test(l)).length; out.push(`- intent card: recorded (${a} acceptance line${a === 1 ? "" : "s"})`); }

  const np = rc?.not_proven;
  if (!Array.isArray(np)) out.push(`NOT PROVEN: ${NR}`);
  else if (np.length === 0) out.push("NOT PROVEN: none recorded");
  else { out.push("NOT PROVEN:", ...np.slice(0, 3).map((l) => `- ${wholeLine(l)}`)); if (np.length > 3) out.push(`- +${np.length - 3} more in the receipt`); }

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

  out.push("### Tests that import the changed files");
  if (!lines) out.push("not measured (no base commit or diff unavailable)");
  else if (lines.size === 0) out.push("no changed files");
  else {
    let map: ReturnType<typeof buildTestMap> | null = null;
    try { map = buildTestMap(inp.repoDir); } catch { /* reported below */ }
    if (!map || map.tests.length === 0) out.push("not measured (no test runner or test files detected)");
    else for (const f of lines.keys()) {
      const hit = impactedRefs(map, [f]).map((t) => t.path);
      out.push(hit.length === 0 ? `- ${f}: no test imports this file` : `- ${f}: ${hit.slice(0, 3).join(", ")}${hit.length > 3 ? `, +${hit.length - 3} more` : ""}`);
    }
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

/** MARK-1: LOKI_AI_MARKING=1, true or yes (any case) turns on AI trailers and the PR marker. Off by default. */
const markingOn = (env: NodeJS.ProcessEnv): boolean => /^(1|true|yes)$/i.test((env["LOKI_AI_MARKING"] ?? "").trim());
/** One line, no control characters, bounded: a value can never open a new trailer or markdown line. */
const cleanFull = (v: string): string => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
export const clean = (v: string): string => cleanFull(v).slice(0, 100) || "unknown";
/** clean, but a value over 100 chars ends in "..." (100 total) so the reader knows it was cut. */
export const cleanMarked = (v: string): string => { const f = cleanFull(v); return f.length > 100 ? `${f.slice(0, 97)}...` : f || "unknown"; };
export interface AiMarkInput { runId: string; provider: string; model: string; receiptRel?: string }
/** The commit trailers added after Loki-Run. Empty when the flag is off. */
export function aiTrailers(i: AiMarkInput & { receiptRel: string }, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!markingOn(env)) return [];
  return ["AI-Generated: true", `AI-Provider: ${clean(i.provider)}`, `AI-Model: ${clean(i.model)}`, `Loki-Receipt: ${clean(i.receiptRel)}`];
}
/** The single PR-body marker line; null when the flag is off. */
export function aiMarkerLine(i: AiMarkInput, env: NodeJS.ProcessEnv = process.env): string | null {
  return markingOn(env) ? `AI-Generated: true (Loki Mode, ${clean(i.provider)}, ${clean(i.model)}, run ${clean(i.runId)})` : null;
}
/** Insert the marker right after the verdict line (same anchor as the route line). */
export function withAiMarker(body: string, line: string | null): string {
  if (!line) return body;
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^(- )?Verdict:/.test(l));
  if (i < 0) return body;
  lines.splice(i + 1, 0, line);
  return lines.join("\n");
}

// PG-23: fill the target repo's PR template from the rendered body. The template is untrusted text: size-limited, never executed.
const TPL_MAX = 32768, TPL_DIRS = [".github", "", "docs"]; // the locations GitHub documents
export function readPrTemplate(repoDir: string): string | null {
  let top: string; try { top = realpathSync(repoDir); } catch { return null; }
  const inside = (q: string): boolean => q === top || q.startsWith(top.endsWith(sep) ? top : top + sep);
  for (const d of TPL_DIRS) {
    try { if (!inside(realpathSync(join(repoDir, d)))) continue; } catch { continue; } // a symlinked directory could point outside the repo
    let names: string[]; try { names = readdirSync(join(repoDir, d)); } catch { continue; }
    const hit = names.filter((n) => n.toLowerCase() === "pull_request_template.md").sort()[0]; if (hit === undefined) continue; // GitHub matches the name case-insensitively
    const p = join(repoDir, d, hit);
    try {
      if (!lstatSync(p).isFile()) continue; // a symlink could point outside the repo
      if (!inside(realpathSync(p))) continue;
      const fd = openSync(p, "r");
      try { const buf = Buffer.alloc(Math.min(fstatSync(fd).size, TPL_MAX)); const n = readSync(fd, buf, 0, buf.length, 0); return buf.toString("utf8", 0, n); } finally { closeSync(fd); }
    } catch { continue; }
  }
  return null;
}
export interface ReceiptProof { testsPassed: boolean; testsAdded: boolean; receipt: boolean; verified: boolean }
/** What the receipt proves; a checkbox is ticked only when its claim is true here. */
export function receiptProof(verdict: string, outputs: Partial<Record<string, Record<string, unknown>>>, digest: string | null): ReceiptProof {
  const checks = Array.isArray(outputs.verify?.["checks"]) ? (outputs.verify["checks"] as { result?: string }[]) : [];
  const wall = outputs.seal?.["wall_published"] as { files?: unknown } | undefined;
  return { testsPassed: checks.length > 0 && checks.every((c) => c.result === "pass"), testsAdded: Array.isArray(wall?.files) && wall.files.length > 0, receipt: !!digest, verified: verdict === "VERIFIED" };
}
const SECTION_MAP: [RegExp, string[]][] = [
  [/\b(tests?|testing|tested|verif\w*|validat\w*|checks?)\b/, ["How it was tested", "Acceptance tests"]], [/risk|not proven|caveat|limitation|known issue/, ["NOT PROVEN"]], [/receipt|evidence|proof/, ["Receipt"]],
  [/chang|file|implement/, ["What changed and why"]], [/summary|descri|overview|why|context|motivation|issue|what/, ["What the issue asked", "What changed and why"]],
];
function tick(line: string, p: ReceiptProof): string {
  const m = /^(\s*[-*+]\s+)\[[ xX]\](\s+.*)$/.exec(line); if (!m) return line; // pre-ticked boxes are reset: only the receipt may tick
  const off = `${m[1]}[ ]${m[2]}`;
  const t = (m[2] ?? "").toLowerCase(), need: boolean[] = [];
  if (/pass|green/.test(t) && /test/.test(t)) need.push(p.testsPassed);
  if (/\b(added|add|new|written)\b/.test(t) && /test/.test(t)) need.push(p.testsAdded);
  if (/receipt|loki verify/.test(t)) need.push(p.receipt);
  if (/\bverified\b/.test(t)) need.push(p.verified);
  return need.length > 0 && need.every(Boolean) ? `${m[1]}[x]${m[2]}` : off; // unknown or unproven items stay unticked
}
function sections(text: string): { head: string | null; lines: string[] }[] {
  const out: { head: string | null; lines: string[] }[] = [{ head: null, lines: [] }]; let fence = false, cmt = false;
  for (const l of text.split("\n")) {
    const wasCmt = cmt;
    if (!fence) { if (!cmt && l.includes("<!--") && !l.includes("-->", l.indexOf("<!--"))) cmt = true; else if (cmt && l.includes("-->")) cmt = false; }
    if (!cmt && !wasCmt && /^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && !cmt && !wasCmt && /^#{1,3}\s+\S/.test(l)) out.push({ head: l, lines: [] }); else out[out.length - 1]?.lines.push(l);
  }
  return out;
}
/** Fills each template heading from the body's sections by keyword; unmapped headings keep the template text. */
export function applyPrTemplate(body: string, template: string, proof: ReceiptProof): string {
  const src = sections(body).filter((s) => s.head !== null).map((s) => ({ name: (s.head ?? "").replace(/^#+\s*/, ""), lines: s.lines.join("\n").trim() })), used = new Set<string>(), out: string[] = [];
  for (const s of sections(template)) {
    if (s.head === null) { out.push(...s.lines.map((l) => tick(l, proof))); continue; }
    const key = s.head.replace(/^#+\s*/, "").toLowerCase(), names = SECTION_MAP.find(([re]) => re.test(key))?.[1], got = names ? src.filter((x) => names.includes(x.name)) : [];
    out.push(s.head);
    if (got.length === 0) { out.push(...s.lines.map((l) => tick(l, proof))); continue; }
    for (const g of got) { used.add(g.name); out.push(g.lines); }
    out.push(...s.lines.filter((l) => /^\s*[-*+]\s+\[[ xX]\]/.test(l)).map((l) => tick(l, proof)), ""); // checklists survive; template prose is replaced
  }
  const rest = src.filter((x) => !used.has(x.name)).map((x) => `## ${x.name}\n${x.lines}\n`); // NOT PROVEN and Receipt are never dropped
  return `${[...out, ...rest].join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
