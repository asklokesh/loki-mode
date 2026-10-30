// H4 (R1-16): per-repo, per-shape outcome history store. Moved out of e10ext/repomemory.ts to keep
// e10ext under its D42 line budget; it lives in the same per-repo cache dir.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoCacheDir } from "../../engine10/cache.ts";
import { withFileLockSync } from "../../util/atomic.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../util/receipt_signer.ts";

// H4 (R1-16): per-repo, per-shape outcome history, appended at seal. Local runs only; the
// router reads it as an evidence floor. A missing or corrupt file is a cold read; a write
// failure returns false instead of throwing so a seal is never lost to the recorder.
export const HISTORY_FILE = "router_history.json";
const HISTORY_CAP = 200;

export type RunExecutor = "haiku" | "sonnet";

/** Who owns a non-pass outcome; "code" is the only owner whose losses count as router evidence. */
export type RunOwner = "code" | "harness" | "env" | "provider";
export type RunVerdict = "pass" | "fail" | "error" | "not_proven";

export interface RunOutcome {
  shape: string;
  executor: RunExecutor;
  verdict: RunVerdict;
  owner: RunOwner | null;
  escalated: boolean;
  usd: number;
  wallS: number;
  /** RECEIPT-TRUTH: what wallS measures. "total-v1" = receipt time.total_s that reconciled with its stage buckets. Entries without it hold the old stage sum (implement only) and are ignored for wall estimates. */
  wallKind?: typeof WALL_KIND;
}
export const WALL_KIND = "total-v1" as const;

const EXECUTORS: readonly string[] = ["haiku", "sonnet"];
const VERDICTS: readonly string[] = ["pass", "fail", "error", "not_proven"];
const OWNERS: readonly string[] = ["code", "harness", "env", "provider"];

function validRun(v: unknown): v is RunOutcome {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["shape"] === "string" &&
    typeof r["executor"] === "string" && EXECUTORS.includes(r["executor"]) &&
    typeof r["verdict"] === "string" && VERDICTS.includes(r["verdict"]) &&
    (r["owner"] === null || (typeof r["owner"] === "string" && OWNERS.includes(r["owner"]))) &&
    typeof r["escalated"] === "boolean" &&
    typeof r["usd"] === "number" && Number.isFinite(r["usd"]) &&
    typeof r["wallS"] === "number" && Number.isFinite(r["wallS"])
  );
}

function historyPath(key: string, cacheRoot?: string): string {
  return resolve(repoCacheDir(key, cacheRoot), HISTORY_FILE);
}

/** Valid outcomes in append order; a corrupt file or invalid entries are dropped, never thrown. */
export function readRunHistory(key: string, cacheRoot?: string): RunOutcome[] {
  const path = historyPath(key, cacheRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const runs = (parsed as { runs?: unknown } | null)?.runs;
    return Array.isArray(runs) ? runs.filter(validRun) : [];
  } catch {
    return [];
  }
}

/** Appends one outcome, keeping the newest HISTORY_CAP entries. Returns false when the write fails. */
export function appendRunOutcome(key: string, outcome: RunOutcome, cacheRoot?: string): boolean {
  try {
    mkdirSync(repoCacheDir(key, cacheRoot), { recursive: true });
    const target = historyPath(key, cacheRoot);
    // Serialize the read-modify-write across processes: two concurrent runs on one repo must not lose an outcome.
    withFileLockSync(target, () => {
      const runs = [...readRunHistory(key, cacheRoot), outcome].slice(-HISTORY_CAP);
      // Temp file in the same directory, then rename: a crash mid-write cannot truncate the history.
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ runs }));
        renameSync(tmp, target);
      } catch (e) {
        rmSync(tmp, { force: true, recursive: false });
        throw e;
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** GAME10-09a: sealed outcome counts for one model tier on one repo shape. unsealed = a receipt whose seal is missing or does not match its content; it never counts toward verified. */
export interface TierOutcomeCount { verified: number; partial: number; failed: number; other: number; unsealed: number; total: number }
export type SealedTierRecord = Record<string, Record<string, TierOutcomeCount>>;
export interface ShapedReceipt { shape: string; receipt: Record<string, unknown> }

/** Model family of a receipt's model name; a missing or unrecognized model is "unknown", never a sonnet outcome. Not claudeTierRank: that returns a catalog role rank and null for legacy-tier ids, which history rows still carry. */
export function tierOfModel(model: unknown): string {
  const m = typeof model === "string" ? model.toLowerCase() : "";
  return m.includes("haiku") ? "haiku" : m.includes("opus") ? "opus" : m.includes("sonnet") ? "sonnet" : "unknown";
}

/** True only when receipt_sha256 is a hash that matches the receipt body (verification and the hash itself excluded, as seal.ts receiptSha256 does). A hash that cannot be computed is not a seal. */
export function receiptSealIntact(receipt: Record<string, unknown>): boolean {
  const recorded = receipt["receipt_sha256"];
  if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) return false;
  try {
    const { verification: _v, receipt_sha256: _h, ...body } = receipt;
    return createHash("sha256").update(canonicalJson(body)).digest("hex") === recorded;
  } catch {
    return false;
  }
}

/** Sealed outcome per shape per model tier, read from receipts. VERIFIED counts only with an intact seal. */
export function sealedOutcomesByTier(receipts: readonly ShapedReceipt[]): SealedTierRecord {
  const out: SealedTierRecord = Object.create(null); // shape names come from callers: "__proto__" must be a plain key
  for (const { shape, receipt } of receipts) {
    const tier = tierOfModel(receipt["model"]);
    const byTier = (out[shape] ??= Object.create(null) as Record<string, TierOutcomeCount>);
    const c = (byTier[tier] ??= { verified: 0, partial: 0, failed: 0, other: 0, unsealed: 0, total: 0 });
    c.total++;
    if (!receiptSealIntact(receipt)) { c.unsealed++; continue; }
    const v = receipt["verdict"];
    if (v === "VERIFIED") c.verified++;
    else if (v === "PARTIAL") c.partial++;
    else if (v === "FAILED") c.failed++;
    else c.other++;
  }
  return out;
}
