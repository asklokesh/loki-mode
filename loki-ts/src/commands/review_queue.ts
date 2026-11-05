// `loki review queue`: every open Loki PR in one list, ranked by risk. A PR is READY only when it is not a draft, CI is green,
// the risk tier (recomputed here from the live diff with the run's own classifyRisk) is low, and its proof passport (receipt.dsse.json
// in the receipt comment) verifies against a key the reader trusts and names this PR's exact head commit. Read-only unless --mark.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { verifyEnvelopeWith } from "../engine10/verify_cmd.ts";
import { takePubkey } from "../engine10/keys_cmd.ts";
import { isEnvelope, outcomeOf } from "../features/receipt_dsse.ts";
import { classifyRisk, criticalRules, diffFilesFromPatch, type RiskTier } from "../util/check_result.ts";
import { passportsIn, renderProofCard } from "../util/receipt_surface.ts";
import { safeGitSpawn } from "../util/safe_git.ts";
import type { GhResult } from "./issues_run.ts";
import type { KeyObject } from "node:crypto";

export interface ReviewQueueDeps {
  gh: (args: readonly string[]) => GhResult;
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
}

export type PassportStatus = "verified" | "unchecked" | "tampered" | "stale" | "disagree" | "none";
interface PrRow { number: number; title: string; url: string; headRefName: string; headRefOid: string; baseRefOid: string; isDraft: boolean; labels: string[]; additions: number; deletions: number; changedFiles: number }
interface PassportView { status: PassportStatus; outcome: string | null; receipt_sha256: string | null; kid: string | null; reason: string | null; predicate: Record<string, unknown> | null }
export interface QueueEntry {
  pr: PrRow; ready: boolean; rank: number; reasons: string[]; tier: RiskTier; riskReasons: string[]; riskSummary: string;
  passport: PassportView; checks: "green" | "pending" | "red" | "none"; lines: number; files: number; paths: string[];
}

const USAGE = `Usage: loki review queue [--repo OWNER/REPO] [--pubkey FILE] [--limit N] [--json] [--mark]
Lists open Loki PRs (head loki/*) ranked by risk. READY means: not a draft, CI green, risk tier low, and a proof
passport that verifies against --pubkey (default: the local receipt key) and names the PR's exact head commit.
Risk is recomputed from the PR diff; LOKI_RISK_TIER is ignored. --mark adds the loki-ready label to READY PRs and
removes it from the others. Exit: 0 listed, 1 gh failed, 2 usage error.
`;
const TIER_RANK: Record<RiskTier, number> = { high: 3, medium: 2, low: 1 };
const short = (s: string): string => s.slice(0, 7);
const HEX = /^[0-9a-f]{40,64}$/;

function parseRows(stdout: string): PrRow[] | null {
  let j: unknown;
  try { j = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(j)) return null;
  const rows: PrRow[] = [];
  for (const r of j as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || !Number.isInteger(r["number"]) || typeof r["headRefName"] !== "string" || typeof r["headRefOid"] !== "string" || typeof r["isDraft"] !== "boolean") return null;
    const num = (k: string): number => (typeof r[k] === "number" ? (r[k] as number) : 0);
    const labels = Array.isArray(r["labels"]) ? (r["labels"] as { name?: unknown }[]).map((l) => String(l?.name ?? "")) : [];
    rows.push({ number: r["number"] as number, title: String(r["title"] ?? ""), url: String(r["url"] ?? ""), headRefName: r["headRefName"] as string, headRefOid: r["headRefOid"] as string, baseRefOid: String(r["baseRefOid"] ?? ""), isDraft: r["isDraft"] as boolean, labels, additions: num("additions"), deletions: num("deletions"), changedFiles: num("changedFiles") });
  }
  return rows;
}

/** One passport verdict per envelope: only --pubkey or the local JWKS decides trust (the embedded JWK is never used), then the commit must be the PR head. */
function judgePassport(bodies: string, head: string, pubkey: KeyObject | undefined): PassportView {
  const found = passportsIn(bodies);
  const none: PassportView = { status: "none", outcome: null, receipt_sha256: null, kid: null, reason: "no proof passport in the PR comments", predicate: null };
  if (found.length === 0) return none;
  const views: PassportView[] = [];
  for (const p of found) {
    let env: unknown;
    try { env = JSON.parse(p.envelope); } catch { views.push({ ...none, status: "tampered", reason: "passport is not valid JSON" }); continue; }
    if (!isEnvelope(env)) { views.push({ ...none, status: "tampered", reason: "passport is not a DSSE envelope" }); continue; }
    const v = verifyEnvelopeWith(env, pubkey);
    if (v.verdict === "UNCHECKED") { views.push({ ...none, status: "unchecked", reason: `passport key is not trusted here: ${v.reasons[0] ?? "unknown key"}; pass --pubkey FILE` }); continue; }
    if (v.verdict !== "VERIFIED") { views.push({ ...none, status: "tampered", reason: `passport failed verification: ${v.reasons[0] ?? v.verdict}` }); continue; }
    const pred = (JSON.parse(Buffer.from(env.payload, "base64").toString()) as { predicate: Record<string, unknown> }).predicate;
    const commit = String(pred["head_sha"] ?? ""), outcome = outcomeOf(env as unknown as Record<string, unknown>);
    const base = { outcome, receipt_sha256: typeof pred["receipt_sha256"] === "string" ? pred["receipt_sha256"] : null, kid: env.signatures[0]?.keyid ?? null, predicate: pred };
    views.push(commit === head ? { ...base, status: "verified", reason: null } : { ...base, status: "stale", reason: `passport is for commit ${short(commit)}, PR head is ${short(head)}` });
  }
  const good = views.filter((v) => v.status === "verified");
  if (good.length > 0) {
    if (new Set(good.map((v) => v.outcome)).size > 1) return { ...good[0]!, status: "disagree", reason: "passports for this head disagree on the run outcome" };
    return good[0]!;
  }
  return views.find((v) => v.status === "stale") ?? views.find((v) => v.status === "tampered") ?? views[0]!;
}

function checksOf(r: GhResult): QueueEntry["checks"] {
  if (r.rc === 0) return "green";
  if (r.rc === 8) return "pending";
  return /no checks reported/i.test(r.stderr + r.stdout) ? "none" : "red";
}

function assess(row: PrRow, d: ReviewQueueDeps, repo: string[], pubkey: KeyObject | undefined): QueueEntry {
  const n = String(row.number);
  const checks = checksOf(d.gh(["pr", "checks", n, ...repo]));
  const comments = d.gh(["pr", "view", n, ...repo, "--json", "comments", "-q", ".comments[].body"]);
  const passport = comments.rc === 0 ? judgePassport(comments.stdout, row.headRefOid, pubkey) : { status: "none" as const, outcome: null, receipt_sha256: null, kid: null, reason: "PR comments could not be read", predicate: null };
  const diff = d.gh(["pr", "diff", n, ...repo]);
  let tier: RiskTier = "high", riskReasons = ["diff could not be read, so risk is not known"], riskSummary = "risk unknown: diff unavailable", lines = row.additions + row.deletions, files = row.changedFiles, paths: string[] = [];
  if (diff.rc === 0 && diff.stdout.trim() !== "") {
    const haveBase = HEX.test(row.baseRefOid) && safeGitSpawn(d.cwd, ["cat-file", "-e", `${row.baseRefOid}^{commit}`], { encoding: "utf8" }).status === 0;
    const parsed = diffFilesFromPatch(diff.stdout, criticalRules(d.cwd, haveBase ? row.baseRefOid : undefined));
    const a = classifyRisk(parsed, {}); // empty env: no LOKI_RISK_TIER override can lower the tier a reviewer sees
    tier = a.tier; riskReasons = a.reasons; riskSummary = a.summary; lines = a.stats.lines; files = a.stats.files; paths = parsed.map((f) => f.path);
  }
  const reasons: string[] = [];
  if (row.isDraft) reasons.push("PR is a draft");
  if (checks === "pending") reasons.push("CI checks pending");
  else if (checks === "none") reasons.push("no CI checks reported");
  else if (checks === "red") reasons.push("CI checks failing or unreadable");
  if (tier !== "low") reasons.push(`risk tier ${tier}: ${riskReasons[0] ?? ""}`.trim());
  if (passport.status !== "verified") reasons.push(passport.reason ?? "no verified passport");
  else if (passport.outcome !== "VERIFIED" && passport.outcome !== "ALREADY_SATISFIED") reasons.push(`passport run outcome is ${passport.outcome}`);
  return { pr: row, ready: reasons.length === 0, rank: 0, reasons, tier, riskReasons, riskSummary, passport, checks, lines, files, paths };
}

export function rankEntries(es: QueueEntry[]): QueueEntry[] {
  const sorted = [...es].sort((a, b) => (a.ready !== b.ready ? (a.ready ? -1 : 1) : a.ready ? a.lines - b.lines : TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.lines - a.lines || a.pr.number - b.pr.number));
  sorted.forEach((e, i) => { e.rank = i + 1; });
  return sorted;
}

function readyBlock(e: QueueEntry): string {
  const p = e.passport.predicate ?? {}, cost = p["cost"] as { usd?: unknown } | undefined, time = p["time"] as { wall_s?: unknown } | undefined;
  const checks = Array.isArray(p["checks"]) ? (p["checks"] as unknown[]).length : 0, np = Array.isArray(p["not_proven"]) ? (p["not_proven"] as unknown[]).map(String) : [];
  const card = renderProofCard({ verdict: e.passport.outcome ?? "VERIFIED", usd: typeof cost?.usd === "number" ? cost.usd : null, wallS: typeof time?.wall_s === "number" ? time.wall_s : 0, checks, mutationProof: typeof p["mutation_proof"] === "string" ? p["mutation_proof"] : null, sha: e.passport.receipt_sha256 });
  const more = e.paths.length > 5 ? `, +${e.paths.length - 5} more` : "";
  return [
    `#${e.pr.number} READY low risk ${e.pr.title} ${e.pr.url}`,
    `  Changed: ${e.files} files, +${e.pr.additions} -${e.pr.deletions} (${e.paths.slice(0, 5).join(", ")}${more})`,
    ...card.split("\n").map((l) => `  ${l}`),
    `  Not proven: ${np.length === 0 ? "none" : `${np.length}: ${np.slice(0, 3).join("; ")}`}`,
    `  Risk: ${e.riskSummary}`,
    `  Next: gh pr review ${e.pr.number} --approve && loki merge pr ${e.pr.number} --require-verified`,
  ].join("\n");
}

function mark(es: QueueEntry[], d: ReviewQueueDeps, repo: string[]): void {
  const label = d.gh(["label", "create", "loki-ready", ...repo, "--color", "0E8A16", "--description", "Loki: low risk, passport verified, CI green", "--force"]);
  if (label.rc !== 0) d.err(`loki review queue: could not create the loki-ready label: ${label.stderr.trim().split("\n")[0] ?? ""}\n`);
  for (const e of es) {
    const has = e.pr.labels.includes("loki-ready");
    if (!e.ready && !has) continue;
    const r = d.gh(["pr", "edit", String(e.pr.number), ...repo, e.ready ? "--add-label" : "--remove-label", "loki-ready"]);
    if (r.rc !== 0) d.err(`loki review queue: #${e.pr.number} label not ${e.ready ? "added" : "removed"}: ${r.stderr.trim().split("\n")[0] ?? ""}\n`);
  }
}

export async function runReviewQueue(argv: readonly string[], inject?: Partial<ReviewQueueDeps>): Promise<number> {
  const d: ReviewQueueDeps = {
    gh: inject?.gh ?? ((a) => {
      const r = spawnSync("gh", [...a], { cwd: inject?.cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
      return { rc: r.status ?? (r.error ? 124 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
    }),
    out: inject?.out ?? ((s) => void process.stdout.write(s)),
    err: inject?.err ?? ((s) => void process.stderr.write(s)),
    cwd: inject?.cwd ?? process.cwd(),
  };
  if (argv.includes("--help") || argv.includes("-h")) return (d.out(USAGE), 0);
  let v: ReturnType<typeof parseArgs>;
  try { v = parseArgs({ args: [...argv], options: { repo: { type: "string" }, pubkey: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" }, mark: { type: "boolean" } }, allowPositionals: true }); } catch (e) { return (d.err(`loki review queue: ${(e as Error).message}\n${USAGE}`), 2); }
  if (v.positionals.length > 0) return (d.err(`loki review queue: unexpected argument ${v.positionals[0]}\n${USAGE}`), 2);
  const limit = v.values["limit"] === undefined ? 50 : Number(v.values["limit"]);
  if (!Number.isInteger(limit) || limit < 1) return (d.err(`loki review queue: --limit must be a positive integer\n`), 2);
  let pubkey: KeyObject | undefined;
  if (v.values["pubkey"] !== undefined) {
    const k = takePubkey(["--pubkey", String(v.values["pubkey"])]);
    if (k.error || !k.pubkey) return (d.err(`loki review queue: ${k.error ?? "no key"}\n`), 2);
    pubkey = k.pubkey;
  }
  const repo = v.values["repo"] ? ["--repo", String(v.values["repo"])] : [];
  const list = d.gh(["pr", "list", ...repo, "--state", "open", "--limit", String(limit), "--json", "number,title,url,headRefName,headRefOid,baseRefOid,isDraft,labels,additions,deletions,changedFiles"]);
  if (list.rc !== 0) return (d.err(`loki review queue: gh pr list failed (rc ${list.rc}): ${list.stderr.trim().split("\n")[0] ?? ""}\n`), 1);
  const rows = parseRows(list.stdout);
  if (!rows) return (d.err("loki review queue: gh pr list returned malformed output; nothing was judged\n"), 1);
  const entries = rankEntries(rows.filter((r) => r.headRefName.startsWith("loki/")).map((r) => assess(r, d, repo, pubkey)));
  if (v.values["json"]) {
    d.out(`${JSON.stringify(entries.map((e) => ({ number: e.pr.number, url: e.pr.url, title: e.pr.title, head: e.pr.headRefOid, branch: e.pr.headRefName, ready: e.ready, rank: e.rank, reasons: e.reasons, risk: { tier: e.tier, reasons: e.riskReasons }, passport: { status: e.passport.status, outcome: e.passport.outcome, receipt_sha256: e.passport.receipt_sha256, kid: e.passport.kid }, checks: e.checks, lines: e.lines, files: e.files })), null, 2)}\n`);
  } else if (entries.length === 0) d.out("No open Loki PRs.\n");
  else d.out(`${entries.map((e) => (e.ready ? readyBlock(e) : `#${e.pr.number} NEEDS REVIEW ${e.tier} risk: ${e.reasons.join("; ")}`)).join("\n")}\n`);
  if (v.values["mark"]) mark(entries, d, repo);
  return 0;
}
