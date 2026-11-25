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
/** UNRUNNABLE-CHECK: the lead of the receipt line for a check that could not run on the base commit or on the change and so did not hold the label. */
export const COULD_NOT_RUN_LEAD = "could not run here, on the original code either: ";
/** Beside the label: ", 1 check could not run here (on the original code either)", or "" when there is none. */
export const couldNotRunSuffix = (notProven: readonly unknown[]): string => { const n = notProven.filter((x) => typeof x === "string" && x.startsWith(COULD_NOT_RUN_LEAD)).length; return n ? `, ${n} check${n === 1 ? "" : "s"} could not run here (on the original code either)` : ""; };
/** The same list with the reviewer's findings first, so they are read before the disclosures. Order within each part is kept. */
export const flagsFirst = <T,>(notProven: readonly T[]): T[] => { const f = new Set<unknown>(reviewerFlags(notProven)); return f.size ? [...notProven.filter((n) => f.has(n)), ...notProven.filter((n) => !f.has(n))] : [...notProven]; };

/** One structured reason seal's evaluation held the label below VERIFIED: the kind, and the check name or receipt line it came from. */
export interface CapReason { kind: string; detail: string }
/** VERIFY-PLAN V7: the mode of one label rule. off: the rule does nothing; observe: it runs and writes what it would have done to the receipt's
 *  `observe` list, never the label; enforce: it decides the label. 0/off/false/no is off, observe is observe, 1/on/true/yes/enforce is enforce,
 *  empty or anything else is the rule's default. */
export type RuleMode = "off" | "observe" | "enforce";
export function ruleMode(name: string, dflt: RuleMode, env: NodeJS.ProcessEnv = process.env): RuleMode {
  const v = (env[name] ?? "").trim().toLowerCase();
  return /^(0|off|false|no)$/.test(v) ? "off" : v === "observe" ? "observe" : /^(1|on|true|yes|enforce)$/.test(v) ? "enforce" : dflt;
}
/** One observe-mode rule that would have changed the label: the rule's knob, the label it would give at its own step of the seal, and why. */
export interface ObservedRule { rule: string; would_label: string; detail: string }
/** VERIFY-PLAN V7 stamp: what Loki ran before the label and the one thing that proved the change, or "none". */
export interface VerificationStamp { ran: string[]; proved_by: string }
export interface StampInput {
  checks: readonly { name: string; result: string; n?: number }[];
  wallFiles: number;
  proofRun: { exit: number | null; proved: number; failed: number } | null;
  ownProof: { ok: boolean; steps: number } | null;
  ftp: { ok: boolean; files: string[] } | null;
  alreadyOk: boolean;
  exoProof: boolean;
  noWall: boolean;
  strictProof: boolean;
  executed: boolean;
  proof: boolean; // seal's own proof value: no proof, no proved_by
  wallPassed: boolean; // verify's wall_passed === true: only then did a Wall test prove the change
}
export function verificationStamp(i: StampInput): VerificationStamp {
  const ran: string[] = [], done = (c: { result: string }): boolean => c.result === "pass" || c.result === "fail";
  const targeted = i.checks.filter((c) => done(c) && c.name.includes(":") && !c.name.startsWith("full suite") && !c.name.startsWith("lint:") && !c.name.startsWith("holdout")).length;
  if (targeted) ran.push(`${targeted} targeted test file(s)`);
  for (const c of i.checks) if (done(c) && c.name.startsWith("full suite")) ran.push(c.name);
  const stat = i.checks.filter((c) => done(c) && (c.name.startsWith("lint:") || c.name === "security scan" || c.name === "select-tests")).length;
  if (stat) ran.push(`${stat} static check(s)`);
  if (i.wallFiles > 0) ran.push(`Wall: ${i.wallFiles} file(s)`);
  if (i.checks.some((c) => c.name === "holdout" && done(c))) ran.push("held-out Wall tests");
  if (i.proofRun) ran.push(`proof script re-run (exit ${i.proofRun.exit === null ? "none" : i.proofRun.exit}, ${i.proofRun.proved} proved, ${i.proofRun.failed} failed)`);
  if (i.ownProof) ran.push(`proof script without the change (${i.ownProof.steps} step(s) counted)`);
  if (i.ftp) ran.push("the change's own tests on the base commit");
  const proved_by = !i.proof ? "none"
    : i.alreadyOk ? "Loki's re-run of the kept proof script on the unchanged tree"
    : !i.noWall && i.exoProof && i.wallPassed ? "a Wall test written from the issue before the code"
    : i.exoProof ? "an agent-independent passing test"
    : i.ftp?.ok ? `a test that fails on the base commit and passes on the change: ${i.ftp.files.join(", ")}`
    : i.ownProof?.ok ? "a proof script step that fails without the change and passes with it"
    : !i.strictProof && i.executed ? "executed tests (LOKI_EXOGENOUS_PROOF=0)"
    : "none";
  return { ran: ran.length ? ran : ["none"], proved_by };
}
type V2Outputs = Partial<Record<string, Record<string, unknown>>>;
const v2strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const v2raw = (o: V2Outputs): Record<string, unknown>[] => (Array.isArray(o.verify?.checks) ? (o.verify!.checks as Record<string, unknown>[]) : []);
/** The file a per-file check runs: the part of its name after the first ":". */
export const fileOfCheck = (name: string): string => name.slice(name.indexOf(":") + 1);
/** The Wall checks of the last verify: a check whose file is one of the Wall files the Wall stage kept (each was red on base when it was written). */
export const wallCheckNames = (o: V2Outputs): Set<string> => {
  const files = (Array.isArray(o.wall?.files) ? (o.wall!.files as Record<string, unknown>[]) : []).map((f) => String(f.path ?? "")).filter(Boolean);
  return new Set(v2raw(o).map((c) => String(c.name)).filter((n) => n.includes(":") && files.some((f) => f === fileOfCheck(n) || f.endsWith("/" + fileOfCheck(n)))));
};
/** VERIFY-PLAN V2 (LOKI_E10_INTRODUCED, default observe; enforce is accepted and behaves as observe until verify owns it): each failing check
 *  verify did not excuse, sorted by what one differential measurement shows. introduced: the change's own check (a Wall, holdout, task-named
 *  or changed test file, a lint, typecheck, scan or selector check), a check verify attributed to the change (introduced_checks), or one whose
 *  base run was compared and showed a failing id not red on base (fresh >= 1) or whose failure names a changed file. pre_existing: compared,
 *  every failing id also red on base (fresh 0), the same error as on base (known_red_same_error), and nothing names a changed file.
 *  unknown: any other failing check, with why (the error differs from base, the base run was cut, not started, not comparable or
 *  unattributable, or no base comparison was recorded). */
export const introducedMode = (env: NodeJS.ProcessEnv = process.env): RuleMode => ruleMode("LOKI_E10_INTRODUCED", "observe", env);
export const V2_ERROR_DIFFERS = "every failing id is red on base, but its error differs from the base run";
export const V2_SUITE_NOT_EXCUSED = "a full suite red on base with the same error that verify did not excuse (see its not_excused line)";
export const V2_NO_RECORD = "no base comparison was recorded for this check";
export interface FailureClasses { introduced: string[]; pre_existing: string[]; unknown: { name: string; why: string }[] }
export function failureClasses(o: V2Outputs): FailureClasses {
  const v = o.verify, raw = v2raw(o), pre = new Set(v2strs(v?.pre_red_checks)), changed = new Set(v2strs(v?.changed_files)), own = new Set(v2strs(v?.own_checks));
  const noIdCmp = new Set(v2strs(v?.no_id_compared)), intro = new Set(v2strs(v?.introduced_checks)), ownLint = new Set(v2strs(v?.own_lint)), same = new Set(v2strs(v?.known_red_same_error));
  const wall = wallCheckNames(o), attr = (v?.exogenous_attribution ?? {}) as Record<string, { state?: string; fresh?: number; names_changed?: boolean; evidence?: string } | undefined>;
  const out: FailureClasses = { introduced: [], pre_existing: [], unknown: [] };
  for (const c of raw) {
    const name = String(c.name ?? "");
    if (c.result !== "fail" || c.owner === "harness" || pre.has(name)) continue;
    const ownCheck = name === "holdout" || name.startsWith("holdout:") || wall.has(name) || own.has(name) || ownLint.has(name) || /^(lint|typecheck)(:|$)/.test(name) || name === "security scan" || name === "select-tests" || name === "app boot" || name === "checklist" || (name.includes(":") && !name.startsWith("full suite") && changed.has(fileOfCheck(name)));
    if (ownCheck || intro.has(name) || noIdCmp.has(name)) { out.introduced.push(name); continue; }
    const ids = v2strs(c.ids);
    if (ids.some((i) => [...changed].some((f) => i.includes(f)))) { out.introduced.push(name); continue; } // an id naming a changed file is the change's own failure
    const a = attr[name];
    if (a?.names_changed) out.introduced.push(name);
    else if (a?.state === "compared" && Number(a.fresh) >= 1) out.introduced.push(name);
    else if (a?.state === "compared" && a.fresh === 0 && !same.has(name)) out.unknown.push({ name, why: V2_ERROR_DIFFERS });
    else if (a?.state === "compared" && a.fresh === 0 && name.startsWith("full suite")) out.unknown.push({ name, why: V2_SUITE_NOT_EXCUSED });
    else if (a?.state === "compared" && a.fresh === 0) out.pre_existing.push(name);
    else if (a) out.unknown.push({ name, why: String(a.evidence ?? a.state ?? "not comparable") });
    else out.unknown.push({ name, why: V2_NO_RECORD });
  }
  return out;
}
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
const NO_CAP = /^could not run here|does not cap|disclosed, not blocking|informational|^n\/a|^pre red:|^flaky test:|^cost |^completed by rule|^Wall failure output kept|kill blocking not enforced|^release note|^edited test kept uncapped|^value change|^repo identity unknown|receipt signing unavailable|^skipped by the repo|^lint red only in files|^linter not installed|^excused as red on base|^already failing on base|^not excused:|judge shares builder vendor|^cross-review skipped: low risk|^one reviewer|^new file nothing uses|^proof not compared with the base|ran no test in verify, runs in the proof script|^visual evidence skipped|^baseline: |^outside stated scope|^route\.|^full test command$|^full suite$|^security scan$|^test update reported/i;
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
