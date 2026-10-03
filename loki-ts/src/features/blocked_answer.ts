// D63-C4: `loki answer [<run-id>] [--text "..."]` closes the BLOCKED loop. engine10 has no in-place resume
// (BLOCKED is terminal), so the answer rides into a fresh run as task context. The answer comes from --text or
// the Control Plane answer file (<answerDir>/<source>/<run>.answer.txt). Launch is injected for tests.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../engine10/events.ts";
import { eventsPath, findLatestRun, listRunIds } from "../engine10/status.ts";
import { REPO_ROOT } from "../util/paths.ts";

export interface AnswerDeps {
  repoDir: string; env: NodeJS.ProcessEnv; binPath: string; answerDir: string;
  launch(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; runId: string }>;
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
export function readBlocked(repoDir: string, runId: string): BlockedRun | string {
  const p = eventsPath(repoDir, runId);
  if (!existsSync(p)) return `run ${runId} not found`;
  const evs = readEvents(p);
  const verdict = evs.findLast((e) => e.type === "run.completed")?.data.verdict;
  if (verdict !== "SPEC_CONFLICT") return `run ${runId} is not BLOCKED (verdict ${typeof verdict === "string" ? verdict : "none yet"})`;
  const task = evs.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data.task;
  const why = evs.find((e) => e.type === "stage.completed" && e.stage === "implement")?.data.spec_conflict_reason;
  if (typeof task !== "string" || !task) return `run ${runId} has no recorded task`;
  return { runId, task, question: clean(typeof why === "string" && why ? why : "the run is blocked on a spec conflict").slice(0, 500) };
}

export function newestBlocked(repoDir: string): string | null {
  const ids = listRunIds(repoDir);
  for (let i = ids.length - 1; i >= 0; i--) if (typeof readBlocked(repoDir, ids[i]!) !== "string") return ids[i]!;
  return null;
}

/** First <answerDir>/<source>/<run>.answer.txt found, or null. */
export function readAnswerFile(answerDir: string, runId: string): string | null {
  if (!existsSync(answerDir)) return null;
  for (const src of readdirSync(answerDir)) {
    const p = join(answerDir, src, `${runId}.answer.txt`);
    if (existsSync(p)) return readFileSync(p, "utf8").trim() || null;
  }
  return null;
}

export async function runAnswer(args: string[], d: AnswerDeps): Promise<number> {
  let runId = "", text: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--text") text = args[++i];
    else if (a.startsWith("--text=")) text = a.slice(7);
    else if (!runId && !a.startsWith("-")) runId = a;
    else { d.err("usage: loki answer [<run-id>] [--text \"...\"]"); return 2; }
  }
  const id = runId || newestBlocked(d.repoDir) || findLatestRun(d.repoDir);
  if (!id) { d.err("loki answer: no runs found; nothing is BLOCKED"); return 2; }
  const b = readBlocked(d.repoDir, id);
  if (typeof b === "string") { d.err(`loki answer: ${b}`); return 2; }
  const answer = (text ?? readAnswerFile(d.answerDir, id) ?? "").trim();
  if (!answer) { d.err(`loki answer: no answer for ${id}; pass --text "..." or answer it in the Control Plane`); return 2; }
  const task = `${b.task}\n\nClarification answering "${b.question}": ${answer}`;
  const r = await d.launch([d.binPath, task], answerEnv(d.env), d.repoDir);
  d.out(`new run ${r.runId} (exit ${r.code})`);
  return r.code;
}

/** Real launcher: spawns bin/loki and discovers the run dir it creates. */
function realLaunch(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; runId: string }> {
  const before = new Set(listRunIds(cwd));
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
  return new Promise((res) => {
    let runId = "";
    const poll = setInterval(() => { runId = listRunIds(cwd).find((x) => !before.has(x) && x.startsWith("e10-")) ?? runId; }, 100);
    const fin = (code: number) => { clearInterval(poll); runId = runId || listRunIds(cwd).find((x) => !before.has(x)) || `pid-${child.pid}`; res({ code, runId }); };
    child.on("exit", (c) => fin(c ?? 1));
    child.on("error", () => fin(1));
  });
}

export function runAnswerCli(args: string[]): Promise<number> {
  return runAnswer(args, {
    repoDir: process.cwd(), env: process.env, binPath: join(REPO_ROOT, "bin", "loki"),
    answerDir: process.env.LOKI_CONTROL_ANSWER_DIR || join(process.env.HOME || homedir(), ".loki", "control", "answers"),
    launch: realLaunch, out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"),
  });
}
