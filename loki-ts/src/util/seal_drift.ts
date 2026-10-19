// loki-ts/src/util/seal_drift.ts -- P12-01: compare a sealed receipt with the workspace it describes (composite_seal.ts is group binding; nothing owned this).
// Three checks on an intact VERIFIED/UNSIGNED receipt: fabricated success (a pass the bound log never recorded), intent drift (task sha256 vs the current spec),
// head drift (head_sha vs the repo HEAD). Fabricated success is TAMPERED; drift is UNCHECKED (the seal is intact but no longer describes the current state).
import { safeGit } from "./safe_git.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
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

/** Paths changed since the seal (head_sha..HEAD) that the sealed diff (base_sha..head_sha) also touched. A moved HEAD with no overlap is benign (empty list).
 *  Null when the sealed diff cannot be established (no usable base_sha, repo error, empty sealed diff): the caller then treats any HEAD move as drift. */
function overlap(repo: string, base: unknown, sealedHead: string, head: string): string[] | null {
  if (typeof base !== "string" || !/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(sealedHead)) return null;
  try {
    const names = (a: string, b: string): string[] => safeGit(repo, ["diff", "--name-only", "--no-renames", "-z", a, b]).split("\0").filter((x) => x !== "");
    const sealed = new Set(names(base, sealedHead));
    if (sealed.size === 0) return null;
    return names(sealedHead, head).filter((x) => sealed.has(x));
  } catch { return null; }
}

/** FC-VERIFIED-PR-WITHOUT-ITS-TEST: true only when EVERY commit after the sealed head is this run's Wall publish commit: a trailer line naming the receipt's run_id, only paths of the receipt's wall.files, each blob sha256 equal to the sealed one.
 *  Anything else (a hook-added file, a rewritten Wall file, a forged trailer, a non-linear history) is not benign. */
function onlyWallPublish(repo: string, r: Obj, sealedHead: string, head: string): boolean {
  const run = r["run_id"], wall = ((r["wall"] ?? {}) as { files?: { path?: unknown; sha256?: unknown }[] }).files;
  if (typeof run !== "string" || run === "" || !Array.isArray(wall) || !/^[0-9a-f]{40,64}$/.test(sealedHead)) return false;
  try {
    const real = (x: string): string => { try { return realpathSync(x); } catch { return x; } }, rr = real(repo), want = new Map(wall.map((w) => [relative(rr, join(real(dirname(String(w.path))), basename(String(w.path)))), String(w.sha256)] as const));
    const commits = safeGit(repo, ["rev-list", "--reverse", "--topo-order", `${sealedHead}..${head}`]).split("\n").filter(Boolean);
    if (commits.length === 0 || safeGit(repo, ["rev-list", "--merges", "--count", `${sealedHead}..${head}`]).trim() !== "0") return false;
    let parent = sealedHead;
    for (const c of commits) {
      if (safeGit(repo, ["rev-parse", `${c}^`]).trim() !== parent) return false;
      if (!safeGit(repo, ["log", "-1", "--format=%B", c]).split("\n").includes(`Loki-Wall-Publish: ${run}`)) return false;
      const names = safeGit(repo, ["diff", "--name-only", "--no-renames", "-z", parent, c]).split("\0").filter(Boolean);
      if (names.length === 0) return false;
      for (const n of names) { const h = want.get(n); if (h === undefined || sha(safeGit(repo, ["cat-file", "blob", `${c}:${n}`])) !== h) return false; }
      parent = c;
    }
    return true;
  } catch { return false; }
}

/** Any commit after the sealed head that carries this run's Wall trailer. Such a commit must pass onlyWallPublish; other later commits keep the TEN-GATES-16 sealed-path overlap rule. */
function claimsWallPublish(repo: string, r: Obj, sealedHead: string, head: string): boolean {
  try { return typeof r["run_id"] === "string" && safeGit(repo, ["log", "--format=%B", `${sealedHead}..${head}`]).split("\n").includes(`Loki-Wall-Publish: ${r["run_id"]}`); } catch { return false; }
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
    try { head = safeGit(repo, ["rev-parse", "HEAD"]).trim(); } catch { return null; }
    if (head !== "" && head !== r["head_sha"] && !onlyWallPublish(repo, r, r["head_sha"], head)) {
      if (claimsWallPublish(repo, r, r["head_sha"], head)) return { verdict: "UNCHECKED", reason: `head drift: HEAD ${head} carries a Loki-Wall-Publish commit for this run that is not exactly its sealed Wall files (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` }; // a trailer is a claim; a forged or hook-widened child is never benign
      const hit = overlap(repo, r["base_sha"], r["head_sha"], head);
      if (hit === null) return { verdict: "UNCHECKED", reason: `head drift: receipt head_sha ${r["head_sha"]} is not the current HEAD ${head} (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` };
      if (hit.length) return { verdict: "UNCHECKED", reason: `head drift: HEAD ${head} changed sealed path(s) after the seal: ${hit.join(", ")} (LOKI_VERIFY_ALLOW_HEAD_DRIFT=1 accepts)` };
    }
  }
  return null;
}
