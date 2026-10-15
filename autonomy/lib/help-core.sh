#!/usr/bin/env bash
# Core help screen and help topics for `loki help`. Source this file; it
# defines functions only. The full command table stays in show_help_all
# (autonomy/loki) and is reached with `loki help all`.

# Topics reachable as `loki help <topic>`. Keep in sync with help_topic_text.
LOKI_HELP_TOPICS="start models providers agents verify exit-codes config"

help_core_screen() {
    local version="$1"
    echo "Loki Mode v${version}"
    echo ""
    echo "Usage: loki <command> [options]"
    echo ""
    echo "Start:"
    echo "  chat             Interactive session: talk to Loki, it builds and verifies"
    echo "  start [SPEC]     Build from a PRD file, issue (owner/repo#N, PROJ-1) or no arg (alias: run)"
    echo "  edit \"<change>\"  Make one targeted change to the current repo"
    echo "  quick \"<task>\"   One small task, no PR"
    echo ""
    echo "Check:"
    echo "  status [--json]  What is running and where it stands"
    echo "  verify [--json]  Deterministic verification (CI-gate exit codes)"
    echo "  receipt          Inspect the proof-of-run receipt (alias of: proof)"
    echo "  diff / undo      See what a run changed; undo <run> to plan or apply a rollback"
    echo ""
    echo "Configure:"
    echo "  setup            First-run setup (provider, keys, defaults)"
    echo "  config           Show or change settings (config list --json)"
    echo "  models           Model tiers and routes (models --local for local models)"
    echo "  agents           Agent roles and routing (route shows where a task would go)"
    echo "  doctor [--json]  Check your setup is ready"
    echo ""
    echo "More:"
    echo "  loki help all            Every command"
    echo "  loki help <topic>        Topics: ${LOKI_HELP_TOPICS// /, }"
    echo "  loki <command> --help    Help for one command"
    echo ""
    echo "New here? Run: loki doctor, then loki quickstart"
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
  loki chat                    Interactive session
  loki plan ./prd.md           Dry run: complexity, cost, plan

Common flags: --provider NAME, --budget USD, --simple, --complex,
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

Claude Code is the default and the only Tier 1 provider.
  loki provider list           Providers and install status
  loki provider set codex      Switch provider (claude, codex, cline, aider, opencode)
  loki start ./prd.md --provider cline

Tier 2: cline. Tier 3 (sequential, degraded): codex, aider. opencode is model-agnostic.
T
            ;;
        agents)
            cat <<'T'
Agents

  loki agents                  List agent roles and their model tiers
  loki route "<task>"          Show which agent and model a task would use
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
  loki undo <run> [--plan]     Plan or apply an undo of a run

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
