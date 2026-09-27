// Loki 10 worker (P2, docs/v10/ENGINE.md section 6): the token-withheld process
// that runs intake..seal. It never writes events.jsonl; each event is one JSON
// line {type, stage, data} on stdout, and the supervisor validates, stamps seq
// and appends. Its own diagnostics go to stderr.
import { GITHUB_TOKEN_VARS } from "../runner/github_token.ts";
import type { EventType, StageName } from "./types.ts";

export type WorkerEmit = (type: EventType, stage: StageName | null, data: Record<string, unknown>) => void;
/** The stage driver (machine.ts, E-02) is injected; the entry wiring (`engine10 worker`) belongs to cli.ts (E-12). */
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
