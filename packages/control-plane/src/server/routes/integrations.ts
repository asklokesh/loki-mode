// CPE-20: GET /v1/integrations. Presence-only probes: an env var NAME and a boolean, or a CLI exit code. No secret value is read into a
// response, logged or returned. Connect is not here: the UI writes the env var NAME through PUT /v1/config (CPE-14), the only writer.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseDocument } from "yaml";
import { resolveConfigFile } from "./config.ts";
import { probeAllowed, ttlCache, type RouteCtx } from "./index.ts";

const GH_TIMEOUT_MS = 3000;
const isSet = (n: string | null | undefined): boolean => !!n && (process.env[n] ?? "") !== "";

export type Status = "connected" | "not_connected" | "not_measured";
export interface IntegrationRow {
  id: string;
  label: string;
  status: Status;
  /** How the status was decided: "gh_cli", "env", "mcp_file" or "none". */
  method: string;
  /** The env var NAME checked (never a value), or null. */
  env_name: string | null;
  env_set: boolean;
  /** Dotted loki.yaml path that Connect writes, or null when loki.yaml has no slot for this service. */
  config_path: string | null;
  detail: string;
}

/** Exit status of `gh auth status` with output discarded; null when gh is absent, slow or fails to start. */
export function ghAuthed(pathVar = process.env.PATH ?? "", timeoutMs = GH_TIMEOUT_MS): Promise<boolean | null> {
  const exe = pathVar.split(delimiter).filter(Boolean).map((d) => join(d, "gh")).find((p) => existsSync(p));
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: boolean | null): void => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(exe, ["auth", "status"], { stdio: "ignore", env: { ...process.env, NO_COLOR: "1" } }); } catch { return resolve(null); }
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish(null); }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0));
  });
}

function configuredName(repoDir: string, path: string[]): string | null {
  try {
    const r = resolveConfigFile(repoDir);
    if (!r.ok || !r.exists || statSync(r.file).size > 1_000_000) return null;
    const doc = parseDocument(readFileSync(r.file, "utf8"));
    if (doc.errors.length) return null;
    const v = doc.getIn(path);
    return typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v) ? v : null;
  } catch { return null; }
}

/** MCP servers declared in the repo's .mcp.json: a count only, never their env or args. */
function mcpServers(repoDir: string): number | null {
  try {
    const p = join(repoDir, ".mcp.json");
    if (!existsSync(p) || statSync(p).size > 1_000_000) return null;
    const j = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, unknown> };
    return j.mcpServers && typeof j.mcpServers === "object" ? Object.keys(j.mcpServers).length : null;
  } catch { return null; }
}

/** Services loki.yaml has no key for: only conventional env var names are checked, and Connect is not offered. */
const CONVENTIONAL: Array<{ id: string; label: string; names: string[] }> = [
  { id: "gitlab", label: "GitLab", names: ["GITLAB_TOKEN", "GITLAB_PRIVATE_TOKEN"] },
  { id: "jira", label: "Jira", names: ["JIRA_API_TOKEN", "JIRA_TOKEN"] },
  { id: "linear", label: "Linear", names: ["LINEAR_API_KEY"] },
  { id: "sentry", label: "Sentry", names: ["SENTRY_AUTH_TOKEN"] },
];

function conv(s: { id: string; label: string; names: string[] }): IntegrationRow {
  const hit = s.names.find((x) => isSet(x)) ?? null;
  return {
    id: s.id, label: s.label, status: hit ? "connected" : "not_measured", method: hit ? "env" : "none",
    env_name: hit, env_set: !!hit, config_path: null,
    detail: hit ? `${hit} is set in the environment` : `${s.names.join(" or ")} is not set; only presence can be probed, so this is not measured`,
  };
}

export async function listIntegrations(repoDir: string, gh: () => Promise<boolean | null> = () => ghAuthed()): Promise<IntegrationRow[]> {
  const rows: IntegrationRow[] = [];

  const gitEnv = configuredName(repoDir, ["git", "token_env"]);
  const ghOk = await gh();
  const gitEnvSet = isSet(gitEnv);
  rows.push({
    id: "github", label: "GitHub",
    status: gitEnvSet || ghOk === true ? "connected" : ghOk === null && !gitEnv ? "not_measured" : "not_connected",
    method: gitEnvSet ? "env" : ghOk !== null ? "gh_cli" : "none",
    env_name: gitEnv, env_set: gitEnvSet, config_path: "git.token_env",
    detail: gitEnvSet ? "git.token_env is set in the environment" : ghOk === true ? "gh auth status succeeded" : ghOk === false ? "gh is installed but not authenticated" : gitEnv ? "git.token_env names a variable that is not set" : "gh not found and git.token_env is not configured",
  });

  rows.push(conv(CONVENTIONAL[0]!));

  const slackEnv = configuredName(repoDir, ["notifications", "slack_webhook_env"]);
  const slackSet = isSet(slackEnv);
  rows.push({
    id: "slack", label: "Slack", status: slackSet ? "connected" : "not_connected",
    method: slackEnv ? "env" : "none", env_name: slackEnv, env_set: slackSet, config_path: "notifications.slack_webhook_env",
    detail: !slackEnv ? "notifications.slack_webhook_env is not configured" : slackSet ? "webhook variable is set" : "webhook variable is named but not set",
  });

  rows.push(...CONVENTIONAL.slice(1).map(conv));

  const n = mcpServers(repoDir);
  rows.push({
    id: "mcp", label: "MCP", status: n === null ? "not_measured" : n > 0 ? "connected" : "not_connected", method: n === null ? "none" : "mcp_file",
    env_name: null, env_set: false, config_path: null,
    detail: n === null ? "no readable .mcp.json in the repo" : `${n} server${n === 1 ? "" : "s"} declared in .mcp.json`,
  });
  return rows;
}

export function mount(ctx: RouteCtx): void {
  const cached = ttlCache<Awaited<ReturnType<typeof listIntegrations>>>();
  ctx.app.get("/v1/integrations", async (c) => {
    if (!probeAllowed(ctx, c)) return c.json({ error: "loopback only without a token" }, 403);
    return c.json({ integrations: await cached(ctx.repoDir, () => listIntegrations(ctx.repoDir)) });
  });
}
