// Per-repo flaky quarantine (VERIFY-PLAN V8) and failure-signature log, stored in the E-18 per-repo cache dir
// (engine10/cache.ts, ENGINE.md section 13). Moved out of engine10/cache.ts to keep the core under its
// line cap. Reads never throw: missing or corrupt = empty.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, writeJson } from "../engine10/cache.ts";
import { safeGit } from "./safe_git.ts";

export interface FailureSignature {
  signature: string;
  count: number;
  sample: string;
}
function isFailureSignature(v: unknown): v is FailureSignature {
  const r = v as Partial<FailureSignature> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.signature === "string" &&
    typeof r.count === "number" &&
    Number.isFinite(r.count) &&
    typeof r.sample === "string"
  );
}
/** VERIFY-PLAN V8: the per-repo flaky quarantine (flaky-quarantine.json in the E-18 per-repo cache dir). A check is quarantined when it came back flaky
 *  on the change and also flipped between pass and fail on the base commit; it leaves the list after QUARANTINE_CLEAN_RUNS verifies in a row where it
 *  passed on its first try. Reads never throw: missing or corrupt is empty. */
export interface QuarantineEntry { first_run: string; last_run: string; base: string; clean: number }
export const QUARANTINE_CLEAN_RUNS = 3;
const QUARANTINE_FILE = "flaky-quarantine.json";
const isEntry = (v: unknown): v is QuarantineEntry => { const e = v as Partial<QuarantineEntry> | null; return typeof e === "object" && e !== null && typeof e.first_run === "string" && typeof e.last_run === "string" && typeof e.base === "string" && typeof e.clean === "number" && Number.isFinite(e.clean); };
const isQuarantine = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function readQuarantine(dir: string): Record<string, QuarantineEntry> {
  const raw = readJson<Record<string, unknown>>(resolve(dir, QUARANTINE_FILE), isQuarantine) ?? {};
  return Object.fromEntries(Object.entries(raw).filter((kv): kv is [string, QuarantineEntry] => isEntry(kv[1])));
}
export function writeQuarantine(dir: string, q: Record<string, QuarantineEntry>): void {
  writeJson(resolve(dir, QUARANTINE_FILE), dir, q);
}
/** One verify's update: a listed name that passed on its first try counts one clean run (and leaves at QUARANTINE_CLEAN_RUNS); a listed name that came
 *  back flaky resets to 0; each newly quarantined name is added with its base-run text. */
export function pruneQuarantine(q: Record<string, QuarantineEntry>, ranPass: readonly string[], flakyNow: readonly string[], added: Record<string, string>, runId: string): Record<string, QuarantineEntry> {
  const out: Record<string, QuarantineEntry> = {};
  for (const [n, e] of Object.entries(q)) {
    if (flakyNow.includes(n)) out[n] = { ...e, clean: 0, last_run: runId };
    else if (ranPass.includes(n)) { if (e.clean + 1 < QUARANTINE_CLEAN_RUNS) out[n] = { ...e, clean: e.clean + 1 }; }
    else out[n] = e;
  }
  for (const [n, base] of Object.entries(added)) out[n] = { first_run: runId, last_run: runId, base, clean: 0 };
  return out;
}
function failuresPath(dir: string): string {
  return resolve(dir, "failures.jsonl");
}
/** Appends one failure-signature record per group, one JSON object per line. */
export function recordFailures(dir: string, groups: readonly FailureSignature[]): void {
  if (groups.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const lines = `${groups.map((g) => JSON.stringify(g)).join("\n")}\n`;
  // O_APPEND write: no read-modify-write window, so concurrent runs cannot drop each other's lines.
  appendFileSync(failuresPath(dir), lines);
}
/** The top `n` failure signatures by total count across all recorded runs
 *  (ENGINE.md section 13: "the top 3 past failure signatures go into the
 *  implementer brief"). Missing file or all-corrupt lines yield []; a single
 *  bad line is skipped rather than sinking the whole read -- valid JSON of
 *  the wrong shape (null, a number, a record with no count) is exactly as
 *  corrupt as unparseable text and is skipped the same way. */
export function topFailures(dir: string, n = 3): FailureSignature[] {
  const path = failuresPath(dir);
  if (!existsSync(path)) return [];
  const totals = new Map<string, FailureSignature>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isFailureSignature(parsed)) continue;
    const rec = parsed;
    const prior = totals.get(rec.signature);
    totals.set(rec.signature, {
      signature: rec.signature,
      count: (prior?.count ?? 0) + rec.count,
      sample: rec.sample, // most recent sample wins
    });
  }
  return [...totals.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

/** P12-11 (FC-REQ): cross-run failure fingerprints, append-only, bounded. Extends this module (flaky.json holds
 *  only a deduped path set, failures.jsonl holds aggregate signatures; neither keeps a per-run row). Best effort:
 *  a concurrent append between the bounding read and the rename can lose a row. */
export const FINGERPRINT_MAX = 200;
export interface FingerprintRow { readonly ts: string; readonly run: string; readonly cls: string; readonly fp: string; readonly name: string; readonly tree?: string }
export function failureFingerprint(cls: string, name: string): string {
  return createHash("sha256").update(`${cls}\0${name}`).digest("hex").slice(0, 16);
}
export function readFingerprints(dir: string): FingerprintRow[] {
  const p = resolve(dir, "fingerprints.jsonl");
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").flatMap((l) => {
      try {
        const r = JSON.parse(l) as FingerprintRow;
        return typeof r?.fp === "string" ? [r] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
/** Appends one row per string name; never throws. Returns the accepted names. */
export function recordFingerprints(dir: string, runId: string, cls: string, names: unknown, tree = ""): string[] {
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n !== "") : [];
  if (list.length === 0) return list;
  try {
    const p = resolve(dir, "fingerprints.jsonl");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(p, `${list.map((name) => JSON.stringify({ ts, run: runId, cls, fp: failureFingerprint(cls, name), name, ...(tree !== "" ? { tree } : {}) })).join("\n")}\n`);
    const rows = readFingerprints(dir);
    if (rows.length > FINGERPRINT_MAX) {
      const tmpP = `${p}.${process.pid}.tmp`;
      writeFileSync(tmpP, `${rows.slice(-FINGERPRINT_MAX).map((r) => JSON.stringify(r)).join("\n")}\n`);
      renameSync(tmpP, p);
    }
  } catch {
    /* best effort */
  }
  return list;
}
/** P12-11b: rerun evidence for decideRecovery. Only a flaky row recorded against THIS tree id counts (verify reruns on one tree, so the row's tree is both the failing and passing tree). Rows without a tree, or from another tree, prove nothing. */
export function cleanTreeId(cwd: string): string {
  try {
    const st = safeGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
    if (st.split("\n").some((l) => l.trim() !== "" && !/^.. "?\.loki\//.test(l))) return "";
    return safeGit(cwd, ["rev-parse", "HEAD^{tree}"]).trim();
  } catch { return ""; }
}
export function flakyRerunSignal(dir: string, tree: string): { test: string; failTree: string; passTree: string } | undefined {
  if (tree === "") return undefined;
  const row = readFingerprints(dir).findLast((r) => r.cls === "flaky" && r.tree === tree);
  return row ? { test: row.name, failTree: tree, passTree: tree } : undefined;
}
/** FC-LINT-PRE-RED: the one definition of a blocking failure: result "fail" and not excused by verify's pre_red_checks (the check also fails on base). */
export const isBlockingFail = (c: unknown, preRed: readonly string[] = []): boolean => !!c && typeof c === "object" && (c as { result?: unknown }).result === "fail" && !preRed.includes(String((c as { name?: unknown }).name));
/** Q17-03: names of verify checks whose result is "fail" (flaky and not_run excluded; FC-LINT-PRE-RED: checks in preRed excluded). Junk input gives []. */
export function failedCheckNames(checks: unknown, preRed: readonly string[] = []): string[] {
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((c) => (isBlockingFail(c, preRed) && typeof (c as { name?: unknown }).name === "string" ? [(c as { name: string }).name] : []));
}
/** Q17-03: failed-check rows recorded on THIS known tree, for decideRecovery's failedChecks. undefined (no evidence) on an unknown tree or no rows, which keeps today's behavior. */
export function failedChecksSignal(dir: string, tree: string): string[] | undefined {
  if (tree === "") return undefined;
  const names = readFingerprints(dir).filter((r) => r.cls === "failed" && r.tree === tree).map((r) => r.name);
  return names.length > 0 ? [...new Set(names)] : undefined;
}
