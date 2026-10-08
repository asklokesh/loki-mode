// Loki 10 worker (P2, ENGINE.md 6): the token-withheld process that runs intake..seal. It never writes
// events.jsonl; each event is one JSON line {type, stage, data} on stdout, and the supervisor validates,
// stamps seq and appends. Its own diagnostics go to stderr.
import { join } from "node:path";
import { GITHUB_TOKEN_VARS } from "../runner/github_token.ts";
import { costTotalsOf, sumResultCosts } from "./cost.ts";
import { capMeter } from "../e10ext/budget_cap.ts";
import { resizeCap } from "../util/run_cap.ts"; import { loadProjectApi } from "../project_model/resolve.ts"; import { parseCapUsd } from "../e10ext/budget_cap.ts";
import { FLOW, runMachine } from "./machine.ts";
import { withFailover, type FailoverRecord } from "../runner/provider_failover.ts";
import { createSessionRunner, resolveModel, type EmitFn } from "./session.ts";
import { RealTestMapProvider } from "./testmap.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S } from "./types.ts";
import type { EventType, RunContext, StageName } from "./types.ts";
import { safeGit } from "../util/safe_git.ts";
export type WorkerEmit = (type: EventType, stage: StageName | null, data: Record<string, unknown>) => void;
/** The stage driver; `main` below passes machine.ts. */
export type WorkerDrive = (emit: WorkerEmit) => Promise<void>;
const SENTINEL_PREFIX = "ghp_LOKIWITHHELDsentinel";
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
  await runWorker(async (rawEmit) => {
    const { emit, over } = capMeter(rawEmit, process.env);
    const base = createSessionRunner({ provider, model, emit: emit as EmitFn, lokiRoot });
    const failovers: FailoverRecord[] = [];
    const sessions = withFailover({
      provider, base,
      makeRunner: (p) => createSessionRunner({ provider: p, model: resolveModel(p), emit: emit as EmitFn, lokiRoot }),
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
          const c = sumResultCosts(join(dir, ".loki"), [...new Set([...ids, ...started])]);
          return costTotalsOf(c);
        },
      },
      clock: { now: () => Date.now() },
      outputs: () => ({}), // replaced by the machine
    };
    // Rule of Two: pr is never loaded here; the supervisor runs it after this process exits.
    const resize = deep ? undefined : (): number => resizeCap(ctx.runDir, loadProjectApi(repoDir), !(Number(parseCapUsd(process.env.LOKI_E10_MAX_COST_USD)) > 0), Number(process.env.LOKI_E10_CAP_FIXED_S) || undefined); // FC-21b: one resize after plan||wall; the machine never shrinks the cap
    const { stopped } = await runMachine(ctx, { flow: FLOW.filter((s) => s !== "pr"), ...(resize ? { resize } : {}) });
    if (stopped) emit("escalated", null, { stop: stopped }); // A-110: the supervisor maps the stop reason to an outcome
  });
  return 0;
}
