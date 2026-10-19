// V2: recorded facts for the reviewer brief. Pure reading; anything unreadable stays undefined so the brief prints NOT RECORDED.
import { readFileSync } from "node:fs";
import { parseRiskDecls, type BriefFacts } from "../util/reviewer_brief.ts";
import { readScopeText } from "../util/run_cap.ts";
import type { Obj } from "../engine10/types.ts";

export function briefFacts(o: Partial<Record<string, Obj>>, runId: string, runDir: string): BriefFacts {
  const seal = (o.seal ?? {}) as { verdict?: string; receipt_path?: string; receipt_sha256?: string };
  const facts: BriefFacts = { runId, ...(seal.verdict ? { verdict: seal.verdict } : {}), receiptSha256: seal.receipt_sha256 ?? null };
  try { if (seal.receipt_path) facts.receipt = JSON.parse(readFileSync(seal.receipt_path, "utf8")); } catch { /* unreadable receipt: NOT RECORDED */ }
  const preRed = Array.isArray(o.verify?.["pre_red_checks"]) ? (o.verify?.["pre_red_checks"] as unknown[]).map(String) : []; // older receipts carry no pre_red key: fall back to verify's record
  if (preRed.length > 0 && Array.isArray(facts.receipt?.checks)) facts.receipt!.checks = facts.receipt!.checks.map((c) => (c.result === "fail" && c.name !== undefined && preRed.includes(c.name) ? { ...c, pre_red: true } : c));
  const card =(o.plan as { intent_card?: unknown } | undefined)?.intent_card;
  if (Array.isArray(card)) facts.intentCard = card.map(String);
  const rd = readScopeText(runDir);
  if (rd.status === "ok") {
    try {
      const j = JSON.parse(rd.text) as { files?: unknown };
      if (Array.isArray(j.files)) facts.declaredFiles = j.files.filter((x): x is string => typeof x === "string");
      facts.risks = parseRiskDecls(j);
    } catch { /* malformed scope file: NOT RECORDED */ }
  }
  return facts;
}
