// T3 Intent card v1: the plan model states what it thinks the user wants plus the acceptance tests it will hold itself to.
// The card is parsed from the plan output, never invented: no parseable card means "Intent: NOT STATED by plan".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const INTENT_HEADER = "What I think you want:";
export const NOT_STATED_LINE = "Intent: NOT STATED by plan";
export const CARD_MIN_LINES = 3;
export const CARD_MAX_LINES = 5;
export const INTENT_ANSWER_FILE = "intent-answer.txt";
const HEADER_RE = /^\s*what i think you want\s*:/i;
const BODY_RE = /^\s*(acceptance[^:]*:|[-*]\s+)/i;

/** LOKI_INTENT_CARD=0 is the only opt-out; anything else (including unset) is on. */
export function intentCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return (env.LOKI_INTENT_CARD ?? "").trim() !== "0"; }
export function confirmRequested(env: NodeJS.ProcessEnv = process.env): boolean { return (env.LOKI_CONFIRM ?? "").trim() === "1"; }

/** Extra brief paragraph, appended only when the card is on. */
export const INTENT_CARD_INSTRUCTION = `After the plan lines, append an intent card of ${CARD_MIN_LINES} to ${CARD_MAX_LINES} lines: a first line starting "${INTENT_HEADER}" with one sentence on what you think the user wants, then ${CARD_MIN_LINES - 1} to ${CARD_MAX_LINES - 1} lines each starting "Acceptance:" naming one check you will hold yourself to.`;

export interface ParsedPlan { card: string[] | null; rest: string }

/** Splits the raw plan output into the intent card (null when absent, too short, or malformed) and the remaining plan text. An over-long card keeps its first CARD_MAX_LINES lines. */
export function parseIntentCard(raw: string): ParsedPlan {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => HEADER_RE.test(l));
  if (start < 0) return { card: null, rest: raw };
  let end = start + 1;
  while (end < lines.length && BODY_RE.test(lines[end] as string)) end++;
  const block = lines.slice(start, end).map((l) => l.trim());
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  if (block.length < CARD_MIN_LINES) return { card: null, rest };
  return { card: block.slice(0, CARD_MAX_LINES), rest };
}

export function renderIntent(card: string[] | null): string { return card ? card.join("\n") : NOT_STATED_LINE; }

/** PR body section; present whenever the card is on, so a missing card is visible rather than silent. */
export function intentSection(plan: Record<string, unknown> | undefined): string {
  if (!plan || plan.intent_enabled !== true) return "";
  const card = Array.isArray(plan.intent_card) ? (plan.intent_card as unknown[]).map(String) : null;
  return `\n\n## Intent\n\n${renderIntent(card)}\n`;
}

export interface ConfirmIo {
  /** Supervisor has an interactive terminal (passed to the worker as LOKI_INTENT_TTY=1). */
  tty: boolean;
  /** Ask the human; resolves "y" or "n". */
  ask(card: string): Promise<"y" | "n">;
  say(line: string): void;
}
export type ConfirmResult = "yes" | "no" | "skipped";

/** LOKI_CONFIRM=1 gate. No TTY never blocks. */
export async function confirmIntent(card: string[] | null, io: ConfirmIo): Promise<ConfirmResult> {
  if (!io.tty) { io.say("Intent confirmation skipped (LOKI_CONFIRM=1 but no interactive TTY)"); return "skipped"; }
  const ans = await io.ask(renderIntent(card));
  if (ans === "n") { io.say("Stopped at the intent card: you answered n. Nothing was implemented."); return "no"; }
  return "yes";
}

/** Worker side: the worker has no TTY, so it waits for the supervisor (which owns the terminal) to write the answer file. Unanswered within waitMs is null (skipped), never a block. */
export async function readAnswerFile(runDir: string, waitMs: number, pollMs = 100): Promise<"y" | "n" | null> {
  const p = join(runDir, INTENT_ANSWER_FILE);
  const until = Date.now() + waitMs;
  for (;;) {
    if (existsSync(p)) { const v = readFileSync(p, "utf8").trim().toLowerCase(); if (v === "y" || v === "n") return v; }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
export function writeAnswerFile(runDir: string, ans: "y" | "n"): void { writeFileSync(join(runDir, INTENT_ANSWER_FILE), `${ans}\n`, "utf8"); }

/** Supervisor side (owns the terminal): show the card, read y/n, hand the answer to the worker through the run dir. */
export async function askIntent(card: string, runDir: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((res) => rl.question(`${card}\nProceed with this intent? [y/n] `, res));
  rl.close();
  writeAnswerFile(runDir, ans.trim().toLowerCase().startsWith("n") ? "n" : "y");
}

/** Worker side of LOKI_CONFIRM=1. Returns true when the user declined. No TTY (LOKI_INTENT_TTY unset by the supervisor) never blocks. */
export async function workerConfirm(card: string[] | null, runDir: string, env: NodeJS.ProcessEnv, emit: (data: Record<string, unknown>) => void, say: (l: string) => void, waitMs = 60_000): Promise<boolean> {
  if (!confirmRequested(env)) return false;
  if (env.LOKI_INTENT_TTY !== "1") { say("Intent confirmation skipped (LOKI_CONFIRM=1 but no interactive TTY)"); return false; }
  emit({ intent_confirm: true, card: renderIntent(card) });
  const ans = await readAnswerFile(runDir, waitMs);
  if (ans === "n") { say("Stopped at the intent card: you answered n. Nothing was implemented."); return true; }
  if (ans === null) say("Intent confirmation timed out; continuing");
  return false;
}

/** Plan-stage hook: parse and print the card (stderr, before implement), run the LOKI_CONFIRM gate. card off or an empty plan is silent and changes nothing. */
export async function applyIntent(raw: string, on: boolean, runDir: string, emit: (data: Record<string, unknown>) => void): Promise<{ rest: string; data: Record<string, unknown> }> {
  if (!on || raw.trim() === "") return { rest: raw, data: {} };
  const { card, rest } = parseIntentCard(raw);
  process.stderr.write(`${renderIntent(card)}\n`);
  const declined = await workerConfirm(card, runDir, process.env, emit, (l) => process.stderr.write(`${l}\n`));
  return { rest, data: { intent_enabled: true, intent_card: card, ...(declined ? { intent_declined: true } : {}) } };
}
