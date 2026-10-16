// loki-ts/src/util/run_identity.ts -- P12-23 (BP2, E-Q, Q3): the execution identity tuple recorded on run.started.
// New file: no util owns execution identity (engine_origin.ts is the origin URL only; run_outputs.ts runIntent is who/why).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { policyFile } from "./run_outputs.ts";

export interface RunIdentity { cli_version: string | null; endpoint: string | null; config_digest: string | null; policy_id: string | null; requested_model: string }
export interface ModelOutcome { requested_model: string; actual_model: string | null; downgraded: boolean }

const STRENGTH = ["opus", "sonnet", "haiku"]; // strongest first; any other family (fable) is not ranked, so never flagged
const family = (m: string): string | null => STRENGTH.find((f) => m.toLowerCase().includes(f)) ?? null;

/** Host only of the API base URL (no scheme, path, credentials or query); null when set but unparseable. */
export function endpointHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BEDROCK_BASE_URL || env.ANTHROPIC_VERTEX_BASE_URL;
  if (!raw) return "api.anthropic.com";
  try { return new URL(raw).hostname || null; } catch { return null; }
}

/** sha256 over CLAUDE.md, settings and hooks files that exist (name + content), null when none exist. */
export function configDigest(repoDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? "";
  const rel = ["CLAUDE.md", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks.json"];
  const files: Array<[string, string]> = rel.map((f) => [f, join(repoDir, f)]);
  if (home) for (const f of [".claude/CLAUDE.md", ".claude/settings.json"]) files.push([`~/${f}`, join(home, f)]);
  const h = createHash("sha256"); let any = false;
  for (const [name, path] of files) {
    if (!existsSync(path)) continue;
    try { h.update(`${name}\0`).update(readFileSync(path)).update("\0"); any = true; } catch { /* unreadable: skipped */ }
  }
  return any ? h.digest("hex") : null;
}

export function cliVersion(): string | null {
  try { return execFileSync("claude", ["--version"], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/)[0] || null; } catch { return null; }
}

export function runIdentity(repoDir: string, env: NodeJS.ProcessEnv, requestedModel: string, version: () => string | null = cliVersion): RunIdentity {
  const pf = policyFile(repoDir, env); let policy: string | null = null;
  if (pf) { try { policy = createHash("sha256").update(readFileSync(pf)).digest("hex"); } catch { /* unreadable */ } }
  return { cli_version: version(), endpoint: endpointHost(env), config_digest: configDigest(repoDir, env), policy_id: policy, requested_model: requestedModel };
}

/** Requested vs provider-reported model. downgraded only when both are known and the actual family is weaker (opus > sonnet > haiku). */
export function modelOutcome(requested: string, actual: string | null | undefined): ModelOutcome {
  const a = actual || null, rf = family(requested), af = a ? family(a) : null;
  return { requested_model: requested, actual_model: a, downgraded: rf !== null && af !== null && STRENGTH.indexOf(af) > STRENGTH.indexOf(rf) };
}
