// Loki 10 state machine (ENGINE.md section 4): stage table, Plan || Wall, optional() loader,
// stage limits, global cap, resume from the last completed stage. Siblings arrive only through
// RunContext; stages come from ./stages/<name>.ts.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fold } from "./events.ts";
import { REGISTRY } from "./registry.ts";
import { backstopS, DEEP_IMPLEMENT_LIMIT_S, MAX_FIX_ROUNDS, STAGE_BUDGETS } from "./types.ts";
import type { EventEnvelope, RunContext, Stage, StageName, StageResult } from "./types.ts";
type Obj = Record<string, unknown>;
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
  /** Events of an earlier attempt of this run (resume). */
  prior?: EventEnvelope[];
  /** Run start in epoch ms; the cap counts from here. Defaults to run.started ts of prior, else now. */
  startedAtMs?: number;
}
export interface MachineResult {
  outputs: Partial<Record<StageName, Obj>>;
  capHit: boolean;
  /** Set when the run ended before seal (intake failure). */
  stopped: string | null;
  /** True when prior already held run.completed: nothing ran. */
  final: boolean;
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
const earlyExit = (d: Obj): boolean => d.already_satisfied === true || d.exit === "spec_conflict";
/** After a cap or limit kill, how long the machine waits for the aborted stage to settle before moving on. */
const KILL_GRACE_MS = 2000;
export function softCapS(capS: number): number { const plain = (capS * 14) / 15, budget = backstopS(capS) - ((STAGE_BUDGETS.commit.targetS ?? 0) + (STAGE_BUDGETS.seal.targetS ?? 0) + KILL_GRACE_MS / 1000); return budget >= 0 ? Math.min(plain, budget) : plain; } // tightens 14/15 of capS so commit+seal's tail fits before the backstop, else the plain point (E-67 finding 1 follow-up 2)
export async function runMachine(ctx: RunContext, opts: MachineOptions = {}): Promise<MachineResult> {
  const load = opts.load ?? defaultLoader(opts.stagesDir ?? join(import.meta.dir, "stages"));
  const prior = opts.prior ?? [];
  const folded = fold(prior);
  const outputs: Partial<Record<StageName, Obj>> = {};
  for (const e of prior) if (e.type === "stage.completed" && e.stage) outputs[e.stage as StageName] = e.data;
  const done = new Set(folded.completed);
  let capHit = false;
  if (folded.run.completed) return { outputs, capHit, stopped: null, final: true };
  const startedTs = folded.run.started ? Date.parse(folded.run.started.ts) : NaN;
  const startMs = opts.startedAtMs ?? (Number.isFinite(startedTs) ? startedTs : ctx.clock.now());
  const capAtMs = startMs + softCapS(ctx.capS) * 1000; // 14/15 of capS for the default/deep caps; see softCapS above
  const capCtl = new AbortController();
  const capTimer = setTimeout(() => capCtl.abort(), Math.max(0, capAtMs - ctx.clock.now()));
  const sctx: MachineRunContext = { ...ctx, outputs: () => ({ ...outputs }), capHit: () => capHit };
  const elapsedS = (): number => (ctx.clock.now() - startMs) / 1000;
  // The timer alone misses a cap already past on resume (it fires a tick later), so check the clock too.
  const capReached = (): boolean => capCtl.signal.aborted || ctx.clock.now() >= capAtMs;
  /** Marks the cap; emits cap.hit once per run even when a parallel group is killed. */
  const markCap = (name: StageName): void => {
    if (capHit) return;
    capHit = true;
    ctx.emit("cap.hit", name, { elapsed_s: elapsedS() });
  };
  /** Runs one stage; returns its result, or null when it was skipped. */
  const runStage = async (name: StageName, underCap: boolean): Promise<StageResult | null> => {
    const st = await load(name);
    if (!st) {
      ctx.emit("stage.skipped", name, { reason: "module not present" });
      return null;
    }
    if (underCap && capReached()) { markCap(name); return null; }
    const limitS = name === "implement" && ctx.deep ? DEEP_IMPLEMENT_LIMIT_S : st.limitS;
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
    }
    const res = r as StageResult;
    if (res.status === "completed") {
      outputs[name] = res.data;
      ctx.emit("stage.completed", name, { ...res.data, duration_s: dur() });
    } else if (res.status === "skipped") {
      ctx.emit("stage.skipped", name, { ...res.data, reason: res.reason ?? "skipped by stage" });
    } else {
      ctx.emit("stage.failed", name, { ...res.data, duration_s: dur(), reason: res.reason ?? "failed" });
    }
    return res;
  };
  /** True when the flow must jump to the tail (commit, seal, pr). */
  const mustJump = (name: StageName, r: StageResult | null): boolean => {
    if (capHit) return true;
    if (!r) return false;
    if (r.status === "failed") return name !== "plan" && name !== "wall" && name !== "verify" && name !== "fix";
    return r.status === "completed" && earlyExit(r.data);
  };
  try {
    let jumped = false;
    for (const step of opts.flow ?? FLOW) {
      const group = (typeof step === "string" ? [step] : [...step]) as StageName[];
      const todo = group.filter((n) => !done.has(n));
      if (todo.length === 0) continue;
      const isTail = todo.every((n) => TAIL.includes(n));
      if (jumped && !isTail) continue;
      if (!isTail && capReached()) markCap(todo[0] as StageName);
      if (capHit && !isTail) { jumped = true; continue; }
      const results = await Promise.all(todo.map((n) => runStage(n, !isTail)));
      if (todo[0] === "intake" && results[0]?.status === "failed") {
        return { outputs, capHit, stopped: "intake failed", final: false };
      }
      if (todo.some((n, i) => mustJump(n, results[i] ?? null))) { jumped = true; continue; }
      // ponytail: on resume a completed verify skips the fix loop; resume mid-fix if it matters
      if (todo[0] === "verify") {
        for (let round = 1; round <= MAX_FIX_ROUNDS && hasFailures(outputs.verify); round++) {
          const fx = await runStage("fix", true);
          if (!fx || mustJump("fix", fx)) break;
          const v = await runStage("verify", true);
          if (mustJump("verify", v)) break;
        }
        if (capHit) jumped = true;
      }
    }
  } finally {
    clearTimeout(capTimer);
  }
  return { outputs, capHit, stopped: null, final: false };
}
