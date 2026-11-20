// No module owns rules a repository was taught by earlier misses; features/ holds the other opt-in rule modules (no_regression.ts, runner_config.ts).
// VERIFY-PLAN V10 (LOKI_E10_CHECKLIST, observe by default): a tracked .loki-checklist.json at the repository root, read from the base commit only.
import { ruleMode } from "../engine10/closure.ts";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "../util/check_result.ts";
import { safeGit } from "../util/safe_git.ts";
import { addedLinesOf } from "./self_review.ts";

export interface ChecklistItem { id: string; trigger: { paths?: string[]; added?: string }; check: { forbid_added?: string; cmd?: string }; why: string; taught_by: string }
export interface ChecklistResult { id: string; result: "pass" | "fail" | "not_run"; detail: string }
type Run = { ok: boolean; cut: boolean; missing: boolean; out: string };
export const CHECKLIST_FILE = ".loki-checklist.json";
export const CHECKLIST_MAX_ITEMS = 50;
export const checklistMode = (env: NodeJS.ProcessEnv = process.env) => ruleMode("LOKI_E10_CHECKLIST", "observe", env);
/** cmd items run only when LOKI_E10_CHECKLIST is set to observe or enforce explicitly; with it unset only forbid_added items are evaluated. */
export const checklistCmdOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env["LOKI_E10_CHECKLIST"] ?? "").trim() !== "" && checklistMode(env) !== "off";

const regexOk = (s: unknown): boolean => { if (typeof s !== "string") return false; try { new RegExp(s); return true; } catch { return false; } };
function validItem(v: unknown): string | null {
  const it = v as Partial<ChecklistItem> | null;
  if (!it || typeof it !== "object") return "an item is not an object";
  if (typeof it.id !== "string" || !it.id) return "an item has no id";
  if (!it.trigger || typeof it.trigger !== "object" || !it.check || typeof it.check !== "object") return `item ${it.id}: trigger and check must be objects`;
  if (it.trigger.paths !== undefined && !(Array.isArray(it.trigger.paths) && it.trigger.paths.every((p) => typeof p === "string"))) return `item ${it.id}: trigger.paths must be a list of globs`;
  if (it.trigger.added !== undefined && !regexOk(it.trigger.added)) return `item ${it.id}: trigger.added is not a valid regex`;
  if (it.check.forbid_added === undefined && it.check.cmd === undefined) return `item ${it.id}: the check has neither forbid_added nor cmd`;
  if (it.check.forbid_added !== undefined && !regexOk(it.check.forbid_added)) return `item ${it.id}: check.forbid_added is not a valid regex`;
  if (it.check.cmd !== undefined && (typeof it.check.cmd !== "string" || !it.check.cmd.trim())) return `item ${it.id}: check.cmd must be a command`;
  if (typeof it.why !== "string" || typeof it.taught_by !== "string") return `item ${it.id}: why and taught_by must be text`;
  return null;
}
/** The checklist as the base commit holds it (`git show <base>:.loki-checklist.json`); a change that adds or edits the file is never read. */
export function readChecklist(repoDir: string, baseSha: string): { items: ChecklistItem[]; problem?: string } {
  let text: string;
  try { text = safeGit(repoDir, ["show", `${baseSha}:${CHECKLIST_FILE}`]); } catch { return { items: [] }; } // no checklist in the base commit
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { items: [], problem: `${CHECKLIST_FILE} is not valid JSON` }; }
  const d = doc as { version?: unknown; items?: unknown };
  if (!d || typeof d !== "object" || d.version !== 1 || !Array.isArray(d.items)) return { items: [], problem: `${CHECKLIST_FILE} must be {"version": 1, "items": [...]}` };
  if (d.items.length > CHECKLIST_MAX_ITEMS) return { items: [], problem: `${CHECKLIST_FILE} has ${d.items.length} items (at most ${CHECKLIST_MAX_ITEMS})` };
  const seen = new Set<string>();
  for (const it of d.items) {
    const why = validItem(it); if (why) return { items: [], problem: why };
    const id = (it as ChecklistItem).id; if (seen.has(id)) return { items: [], problem: `item id ${id} is not unique` }; seen.add(id);
  }
  return { items: d.items as ChecklistItem[] };
}
/** `paths` globs are anchored at the repository root and read by check_result.ts globToRegExp (`*` within a segment, `**` across, `?` one character). A pattern
 *  whose last segment matches a directory matches everything under it: `src` and `src/*` both match src/a/b.ts. */
const matching = (it: ChecklistItem, changed: readonly string[]): string[] => { const res = (it.trigger.paths ?? []).map((p) => globToRegExp("/" + p)); return changed.filter((f) => !res.length || res.some((r) => r.test(f))); };
/** The lines the change adds to `f`, with their line numbers, read by self_review.ts addedLinesOf: the -U0 diff against the base commit, or, for a path the base
 *  commit does not hold (a file the change creates, untracked until seal, so absent from `git diff <base>`), every line of the regular file in the checkout,
 *  numbered from 1, without the empty piece after a final newline. */
export function addedLines(repoDir: string, baseSha: string, f: string): { lines: string[]; nos: number[] } {
  let inBase = true;
  if (baseSha) try { safeGit(repoDir, ["cat-file", "-e", `${baseSha}:${f}`]); } catch { inBase = false; }
  if (!inBase) { try { if (!lstatSync(join(repoDir, f)).isFile()) return { lines: [], nos: [] }; } catch { return { lines: [], nos: [] }; } } // a symlink or directory: never read through it
  const a = addedLinesOf(repoDir, baseSha, f, !inBase) ?? { lines: [], nos: [] };
  if (!inBase && a.lines[a.lines.length - 1] === "") { a.lines.pop(); a.nos.pop(); }
  return a;
}
/** The items whose trigger the change matches: a changed file under one of `paths` (absent: any changed file) and, when `added` is set, an added line there that matches it. */
export function firedItems(items: readonly ChecklistItem[], changed: readonly string[], addedLines: (f: string) => string[]): ChecklistItem[] {
  return items.filter((it) => { const files = matching(it, changed); if (!files.length) return false; if (it.trigger.added === undefined) return true; const re = new RegExp(it.trigger.added); return files.some((f) => addedLines(f).some((l) => re.test(l))); });
}
/** Runs each fired item. forbid_added fails on a matching added line (file:line named). A cmd item runs once only with cmdOn; when it fails on the change it is run once in
 *  the base tree and fails only if base passes (fails there too: not run; no base run possible: not run). */
export async function runChecklist(fired: readonly ChecklistItem[], addedLines: (f: string) => string[], opts: { cmdOn: boolean; changed: readonly string[]; lineNo?: (f: string, i: number) => number | undefined; run: (cmd: string) => Promise<Run>; runBase: (cmd: string) => Promise<Run | null> }): Promise<ChecklistResult[]> {
  const out: ChecklistResult[] = [];
  for (const it of fired) {
    if (it.check.forbid_added !== undefined) {
      const re = new RegExp(it.check.forbid_added), files = matching(it, opts.changed);
      let hit: string | null = null;
      for (const f of files) { const ls = addedLines(f); const i = ls.findIndex((l) => re.test(l)); if (i >= 0) { hit = `${f}:${opts.lineNo?.(f, i) ?? "?"}: ${ls[i]!.slice(0, 120)}`; break; } }
      out.push(hit ? { id: it.id, result: "fail", detail: `an added line matches ${it.check.forbid_added} (${hit})` } : { id: it.id, result: "pass", detail: "no added line matches" });
      continue;
    }
    if (!opts.cmdOn) { out.push({ id: it.id, result: "not_run", detail: "cmd items run only with LOKI_E10_CHECKLIST set" }); continue; }
    const cmd = it.check.cmd!, a = await opts.run(cmd);
    if (a.cut || a.missing) { out.push({ id: it.id, result: "not_run", detail: a.cut ? "cut by its time limit" : "its tool is missing" }); continue; }
    if (a.ok) { out.push({ id: it.id, result: "pass", detail: `\`${cmd}\` passed` }); continue; }
    const b = await opts.runBase(cmd);
    if (b === null) out.push({ id: it.id, result: "not_run", detail: `not compared with the base commit: no base tree, or the deadline is near (\`${cmd}\` failed on the change)` });
    else if (b.ok) out.push({ id: it.id, result: "fail", detail: `\`${cmd}\` fails on the change and passes on the base commit` });
    else out.push({ id: it.id, result: "not_run", detail: `\`${cmd}\` fails on the base commit too` });
  }
  return out;
}
