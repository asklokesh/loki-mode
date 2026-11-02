// CP-ASK slice 7: provider argv for an Ask job. Pure; no spawn. The prompt travels on stdin so a question can never become an option.
// claude is the only path. opencode has no read-only guard and is refused.
import { ALLOWED_TOOLS, DENIED_TOOLS } from "./policy.ts";

export interface InvokeOpts {
  provider: string;
  model?: string | null;
  mcpConfigPath: string;
  jobDir: string;
  maxUsd: number;
  /** Replaces argv[0] (tests, or a pinned binary path). */
  bin?: string;
}
export type Invocation = { ok: true; argv: string[]; promptVia: "stdin" } | { ok: false; error: string };

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
export const REFUSED = "Ask needs claude for now";

export function buildInvocation(o: InvokeOpts): Invocation {
  if (o.provider === "opencode") return { ok: false, error: REFUSED };
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
  return { ok: false, error: "provider must be claude" };
}
