// Per-repo flaky-test list and failure-signature log, stored in the E-18 per-repo cache dir
// (engine10/cache.ts, ENGINE.md section 13). Moved out of engine10/cache.ts to keep the core under its
// line cap; only e10ext/repomemory.ts consumes it. Reads never throw: missing or corrupt = empty.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, writeJson } from "../engine10/cache.ts";

export interface FailureSignature {
  signature: string;
  count: number;
  sample: string;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
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
/** Flaky test paths seen across past runs (deduped, sorted). */
export function readFlaky(dir: string): string[] {
  return readJson<string[]>(resolve(dir, "flaky.json"), isStringArray) ?? [];
}
/** Unions `testPaths` into the existing flaky list and writes it back. */
export function recordFlaky(dir: string, testPaths: readonly string[]): void {
  const merged = new Set([...readFlaky(dir), ...testPaths]);
  writeJson(resolve(dir, "flaky.json"), dir, [...merged].sort());
}
function failuresPath(dir: string): string {
  return resolve(dir, "failures.jsonl");
}
/** Appends one failure-signature record per group, one JSON object per line. */
export function recordFailures(dir: string, groups: readonly FailureSignature[]): void {
  if (groups.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const lines = `${groups.map((g) => JSON.stringify(g)).join("\n")}\n`;
  const existing = existsSync(failuresPath(dir)) ? readFileSync(failuresPath(dir), "utf8") : "";
  writeFileSync(failuresPath(dir), existing + lines);
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
export function flakyRerunSignal(dir: string, tree: string): { test: string; failTree: string; passTree: string } | undefined {
  if (tree === "") return undefined;
  const row = readFingerprints(dir).findLast((r) => r.cls === "flaky" && r.tree === tree);
  return row ? { test: row.name, failTree: tree, passTree: tree } : undefined;
}
