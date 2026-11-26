// T3 Intent card v1: the plan model states what it thinks the user wants plus the acceptance tests it will hold itself to.
// The card is parsed from the plan output, never invented: no parseable card means "Intent: NOT STATED by plan".
import { stderrIsTty } from "./term_width.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const INTENT_HEADER = "What I think you want:";
export const NOT_STATED_LINE = "Intent: NOT STATED by plan";
export const CARD_MIN_LINES = 3;
export const CARD_MAX_LINES = 5;
export const INTENT_ANSWER_FILE = "intent-answer.txt";
const HEADER_RE = /^\s*what i think you want\s*:/i;
const BODY_RE = /^\s*(acceptance[^:]*:|out of scope\s*:|[-*]\s+)/i;
const OOS_RE = /^out of scope\s*:/i;
const OOS_MAX_CHARS = 200;

/** LOKI_INTENT_CARD=0 is the only opt-out; anything else (including unset) is on. */
export function intentCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return (env.LOKI_INTENT_CARD ?? "").trim() !== "0"; }
export function confirmRequested(env: NodeJS.ProcessEnv = process.env): boolean { return (env.LOKI_CONFIRM ?? "").trim() === "1"; }

/** Extra brief paragraph, appended only when the card is on. */
export const INTENT_CARD_INSTRUCTION = `After the plan lines, append an intent card of ${CARD_MIN_LINES} to ${CARD_MAX_LINES} lines: a first line starting "${INTENT_HEADER}" with one sentence on what you think the user wants, then ${CARD_MIN_LINES - 1} to ${CARD_MAX_LINES - 1} lines each starting "Acceptance:" naming one check you will hold yourself to. You may add one optional line starting "Out of scope:" naming what you will NOT do; it counts toward the ${CARD_MAX_LINES} lines.`;

const OOS_SENTENCE = ` You may add one optional line starting "Out of scope:" naming what you will NOT do; it counts toward the ${CARD_MAX_LINES} lines.`;
const ISSUE_SCOPE_SENTENCE = " The issue has its own acceptance lines and they are the scope: plan every one of them, and do not write an Out of scope line. If one line cannot be delivered in this run, plan the rest and name that line and the reason in the plan.";

/** The brief paragraph for the card. With the issue's own acceptance lines the optional "Out of scope:" permission is replaced: those lines are the scope and the plan may not exclude one. False returns INTENT_CARD_INSTRUCTION unchanged. */
export function intentCardInstruction(hasIssueLines: boolean): string { return hasIssueLines ? INTENT_CARD_INSTRUCTION.replace(OOS_SENTENCE, ISSUE_SCOPE_SENTENCE) : INTENT_CARD_INSTRUCTION; }

export interface ParsedPlan { card: string[] | null; rest: string }

/** Splits the raw plan output into the intent card (null when absent, too short, or malformed) and the remaining plan text. An over-long card keeps its first CARD_MAX_LINES lines. */
export function parseIntentCard(raw: string): ParsedPlan {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => HEADER_RE.test(l));
  if (start < 0) return { card: null, rest: raw };
  let end = start + 1;
  while (end < lines.length && BODY_RE.test(lines[end] as string)) end++;
  const block = lines.slice(start, end).map((l) => l.trim()).map((l) => (OOS_RE.test(l) ? l.slice(0, OOS_MAX_CHARS) : l));
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
export async function applyIntent(raw: string, on: boolean, runDir: string, emit: (data: Record<string, unknown>) => void, issueLines: string[] = []): Promise<{ rest: string; data: Record<string, unknown> }> {
  if (on && raw.trim() === "" && issueLines.length) { process.stderr.write(`${stderrIsTty() ? "\r\x1b[2K" : ""}${renderIntent(issueLines.map((l) => `Acceptance: ${l}`))}\n`); return { rest: raw, data: {} }; } // Q1 ISSUE-ACCEPTANCE: no card, but the issue's own lines are still shown
  if (!on || raw.trim() === "") return { rest: raw, data: {} };
  const parsed = parseIntentCard(raw), rest = parsed.rest;
  // An issue with its own acceptance lines has no room for a plan-written "Out of scope:" line: dropped from the printed and stored card, kept as scope_narrowed.
  const oos = issueLines.length && parsed.card ? parsed.card.filter((l) => OOS_RE.test(l)) : [];
  const card = oos.length && parsed.card ? parsed.card.filter((l) => !OOS_RE.test(l)) : parsed.card, shown = cardWithIssueLines(card, issueLines); // Q1 ISSUE-ACCEPTANCE: the printed Acceptance lines are the issue's own, verbatim, then the card's additions
  process.stderr.write(`${stderrIsTty() ? "\r\x1b[2K" : ""}${renderIntent(shown)}\n`); // the supervisor's live line holds the cursor on this terminal; clear it first so the card starts its own line
  const declined = await workerConfirm(shown, runDir, process.env, emit, (l) => process.stderr.write(`${l}\n`));
  return { rest, data: { intent_enabled: true, intent_card: card, ...(oos.length ? { scope_narrowed: oos.map((l) => l.replace(OOS_RE, "").trim()).join("; ") } : {}), ...(declined ? { intent_declined: true } : {}) } };
}

/** The Acceptance lines of a recorded plan output's intent card (what the user asked), cleaned and bounded; empty when there is no card. */
export function acceptanceLines(plan: unknown): string[] {
  const card = (plan as { intent_card?: unknown } | undefined)?.intent_card;
  return Array.isArray(card) ? card.map((l) => String(l).replace(/[\x00-\x1f\x7f`]+/g, " ").trim()).filter((l) => /^acceptance\b/i.test(l)).map((l) => l.slice(0, 500)).slice(0, 10) : [];
}

/** Reviewer prompt lines asking the diff be checked against the acceptance lines and each unmet one named; empty for no lines, so a prompt without a card is unchanged. */
export const acceptancePromptBlock = (lines: string[]): string[] => lines.length ? ["", "The user asked for the following (intent card). Check the diff against each line:", ...lines, "For each line the diff leaves unmet, add a reason line starting `- UNMET: ` followed by that line. Do not use VERDICT: PASS while a line is unmet."] : [];

// FC-PR-BODY-PUBLIC-HYGIENE: an issue template's checklist is form boilerplate, never what was asked. Dropped: checkbox items under a Preflight or before-submitting heading, anywhere, and checkbox items worded as a first-person attestation. Nothing under an acceptance or criteria heading is ever dropped.
const TEMPLATE_HEAD = /^#+\s*(pre-?flight(\s+checklist)?|before (you )?(submit(ting)?|open(ing)?|fil(e|ing)))\s*:?\s*$/i, ACCEPT_HEAD = /^#+\s.*(accept|criteria)/i, CHECK_ITEM = /^[-*+]\s+\[[ xX]\]/, ATTEST = /\bI (have (searched|read|checked|confirmed)|am using the latest|agree to)\b/i;
export function stripTemplate(lines: { filter(fn: (l: string) => boolean): string[] }): string[] {
  let tpl = false, acc = false;
  return lines.filter((l) => {
    if (/^#+\s/.test(l)) { tpl = TEMPLATE_HEAD.test(l); acc = ACCEPT_HEAD.test(l); return !tpl; }
    return acc || !(CHECK_ITEM.test(l) && (tpl || ATTEST.test(l)));
  });
}
// Q1 ISSUE-ACCEPTANCE: the issue's own acceptance list, verbatim, with no model call. MARK, CHECKED and normAsk are the prove listing's
// (stages/prove_list.ts on q1-prove-stage), moved here so both read an ask the same way.
export const MARK = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/;
export const CHECKED = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/;
export const normAsk = (t: string): string => t.replace(MARK, "").replace(/\s+/g, " ").trim();
const LIST_HEAD = /^\s*(?:#{1,6}\s*|\*\*|__)?\s*(?:acceptance criteria|acceptance|requirements|definition of done|specifications|things to cover)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i;
const ANY_HEAD = /^\s*(?:#{1,6}\s|(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$)/, LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/, OPEN_BOX = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*\S/;
export const ISSUE_ACCEPTANCE_MAX = 50;
/** The issue's acceptance list: the list items under every heading named Acceptance criteria, Acceptance, Requirements, Definition of done,
 *  Specifications or Things to cover (markdown, bold or "Name:" line), in order; with no such heading holding items, every open "- [ ] " line.
 *  Each line is the issue's text without its list or checkbox marker. Checked boxes and template attestations are left out (as the prove listing
 *  does). [] when the issue has no list, so such a run keeps today's behavior. */
export function issueAcceptance(issue: string): string[] {
  const lines = stripTemplate(issue.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== ""));
  const keep = (l: string): boolean => !CHECKED.test(l) && !ATTEST.test(l);
  const under: string[] = []; let inList = false;
  for (const l of lines) {
    if (LIST_HEAD.test(l)) { inList = true; continue; }
    if (ANY_HEAD.test(l)) { inList = false; continue; }
    if (inList && LIST_ITEM.test(l) && keep(l)) under.push(normAsk(l));
  }
  const picked = under.length > 0 ? under : lines.filter((l) => OPEN_BOX.test(l) && keep(l)).map(normAsk);
  return [...new Set(picked.filter(Boolean))].slice(0, ISSUE_ACCEPTANCE_MAX);
}
/** An issue line the issue itself marks optional: listed and reviewed, but never a cap on the label. */
export const optionalAsk = (line: string): boolean => /^\(?optional\b|\(optional\)/i.test(line);
/** The intake record's issue acceptance lines (strings only), or [] when the issue had none. */
export const issueAcceptanceOf = (intake: unknown): string[] => { const v = (intake as { issue_acceptance?: unknown } | undefined)?.issue_acceptance; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []; };
export type IssueAskStatus = "met" | "unmet" | "not_checked";
/** Each issue line with what the line check recorded (xreview.ts issueLineCheck): met only with a MET and its evidence phrase; not_checked when it gave no answer for the line. */
export function issueAcceptanceStatus(lines: string[], marks: { met: number[]; unmet: number[] } | undefined, evidence: Record<string, string> = {}, reasons: Record<string, string> = {}): { line: string; status: IssueAskStatus; evidence?: string; reason?: string; optional?: true }[] {
  return lines.map((line, i) => { const k = i + 1, status: IssueAskStatus = !marks ? "not_checked" : marks.met.includes(k) ? "met" : marks.unmet.includes(k) ? "unmet" : "not_checked"; return { line, status, ...(status === "met" && evidence[String(k)] ? { evidence: evidence[String(k)] } : {}), ...(status === "unmet" && reasons[String(k)] ? { reason: reasons[String(k)] } : {}), ...(optionalAsk(line) ? { optional: true as const } : {}) }; });
}
export const NOT_ADDRESSED = "not addressed: ";
/** The seal's open notes: one "not addressed: <verbatim line>" per required issue line the review did not mark met. */
export const notAddressedNotes = (st: { line: string; status: IssueAskStatus; optional?: true }[]): string[] => st.filter((s) => s.status !== "met" && !s.optional).map((s) => `${NOT_ADDRESSED}${s.line}`);
/** The line check call and the seal cap, on by default (the label is checked against the issue's own lines); LOKI_E10_ISSUE_ACCEPTANCE=0 turns both off. */
export const issueAcceptanceCapOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_ISSUE_ACCEPTANCE"] ?? "").trim());
/** The line Loki adds to the issue's own list when the repository needs a database or another service: the change must work on a fresh install, not only on data that already existed. */
export const FRESH_INSTALL_ASK = "Fresh install (added by Loki): after this change, an empty database set up with the repository's own migrations or setup accepts a first account, tenant or record created through the product's own code path";
/** The printed card: the issue's lines first, verbatim, as "Acceptance:" lines, then the card's own Acceptance lines that repeat none of them, then the rest. */
export function cardWithIssueLines(card: string[] | null, issueLines: string[]): string[] | null {
  if (!issueLines.length) return card;
  const own = card ?? [], seen = new Set(issueLines.map((l) => l.toLowerCase()));
  const head = own.filter((l) => /^\s*what i think you want\b/i.test(l)), acc = own.filter((l) => /^\s*acceptance\b/i.test(l) && !seen.has(l.replace(/^\s*acceptance\s*:\s*/i, "").trim().toLowerCase()));
  const rest = own.filter((l) => !head.includes(l) && !/^\s*acceptance\b/i.test(l));
  return [...head, ...issueLines.map((l) => `Acceptance: ${l}`), ...acc, ...rest];
}

export const intentLine = (card: unknown): string | null => { for (const l of Array.isArray(card) ? card : []) { const m = /^\s*what i think you want\s*:\s*(\S.*)$/i.exec(String(l)); if (m) return m[1]!.trim(); } return null; };
