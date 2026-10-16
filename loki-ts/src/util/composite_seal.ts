// Composite receipt code, moved out of features/speed/seal_group.ts: features/ (D66) and engine10/ (D29) are both at their
// line caps, and util/ is uncapped. Reuses seal_group's exported helpers; no second sealer.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalJson } from "./receipt_signer.ts";
import { compositeVerdict, dirNames, ID_RE, isObj, readJson, sha, text, type RecHash, type VerifyOne } from "../features/speed/seal_group.ts";
import type { VerifyDeps } from "../engine10/verify_cmd.ts";

// Composite receipt: one signed artifact over every child repo receipt of a workspace run.
// Layout (written by `loki verify --seal-composite <run_dir>`): <run_dir>/composite.json next to integration.json,
// child receipts at <run_dir>/worktrees/<repo slug>/.loki/runs/<run id>/receipt.json. The body binds, in order, each child's
// receipt file hash, receipt_sha256, head_sha and verdict, plus the integration.json file hash. composite_sha256 is the
// sha256 of canonicalJson(body); the signature is the existing signReceipt over it. The verdict is computed from the children
// (capGroupVerdict) and can never read higher than the weakest child.
export const COMPOSITE_SCHEMA = "loki.v10.composite/1";
export interface CompositeChild { repo: string; run_id: string; receipt_path: string; receipt_file_sha256: string; receipt_sha256: string; head_sha: string; verdict: string }
export interface CompositeIntegration { status: string; exit_code: number | null; log_sha256: string | null; heads: Record<string, string | null> }
export interface CompositeBody { schema: string; workspace: string; run_id: string; integration_sha256: string; integration: CompositeIntegration; children: CompositeChild[]; verdict: string }
/** integration.log must hash to the recorded log_sha256 when one is recorded; a recorded hash with no log is a problem too. */
function logProblem(runDir: string, integ: Record<string, unknown>): string | null {
  if (typeof integ["log_sha256"] !== "string") return null;
  let b: Buffer;
  try { b = readFileSync(join(runDir, "integration.log")); } catch { return "integration.log is missing but integration.json records its hash"; }
  return sha(b) === integ["log_sha256"] ? null : "integration.log does not match its recorded hash";
}
/** Problem with the integration run recorded in integration.json (failed, interrupted or nonzero exit), or null. A missing status is legacy and not judged here. */
function integrationProblem(integ: Record<string, unknown>): string | null {
  const st = integ["status"], rc = integ["exit_code"];
  if (st !== undefined && st !== "passed" && st !== "not_configured") return `integration status is ${text(st, 40) || "unknown"}, not passed`;
  if (typeof rc === "number" && rc !== 0) return `integration exit code is ${rc}`;
  return null;
}
const slugOf = (repo: string): string => repo.replace(/\//g, "__"); // mirrors workspace.py _slug
export const isComposite = (r: Record<string, unknown>): boolean => r["schema"] === COMPOSITE_SCHEMA;
const relOk = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.split("/").includes("..");
/** Builds the unsigned composite body. Throws (message names the repo) unless every workspace repo has a readable child receipt. */
export function composeComposite(runDir: string, rh: RecHash): CompositeBody {
  const ip = join(runDir, "integration.json");
  let ibytes: Buffer;
  try { ibytes = readFileSync(ip); } catch { throw new Error("integration.json missing; the workspace run did not finish"); }
  const integ = readJson(ip);
  if (!isObj(integ) || !isObj(integ["outcomes"])) throw new Error("integration.json has no outcomes");
  const iprob = integrationProblem(integ);
  if (iprob) throw new Error(`${iprob}; no composite`);
  if (typeof integ["status"] !== "string") throw new Error("integration.json has no status; no composite");
  const lprob = logProblem(runDir, integ);
  if (lprob) throw new Error(`${lprob}; no composite`);
  const heads = isObj(integ["heads"]) ? integ["heads"] : {};
  const order = Array.isArray(integ["order"]) ? (integ["order"] as unknown[]).map(String) : Object.keys(integ["outcomes"]).sort();
  const children: CompositeChild[] = [];
  for (const repo of order) {
    const outcome = String((integ["outcomes"] as Record<string, unknown>)[repo] ?? "");
    if (outcome !== "ok") throw new Error(`repo ${text(repo, 80)} did not finish (${text(outcome, 80) || "no outcome"}); no composite`);
    const runsDir = join(runDir, "worktrees", slugOf(repo), ".loki", "runs");
    const ids = (dirNames(runsDir) ?? []).filter((n) => existsSync(join(runsDir, n, "receipt.json")));
    const id = ids[ids.length - 1];
    if (!id) throw new Error(`repo ${text(repo, 80)} has no receipt.json under worktrees/${slugOf(repo)}/.loki/runs`);
    const rp = join(runsDir, id, "receipt.json"), bytes = readFileSync(rp), r = readJson(rp);
    if (!isObj(r) || typeof r["receipt_sha256"] !== "string" || rh(r) !== r["receipt_sha256"]) throw new Error(`repo ${text(repo, 80)} receipt is unreadable or its hash does not recompute`);
    const head = String(r["head_sha"] ?? "");
    if (!head) throw new Error(`repo ${text(repo, 80)} receipt has no head_sha`);
    if (typeof heads[repo] !== "string" || heads[repo] === "") throw new Error(`repo ${text(repo, 80)} has no integrated head in integration.json; no composite`);
    if (heads[repo] !== head) throw new Error(`repo ${text(repo, 80)} receipt head ${head} is not the integrated head ${String(heads[repo])} (stale receipt)`);
    children.push({ repo, run_id: String(r["run_id"] ?? id), receipt_path: `worktrees/${slugOf(repo)}/.loki/runs/${id}/receipt.json`, receipt_file_sha256: sha(bytes), receipt_sha256: r["receipt_sha256"], head_sha: head, verdict: String(r["verdict"] ?? "") });
  }
  if (children.length === 0) throw new Error("workspace has no repos");
  return { schema: COMPOSITE_SCHEMA, workspace: basename(dirname(runDir)), run_id: basename(runDir), integration_sha256: sha(ibytes),
    integration: { status: String(integ["status"]), exit_code: typeof integ["exit_code"] === "number" ? integ["exit_code"] : null, log_sha256: typeof integ["log_sha256"] === "string" ? integ["log_sha256"] : null, heads: heads as Record<string, string | null> },
    children, verdict: compositeVerdict(children.map((c) => c.verdict)) };
}
/** Verify side for composite.json. Null problem means the composite body checks out against disk; `verdict` is the recomputed (capped) outcome. */
export async function verifyComposite(receiptPath: string, receipt: Record<string, unknown>, rh: RecHash, verifyOne: VerifyOne, deps: VerifyDeps = {}): Promise<{ problem: { verdict: "TAMPERED" | "UNCHECKED"; reason: string } | null; verdict: string }> {
  const runDir = dirname(receiptPath);
  const signed = isObj(receipt["verification"]) && typeof receipt["verification"]["jwt"] === "string";
  const bad = (reason: string): { problem: { verdict: "TAMPERED"; reason: string }; verdict: string } => ({ problem: { verdict: "TAMPERED", reason: `composite: ${reason}` }, verdict: "FAILED" });
  const kids = receipt["children"];
  if (!Array.isArray(kids) || kids.length === 0 || !ID_RE.test(String(receipt["run_id"] ?? ""))) return bad("body malformed");
  let ibytes: Buffer;
  try { ibytes = readFileSync(join(runDir, "integration.json")); } catch { return bad("integration.json missing"); }
  if (sha(ibytes) !== receipt["integration_sha256"]) return bad("integration.json does not match its recorded hash");
  const integ = readJson(join(runDir, "integration.json"));
  if (!isObj(integ) || !isObj(integ["outcomes"])) return bad("integration.json has no outcomes");
  const iprob = integrationProblem(integ);
  if (iprob) return bad(iprob);
  const lprob = logProblem(runDir, integ);
  if (lprob) return bad(lprob);
  const heads = isObj(integ["heads"]) ? integ["heads"] : {}, outcomes = integ["outcomes"];
  const stated = receipt["integration"];
  if (stated !== undefined) {
    const fileSide = { status: integ["status"] ?? null, exit_code: integ["exit_code"] ?? null, log_sha256: integ["log_sha256"] ?? null, heads };
    if (!isObj(stated) || canonicalJson(stated) !== canonicalJson(fileSide)) return bad("integration section differs from integration.json");
  }
  const order = Array.isArray(integ["order"]) ? (integ["order"] as unknown[]).map(String) : Object.keys(outcomes).sort();
  const kidRepos = (kids as unknown[]).map((k) => (isObj(k) ? String(k["repo"] ?? "") : ""));
  if (new Set(kidRepos).size !== kidRepos.length) return bad("children list a repo more than once");
  if (kidRepos.length !== order.length || kidRepos.some((r, i) => r !== order[i])) return bad("children do not cover the integrated repos in order (a repo is missing or extra)");
  let unchecked: string | null = null;
  const verdicts: string[] = [];
  for (const raw of kids as unknown[]) {
    const c = isObj(raw) ? raw : {}, repo = String(c["repo"] ?? ""), rel = String(c["receipt_path"] ?? "");
    if (!repo || !relOk(rel) || !rel.startsWith(`worktrees/${slugOf(repo)}/.loki/runs/`)) return bad(`child ${text(repo, 80) || "?"} has an invalid receipt path`);
    if (outcomes[repo] !== "ok") return bad(`child ${text(repo, 80)} did not finish ok in integration.json`);
    const rp = join(runDir, rel);
    let bytes: Buffer;
    try { bytes = readFileSync(rp); } catch { return bad(`child ${repo} receipt missing`); }
    if (sha(bytes) !== c["receipt_file_sha256"]) return bad(`child ${repo} receipt does not match its recorded hash (swapped or edited)`);
    const sub = readJson(rp);
    if (!isObj(sub) || sub["receipt_sha256"] !== c["receipt_sha256"] || rh(sub) !== c["receipt_sha256"]) return bad(`child ${repo} receipt hash does not recompute`);
    if (String(sub["verdict"] ?? "") !== c["verdict"]) return bad(`child ${repo} verdict differs from the composite`);
    if (String(sub["head_sha"] ?? "") !== c["head_sha"] || !c["head_sha"]) return bad(`child ${repo} head_sha differs from the composite`);
    verdicts.push(String(c["verdict"]));
    if (typeof heads[repo] !== "string" || heads[repo] === "") { if (stated !== undefined) return bad(`child ${repo} has no integrated head`); unchecked ??= `child ${repo} has no integrated head to compare (legacy composite, freshness not checked)`; }
    else if (heads[repo] !== c["head_sha"]) return bad(`child ${repo} head ${String(c["head_sha"])} is not the integrated head ${String(heads[repo])}`);
    const r = await verifyOne(rp, deps);
    if (r.verdict === "TAMPERED") return bad(`child ${repo} failed verify: ${r.reasons.join("; ")}`);
    if (r.verdict === "UNSIGNED" && signed) unchecked ??= `child ${repo} receipt is unsigned under a signed composite`;
    if (r.verdict === "UNCHECKED") unchecked ??= `child ${repo} not checked: ${r.reasons.join("; ")}`;
  }
  const expect = compositeVerdict(verdicts);
  if (receipt["verdict"] !== expect) return bad(`recorded verdict ${String(receipt["verdict"])} differs from the children (${expect})`);
  return { problem: unchecked ? { verdict: "UNCHECKED", reason: `composite: ${unchecked}` } : null, verdict: expect };
}
/** composite_sha256: sha256 of canonicalJson over the body, i.e. the file minus composite_sha256 and verification. */
export function compositeHash(r: Record<string, unknown>): string {
  const { composite_sha256: _c, verification: _v, ...body } = r;
  return sha(canonicalJson(body));
}
/** Human lines for `loki verify`: the integration result and the head SHA each child attests, so nobody opens the JSON. */
export function compositeLines(c: Record<string, unknown>): string[] {
  const i = isObj(c["integration"]) ? c["integration"] : null, kids = Array.isArray(c["children"]) ? c["children"] : [];
  const out = i ? [`integration: ${text(i["status"], 40)} (exit ${String(i["exit_code"] ?? "n/a")}, log_sha256 ${String(i["log_sha256"] ?? "none")})`] : ["integration: not stated (legacy composite)"];
  for (const k of kids) if (isObj(k)) out.push(`  ${text(k["repo"], 80)} head_sha: ${text(k["head_sha"], 64)} (${text(k["verdict"], 20)})`);
  return out;
}
