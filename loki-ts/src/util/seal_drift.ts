// loki-ts/src/util/seal_drift.ts -- P12-01: compare a sealed receipt with the workspace it describes (composite_seal.ts is group binding; nothing owned this).
// Three checks on an intact VERIFIED/UNSIGNED receipt: fabricated success (a pass the bound log never recorded), intent drift (task sha256 vs the current spec),
// head drift (head_sha vs the repo HEAD). Fabricated success is TAMPERED; drift is UNCHECKED (the seal is intact but no longer describes the current state).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readEvents } from "../engine10/events.ts";

const EMPTY_SHA = createHash("sha256").digest("hex");
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
export interface Drift { verdict: "TAMPERED" | "UNCHECKED"; reason: string }
type Obj = Record<string, unknown>;

/** A receipt whose bound log shows the verify stage ran must not claim a passing check the log never recorded as a test.result pass. Unbound receipts (no log at seal) are skipped. */
function fabricatedPass(receiptPath: string, r: Obj): string | null {
  const bound = r["events_sha256"];
  if (typeof bound !== "string" || bound === EMPTY_SHA || !Array.isArray(r["checks"])) return null;
  const log = join(dirname(receiptPath), "events.jsonl");
  const events = readEvents(log);
  if (!events.some((e) => e.stage === "verify")) return null; // the verify stage left no trace (hand-built or partial log): nothing to compare
  const passed = new Set(events.filter((e) => e.type === "test.result" && e.data["result"] === "pass").map((e) => String(e.data["name"])));
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

export function sealDrift(receiptPath: string, r: Obj, env: NodeJS.ProcessEnv = process.env): Drift | null {
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
