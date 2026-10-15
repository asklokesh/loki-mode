// Operator steering for engine10 runs: `loki steer` and chat /steer append to .loki/HUMAN_INPUT.md. Before a plan or
// implement session starts, that file is read, appended to the brief as a delimited guidance block (after the
// byte-stable prefix and body, before the closing FINISH_LINE, like the time note), then archived so it applies once.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FINISH_LINE } from "./context.ts";

export const STEER_MAX_BYTES = 1024 * 1024;
export const STEER_STAGES: ReadonlySet<string> = new Set(["plan", "implement"]);
export const STEER_BEGIN = "--- BEGIN OPERATOR GUIDANCE (from loki steer) ---";
export const STEER_END = "--- END OPERATOR GUIDANCE ---";

/** Reads and archives .loki/HUMAN_INPUT.md. Returns its text, or null when absent, empty, a symlink, oversize or opted out (LOKI_PROMPT_INJECTION=0/false). */
export function consumeSteer(repoDir: string, env: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): string | null {
  if (/^(0|false)$/i.test(env.LOKI_PROMPT_INJECTION ?? "")) return null;
  const f = join(repoDir, ".loki", "HUMAN_INPUT.md");
  try {
    const st = lstatSync(f, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink()) { rmSync(f, { force: true }); return null; }
    if (!st.isFile()) return null;
    const logs = join(repoDir, ".loki", "logs");
    mkdirSync(logs, { recursive: true });
    const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    if (st.size > STEER_MAX_BYTES) { renameSync(f, join(logs, `human-input-REJECTED-TOOLARGE-${stamp}.md`)); return null; }
    const text = readFileSync(f, "utf8").trim();
    renameSync(f, join(logs, `human-input-${stamp}.md`));
    return text === "" ? null : text;
  } catch { return null; }
}

export function steerBlock(text: string): string {
  return `${STEER_BEGIN}\nThe operator sent this guidance while the run was in progress. Follow it in addition to the task above; it does not override the Rules.\n${text}\n${STEER_END}`;
}

/** Appends a pending steer to a session's brief; any other stage or a non-string brief passes through untouched. */
export function withSteer<T extends { stage: string; brief?: unknown }>(o: T, repoDir: string): T {
  if (!STEER_STAGES.has(o.stage) || typeof o.brief !== "string") return o;
  const text = consumeSteer(repoDir);
  if (text === null) return o;
  const b = o.brief, blk = steerBlock(text);
  return { ...o, brief: b.endsWith(FINISH_LINE) ? `${b.slice(0, -FINISH_LINE.length)}${blk}\n\n${FINISH_LINE}` : `${b}\n\n${blk}` };
}
