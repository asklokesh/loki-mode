// Advisor availability probe (ROUTER-1 R1-06, section 4.4).
// Pure decision over env, provider, Claude Code version and a run dir.
// Unavailable never fails a run; callers fall back to plan-on-Opus.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isNewer } from "../../util/update_check.ts";

export const ADVISOR_MIN_CLAUDE_CODE = "2.1.293";
export const ADVISOR_ERROR_MARKER = "advisor-error.txt";

export interface AdvisorProbe {
  available: boolean;
  reason: string;
}

const CLOUD_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function isAnthropicHost(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

function readMarker(runDir: string): string | null {
  try {
    const file = join(runDir, ADVISOR_ERROR_MARKER);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf-8").trim() || "advisor tool error";
  } catch {
    return null;
  }
}

export function probeAdvisor(
  env: Record<string, string | undefined>,
  provider: string,
  claudeCodeVersion: string,
  runDir: string,
): AdvisorProbe {
  const no = (reason: string): AdvisorProbe => ({ available: false, reason });

  if (provider !== "claude") return no(`provider is ${provider}, not claude`);
  for (const flag of CLOUD_FLAGS) {
    if (env[flag]) return no(`${flag} is set`);
  }
  const base = env["ANTHROPIC_BASE_URL"];
  if (base && !isAnthropicHost(base)) {
    return no("ANTHROPIC_BASE_URL points at a non-Anthropic host");
  }
  const m = /^\s*(\d+\.\d+\.\d+)/.exec(claudeCodeVersion ?? "");
  if (!m || isNewer(ADVISOR_MIN_CLAUDE_CODE, m[1] as string)) {
    return no(`Claude Code ${claudeCodeVersion || "unknown"} is below ${ADVISOR_MIN_CLAUDE_CODE}`);
  }
  if ((env["LOKI_ROUTER_ADVISOR"] ?? "").trim().toLowerCase() === "off") {
    return no("LOKI_ROUTER_ADVISOR=off");
  }
  const sticky = readMarker(runDir);
  if (sticky !== null) return no(`advisor error earlier in this run: ${sticky}`);
  return { available: true, reason: "" };
}

// Sticky for the rest of the run: the first recorded error wins. Best effort,
// never throws (an unwritable runDir just means the next probe re-tries).
export function recordAdvisorError(runDir: string, message: string): void {
  try {
    const file = join(runDir, ADVISOR_ERROR_MARKER);
    if (existsSync(file)) return;
    if (!existsSync(runDir)) return;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(file, `${message}\n`, { flag: "wx" });
  } catch {
    // ignore
  }
}
