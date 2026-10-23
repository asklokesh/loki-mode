// Advisor availability probe (ROUTER-1 R1-06, section 4.4).
// Pure decision over env, provider, Claude Code version and a run dir.
// Unavailable never fails a run; callers fall back to plan-on-Opus.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claudeTierRank } from "../../util/claude_model.ts";
import { isNewer } from "../../util/update_check.ts";
import { envOverride } from "./decision.ts";

export const ADVISOR_MIN_CLAUDE_CODE = "2.1.293";
export const ADVISOR_ERROR_MARKER = "advisor-error.txt";
/** Advisor errors in one session after which route_block stops attaching the advisor. */
export const ADVISOR_ERROR_LIMIT = 3;

/** The one advisor every router caller attaches. */
export const ROUTER_ADVISOR_MODEL = "opus";

/**
 * The one executor/advisor pair every probeAdvisor caller passes, so the invalid_pair rule holds on every path. The executor is the
 * caller's model, else the explicit model override, else Opus (the router-on plan session).
 */
export function advisorPair(env: Record<string, string | undefined>, executorModel?: string): { executor: string; advisor: string } {
  return { executor: executorModel || envOverride(env) || "opus", advisor: ROUTER_ADVISOR_MODEL };
}

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
  pair?: { executor?: string; advisor?: string },
): AdvisorProbe {
  const no = (reason: string): AdvisorProbe => ({ available: false, reason });

  if (provider !== "claude") return no(`provider is ${provider}, not claude`);
  // CH-02: session.ts sets this on every stage Opus did not mark (plan and fix are marked), so it behaves exactly like unavailable.
  if (env["LOKI_ADVISOR_SCOPE"] === "off") return no("advisor not marked for this stage");
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
  const ex = pair?.executor && pair.advisor ? claudeTierRank(pair.executor) : null;
  const ad = pair?.executor && pair.advisor ? claudeTierRank(pair.advisor) : null;
  // A lower rank is a stronger tier: an advisor weaker than its executor adds cost and no judgment.
  if (ex !== null && ad !== null && ad > ex) return no(`invalid_pair: advisor ${pair?.advisor} ranks below executor ${pair?.executor}`);
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
