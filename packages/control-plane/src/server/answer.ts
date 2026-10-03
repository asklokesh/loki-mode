// BLOCKED answer: a human reply to a run's one question, written to a file the operator resumes from.
// File: <answerDir>/<source>/<run>.answer.txt (default ~/.loki/control/answers, override LOKI_CONTROL_ANSWER_DIR).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";

export const MAX_ANSWER = 4000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const defaultAnswerDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LOKI_CONTROL_ANSWER_DIR || join(env.HOME || homedir(), ".loki", "control", "answers");

/** The question a BLOCKED (spec conflict) run is waiting on, or null when it is not blocked. */
export function blockedQuestion(evs: EventEnvelope[], verdict: string | null): string | null {
  if (verdict !== "SPEC_CONFLICT") return null;
  const why = evs.find((e) => e.type === "stage.completed" && e.stage === "implement")?.data.spec_conflict_reason;
  return (typeof why === "string" && why ? why : "the run is blocked on a spec conflict").replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500);
}

export type AnswerResult = { status: 200; body: { ok: true; path: string; resume: string } } | { status: 400 | 413; body: { error: string } };

export function writeAnswer(dir: string, source: string, run: string, answer: unknown): AnswerResult {
  if (!ID.test(source) || !ID.test(run) || source.includes("..") || run.includes("..")) return { status: 400, body: { error: "invalid run id" } };
  if (typeof answer !== "string" || answer.trim() === "") return { status: 400, body: { error: "answer must be a non-empty string" } };
  if (answer.length > MAX_ANSWER) return { status: 413, body: { error: `answer over ${MAX_ANSWER} characters` } };
  const d = join(dir, source);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const path = join(d, `${run}.answer.txt`);
  writeFileSync(path, `${answer.trim()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { status: 200, body: { ok: true, path, resume: `loki "$(cat '${path}')"  # re-run the task with the answer, or paste it into the issue` } };
}
