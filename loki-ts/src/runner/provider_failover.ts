// T9 provider failover v1: when a stage session fails with a classified provider outage or rate limit, retry that stage once on the
// next provider. A code failure is never an outage; gemini is deprecated and never chosen. LOKI_FAILOVER=0 leaves the runner untouched.
import type { SessionResult, SessionRunOptions, SessionRunner } from "../engine10/types.ts";

export interface FailoverRecord {
  stage: string;
  from: string;
  to: string | null; // null: no other provider was available
  reason: "rate_limit" | "outage";
  evidence: string; // the classified provider output line
  note?: string; // "failover: none available" when to is null
}
export const NONE_AVAILABLE = "failover: none available";
const DEFAULT_ORDER = ["claude", "cline", "codex", "aider", "opencode"]; // providers/loader.sh auto_detect_provider order
const ALLOWED = new Set(DEFAULT_ORDER); // gemini (deprecated) and unknown names can never be chosen

// Provider wire text only: scanned on the child's stderr tail and the SDK error line, never the agent transcript.
const RATE_LIMIT = /(?:\brate[_ -]?limit(?:ed|_error| exceeded| reached)?\b|\btoo many requests\b|\bhttp[ /:]*429\b|\bstatus[ :=]*429\b|\b429 )/i;
const OUTAGE = /(?:\boverloaded(?:_error)?\b|\bservice unavailable\b|\bhttp[ /:]*50[234]\b|\bstatus[ :=]*50[234]\b|\bbad gateway\b|\bgateway timeout\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNRESET\b|\bsocket hang up\b|\busage limit reached\b)/i;

/** The first provider-written line that names a rate limit or outage, or null (a code failure, a clean exit, or a kill). */
export function classifyOutage(stderrTail: string, exit: number | null, killed: boolean): { reason: FailoverRecord["reason"]; evidence: string } | null {
  if (killed || exit === 0 || exit === null) return null;
  for (const line of (stderrTail ?? "").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    if (RATE_LIMIT.test(l)) return { reason: "rate_limit", evidence: l.slice(0, 300) };
    if (OUTAGE.test(l)) return { reason: "outage", evidence: l.slice(0, 300) };
  }
  return null;
}

export function failoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env["LOKI_FAILOVER"] !== "0"; }

/** Next provider after `current`: LOKI_FAILOVER_PROVIDERS in order, else every installed non-deprecated provider in loader order. */
export function nextProvider(current: string, env: NodeJS.ProcessEnv, installed: (p: string) => boolean): string | null {
  const listed = (env["LOKI_FAILOVER_PROVIDERS"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const order = listed.length > 0 ? listed : DEFAULT_ORDER;
  for (const p of order) if (p !== current && ALLOWED.has(p) && installed(p)) return p;
  return null;
}

export function defaultInstalled(p: string): boolean { return ALLOWED.has(p) && Bun.which(p) !== null; }

export interface FailoverDeps {
  provider: string;
  makeRunner: (provider: string) => SessionRunner;
  base: SessionRunner;
  env?: NodeJS.ProcessEnv;
  installed?: (p: string) => boolean;
  onFailover: (rec: FailoverRecord) => void;
}
/** Wraps the stage session runner. Disabled (LOKI_FAILOVER=0) returns `base` itself, so behavior is byte-identical. */
export function withFailover(d: FailoverDeps): SessionRunner {
  const env = d.env ?? process.env;
  if (!failoverEnabled(env)) return d.base;
  const installed = d.installed ?? defaultInstalled;
  return {
    async run(opts: SessionRunOptions): Promise<SessionResult> {
      const r = await d.base.run(opts);
      if (opts.stage === "verify" || opts.signal.aborted) return r;
      const tail = (r as { stderrTail?: string }).stderrTail ?? "";
      const c = classifyOutage(tail, r.exit, r.killed);
      if (!c) return r;
      const to = nextProvider(d.provider, env, installed);
      const rec: FailoverRecord = { stage: opts.stage, from: d.provider, to, reason: c.reason, evidence: c.evidence, ...(to ? {} : { note: NONE_AVAILABLE }) };
      d.onFailover(rec);
      if (!to) return r;
      return d.makeRunner(to).run(opts);
    },
  };
}
