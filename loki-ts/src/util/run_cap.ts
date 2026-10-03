// FC-21 (b): the run wall-clock cap scales with task size. Pure; the CLI gathers the signals.
// An explicit cap (LOKI_E10_CAP_S) is returned untouched, so it is never shrunk or grown.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CAP_S } from "../engine10/types.ts";

export interface RunCapInput {
  text: string; // task text (for an issue run, the fetched title and body)
  fileCount: number; // tracked files in the repo
  subscription: boolean; // no dollar cap: time is the only guard, so large tasks get a generous cap
  explicitS?: number; // LOKI_E10_CAP_S
  yamlS?: number | null; // loki.yaml budgets.run_cap_s
}
const MEDIUM_CHARS = 600, LARGE_CHARS = 1500, BIG_REPO_FILES = 3000;
/** Seconds: explicit env wins, then loki.yaml, then the size-scaled default (small keeps DEFAULT_CAP_S). */
export function runCapS(i: RunCapInput): number {
  if (i.explicitS && i.explicitS > 0) return i.explicitS;
  if (i.yamlS && i.yamlS > 0) return i.yamlS;
  const n = i.text.length, large = n > LARGE_CHARS || (n > MEDIUM_CHARS && i.fileCount > BIG_REPO_FILES);
  if (large) return i.subscription ? 2700 : 1800;
  if (n > MEDIUM_CHARS) return i.subscription ? 1800 : 1200;
  return DEFAULT_CAP_S;
}
/** budgets.run_cap_s from loki.yaml text (a two-level read, like budgets.per_run). */
export function yamlRunCapS(text: string): number | null {
  const m = /^budgets:[ \t]*(?:#.*)?\n((?:[ \t]+.*\n?|[ \t]*\n)*)/m.exec(text);
  const v = m ? /^[ \t]+run_cap_s:[ \t]*(\d+)/m.exec(m[1]!)?.[1] : undefined;
  return v && Number(v) > 0 ? Number(v) : null;
}
/** Gathers the signals (task text, issue title and body, tracked file count, loki.yaml) and returns the run cap. Best effort: any unreadable signal falls back to the default. */
export function resolveRunCapS(repoDir: string, runDir: string, task: string, subscription: boolean, env: NodeJS.ProcessEnv = process.env): number {
  let text = task, fileCount = 0, yamlS: number | null = null;
  try { const i = JSON.parse(readFileSync(join(runDir, "issue.json"), "utf8")) as { title?: string; body?: string }; text += `\n${i.title ?? ""}\n${i.body ?? ""}`; } catch { /* no issue */ }
  try { fileCount = execFileSync("git", ["ls-files"], { cwd: repoDir, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], env: process.env }).split("\n").length; } catch { /* unknown size */ }
  for (const f of ["loki.yaml", "loki.yml"]) { const p = join(repoDir, f); if (existsSync(p)) try { yamlS = yamlRunCapS(readFileSync(p, "utf8")); } catch { /* unreadable */ } }
  return runCapS({ text, fileCount, subscription, explicitS: Number(env.LOKI_E10_CAP_S) || undefined, yamlS });
}
/** The line appended to the implement brief (after the cache-stable prefix) so the model can checkpoint. */
export const timeBudgetNote = (limitS: number): string => `Time budget: about ${Math.max(1, Math.round(limitS / 60))} minutes left for this session. Work in small steps, keep the test suite passing at every checkpoint, and leave the tree in a working state when time runs out.`;
