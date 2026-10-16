// Loki 10 worker (P2, ENGINE.md 6): the token-withheld process that runs intake..seal. It never writes
// events.jsonl; each event is one JSON line {type, stage, data} on stdout, and the supervisor validates,
// stamps seq and appends. Its own diagnostics go to stderr.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "./events.ts";
import { eventsRelPath } from "../util/engine_origin.ts";
import { GITHUB_TOKEN_VARS, SENTINEL_PREFIX } from "../util/credential_env.ts";
import { costTotalsOf, liveArchivedCosts, sumResultCosts, UNMETERED } from "./cost.ts";
import { capMeter } from "../e10ext/budget_cap.ts";
import { resizeCap } from "../util/run_cap.ts"; import { loadProjectApi } from "../project_model/resolve.ts"; import { parseCapUsd } from "../e10ext/budget_cap.ts";
import { FLOW, runMachine } from "./machine.ts";
import { withFailover, type FailoverRecord } from "../runner/provider_failover.ts";
import { cancelSessions, createSessionRunner, resolveModel, type EmitFn } from "./session.ts";
import { RealTestMapProvider } from "./testmap.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S } from "./types.ts";
import type { EventType, RunContext, StageName } from "./types.ts";
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
export async function runWorker(
  drive: WorkerDrive,
  opts: { env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): Promise<void> {
  assertWorkerEnv(opts.env ?? process.env);
  const write = opts.write ?? ((line: string) => { process.stdout.write(line); });
  await drive((type, stage, data) => write(JSON.stringify({ type, stage, data }) + "\n"));
}
/** `engine10 worker <run-id> <provider> <model> <fast|deep>`, spawned by the supervisor through cli.ts. */
export async function main(args: string[]): Promise<number> {
  const [runId, provider = "claude", model = resolveModel(provider), mode = "fast"] = args;
  if (!runId) { process.stderr.write("engine10 worker: missing run id\n"); return 2; }
  const repoDir = process.cwd();
  const lokiRoot = join(repoDir, ".loki");
  const deep = mode === "deep";
  const started = new Set<string>();
  // Supervisor cancel (SIGINT/SIGTERM): stop every live session so each records its partial usage, then exit.
  (globalThis as Record<symbol, unknown>)[Symbol.for("loki.ownsStopSignals")] = true; // cli.ts's blanket exit(130/143) stands down: the handler below owns the stop
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { void cancelSessions().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)); });
  await runWorker(async (rawEmit) => {
    const { emit, over, remaining } = capMeter(rawEmit, process.env);
    const base = createSessionRunner({ provider, model, emit: emit as EmitFn, lokiRoot, remaining });
    const failovers: FailoverRecord[] = [];
    const sessions = withFailover({
      provider, base,
      makeRunner: (p) => createSessionRunner({ provider: p, model: resolveModel(p), emit: emit as EmitFn, lokiRoot, remaining }),
      onFailover: (rec) => { failovers.push(rec); emit("provider.failover", rec.stage as StageName, { ...rec }); },
    });
    const ctx: RunContext = {
      runId, repoDir, runDir: join(lokiRoot, "runs", runId), branch: `loki/${runId}`, provider, model, deep,
      baseSha: safeGit(repoDir, ["rev-parse", "HEAD"]).trim(),
      capS: deep ? DEEP_CAP_S : Number(process.env.LOKI_E10_CAP_S) || DEFAULT_CAP_S,
      emit, overCap: over,
      sessions: { run: (o) => { started.add(o.iterationId); return sessions.run(o); } }, failovers: () => failovers,
      tests: new RealTestMapProvider(),
      cost: {
        // Union with every session started: a killed stage's output (and its ids) is dropped by the machine.
        read(dir, ids) {
          const c = sumResultCosts(join(dir, ".loki"), liveArchivedCosts(join(dir, ".loki"), [...new Set([...ids, ...started])], UNMETERED));
          return costTotalsOf(c);
        },
      },
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
