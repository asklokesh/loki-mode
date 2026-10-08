// Loki 10 state machine (ENGINE.md section 4): stage table, Plan || Wall, optional() loader,
// stage limits, global cap, stop reasons (stalled, fatal). Siblings arrive only through
// RunContext; stages come from ./stages/<name>.ts.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { hooks } from "./hooks.ts";
import { classifyFailure } from "../runner/retry_class.ts";
import { REGISTRY } from "./registry.ts";
import { timeBudgetNote } from "../util/run_cap.ts"; import { FINISH_LINE } from "../e10ext/context.ts"; import { restoreReadOnly, type ReadOnlyFile } from "./stages/implement.ts"; import { stallClimb } from "../runner/router/unit_model.ts";
import { backstopS, DEEP_IMPLEMENT_LIMIT_S, MAX_FIX_ROUNDS, STAGE_BUDGETS } from "./types.ts";
import type { Obj, RunContext, Stage, StageName, StageResult } from "./types.ts";

/** WC-01b: optional split halves a wall stage may carry (see wall.ts `stage.split`). */
interface WallSplit {
  author(ctx: RunContext, signal: AbortSignal): Promise<{ kind: string } & Record<string, unknown>>;
  install(ctx: RunContext, a: never, baseDir: string): StageResult;
}
const wallConcurrent = (): boolean => process.env.LOKI_E10_WALL_CONCURRENT === "1";
/** Run order. An array is a parallel group. fix is driven by the verify loop, deep is detached (supervisor). */
export const FLOW: readonly (StageName | readonly StageName[])[] = [
  "intake", ["plan", "wall"], "implement", "verify", "commit", "seal", "pr",
];
/** Stages that still run after the cap or an early exit. */
const TAIL: readonly StageName[] = ["commit", "seal", "pr"];
/** Local extension of RunContext (not in types.ts): lets seal and pr see that the cap fired. */
export interface MachineRunContext extends RunContext {
  capHit(): boolean;
}
export interface MachineOptions {
  /** Resolves a stage; default imports <stagesDir>/<name>.ts and takes its `stage` (or default) export. */
  load?: (name: StageName) => Promise<Stage | null>;
  stagesDir?: string;
  /** Run order override; the worker passes FLOW without "pr" (Rule of Two: pr runs in the supervisor). */
  flow?: typeof FLOW;
  /** FC-21b: called once after plan||wall (or wall alone); returns the sized cap in seconds. */
  resize?: () => number;
  /** Run start in epoch ms; the cap counts from here. Defaults to now. */
  startedAtMs?: number;
}
export interface MachineResult {
  outputs: Partial<Record<StageName, Obj>>;
  capHit: boolean;
  /** Why the run ended early: "intake failed", "stalled" (same failures 3 verifies running), "fatal:<auth|quota_exhausted>". */
  stopped: string | null;
}
/** Dynamically imports an optional module. Absent file: null. A present file that fails to load throws. */
export async function optional<T = Record<string, unknown>>(path: string): Promise<T | null> {
  const abs = isAbsolute(path) ? path : join(import.meta.dir, path);
  // ponytail: file-existence check, so a module that fails to load is never mistaken for an absent one
  if (!existsSync(abs)) return null;
  return (await import(abs)) as T;
}
function defaultLoader(dir: string) {
  return async (name: StageName): Promise<Stage | null> => {
    const reg = dir === join(import.meta.dir, "stages") ? REGISTRY[`./stages/${name}.ts`] : undefined;
    const mod = (reg ? await reg() : await optional(join(dir, `${name}.ts`))) as { stage?: Stage; default?: Stage } | null;
    return mod ? (mod.stage ?? mod.default ?? null) : null;
  };
}
const hasFailures = (d: Obj | undefined): boolean => Array.isArray(d?.failures_grouped) && d.failures_grouped.length > 0;
// Only already_satisfied short-circuits to the tail. spec_conflict must still run verify and
// the fix loop (E-98b); seal.ts:110 already reads implement.exit off outputs for the verdict.
const earlyExit = (d: Obj): boolean => d.already_satisfied === true;
/** After a cap or limit kill, how long the machine waits for the aborted stage to settle before moving on. */
const KILL_GRACE_MS = 2000;
export function softCapS(capS: number): number { const plain = (capS * 14) / 15, budget = backstopS(capS) - ((STAGE_BUDGETS.commit.targetS ?? 0) + (STAGE_BUDGETS.seal.targetS ?? 0) + KILL_GRACE_MS / 1000 + 2); return Math.max(0, Math.min(plain, budget)); } // tightens 14/15 of capS so commit+seal's tail (plus a 2s margin: this clock starts after worker boot, the backstop's starts at spawn) fits before the backstop; when the tail can never fit at all (budget < 0), 0 still maximizes the gap to the backstop instead of the old plain-point fallback, which left as little as 0.17s to seal (E-67 round 5 REJECT finding 1)
export async function runMachine(ctx: RunContext, opts: MachineOptions = {}): Promise<MachineResult> {
  const load = opts.load ?? defaultLoader(opts.stagesDir ?? join(import.meta.dir, "stages"));
  const outputs: Partial<Record<StageName, Obj>> = {};
  let capHit = false, fatal: string | null = null;
  const startMs = opts.startedAtMs ?? ctx.clock.now();
  if (ctx.startedAtMs === undefined) ctx.startedAtMs = startMs;
  const timeline: NonNullable<typeof ctx.timeline> = ctx.timeline ??= [];
  let capAtMs = startMs + softCapS(ctx.capS) * 1000; // 14/15 of capS for the default/deep caps; see softCapS above
  const capCtl = new AbortController();
  let capTimer = setTimeout(() => capCtl.abort(), Math.max(0, capAtMs - ctx.clock.now()));
  let implementStartMs: number | null = null;
  const withTimeNote = (brief: string, limitS: number): string => brief.endsWith(FINISH_LINE) ? `${brief.slice(0, -FINISH_LINE.length)}${timeBudgetNote(limitS)}\n\n${FINISH_LINE}` : `${brief}\n\n${timeBudgetNote(limitS)}`;
  const sessions = { run: async (o: Parameters<typeof ctx.sessions.run>[0]) => {
    const left = implementStartMs === null ? Infinity : Math.max(1, implementBudgetS - (ctx.clock.now() - implementStartMs) / 1000), imp = o.stage === "implement" ? { ...o, limitS: Math.min(Math.max(o.limitS, implementBudgetS), left) } : o, r = await ctx.sessions.run(imp.stage === "implement" && typeof imp.brief === "string" && imp.limitS > 0 ? { ...imp, brief: withTimeNote(imp.brief, imp.limitS) } : imp); // FC-21 (c): the time note goes after the byte-stable prefix and body; FC-21b A2: a resumed session gets only the budget left, and the note sits BEFORE the closing FINISH_LINE
    const t = (r as { stderrTail?: string }).stderrTail ?? "", sdk = /\[sdk-loop error: [^\n]*?(?:(Failed to authenticate|API key is invalid|Not logged in)|(credit balance))/.exec(t); // the SDK's real wording, matched only on its own error line
    const k = r.exit === 0 ? null : sdk ? (sdk[1] ? "auth" : "quota_exhausted") : classifyFailure(t).reason; if (k === "auth" || k === "quota_exhausted") fatal ??= `fatal:${k}`; if (ctx.overCap?.()) capCtl.abort(); // D60-5: dollar cap reached, stop the running stage too
    return r;
  } };
  const sctx: MachineRunContext = { ...ctx, sessions, implementLeftS: () => implementStartMs === null ? Infinity : implementBudgetS - (ctx.clock.now() - implementStartMs) / 1000, outputs: () => ({ ...outputs }), capHit: () => capHit };
  const elapsedS = (): number => (ctx.clock.now() - startMs) / 1000;
  /** FC-21b: the one post-plan resize. Never below the current cap or the elapsed time; recomputes capAtMs and re-arms the soft-cap timer. */
  const applyResize = (proposedS: number): void => {
    if (!(proposedS > ctx.capS) || proposedS <= elapsedS() || capCtl.signal.aborted) return;
    ctx.capS = sctx.capS = proposedS; capAtMs = startMs + softCapS(proposedS) * 1000; clearTimeout(capTimer);
    capTimer = setTimeout(() => capCtl.abort(), Math.max(0, capAtMs - ctx.clock.now()));
    ctx.emit("cap.sized", null, { cap_s: proposedS });
  };
  // The timer alone can miss a cap that has just passed (it fires a tick later), so check the clock too.
  const capReached = (): boolean => capCtl.signal.aborted || ctx.clock.now() >= capAtMs || ctx.overCap?.() === true;
  /** Marks the cap; emits cap.hit once per run even when a parallel group is killed. */
  const markCap = (name: StageName): void => {
    if (capHit) return;
    capHit = true;
    ctx.emit("cap.hit", name, { elapsed_s: elapsedS() });
  };
  let implementBudgetS = 0; const implementLimitS = (floorS: number): number => Math.max(floorS, Math.floor(softCapS(ctx.capS) - elapsedS() - (STAGE_BUDGETS.verify.limitS ?? 0))); // leaves verify's window before the soft cap
  /** Runs one stage; returns its result, or null when it was skipped. */
  const runStage = async (name: StageName, underCap: boolean): Promise<StageResult | null> => {
    const st = await load(name);
    if (!st) {
      ctx.emit("stage.skipped", name, { reason: "module not present" });
      return null;
    }
    if (underCap && capReached()) { markCap(name); return null; }
    const limitS = name === "implement" ? (ctx.deep ? DEEP_IMPLEMENT_LIMIT_S : st.limitS >= STAGE_BUDGETS.implement.limitS ? implementLimitS(st.limitS) : st.limitS) : st.limitS; if (name === "implement") { implementBudgetS = limitS; implementStartMs = ctx.clock.now(); } // FC-19: implement gets the run budget left, not a fixed 480s
    ctx.emit("stage.started", name, { target_s: st.targetS, limit_s: limitS });
    const t0 = ctx.clock.now();
    const dur = (): number => (ctx.clock.now() - t0) / 1000;
    const ctl = new AbortController();
    let why: "limit" | "cap" | null = null;
    const kill = (w: "limit" | "cap"): void => { if (!why) { why = w; ctl.abort(); } };
    const limitTimer = setTimeout(() => kill("limit"), limitS * 1000);
    const onCap = (): void => kill("cap");
    if (underCap) {
      if (capCtl.signal.aborted) onCap();
      else capCtl.signal.addEventListener("abort", onCap);
    }
    const aborted = new Promise<null>((res) => ctl.signal.addEventListener("abort", () => res(null)));
    let r: StageResult | null;
    let p: Promise<StageResult> | undefined;
    try {
      p = st.run(sctx, ctl.signal);
      p.catch(() => {}); // a stage that rejects after being aborted is ignored
      r = ctl.signal.aborted ? null : await Promise.race([p, aborted]);
    } catch (err) {
      r = { status: "failed", data: {}, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(limitTimer);
      capCtl.signal.removeEventListener("abort", onCap);
    }
    if (why) {
      // Bounded grace so a killed stage is not still running when commit starts.
      if (why === "cap") markCap(name);
      if (p) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          p.then(() => {}, () => {}),
          new Promise<void>((res) => { graceTimer = setTimeout(res, KILL_GRACE_MS); }),
        ]);
        clearTimeout(graceTimer);
      }
      r = { status: "failed", data: {}, reason: why, killed: true };
      if (name === "implement" && why === "limit") { const ro = (outputs.wall?.readOnlyFiles as ReadOnlyFile[] | undefined) ?? [], reverted = restoreReadOnly(ro).map((f) => relative(ctx.repoDir, f)); outputs.implement = { exit: "killed", limit_s: limitS, elapsed_s: dur(), ...(reverted.length ? { tests_reverted: reverted } : {}) }; } // FC-21 (a): the work that exists is verified, and seal reads exit=killed so the verdict can never be VERIFIED
    }
    const res = r as StageResult;
    if (res.status === "completed") {
      const durationS = dur();
      res.data.duration_s = durationS; outputs[name] = res.data; // RECEIPT-TRUTH: seal sums time.stages from outputs, so every stage records its own duration_s here; same object (not a copy) because intake mutates its own data after the stage ends (D61-04)
      ctx.emit("stage.completed", name, { ...res.data, duration_s: durationS });
    } else if (res.status === "skipped") {
      ctx.emit("stage.skipped", name, { ...res.data, reason: res.reason ?? "skipped by stage" });
    } else {
      ctx.emit("stage.failed", name, { ...res.data, duration_s: dur(), reason: res.reason ?? "failed" });
    }
    timeline.push({ stage: name, startMs: t0, endMs: ctx.clock.now() });
    return res;
  };
  /** True when the flow must jump to the tail (commit, seal, pr). */
  const mustJump = (name: StageName, r: StageResult | null): boolean => {
    if (capHit) return true;
    if (!r) return false;
    if (r.status === "failed") return r.reason !== "limit" && name !== "plan" && name !== "wall" && name !== "verify" && name !== "fix";
    return r.status === "completed" && (earlyExit(r.data) || outputs.intake?.already_satisfied === true); // D61-04: a deferred already-done hit lands on intake's data mid-implement
  };
  // WC-01b: under LOKI_E10_WALL_CONCURRENT=1 the Wall is authored alongside plan and implement, then installed once before verify.
  interface WallJob { snap: Promise<string | null>; split: WallSplit; promise: Promise<{ kind: string } & Record<string, unknown>>; ctl: AbortController; aborted: Promise<null>; t0: number; timer: ReturnType<typeof setTimeout>; why: () => "limit" | "cap" | null; onCap: () => void; }
  let wallJob: WallJob | null = null;
  const closeWallJob = (j: WallJob): void => { clearTimeout(j.timer); capCtl.signal.removeEventListener("abort", j.onCap); };
  const dropSnap = (j: WallJob): void => { j.snap.then((d) => { if (d) rmSync(d, { recursive: true, force: true }); }, () => {}); };
  const abortWall = (): void => { const j = wallJob; wallJob = null; if (!j) return; closeWallJob(j); dropSnap(j); j.ctl.abort(); j.promise.catch(() => {}); }; // an abort before install installs nothing (E-54)
  const startWallAuthor = async (): Promise<boolean> => {
    if (!hooks.wall) return false;
    const st = await load("wall") as (Stage & { split?: WallSplit }) | null;
    if (!st?.split) return false;
    const ctl = new AbortController(); let why: "limit" | "cap" | null = null;
    const kill = (w: "limit" | "cap"): void => { if (!why) { why = w; ctl.abort(); } };
    const timer = setTimeout(() => kill("limit"), st.limitS * 1000), onCap = (): void => kill("cap");
    if (capCtl.signal.aborted) onCap(); else capCtl.signal.addEventListener("abort", onCap);
    const aborted = new Promise<null>((res) => ctl.signal.addEventListener("abort", () => res(null)));
    ctx.emit("stage.started", "wall", { target_s: st.targetS, limit_s: st.limitS });
    const promise = st.split.author(sctx, ctl.signal); promise.catch(() => {});
    wallJob = { snap: hooks.wall!.snapshotTree(ctx.repoDir, ctl.signal), split: st.split, promise, ctl, aborted, t0: ctx.clock.now(), timer, why: () => why, onCap };
    return true;
  };
  /** Awaits the author, then installs once against a pre-implement tree snapshot. Returns the wall result (also recorded in outputs/events). */
  const installWallJob = async (): Promise<void> => {
    const j = wallJob; if (!j) return; wallJob = null;
    const dur = (): number => (ctx.clock.now() - j.t0) / 1000;
    let r: StageResult;
    try {
      const a = await Promise.race([j.promise, j.aborted]); closeWallJob(j);
      if (!a) { dropSnap(j); r = { status: "failed", data: {}, reason: j.why() ?? "aborted", killed: true }; }
      else if (a.kind === "done") { dropSnap(j); r = a.result as StageResult; }
      else {
        const base = await j.snap; // unproven base run is never trusted: no snapshot, no install (nothing is dropped silently)
        if (!base) r = { status: "failed", data: {}, reason: "wall base snapshot unavailable: nothing installed" };
        else try {
          const w = a as unknown as { contents: Map<string, string>; targetDir: string };
          mkdirSync(join(base, relative(ctx.repoDir, w.targetDir)), { recursive: true });
          for (const [n, c] of w.contents) writeFileSync(join(base, relative(ctx.repoDir, w.targetDir), n), c, "utf8");
          r = j.split.install(sctx, a as never, base);
          const changed = hooks.wall!.changedSinceBase(ctx.repoDir, ctx.baseSha);
          if (r.status === "completed") {
            const touched = (changed ?? []).filter((f) => !f.startsWith(".loki/") && !f.startsWith(`${relative(ctx.repoDir, w.targetDir)}/loki_wall_`));
            // Fail closed: a base run that passes while implement changed files is not trusted as "already satisfied" (the base copy could still resolve into live code); verify decides.
            const unsure = changed === null || touched.length > 0, d = r.data, b0 = d.base_run as { pass?: number; fail?: number; not_run?: number };
            const green = typeof b0.pass === "number" && b0.pass > 0 && b0.fail === 0 && (b0.not_run ?? 0) === 0;
            // Fail closed for EVERY consumer (wall, discard.alreadySatisfied, seal wallGreenOnBase): an untrusted green base run is recorded as unproven (not_run), which all of them already refuse.
            const distrust = unsure && green;
            r = { ...r, data: { ...d, ...(distrust ? { already_satisfied: false, already_satisfied_distrusted: true } : {}), base_run: { ...b0, ...(distrust ? { not_run: 1, unproven: true } : {}), ...(changed === null || changed.some((f) => hooks.wall!.manifests.test(f)) ? { deps: "head" } : {}) } } };
          }
        } finally { rmSync(base, { recursive: true, force: true }); }
      }
    } catch (err) { r = { status: "failed", data: {}, reason: err instanceof Error ? err.message : String(err) }; }
    if (r.status === "completed") { outputs.wall = r.data; ctx.emit("stage.completed", "wall", { ...r.data, duration_s: dur() }); }
    else if (r.status === "skipped") ctx.emit("stage.skipped", "wall", { ...r.data, reason: r.reason ?? "skipped by stage" });
    else ctx.emit("stage.failed", "wall", { ...r.data, duration_s: dur(), reason: r.reason ?? "failed" });
  };
  try {
    let jumped = false, resized = false, stopped: string | null = null;
    const sigs: string[] = [];
    const sigOf = (d: Obj | undefined, r?: StageResult | null): string => r && r.status !== "completed" ? `verify-crashed-${sigs.length}` : JSON.stringify(((d?.failures_grouped ?? []) as { signature?: string }[]).map((g) => g.signature).sort()); // a crashed or timed-out verify leaves outputs.verify stale: record a marker that never matches (A-113b)
    for (const step of opts.flow ?? FLOW) {
      const group = (typeof step === "string" ? [step] : [...step]) as StageName[];
      let todo = group;
      if (wallJob && (jumped || capReached())) abortWall();
      const isTail = todo.every((n) => TAIL.includes(n));
      if (jumped && !isTail) continue;
      if (!isTail && capReached()) markCap(todo[0] as StageName);
      if (capHit && !isTail) { jumped = true; continue; }
      if (wallConcurrent() && todo.includes("plan") && todo.includes("wall") && !wallJob && await startWallAuthor()) todo = todo.filter((n) => n !== "wall"); // the Wall is now a background job, joined before verify
      if (wallJob && todo.includes("implement") && !(await (wallJob as WallJob).snap)) { const j = wallJob as WallJob, t0 = j.t0; abortWall(); ctx.emit("stage.failed", "wall", { duration_s: (ctx.clock.now() - t0) / 1000, reason: "wall base snapshot unavailable: nothing installed" }); } // the base copy must be complete before implement edits the tree; no copy means no Wall
      if (wallJob && todo[0] === "verify") {
        await installWallJob();
        if (outputs.wall?.already_satisfied === true) { jumped = true; continue; } // moved after implement by WC-01b; same exit as before
      }
      const results = await Promise.all(todo.map((n) => runStage(n, !isTail)));
      if (todo[0] === "intake" && results[0]?.status === "failed" && !capHit) {
        return { outputs, capHit, stopped: "intake failed" };
      }
      if (results[todo.indexOf("commit")]?.status === "failed") return { outputs: { ...outputs, commit: { failed: true } }, capHit, stopped: "commit failed" }; // A-104b r2: a failed commit never advances to seal
      if (opts.resize && !resized && (todo.includes("plan") || todo.includes("wall"))) { resized = true; try { applyResize(opts.resize()); } catch { /* an unreadable plan scope keeps the current cap */ } }
      if (fatal) { stopped = fatal; jumped = true; continue; }
      if (outputs.plan?.intent_declined === true) return { outputs, capHit, stopped: "intent declined" }; // T3: user answered n at the intent card
      if (todo.some((n, i) => mustJump(n, results[i] ?? null))) { jumped = true; continue; }
      if (todo[0] === "verify") {
        sigs.push(sigOf(outputs.verify, results[0]));
        let extraRounds = 0; // ROUTER-1 R1-13: one extra fix round on the next rung before STALLED
        for (let round = 1; round <= MAX_FIX_ROUNDS + extraRounds && hasFailures(outputs.verify); round++) {
          const fx = await runStage("fix", true);
          if (!fx || mustJump("fix", fx) || fatal) break;
          const v = await runStage("verify", true);
          sigs.push(sigOf(outputs.verify, v));
          if (mustJump("verify", v)) break;
          if (hasFailures(outputs.verify) && sigs.length >= 3 && sigs.slice(-3).every((x) => x === sigs[sigs.length - 1])) {
            // A stall may climb once, only on a code-owned failure (a lint-only or harness-owned stall is unchanged); the same routedFix decides here and in the fix stage.
            const up = stallClimb(ctx.model, outputs, sigs[sigs.length - 1] ?? "");
            if (up) {
              outputs.fix = { ...outputs.fix, stall_escalated: true, stall_pending: true }; extraRounds = 1;
              ctx.emit("route.escalated", "fix", { ...up });
              continue;
            }
            stopped = "stalled"; break;
          }
        }
        if (fatal) { stopped = fatal; jumped = true; }
        if (capHit) jumped = true;
      }
    }
    return { outputs, capHit, stopped };
  } finally {
    abortWall();
    clearTimeout(capTimer);
  }
}
