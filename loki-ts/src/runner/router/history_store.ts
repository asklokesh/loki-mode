// H4 (R1-16): per-repo, per-shape outcome history store. Moved out of e10ext/repomemory.ts to keep
// e10ext under its D42 line budget; it lives in the same per-repo cache dir.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoCacheDir } from "../../engine10/cache.ts";

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
}

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
    const runs = [...readRunHistory(key, cacheRoot), outcome].slice(-HISTORY_CAP);
    mkdirSync(repoCacheDir(key, cacheRoot), { recursive: true });
    // Temp file in the same directory, then rename: a crash mid-write cannot truncate the history.
    const target = historyPath(key, cacheRoot);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ runs }));
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true, recursive: false });
      throw e;
    }
    return true;
  } catch {
    return false;
  }
}
