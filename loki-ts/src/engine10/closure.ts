// RW-03: what held a run below VERIFIED, as structured items read from its receipt. A leaf (no engine imports): output.ts, seal.ts and the pull request
// body read it. Class a: closable by more checking with no model. Class b: closable by the session. Class c: not closable in the run (a person, the
// environment, or a fault of Loki's own). This file owns the classification only; it never changes a verdict.
import { defaultBudgetsOn } from "./types.ts";

/** The lead of every reason whose cause is Loki's own (a check it could not run, its own limit, an internal error), never the change failing a check. */
export const LOKI_OWN_LEAD = "Loki could not finish checking: ";
/** Stages that check or deliver the change. A failure of one of these is Loki's own; a failure of intake, plan, implement or fix keeps its own text
 *  (setup, the provider, or the session), which the next-step hint reads. */
const OWN_STAGES: ReadonlySet<string> = new Set(["wall", "prove", "verify", "commit", "seal", "pr"]);
/** The outcome-line reason for a stage that failed: led with LOKI_OWN_LEAD when the cause is Loki's own, unchanged otherwise. */
export function ownReason(stage: unknown, reason: unknown): string | undefined {
  if (typeof reason !== "string" || reason.trim() === "") return undefined;
  const s = typeof stage === "string" ? stage : "";
  if (reason === "limit") return `${LOKI_OWN_LEAD}the ${s || "running"} stage reached its time limit`;
  return OWN_STAGES.has(s) && !reason.startsWith(LOKI_OWN_LEAD) ? `${LOKI_OWN_LEAD}${reason}` : reason;
}
/** A reason with the lead removed, for readers that match on the cause itself. */
export const withoutOwnLead = (reason: string): string => (reason.startsWith(LOKI_OWN_LEAD) ? reason.slice(LOKI_OWN_LEAD.length) : reason);

/** RW-03 VERIFIED MODE (`--verified`, LOKI_VERIFIED=1): opt-in. The user accepts more time and spend so that Loki keeps working toward VERIFIED. */
export const verifiedOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_VERIFIED"] ?? "").trim());
/** The bounds of verified mode's closure phase: rounds and wall clock always, dollars when every session is priced, new tokens. Each has its own override. */
export interface VerifiedBounds { rounds: number; wall_s: number; usd: number; tokens: number }
// NO-DEFAULT-BUDGET: a bound is the user's value (never clamped by Loki), else its old default only with LOKI_E10_DEFAULT_BUDGETS=1, else none (Infinity; null in the receipt).
const boundOf = (raw: string | undefined, dflt: number, env: NodeJS.ProcessEnv): number => { const n = Number((raw ?? "").trim()); return (raw ?? "").trim() !== "" && Number.isFinite(n) && n > 0 ? n : defaultBudgetsOn(env) ? dflt : Infinity; };
export const verifiedBounds = (env: NodeJS.ProcessEnv = process.env): VerifiedBounds => ({ rounds: Math.floor(boundOf(env["LOKI_VERIFIED_ROUNDS"], 3, env)), wall_s: Math.floor(boundOf(env["LOKI_VERIFIED_MAX_S"], 7200, env)), usd: boundOf(env["LOKI_VERIFIED_MAX_USD"], 5, env), tokens: Math.floor(boundOf(env["LOKI_VERIFIED_MAX_TOKENS"], 3_000_000, env)) });
/** Whether this build runs closure rounds. False until the round itself lands, so the header and the receipt never promise work that does not happen. */
export const CLOSURE_ROUNDS_BUILT = false;
/** The start-line text for a verified-mode run: the bounds that apply, said plainly. */
export function verifiedHeader(env: NodeJS.ProcessEnv = process.env): string {
  const b = verifiedBounds(env), lim = (v: number, f: (x: number) => string): string => (Number.isFinite(v) ? f(v) : "no limit"), hours = lim(b.wall_s, (w) => (w % 3600 === 0 ? `${w / 3600} h` : `${Math.round(w / 60)} min`));
  return CLOSURE_ROUNDS_BUILT ? `verified mode: up to ${lim(b.rounds, String)} closure rounds, ${hours}, ${lim(b.usd, (u) => `$${u.toFixed(2)}`)} when every session is priced, ${lim(b.tokens, (t) => `${(t / 1e6).toFixed(1)}M`)} new tokens` : "verified mode: on (recorded in the receipt; closure rounds are not in this build, so the run itself is unchanged)";
}
/** The receipt block of a verified-mode run. */
export const verifiedReceiptBlock = (env: NodeJS.ProcessEnv = process.env): { verified_mode?: { bounds: VerifiedBounds; closure_rounds_built: boolean; rounds: unknown[] } } => (verifiedOn(env) ? { verified_mode: { bounds: verifiedBounds(env), closure_rounds_built: CLOSURE_ROUNDS_BUILT, rounds: [] } } : {});
/** The independent reviewer's findings on a receipt's NOT PROVEN list (flags and blocks), in receipt order. The label rule does not read this. */
export const reviewerFlags = (notProven: readonly unknown[]): string[] => notProven.filter((n): n is string => typeof n === "string" && /^cross-review (flag|block) \(/.test(n));
/** Beside the label: ", 5 reviewer flags open", or "" when there are none. */
export const reviewerFlagsSuffix = (notProven: readonly unknown[]): string => { const n = reviewerFlags(notProven).length; return n ? `, ${n} reviewer flag${n === 1 ? "" : "s"} open` : ""; };
/** The same list with the reviewer's findings first, so they are read before the disclosures. Order within each part is kept. */
export const flagsFirst = <T,>(notProven: readonly T[]): T[] => { const f = new Set<unknown>(reviewerFlags(notProven)); return f.size ? [...notProven.filter((n) => f.has(n)), ...notProven.filter((n) => !f.has(n))] : [...notProven]; };

/** One structured reason seal's evaluation held the label below VERIFIED: the kind, and the check name or receipt line it came from. */
export interface CapReason { kind: string; detail: string }
export type ItemClass = "a" | "b" | "c";
export interface OpenItem {
  kind: string;
  class: ItemClass;
  /** What Loki did about it during the run, from the receipt's own records; null when the receipt records nothing. */
  tried: string | null;
  /** Why it is still open: the receipt's own line (or the failing check names). */
  why: string;
}
/** The receipt fields the classifier reads; every one is optional so an older or partial receipt still classifies. */
export interface ReceiptView {
  checks?: { name?: unknown; result?: unknown; pre_red?: unknown }[];
  not_proven?: unknown[];
  implement_limit?: unknown;
  spec_conflict_reason?: unknown;
  proof_rerun?: { exit?: unknown } | null;
  issue_acceptance_check?: { calls?: unknown } | null;
  cost?: { fix_rounds?: unknown } | null;
}
/** Lines that are on the receipt for disclosure and never hold the label. */
const NO_CAP = /does not cap|disclosed, not blocking|informational|^n\/a|^pre red:|^flaky test:|^cost |^completed by rule|^Wall failure output kept|kill blocking not enforced|^release note|^edited test kept uncapped|^value change|^repo identity unknown|receipt signing unavailable|^skipped by the repo|^lint red only in files|^linter not installed|^excused as red on base|^already failing on base|^not excused:|judge shares builder vendor|^cross-review skipped: low risk|^one reviewer|^new file nothing uses|^proof not compared with the base|ran no test in verify, runs in the proof script|^visual evidence skipped|^baseline: |^outside stated scope|^route\.|^full test command$|^full suite$|^security scan$|^test update reported/i;
const RULES: readonly (readonly [string, ItemClass, RegExp])[] = [
  ["Loki could not finish checking", "c", /^Loki could not finish checking: /],
  ["verify stopped at its time limit", "a", /^verify stopped at its time limit/],
  ["verify stopped at the run cap", "a", /^verify stopped at the run time cap/],
  ["suite or check timed out", "a", /timed out after \d+s/],
  ["suite aborted", "a", /^not run: .*\(aborted\)/],
  ["quick re-verify only", "a", /^quick re-verify only/],
  ["reverse-dependent tests dropped", "a", /^reverse-dependent tests dropped|^reverse-dependent scan hit/],
  ["base not measured", "a", /not measured on base/],
  ["holdout not executed", "a", /^holdout not executed/],
  ["acceptance check did not answer", "a", /^acceptance not reviewed/],
  ["no fail-then-pass test", "b", /^no test shown to fail on the base commit/],
  ["only agent-authored tests", "b", /^only agent-authored tests executed/],
  ["no tests executed", "b", /^no tests executed/],
  ["Wall green on base", "b", /^Wall green on base/],
  ["no check references a changed symbol", "b", /^no passing check references a changed symbol/],
  ["added public function not exercised", "b", /^no agent-independent passing test calls/],
  ["named spec site uncovered", "b", /^named site without a binding case/],
  ["acceptance line not addressed", "b", /^not addressed: /],
  ["proof re-run did not pass", "b", /^Loki's own re-run of the session's proof script did not pass/],
  ["named site unchanged without a reason", "b", /named site.*unchanged|left unchanged/],
  ["review block or UNMET", "b", /^cross-review (block|flag) /],
  ["weakened or changed tests", "b", /^weakened test|^test configuration changed|^skipped or fewer tests|^assertion value changed|^reverted test edit/],
  ["hidden or ignored files changed during the run", "b", /^ignore rules changed|^an ignored file that can change|^ignored file created during the run/],
  ["unfinished session", "b", /LOKI_UNFINISHED|unfinished|without a finish line|^changed, untested after limit/],
  ["fix round skipped, suite failures unproven", "b", /^fix round skipped/],
  ["time ran out", "c", /^time ran out|backstop/],
  ["open choice the issue does not decide", "c", /^open choice|^behavior change the issue does not decide|^NOT PROVEN:/],
  ["fails the same way on base (environment)", "c", /fails the same way on base|test command does not run in this checkout|pre-exist on base/],
  ["no runner or no test command", "c", /no runner of this repo|no test runner detected|defines no test command/],
  ["harness-owned failure", "c", /harness-owned/],
  ["system interpreter", "c", /system interpreter|system ruff/],
  ["Wall test not executed or discarded", "c", /^Wall test not executed|^wall test discarded|^wall base run not_run|^Wall assertion arbitrated|^Wall test fails/],
  ["review did not run", "c", /^cross-review not run/],
  ["secret match", "c", /^not pushed: /],
  ["check not run", "c", /^not run: /],
];
/** Every item that held this receipt below VERIFIED, in receipt order, one per kind (the first line of a kind is its `why`). A line no rule knows is
 *  kept as kind "other" in class c, so nothing is dropped silently. Disclosure lines are left out. */
export function openItems(r: ReceiptView): OpenItem[] {
  const out: OpenItem[] = [], seen = new Set<string>();
  const add = (kind: string, cls: ItemClass, tried: string | null, why: string): void => { if (!seen.has(kind)) { seen.add(kind); out.push({ kind, class: cls, tried, why }); } };
  const rounds = Array.isArray(r.cost?.fix_rounds) ? r.cost!.fix_rounds.length : 0;
  const failing = (r.checks ?? []).filter((c) => c?.result === "fail" && c.pre_red !== true).map((c) => String(c.name ?? ""));
  if (failing.length) add("a check fails", "b", rounds ? `${rounds} fix round(s)` : null, failing.slice(0, 5).join(", ") + (failing.length > 5 ? ` and ${failing.length - 5} more` : ""));
  if (r.implement_limit) add("implement stopped at its limit", "b", null, "the session was stopped before it finished");
  if (typeof r.spec_conflict_reason === "string" && r.spec_conflict_reason) add("spec conflict", "c", null, r.spec_conflict_reason);
  for (const raw of r.not_proven ?? []) {
    if (typeof raw !== "string" || raw === "" || NO_CAP.test(raw)) continue;
    const rule = RULES.find(([, , rx]) => rx.test(raw));
    const kind = rule ? rule[0] : "other", cls: ItemClass = rule ? rule[1] : "c";
    const tried = kind === "proof re-run did not pass" && r.proof_rerun ? `Loki ran the proof script itself (exit ${r.proof_rerun.exit === null || r.proof_rerun.exit === undefined ? "none" : String(r.proof_rerun.exit)})`
      : kind === "acceptance line not addressed" && typeof r.issue_acceptance_check?.calls === "number" ? `the acceptance check ran (${r.issue_acceptance_check.calls} call(s))` : null;
    add(kind === "other" ? `other: ${raw.slice(0, 60)}` : kind, cls, tried, raw);
  }
  return out;
}
