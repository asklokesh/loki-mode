// loki-ts/src/util/seal_drift.ts -- P12-01: compare a sealed receipt with the workspace it describes (composite_seal.ts is group binding; nothing owned this).
// Three checks on an intact VERIFIED/UNSIGNED receipt: fabricated success (a pass the bound log never recorded), intent drift (task sha256 vs the current spec),
// head drift (head_sha vs the repo HEAD). Fabricated success is TAMPERED; drift is UNCHECKED (the seal is intact but no longer describes the current state).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EventEnvelope } from "../engine10/types.ts";

const EMPTY_SHA = createHash("sha256").digest("hex");
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
export interface Drift { verdict: "TAMPERED" | "UNCHECKED"; reason: string }
type Obj = Record<string, unknown>;

/** The events the receipt hash actually covers: the line-aligned prefix of events.jsonl hashing to events_sha256 (verify_cmd checkEventLog's rule), cut at log.sealed.
 *  Lines appended after seal are unbound and prove nothing. Null when no prefix matches (checkEventLog already reports that as TAMPERED). */
function boundEvents(log: string, bound: string): EventEnvelope[] | null {
  if (!existsSync(log)) return null;
  const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.trim() !== ""), h = createHash("sha256");
  let n = -1;
  for (let i = 0; i <= lines.length; i++) { if (h.copy().digest("hex") === bound) { n = i; break; } if (i < lines.length) h.update(lines[i] + "\n"); }
  if (n < 0) return null;
  const evs = lines.slice(0, n).flatMap((l) => { try { return [JSON.parse(l) as EventEnvelope]; } catch { return []; } });
  const sealed = evs.findIndex((e) => e.type === "log.sealed");
  return sealed >= 0 ? evs.slice(0, sealed) : evs;
}

/** A receipt whose bound log shows the verify stage ran must not claim a passing check the log never recorded as a test.result pass. Unbound receipts (no log at seal) are skipped. */
function fabricatedPass(receiptPath: string, r: Obj): string | null {
  const bound = r["events_sha256"];
  if (typeof bound !== "string" || bound === EMPTY_SHA || !Array.isArray(r["checks"])) return null;
  const events = boundEvents(join(dirname(receiptPath), "events.jsonl"), bound);
  if (!events || !events.some((e) => e.stage === "verify")) return null; // the verify stage left no trace (hand-built or partial log): nothing to compare
  const passed = new Set(events.filter((e) => e.type === "test.result" && e.stage === "verify" && e.data["result"] === "pass").map((e) => String(e.data["name"])));
  const missing = (r["checks"] as Obj[]).filter((c) => c?.["result"] === "pass" && !passed.has(String(c["name"]))).map((c) => String(c["name"]));
  return missing.length ? `receipt claims pass with no test.result pass in events.jsonl: ${missing.join(", ")}` : null;
}

/** The current spec the sealed task sha256 is compared with: the run's issue.json (issue source), or the file named by LOKI_VERIFY_TASK_FILE (text source). Null when none is available. */
function currentTaskSha(runDir: string, source: unknown, env: NodeJS.ProcessEnv): string | null {
  const f = source === "issue" ? join(runDir, "issue.json") : env["LOKI_VERIFY_TASK_FILE"];
  return f && existsSync(f) ? sha(readFileSync(f)) : null;
}

/** <repo>/.loki/runs/<id>/receipt.json -> <repo>; null for any other layout (a copied receipt has no workspace to drift from). */
function repoOf(receiptPath: string): string | null {
  const runs = dirname(dirname(receiptPath));
  return basename(runs) === "runs" && basename(dirname(runs)) === ".loki" ? dirname(dirname(runs)) : null;
}

export function sealDrift(given: string, r: Obj, env: NodeJS.ProcessEnv = process.env): Drift | null {
  let receiptPath = given;
  try { receiptPath = join(realpathSync(dirname(given)), basename(given)); } catch { /* keep the given path */ } // resolve the DIRECTORY only (as verifyReceipt/checkEventLog read the log from dirname(given)); a receipt.json symlink must not move the log and layout lookup
  const fab = fabricatedPass(receiptPath, r);
  if (fab) return { verdict: "TAMPERED", reason: fab };
  const task = (r["task"] ?? {}) as { source?: unknown; sha256?: unknown };
  const cur = currentTaskSha(dirname(receiptPath), task.source, env);
  if (cur !== null && typeof task.sha256 === "string" && task.sha256 !== "" && cur !== task.sha256) return { verdict: "UNCHECKED", reason: `intent drift: sealed task sha256 ${task.sha256} differs from the current spec ${cur}` };
  const repo = repoOf(receiptPath);
  if (repo && env["LOKI_VERIFY_ALLOW_HEAD_DRIFT"] !== "1" && typeof r["head_sha"] === "string") {
    let head = "";
    try { head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
    if (head !== "" && head !== r["head_sha"]) return { verdict: "UNCHECKED", reason: `head drift: receipt head_sha ${r["head_sha"]} is not the current HEAD ${head} (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` };
  }
  return null;
}
