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
// buildDevilsAdvocateAgent and is auto-wired as a SEPARATE conditional second
// invocation when the first 3 reach unanimous APPROVE (council.ts fires it via
// dispatchDevilsAdvocate, mirroring the bash trigger at
// completion-council.sh:723). The DA is BLIND (it is not shown the base voters'
// verdicts/reasoning). If the LLM DA dispatch fails, council.ts falls back to
// the deterministic file-scan check (councilDevilsAdvocate) so anti-sycophancy
// is never silently dropped and the loop never hangs.
//
// Public API:
//   AgentSpec                              -- single voter declaration shape
//   buildVoterAgentsJson(cec)              -> Record<slug, AgentSpec>  (3 base)
//   buildDevilsAdvocateAgent(cec)          -> AgentSpec                (1 extra, blind)
//   dispatchClaudeAgents(cec, runner?)     -> Promise<AgentVerdict[]>  (throws on failure)
//   dispatchDevilsAdvocate(cec, runner?)   -> Promise<AgentVerdict>    (blind DA re-review)
//
// On any failure (claude missing, --agents unsupported, --json-schema
// unsupported, parse error), dispatchClaudeAgents throws. The caller
// (councilEvaluate) catches and falls through to the existing heuristic.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AgentVerdict } from "../runner/council.ts";
import type { CouncilEvaluateContext } from "../runner/council.ts";
import { readStreamCapped } from "../util/shell.ts";
import { parseMultiResponse } from "./finding_schema.ts";
import {
  claudeFlagSupported,
  effortForTier,
  ensureClaudeHelpCache,
  reviewAllowlistArgv,
  cavemanSuppressEnv,
} from "../providers/claude_flags.ts";

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

// H6 (W4 bug-hunt): hard timeout on every reviewer subcall so a hung `claude`
// (network stall, stdin wait, deadlock) can NEVER wedge councilEvaluate -- the
// old code awaited `proc.exited` with no bound, so a child that never exits made
// the completion loop hang forever and falsified the "we NEVER hang" invariant.
//
// Read at call time (NOT module load) so a test override of the env var takes
// effect, and so operators can tune it per-run. Default is generous (10min) so
// it only fires on a true hang, never on a legitimately long review.
const DEFAULT_COUNCIL_TIMEOUT_MS = 600_000;
export function councilTimeoutMs(): number {
  const raw = process.env["LOKI_COUNCIL_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return DEFAULT_COUNCIL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COUNCIL_TIMEOUT_MS;
  return n;
}

// Bound a runner call so an injected stub (test) OR the real child cannot wedge
// the council. On timeout we reject with a clear error; the caller treats any
// dispatch rejection as a dispatch failure and falls through to the heuristic /
// deterministic-scan path. The timer is always cleared (finally) so it never
// leaks and the loser-promise never raises an unhandled rejection.
async function withCouncilTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  const ms = councilTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Swallow the loser's rejection so it cannot surface as an unhandled rejection
  // once the race has already settled.
  work.catch(() => {});
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms (LOKI_COUNCIL_TIMEOUT_MS)`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

// Build the conditional 4th voter (anti-sycophancy).
//
// BLIND REVIEW (mirrors bash completion-council.sh:2090-2091, BUG-QG-009):
// the devil's-advocate is deliberately NOT shown the base voters' member
// verdicts/reasons. Leaking the prior votes into the contrarian's prompt
// biases it toward agreement and defeats the anti-sycophancy purpose -- the
// exact bug BUG-QG-009 fixed on the bash route. The DA is told only that the
// council was unanimous APPROVE; it re-derives its own judgment by inspecting
// the repo/evidence directly (it stays blind to the votes, not to the
// evidence -- bash still feeds the evidence file). No `baseFindings` param:
// the function never quotes them, so passing them would be misleading.
export function buildDevilsAdvocateAgent(cec: CouncilEvaluateContext): AgentSpec {
  const iter = cec.iteration;
  const prdHint = readPrdHint(cec.ctx.prdPath);
  const prdLine = prdHint.length > 0 ? `PRD hint: ${prdHint}` : "PRD: (none provided)";

  return {
    description: "Devil's advocate -- skeptical reviewer on unanimous APPROVE.",
    model: "opus",
    effort: "xhigh",
    prompt: [
      `You are the devils-advocate voter for iteration ${iter}.`,
      prdLine,
      "The base council reached unanimous APPROVE. Your job is to push back.",
      "You are NOT shown the base voters' verdicts or reasoning (blind review):",
      "re-derive your own judgment from the evidence so you are not biased to agree.",
      "",
      "Re-inspect the repo, queue files in .loki/queue/, test logs, and recent error events.",
      "Vote REJECT when you find HIGH or CRITICAL signals the base voters may have missed.",
      "Vote APPROVE only when you genuinely cannot find a flaw -- be skeptical.",
      "Vote CANNOT_VALIDATE only when key evidence is unreachable.",
      commonSuffix(VOTER_SLUGS.DEVILS_ADVOCATE),
    ].join("\n"),
  };
}

// Default runner: spawns claude via Bun.spawn. Test code injects a fake.
//
// caveman HARD-SUPPRESS (parsed output): council votes are a trust gate parsed
// for VOTE/findings. A globally-active caveman would compress/reword the verdict
// and silently flip it, so this spawn UNCONDITIONALLY disables caveman with
// CAVEMAN_DEFAULT_MODE=off (mirrors the bash council subcalls in
// completion-council.sh). No-op when caveman is absent.
async function defaultClaudeRunner(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  // H6 (W4 bug-hunt): bound the REAL child with an AbortSignal so a hung claude
  // is killed instead of leaving `await proc.exited` pending forever. Bun.spawn
  // honors `signal`: on timeout it sends SIGTERM, the child exits non-zero (143),
  // proc.exited resolves, and the existing `exitCode !== 0` check throws so the
  // caller falls through to the heuristic. AbortSignal.timeout self-cleans (no
  // manual timer to leak). The dispatch-level withCouncilTimeout() race is a
  // second, runner-agnostic guard (it also bounds an injected hanging stub, which
  // has no child handle to kill); the two layers are intentionally distinct.
  //
  // stderr is set to "ignore" (it was "pipe" but never read): an unread "pipe"
  // can deadlock a chatty child once the OS pipe buffer fills. stdout is the only
  // stream consumed.
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(councilTimeoutMs()),
    env: { ...process.env, CAVEMAN_DEFAULT_MODE: cavemanSuppressEnv() },
  });
  // v7.77.0 (W77-D LOW): bounded read so a runaway claude child cannot OOM the
  // parent. The AbortSignal.timeout above still bounds wall-clock; this only
  // bounds heap. Verdict output is tiny in practice, well under the cap.
  const stdout = await readStreamCapped(proc.stdout as ReadableStream<Uint8Array>);
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
  // / voter agent should not casually mutate the working tree (a parallel agent
  // once ran `git reset --hard` and wiped uncommitted work).
  // Deny Edit/Write/NotebookEdit
  // + git MUTATION forms incl. the git -C / --git-dir / -c evasions; read-only
  // git (diff/log/show/status) stays allowed so the voter can still inspect the
  // tree. A guardrail (raises the cost of the common destructive command), not a
  // sandbox -- echo>/sed -i/etc. remain. Default-ON; opt out with
  // LOKI_REVIEW_TOOL_GUARD=0. Gated on CLI support. NOTE: --bare (Embed 2) is
  // deliberately NOT applied to this voter path: it relies on auto-discovered
  // context (CLAUDE.md/hooks) that --bare drops, which could change voter
  // judgment. Mirrors loki_review_guard_denylist in autonomy/lib/claude-flags.sh.
  if (
    process.env["LOKI_REVIEW_TOOL_GUARD"] !== "0" &&
    claudeFlagSupported("--disallowedTools")
  ) {
    argv.push(
      "--disallowedTools",
      "Edit,Write,NotebookEdit,Bash(git commit:*),Bash(git reset:*),Bash(git push:*),Bash(git checkout:*),Bash(git clean:*),Bash(git rm:*),Bash(git stash:*),Bash(git -C:*),Bash(git --git-dir:*),Bash(git -c:*)",
    );
  }
  // EMBED 3b (v7.35.0, #167): positive --allowedTools least-privilege grant.
  // DEFAULT OFF (opt-in LOKI_REVIEW_ALLOWLIST=1). Emitted ALONGSIDE the denylist:
  // verified live that deny precedence holds (deny wins over allow even under
  // --dangerously-skip-permissions), so the denylist still hard-blocks every
  // mutation form while this narrows the in-context surface to read/inspect
  // tools. reviewAllowlistArgv() returns [] when disabled / CLI-unsupported, so
  // the default argv stays byte-identical. Mirrors the bash call sites
  // (run.sh reviewer + adversarial) and loki_review_allowlist.
  argv.push(...reviewAllowlistArgv());
  argv.push("-p", topPrompt);

  // H6: bound the subcall. A hung runner rejects here -> caller falls through.
  const result = await withCouncilTimeout(runner(argv), "council voter dispatch");
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

// dispatchDevilsAdvocate -- single-shot LLM anti-sycophancy re-review.
//
// Mirrors the bash council_devils_advocate provider call
// (completion-council.sh:2074-2170): on a unanimous APPROVE, invoke ONE
// contrarian reviewer (model=opus, effort=xhigh) and parse a single
// schema-validated finding. The reviewer is BLIND to the base votes (see
// buildDevilsAdvocateAgent / BUG-QG-009) and inspects the repo directly.
//
// Throws on any failure (claude missing, --agents/--json-schema unsupported,
// non-zero exit, malformed/empty/multi response). The caller
// (councilEvaluate) catches the throw and degrades to the deterministic
// councilDevilsAdvocate scan -- it never upholds a unanimous APPROVE on a DA
// dispatch failure (that would silently drop anti-sycophancy).
//
// Returns the contrarian AgentVerdict with role normalized to the underscore
// form "devils_advocate" so the appended vote matches the deterministic-scan
// role string used elsewhere on the council path.
export async function dispatchDevilsAdvocate(
  cec: CouncilEvaluateContext,
  claudeRunner?: ClaudeRunner,
): Promise<AgentVerdict> {
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

  const daAgent = buildDevilsAdvocateAgent(cec);
  const agentsJson: Record<string, AgentSpec> = {
    [VOTER_SLUGS.DEVILS_ADVOCATE]: daAgent,
  };
  const schemaPath = findingSchemaPath();

  const topPrompt = [
    `Iteration ${cec.iteration} anti-sycophancy re-review.`,
    "The base council reached unanimous APPROVE. Dispatch the devils-advocate agent.",
    "Return ONE JSON object with a 'findings' array containing exactly one entry.",
    "The JSON must conform to the schema passed via --json-schema.",
  ].join("\n");

  // Same trust-gate hardening as dispatchClaudeAgents: voters never go through
  // buildAutoFlags (no autonomy override that would bias toward APPROVE), and
  // the tree-mutation guard / least-privilege allowlist apply identically.
  const argv = [
    "claude",
    "--dangerously-skip-permissions",
    "--agents",
    JSON.stringify(agentsJson),
    "--json-schema",
    schemaPath,
  ];
  if (
    process.env["LOKI_REVIEW_TOOL_GUARD"] !== "0" &&
    claudeFlagSupported("--disallowedTools")
  ) {
    argv.push(
      "--disallowedTools",
      "Edit,Write,NotebookEdit,Bash(git commit:*),Bash(git reset:*),Bash(git push:*),Bash(git checkout:*),Bash(git clean:*),Bash(git rm:*),Bash(git stash:*),Bash(git -C:*),Bash(git --git-dir:*),Bash(git -c:*)",
    );
  }
  argv.push(...reviewAllowlistArgv());
  argv.push("-p", topPrompt);

  // H6: bound the subcall. A hung runner rejects here -> caller falls through
  // to the deterministic file-scan councilDevilsAdvocate (never a silent uphold).
  const result = await withCouncilTimeout(runner(argv), "council devil's-advocate dispatch");
  if (result.exitCode !== 0) {
    throw new Error(`claude exited with code ${result.exitCode}`);
  }
  const verdicts = parseMultiResponse(result.stdout);
  // Exactly one DA finding expected. Best-effort: prefer the devils-advocate
  // slug, but accept the first finding if the model emitted a different role
  // string (this is a single-voter dispatch, so any finding is the DA's). This
  // is intentionally looser than dispatchClaudeAgents' strict missing-slug
  // throw -- there is only one voter here, so a slug mismatch is not ambiguous.
  const da = verdicts.find((v) => v.role === VOTER_SLUGS.DEVILS_ADVOCATE) ?? verdicts[0];
  if (da === undefined) {
    throw new Error("devil's advocate response contained no finding");
  }
  // Normalize role to the underscore form used by the deterministic scan so
  // the appended council vote is consistent regardless of which path produced it.
  return { ...da, role: "devils_advocate" };
}
