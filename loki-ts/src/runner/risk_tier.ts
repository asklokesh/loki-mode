// RISKTIER: classify risk on the ARTIFACT (the actual diff), never the prompt, and map the tier to a
// verification plan. Pure functions plus one best-effort recorder. Reuses isTestFile from testmap.ts;
// the bash `loki review --risk` scorer (autonomy/lib/review_risk.py) stays a separate 0-100 advisory view.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestFile } from "../engine10/testmap.ts";
import { safeGit } from "../util/safe_git.ts";

export type RiskTier = "low" | "medium" | "high";
export interface DiffFile { path: string; added: number; deleted: number; status?: "added" | "modified" | "deleted" }
export interface RiskOverride { from: RiskTier; to: RiskTier; reason: string }
export interface RiskAssessment {
  version: 1; tier: RiskTier; computed: RiskTier; reasons: string[];
  stats: { files: number; lines: number; sensitive: string[]; tests_modified: string[]; tests_deleted: string[]; api: string[] };
  checks_selected: string[]; checks_deferred: string[]; // deferred = planned for this tier but NOT run by the fast verify stage; never a pass
  override?: RiskOverride; override_ignored?: string; summary: string;
}

const SENSITIVE: [string, RegExp][] = [
  ["auth", /(^|\/)(auth|oauth|sso|session|login|permission|rbac|acl)[\w.-]*(\/|\.|$)/i],
  ["crypto", /(^|\/)(crypt|crypto|jwt|signing|keys?|secrets?|tokens?|credential|password)[\w.-]*(\/|\.|$)/i],
  ["payments", /(^|\/)(payments?|billing|checkout|stripe|invoice)[\w.-]*(\/|\.|$)/i],
  ["migration", /(^|\/)(migrations?|alembic)\/|\.sql$/i],
  ["ci", /(^|\/)(\.github\/(workflows|actions)|\.gitlab-ci\.yml|\.circleci|Jenkinsfile|azure-pipelines)/i],
  ["lockfile", /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|Gemfile\.lock|uv\.lock)$/],
  ["infra", /(^|\/)(Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|terraform|helm|k8s|kubernetes|infra|deploy)(\/|\.|$)|\.tf$/i],
  ["env", /(^|\/)\.env[\w.]*$/],
];
const API: RegExp = /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$|\.proto$|\.d\.ts$|(^|\/)(api|routes|public)\/|(^|\/)index\.(ts|js|py)$/i;
const TEST_CFG = /(^|\/)(conftest\.py|\.?pytest\.(ini|toml)|tox\.ini|jest\.config\.[\w.]+|vitest\.config\.[\w.]+)$/;
const RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
const FILES_MEDIUM = 4, FILES_HIGH = 15, LINES_MEDIUM = 100, LINES_HIGH = 500;

// Fast verify always runs targeted tests and lint of changed files; anything else in `selected` is required depth.
const RAN_ALWAYS = ["targeted tests", "lint of changed files"];
const PLAN: Record<RiskTier, { selected: string[] }> = {
  low: { selected: [...RAN_ALWAYS] },
  medium: { selected: [...RAN_ALWAYS, "full test command", "one reviewer"] },
  high: { selected: [...RAN_ALWAYS, "full test command", "full suite", "council", "security scan"] },
};
const LOW_SKIPPED = ["full test command", "reviewer", "council", "security scan"]; // low skips these by design; they are listed so the record never implies they ran
const deferredOf = (tier: RiskTier, selected: string[], executed: string[]): string[] => (tier === "low" ? LOW_SKIPPED : selected).filter((c) => !RAN_ALWAYS.includes(c) && !executed.includes(c));

function summaryOf(a: Pick<RiskAssessment, "tier" | "computed" | "reasons" | "override" | "checks_deferred">): string {
  const why = a.tier === a.computed ? a.reasons.slice(0, 2).join("; ") : `computed ${a.computed}; override ${a.override?.from} to ${a.override?.to}: ${a.override?.reason}`;
  const def = a.checks_deferred;
  return `risk: ${a.tier} (${why}), ${def.length ? def.join(", ") : "no deeper checks"} not run`;
}

/** Marks selected deeper checks that verify really executed (for example the full test command), then rebuilds deferred and summary. */
export function markExecuted(a: RiskAssessment, executed: string[]): RiskAssessment {
  const checks_deferred = deferredOf(a.tier, a.checks_selected, executed);
  return { ...a, checks_deferred, summary: summaryOf({ ...a, checks_deferred }) };
}

export function classifyRisk(files: DiffFile[], env: NodeJS.ProcessEnv = process.env): RiskAssessment {
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const sensitive = files.flatMap((f) => { const hit = SENSITIVE.find(([, re]) => re.test(f.path)); return hit && !isTestFile(f.path) ? [`${f.path} (${hit[0]})`] : []; });
  const testFiles = files.filter((f) => isTestFile(f.path));
  const testsDeleted = testFiles.filter((f) => f.status === "deleted").map((f) => f.path);
  const testsModified = [...testFiles.filter((f) => f.status !== "added" && f.status !== "deleted").map((f) => f.path), ...files.filter((f) => TEST_CFG.test(f.path)).map((f) => f.path)];
  const api = files.filter((f) => API.test(f.path) && !isTestFile(f.path)).map((f) => f.path);
  const high: string[] = [], med: string[] = [];
  if (sensitive.length) high.push(`sensitive paths: ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? ` (+${sensitive.length - 5})` : ""}`);
  if (testsDeleted.length) high.push(`test files deleted: ${testsDeleted.join(", ")}`);
  if (api.length) high.push(`public API surface: ${api.slice(0, 3).join(", ")}`);
  if (files.length >= FILES_HIGH) high.push(`${files.length} files >= ${FILES_HIGH}`);
  if (lines >= LINES_HIGH) high.push(`${lines} changed lines >= ${LINES_HIGH}`);
  if (testsModified.length) med.push(`existing tests or test config modified: ${testsModified.slice(0, 3).join(", ")}`);
  if (files.length >= FILES_MEDIUM) med.push(`${files.length} files >= ${FILES_MEDIUM}`);
  if (lines >= LINES_MEDIUM) med.push(`${lines} changed lines >= ${LINES_MEDIUM}`);
  const computed: RiskTier = high.length ? "high" : med.length ? "medium" : "low";
  const reasons = high.length ? [...high, ...med] : med.length ? med : [`${files.length} file${files.length === 1 ? "" : "s"}, no sensitive paths`];

  // A prompt or flag may RAISE the tier freely. Lowering needs an explicit recorded reason; high is never lowered silently.
  let tier = computed, override: RiskOverride | undefined, ignored: string | undefined;
  const asked = (env["LOKI_RISK_TIER"] ?? "").trim().toLowerCase() as RiskTier;
  if (asked in RANK && asked !== computed) {
    const reason = (env["LOKI_RISK_OVERRIDE_REASON"] ?? "").trim();
    if (RANK[asked] > RANK[computed]) { tier = asked; override = { from: computed, to: asked, reason: reason || "raised by LOKI_RISK_TIER" }; }
    else if (reason) { tier = asked; override = { from: computed, to: asked, reason }; }
    else ignored = `LOKI_RISK_TIER=${asked} ignored: lowering from ${computed} needs LOKI_RISK_OVERRIDE_REASON`;
  }
  const plan = PLAN[tier], checks_deferred = deferredOf(tier, plan.selected, []);
  const summary = summaryOf({ tier, computed, reasons, ...(override ? { override } : {}), checks_deferred });
  return {
    version: 1, tier, computed, reasons,
    stats: { files: files.length, lines, sensitive, tests_modified: testsModified, tests_deleted: testsDeleted, api },
    checks_selected: plan.selected, checks_deferred,
    ...(override ? { override } : {}), ...(ignored ? { override_ignored: ignored } : {}), summary,
  };
}

/** Diff of the working tree against baseSha (tracked numstat plus untracked line counts), .loki/ excluded. Throws on git failure. */
export function diffFiles(repoDir: string, baseSha: string): DiffFile[] {
  const out = new Map<string, DiffFile>();
  for (const l of safeGit(repoDir, ["diff", "--numstat", baseSha]).split("\n")) {
    const [a, d, ...p] = l.split("\t"), path = p.join("\t");
    if (!path || path.startsWith(".loki/")) continue;
    out.set(path, { path, added: Number(a) || 0, deleted: Number(d) || 0 });
  }
  for (const l of safeGit(repoDir, ["diff", "--name-status", baseSha]).split("\n")) {
    const [s, ...p] = l.split("\t"), f = out.get(p[p.length - 1] ?? "");
    if (f) f.status = s?.startsWith("A") ? "added" : s?.startsWith("D") ? "deleted" : "modified";
  }
  for (const path of safeGit(repoDir, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((x) => x.trim()).filter(Boolean)) {
    if (path.startsWith(".loki/")) continue;
    let n = 0; try { n = readFileSync(join(repoDir, path), "utf8").split("\n").length; } catch { /* unreadable or binary */ }
    out.set(path, { path, added: n, deleted: 0, status: "added" });
  }
  return [...out.values()];
}

/** Writes .loki/state/risk-tier.json atomically; best effort, a recording failure never fails the run. */
export function recordRisk(repoDir: string, a: RiskAssessment): string | null {
  try {
    const dir = join(repoDir, ".loki", "state"), p = join(dir, "risk-tier.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(a, null, 2) + "\n"); renameSync(`${p}.tmp`, p);
    return p;
  } catch { return null; }
}

/** The recorded summary line for a run that started at sinceMs; null when absent, stale or unreadable. */
export function readRiskSummary(repoDir: string, sinceMs = 0): string | null {
  try {
    const p = join(repoDir, ".loki", "state", "risk-tier.json");
    if (statSync(p).mtimeMs < sinceMs) return null;
    const s = (JSON.parse(readFileSync(p, "utf8")) as { summary?: unknown }).summary;
    return typeof s === "string" && s ? s : null;
  } catch { return null; }
}

/** Appends the risk line to rendered output only while the default 8-line cap (D48, start line printed separately) still holds. */
export function withRiskLine(out: string, line: string | null, maxLines = 7): string {
  if (!line) return out;
  const body = out.replace(/\n+$/, "");
  return body.split("\n").length + 1 > maxLines ? out : `${body}\n${line}\n`;
}
