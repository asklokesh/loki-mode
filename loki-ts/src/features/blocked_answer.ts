// `loki answer [<run-id>] ["<text>" | --text "..."]` closes the BLOCKED loop: the run resumes under the same run id
// (util/run_outputs.ts resumeFlag), the answer joins its task text, and settled stages are not re-run. The answer comes
// from the argument, --text, or the Control Plane answer file (<answerDir>/<source>/<run>.answer.txt). The resume is injected for tests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { conflictReasonOf, readEvents } from "../engine10/events.ts";
import { eventsPath, latestRunId, listRunIds, runsRoot } from "../commands/run_status.ts";

export interface AnswerDeps {
  repoDir: string; env: NodeJS.ProcessEnv; answerDir: string;
  resume(runId: string, answer: string): Promise<number>;
  out(line: string): void; err(line: string): void;
}
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
/** Child env: caller env minus chat/control secrets, headless. */
export function answerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("SLACK_") && k !== "LOKI_CONTROL_TOKEN") e[k] = v;
  e.LOKI_NO_BROWSER = "1";
  return e;
}
export interface BlockedRun { runId: string; task: string; question: string }
/** Reads a run's task and question; returns the reason it cannot be resumed otherwise. */
const MAX_ANSWER = 4000; // matches the control-plane write cap
const validId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");

export function readBlocked(repoDir: string, runId: string): BlockedRun | string {
  if (!validId(runId)) return "invalid run id (letters, digits, . _ - only)";
  const p = eventsPath(runsRoot(process.env, repoDir), runId);
  if (!existsSync(p)) return `run ${runId} not found`;
  const evs = readEvents(p);
  const verdict = evs.findLast((e) => e.type === "run.completed")?.data.verdict;
  if (verdict !== "SPEC_CONFLICT") return `run ${runId} is not BLOCKED (verdict ${typeof verdict === "string" ? verdict : "none yet"})`;
  const task = evs.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data.task;
  const why = conflictReasonOf(evs);
  if (typeof task !== "string" || !task) return `run ${runId} has no recorded task`;
  return { runId, task, question: clean(typeof why === "string" && why ? why : "the run is blocked on a spec conflict").slice(0, 500) };
}
export function newestBlocked(repoDir: string): string | null {
  const ids = listRunIds(runsRoot(process.env, repoDir));
  for (let i = ids.length - 1; i >= 0; i--) if (typeof readBlocked(repoDir, ids[i]!) !== "string") return ids[i]!;
  return null;
}
/** First <answerDir>/<source>/<run>.answer.txt found, or null. */
export function readAnswerFile(answerDir: string, runId: string): string | null {
  if (!validId(runId) || !existsSync(answerDir)) return null;
  for (const src of readdirSync(answerDir)) {
    const p = join(answerDir, src, `${runId}.answer.txt`);
    if (existsSync(p)) return readFileSync(p, "utf8").slice(0, MAX_ANSWER).trim() || null;
  }
  return null;
}
export async function runAnswer(args: string[], d: AnswerDeps): Promise<number> {
  let runId = "", text: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--text") {
      if (i + 1 >= args.length) { d.err("loki answer: --text needs a value"); return 2; }
      text = args[++i];
    }
    else if (a.startsWith("--text=")) text = a.slice(7);
    else if (!a.startsWith("-")) pos.push(a);
    else { d.err(USAGE); return 2; }
  }
  if (pos.length > 0 && /^e10-[A-Za-z0-9-]+$/.test(pos[0]!)) runId = pos.shift()!; // a run id, else the first word is already the answer
  if (pos.length > 1 || (pos.length === 1 && text !== undefined)) { d.err(USAGE); return 2; }
  if (pos.length === 1) text = pos[0];
  const id = runId || newestBlocked(d.repoDir) || latestRunId(runsRoot(process.env, d.repoDir));
  if (!id) { d.err("loki answer: no runs found; nothing is BLOCKED"); return 2; }
  const b = readBlocked(d.repoDir, id);
  if (typeof b === "string") { d.err(`loki answer: ${b}`); return 2; }
  const answer = (text ?? readAnswerFile(d.answerDir, id) ?? "").trim().slice(0, MAX_ANSWER);
  if (!answer) { d.err(`loki answer: no answer for ${id}; pass the text (loki answer ${id} "...") or answer it in the Control Plane`); return 2; }
  d.out(`resuming ${id} with your answer`);
  return d.resume(id, answer);
}
const USAGE = 'usage: loki answer [<run-id>] ["<text>" | --text "..."]';
export function runAnswerCli(args: string[]): Promise<number> {
  const safe = answerEnv(process.env); // the resumed run is headless and never sees chat or control secrets
  for (const k of Object.keys(process.env)) if (!(k in safe)) delete process.env[k];
  process.env.LOKI_NO_BROWSER = "1";
  return runAnswer(args, {
    repoDir: process.cwd(), env: process.env,
    answerDir: process.env.LOKI_CONTROL_ANSWER_DIR || join(process.env.HOME || homedir(), ".loki", "control", "answers"),
    resume: async (runId, answer) => (await import("../util/run_outputs.ts")).resumeFlag(runId, false, { out: (l) => process.stdout.write(l) }, answer),
    out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"),
  });
}
