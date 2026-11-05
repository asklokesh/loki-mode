// Shared by the prototype drivers under bench/proto: one tool-less, single-turn Haiku call through the claude CLI, plus a
// zero-cost replay of recorded calls. Prototype only; the product path is sdk_invoker's messages.create.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { LlmCall, Usage } from "../../loki-ts/src/features/tournament.ts";

export interface Transcript { system: string; user: string; text: string; usage: Usage }
export const ZERO_USAGE: Usage = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

/** A real call: `claude -p --model claude-haiku-5-5 --tools ""` with the system prompt replaced. Every call is appended to `log`. */
export function haikuCli(work: string, log: Transcript[], opts: { effort?: string; timeoutMs?: number } = {}): LlmCall {
  return async (system, user) => {
    const pf = join(work, `prompt${log.length}-${Date.now()}.txt`);
    writeFileSync(pf, user);
    const args = ["-p", "--model", "claude-haiku-5-5", "--system-prompt", system, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", ...(opts.effort ? ["--effort", opts.effort] : [])];
    const r = await new Promise<{ out: string; code: number | null }>((res) => {
      const p = spawn("claude", args, { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
      let out = ""; p.stdout.on("data", (b: Buffer) => (out += b.toString()));
      const t = setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs ?? 240_000);
      p.on("close", (code) => { clearTimeout(t); res({ out, code }); });
      p.stdin.end(readFileSync(pf));
    });
    const j = JSON.parse(r.out) as { result: string; total_cost_usd: number; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
    const usage: Usage = { inTok: j.usage.input_tokens, outTok: j.usage.output_tokens, cacheRead: j.usage.cache_read_input_tokens ?? 0, cacheWrite: j.usage.cache_creation_input_tokens ?? 0, costUsd: j.total_cost_usd };
    log.push({ system, user, text: j.result, usage });
    return { text: j.result, usage };
  };
}

/** Zero-cost re-score: returns the texts an earlier real run recorded, the n-th call of each system prompt in order. */
export function replayCalls(file: string, log: Transcript[]): LlmCall {
  const rec = JSON.parse(readFileSync(file, "utf8")) as Transcript[], used = new Map<string, number>();
  return async (system, user) => {
    const k = used.get(system) ?? 0, r = rec.filter((x) => x.system === system)[k];
    if (!r) throw new Error(`replay: no recorded call ${k} for system prompt ${system.slice(0, 40)}`);
    used.set(system, k + 1);
    log.push({ system, user, text: r.text, usage: r.usage });
    return { text: r.text, usage: r.usage };
  };
}
