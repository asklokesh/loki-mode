// LOKI_E10_OPUS_CONSULT (default on, =0 opts out): one tool-less strong-model consult at the points where a cheap run is most likely
// to go wrong, plus the never-stop policy. New file: no existing module owns a strong-model advisory call (tournament.ts and
// patch_protocol.ts own their own Haiku calls; this one reuses their call path and the child ledger).
//
// Triggers, at most LOKI_E10_CONSULT_MAX (default 1) per run, counted in <runDir>/opus-consult.json:
//   stop        the run would end SPEC_CONFLICT (implement or a fix round)
//   red-verify  verify is still red after the first fix round
//   open-choice intake recorded an either/or the run settles by itself (no maintainer, preference or pinned test decides it)
// The consult reads a compact brief (task, diff so far, failing output, context-pack excerpts) and returns a short diagnosis and the
// intended behavior; the Haiku session continues with it. Its tokens and dollars go to .loki/metrics/child-sessions.jsonl (phase
// opus-consult-<trigger>), which the receipt cost and the bench's approved cost method (ledger + sdk-toolless records) both read.
//
// Never-stop (same knob): a headless run that would end SPEC_CONFLICT instead infers the most likely intent, implements it, names
// the choice on an ASSUMPTION line, and is capped at PARTIAL by seal (neverStopNotes). LOKI_E10_INTAKE_ASK=1 is the explicit
// interactive opt-in that keeps the old stop (a person is there to answer `loki answer`).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOff } from "../council/role_agents.ts";
import { toolLessCall } from "../runner/sdk_invoker.ts";
import { withChildLedger } from "../util/child_ledger.ts";
import { run } from "../util/shell.ts";

export type ConsultTrigger = "stop" | "red-verify" | "open-choice";
export const CONSULT_FILE = "opus-consult.json";
/** claude-opus-5-5: Claude Opus 5.5, $4 / $20 per MTok, cache read $0.20 (claude-api skill, 2026-10-06; loki-ts/data/model-pricing.json "opus"). */
export const CONSULT_MODEL_DEFAULT = "claude-opus-5-5";
const MAX_TOKENS = 1200; // a diagnosis and an intended behavior, not code; thinking cannot be disabled on Opus 5.5, so "low" effort bounds it
const CAP = { task: 5000, evidence: 2500, diff: 5000, code: 6000 }; // about 5k input tokens: measured on cli-2418 (bench, 2026-11-06), 23k chars with a 1h cache write cost $0.077 per consult

export const consultEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.LOKI_E10_OPUS_CONSULT);
/** Never-stop is on with the knob unless the run explicitly asks a person (LOKI_E10_INTAKE_ASK=1). */
export const neverStopActive = (env: NodeJS.ProcessEnv = process.env): boolean => consultEnabled(env) && env.LOKI_E10_INTAKE_ASK !== "1";
export const consultModel = (env: NodeJS.ProcessEnv = process.env): string => env.LOKI_E10_CONSULT_MODEL || CONSULT_MODEL_DEFAULT;
const consultMax = (env: NodeJS.ProcessEnv): number => { const n = Number(env.LOKI_E10_CONSULT_MAX); return Number.isInteger(n) && n >= 0 ? n : 1; };

export interface ConsultRecord { trigger: ConsultTrigger; stage: string; model: string; outcome: string; usd: number | null; advice: string | null }
export function readConsults(runDir: string): ConsultRecord[] {
  try { const j = JSON.parse(readFileSync(join(runDir, CONSULT_FILE), "utf8")) as unknown; return Array.isArray(j) ? (j as ConsultRecord[]) : []; } catch { return []; }
}
/** True while the run still has a consult left under the cap (the knob on). */
export const consultAvailable = (runDir: string, env: NodeJS.ProcessEnv = process.env): boolean => consultEnabled(env) && readConsults(runDir).length < consultMax(env);

export type ConsultCall = (system: string, prompt: string, phase: string) => Promise<{ text: string | null; usd: number | null; outcome: string }>;
/** The tool-less call: the CLI invoker (tests/min e2e stub, legacy installs) runs `claude -p` with no tools, priced by withChildLedger exactly like
 *  patch_protocol.ts patchCallFor; otherwise sdk_invoker toolLessCall (ledgered, run-cap aware). Opus 5.5 rejects disabled thinking, so "low". */
export function consultCallFor(model: string, lokiDir: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 180_000): ConsultCall {
  if (env.LOKI_E10_INVOKER === "cli") return async (system, prompt, phase) => {
    try {
      const r = await withChildLedger(run, lokiDir, phase, model)([env.LOKI_CLAUDE_CLI || "claude", "-p", prompt, "--output-format", "json", "--tools", "", "--model", model, "--system-prompt", system, "--strict-mcp-config", "--setting-sources", "project"], { timeoutMs, group: true });
      const j = JSON.parse(r.stdout) as { result?: unknown; is_error?: boolean; total_cost_usd?: number };
      const ok = r.exitCode === 0 && !j.is_error && typeof j.result === "string" && j.result.trim() !== "";
      return { text: ok ? (j.result as string) : null, usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null, outcome: ok ? "ok" : "failed" };
    } catch { return { text: null, usd: null, outcome: "transport" }; }
  };
  return async (system, prompt, phase) => {
    const r = await toolLessCall({ model, system, prompt, maxTokens: MAX_TOKENS, thinking: "low", timeoutMs, ledger: { lokiDir, phase }, noCache: true });
    return { text: r.outcome.kind === "ok" ? r.outcome.value : null, usd: r.usd, outcome: r.outcome.kind };
  };
}
let callOverride: ConsultCall | null = null;
/** TEST SEAM: replace the consult call. Production code must never call this. */
export function __setConsultCallForTests(c: ConsultCall | null): void { callOverride = c; }

export const CONSULT_SYSTEM =
  "You advise a fast, cheaper coding agent that is working on a task in a repository. You have no tools: read the task, the evidence and the code below. " +
  "Reply in at most 120 words, plain text, exactly two labeled parts. DIAGNOSIS: what is wrong or what the agent is missing, naming files, functions and lines. " +
  "INTENDED: the behavior the task most likely wants, concrete enough to implement (names, values, edge cases). Never ask a question and never refuse for ambiguity: " +
  "when the task can be read two ways, pick the reading its author most likely meant, keep existing tests and documented behavior true where they do not contradict it, and say why in one sentence.";
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[... truncated]` : s);
export function consultPrompt(trigger: ConsultTrigger, p: { task: string; evidence: string; diff: string | null; code: string }): string {
  const head = trigger === "stop" ? "The agent wants to stop: it says the task conflicts with the repository." : trigger === "red-verify" ? "The agent's change still fails checks after one fix round." : "The task leaves a choice open that no maintainer comment, stated preference or existing test decides.";
  return [`Loki Opus consult (trigger: ${trigger}). ${head}`, `Task:\n${clip(p.task, CAP.task)}`, `Evidence:\n${clip(p.evidence, CAP.evidence)}`, `Diff so far:\n${p.diff ? clip(p.diff, CAP.diff) : "(no change yet)"}`, `Relevant code:\n${p.code ? clip(p.code, CAP.code) : "(none collected)"}`].join("\n\n");
}

/** One consult when the cap allows: records it in <runDir>/opus-consult.json (the receipt disclosure) and returns the advice text, or null
 *  (knob off, cap used, or the call failed). Never throws. */
export async function runConsult(o: { runDir: string; repoDir: string; stage: string; trigger: ConsultTrigger; task: string; evidence: string; diff: string | null; code: string }, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    if (!consultAvailable(o.runDir, env)) return null;
    const model = consultModel(env), call = callOverride ?? consultCallFor(model, join(o.repoDir, ".loki"), env);
    const prior = readConsults(o.runDir), slot: ConsultRecord = { trigger: o.trigger, stage: o.stage, model, outcome: "started", usd: null, advice: null };
    const save = (xs: ConsultRecord[]): void => { try { mkdirSync(o.runDir, { recursive: true }); writeFileSync(join(o.runDir, CONSULT_FILE), JSON.stringify(xs), "utf8"); } catch { /* best effort */ } };
    save([...prior, slot]); // the slot is taken before the call: a crash mid-call never buys a second consult
    const r = await call(CONSULT_SYSTEM, consultPrompt(o.trigger, o), `opus-consult-${o.trigger}`);
    const advice = r.text ? r.text.replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ").trim().slice(0, 2000) : null;
    save([...prior, { ...slot, outcome: r.outcome, usd: r.usd, advice }]);
    return advice;
  } catch { return null; }
}

/** The brief block a session gets with the advice. */
export const adviceBlock = (advice: string | null): string[] => (advice ? [`A senior reviewer read the task and the code (one consult, no tools). Use this unless the task text or a test clearly contradicts it:\n${advice}`] : []);

/** Never-stop: the resume brief after a would-be SPEC_CONFLICT. */
export const neverStopBrief = (reason: string, advice: string | null): string =>
  [`Do not stop on this conflict. You raised: ${reason.replace(/[\r\n]+/g, " ").slice(0, 500)}. Nobody can answer a question during this run, so infer the behavior the task's author most likely wants and implement it now.`,
    "Keep every existing test and documented behavior true where it does not contradict that reading. Before the last line, write one line `ASSUMPTION: <the choice you made and why>`.",
    ...adviceBlock(advice), "Finish with exactly one line: LOKI_DONE."].join("\n\n");
export const assumptionOf = (text: string | undefined): string | null => /^\W*ASSUMPTION:\s*(.+)$/m.exec(text ?? "")?.[1]?.trim().slice(0, 300) ?? null;

/** A conflict the run settled itself (implement or fix), recorded on outputs.implement.never_stop and read by seal. */
export interface NeverStopRecord { stage: string; conflict: string; assumption: string | null; consulted: boolean }
const one = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300);
/** Seal: one NOT PROVEN line per settled conflict. Always caps VERIFIED at PARTIAL, whatever LOKI_E10_OPEN_DECISION_CAP says: a stop the run overrode is never proven intent. */
export function neverStopNotes(implement: Record<string, unknown> | undefined): string[] {
  const xs = Array.isArray(implement?.never_stop) ? (implement!.never_stop as NeverStopRecord[]) : [];
  return xs.filter((x) => x && typeof x.conflict === "string").map((x) => `spec conflict the run settled itself instead of stopping (${x.stage}): ${one(x.conflict)} -> implemented the most likely intent: ${x.assumption ? one(x.assumption) : "the session named no ASSUMPTION line"}${x.consulted ? " (after one Opus consult)" : ""}`);
}
/** Seal: a disclosure per consult (never a cap): trigger, model, dollars. */
export function consultNotes(runDir: string): string[] {
  return readConsults(runDir).map((c) => `Opus consult (${c.trigger}, ${c.stage}, ${c.model}): ${c.outcome}${typeof c.usd === "number" ? `, $${c.usd.toFixed(4)}` : ", cost not measured"}${c.advice ? `; advice: ${one(c.advice)}` : ""}`);
}
