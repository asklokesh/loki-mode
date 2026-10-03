// Changed files for a finished run when its events carry no diff: the run's receipt.json names base_sha and head_sha, and
// `git diff --numstat base head` in the run's discovered repo gives the per-file counts. Shas are validated as hex, git is
// spawned without a shell and with an explicit env, and a failure of any step reads as null (unmeasured), never as zero files.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/migrate.ts";
import { localRepos } from "../db/schema.ts";

export interface DiffStat {
  base: string;
  head: string;
  files: { path: string; added: number | null; removed: number | null }[];
  added: number;
  removed: number;
  source: "git";
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 5000;
const cache = new Map<string, DiffStat>();

const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

/** Parses `git diff --numstat` output; a binary file ("-\t-") keeps null counts. */
export function parseNumstat(out: string): DiffStat["files"] {
  const files: DiffStat["files"] = [];
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files.push({ path: m[3]!, added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
  }
  return files;
}

function readReceipt(runDir: string): { base_sha?: unknown; head_sha?: unknown } | null {
  let fd: number;
  try { fd = openSync(join(runDir, "receipt.json"), "r"); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECEIPT_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const j = JSON.parse(buf.toString("utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; } finally { closeSync(fd); }
}

/** Null when the run is unknown, has no local repo or receipt, has no valid shas, or git cannot answer. Only successes are cached (a finished run's range never changes). */
export function diffStatFor(db: Db, source: string, run: string): DiffStat | null {
  if (!ID.test(source) || !ID.test(run) || source.includes("..") || run.includes("..")) return null;
  const key = `${source}/${run}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const repo = db.select({ p: localRepos.realpath }).from(localRepos).where(and(eq(localRepos.sourceId, source))).get();
  if (!repo) return null;
  let repoReal: string, runsRoot: string, runDir: string;
  try {
    repoReal = realpathSync(repo.p);
    runsRoot = realpathSync(join(repoReal, ".loki", "runs"));
    runDir = realpathSync(join(runsRoot, run));
  } catch { return null; }
  if (runDir !== join(runsRoot, run) || !runDir.startsWith(runsRoot + sep)) return null;
  const r = readReceipt(runDir);
  const base = typeof r?.base_sha === "string" ? r.base_sha : "", head = typeof r?.head_sha === "string" ? r.head_sha : "";
  if (!SHA.test(base) || !SHA.test(head)) return null;
  try {
    const out = execFileSync("git", ["-C", repoReal, "-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", `${base}..${head}`, "--"], { env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = parseNumstat(out);
    const stat: DiffStat = { base, head, files, added: files.reduce((n, f) => n + (f.added ?? 0), 0), removed: files.reduce((n, f) => n + (f.removed ?? 0), 0), source: "git" };
    cache.set(key, stat);
    return stat;
  } catch { return null; }
}
