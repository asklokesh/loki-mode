<div align="center">

# Loki Mode

### The spec-driven autonomous builder with verified completion.

_The free, source-available autonomous coding agent by [Autonomi](https://www.autonomi.dev/). Same Loki CLI, SDK, and MCP for everyone; the commercial editions for teams and enterprises are sold under the **Autonomi** brand (Autonomi Cloud, Autonomi Enterprise)._

**Hand it a spec. It does not accept "done" on an empty diff or failing tests.**

[![npm version](https://img.shields.io/npm/v/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=553DE9)](https://www.npmjs.com/package/loki-mode)
[![npm downloads](https://img.shields.io/npm/dt/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=1FC5A8&label=downloads)](https://www.npmjs.com/package/loki-mode)
[![Docker Pulls](https://img.shields.io/docker/pulls/asklokesh/loki-mode?style=for-the-badge&logo=docker&logoColor=white&color=2F71E3)](https://hub.docker.com/r/asklokesh/loki-mode)
[![License](https://img.shields.io/badge/License-BUSL--1.1-36342E?style=for-the-badge)](LICENSE)

[Website](https://www.autonomi.dev/) | [Documentation](wiki/Home.md) | [Installation](docs/INSTALLATION.md) | [Changelog](CHANGELOG.md)

**Current release: v9.16.0**

</div>

---

## Install

```bash
bun install -g loki-mode          # recommended (npm, Homebrew, Docker below)
```

<details>
<summary>Other install methods</summary>

| Method | Command | Notes |
|--------|---------|-------|
| **Bun (recommended)** | `bun install -g loki-mode` | Fastest startup for CLI commands. |
| **npm** | `npm install -g loki-mode` | Works without Bun (bash fallback). Migrate any time with `loki self-update --to bun`. |
| **Homebrew** | `brew tap asklokesh/tap && brew install loki-mode` | Auto-installs Bun as a dep. |
| **Docker** | `docker pull asklokesh/loki-mode:latest` | Bun + Claude CLI pre-installed. See [DOCKER_README.md](DOCKER_README.md). |

Upgrade with `loki self-update`. Long form: [Installation Guide](docs/INSTALLATION.md).

</details>

## Use it

```bash
loki quickstart                   # guided first build: asks a few questions, quotes cost, builds
```

That is the whole happy path. It asks for a one-line idea, picks a template,
shows the real cost and time estimate before spending anything, then builds.
Press Enter through every step and you get a sample Todo app.

One command, no prompts (CI, scripts, containers, any shell without a terminal):

```bash
loki quickstart "a todo app with user accounts" --yes
```

Both halves are required with no terminal: an idea (or a path to a PRD file)
and an explicit `--yes`. Given both, Loki picks the top-ranked template
automatically, prints the same honest cost and time estimate, and starts the
build without asking anything. Missing either half exits 2 with the
needs-a-terminal message and writes nothing, so an ambient `LOKI_AUTO_CONFIRM`
or a stray argument in CI can never start a paid build on its own. Existing
files are never overwritten: if `prd.md` is present the PRD lands at
`prd-quickstart.md`, then numbered suffixes as needed.

Choose an exact shipped starter when the top-ranked match is not the one you
want:

```bash
loki quickstart --list-templates
loki quickstart --list-templates --json       # schema-v1 automation output
loki quickstart "an internal reporting workspace" --template dashboard --yes
```

Template discovery works without a terminal or provider and lists every shipped
starter's stable name and purpose in catalog order. It returns before estimation,
consent, PRD writes, or build execution. Positional input and execution/preview
flags are intentionally incompatible; `--json` is the only optional modifier.

`--template` accepts an exact template name for idea inputs and works the same
way with interactive use or `--dry-run` (including JSON preview). Unknown
templates, duplicate flags, and combinations with a PRD path refuse before
provider discovery, estimation, writes, or build execution.

Preview the same deterministic template choice and estimator-backed plan with
zero writes or execution:

```bash
loki quickstart "a todo app with user accounts" --dry-run
```

Preview requires an idea or readable PRD path, works without a terminal or AI
provider, and exits before creating a PRD or starting a build. `--dry-run` and
`--yes` are mutually exclusive so execution intent is never ambiguous.

For scripts and local dashboards, add `--json` to receive one versioned JSON
object instead of terminal text:

```bash
loki quickstart "a todo app with user accounts" --dry-run --json > preview.json
loki quickstart --from-preview preview.json --yes
```

The object contains the input kind, deterministic selected template (or `null`
for an existing PRD), the exact estimator response under `plan`, and a bounded
continuation containing the exact idea/template or the PRD path and SHA-256.
`--from-preview` requires explicit argv `--yes`, rejects malformed, conflicting,
symlinked, or changed inputs before provider and build boundaries, then uses the
existing no-clobber quickstart path. The saved plan is evidence rather than
execution authority: Loki recomputes and displays the current estimate before
starting. `--json` requires `--dry-run`; invalid input or estimator failure
writes no JSON, and preview still exits before provider discovery, file writes,
or build execution.

Or go straight at it:

```bash
loki quick "build a landing page with a signup form"     # one-shot task
loki start prd.md                                        # build from a spec you wrote
loki modernize heal ./your-repo --assess                 # existing codebase, read-only
```

**Loki needs a model to drive.** An `ANTHROPIC_API_KEY` alone is enough (the
Claude Agent SDK ships inside Loki); or point it at Claude Code, aider, cline,
or an open model. Run `loki doctor` and it tells you exactly what is missing.

```bash
export ANTHROPIC_API_KEY=sk-...
loki doctor                       # checks your setup, names any blocker
```

## Try it first, without installing

```bash
npx loki-mode tour                # no install, no API key, no spend, no network
```

Prints a real Evidence Receipt from a past build, headline and all:

```
Headline: VERIFIED WITH GAPS

| Fact          | Value                                    |
| Files changed | 8                                        |
| Diff sha256   | c2be6fff3e774c387f276277b25fc424f07b667… |
| Tests         | verified (node-test)                     |
| Build         | not_run                                  |
| Security      | findings                                 |
| Cost          | $10.3218                                 |
```

**"WITH GAPS" is the point.** Build was not run, security has findings, and the
receipt says so on its own front page. Recompute the diff hash yourself and
check it matches -- you are not asked to trust the agent's self-report.

---

> **How it works:** Drop a spec -- a PRD, GitHub issue, OpenAPI/JSON/YAML, or one-line brief. Loki Mode classifies complexity (`run.sh:detect_complexity()`), assembles an agent team from 41 specialized agent roles across 8 domains - prompt-defined specifications the orchestrator adopts per phase, with parallel review (blind council) and optional worktree streams on Claude Code, sequential on other providers - and runs autonomous RARV cycles (Reason - Act - Reflect - Verify, see `run.sh:run_autonomous()`) with 8 quality gates (see `skills/quality-gates.md`). Code is not "done" until it passes automated verification. Output is a Git repo with source, tests, configs, and audit logs.

---

<details>
<summary><b>Why verified completion matters</b> -- the failure this exists to fix</summary>

Self-reported completion is the failure users actually hit. A survey of the
open issue trackers of seven coding harnesses (OpenHands, Cline, Aider,
SWE-agent, Roo-Code, OpenCode, Continue) found the recurring complaint is the
agent silently not doing the work -- "always stuck at Preparing write"
([opencode#11112](https://github.com/anomalyco/opencode/issues/11112), 76
comments), "Continue not making changes to code"
([continue#7143](https://github.com/continuedev/continue/issues/7143)), "Agent
does not execute functions"
([continue#5696](https://github.com/continuedev/continue/issues/5696)). None of
those seven publishes a machine-checkable completion artifact.

We measured every named competitor that ships a local CLI -- opencode 1.18.9,
aider 0.86.2, codex-cli 0.146.0, Claude Code 2.1.220, cursor-agent -- and none
exposes a command that verifies the agent's own output. Rerun it yourself with
`bash tests/test-competitor-verify-surface.sh`.

That is a measurement of the CLI surface, not of whole products: a web UI or an
API could expose something `--help` does not, and Devin and Replit Agent ship no
local CLI so they are not covered.

**Evaluating this against something else?** [docs/EVALUATING.md](docs/EVALUATING.md)
puts a runnable command next to every claim we make, and states plainly what we
do not have (no enterprise case studies, no independent benchmark placement, and
generation is not air-gapped). It ends with the one question worth asking any
agent vendor, including us.

</details>

## Already have a codebase? Start read-only.

Most agents are built to create new apps. The harder, more valuable problem is
the ten-year-old repo that pays the bills. Loki works on both, and on an
existing codebase it starts by **changing nothing**:

```bash
loki modernize heal ./your-repo --assess          # read-only. no writes, no commits.
loki modernize heal ./your-repo --assess --json   # same, machine-readable
```

You get a modernization readiness report: language mix, a 4-level maturity
rating, technical-debt signals (test coverage, TODO density, oversized files,
dependency staleness), and a **ranked list of where to start** -- ordered by
blast radius, so the first change is the one least likely to break something.

Then, if you want it to act:

```bash
loki modernize heal ./your-repo --strict          # block ALL behavioral change without approval
loki modernize heal ./your-repo --phase archaeology   # extract knowledge only
loki modernize heal ./your-repo --compliance healthcare   # or fintech | government
```

The healing pipeline runs in phases -- archaeology, stabilize, isolate,
modernize, validate -- and the validate phase checks **behavioral equivalence
against the pre-change baseline**, not just that the tests are green. Friction
points (the weird code that exists for a reason nobody remembers) are cataloged
before anything touches them, because in a legacy system the strange code is
usually load-bearing.

## The Evidence Receipt: don't trust the agent, check it

Every coding agent tells you it finished. Loki hands you something you can
check yourself.

**We are not the only tool that checks its own work, and you should be
suspicious of anyone who claims to be.** Lovable runs a security scan on every
publish and can block the publish outright. Claude Code's review has a step that
checks findings against actual code behavior. Replit says its agent tests its
own work.

The difference is what you are left holding. Their output lives in their
dashboard: a findings count in a dialog, a check run that by design never blocks
a merge. Ours is a **file**. It is bound to a specific diff by `diff_sha256`, it
records what was NOT proven as prominently as what was, and someone who has
never installed Loki can re-verify it from the repository alone. Commit it,
attach it to the PR, hand it to an auditor.

Portable, diff-bound, and honest about its gaps -- that is the claim, and it is
the one worth checking.

Each run writes a receipt to `.loki/proofs/<run_id>/` that separates
**deterministic FACTS** (the git diff with base and head SHAs plus a
`diff_sha256`, the test command and its exit code, the build command and its
exit code, each gate verdict) from **AI ASSESSMENTS** (the council verdict,
labeled as judgment, never as proof). The headline is computed from the facts
alone:

| Headline | Means |
|---|---|
| VERIFIED | tests ran a real command and exited 0, diff non-empty, nothing skipped |
| VERIFIED WITH GAPS | each gap listed by name |
| NOT VERIFIED | a check ran and failed |

```bash
loki proof list            # every receipt from this project
loki proof show <id>       # the facts, the assessments, and the headline
loki proof verify <id>     # re-hash the receipt and re-derive the diff
```

`loki proof verify` exits 0 clean, 1 on tamper or drift. Receipts are attached
to pull requests automatically (`LOKI_PROVEN_PR=0` to opt out), so a reviewer
sees the evidence next to the code.

**What the receipt does NOT claim.** On the unsigned path the generator is
trusted: someone who rewrites both the facts and the headline into a mutually
consistent lie and recomputes the hash will still pass verification. That is
defense-in-depth, not non-forgeability, and neutral non-forgeability needs the
signed record. We tested for exactly this and locked the limitation into the
suite (`tests/test-proof-forgery-defense.sh`), and in v7.111.0 we removed our
own earlier "non-forgeable" claim once we found it was false on that path. An
honest boundary you can verify beats a marketing claim you cannot.

To close that gap, sign your receipts: `export LOKI_PROOF_GPG_KEY=<key-id>` and
every receipt carries a detached GPG signature that any third party with your
public key can verify offline. See [docs/SIGNED-RECEIPTS.md](docs/SIGNED-RECEIPTS.md).

## Why Loki Mode?

- **Spec-driven, autonomous, with a built-in trust layer** -- Hand Loki a spec, walk away, come back to working code with tests. The full RARV-C closure loop (Reason - Act - Reflect - Verify - Close) runs until the work is actually done, not just attempted. The verified-completion evidence gate (`skills/quality-gates.md`) refuses any "done" claim on an empty git diff against the run-start commit, blocks completion when tests run red, and (v8.0.0) also blocks when a serveable app is confirmed unhealthy (runtime-boot axis, opt out `LOKI_EVIDENCE_BOOT_GATE=0`) or a credential is detected in the changed files (secret-leak axis, opt out `LOKI_EVIDENCE_SECRET_GATE=0`), so "complete" means proven, not promised.
- **A checklist verifier that is honest, not brittle** -- Each completion checklist item is checked deterministically before the completion council will accept "done". The verifier speaks extended regex (`grep -E`) so real LLM-emitted patterns match instead of erroring, and it is runner-agnostic: it runs the project's own declared test command rather than assuming a fixed runner. Crucially, a check that cannot be established is reported as inconclusive (pending), never as a false pass and never as a false failure. `rc == 0` alone is not a pass; a test check goes green only on a real "N passed" signal from the runner (v7.121.x).
- **Production quality built in** -- 8 quality gates (`skills/quality-gates.md`), blind 3-reviewer code review (`run.sh:run_code_review()`), anti-sycophancy checks
- **Standalone verification: `loki verify`** -- Run Loki's deterministic gates (build, tests, static analysis, secret scan, dependency audit) against any branch or PR diff, including code written by other agents or humans. CI-ready exit codes (0 VERIFIED, 1 CONCERNS, 2 BLOCKED), machine-readable evidence at `.loki/verify/evidence.json`. Inconclusive evidence is never reported as VERIFIED (v7.27.0).
- **Living spec and pre-build interrogation** -- `loki spec` locks a spec and detects drift deterministically (`spec.lock`, `drift-report.json`, and a `SPEC_DRIFT` finding in `loki verify` with CI exit codes), so you can tell when the build diverges from what was agreed. For an OpenAPI/GraphQL/Postman contract it locks one requirement per operation with a per-operation hash, so a single changed response schema drifts exactly that operationId (v8.0.0). `loki grill` runs a Devil's-Advocate interrogation of the spec before you build, surfacing gaps and contradictions early (v7.28.0).
- **Mid-flight model switching** -- switch the model a live run uses from the dashboard (applies at the next iteration, current run only). A Fable tier lever exists in the CLI, dashboard, and override paths, but Claude Fable 5 is not yet available at the API, so selecting Fable currently collapses to Opus at every dispatch chokepoint and the `loki plan` quote reflects Opus accordingly. For every model lever (session pin, mid-flight override, architect pass) and every `LOKI_MAX_TIER` path, the `loki plan` quote, the dashboard's reported model, and the actual dispatched model agree, with the ceiling enforced (v7.31.0; Fable-to-Opus collapse v7.39.1).
- **A calmer CLI** -- the help surface is ~20 grouped workflow entries instead of a 70-command wall; merged commands live on as aliases that forward byte-identically with a one-line stderr pointer, so no script breaks (v7.31.0).
- **Guided first build: `loki quickstart`** -- four quick questions (setup check, one-line idea, template pick, plan review) and your build starts; pressing Enter through every step builds the sample Todo app. The plan step quotes the real cost/time estimate before anything is spent, and `loki demo` now confirms its estimate the same way. If no AI provider CLI is installed, Loki offers to install Claude Code (consent-gated, interactive terminals only) (v7.29.0).
- **Live App Preview** -- The dashboard embeds the locally-running app in an iframe so you can interact with it immediately during a build. Use `loki preview` (alias `loki open`) to print the URL and open it in your browser. Local-first: no hosted service, no vendor lock (v7.24.0).
- **Compose-first fullstack** -- When a spec needs more than one service (web + database + cache) Loki generates a 12-factor `docker-compose.yml` with healthchecks, `depends_on` wiring, env-var config, and a `.env.example`. The Live App Preview surfaces the web service URL (not a database port), and health reflects the web service's Docker healthcheck so a crashed app shows as crashed even when the database stays up. Single-service apps stay on a plain run command. All local-first, no hosted service (v7.26.0).
- **Intelligent `loki start`** -- For interactive foreground runs the dashboard auto-opens in the browser (cross-platform; skipped in CI, SSH-without-TTY, and piped runs; opt out with `LOKI_NO_AUTO_OPEN=1`). The completion summary shows "Your app is live at <url>" so you know exactly where to try what Loki just built. The autonomous loop passes Claude Code's `--effort`, `--max-budget-usd`, and `--fallback-model` on every iteration (each gated on CLI support and individual opt-out env vars) for better long-run unattended execution (v7.25.0).
- **Confidence is not evidence** -- When the agent's self-reported confidence spikes to near-certainty, Loki forces an EXTRA verification pass before accepting a stop, rather than taking the claim at face value. Strictly additive: high confidence makes the engine look harder, never less hard, and it can never skip or satisfy a gate (v8.0.0, opt out `LOKI_CONFIDENCE_SPIKE=0`).
- **Goals it can actually measure** -- A goal with no checkable success condition ("make it fast") gives the loop no gradient: every iteration can claim progress and none can be verified. Loki flags an un-measurable goal up front and asks for a threshold, a metric, or a concrete artifact. Advisory only, and never rewrites your goal (v8.0.0, opt out `LOKI_GOAL_SCORING=0`).
- **Stops paying for failures that cannot succeed** -- A positively-identified permanent failure (bad credentials, unknown model, exhausted quota) exits immediately instead of burning the retry budget on guaranteed-identical failures. Fail-safe: an unrecognized error still retries exactly as before, and rate limits are never treated as permanent (v8.0.0, opt out `LOKI_SMART_RETRY=0`).
- **Cross-project memory** -- Episodic/semantic/procedural memory with vector search; knowledge learned on one project surfaces on the next (v5.15.0+, see `memory/engine.py`)
- **Self-hosted and private** -- Your keys, your infrastructure, no data leaves your network
- **Legacy system healing** -- `loki modernize heal` archaeology/stabilize/isolate/modernize/validate phases (v6.67.0, see `skills/healing.md`)
- **MCP server** -- 36 tools (including ChromaDB code search) plus 3 resources and 2 prompts (`mcp/server.py`, with magic tools registered from `mcp/magic_tools.py` and the managed-memory tool from `mcp/managed_tools.py`). Of the 36, 35 are always available; `loki_memory_redact` is registered but only succeeds when `LOKI_MANAGED_AGENTS=true` and `LOKI_MANAGED_MEMORY=true`. Launch with `loki mcp` (bootstraps the Python MCP SDK on first run).
- **Full-stack output** -- Source code, tests, Docker Compose stacks (multi-service with healthchecks), CI/CD pipelines, audit logs
- **Provider-agnostic** -- runs on Claude, Cline, Codex, Aider, or opencode with automatic failover (`loki-ts/src/runner/providers.ts`); no vendor lock-in. When `LOKI_PROVIDER` is unset, Loki auto-detects in that order; an explicit choice always wins and is never silently substituted. Gemini was removed as a provider in v7.5.18.
- **Source-available (BUSL-1.1)** -- Free for personal, internal, and academic use.

---

## Loki does not lie about "done"

Most coding agents declare a task done by telling you so in a transcript. The
transcript is the agent's own narration; there is nothing to check. Loki Mode
takes a different stance: it does not call work done until the work is verified,
and every build produces an **Evidence Receipt** you can re-verify yourself.

The receipt separates two things most tools blur together:

- **Facts** -- deterministic, non-LLM, and re-derivable by anyone: the git diff
  (base/head SHAs, file/insertion/deletion counts, a `diff_sha256`), the test
  command that ran with its exit code, the build command with its exit code, and
  each quality-gate verdict. A skeptic can recompute every one of these from the
  same repo state.
- **Assessments** -- AI judgments such as the review council's verdict. These are
  labeled explicitly as judgment, not proof, and never make the headline green on
  their own.

The receipt's headline is computed only from the facts:

- **VERIFIED** -- tests recorded a real command, ran, and exited 0; the diff is
  non-empty; nothing was skipped.
- **VERIFIED WITH GAPS** -- some facts checked out, but something was not run or
  was inconclusive. Every gap is listed by name, so silence never reads as a pass.
- **NOT VERIFIED** -- a test, build, or gate ran and failed (or there was nothing
  to verify).

This is honesty-of-done, not a claim of perfection. The receipt proves the
completion claim is backed by deterministic evidence and is independently
re-checkable; it does not claim the generated code is bug-free.

<details>
<summary><strong>Verify a receipt yourself -- <code>loki proof</code> commands, tamper/drift checks, proven PRs (advanced)</strong></summary>

### Verify it yourself

Receipts are written to `.loki/proofs/<run_id>/` automatically at run completion
(opt out with `LOKI_PROOF=0`). Inspect and re-check them with `loki proof`
(aliased as `loki receipt`):

```bash
loki proof list              # every receipt: run id, time, council verdict, cost, files
loki proof show <id>         # the full proof.json (facts, assessments, honesty)
loki proof verify <id>       # re-check the receipt against the repo (exit 0 clean, 1 tamper/drift)
```

`loki proof verify` does two independent checks and prints the result as JSON:

- **Tamper check** -- recomputes the receipt's integrity hash and compares it to
  the recorded one. If anyone edited the receipt after it was written, `hash_ok`
  is `false`.
- **Drift check** -- re-runs the diff from the recorded base SHA against the
  current repo and compares the file/insertion/deletion counts and `diff_sha256`
  to what the receipt recorded. If the repo no longer matches, `diff_drift` is
  `true`.

A clean receipt prints `"ok": true` and exits 0. A tampered or drifted receipt
exits 1. When a check cannot run (for example a receipt with no recorded base
SHA), the verifier reports it as unverifiable rather than passing it silently.

```json
{
  "hash_ok": true,
  "diff_drift": false,
  "gpg_ok": "n/a",
  "degraded": [],
  "reason": "",
  "ok": true
}
```

You can share a receipt as a self-contained HTML page (`loki proof open <id>`),
or publish it as a GitHub Gist with `loki proof share <id>` (opt-in; the page is
redacted before it leaves your machine). An optional, off-by-default GPG detached
signature (`LOKI_PROOF_GPG_KEY`) lets a third party confirm the receipt came from
you.

### Proven PR

When Loki opens a pull request, the PR body includes the Evidence Receipt
summary, so a reviewer does not have to take the agent on faith. It shows the
honest verdict (VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED), the key facts
(diff hash, tests, secure-gate, cost), and a "verify this yourself" line:
`loki proof verify <id>` against the recorded base SHA. A green claim appears
only when the receipt's own headline is VERIFIED. This is on by default whenever
Loki opens or advises a PR; opt out with `LOKI_PROVEN_PR=0`.

An optional advisory status check (`loki: verified-completion`) maps the verdict
to a GitHub check-run. It is opt-in (`LOKI_PROVEN_PR_CHECK=1`) and can never block
a merge on its own. To make verified-completion blocking, add it as a required
status check in your repository's branch-protection settings.

</details>

---

<details>
<summary><b>Setup details: providers, other models, what loki doctor checks</b></summary>

Other spec sources work the same way:

```bash
loki init my-app --template simple-todo-app    # scaffold a starter PRD
loki start owner/repo#123                      # a GitHub issue
loki start ./openapi.yaml                      # an OpenAPI/YAML spec
loki demo --offline                            # replay a sample receipt, no key, no spend
```

Loki needs a model to drive. There are two ways to give it one.

**Without a separate CLI (v8).** The Claude Agent SDK ships inside Loki, so an API key alone is enough:

```bash
export ANTHROPIC_API_KEY=sk-...               # or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
LOKI_SDK_MODE=full loki start prd.md          # runs the loop and the judges through the bundled SDK
```

This needs Bun on your PATH (the SDK loop runs on the Bun runtime). `loki doctor` reports `Bundled Claude Agent SDK is usable -- no separate CLI needed` when that path is genuinely ready, and stays on the normal blocker otherwise: it checks that the SDK's platform binary is actually extracted, that credentials are present, and that the SDK loop is really the route your next run will take. It will not tell you that you are ready and then fail the build.

**With a coding-agent CLI.** The classic path, and still the default: Loki drives a separate CLI (Claude Code is the recommended one) plus a couple of common tools on your PATH.

**With a different model or provider.** Loki is not tied to Anthropic, but
*how* you reach another model depends on which API the endpoint speaks. There
are two routes, and picking the wrong one fails confusingly.

*Route 1 -- OpenAI-shaped endpoints (OpenRouter, and most hosted open models).*
Use a provider that speaks that API natively. `aider` and `cline` both do, and
Loki now defaults them to open-weight models rather than Claude:

```bash
loki provider set aider
export OPENROUTER_API_KEY=sk-or-...
loki start prd.md                          # defaults to deepseek-v3.2

export LOKI_AIDER_MODEL=openrouter/z-ai/glm-4.6   # or pick your own
```

OpenRouter serves **only** the OpenAI-shaped `/v1/chat/completions`; it has no
Anthropic `/v1/messages` endpoint. Pointing `ANTHROPIC_BASE_URL` at it does not
work, which earlier versions of this README incorrectly suggested.

*Route 2 -- Anthropic-protocol gateways.* `ANTHROPIC_BASE_URL` routes Claude
Code itself, so the endpoint must speak the Anthropic Messages API. LiteLLM,
Bedrock proxies, and self-hosted gateways can:

```bash
# Ollama, fully local (no API key, no per-token cost)
export ANTHROPIC_BASE_URL=http://localhost:11434/v1
export LOKI_MODEL_OVERRIDE=<model you have pulled, e.g. the output of `ollama list`>
loki start prd.md

# LiteLLM / vLLM / any self-hosted gateway
export ANTHROPIC_BASE_URL=https://your-gateway.internal/v1
export ANTHROPIC_API_KEY=...
export LOKI_MODEL_OVERRIDE=<whatever your gateway calls the model>
loki start prd.md
```

**Set both variables.** `LOKI_MODEL_OVERRIDE` is what makes the alt-provider
path work: without it Loki keeps asking for `opus` / `sonnet` / `haiku`, which
only Anthropic resolves, and most providers reject those names outright. A
proxy that maps the aliases for you (LiteLLM can) is the one exception.

Model IDs are not listed here on purpose -- OpenRouter's catalogue changes every
week, and a stale ID in a README is a failure you would hit at runtime. Take the
exact string from your provider's own model list.

Both routes honor these variables identically -- the bundled-SDK path and the
Claude Code CLI path -- and `loki doctor` reports the endpoint it detected plus a
warning if the model override is missing.

The quality gates, the completion council, and the Evidence Receipt do not care
which model produced the code. They check what was actually built.

Either way, run `loki doctor` any time and it tells you exactly what is present and what is missing, with a copy-pasteable install command for each gap.

**What Loki needs (and what `loki doctor` checks)**

Required:

- An agent provider CLI: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`, Tier 1, recommended and E2E-verified - the provider Loki Mode is built for). Cline, Codex, Aider, and opencode are supported as experimental providers (wiring in place; not yet E2E-verified by us). Loki cannot run a build without one of these installed and authenticated.
- Python 3.10+ (`python3`) for the dashboard, memory system, and orchestration helpers.
- Git 2.x (`git`) for checkpoints and worktrees.
- `curl` for installation and network calls.

Recommended:

- Bun 1.3.0+ (`bun`) for the fast runtime (the recommended install path above installs it).
- Node.js 18+ and npm if you install via npm instead of Bun.
- `jq` for nicer JSON handling in shell flows.
- Docker if you want Loki's App Runner to run containerized projects, or to run Loki itself from the published image.

You also need credentials for whichever provider you use (for Claude Code, an authenticated `claude` login or `ANTHROPIC_API_KEY`). `loki doctor` flags a missing or unauthenticated provider as the first thing to fix.

If you do not have Bun yet:

```bash
curl -fsSL https://bun.sh/install | bash       # macOS / Linux (or: brew install oven-sh/bun/bun)
```

Docker without installing loki locally: `loki docker start prd.md` runs it in the
published image with zero config, bind-mounting the current folder so `.loki`
state and resume work exactly like local. See [DOCKER_README.md](DOCKER_README.md).

Upgrading: `loki self-update` auto-detects which package manager installed loki
and runs the right upgrade. `loki self-update --to bun` migrates an npm install
to Bun in one command. `loki self-update --check` shows the install path.

See the [Installation Guide](docs/INSTALLATION.md) for the long form.

</details>

---

<details>
<summary><strong>Runtime architecture -- dual Bash/Bun runtime, rollback flag, migration cost (advanced)</strong></summary>

Loki Mode runs a dual runtime by deliberate design: the battle-tested Bash engine is the stable core (the autonomous loop, quality gates, and completion council stay on it; it receives bug fixes and hardening), and new product surfaces are built TypeScript/Bun-first as modules that wrap the engine rather than reimplement it. An earlier plan to make v8 Bun-only has been superseded by this stable-engine approach: rewriting the verified trust layer would risk the exact guarantees this product exists to provide, for no capability gain. Bash support is not going away.

**What ships today:**

- Commands routed to the Bun runtime when `bun` is on `PATH` (the router lives in `bin/loki`): `version`, `--version`, `-v`, `status`, `stats`, `doctor`, `provider` (covers `provider show` and `provider list`), `memory` (covers `memory list` and `memory index`), `rollback`, `kpis`, and `internal`.
- Every other command continues to execute on the existing Bash CLI (`autonomy/loki`), including the autonomous `loki start` / `loki run` loop which remains the Bash orchestrator (`autonomy/run.sh`).
- If `bun` is not on `PATH`, the shim falls through to Bash silently. Existing users without Bun installed see no behavior change.

**Rollback flag:**

Force every command to take the legacy Bash path:

```bash
LOKI_LEGACY_BASH=1 loki <cmd>
```

This is the documented escape hatch for any user who hits a regression on the Bun route. The Bash path remains the source of truth through Phase 5.

**Phase 6 (planned, calendar TBD):**

The next major release sunsets the Bash runtime entirely. There is no firm calendar date. Users who need to stay on the Bash route should pin the last v7.x release.

**Cost:**

- Adds a Bun runtime dependency (Bun 1.3.0 or newer recommended; the shim works as long as `bun` resolves).
- Adds a Bun toolchain to the system (Bun itself is roughly 50 MB installed via `brew install` or the official curl installer). The published `loki-ts/dist/loki.js` bundle inside the npm tarball is approximately 152 KB.
- Speedup on the ported commands is measured in `.loki/metrics/migration_bench_soak.jsonl` and analysed in [ADR-001](docs/architecture/ADR-001-runtime-migration.md). Recorded soak results show roughly 3x to 5x faster execution on the ported commands (per-command range 2.9x to 5.0x); treat as indicative, not contractual.

**More:**

- [UPGRADING.md](UPGRADING.md) -- per-version upgrade and rollback guidance.
- [ADR-001: Runtime Migration](docs/architecture/ADR-001-runtime-migration.md) -- design rationale and phase definitions.

</details>

---

<details>
<summary><strong>Other install methods</strong></summary>

| Method | Command |
|--------|---------|
| **Homebrew** | `brew tap asklokesh/tap && brew install loki-mode` |
| **Docker** | `docker pull asklokesh/loki-mode:latest` |
| **Inside Claude Code** | `claude --dangerously-skip-permissions` then type "Loki Mode" |
| **Git clone** | `git clone https://github.com/asklokesh/loki-mode.git` |

See the full [Installation Guide](docs/INSTALLATION.md).

</details>

<details>
<summary><strong>Supported spec formats</strong></summary>

A "spec" is whatever you hand `loki start`. Loki auto-detects the format and normalises it before the RARV loop. A Markdown PRD is one form of spec; the table below lists every input the CLI accepts.

| Format | Example | Notes |
|--------|---------|-------|
| Markdown PRD | `loki start ./prd.md` | Canonical form. Headings become section anchors. |
| JSON spec | `loki start ./spec.json` | Free-form JSON; keys surfaced to agents. |
| YAML spec | `loki start ./openapi.yaml` | OpenAPI / AsyncAPI / plain YAML all accepted. An OpenAPI/GraphQL/Postman contract expands into a per-operation build checklist (one item per operationId/field/request) so no operation is lost to prompt truncation (v8.0.0). |
| Plain text brief | `loki start ./brief.txt` | One-paragraph briefs work; complexity auto-detects to "simple". |
| GitHub issue URL | `loki start https://github.com/owner/repo/issues/42` | Title + body + labels become the spec. |
| GitHub shorthand | `loki start owner/repo#42` | Same as above, shorter. |
| Jira ticket key | `loki start PROJ-456` | Requires `JIRA_BASE_URL` + `JIRA_TOKEN` env vars. |
| GitLab / Azure DevOps URL | `loki start https://gitlab.com/group/proj/-/issues/7` | GitLab and Azure DevOps issue URLs both supported. |
| Bare issue number | `loki start #123` or `loki start 123` | Resolved against the current repo's `origin` remote. |
| OpenSpec change directory | `loki start --openspec ./openspec/change-001` | Reads OpenSpec change manifest + delta files. |
| Auto-detect (no input) | `loki start` | Picks up `./prd.md`, `./spec.{json,yaml,yml}`, or `./SPEC.md` from cwd. |

All formats land in the same RARV pipeline and pass the same 8 quality gates (`skills/quality-gates.md`).

</details>

---

## What You Can Build

| Project | Build Time | Complexity |
|---------|:----------:|:----------:|
| Landing page with signup form | ~10 min | Simple |
| REST API with JWT auth | ~20 min | Simple |
| Portfolio with animations | ~15 min | Simple |
| SaaS dashboard with analytics | ~25 min | Standard |
| E-commerce store with Stripe | ~45 min | Standard |
| Task manager with kanban board | ~25 min | Standard |
| Chat app with WebSocket | ~30 min | Standard |
| Blog platform with MDX | ~30 min | Standard |
| Microservice architecture | ~2 hours | Complex |
| ML pipeline with monitoring | ~3 hours | Complex |

---

## What To Expect

| | Simple | Standard | Complex |
|---|---|---|---|
| **Examples** | Landing page, todo app, single API | CRUD + auth, REST API + React | Microservices, real-time, ML pipelines |
| **Duration** | 5-30 min | 30-90 min | 2+ hours |
| **Autonomy** | Completes independently | May need guidance on complex parts | Use as accelerator with human review |

---

<details>
<summary><strong>Internal architecture -- RARV cycle, agent roles, quality gates, memory, dashboard, enterprise layer (advanced)</strong></summary>

<div align="center">
<img width="100%" alt="Loki Mode Architecture" src="https://github.com/user-attachments/assets/c9798120-9587-4847-8e8d-8f421f984dfc" />
</div>

<table>
<tr>
<td width="33%" valign="top">

### RARV Cycle
Every iteration: **Reason** (read state) - **Act** (execute, commit) - **Reflect** (update context) - **Verify** (run tests, check spec). Failures trigger self-correction.

[Core Workflow](references/core-workflow.md)

</td>
<td width="33%" valign="top">

### 41 Agent Roles
8 domains: engineering, operations, business, data, product, growth, review, orchestration. These are prompt-defined role specifications the orchestrator adopts per phase, auto-composed by PRD complexity; parallelism comes from the blind review council, the adversarial reviewer, and optional git-worktree streams on Claude Code, sequential on other providers.

[Agent Types](references/agent-types.md)

</td>
<td width="33%" valign="top">

### 8 Quality Gates
Static analysis, test suite (pass/fail), blind 3-reviewer code review with severity blocking, anti-sycophancy Devil's Advocate, mock-integrity detection, test-mutation detection, documentation coverage, and Magic Modules debate. Backward-compatibility is a conditional healing-mode auditor (not one of the 8). Code does not ship until all gates pass.

[Quality Gates](skills/quality-gates.md)

</td>
</tr>
<tr>
<td width="33%" valign="top">

### Memory System
3-tier architecture: episodic (interaction traces), semantic (generalized patterns), procedural (learned skills). Vector search optional.

[Memory Architecture](references/memory-system.md)

</td>
<td width="33%" valign="top">

### Dashboard
Real-time monitoring, agent status, task queue, WebSocket streaming, and Live App Preview (embedded iframe of the running app with Refresh/Open/Restart toolbar). Auto-starts at `localhost:57374`.

[Dashboard Guide](docs/dashboard-guide.md)

</td>
<td width="33%" valign="top">

### Enterprise Layer
TLS, OIDC bearer-token validation (the foundation for SSO; browser SAML login is
roadmap), scoped RBAC, OTEL tracing, policy engine, audit trails. Activated via
env vars. See [Enterprise Identity Roadmap](docs/ENTERPRISE-IDENTITY-ROADMAP.md).

[Enterprise Guide](docs/enterprise/architecture.md)

</td>
</tr>
</table>

</details>

---

## Loki Mode vs. Alternatives

| Feature | Loki Mode | bolt.new | Replit | Lovable |
|---------|:---------:|:--------:|:------:|:-------:|
| Self-hosted / your keys | Yes | No | No | No |
| Multi-provider failover (5 providers) | Yes | No | No | No |
| 8 quality gates | Yes | No | No | No |
| Blind code review | Yes | No | No | No |
| Enterprise auth (OIDC token + scoped RBAC) | Yes | No | Yes | No |
| Air-gapped deployment | Yes | No | No | No |
| Docker + CI/CD generation | Yes | No | Yes | No |
| Source-available (BUSL-1.1) | Yes | No | No | No |
| Free tier | Source-available | Yes | Yes | Yes |

Among the four tools in this table, Loki Mode is the one that is fully self-hosted, source-available (BUSL-1.1), and includes automated quality verification. Your code, your keys, your infrastructure. We have not surveyed every tool on the market, so read this as a comparison against the named three, not a claim about the whole category.

---

<details>
<summary><strong>Provider matrix -- per-provider status, autonomous flags, parallelism, install (includes deprecated Gemini)</strong></summary>

Loki's autonomy and quality loop are the product; the underlying coding CLI is swappable. Loki runs on any of the providers below so you are never locked to one vendor. With `LOKI_PROVIDER` unset, Loki auto-detects the first installed provider in the order the table lists (claude, cline, codex, aider, opencode); setting it explicitly always wins and is never silently substituted.

| Provider | Status | Autonomous Flag | Parallel Agents | Install |
|----------|--------|:-:|:-:|---------|
| **Claude Code** | Active (Tier 1, E2E-verified) | `--dangerously-skip-permissions` | Yes (10+) | `npm i -g @anthropic-ai/claude-code` |
| **Cline CLI** | Experimental (Tier 2) | `-y` | Sequential | `npm install -g cline` |
| **Codex CLI** | Experimental (Tier 3) | `exec --sandbox workspace-write --skip-git-repo-check` | Sequential | `npm i -g @openai/codex` |
| **Aider** | Experimental (Tier 3) | `--yes-always` | Sequential | `pip install aider-chat` |
| **opencode** | Experimental | `--auto` | Sequential | `npm install -g opencode-ai` |
| **Google Gemini CLI** | REMOVED v7.5.18 | -- | -- | Upstream deprecated; runtime removed. `LOKI_PROVIDER=gemini` exits with a migration message. |

Status legend: "E2E-verified" means we run real spec-to-code builds on it ourselves. Claude Code is the primary, fully supported provider and the one Loki Mode is built for; it gets full features (subagents, parallelization, MCP, Task tool). "Experimental" means the wiring is in place but we have not produced an end-to-end verified build ourselves; treat as community-tested. Experimental providers run sequentially. Auto-failover switches providers when rate-limited. See [Provider Guide](skills/providers.md).

</details>

---

## CLI Reference

<details>
<summary><strong>All commands</strong></summary>

| Command | Description |
|---------|-------------|
| `loki start [PRD]` | Start with optional PRD file (also accepts an issue ref; replaces deprecated `loki run`). Auto-opens the dashboard in the browser for interactive runs and passes native `--effort`/`--max-budget-usd`/`--fallback-model` for resilience (v7.25.0) |
| `loki stop` | Stop execution |
| `loki modernize heal <path>` | Legacy system healing (archaeology, stabilize, isolate, modernize, validate -- v6.67.0; was: `loki heal`) |
| `loki pause` / `resume` | Pause/resume after current session |
| `loki steer "<note>"` | Nudge a running build with a directive (writes `.loki/HUMAN_INPUT.md`; the loop reads it when `LOKI_PROMPT_INJECTION=1`) (v8.0.0) |
| `loki status` | Show current status |
| `loki why` | Explain the last outcome; on a stalled run names the real stall reason (proactive stuck-detector + convergence signal) and suggests `loki steer` (v8.0.0) |
| `loki cockpit` | Live multi-repo status as an inline terminal image (Kitty/iTerm2/WezTerm/Ghostty); text + dashboard fallback elsewhere (v7.126.0) |
| `loki dashboard` | Open web dashboard |
| `loki preview` | Print running app URL and open in browser (Live App Preview, v7.24.0; was: `loki open`) |
| `loki web` | Launch Purple Lab web UI [DEPRECATED in v7.44.0 -- use `loki start` which auto-opens the dashboard at http://localhost:57374; for the hosted platform see Autonomi Cloud] |
| `loki doctor` | Check environment and dependencies |
| `loki plan [PRD]` | Pre-execution analysis: complexity, cost, iterations |
| `loki review [--staged\|--diff]` | AI-powered code review with severity filtering |
| `loki test [--file\|--dir\|--changed]` | AI test generation (8 languages, 9 frameworks) |
| `loki analyze onboard [path]` | Project analysis and CLAUDE.md generation (was: `loki onboard`) |
| `loki import` | Import GitHub issues as tasks |
| `loki ci` | CI/CD quality gate integration |
| `loki failover` | Cross-provider auto-failover management |
| `loki memory <cmd>` | Memory system: index, timeline, search, consolidate |
| `loki enterprise` | Enterprise feature management |
| `loki version` | Show version |

</details>

Run `loki --help` for all options. Full reference: [CLI Reference](wiki/CLI-Reference.md) | Config: [config.example.yaml](autonomy/config.example.yaml)

### Configuration file

Pass a config file to `loki start` with `--config <path>` (aliases: `--env-file`, `--vars`), or set `LOKI_CONFIG_FILE`. The format is detected from the extension or content: `.yaml`/`.yml`, `.json`, or `.env` (flat `LOKI_*=value` lines). Values resolve by precedence: a CLI flag beats an ambient env var, which beats the `--config` file, which beats built-in defaults. Never inline a secret; reference an env var with `${VAR}` and the loader expands it at load time (an unset reference is skipped with a warning, and a raw-looking secret literal is flagged). Generate a starter with `loki config example`.

```bash
# config.yaml
dashboard:
  port: 9000
github:
  token: ${GITHUB_TOKEN}   # expanded from the environment, never stored inline

loki start --config config.yaml ./prd.md
```

---

<details>
<summary><strong>Configuration env vars (intelligent defaults, opt-out knobs)</strong></summary>

Loki Mode's accuracy and autonomy behaviors are default-on. Each is an opt-out escape hatch, not a setting you have to discover. The most relevant knobs from the v7.41.x accuracy/autonomy hardening:

| Env var | Default | Effect |
|---------|---------|--------|
| `LOKI_REVIEW_INCONCLUSIVE_BLOCK` | `1` | Blocks completion when a code-review round returns zero usable verdicts (an all-empty review proves nothing). Set `0` to record the inconclusive result without blocking. |
| `LOKI_COMPLETION_TEST_CAPTURE` | `1` | Captures fresh test results before the verified-completion evidence gate evaluates. Set `0` to skip the pre-gate capture. |
| `LOKI_AUTO_DOCS` | `true` | Generates the `.loki/docs/` suite before the documentation gate scores it (bounded: once per run when docs are missing, and again only when >10 commits stale). Set `false` to opt out. |
| `LOKI_CAVEMAN` | `1` (on) | Output-token compressor for free-form generation only (never trust-gate subcalls). Set `0` to opt out. |
| `LOKI_CAVEMAN_LEVEL` | inferred | Compression level for the compressor. Auto-inferred per invocation from the run's RARV tier; set explicitly (`lite` / `full` / `ultra`) to override the inference. |
| `LOKI_CONFIDENCE_SPIKE` | `1` (on) | Forces one EXTRA verification pass when the agent's self-reported confidence spikes, instead of trusting the claim. Strictly additive -- it can never skip a gate. Set `0` to opt out; tune with `LOKI_CONFIDENCE_SPIKE_DELTA` (default `40`) and `LOKI_CONFIDENCE_SPIKE_MIN` (default `90`). |
| `LOKI_GOAL_SCORING` | `1` (on) | Flags a goal with no measurable success condition and asks for a threshold, metric, or concrete artifact. Advisory only -- never blocks a build or rewrites the goal. Set `0` to opt out. |
| `LOKI_SMART_RETRY` | `1` (on) | Stops early on a positively-identified permanent failure (bad credentials, unknown model, exhausted quota) rather than burning retries. Unrecognized errors and rate limits still retry as before. Set `0` to retry every failure. |
| `LOKI_SIMPLE` | `0` (off) | EXPERIMENTAL. Strips the coaching half of the system prompt -- the RARV cycle, SDLC phases and memory habits that a frontier model already does natively. Per-iteration state (which gate failed, self-heal output, checklist status) is never touched, because that is information the model cannot derive. Measured at -78% prompt size, ~1562 tokens per iteration, on both the bash and Bun routes. INERT on degraded providers (Codex, Aider): those take an earlier return path whose prompt is already minimal by design, so the flag has nothing to strip there -- a measured zero, not an untested case. Whether it changes build speed or quality is NOT yet measured, so treat it as an experiment, not a tuning knob: run `benchmarks/run-prompt-ablation.sh` on your own workload before adopting it. |

This is a subset. See the [wiki](wiki/Home.md) for the full env-var reference and the RARV-C closure knobs (`LOKI_INJECT_FINDINGS`, `LOKI_OVERRIDE_COUNCIL`, `LOKI_AUTO_LEARNINGS`, `LOKI_HANDOFF_MD`).

</details>

<details>
<summary><strong>BMAD Method Integration</strong></summary>

Loki Mode integrates with the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD), a structured AI-driven agile methodology. If your project uses BMAD for requirements elicitation, Loki Mode can consume those artifacts directly:

```bash
loki start --bmad-project ./my-project
```

The adapter handles BMAD's frontmatter conventions, FR-format functional requirements, Given/When/Then acceptance criteria, and artifact chain validation. Non-BMAD projects are unaffected -- the integration is opt-in via `--bmad-project`.

See [BMAD Integration Validation](docs/architecture/bmad-integration-validation.md).

</details>

<details>
<summary><strong>Enterprise Features</strong></summary>

Enterprise features are included but require env var activation.

```bash
export LOKI_ENTERPRISE_AUTH=true                 # token auth (dashboard/auth.py)
export LOKI_OIDC_ISSUER=https://accounts.google.com
export LOKI_OIDC_CLIENT_ID=your-client-id        # OIDC needs issuer + client id
export LOKI_ENTERPRISE_AUDIT=true                # force audit logging on
export LOKI_TLS_CERT=/path/cert.pem              # HTTPS: set BOTH cert and key
export LOKI_TLS_KEY=/path/key.pem
loki enterprise status
```

[Enterprise Architecture](docs/enterprise/architecture.md) | [Security](docs/enterprise/security.md) | [Authentication](docs/authentication.md) | [Authorization](docs/authorization.md) | [Metrics](docs/metrics.md) | [Audit Logging](docs/audit-logging.md)

</details>

<details>
<summary><strong>Benchmarks</strong></summary>

Self-reported results from the included test harness. Verification scripts included for reproduction.

| Benchmark | Result | Notes |
|-----------|--------|-------|
| HumanEval | 162/164 (98.78%) | Self-reported; harness + results JSON in `benchmarks/results/humaneval-loki-results.json`. Max 3 retries, RARV self-verification. |
| SWE-bench | Not yet measured | Harness exists and generates patches, but the official SWE-bench evaluator has not been run, so there is no pass-rate to report. Run it yourself: `./benchmarks/run-benchmarks.sh swebench --execute` |

See [benchmarks/](benchmarks/) for methodology.

</details>

<details>
<summary><strong>Presentation</strong></summary>

![Loki Mode Presentation](docs/loki-mode-presentation.gif)

*11 slides: Problem, Solution, 41 Agents, RARV Cycle, 8 Quality Gates (HumanEval 98.78%), Multi-Provider, Enterprise Hardening (Live App Preview), Full Lifecycle*

**[Download PPTX](docs/loki-mode-presentation.pptx)**

</details>

---

## Limitations

| Area | What Works | What Doesn't (Yet) |
|------|-----------|---------------------|
| **Code Gen** | Full-stack apps from PRDs | Complex domain logic may need human review |
| **Deploy** | Generates configs, Dockerfiles, CI/CD; `loki deploy` prints the exact deploy command | Does not deploy -- human runs the printed deploy command (Loki never runs a cloud CLI or git push) |
| **Testing** | 8 automated quality gates | Test quality depends on AI assertions |
| **Providers** | 5 providers with auto-failover | Non-Claude providers lack parallel agents |
| **Dashboard** | Real-time single-machine monitoring | No multi-node clustering |

> **What "autonomous" means:** The system runs RARV cycles without prompting. It does NOT access your cloud accounts, payment systems, or external services unless you provide credentials. Human oversight is expected for deployment, API keys, and critical decisions.

---

## Research Foundation

<details>
<summary><strong>Papers and sources</strong></summary>

| Source | What We Use |
|--------|-------------|
| [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | Evaluator-optimizer, parallelization |
| [Anthropic: Constitutional AI](https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback) | Self-critique against quality principles |
| [DeepMind: Scalable Oversight via Debate](https://deepmind.google/research/publications/34920/) | Debate-based verification in council review |
| [DeepMind: SIMA 2](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/) | Self-improvement loop design |
| [OpenAI: Agents SDK](https://openai.github.io/openai-agents-python/) | Guardrails, tripwires, tracing |
| [NVIDIA ToolOrchestra](https://github.com/NVlabs/ToolOrchestra) | Efficiency metrics, reward signals |
| [CONSENSAGENT (ACL 2025)](https://aclanthology.org/2025.findings-acl.1141/) | Anti-sycophancy in blind review |
| [GoalAct](https://arxiv.org/abs/2504.16563) | Hierarchical planning for complex PRDs |

**Practitioner insights:** Boris Cherny, Simon Willison, [HN Community](https://news.ycombinator.com/item?id=44623207)

**[Full Acknowledgements](docs/ACKNOWLEDGEMENTS.md)** -- 50+ papers and resources

</details>

---

## Contributing

```bash
git clone https://github.com/asklokesh/loki-mode.git && cd loki-mode
npm install && npm test              # CLI + Node test suites
python3 -m pytest                    # Python test suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Business Source License 1.1](LICENSE) -- Free for personal, internal, academic, and non-commercial use. Converts to Apache 2.0 on March 19, 2030. Contact founder@autonomi.dev for commercial licensing.

---

<div align="center">

**[Autonomi](https://www.autonomi.dev/)** | **[Documentation](wiki/Home.md)** | **[Changelog](CHANGELOG.md)** | **[Comparisons](references/competitive-analysis.md)**

</div>
