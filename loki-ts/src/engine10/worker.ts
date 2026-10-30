// Loki 10 worker (P2, ENGINE.md 6): the token-withheld process that runs intake..seal. It never writes events.jsonl; each event is one JSON line {type, stage, data} on stdout, and the supervisor validates, stamps seq and appends. Its own diagnostics go to stderr.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "./events.ts";
import { hooks, type StageCapability } from "./hooks.ts";
import { eventsRelPath } from "../util/engine_origin.ts";
import { GITHUB_TOKEN_VARS, SENTINEL_PREFIX } from "../util/credential_env.ts";
import { costTotalsOf, liveArchivedCosts, sumRunCosts, UNMETERED } from "./cost.ts"; import { childSpendDelta, sealedRunCost } from "../util/child_ledger.ts";
import { capMeter, type BudgetCrossing } from "../e10ext/budget_cap.ts";
import { resizeCap } from "../util/run_cap.ts"; import { loadProjectApi } from "../project_model/resolve.ts"; import { parseCapUsd } from "../e10ext/budget_cap.ts";
import { FLOW, runMachine } from "./machine.ts";
import { withFailover, type FailoverRecord } from "../runner/provider_failover.ts";
import { cancelSessions, createSessionRunner, resolveModel, type EmitFn } from "./session.ts";
import { RealTestMapProvider } from "./testmap.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S, envCapS, type EventType, type RunContext, type StageName } from "./types.ts";
import { safeGit } from "../util/safe_git.ts";
export type WorkerEmit = (type: EventType, stage: StageName | null, data: Record<string, unknown>) => void;
/** The stage driver; `main` below passes machine.ts. */
export type WorkerDrive = (emit: WorkerEmit) => Promise<void>;
/** Fail closed: the worker refuses to start while it can see a real GitHub token. */
export function assertWorkerEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.LOKI_ALLOW_AGENT_GITHUB_TOKEN === "1") return; // operator opt-out, warned by withholdGithubTokens
  for (const v of GITHUB_TOKEN_VARS) {
    const val = env[v] ?? "";
    if (val !== "" && !val.startsWith(SENTINEL_PREFIX)) {
      throw new Error(`engine10 worker: ${v} holds a real token; the worker must run with withheld credentials`);
    }
  }
}
/** GAME10-05a: capability record for one stage; the evidence lives in contrib (hooks.stageCapability). An empty slot records "unknown" everywhere, never a guess. */
export const stageCapability = (stage: string, env: NodeJS.ProcessEnv, argv: readonly string[] = []): StageCapability => hooks.stageCapability?.(stage, env, argv) ?? { stage, secrets: "unknown", can_push: "unknown", network: "unknown" };
/** The worker's first line: what this process really holds, cross-checking the supervisor's spawn-site record. workerStages: every stage the worker runs (FLOW flattened, minus pr, which runs in the supervisor). */
export function emitObservedCapability(emit: WorkerEmit, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): void { emit("capability.observed" as never, null, { stages: workerStages().map((st) => stageCapability(st, env, argv)) }); }
export const workerStages = (): StageName[] => FLOW.flat().filter((x): x is StageName => x !== "pr");
export async function runWorker(
  drive: WorkerDrive,
  opts: { env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): Promise<void> {
  assertWorkerEnv(opts.env ?? process.env);
  const write = opts.write ?? ((line: string) => { process.stdout.write(line); });
  await drive((type, stage, data) => write(JSON.stringify({ type, stage, data }) + "\n"));
}
/** P12-07l: deep honors the same cap env as fast (remaining cap on resume; the supervisor sets the full cap otherwise). */
export function workerCapS(deep: boolean, env: NodeJS.ProcessEnv): number { return envCapS(env.LOKI_E10_CAP_S) ?? (deep ? DEEP_CAP_S : DEFAULT_CAP_S); }

/** The receipt's cost reader: files for tokens and records, the run's cost events (runCost, the number shown everywhere) for dollars. */
export const workerCostReader = (runId: string, events: () => { type: string; data: Record<string, unknown> }[] = () => []): RunContext["cost"] => ({ read: (dir, ids) => { const l = join(dir, ".loki"); return costTotalsOf(sealedRunCost(sumRunCosts(l, liveArchivedCosts(l, ids, UNMETERED), [], runId), events().map((e) => ({ ...e, run: runId })), l)); } });

/** Keeps each cost event the worker emits for the receipt's cost reader; a resume starts from the log's earlier cost events (read before any new emit, so nothing is counted twice). */
export function costCapture(rawEmit: WorkerEmit, runId: string, repoDir: string, env: NodeJS.ProcessEnv = process.env): { emit: WorkerEmit; cost: RunContext["cost"] } {
  const kept: { type: string; data: Record<string, unknown> }[] = env.LOKI_E10_RESUME === "1" ? readEvents(join(repoDir, eventsRelPath(runId))).filter((e) => e.type === "cost") : [];
  return { emit: (t, s, d) => { if (t === "cost") kept.push({ type: t, data: d }); rawEmit(t, s, d); }, cost: workerCostReader(runId, () => kept) };
}

/** The worker's one emit composition (main uses only this): the cap meter wraps the cost capture, so each cost event feeds the meter and the receipt's reader. */
export function workerEmits(rawEmit: WorkerEmit, runId: string, repoDir: string, lokiRoot: string, env: NodeJS.ProcessEnv = process.env, onBudget?: (b: BudgetCrossing) => void): { emit: WorkerEmit; over: () => boolean; remaining: () => number | null; cost: RunContext["cost"] } { const c = costCapture(rawEmit, runId, repoDir, env); return { ...capMeter(c.emit, env, onBudget, childSpendDelta(lokiRoot, runId)), cost: c.cost }; }
/** `engine10 worker <run-id> <provider> <model> <fast|deep>`, spawned by the supervisor through cli.ts. */
export async function main(args: string[]): Promise<number> {
  const [runId, provider = "claude", model = resolveModel(provider), mode = "fast"] = args;
  if (!runId) { process.stderr.write("engine10 worker: missing run id\n"); return 2; }
  const repoDir = process.cwd();
  const lokiRoot = join(repoDir, ".loki"); process.env["LOKI_E10_RUN_ID"] = runId; // child-ledger lines carry the run id
  const deep = mode === "deep";
  // Supervisor cancel (SIGINT/SIGTERM): stop every live session so each records its partial usage, then exit.
  (globalThis as Record<symbol, unknown>)[Symbol.for("loki.ownsStopSignals")] = true; // cli.ts's blanket exit(130/143) stands down: the handler below owns the stop
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { void cancelSessions().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)); });
  await runWorker(async (rawEmit) => {
    emitObservedCapability(rawEmit); // GAME10-05a
    const { emit, over, remaining, cost } = workerEmits(rawEmit, runId, repoDir, lokiRoot, process.env, (b) => { void import("../util/slack_events.ts").then((m) => m.notifyEvent(process.env, "budget", { cost: `$${b.usd_so_far.toFixed(2)} of $${b.cap_usd.toFixed(2)} (${b.threshold_pct}% of cap)`, question: `$${b.cap_usd.toFixed(2)}`, summary: `Budget: ${b.threshold_pct}% of the $${b.cap_usd.toFixed(2)} cap reached ($${b.usd_so_far.toFixed(2)} spent)` })).catch(() => {}); });
    const base = createSessionRunner({ provider, model, emit: emit as EmitFn, lokiRoot, remaining });
    const failovers: FailoverRecord[] = [];
    const sessions = withFailover({
      provider, base,
      makeRunner: (p) => createSessionRunner({ provider: p, model: resolveModel(p), emit: emit as EmitFn, lokiRoot, remaining }),
      onFailover: (rec) => { failovers.push(rec); emit("provider.failover", rec.stage as StageName, { ...rec }); },
    });
    const externalPatch = process.env.LOKI_E10_SEAL_EXISTING_PATCH || undefined; // CW-12 B2: only the implement stage may see the diff path; take it here and remove it so no session, check or child inherits it
    delete process.env.LOKI_E10_SEAL_EXISTING_PATCH;
    const ctx: RunContext = {
      externalPatch, runId, repoDir, runDir: join(lokiRoot, "runs", runId), branch: `loki/${runId}`, provider, model, deep,
      baseSha: safeGit(repoDir, ["rev-parse", "HEAD"]).trim(),
      capS: workerCapS(deep, process.env),
      emit, overCap: over,
      sessions, failovers: () => failovers,
      tests: new RealTestMapProvider(),
      cost,
      clock: { now: () => Date.now() },
      outputs: () => ({}), // replaced by the machine
    };
    // Rule of Two: pr is never loaded here; the supervisor runs it after this process exits.
    const resize = deep ? undefined : (): number => resizeCap(ctx.runDir, loadProjectApi(repoDir), !(Number(parseCapUsd(process.env.LOKI_E10_MAX_COST_USD)) > 0), Number(process.env.LOKI_E10_CAP_FIXED_S) || undefined); // FC-21b: one resize after plan||wall; the machine never shrinks the cap
    let flow = FLOW.filter((s) => s !== "pr"), restored: Partial<Record<StageName, Record<string, unknown>>> | undefined;
    if (process.env.LOKI_E10_RESUME === "1") { // P12-07i: seed ctx from the durable log, then run only the unsettled stages; refuse (fail closed) on an invalid resume point
      const p = join(repoDir, eventsRelPath(runId)), r = (await import("../util/run_outputs.ts")).resumeMachineOpts(ctx as never, readEvents(p), readFileSync(p, "utf8"), flow);
      if (!r.ok) { emit("escalated", null, { stop: `resume refused: ${r.reason}` }); return; }
      flow = r.flow as typeof flow; const rs = r.restored as NonNullable<typeof restored>; restored = rs; const b = rs.intake?.["base_sha"]; if (typeof b === "string") ctx.baseSha = b;
    }
    const { stopped } = await runMachine(ctx, { flow, ...(restored ? { restored } : {}), ...(resize ? { resize } : {}) });
    if (stopped) emit("escalated", null, { stop: stopped }); // A-110: the supervisor maps the stop reason to an outcome
  });
  return 0;
}
