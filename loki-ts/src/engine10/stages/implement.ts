// E-08: Implement (ENGINE.md 4, 16). One session; the brief marks Wall tests read-only, names only the impacted tests. Afterwards any changed Wall file is restored (tests_reverted) and the exit is classified.
import { execSpecBriefOf } from "../../features/exec_spec.ts"; import { recoverTournamentUndo, runTournamentGate, tournamentEnabled } from "../../features/tournament.ts"; import { nrdOverlapOn, runNrdGate, startNrdGate } from "../../features/no_regression.ts";
import { installOwned } from "../../project_model/install.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { withStagePrefix } from "../../features/lean_prefix.ts"; import { fragmentWriterOn, outOfRepoReask, outOfRepoTests } from "../../project_model/conventions.ts";
import { learningsBlock, lessonsForBrief, orgKnowledgeBlock } from "../../util/pr_lessons.ts"; export { learningsBlock }; // learningsBlock lives with the other brief-note helpers
import { FINISH_LINE, FIXED_RULES, briefRecord, type BriefRecord } from "../../e10ext/context.ts";
import { fastTierModel } from "../../runner/model_downgrades.ts";
import { cascadeDowngrade, loadRepoMap, namedFiles, sizeTask } from "../sizing.ts";
import type { ExtraAttemptsDeps } from "../../features/attempts.ts";
import { selectRelevantFiles } from "./plan.ts"; import { changedFiles, checkExcerpt, commandFor, runCheck, type VerifyCheck } from "./verify.ts"; import { loadProjectApi } from "../../project_model/resolve.ts"; import { suiteCmdsOpt } from "../../project_model/package_suite.ts"; import { planStopChecks } from "../../runner/stop_checks.ts";
import { capStopOf, classifyExitCause, resolveModel } from "../session.ts"; import { MAX_TURNS_EXIT } from "../../runner/worker_proc.ts"; // E-68 reuse: never re-classify exit codes here
import { adjudicateWallConflict, coverageFoldLines, coverageMode, coverageResumeEnabled, reaskFoldedClaims, resumeAfterAlreadyDone, resumeNeverStop, resumeAfterConflict, resumeAfterEmptyDone, resumeForCoverage } from "../../util/conflict_resume.ts";
import { INTERRUPTED_BRIEF, interruptedSession, planChain, readSessionId } from "../../runner/session_resume.ts";
import { routeEscalate, routeStart } from "../../runner/router/implement_route.ts";
import { routerActive } from "../../runner/router/unit_model.ts";
import { type ImplementExit, type RunContext, type SessionResult, type SessionRunOptions, type Stage, type StageResult, type TestMap, type TestRef, taskBlock } from "../types.ts";
import { safeGit } from "../../util/safe_git.ts"; import { runPickedChoice, sha256 } from "./seal.ts";
import { adviceBlock, assumptionOf, consultEnabled, neverStopActive, runConsult, type NeverStopRecord } from "../../features/opus_consult.ts"; import { currentDiff } from "../../runner/session_resume.ts";
import { assumptionsBlock } from "../../features/spec_ambiguity.ts";
import { loadSpecFile, specBriefBlock, type LoadedSpec } from "../../util/spec_file.ts";
import { appliedTests, buildPatchBrief, patchCallFor, patchEnabled, runPatchProtocol, testConventions, type PatchCall, type PatchCheck, type PatchOutcome } from "../../features/patch_protocol.ts";
import { isTestFile } from "../../util/test_file_text.ts";

/** A test file (a sealed Wall test) the implement session must not change: path is absolute, in the repo working tree; content is what to restore if it no longer matches. */
export interface ReadOnlyFile { path: string; content: string; }

/** Impacted tests: the intake test map narrowed to plan's relevant files, falling back to the task's named  files when Plan was skipped or found none (E-64's lean path; E-98c), plus the sealed Wall tests. */
export function impactedTests(ctx: RunContext): string[] {
  const o = ctx.outputs();
  const map = o.intake?.testmap as TestMap | undefined;
  const task = (o.intake?.task as string | undefined) ?? "";
  const relevantFiles = o.plan?.relevant_files as string[] | undefined;
  const relevant = relevantFiles?.length ? relevantFiles : namedFiles(task, loadRepoMap(o.intake?.repomap_ref as string | undefined));
  const fromMap = map ? ctx.tests.impacted(map, relevant).map((t) => t.path) : [];
  const wall = ((o.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? []).map((f) => relative(ctx.repoDir, f.path));
  return [...new Set([...fromMap, ...wall])];
}

export const briefCtx = (ctx: RunContext, model?: string): BriefRecord => briefRecord(ctx, { select: selectRelevantFiles, cmd: (t, repoDir) => { const c = commandFor(t, repoDir, loadProjectApi(repoDir)); return [c.cmd, c.args, c.interpreter, c.pkgRoot]; } }, model); // L021: a haiku or sonnet model adds the context pack
// Plan skipped: fixed lines (this one, then the folded coverage line), no per-task text, placed right after FIXED_RULES so every skipped-plan brief shares the same cache-stable prefix.
export const FOLD_PLAN_INSTRUCTION = "Before editing, write the files you will change and the test you will run, in at most 10 lines, then proceed.";
const REPRO_LINE = "If the task reports a bug, first add a new test function that reproduces it, run it and see it fail, then fix the code and run that test again.";
export function buildImplementBrief(task: string, plan: string | null, impactedTests: string[], repoMap = "", spec: string | null = null, assumptions: unknown = undefined): string {
  return withStagePrefix([ // FIXED_RULES leads and FINISH_LINE closes, both byte-identical per task
    FIXED_RULES,
    ...(plan ? [] : [FOLD_PLAN_INSTRUCTION, ...coverageFoldLines()]), // LOKI_E10_COVERAGE_RESUME fold (default): fixed bytes before any per-task text; turn and off add nothing (main's brief)
    ...taskBlock(task),
    ...assumptionsBlock(assumptions),
    ...(spec ? [spec] : []), // SPEC-FIRST-INTENT: the user-edited spec is the authoritative intent; absent adds nothing
    plan ? `Follow this plan:\n${plan}` : "No separate plan was made: plan the change yourself in this session, then implement it." + (process.env.LOKI_E10_REPRO === "1" ? " " + REPRO_LINE : ""), // TEN-QUALITY-08: default off, lean path only
    ...(repoMap ? [repoMap] : []),
    impactedTests.length ? `Impacted tests (a starting hint, not a limit): ${impactedTests.join(", ")}.` : "Impacted tests: none known; run the targeted tests for the code you change (the harness runs the full suite after you stop when the diff's risk tier is medium or high).",
    FINISH_LINE,
  ].join("\n\n"));
}

/** Restores any read-only file the session changed or deleted; returns the paths restored, in order given. */
export function restoreReadOnly(files: ReadOnlyFile[]): string[] {
  const reverted: string[] = [];
  for (const f of files) {
    const current = existsSync(f.path) ? readFileSync(f.path, "utf8") : null;
    if (current !== f.content) {
      writeFileSync(f.path, f.content, "utf8");
      reverted.push(f.path);
    }
  }
  return reverted;
}

/** FC-43: the exact set verify.ts judges "empty diff" on; an unreadable tree is "not empty" so the resume never fires on a guess. */
function treeIsEmpty(ctx: RunContext): boolean {
  try { return changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created)).length === 0; } catch { return false; }
}

/** The supervisor snapshots the spec it hashed into the run dir; read that copy, never the live file the user may still be editing. */
function specFor(ctx: RunContext): LoadedSpec | null {
  if (!process.env.LOKI_E10_SPEC_SHA256) return null;
  try { return loadSpecFile(join(ctx.runDir, "spec.snapshot.md")); } catch { return null; }
}

/** CW-12: the changes were made by an external client and arrive as a patch. Apply it to the tree the Wall already sealed against; no session runs and the exit is "external". */
export function applyExternalPatch(ctx: RunContext, patchPath: string): StageResult {
  try { safeGit(ctx.repoDir, ["apply", "--binary", "--whitespace=nowarn", patchPath]); } catch (e) { return { status: "failed", data: { exit: "error", external: true }, reason: `external patch does not apply: ${(e as Error).message.split("\n")[0]}` }; }
  const testsReverted = restoreReadOnly((ctx.outputs().wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? []);
  return { status: "completed", data: { exit: "external", external: true, patch_sha256: sha256(readFileSync(patchPath, "utf8")), tests_reverted: testsReverted, impacted_tests: impactedTests(ctx), iteration_ids: [] } };
}

/** EXP-0010: the exact brief the first implement session got (saved by the stage); null when it was not saved. */
export const ATTEMPT_BRIEF_FILE = "implement-brief.txt";
export function savedImplementBrief(ctx: RunContext): string | null { try { return readFileSync(join(ctx.runDir, ATTEMPT_BRIEF_FILE), "utf8") || null; } catch { return null; } }
/** EXP-0010: what the extra attempts need beyond the brief, shared with the machine: the impacted-test set, the Wall's bytes, and verify's own runner for one test. */
export function attemptDeps(ctx: RunContext, k: number, brief: string, limitS: number, model?: string): ExtraAttemptsDeps {
  const readOnly = (ctx.outputs().wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];
  return {
    k, brief, limitS, impacted: impactedTests(ctx), ...(model ? { model } : {}),
    wallPaths: readOnly.map((f) => relative(ctx.repoDir, f.path)), wallContent: Object.fromEntries(readOnly.map((f) => [relative(ctx.repoDir, f.path), f.content])),
    check: (c, t, sg, out) => { const tc = commandFor(t, c.repoDir, loadProjectApi(c.repoDir)); return runCheck(c, `${t.runner}:${t.path}`, tc.cmd, tc.args, sg, out as VerifyCheck[], { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}) }); },
  };
}

/** LOKI_E10_PATCH: the patch protocol's harness-run check. The impacted tests of the applied files plus every applied test file (its runner from a mapped file with the same extension), at most PATCH_MAX_CHECKS, run by verify's own runner with no events emitted. */
const PATCH_MAX_CHECKS = 6;
export function patchCheckRefs(ctx: RunContext, applied: string[], impacted: string[]): TestRef[] {
  const map = ctx.outputs().intake?.testmap as TestMap | undefined;
  const ext = (p: string): string => p.slice(p.lastIndexOf("."));
  const fromMap = map ? [...ctx.tests.impacted(map, applied.filter((f) => !isTestFile(f))), ...map.tests.filter((t) => impacted.includes(t.path) || applied.includes(t.path))] : [];
  const extra = appliedTests(applied).filter((f) => !fromMap.some((t) => t.path === f)).flatMap((f): TestRef[] => { const r = map?.tests.find((t) => ext(t.path) === ext(f))?.runner ?? (map?.runners.length === 1 ? map.runners[0] : undefined); return r ? [{ runner: r, path: f }] : []; });
  const seen = new Set<string>();
  return [...extra, ...fromMap].filter((t) => !seen.has(t.path) && !!seen.add(t.path)).slice(0, PATCH_MAX_CHECKS);
}
export function patchCheck(ctx: RunContext, impacted: string[], wall: string[], signal: AbortSignal): (applied: string[]) => Promise<PatchCheck> {
  return async (applied) => {
    const refs = patchCheckRefs(ctx, applied, impacted), quiet = Object.assign(Object.create(ctx) as RunContext, { emit: () => undefined }), out: VerifyCheck[] = [];
    const map = ctx.outputs().intake?.testmap as TestMap | undefined;
    if (!refs.some((t) => impacted.includes(t.path) || (map?.tests ?? []).some((m) => m.path === t.path))) return { ok: false, ran: 0, names: refs.map((t) => `patch:${t.runner}:${t.path}=own test only`), digest: "no test that existed before the change covers it; the model's own new test alone is no proof" }; // never green on the model's own test alone: fall back
    for (const t of refs) { const tc = commandFor(t, ctx.repoDir, loadProjectApi(ctx.repoDir)); await runCheck(quiet, `patch:${t.runner}:${t.path}`, tc.cmd, tc.args, signal, out, { ...(tc.interpreter ? { interpreter: tc.interpreter } : {}), ...(tc.pkgRoot !== "." ? { cwd: tc.cwd } : {}), wall: new Set(wall) }); }
    const ran = out.filter((c) => c.result === "pass" || c.result === "fail" || c.result === "flaky");
    return { ok: ran.length > 0 && ran.length === out.length && out.every((c) => c.result === "pass"), ran: ran.length, names: out.map((c) => `${c.name}=${c.result}`), digest: out.filter((c) => c.result !== "pass").map((c) => `${c.name}: ${c.result}${c.reason ? ` (${c.reason})` : ""}\n${checkExcerpt(c) || c.first_error || ""}`).join("\n").slice(0, 1500) };
  };
}
/** The patch brief: the context pack's code (the haiku pack), the impacted tests' heads and the exact check commands. */
export function patchBrief(ctx: RunContext, task: string, impacted: string[]): string {
  const bc = briefCtx(ctx, "haiku"), code = bc.packText ?? "";
  const refs = patchCheckRefs(ctx, bc.files.filter((f) => !isTestFile(f)), impacted); // the tests of the code the dossier shows, not only the task's named files
  const tests = [...new Set([...impacted.filter((p) => isTestFile(p)), ...refs.map((t) => t.path)])], cmds = refs.map((t) => { const c = commandFor(t, ctx.repoDir, loadProjectApi(ctx.repoDir)); return `${c.pkgRoot !== "." ? `cd ${c.pkgRoot} && ` : ""}${[c.cmd.startsWith(`${ctx.repoDir}/`) ? relative(ctx.repoDir, c.cmd) : c.cmd, ...c.args].join(" ")}`; });
  return buildPatchBrief(task, code || bc.text, testConventions(ctx.repoDir, tests), cmds);
}
/** Test seam: the e2e drives the protocol with a recorded reply instead of a model. */
let patchCallOverride: PatchCall | null = null;
export function __setPatchCallForTests(c: PatchCall | null): void { patchCallOverride = c; }

export const implementStage: Stage = {
  name: "implement",
  targetS: 180,
  limitS: 480,

  async run(ctx: RunContext, signal: AbortSignal): Promise<StageResult> {
    rmSync(join(ctx.repoDir, ".loki", "supply-declared.json"), { force: true }); // T10 B3: never judge this run by a stale declaration
    try { recoverTournamentUndo(ctx.repoDir, ctx.runDir); } catch { /* an unreadable record is left for a person */ } // a displacement a kill cut short is undone before any session can write newer edits
    if (ctx.externalPatch) return applyExternalPatch(ctx, ctx.externalPatch);
    const prior = ctx.outputs();
    const task = (prior.intake?.task as string | undefined) ?? "";
    const plan = (prior.plan?.plan as string | undefined) ?? null;
    const impacted = impactedTests(ctx);
    const readOnly = (prior.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [];
    const routed = routerActive();
    const downgrade = routed ? null : cascadeDowngrade(ctx.model); // the router (LOKI_ROUTER=auto for Haiku first) replaces the opt-in downgrade list
    const cascade = downgrade !== null;
    if (downgrade) process.stderr.write(`${downgrade.note}\n`);
    const lessons = lessonsForBrief(ctx.repoDir, ctx.runId, task, [...((prior.plan?.relevant_files as string[] | undefined) ?? []), ...impacted], ctx.runDir); // T6: reviewer lessons plus run lessons on the relevant files or their impacted tests (util/pr_lessons.ts), tagged as used by this run and recorded in lessons-injected.json
    const bc = briefCtx(ctx, routed ? undefined : downgrade?.to ?? ctx.model), repoMap = bc.text + lessons + learningsBlock(ctx.repoDir) + orgKnowledgeBlock(ctx.repoDir, task, ctx.runDir); // S41-10: up to 20 relevant files + impacted test commands, not the first 200 paths; FR06 org block is off unless LOKI_ORG_GRAPH=1

    const spec = specFor(ctx);
    // CH-03: resume plan's session on the same model (never when routed: per-unit models differ). Wall, verify and seal never join the chain. planChain owns eligibility; `!plan` here only keeps plan_chain out of the data when plan was skipped.
    const chain = routed || !plan ? null : planChain(ctx, downgrade?.to ?? ctx.model, fastTierModel(process.env));
    const own = routed ? null : interruptedSession(ctx, `${ctx.runId}-impl`); // a rerun continues its own killed session before any plan link
    const ownId = own && "id" in own ? own.id : undefined;
    const resumeId = ownId ?? (chain && "id" in chain ? chain.id : undefined);
    let planChainMode: string | undefined = ownId ? "resumed (interrupted session)" : chain ? (resumeId ? "resumed" : `fresh (${(chain as { why: string }).why})`) : undefined;
    let sessionResume: string | undefined = own ? (ownId ? "resumed" : `fresh (${(own as { why: string }).why})`) : undefined;
    const picked = (Array.isArray(prior.intake?.assumptions) ? (prior.intake!.assumptions as unknown[]) : []).filter((a): a is string => typeof a === "string" && runPickedChoice(a)); // LOKI_E10_OPUS_CONSULT trigger open-choice: an either/or the run would settle by itself
    const choiceAdvice = picked.length && consultEnabled() && !ownId && !signal.aborted ? await runConsult({ runDir: ctx.runDir, repoDir: ctx.repoDir, stage: "implement", trigger: "open-choice", task, evidence: picked.join("\n"), diff: null, code: bc.packText ?? bc.text }) : null;
    const fullBrief = buildImplementBrief(task, plan, impacted, repoMap, [specBriefBlock(spec), execSpecBriefOf(ctx.runDir), ...adviceBlock(choiceAdvice)].filter(Boolean).join("\n\n") || null, prior.intake?.assumptions); // the advice joins the per-task part of the brief, never the cache-stable prefix // LOKI_E10_EXEC_SPEC: the binding and advisory spec cases the lean Wall stage left
    try { mkdirSync(ctx.runDir, { recursive: true }); writeFileSync(join(ctx.runDir, ATTEMPT_BRIEF_FILE), fullBrief, "utf8"); } catch { /* best effort: without it the machine starts no extra attempt */ } // EXP-0010: the extra attempts after a red verify start from this exact brief
    const first: SessionRunOptions = {
      stage: "implement",
      brief: ownId ? INTERRUPTED_BRIEF : fullBrief,
      tier: "development",
      iterationId: `${ctx.runId}-impl`,
      limitS: implementStage.limitS,
      signal,
      cwd: ctx.repoDir,
      ...(downgrade ? { model: downgrade.to } : {}),
      ...suiteCmdsOpt(ctx.repoDir, prior.intake?.testmap), ...(resumeId ? { resumeSessionId: resumeId } : {}), ...planStopChecks(ctx.repoDir, prior, new Set(impacted), implementStage.limitS, ctx.baseSha), // in-session fix rounds, default on (LOKI_E10_STOP_CHECKS=0 off)
    };
    const unchained = (): SessionRunOptions => { const { resumeSessionId: _chained, ...rest } = first; return ownId ? { ...rest, brief: fullBrief } : rest; }; // read at call time: the router may rewrite first.model; retries and conflict reruns never inherit the chain link
    // ROUTER-1: per-unit ladder from the plan's route record (runner/router/unit_model.ts). Flag off: none of this runs.
    const size = sizeTask(task, loadRepoMap(prior.intake?.repomap_ref as string | undefined), (prior.intake?.testmap as TestMap | undefined) ?? null).size;
    const rt = routed ? routeStart(ctx, first, prior.plan, size) : null;
    // LOKI_E10_PATCH (default off): lean path only (no plan, no router, no session to continue). Green skips the agentic session; anything else restored the tree and the session below runs as today.
    let patch: PatchOutcome | undefined, patchS = 0, patchNote = ""; // patchNote: the patch reply's lines before its first edit block (its root cause), the green session's summary
    const patchModel = downgrade?.to ?? ctx.model ?? resolveModel(ctx.provider); // a named model only: "claude (provider default)" names none for a tool-less call
    const patchOn = patchEnabled() && !plan && !routed && !resumeId && ctx.provider === "claude" && /^[\w.:@/-]+$/.test(patchModel);
    if (patchOn && !signal.aborted) {
      const started = Date.now();
      try { patch = await runPatchProtocol({ rules: { repoDir: ctx.repoDir, readOnly: readOnly.map((f) => relative(ctx.repoDir, f.path)), task }, brief: patchBrief(ctx, task, impacted), iterationId: `${ctx.runId}-impl-p`, signal,
        call: patchCallOverride ?? patchCallFor(patchModel, join(ctx.repoDir, ".loki")), check: patchCheck(ctx, impacted, readOnly.map((f) => relative(ctx.repoDir, f.path)), signal),
        record: (n, prompt, reply) => { if (reply && n === 1) patchNote = reply.split(/^FILE:/m)[0]!.trim(); mkdirSync(ctx.runDir, { recursive: true }); writeFileSync(join(ctx.runDir, `implement-patch-${n}.txt`), `${prompt}\n\n=== REPLY ===\n${reply ?? "(call failed)"}\n`, "utf8"); } });
      } catch (e) { patch = { status: "error", calls: 0, applied: [], refused: [], restored: [], log: [`error before any edit: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`], usd: null }; } // the brief or the call setup threw (the protocol restores its own writes): the agentic session runs
      patchS = (Date.now() - started) / 1000;
    }
    let session: SessionResult = patch?.status === "green" ? { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: patchS, killed: false, summary: patchNote || patch.log.join("\n") } : await ctx.sessions.run(first);
    const ids = patch?.status === "green" ? [`${ctx.runId}-impl-p`] : [first.iterationId];
    if (patch?.status !== "green" && resumeId && !session.killed && session.exit !== 0 && session.exit !== MAX_TURNS_EXIT) { // a failed resume reruns fresh with the same full brief
      planChainMode = "fallback (resume failed)";
      if (ownId) { sessionResume = "fallback (resume failed)"; process.stderr.write(`implement: recorded session ${ownId} was not resumable, starting a fresh session\n`); }
      const retry = `${first.iterationId}f`; ids.push(retry);
      session = await ctx.sessions.run({ ...unchained(), iterationId: retry });
    }
    if (rt && !signal.aborted) session = await routeEscalate(ctx, first, session, rt, ids, () => treeIsEmpty(ctx)); // triggers b/c (and, under the preset, a no-diff already-done claim): one redo on the next rung
    if (session.markers.specConflict && !session.killed) { const r = await resumeAfterConflict(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId); } // FC-19: one correction, then the conflict is believed
    if (session.markers.specConflict && !session.killed && !signal.aborted) { const w = await adjudicateWallConflict(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, readOnly); if (w) { session = w.session; ids.push(...w.ids); } } // FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a Wall-anchored conflict goes to the referee (record: outputs.wall.arbitrated)
    let neverStop: NeverStopRecord | undefined; // LOKI_E10_OPUS_CONSULT never-stop: a headless run does not end BLOCKED on a conflict it can settle; one consult, then one resume that implements the most likely intent
    if (session.markers.specConflict && !session.killed && !signal.aborted && neverStopActive()) {
      const reason = session.markers.specConflict;
      const advice = await runConsult({ runDir: ctx.runDir, repoDir: ctx.repoDir, stage: "implement", trigger: "stop", task, evidence: `The agent stopped with LOKI_SPEC_CONFLICT: ${reason}\n\nIts last message:\n${(session.summary ?? "").slice(-1500)}`, diff: currentDiff(ctx.repoDir, ctx.baseSha, 6000, true), code: bc.packText ?? bc.text });
      const r = await resumeNeverStop(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, reason, advice); session = r.session; if (r.iterationId !== ids[ids.length - 1]) ids.push(r.iterationId);
      if (!session.markers.specConflict) neverStop = { stage: "implement", conflict: reason, assumption: assumptionOf(session.summary), consulted: advice !== null };
    }
    // HONEST-ALREADY-DONE: an already-done claim gets one challenge before it is believed, including a claim made in reply to the empty-done correction; after a challenge no empty-done correction follows (one extra session at most).
    // A no-diff claim the router already redid on the next rung (routeEscalate, trigger already_done_claim) was challenged in that redo's brief; an empty-done correction after it carries the challenge too.
    let challenged = false; const routerRedid = rt?.escalations.some((e) => e.trigger === "already_done_claim") ?? false;
    const challenge = async (): Promise<void> => { if (signal.aborted || session.killed || !session.markers.alreadyDone || session.markers.specConflict || challenged || routerRedid || process.env.LOKI_E10_ALREADY_DONE_CHALLENGE === "0") return; challenged = true; const r = await resumeAfterAlreadyDone(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; ids.push(r.iterationId); };
    await challenge();
    if (!challenged && !signal.aborted && !session.killed && session.exit === 0 && !session.markers.specConflict && !session.markers.alreadyDone && treeIsEmpty(ctx)) { const r = await resumeAfterEmptyDone(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session, routerRedid); session = r.session; ids.push(r.iterationId); await challenge(); } // FC-43: one correction for a done exit with no change

    let coverage: string | undefined; // L4: lean path only; an attempts run owns its own sessions
    let claimAbsent: string[] | undefined; // site-ledger claimed_change_absent: SITE lines naming a line the coverage turn did not change, re-asked once
    if (coverageResumeEnabled() && !plan) { if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await resumeForCoverage(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); claimAbsent = r.claimAbsent; coverage = "resumed"; } else coverage = patch?.status === "green" ? "skipped (patch green)" : "skipped"; }
    else if (coverageMode() === "fold" && !plan) { // the brief carried COVERAGE_FOLD (buildImplementBrief), so no separate turn; with LOKI_E10_CLAIM_CHECK on, the session's own SITE lines get the claim check
      coverage = patch?.status === "green" ? "skipped (patch green)" : "folded";
      if (patch?.status !== "green" && !signal.aborted && !session.killed && session.exit === 0 && session.markers.done && !session.markers.specConflict && !session.markers.alreadyDone && !treeIsEmpty(ctx)) { const r = await reaskFoldedClaims(ctx, { ...unchained(), iterationId: ids[ids.length - 1]! }, session); session = r.session; for (const id of r.iterationIds) if (!ids.includes(id)) ids.push(id); claimAbsent = r.claimAbsent; }
    }

    if (process.env.LOKI_E10_REPRO === "1" && !plan && !signal.aborted && !session.killed && session.exit === 0) { let bad: { name: string; why: string }[] = []; try { bad = outOfRepoTests(ctx.repoDir, changedFiles(ctx.repoDir, ctx.baseSha, installOwned(ctx.repoDir, ctx.outputs().intake?.install_created))); } catch { /* unreadable tree: no re-ask */ } if (bad.length) { const redo = `${first.iterationId}-oor`; ids.push(redo); session = await ctx.sessions.run({ ...unchained(), brief: withStagePrefix(outOfRepoReask("Rewrite these new test files in place, keeping the same names and what they reproduce.", bad)), iterationId: redo }); } } // TEN-QUALITY-44: the repro test gets the Wall's out-of-repo check and one re-ask
    const testsReverted = restoreReadOnly(readOnly);
    const tournament = tournamentEnabled() && !plan ? await runTournamentGate(ctx, signal, session, attemptDeps(ctx, 0, "", 0)) : undefined; // after the Wall files are restored, so candidates are checked against the original Wall and tests; LOKI_E10_TOURNAMENT (Go, lean path, on by default but inert without an exec-spec probe block; =0 opts out): features/tournament.ts
    const overlap = !plan && nrdOverlapOn(); if (overlap) startNrdGate(ctx, signal, session, readOnly.map((f) => relative(ctx.repoDir, f.path))); // SPEED-NRD-OVERLAP: verify (or seal) settles it
    const noRegression = !plan && !overlap ? await runNrdGate(ctx, signal, session, readOnly.map((f) => relative(ctx.repoDir, f.path))) : null; // LOKI_E10_NRD (Go, lean path, default on, =0 opts out): features/no_regression.ts, after the tournament and the Wall restore; the first verify hands its finding to one fix round
    const iterationId = ids[ids.length - 1]!;
    // E-68 classifies exit codes; a non-killed, marker-less non-zero exit is an error, never "done".
    let exit: ImplementExit | "error";
    if (session.killed || session.exit === MAX_TURNS_EXIT) { // a turn-cap stop is harness-owned and ends like a limit stop: PARTIAL, never BLOCKED
      exit = "killed";
    } else if (session.markers.specConflict) {
      exit = "spec_conflict";
    } else if (session.markers.alreadyDone && treeIsEmpty(ctx)) { // an already-done claim over edits is a change, never "already satisfied": the edits are verified and kept, not discarded by commit
      exit = "already_done";
    } else if (session.markers.alreadyDone) {
      exit = "done";
    } else if (session.exit !== 0) {
      exit = "error";
    } else {
      exit = "done";
    }

    const data: Record<string, unknown> = {
      exit,
      already_done_evidence: session.markers.alreadyDone,
      spec_conflict_reason: session.markers.specConflict,
      tests_reverted: testsReverted,
      impacted_tests: impacted, brief_files: bc.files, ...(bc.pack ? { context_pack: bc.pack } : {}), // L022: the exact files the brief named; L021: pack paths and line ranges
      cascade,
      ...(downgrade ? { model_downgrade: downgrade.note } : {}),
      iteration_ids: ids, model: rt ? rt.current : downgrade?.to ?? ctx.model, ...(rt ? { route_model: rt.current, route_escalations: rt.escalations } : {}), session_id: readSessionId(ctx.repoDir, iterationId), // MW-2
      duration_s: session.durationS, ...(session.exit === MAX_TURNS_EXIT && !session.killed ? { stop_cause: "max_turns", owner: "harness", limit_s: implementStage.limitS, elapsed_s: session.durationS, ...(capStopOf(session.summary) ? { session_cap: capStopOf(session.summary) } : {}) } : {}),
      ...(planChainMode ? { plan_chain: planChainMode } : {}),
      ...(sessionResume ? { session_resume: sessionResume } : {}),
      ...(coverage ? { coverage_resume: coverage } : {}), ...(claimAbsent ? { claim_absent: claimAbsent } : {}),
      ...(patch ? { patch: { status: patch.status, seconds: Math.round(patchS * 10) / 10, calls: patch.calls, applied: patch.applied, refused: patch.refused, restored: patch.restored, usd: patch.usd, log: patch.log, ...(patch.check ? { check: patch.check } : {}) } } : {}),
      ...(tournament ? { tournament } : {}),
      ...(noRegression ? { no_regression: noRegression } : {}),
      ...(neverStop ? { never_stop: [neverStop] } : {}),
      ...(fragmentWriterOn() && session.summary ? { summary_tail: session.summary.slice(-1500) } : {}), // the release-note writer reads the final message
    };

    if (exit !== "error") return { status: "completed", data };

    const stderrTail = session.stderrTail ?? ""; mkdirSync(ctx.runDir, { recursive: true }); const stderrPath = join(ctx.runDir, `${iterationId}.stderr.log`); writeFileSync(stderrPath, stderrTail, "utf8");
    data.stderr_path = stderrPath;

    return { status: "failed", reason: classifyExitCause(session.exit, false, undefined, stderrTail, ctx.provider), data };
  },
};
export const stage = implementStage;
