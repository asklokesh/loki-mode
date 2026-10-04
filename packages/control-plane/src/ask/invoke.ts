// CP-ASK slice 7: provider argv for an Ask job. Pure; no spawn. The prompt travels on stdin so a question can never become an option.
// claude is the full path. codex is degraded: its read-only sandbox still allows shell reads. opencode, cline and aider have no read-only guard or no MCP and are refused.
import { ALLOWED_TOOLS, DENIED_TOOLS, MCP_SERVER_NAME } from "./policy.ts";

export interface InvokeOpts {
  provider: string;
  model?: string | null;
  mcpConfigPath: string;
  jobDir: string;
  maxUsd: number;
  /** Replaces argv[0] (tests, or a pinned binary path). */
  bin?: string;
  /** Tools server command and args, for providers that take MCP as flags rather than a file. */
  mcpCommand?: { command: string; args: string[] };
}
export type Invocation = { ok: true; argv: string[]; promptVia: "stdin" } | { ok: false; error: string };

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
export const REFUSED = "Ask needs claude or codex for now";

const toml = (v: string): string => JSON.stringify(v);

export function buildInvocation(o: InvokeOpts): Invocation {
  if (o.provider === "cline" || o.provider === "aider" || o.provider === "opencode") return { ok: false, error: REFUSED };
  if (o.model && !MODEL_RE.test(o.model)) return { ok: false, error: "model must match [A-Za-z0-9][A-Za-z0-9._/-]{0,79}" };
  const model = o.model ? ["--model", o.model] : []; // the default model is omitted so the provider's own default applies
  if (o.provider === "claude") {
    return {
      ok: true,
      promptVia: "stdin",
      argv: [o.bin ?? "claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--disable-slash-commands",
        "--strict-mcp-config", "--mcp-config", o.mcpConfigPath,
        "--tools", "", "--allowedTools", ALLOWED_TOOLS, "--disallowedTools", DENIED_TOOLS,
        "--max-budget-usd", String(o.maxUsd), ...model],
    };
  }
  if (o.provider === "codex") {
    const mcp = o.mcpCommand ? ["-c", `mcp_servers.${MCP_SERVER_NAME}.command=${toml(o.mcpCommand.command)}`, "-c", `mcp_servers.${MCP_SERVER_NAME}.args=[${o.mcpCommand.args.map(toml).join(",")}]`] : [];
    return { ok: true, promptVia: "stdin", argv: [o.bin ?? "codex", "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", o.jobDir, ...mcp, ...model, "-"] };
  }
  return { ok: false, error: "provider must be one of: claude, codex" };
}
