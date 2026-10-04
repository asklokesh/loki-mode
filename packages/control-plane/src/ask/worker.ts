// CP-ASK slice 9: run one Ask turn on the user's provider. The provider is spawned detached (argv, no shell, scrubbed env) in an
// empty 0700 scratch dir; its stream is parsed into ask_events; the message ends done, failed, timeout, over_budget or interrupted.
// Kills only ever target the process group recorded on the message row.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/migrate.ts";
import { childEnv } from "../server/spawn.ts";
import { buildInvocation } from "./invoke.ts";
import { type AskProvider, finish, markComplete, newState, parseLine } from "./parse.ts";
import { buildMcpConfig, createJobDir, MCP_SERVER_SCRIPT, removeJobDir } from "./policy.ts";
import { buildPrompt } from "./prompt.ts";
import { type AskStatus, appendEvent, finishMessage, getMessage, getThread, listMessages, setRunning } from "./store.ts";

export interface WorkerOpts {
  repoRoot: string;
  dbPath: string;
  /** Provider binary override (tests, pinned path). */
  bin?: string;
  timeoutMs?: number;
  maxUsd?: number;
  /** Signal a process GROUP. Default process.kill(-pgid, sig). */
  kill?: (pgid: number, sig: NodeJS.Signals) => void;
}

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_USD = 1;
const KILL_GRACE_MS = 2_000;

interface Live { pgid: number; terminate: (why: "cancelled" | "timeout") => void }
const live = new Map<string, Live>();

const defaultKill = (pgid: number, sig: NodeJS.Signals): void => { process.kill(-pgid, sig); };

/** Cancel a running job. The target is the pgid recorded on the row, and it must match the live job this process spawned. */
export function cancelJob(db: Db, messageId: string): boolean {
  const m = getMessage(db, messageId);
  const j = live.get(messageId);
  if (!m || m.status !== "running" || !j || m.pgid === null || m.pgid <= 1 || m.pgid !== j.pgid) return false;
  j.terminate("cancelled");
  return true;
}

/** The ids of jobs this process is currently running (shutdown, tests). */
export const liveJobs = (): string[] => [...live.keys()];

export async function runAskJob(db: Db, messageId: string, o: WorkerOpts): Promise<AskStatus> {
  const msg = getMessage(db, messageId);
  if (!msg || msg.role !== "assistant" || msg.status !== "queued") throw new Error(`message ${messageId} is not a queued assistant message`);
  const thread = getThread(db, msg.threadId)!;
  const fail = (error: string): AskStatus => { finishMessage(db, messageId, { status: "failed", error }); return "failed"; };

  const all = listMessages(db, msg.threadId);
  const question = [...all].reverse().find((m) => m.role === "user" && m.seq < msg.seq)?.text ?? "";
  const history = all.filter((m) => m.seq < msg.seq - 1 && (m.role === "user" || m.status === "done")).map((m) => ({ role: m.role, text: m.text }));
  const prompt = buildPrompt({ history, question, repo: thread.repo });

  const maxUsd = o.maxUsd ?? DEFAULT_MAX_USD;
  let jobDir: string | undefined;
  try {
    jobDir = createJobDir();
    const mcpConfigPath = join(jobDir, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(o.repoRoot, o.dbPath)), { mode: 0o600 });
    const inv = buildInvocation({
      provider: thread.provider, model: thread.model, mcpConfigPath, jobDir, maxUsd, bin: o.bin,
      mcpCommand: { command: "bun", args: [join(o.repoRoot, MCP_SERVER_SCRIPT)] },
    });
    if (!inv.ok) return fail(inv.error);
    const provider = thread.provider as AskProvider;
    const mcpEnv = provider === "claude" ? {} : { LOKI_CONTROL_DB: o.dbPath }; // codex and opencode take MCP via flags/config and inherit env
    return await new Promise<AskStatus>((resolve) => {
      const [cmd, ...args] = inv.argv;
      let child;
      try {
        child = spawn(cmd!, args, { cwd: jobDir, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...childEnv(), ...mcpEnv } });
      } catch (e) { resolve(fail(`could not start ${cmd}: ${(e as Error).message}`)); return; }
      const state = newState();
      let buf = "", errTail = "", ended: "timeout" | "cancelled" | undefined, settled = false;
      const kill = o.kill ?? defaultKill;

      child.once("error", (e) => { if (settled) return; settled = true; clearTimers(); resolve(fail(`could not start ${cmd}: ${e.message}`)); });
      child.once("spawn", () => {
        const pid = child.pid ?? 0;
        if (pid > 1) { setRunning(db, messageId, pid, pid); live.set(messageId, { pgid: pid, terminate }); } // detached: pgid === pid
      });

      let timer: ReturnType<typeof setTimeout> | undefined, escalate: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = () => { clearTimeout(timer); clearTimeout(escalate); live.delete(messageId); };
      function terminate(why: "timeout" | "cancelled"): void {
        if (ended) return;
        ended = why;
        const pgid = getMessage(db, messageId)?.pgid ?? 0; // the recorded group only
        if (pgid <= 1) return;
        try { kill(pgid, "SIGTERM"); } catch { /* already gone */ }
        escalate = setTimeout(() => { try { kill(pgid, "SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
      }
      timer = setTimeout(() => terminate("timeout"), o.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const take = (line: string) => { for (const ev of parseLine(provider, line, state)) appendEvent(db, messageId, ev.kind, ev.payload); };
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      child.stderr!.on("data", (d: Buffer) => { errTail = (errTail + d.toString("utf8")).slice(-2000); });
      child.stdin!.on("error", () => { /* provider exited before reading the prompt */ });
      child.stdin!.end(prompt);

      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (buf.trim()) take(buf);
        if (provider === "opencode" && code === 0) markComplete(state);
        const out = finish(state);
        const base = { text: out.text, costUsd: out.costUsd ?? null };
        let status: AskStatus;
        let error: string | null = null;
        if (ended === "timeout") { status = "timeout"; error = `timed out after ${Math.round((o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`; }
        else if (ended === "cancelled") { status = "interrupted"; error = "cancelled"; }
        else if ((out.costUsd ?? 0) > maxUsd || (out.status === "failed" && /budget/i.test(out.error ?? ""))) { status = "over_budget"; error = `over the $${maxUsd.toFixed(2)} budget`; }
        else if (out.status === "failed") { status = "failed"; error = [out.error, code ? `exit ${code}` : "", errTail.trim().slice(-500)].filter(Boolean).join("; "); }
        else status = "done";
        finishMessage(db, messageId, { status, ...base, error });
        resolve(status);
      });
    });
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    if (jobDir) { try { removeJobDir(jobDir); } catch { /* validated refusal leaves it for the OS temp reaper */ } }
  }
}
