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
import { dirname, join } from "node:path";
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
const cell = (s: string): string => s.replace(/[\x00-\x1f\x7f|]+/g, " ").trim();
/** Markdown unit table for the PR body. */
export function unitTableLines(g: ReceiptGroup): string[] {
  return [
    `Units (group ${cell(g.group_id)}):`, "",
    "| Unit | Goal | Files | Tests | Tokens | Model | Verdict |", "|---|---|---|---|---|---|---|",
    ...g.units.map((u) => `| ${cell(u.unit_id)} | ${cell(u.goal)} | ${u.files.map(cell).join(", ")} | ${u.tests} | ${u.tokens} | ${cell(u.model)} | ${cell(u.verdict)} |`),
  ];
}
