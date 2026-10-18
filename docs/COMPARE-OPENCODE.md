# Loki Mode and opencode: an honest comparison

opencode is a general-purpose interactive coding agent. Loki is an autonomous
delivery system that works from a task to a verified, receipted result.
They overlap in the terminal and differ in intent, so this page scores them
category by category and says where opencode is ahead. It describes opencode
from its public behavior as of this writing; check its docs for current detail.
Loki can also drive opencode as a provider (`loki start --provider opencode`).

## Summary

| Category | Loki Mode | opencode | Edge |
|---|---|---|---|
| Everyday UX | One command, `loki start`. No task and no repo shows a receipt before any spend. The run prints its autonomy level | Polished TUI as the main surface | opencode for interactive feel; Loki for one command that finishes |
| Install and onboarding | npm install, then `loki start`. No key shows a real receipt. A provider is required only when there is a repo or a task | Single binary or npm, provider login flow | Loki shows proof before it asks for a key |
| Learning curve | `loki start` is the factory. Policy, receipt, and cost route are printed by that command. `loki help` lists the rest | Learn one TUI | Loki if you do not want a second verb |
| Interactive coding | `loki chat`: Plan/Build modes, slash commands, `--attach` | Full TUI with sessions and rich editing flow | opencode |
| Small changes | `loki edit` (one pass, diff, opt-in verify and receipt) | Prompt in the TUI or `opencode run` | Even |
| Provider flexibility | Claude default; codex, cline, aider, opencode; OpenRouter and local routes | Very wide provider catalog, first-class | opencode |
| Local models | `loki models --local`, `LOKI_MODEL_ROUTE=ollama/...`, lmstudio, llamacpp, vllm, custom URL | Local providers via config | Even |
| Multi-agent | Role agents, council review, custom agents in `.loki/agents/*.md`, the run view names the active stage | Configurable agents and subagents | Loki when you want the receipt to name who ran |
| Cost control | Same provider model as a raw session. Tool logs are trimmed before the next turn so a long run does not resend them. `--max-cost` and `budgets.per_run` are hard caps. `--haiku` or `--cost lean` opts the first implement onto haiku; a failed check climbs back | User watches the TUI | Loki when the result has to be a check the model did not grade |
| Proof | Signed receipt, `loki verify`, NOT PROVEN list, and a PR comment. A behavior change is verified only when a Wall test fails on the old code and passes after (`LOKI_MUTATION_STRICT=0` opts out) | The diff in the TUI | Loki |
| Docs consistency | One routing story, one cap rule, generated CLI table | Single product surface | Even |
| Predictability | Order-independent routing, documented exit-code contract, spend cap, STALLED is never a verified receipt | Interactive, user-driven | Loki for unattended use |

## Per category

**Everyday UX.** In opencode you work inside one TUI and watch each step. In
Loki you hand over a task with `loki start` and read one summary at the end:
Result, Files, Cost, Elapsed, Receipt and a `next:` command. If you want to
watch and steer, `loki chat --attach` joins the run. opencode's interactive
experience is more mature.

**Install and onboarding.** opencode installs as one tool and logs in to a
provider. Loki needs Node.js 18+, Python 3.8+, git, jq, curl and a model:
Claude Code is the default and needed for the default path; other CLIs are
optional. `loki setup` walks through it and `loki doctor --fix` repairs state
safely, printing exact commands for the rest. More prerequisites than opencode.

**Learning curve.** `loki help` shows grouped core verbs (Start, Check,
Configure); `loki help all` and `loki help <topic>` go deeper. Flag order and
input form never change the engine, and `loki route` or `--explain-route`
prints the engine, provider, model and reason. Unknown commands suggest the
nearest match and exit 2.

**Interactive coding.** `loki chat` has Plan mode (read-only for Claude) and
Build mode, slash commands (`/run`, `/quick`, `/edit`, `/verify`, `/receipt`,
`/diff`, `/undo`, `/model`, `/provider`) and `--tui` for the Claude Code TUI.
It is newer and smaller than opencode's TUI. Its advantage is the handoff: `/run`
starts a real `loki start` run and `--attach` joins one in progress.

**Small changes.** `loki edit "<change>"` is one pass with no plan, council or
PR, then diff stat, diff, cost and time. `--verify`, `--receipt`, `--commit`
and `--dry-run` are opt-in. Claude provider only for now.

**Provider flexibility.** opencode has the broader provider catalog. Loki's
Tier-1 provider is Claude Code; codex, cline, aider and opencode are optional.
On those, the Loki 10 engine now measures cost (parsed or estimated, flagged
`estimated`) so `--max-cost` applies, and enforces the wall-clock limit,
`BUDGET_LIMIT` kill and a post-iteration guard scan. Kill blocking is still
Claude-only and receipts say so (`kill blocking not enforced`).

**Local models.** `loki models --local` probes Ollama, LM Studio, llama.cpp and
vLLM and prints ready-to-paste values. `LOKI_MODEL_ROUTE=<kind>/<id>` runs a
local or OpenRouter model through the Claude harness, so Loki's controls still
apply. Small local models can fail tool use; that limit is the model's.

**Multi-agent.** Loki has built-in roles and a council. You can add your own
as markdown with frontmatter (model, provider, tools, deny, permission) in
`.loki/agents/`, manage them with `loki agents list|new|show|export --claude`,
and council reviewers use a matching agent automatically.

**Docs consistency.** The prerequisites, the spend cap ($100 with an API key,
none on a subscription), routing and the provider table are stated once and
match the code on this branch.

**Predictability.** One execution path for every input form, a documented
exit-code contract (`loki verify` 0 to 3, usage errors 64) and a spend cap
that applies on every engine10 provider.

## What Loki adds

- **Autonomy.** A task, PRD or issue goes to a pull request without turn-by-turn
  prompting, with a stop-and-ask when the contract cannot be met.
- **Receipts.** A signed receipt per run that `loki verify` re-checks and that
  lists what was NOT PROVEN.
- **Verification.** Checks written from the task before code, a deterministic
  `loki verify` for CI, and test-weakening detection.
- **Council.** Specialist review selected from the changed files and diff.

## Switching from Claude Code or opencode

`loki start` and `loki factory` both run the Loki 10 engine. `--provider opencode` and the default Claude path are the same loop: plan, implement, verify, seal, and a pull request unless you pass `--no-pr`. The receipt is still written with `--no-pr`, and `loki verify` checks it with no network.

There is no transcript importer. A Claude Code or opencode session is not copied in. The handoff is the repository and the task. Inside one Loki run, the plan session resumes into implement unless `LOKI_E10_FIX_RESUME=0`. `loki chat --attach` joins a run that is already going. `loki resume` continues a paused or interrupted run from its checkpoint.

A rate limit is retried. A hard billing failure is not. Repeating the same diff against the same failure stops as STALLED with a receipt, and that receipt is not VERIFIED.

The MCP server and the Claude plugin return the same receipt-capable result as the CLI. Uninstalling Loki removes the command only. Receipts stay in the project's `.loki/runs` and in `~/.loki` until you delete them.

## When to pick which

Pick opencode for hands-on interactive coding across many providers. Pick Loki
when you want to delegate a task and get back a verified, receipted result, or
to gate CI on `loki verify`. They compose: run opencode as a Loki provider.
