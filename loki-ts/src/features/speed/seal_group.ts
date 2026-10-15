// D61 slice 13: one Seal, a combined receipt, and a per-unit sub-receipt bound by hash.
//
// Layout next to the combined receipt (written by the group runner before Seal):
//   group/manifest.json                    { group_id, units: [{ unit_id, goal, files, tests, tokens, model }] }  (DAG order)
//   group/units/<unit_id>/receipt.json     the unit's own sealed receipt
//   group/units/<unit_id>/events.jsonl     the unit's own event log
// Seal reads these once and stores a `group` section in the combined receipt body, so the combined
// receipt_sha256 (and its signature) covers, per unit and in order: the sub-receipt file hash, the
// sub-receipt's own receipt_sha256, its verdict and the unit's full events file hash. Verify recomputes
// all of it and also runs the full verify on every sub-receipt. Nothing here produces a verdict:
// the combined verdict still comes from the Seal computation, and this module can only lower it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalJson } from "../../util/receipt_signer.ts";
import type { Verdict } from "../../engine10/types.ts";
import type { VerifyDeps } from "../../engine10/verify_cmd.ts";

export interface GroupUnit {
  index: number;
  unit_id: string;
  sub_receipt_sha256: string;
  receipt_sha256: string;
  events_file_sha256: string | null;
  verdict: string;
  goal: string;
  files: string[];
  tests: number;
  tokens: number;
  model: string;
}
export interface ReceiptGroup { group_id: string; units: GroupUnit[] }
export interface GroupSeal { section: ReceiptGroup | undefined; notProven: string[]; problems: number; allUnitsPass: boolean }
/** Same hash the receipt uses (seal.ts receiptSha256), injected so this module never imports seal.ts or verify_cmd.ts. */
type RecHash = (r: Record<string, unknown>) => string;
type VerifyOne = (receiptPath: string, deps?: VerifyDeps) => Promise<{ verdict: string; reasons: string[] }>;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PASSING = new Set(["VERIFIED", "ALREADY_SATISFIED"]);
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, cap: number): string => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, cap) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const unitsDir = (runDir: string): string => join(runDir, "group", "units");
const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const dirNames = (d: string): string[] | null => { try { return readdirSync(d).filter((n) => !n.startsWith(".")).sort(); } catch { return null; } }; // dotfiles (.DS_Store) are not units
/** Reads the group directory under runDir. No group/manifest.json means a single run: inert, so the receipt is byte-identical to today. */
export function sealGroup(runDir: string, rh: RecHash): GroupSeal {
  const manifestPath = join(runDir, "group", "manifest.json");
  if (!existsSync(manifestPath)) return { section: undefined, notProven: [], problems: 0, allUnitsPass: true };
  const notProven: string[] = [];
  let problems = 0;
  const fail = (m: string): void => { problems++; notProven.push(`group: ${m}`); };
  const m = readJson(manifestPath);
  const list = isObj(m) && Array.isArray(m["units"]) ? (m["units"] as unknown[]) : [];
  if (!isObj(m) || !ID_RE.test(String(m["group_id"] ?? "")) || list.length === 0) {
    fail("manifest missing, unreadable or empty");
    return { section: undefined, notProven, problems, allUnitsPass: false };
  }
  const units: GroupUnit[] = [];
  const seen = new Set<string>(), seenLower = new Set<string>();
  let allUnitsPass = true;
  list.forEach((raw, index) => {
    const u = isObj(raw) ? raw : {};
    const id = String(u["unit_id"] ?? "");
    if (!ID_RE.test(id) || seen.has(id) || seenLower.has(id.toLowerCase())) return fail(`unit ${index} has an invalid, duplicate or case-colliding id`);
    seen.add(id); seenLower.add(id.toLowerCase());
    const dir = join(unitsDir(runDir), id), rp = join(dir, "receipt.json"), ep = join(dir, "events.jsonl");
    let bytes: Buffer;
    try { bytes = readFileSync(rp); } catch { return fail(`unit ${id} sub-receipt missing`); }
    const sub = readJson(rp);
    if (!isObj(sub) || typeof sub["receipt_sha256"] !== "string" || rh(sub) !== sub["receipt_sha256"]) return fail(`unit ${id} sub-receipt unreadable or its hash does not recompute`);
    const verdict = String(sub["verdict"] ?? "");
    if (!PASSING.has(verdict)) { allUnitsPass = false; notProven.push(`group: unit ${id} verdict ${verdict || "unknown"}`); }
    units.push({
      index, unit_id: id, sub_receipt_sha256: sha(bytes), receipt_sha256: sub["receipt_sha256"], events_file_sha256: existsSync(ep) ? sha(readFileSync(ep)) : null, verdict,
      goal: text(u["goal"], 200), files: (Array.isArray(u["files"]) ? u["files"] : []).map((f) => text(f, 200)).filter(Boolean).slice(0, 50), tests: num(u["tests"]), tokens: num(u["tokens"]), model: text(u["model"], 64),
    });
  });
  const extra = (dirNames(unitsDir(runDir)) ?? []).filter((n) => !seen.has(n));
  for (const n of extra) fail(`unit directory ${text(n, 64)} is not in the manifest`);
  return { section: problems === 0 ? { group_id: String((m as Record<string, unknown>)["group_id"]), units } : undefined, notProven, problems, allUnitsPass: allUnitsPass && problems === 0 };
}
/** Only ever lowers: a sub-receipt problem is FAILED, a non-passing unit caps VERIFIED at PARTIAL. Never raises anything to VERIFIED. */
export function capGroupVerdict(v: Verdict, g: GroupSeal): Verdict {
  if (g.problems > 0) return v === "SPEC_CONFLICT" ? v : "FAILED";
  return !g.allUnitsPass && (v === "VERIFIED" || v === "ALREADY_SATISFIED") ? "PARTIAL" : v;
}
/** Verify side. Null means the group section checks out (or the receipt is a single run with no group directory). */
export async function verifyGroup(receiptPath: string, receipt: Record<string, unknown>, rh: RecHash, verifyOne: VerifyOne, deps: VerifyDeps = {}): Promise<{ verdict: "TAMPERED" | "UNCHECKED"; reason: string } | null> {
  const runDir = dirname(receiptPath);
  const signed = isObj(receipt["verification"]) && typeof receipt["verification"]["jwt"] === "string"; // a signed combined receipt needs signed sub-receipts (enforced here: signing is decided after Seal reads the group, and D71 caps core hook lines)
  const bad = (reason: string): { verdict: "TAMPERED"; reason: string } => ({ verdict: "TAMPERED", reason: `group: ${reason}` });
  const g = receipt["group"];
  if (g === undefined) return existsSync(join(runDir, "group", "manifest.json")) ? bad("group directory present but the receipt has no group section") : null;
  if (!isObj(g) || !ID_RE.test(String(g["group_id"] ?? "")) || !Array.isArray(g["units"]) || g["units"].length === 0) return bad("group section malformed");
  const entries = g["units"] as unknown[];
  const ids = entries.map((e) => (isObj(e) ? String(e["unit_id"] ?? "") : ""));
  if (ids.some((id) => !ID_RE.test(id)) || new Set(ids.map((i) => i.toLowerCase())).size !== ids.length) return bad("unit ids invalid, duplicated or case-colliding");
  const onDisk = dirNames(unitsDir(runDir));
  if (onDisk === null || onDisk.join("\0") !== [...ids].sort().join("\0")) return bad("unit directories do not match the receipt (missing or extra unit)");
  let unchecked: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Record<string, unknown>, id = ids[i]!, dir = join(unitsDir(runDir), id), rp = join(dir, "receipt.json"), ep = join(dir, "events.jsonl");
    if (e["index"] !== i) return bad(`unit ${id} is out of order (index ${String(e["index"])} at position ${i})`);
    let bytes: Buffer;
    try { if (!statSync(dir).isDirectory()) return bad(`unit ${id} is not a directory`); bytes = readFileSync(rp); } catch { return bad(`unit ${id} sub-receipt missing`); }
    if (sha(bytes) !== e["sub_receipt_sha256"]) return bad(`unit ${id} sub-receipt does not match its recorded hash`);
    const evSha = existsSync(ep) ? sha(readFileSync(ep)) : null;
    if (evSha !== (e["events_file_sha256"] ?? null)) return bad(`unit ${id} events.jsonl does not match its recorded hash`);
    const sub = readJson(rp);
    if (!isObj(sub) || sub["receipt_sha256"] !== e["receipt_sha256"] || rh(sub) !== e["receipt_sha256"]) return bad(`unit ${id} sub-receipt hash does not recompute`);
    if (String(sub["verdict"] ?? "") !== e["verdict"]) return bad(`unit ${id} verdict differs from the combined receipt`);
    const r = await verifyOne(rp, deps);
    if (r.verdict === "UNSIGNED" && signed) unchecked ??= `unit ${id} sub-receipt is unsigned under a signed combined receipt`;
    if (r.verdict === "TAMPERED") return bad(`unit ${id} sub-receipt failed verify: ${r.reasons.join("; ")}`);
    if (r.verdict === "UNCHECKED") unchecked ??= `unit ${id} sub-receipt not checked: ${r.reasons.join("; ")}`;
  }
  return unchecked ? { verdict: "UNCHECKED", reason: `group: ${unchecked}` } : null;
}

// Composite receipt: one signed artifact over every child repo receipt of a workspace run.
// Layout (written by `loki verify --seal-composite <run_dir>`): <run_dir>/composite.json next to integration.json,
// child receipts at <run_dir>/worktrees/<repo slug>/.loki/runs/<run id>/receipt.json. The body binds, in order, each child's
// receipt file hash, receipt_sha256, head_sha and verdict, plus the integration.json file hash. composite_sha256 is the
// sha256 of canonicalJson(body); the signature is the existing signReceipt over it. The verdict is computed from the children
// (capGroupVerdict) and can never read higher than the weakest child.
export const COMPOSITE_SCHEMA = "loki.v10.composite/1";
export interface CompositeChild { repo: string; run_id: string; receipt_path: string; receipt_file_sha256: string; receipt_sha256: string; head_sha: string; verdict: string }
export interface CompositeBody { schema: string; workspace: string; run_id: string; integration_sha256: string; children: CompositeChild[]; verdict: string }
const slugOf = (repo: string): string => repo.replace(/\//g, "__"); // mirrors workspace.py _slug
export const isComposite = (r: Record<string, unknown>): boolean => r["schema"] === COMPOSITE_SCHEMA;
/** Cap rule shared by seal and verify: FAILED child fails, SPEC_CONFLICT stays, any non-passing child caps at PARTIAL. */
export function compositeVerdict(childVerdicts: string[]): Verdict {
  const base: Verdict = childVerdicts.includes("SPEC_CONFLICT") ? "SPEC_CONFLICT" : childVerdicts.length > 0 && childVerdicts.every((v) => v === "ALREADY_SATISFIED") ? "ALREADY_SATISFIED" : "VERIFIED";
  const failed = childVerdicts.filter((v) => v === "FAILED" || !["VERIFIED", "ALREADY_SATISFIED", "PARTIAL", "SPEC_CONFLICT"].includes(v)).length;
  return capGroupVerdict(base, { section: undefined, notProven: [], problems: failed, allUnitsPass: childVerdicts.every((v) => PASSING.has(v)) });
}
const relOk = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.split("/").includes("..");
/** Builds the unsigned composite body. Throws (message names the repo) unless every workspace repo has a readable child receipt. */
export function composeComposite(runDir: string, rh: RecHash): CompositeBody {
  const ip = join(runDir, "integration.json");
  let ibytes: Buffer;
  try { ibytes = readFileSync(ip); } catch { throw new Error("integration.json missing; the workspace run did not finish"); }
  const integ = readJson(ip);
  if (!isObj(integ) || !isObj(integ["outcomes"])) throw new Error("integration.json has no outcomes");
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
    if (typeof heads[repo] === "string" && heads[repo] !== head) throw new Error(`repo ${text(repo, 80)} receipt head ${head} is not the integrated head ${String(heads[repo])} (stale receipt)`);
    children.push({ repo, run_id: String(r["run_id"] ?? id), receipt_path: `worktrees/${slugOf(repo)}/.loki/runs/${id}/receipt.json`, receipt_file_sha256: sha(bytes), receipt_sha256: r["receipt_sha256"], head_sha: head, verdict: String(r["verdict"] ?? "") });
  }
  if (children.length === 0) throw new Error("workspace has no repos");
  return { schema: COMPOSITE_SCHEMA, workspace: basename(dirname(runDir)), run_id: basename(runDir), integration_sha256: sha(ibytes), children, verdict: compositeVerdict(children.map((c) => c.verdict)) };
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
  const integ = readJson(join(runDir, "integration.json")), heads = isObj(integ) && isObj(integ["heads"]) ? integ["heads"] : {};
  let unchecked: string | null = null;
  const verdicts: string[] = [];
  for (const raw of kids as unknown[]) {
    const c = isObj(raw) ? raw : {}, repo = String(c["repo"] ?? ""), rel = String(c["receipt_path"] ?? "");
    if (!repo || !relOk(rel)) return bad(`child ${text(repo, 80) || "?"} has an invalid receipt path`);
    const rp = join(runDir, rel);
    let bytes: Buffer;
    try { bytes = readFileSync(rp); } catch { return bad(`child ${repo} receipt missing`); }
    if (sha(bytes) !== c["receipt_file_sha256"]) return bad(`child ${repo} receipt does not match its recorded hash (swapped or edited)`);
    const sub = readJson(rp);
    if (!isObj(sub) || sub["receipt_sha256"] !== c["receipt_sha256"] || rh(sub) !== c["receipt_sha256"]) return bad(`child ${repo} receipt hash does not recompute`);
    if (String(sub["verdict"] ?? "") !== c["verdict"]) return bad(`child ${repo} verdict differs from the composite`);
    if (String(sub["head_sha"] ?? "") !== c["head_sha"] || !c["head_sha"]) return bad(`child ${repo} head_sha differs from the composite`);
    verdicts.push(String(c["verdict"]));
    if (typeof heads[repo] === "string" && heads[repo] !== c["head_sha"]) unchecked ??= `child ${repo} head ${String(c["head_sha"])} is not the integrated head ${String(heads[repo])}`;
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
