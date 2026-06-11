// loki-ts/src/council/voter_agents.ts -- Phase C (v7.5.20) helpers.
//
// Builds the `--agents <json>` payload Claude Code consumes plus a thin
// dispatcher that invokes claude, parses the structured response, and
// returns AgentVerdict[] for council.ts to aggregate.
//
// Voter roster (architect design Phase C):
//   - requirements-verifier  (model=opus,   effort=high)
//   - test-auditor           (model=sonnet, effort=high)
//   - convergence-voter      (model=sonnet, effort=medium)
//   - devils-advocate        (model=opus,   effort=xhigh)  -- conditional 4th
//
// The 3 base voters always run. The 4th (devils-advocate) is constructed via
// buildDevilsAdvocateAgent and is intended as a SEPARATE conditional second
// invocation when the first 3 reach unanimous APPROVE. The current Phase C
// implementation does NOT auto-wire the 4th call -- it is exposed as a typed
// primitive so a follow-up patch (or test) can drive it directly. The
// existing councilEvaluate() devil's advocate is the deterministic
// file-scan-based check at council.ts:293+; we are not replacing it here.
//
// Public API:
//   AgentSpec                              -- single voter declaration shape
//   buildVoterAgentsJson(cec)              -> Record<slug, AgentSpec>  (3 base)
//   buildDevilsAdvocateAgent(cec, base)    -> AgentSpec                (1 extra)
//   dispatchClaudeAgents(cec, runner?)     -> Promise<AgentVerdict[]>  (throws on failure)
//
// On any failure (claude missing, --agents unsupported, --json-schema
// unsupported, parse error), dispatchClaudeAgents throws. The caller
// (councilEvaluate) catches and falls through to the existing heuristic.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AgentVerdict } from "../runner/council.ts";
import type { CouncilEvaluateContext } from "../runner/council.ts";
import { parseMultiResponse } from "./finding_schema.ts";
import { claudeFlagSupported, effortForTier, ensureClaudeHelpCache } from "../providers/claude_flags.ts";

export type AgentSpec = {
  description: string;
  prompt: string;
  model?: string;
  effort?: string;
  tools?: string[];
  permissionMode?: string;
};

// Slug constants -- kept here so tests can assert on the exact strings.
export const VOTER_SLUGS = {
  REQUIREMENTS_VERIFIER: "requirements-verifier",
  TEST_AUDITOR: "test-auditor",
  CONVERGENCE_VOTER: "convergence-voter",
  DEVILS_ADVOCATE: "devils-advocate",
} as const;

// Injectable Claude runner -- production code uses Bun.spawn; tests inject.
export type ClaudeRunner = (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;

// Best-effort PRD snippet for prompt grounding. Reads up to first 200 chars,
// strips leading/trailing whitespace. Returns "" when not available.
function readPrdHint(prdPath: string | undefined): string {
  if (!prdPath) return "";
  try {
    if (!existsSync(prdPath)) return "";
    return readFileSync(prdPath, "utf8").slice(0, 200).trim();
  } catch {
    return "";
  }
}

// Shared prompt suffix telling each voter to emit only the finding for its
// own role and to stay inside the schema. The umbrella `--json-schema`
// validation enforces the top-level wrapper; this suffix narrows behaviour
// per voter so the multi-finding response is well-formed.
function commonSuffix(slug: string): string {
  return [
    "",
    `Your role slug is "${slug}". Emit exactly one finding with role=${slug}.`,
    "Return ONLY the JSON object {\"findings\":[...]} matching the provided --json-schema.",
    "Do not wrap in markdown fences. Do not add prose before or after the JSON.",
  ].join("\n");
}

// Build the 3-voter base set Claude consumes via --agents <json>.
// CEC inputs used: iteration number, ctx.prdPath for grounding hints.
export function buildVoterAgentsJson(cec: CouncilEvaluateContext): Record<string, AgentSpec> {
  const iter = cec.iteration;
  const prdHint = readPrdHint(cec.ctx.prdPath);
  const prdLine = prdHint.length > 0 ? `PRD hint: ${prdHint}` : "PRD: (none provided)";

  // Effort per voter -- architect design says high/high/medium for the base trio.
  // We reuse effortForTier so a future complexity bump cascades through.
  const tier = cec.ctx.currentTier ?? "development";
  const baseHigh = effortForTier(tier === "fast" ? "development" : tier);
  // Convergence-voter is medium by intent (cheap signal); use 'fast' tier mapping.
  const convergenceEffort = effortForTier("fast");

  const reqVerifier: AgentSpec = {
    description: "Requirements verifier -- checks current state against the PRD requirements.",
    model: "opus",
    effort: baseHigh,
    prompt: [
      `You are the requirements-verifier voter for iteration ${iter}.`,
      prdLine,
      "Inspect the working tree, queue files in .loki/queue/, and most recent test logs.",
      "Decide whether the current state satisfies the PRD requirements.",
      "Vote APPROVE only when each named requirement has supporting evidence in the repo.",
      "Vote REJECT when at least one named requirement is missing or violated; include an issue per gap.",
      "Vote CANNOT_VALIDATE when the PRD is missing, ambiguous, or the repo state cannot be inspected.",
      commonSuffix(VOTER_SLUGS.REQUIREMENTS_VERIFIER),
    ].join("\n"),
  };

  const testAuditor: AgentSpec = {
    description: "Test auditor -- inspects test logs and gate outcomes.",
    model: "sonnet",
    effort: baseHigh,
    prompt: [
      `You are the test-auditor voter for iteration ${iter}.`,
      prdLine,
      "Inspect .loki/logs/*test*.log and .loki/quality/ for the latest gate outcomes.",
      "Vote APPROVE when test logs exist and show a clean pass marker.",
      "Vote REJECT when tests are missing, failing, or carry HIGH severity issues; include an issue per failure.",
      "Vote CANNOT_VALIDATE when log inspection is blocked or no test infrastructure exists yet.",
      commonSuffix(VOTER_SLUGS.TEST_AUDITOR),
    ].join("\n"),
  };

  const convergenceVoter: AgentSpec = {
    description: "Convergence voter -- monitors iteration delta and stagnation signals.",
    model: "sonnet",
    effort: convergenceEffort,
    prompt: [
      `You are the convergence-voter for iteration ${iter}.`,
      prdLine,
      "Inspect .loki/council/convergence.log (recent rows) and .loki/state/.",
      "Vote APPROVE when the iteration delta is stable AND no new churn is visible.",
      "Vote REJECT when convergence is regressing (more failing tasks than last iteration).",
      "Vote CANNOT_VALIDATE when convergence history is too short to judge (fewer than 2 rows).",
      commonSuffix(VOTER_SLUGS.CONVERGENCE_VOTER),
    ].join("\n"),
  };

  return {
    [VOTER_SLUGS.REQUIREMENTS_VERIFIER]: reqVerifier,
    [VOTER_SLUGS.TEST_AUDITOR]: testAuditor,
    [VOTER_SLUGS.CONVERGENCE_VOTER]: convergenceVoter,
  };
}

// Build the conditional 4th voter (anti-sycophancy). Caller supplies the
// already-collected base findings so the prompt can quote them and push back.
export function buildDevilsAdvocateAgent(
  cec: CouncilEvaluateContext,
  baseFindings: readonly AgentVerdict[],
): AgentSpec {
  const iter = cec.iteration;
  // Compact summary of the base findings -- one line each, capped per line.
  const baseSummary = baseFindings
    .map((f) => {
      const reason = f.reason.length > 200 ? f.reason.slice(0, 200) + "..." : f.reason;
      return `- ${f.role}: ${f.verdict} -- ${reason}`;
    })
    .join("\n");

  return {
    description: "Devil's advocate -- skeptical reviewer on unanimous APPROVE.",
    model: "opus",
    effort: "xhigh",
    prompt: [
      `You are the devils-advocate voter for iteration ${iter}.`,
      "The base voters reached unanimous APPROVE. Your job is to push back.",
      "",
      "Base findings under review:",
      baseSummary,
      "",
      "Re-inspect the repo, queue files, test logs, and recent error events.",
      "Vote REJECT when you find HIGH or CRITICAL signals the base voters missed.",
      "Vote APPROVE only when you genuinely cannot find a flaw -- be skeptical.",
      "Vote CANNOT_VALIDATE only when key evidence is unreachable.",
      commonSuffix(VOTER_SLUGS.DEVILS_ADVOCATE),
    ].join("\n"),
  };
}

// Default runner: spawns claude via Bun.spawn. Test code injects a fake.
async function defaultClaudeRunner(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

// Resolve the static schema path relative to this module so the same file
// powers both bash and Bun routes (architect design Phase C).
function findingSchemaPath(): string {
  // Up two dirs from src/council/ to loki-ts/, then into data/.
  return resolvePath(import.meta.dir, "..", "..", "data", "finding-schema.json");
}

// Single-shot Claude invocation that declares all 3 base voters and asks for
// a schema-validated multi-finding response. Throws on any failure so the
// caller (councilEvaluate) can fall through to the existing heuristic.
//
// Contract:
//   - Validates --agents + --json-schema support via claudeFlagSupported.
//     When the cache is empty AND no runner is injected, we initialize it.
//     When a runner IS injected (tests), we trust the caller and skip the
//     support check -- the test driver controls everything.
//   - Builds the agents JSON payload, writes it to argv (inline, not file).
//   - Returns AgentVerdict[] with exactly the count of base voters (3).
export async function dispatchClaudeAgents(
  cec: CouncilEvaluateContext,
  claudeRunner?: ClaudeRunner,
): Promise<AgentVerdict[]> {
  const runner = claudeRunner ?? defaultClaudeRunner;
  const injected = claudeRunner !== undefined;

  if (!injected) {
    await ensureClaudeHelpCache();
    if (!claudeFlagSupported("--agents")) {
      throw new Error("claude CLI does not support --agents");
    }
    if (!claudeFlagSupported("--json-schema")) {
      throw new Error("claude CLI does not support --json-schema");
    }
  }

  const agentsJson = buildVoterAgentsJson(cec);
  const schemaPath = findingSchemaPath();

  // Minimal prompt: the agents declare the per-voter detail; the top-level
  // prompt tells Claude to produce the multi-finding wrapper.
  const topPrompt = [
    `Iteration ${cec.iteration} council evaluation.`,
    "Dispatch each declared voter agent in parallel. Collect their findings.",
    "Return ONE JSON object with a 'findings' array containing one entry per voter.",
    "The JSON must conform to the schema passed via --json-schema.",
  ].join("\n");

  // NOTE (v7.7.31): council voters deliberately do NOT go through
  // buildAutoFlags(), so they never receive the --append-system-prompt autonomy
  // override. A reviewer/judge must keep its ability to say "not done" or raise
  // a CONCERN; injecting "do NOT refuse, do NOT ask" would bias voters toward
  // APPROVE and defeat the council's adversarial purpose. Do not route voters
  // through the auto-flags builder.
  const argv = [
    "claude",
    "--dangerously-skip-permissions",
    "--agents",
    JSON.stringify(agentsJson),
    "--json-schema",
    schemaPath,
  ];
  // EMBED 3 (v7.33.0): --disallowedTools on the council voter argv. A reviewer
  // / voter agent must NEVER mutate the working tree (a parallel agent once ran
  // `git reset --hard` and wiped uncommitted work). Deny Edit/Write/NotebookEdit
  // + git MUTATION subcommands only; read-only git (diff/log/show/status) stays
  // allowed so the voter can still inspect the tree. Default-ON; opt out with
  // LOKI_REVIEW_TOOL_GUARD=0. Gated on CLI support. NOTE: --bare (Embed 2) is
  // deliberately NOT applied here -- per `claude --help`, --bare nullifies
  // --agents, which this voter argv is built around. Mirrors the bash reviewer/
  // adversarial sites in autonomy/run.sh and loki_review_guard_denylist.
  if (
    process.env["LOKI_REVIEW_TOOL_GUARD"] !== "0" &&
    claudeFlagSupported("--disallowedTools")
  ) {
    argv.push(
      "--disallowedTools",
      "Edit,Write,NotebookEdit,Bash(git commit*),Bash(git reset*),Bash(git push*),Bash(git checkout*),Bash(git clean*),Bash(git rm*),Bash(git stash*)",
    );
  }
  argv.push("-p", topPrompt);

  const result = await runner(argv);
  if (result.exitCode !== 0) {
    throw new Error(`claude exited with code ${result.exitCode}`);
  }
  // parseMultiResponse throws on any malformed / schema-violating output.
  const verdicts = parseMultiResponse(result.stdout);
  // Ensure each declared voter is represented. If Claude omitted one,
  // we treat the whole response as invalid so the caller falls through.
  const expectedSlugs = Object.keys(agentsJson);
  const seen = new Set(verdicts.map((v) => v.role));
  for (const slug of expectedSlugs) {
    if (!seen.has(slug)) {
      throw new Error(`response missing finding for voter slug ${slug}`);
    }
  }
  return verdicts;
}
