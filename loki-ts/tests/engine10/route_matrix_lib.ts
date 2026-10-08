// Semantic L1 guard for ROUTER-1: runs plan, implement, fix and the machine's stall path through fake sessions with
// LOKI_ROUTER=1 and records every model handed to sessions.run. Invariant: a session never starts below the run's model
// unless a VALID Opus route record (plan.units, every unit haiku with a reason, nothing NOT PROVEN) names haiku, and a
// unit never moves down within a run. It judges behavior, not source text, so it takes the source root as a parameter and
// a mutation test can point it at a mutated copy of src/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const H = "claude-haiku-5-5", S = "claude-sonnet-5-5", O = "claude-opus-5-5", LABEL = "claude (provider default)";
const RUNS = [H, S, O, LABEL];
// Independent of the code under test: a mutated model_rank.ts cannot hide a violation from this ranking.
const rank = (m: string): number => (/haiku/i.test(m) ? 0 : /sonnet/i.test(m) ? 1 : /opus/i.test(m) ? 2 : 3);
const floorRank = (run: string): number => (run === LABEL ? 1 : rank(run));

const unit = (executor: string, reason = "mechanical rename"): Record<string, unknown> => ({ id: "u1", kind: "impl", executor, reason });
const PLANS: { name: string; plan: Record<string, unknown> | undefined; valid: boolean }[] = [
  { name: "none", plan: undefined, valid: false },
  { name: "haiku-assigned", plan: { units: [unit("haiku")], route_not_proven: [] }, valid: true },
  { name: "invalid:no-reason", plan: { units: [unit("haiku", "")], route_not_proven: [] }, valid: false },
  { name: "invalid:sentinel", plan: { units: [unit("sonnet", "invalid unit route")], route_not_proven: [] }, valid: false },
  { name: "invalid:not-proven", plan: { units: [unit("haiku")], route_not_proven: ["u1"] }, valid: false },
  { name: "invalid:empty", plan: { units: [], route_not_proven: [] }, valid: false },
  { name: "invalid:mixed", plan: { units: [unit("haiku"), unit("sonnet")], route_not_proven: [] }, valid: false },
  { name: "invalid:legacy-route", plan: { route: { executor: "haiku", source: "advisor", reason: "r" } }, valid: false },
];

type Call = { stage: string; model: string | undefined };
interface Rig { calls: Call[]; events: { type: string; data: Record<string, unknown> }[] }
type Outputs = Record<string, Record<string, unknown> | undefined>;
type Res = { exit: number; markers: Record<string, unknown>; durationS: number; killed: boolean };
const DONE: Res = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const ESC: Res = { ...DONE, markers: { ...DONE.markers, escalate: "advisor: too subtle" } };
const CONFLICT: Res = { ...DONE, markers: { done: false, alreadyDone: null, specConflict: "spec says A and B" } };
const KILLED: Res = { ...DONE, exit: 124, killed: true };
const CRASH: Res = { ...DONE, exit: 1 };

function makeCtx(run: string, outputs: () => Outputs, results: Res[], rig: Rig, runDir: string, onRun?: () => void) {
  return {
    runId: "e10-mx", repoDir: join(runDir, "repo"), runDir, baseSha: "x", branch: "b", provider: "claude", model: run, deep: false, capS: 900,
    emit: (type: string, _s: unknown, data: Record<string, unknown>) => { rig.events.push({ type, data }); },
    sessions: { async run(o: { stage: string; model?: string }) { rig.calls.push({ stage: o.stage, model: o.model }); onRun?.(); return results[Math.min(rig.calls.length - 1, results.length - 1)]!; } },
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 }, outputs,
  };
}

export async function matrixViolations(root: string): Promise<string[]> {
  const v: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_MODEL_DEVELOPMENT", "MX_ENV_FILE", "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_E10_PLAN", "LOKI_E10_CASCADE", "LOKI_NO_BROWSER", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env["LOKI_ROUTER"] = "1"; process.env["LOKI_NO_BROWSER"] = "1";
  const dir = mkdtempSync(join(tmpdir(), "loki-mx-"));
  const ac = new AbortController();
  const imp = (await import(join(root, "engine10/stages/implement.ts"))) as { implementStage: { run(c: unknown, s: AbortSignal): Promise<{ data: Record<string, unknown> }> } };
  const fixm = (await import(join(root, "engine10/stages/fix.ts"))) as { fixStage: { run(c: unknown, s: AbortSignal): Promise<{ data: Record<string, unknown>; status: string }> } };
  const plm = (await import(join(root, "engine10/stages/plan.ts"))) as { planStage: { run(c: unknown, s: AbortSignal): Promise<unknown> } };
  const mach = (await import(join(root, "engine10/machine.ts"))) as { runMachine(c: unknown, o: { load: (n: string) => Promise<unknown> }): Promise<unknown> };

  // Judge one recorded sequence: no call below the run floor without a valid record, and a unit never moves down.
  const judge = (where: string, run: string, valid: boolean, calls: Call[], extra: string[] = []): void => {
    let prev = -1;
    for (const c of calls) {
      const r = c.model === undefined ? floorRank(run) : rank(c.model);
      if (r < floorRank(run) && !valid) v.push(`${where}: ${c.stage} ran ${c.model} below ${run} with no valid route record`);
      if (c.stage !== "plan" && r < prev) v.push(`${where}: ${c.stage} moved down to ${c.model ?? run}`);
      if (c.stage !== "plan") prev = Math.max(prev, r);
    }
    for (const e of extra) v.push(`${where}: ${e}`);
  };
  // The recorded model (data.model / route_model) feeds the next round's pin, so it must equal what actually ran.
  const honest = (run: string, calls: Call[], recorded: unknown): string[] => {
    if (typeof recorded !== "string" || calls.length === 0) return [];
    const ran = calls[calls.length - 1]!.model, a = recorded === LABEL ? floorRank(run) : rank(recorded), b = ran === undefined ? floorRank(run) : rank(ran);
    return a === b ? [] : [`recorded model ${recorded} but the session ran ${ran ?? run}`];
  };
  const groupsOf = (kind: string): { signature: string; count: number; sample: string }[] =>
    kind === "lint-only" ? [{ signature: "lint:eslint", count: 1, sample: "s" }] : [{ signature: "AssertionError: x", count: 1, sample: "s" }];

  try {
    // 1. plan: an Opus pin is an upward move and allowed; anything below the run model is red.
    for (const run of RUNS) for (const adv of ["on", "off"]) {
      process.env["LOKI_E10_PLAN"] = "always"; if (adv === "off") process.env["LOKI_ROUTER_ADVISOR"] = "off"; else delete process.env["LOKI_ROUTER_ADVISOR"];
      const rig: Rig = { calls: [], events: [] };
      const pdir = join(dir, `plan-${rig.calls.length}-${run.length}-${adv}`);
      const ctx = makeCtx(run, () => ({ intake: { task: "fix the bug" } }), [DONE], rig, pdir, () => { writeFileSync(join(pdir, "plan-scope.json"), JSON.stringify({ units: [unit("haiku")] })); });
      const { mkdirSync } = await import("node:fs"); mkdirSync(pdir, { recursive: true });
      await plm.planStage.run(ctx, ac.signal);
      judge(`plan run=${run} advisor=${adv}`, run, false, rig.calls);
    }
    delete process.env["LOKI_E10_PLAN"]; delete process.env["LOKI_ROUTER_ADVISOR"];

    // 2. implement: route record x run model x outcome sequence.
    const SEQS: [string, Res[]][] = [["done", [DONE]], ["escalate", [ESC, DONE]], ["conflict", [CONFLICT, CONFLICT, CONFLICT]], ["limit_kill", [KILLED, DONE]], ["crash", [CRASH]]];
    for (const run of RUNS) for (const p of PLANS) for (const [sn, seq] of SEQS) {
      const rig: Rig = { calls: [], events: [] };
      const ctx = makeCtx(run, () => ({ intake: { task: "t" }, ...(p.plan ? { plan: p.plan } : {}) }), seq, rig, dir);
      const ir = await imp.implementStage.run(ctx, ac.signal);
      judge(`implement run=${run} route=${p.name} seq=${sn}`, run, p.valid, rig.calls, honest(run, rig.calls, ir.data["route_model"]));
    }
    // positive control: the router must still honor a valid record (a guard that passes because routing is dead proves nothing).
    {
      const rig: Rig = { calls: [], events: [] };
      await imp.implementStage.run(makeCtx(S, () => ({ intake: { task: "t" }, plan: PLANS[1]!.plan }), [DONE], rig, dir), ac.signal);
      if (rank(rig.calls[0]?.model ?? S) !== 0) v.push("implement: a valid haiku route record was not honored (positive control)");
    }

    // 3. fix: failure kind x prior state x route record x run model, including prior.fix.model carry-over.
    const PRIORS: [string, (g: string) => Outputs][] = [
      ["first", () => ({})],
      ["carried-haiku-same-sig", (sig) => ({ fix: { round: 1, signatures: sig, model: H } })],
      ["carried-haiku-other-sig", () => ({ fix: { round: 1, signatures: "other", model: H } })],
      ["implement-route-haiku", () => ({ implement: { route_model: H, exit: "done" } })],
      ["limit_kill", () => ({ implement: { route_model: H, exit: "killed" } })],
      ["stall", (sig) => ({ fix: { round: 2, signatures: sig, model: H, stall_escalated: true, stall_pending: true } })],
    ];
    for (const run of RUNS) for (const p of PLANS) for (const kind of ["code-owned", "lint-only"]) for (const [pn, mk] of PRIORS) {
      const groups = groupsOf(kind), sig = groups.map((g) => g.signature).sort().join("|");
      const rig: Rig = { calls: [], events: [] };
      const prior = mk(sig);
      const ctx = makeCtx(run, () => ({ intake: { task: "t" }, verify: { failures_grouped: groups }, ...(p.plan ? { plan: p.plan } : {}), ...prior }), [DONE], rig, dir);
      const fr = await fixm.fixStage.run(ctx, ac.signal);
      const where = `fix run=${run} route=${p.name} kind=${kind} prior=${pn}`;
      judge(where, run, p.valid, rig.calls, honest(run, rig.calls, fr.data["model"]));
      // B4: a haiku unit with a code-owned failure is redone on sonnet in the first fix round, not retried on haiku.
      if (p.valid && kind === "code-owned" && pn === "implement-route-haiku" && rank(rig.calls[0]?.model ?? run) !== 1) v.push(`${where}: haiku unit with a code-owned failure was not redone on sonnet`);
    }

    // 3b. real round-1 outputs carried into round 2 (a wrong recorded model poisons the next pin).
    for (const run of RUNS) for (const p of PLANS) for (const same of [true, false]) for (const esc of [false, true]) for (const kind of ["code-owned", "lint-only"]) {
      const outputs: Outputs = { intake: { task: "t" }, ...(p.plan ? { plan: p.plan } : {}) };
      const rig: Rig = { calls: [], events: [] };
      const ctx = makeCtx(run, () => ({ ...outputs }), esc ? [ESC, DONE] : [DONE], rig, dir);
      outputs["implement"] = (await imp.implementStage.run(ctx, ac.signal)).data;
      outputs["verify"] = { failures_grouped: groupsOf(kind) };
      outputs["fix"] = (await fixm.fixStage.run(ctx, ac.signal)).data;
      if (!same) outputs["verify"] = { failures_grouped: [{ signature: kind === "lint-only" ? "lint:other" : "other", count: 1, sample: "s" }] };
      const r2 = await fixm.fixStage.run(ctx, ac.signal);
      judge(`fix round2 run=${run} route=${p.name} ${same ? "repeat" : "new-failure"} implement-escalated=${esc} kind=${kind}`, run, p.valid, rig.calls, honest(run, rig.calls, r2.data["model"]));
    }

    // 4. machine: a stalled verify loop with real implement and fix stages. Lint-only never climbs or emits route.escalated.
    for (const run of RUNS) for (const p of PLANS) for (const kind of ["code-owned", "lint-only"]) {
      const rig: Rig = { calls: [], events: [] };
      const stub = (name: string, fn?: (c: { outputs(): Outputs }) => Promise<unknown>) => ({ name, targetS: 1, limitS: 5, run: fn ?? (async () => ({ status: "completed", data: name === "plan" && p.plan ? p.plan : {} })) });
      const groups = groupsOf(kind);
      const real: Record<string, unknown> = { implement: imp.implementStage, fix: fixm.fixStage };
      const load = async (n: string): Promise<unknown> => real[n] ?? (n === "verify" ? stub("verify", async () => ({ status: "completed", data: { failures_grouped: groups } })) : stub(n));
      const ctx = makeCtx(run, () => ({}), [DONE], rig, dir);
      await mach.runMachine(ctx, { load });
      const stallEvents = rig.events.filter((e) => e.type === "route.escalated" && e.data["trigger"] === "stall");
      const fixCalls = rig.calls.filter((c) => c.stage === "fix").length;
      judge(`machine run=${run} route=${p.name} kind=${kind}`, run, p.valid, rig.calls,
        kind === "lint-only" && (stallEvents.length > 0 || fixCalls !== 2) ? ["lint-only stall climbed or granted an extra round"] : []);
    }

    // 5. override axis: LOKI_MODEL_OVERRIDE or LOKI_CLAUDE_MODEL_DEVELOPMENT is the user bypass. No path may hand a model to a session
    // (every router pin shows up as a defined model), and the child env must carry the user's model, never a router pin.
    const sess = (await import(join(root, "engine10/session.ts"))) as { createSessionRunner(c: unknown): { run(o: unknown): Promise<unknown> } };
    for (const ov of ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT"]) {
      delete process.env["LOKI_MODEL_OVERRIDE"]; delete process.env["LOKI_CLAUDE_MODEL_DEVELOPMENT"];
      process.env[ov] = O;
      const none = (where: string, calls: Call[]): void => { for (const c of calls) if (c.model !== undefined) v.push(`override ${ov}: ${where}: ${c.stage} was pinned to ${c.model} over the user model`); };
      for (const run of RUNS) for (const p of PLANS) {
        for (const [sn, seq] of SEQS) {
          const rig: Rig = { calls: [], events: [] };
          const ir = await imp.implementStage.run(makeCtx(run, () => ({ intake: { task: "t" }, ...(p.plan ? { plan: p.plan } : {}) }), seq, rig, dir), ac.signal);
          none(`implement run=${run} route=${p.name} seq=${sn}`, rig.calls);
          const rm = ir.data["route_model"];
          if (typeof rm === "string" && rank(rm) < floorRank(run)) v.push(`override ${ov}: implement run=${run} route=${p.name} seq=${sn}: recorded route_model ${rm} below the run model`);
        }
        for (const kind of ["code-owned", "lint-only"]) for (const [pn, mk] of PRIORS) {
          const groups = groupsOf(kind), sig = groups.map((g) => g.signature).sort().join("|");
          const rig: Rig = { calls: [], events: [] };
          const prior = mk(sig);
          await fixm.fixStage.run(makeCtx(run, () => ({ intake: { task: "t" }, verify: { failures_grouped: groups }, ...(p.plan ? { plan: p.plan } : {}), ...prior }), [DONE], rig, dir), ac.signal);
          none(`fix run=${run} route=${p.name} kind=${kind} prior=${pn}`, rig.calls);
        }
        for (const kind of ["code-owned", "lint-only"]) {
          const rig: Rig = { calls: [], events: [] };
          const stub = (name: string, fn?: (c: { outputs(): Outputs }) => Promise<unknown>) => ({ name, targetS: 1, limitS: 5, run: fn ?? (async () => ({ status: "completed", data: name === "plan" && p.plan ? p.plan : {} })) });
          const groups = groupsOf(kind);
          const real: Record<string, unknown> = { implement: imp.implementStage, fix: fixm.fixStage };
          const load = async (n: string): Promise<unknown> => real[n] ?? (n === "verify" ? stub("verify", async () => ({ status: "completed", data: { failures_grouped: groups } })) : stub(n));
          await mach.runMachine(makeCtx(run, () => ({}), [DONE], rig, dir), { load });
          none(`machine run=${run} route=${p.name} kind=${kind}`, rig.calls);
        }
      }
      process.env["LOKI_E10_PLAN"] = "always"; process.env["LOKI_ROUTER_ADVISOR"] = "off";
      for (const run of RUNS) {
        const { mkdirSync } = await import("node:fs");
        const rig: Rig = { calls: [], events: [] }, pdir = join(dir, `plan-ov-${ov}-${run.length}`);
        mkdirSync(pdir, { recursive: true });
        await plm.planStage.run(makeCtx(run, () => ({ intake: { task: "fix the bug" } }), [DONE], rig, pdir, () => { writeFileSync(join(pdir, "plan-scope.json"), JSON.stringify({ units: [unit("haiku")] })); }), ac.signal);
        none(`plan run=${run}`, rig.calls);
      }
      delete process.env["LOKI_E10_PLAN"]; delete process.env["LOKI_ROUTER_ADVISOR"];
      // The session runner itself: a router-originated haiku pin (or any pin) must not overwrite the user's model in the child env.
      for (const pin of [H, S, "opus"]) for (const advisor of [undefined, { available: false }]) {
        const f = join(dir, `env-${ov}-${pin}-${advisor ? "noadv" : "adv"}.txt`);
        process.env["MX_ENV_FILE"] = f;
        await sess.createSessionRunner({ provider: "claude", ...(advisor ? { advisor } : {}), childCommand: ["bash", ["-c", `env > "$MX_ENV_FILE"`]] })
          .run({ stage: "implement", brief: "b", tier: "development", iterationId: "e10-mx-ov", limitS: 20, signal: ac.signal, model: pin });
        const got = /^LOKI_CLAUDE_MODEL_DEVELOPMENT=(.*)$/m.exec(readFileSync(f, "utf8"))?.[1];
        if (got !== O) v.push(`override ${ov}: session child env LOKI_CLAUDE_MODEL_DEVELOPMENT=${got} for pin ${pin}, expected the user model ${O}`);
      }
      delete process.env["MX_ENV_FILE"];
    }
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
  return v;
}
