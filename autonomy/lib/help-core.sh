#!/usr/bin/env bash
# Core help screen and help topics for `loki help`. Source this file; it
# defines functions only. The front page lists exactly the 11 KEEP commands of
# loki-ts/src/cli/registry.ts (tests/min/cli-entrypoints.sh compares them). The
# hidden and renamed commands stay in show_help_all (autonomy/loki), reached
# with `loki help all`.

# Topics reachable as `loki help <topic>`. Keep in sync with help_topic_text.
LOKI_HELP_TOPICS="providers exit-codes"

# The 11 core commands, grouped. Shared by the front page and `loki help all`.
help_core_commands() {
    echo "Build:"
    echo "  loki \"<goal>\"              Build it: a goal, a PRD file, or an issue (owner/repo#N)"
    echo "  start [input] [options]    Same, with options (--no-pr, --max-cost USD, --model, --provider, --dry-run, --deploy)"
    echo "  chat [--attach]            Talk it through instead; --attach joins the running build"
    echo ""
    echo "Check:"
    echo "  status [--json]            What is running, how it ended, what to do next"
    echo "  verify [base] [--fast]     Deterministic verification with CI exit codes (--json)"
    echo "  receipt [run]              The signed proof of a run (share, badge, bundle)"
    echo ""
    echo "Control:"
    echo "  stop                       Stop the running build"
    echo "  undo <run>                 Plan (--plan) or apply an undo of a run"
    echo "  deploy                     Deploy a VERIFIED run"
    echo ""
    echo "Setup:"
    echo "  doctor [--fix]             Check and repair your setup (first run: loki doctor --fix)"
    echo "  config list|get|set        Show or change settings (config list --json)"
    echo "  control serve              The local UI"
}

help_core_screen() {
    local version="$1"
    echo "Loki Mode v${version}"
    echo ""
    help_core_commands
    echo ""
    echo "Default spend cap per run: $(loki_budget_default_usd 2>/dev/null) USD (--max-cost USD). Exit codes: docs/exit-codes.md"
    echo "loki <command> --help   |   loki help all   |   loki help <topic> (${LOKI_HELP_TOPICS// /, })"
    echo "docs: https://www.autonomi.dev/docs"
}

help_topic_text() {
    case "$1" in
        start)
            cat <<'T'
Starting work

  loki start ./prd.md          Build from a spec file
  loki start owner/repo#123    Build from a GitHub issue
  loki "<task>"                Same as quick
  loki quick "add dark mode"   One small task, no PR
  loki edit "rename foo to bar" One targeted change
  loki chat                    Interactive alternative to start (/run inside chat runs loki start)
  loki chat --attach           Chat about the current or latest start run (/status /steer /diff /stop)
  loki plan ./prd.md           Dry run: complexity, cost, plan

Common flags: --provider NAME, --model ID (tier or route, e.g. ollama/qwen3-coder), --budget USD, --simple, --complex,
--no-dashboard, --spec FILE, --config PATH. Full list: loki help all.
T
            ;;
        models)
            cat <<'T'
Models

Loki routes work by tier: planning (opus), development (sonnet), fast (haiku).
  loki models                  Show the model for each tier
  loki models --local          Show local models (Ollama, LM Studio, llama.cpp)
  loki config set maxTier sonnet   Cap model cost
  loki config set model.development <id>   Override one tier
  LOKI_MODEL_OVERRIDE=<id>     Force one model id (Anthropic-protocol gateways)
T
            ;;
        providers)
            cat <<'T'
Providers

Supported providers: claude (Claude Code CLI, or an Anthropic API key through
the Agent SDK) and opencode (any model, including OpenRouter).
  loki provider list           Providers and install status
  loki provider set opencode   Switch provider (claude, opencode)
  loki start ./prd.md --provider opencode

opencode with OpenRouter: export OPENROUTER_API_KEY=sk-or-..., then
  loki start ./prd.md --provider opencode --model openrouter/<vendor>/<model>
T
            ;;
        agents)
            cat <<'T'
Agents

  loki agents list|new|show    Your own agents (.loki/agents/<name>.md); council reviewers use them
  loki route "<task>"          Show which engine, provider and model a task would use
  loki agent --help            Lower-level agent commands

Roles use Opus for planning, Sonnet for development, Haiku for fast work.
T
            ;;
        verify)
            cat <<'T'
Verification

  loki verify                  Deterministic PR verification
  loki verify --fast           Exogenous checks only, milliseconds, no model call
  loki verify --json           One JSON object: command, exit_code, ok, output
  loki verify --pubkey FILE    Check a receipt against a public key
  loki receipt                 Inspect the proof-of-run receipt
  loki undo <run> [--plan|--dry-run]  Plan or apply an undo of a run

Exit codes: see loki help exit-codes.
T
            ;;
        exit-codes)
            cat <<'T'
Exit codes

  0   success
  1   failure
  2   usage error (unknown command, bad flag)
  3   missing component

Severity rises with the code: a bigger number is never better news.
Per-command contracts (verify, proof, start under LOKI_DURABLE_STATE=1):
docs/exit-codes.md
T
            ;;
        config)
            cat <<'T'
Configuration

  loki config                  Show current configuration
  loki config list --json      Machine-readable configuration
  loki config set KEY VALUE    Set a value (maxTier, model.planning, ...)
  loki config get KEY          Read a value
  loki config validate [FILE]  Validate loki.yaml
  loki setup                   First-run setup
  loki start --config FILE     Load settings from a file

Precedence: CLI flag > env var > --config file > defaults.
Environment variables: docs/environment-variables.md
T
            ;;
        *)
            return 1
            ;;
    esac
}

# Print the topic, or return 1 when $1 is not a topic.
help_topic() {
    help_topic_text "$1"
}
