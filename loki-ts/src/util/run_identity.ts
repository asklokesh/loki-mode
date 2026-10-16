// loki-ts/src/util/run_identity.ts -- P12-23 (BP2, E-Q, Q3): the execution identity tuple recorded on run.started.
// New file: no util owns execution identity (engine_origin.ts is the origin URL only; run_outputs.ts runIntent is who/why).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRouteEnv, modelRouteModel } from "../providers/model_routes.ts";

export interface RunIdentity { cli_version: string | null; endpoint: string | null; config_digest: string | null; requested_model: string }
export interface ModelOutcome { requested_model: string; actual_model: string | null; downgraded: boolean | null }

const STRENGTH = ["opus", "sonnet", "haiku"]; // strongest first; any other family (fable) is not ranked, so never flagged
const family = (m: string): string | null => STRENGTH.find((f) => m.toLowerCase().includes(f)) ?? null;

/** host[:port] of the API base URL the claude child will use (a model route wins, as in childEnv); no scheme, path, credentials or query. Null when unparseable. */
export function endpointHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = modelRouteEnv(env)["ANTHROPIC_BASE_URL"] || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BEDROCK_BASE_URL || env.ANTHROPIC_VERTEX_BASE_URL;
  if (!raw) return env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1" ? null : "api.anthropic.com"; // cloud-provider auth: the endpoint is not ours to name
  try { return new URL(raw).host || null; } catch { return null; }
}

/** Settings content for the digest: key names of `env` only (it carries API keys), everything else verbatim. Unparseable files contribute a marker, never raw text. */
function settingsForDigest(raw: Buffer): string {
  try {
    const { env, ...rest } = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const names = env && typeof env === "object" ? Object.keys(env).sort() : [];
    return JSON.stringify({ rest, env_keys: names });
  } catch { return "unparseable"; }
}

/** sha256 over CLAUDE.md, settings (env values excluded) and hooks files that exist (name + content), null when none exist. */
export function configDigest(repoDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? "";
  const rel = ["CLAUDE.md", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks.json"];
  const files: Array<[string, string]> = rel.map((f) => [f, join(repoDir, f)]);
  if (home) for (const f of [".claude/CLAUDE.md", ".claude/settings.json", ".claude/hooks.json"]) files.push([`~/${f}`, join(home, f)]);
  const h = createHash("sha256"); let any = false;
  for (const [name, path] of files) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path);
      h.update(`${name}\0`).update(/settings(\.local)?\.json$/.test(name) ? settingsForDigest(raw) : raw).update("\0"); any = true;
    } catch { /* unreadable: skipped */ }
  }
  return any ? h.digest("hex") : null;
}

let cachedVersion: string | null | undefined;
/** `claude --version`, once per process. The child gets only PATH and HOME: no GH_TOKEN or API key ever reaches it (Rule of Two). */
export function cliVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  let cwd: string | null = null;
  try {
    cwd = mkdtempSync(join(tmpdir(), "loki-cliver-")); // scratch cwd: a wrapper that ignores --version must not write into the repo
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    cachedVersion = execFileSync("claude", ["--version"], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, cwd }).trim().split(/\s+/)[0] || null;
  } catch { cachedVersion = null; }
  if (cwd) try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  return cachedVersion;
}

export function runIdentity(repoDir: string, env: NodeJS.ProcessEnv, requestedModel: string, version: () => string | null = cliVersion): RunIdentity {
  return { cli_version: version(), endpoint: endpointHost(env), config_digest: configDigest(repoDir, env), requested_model: requestedModel };
}

/** Requested vs provider-reported model. downgraded is null when either family is unknown (including the "claude (provider default)" sentinel); else true only when the actual family is weaker (opus > sonnet > haiku). */
export function modelOutcome(requested: string, actual: string | null | undefined): ModelOutcome {
  const a = actual || null, rf = family(requested), af = a ? family(a) : null;
  return { requested_model: requested, actual_model: a, downgraded: rf === null || af === null ? null : STRENGTH.indexOf(af) > STRENGTH.indexOf(rf) };
}

const PROVIDER_DEFAULT = "claude (provider default)"; // same label as engine10/session.ts PROVIDER_DEFAULT_MODEL (not imported: session.ts imports this file)
/** The model one session of `tier` was configured to run, read from its child env after tier and router-pin resolution
 *  (mirrors runner/providers.ts claudeModelFor). Requested is per session: a fast-tier stage on a run-level opus is not a downgrade. */
export function requestedModelForTier(env: NodeJS.ProcessEnv, tier: string): string {
  const name = tier === "planning" ? "PLANNING" : tier === "fast" ? "FAST" : "DEVELOPMENT";
  if (env.LOKI_MODEL_OVERRIDE) return env.LOKI_MODEL_OVERRIDE;
  const routed = modelRouteModel(env);
  if (routed) return routed;
  const pin = env[`LOKI_CLAUDE_MODEL_${name}`] || env[`LOKI_MODEL_${name}`];
  if (pin) return pin;
  if (env.LOKI_E10_MODEL_DEFAULT === "1" && tier !== "fast" && !env.LOKI_MAX_TIER && !env.LOKI_TIER_ROUTING) return PROVIDER_DEFAULT;
  return tier === "fast" && env.LOKI_ALLOW_HAIKU === "true" ? "haiku" : "sonnet";
}
