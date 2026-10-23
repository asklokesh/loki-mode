#!/usr/bin/env bash
# Core help screen and help topics for `loki help`. Source this file; it
# defines functions only. The full command table stays in show_help_all
# (autonomy/loki) and is reached with `loki help all`.

# Topics reachable as `loki help <topic>`. Keep in sync with help_topic_text.
LOKI_HELP_TOPICS="providers exit-codes"

help_core_screen() {
    local version="$1"
    echo "Loki Mode v${version}"
    echo ""
    echo "Usage: loki <command> [options]"
    echo ""
    echo "Start:"
    echo "  start [SPEC]     PRIMARY: build from a PRD file, brief, or issue (owner/repo#N, PROJ-1) (alias: run)"
    echo "  chat [--attach]  Interactive alternative; --attach joins the current 'loki start' run"
    echo "  edit \"<change>\"  Make one targeted change to the current repo"
    echo "  quick \"<task>\"   One small task, no PR"
    echo ""
    echo "Check:"
    echo "  status [--json|--badge|--probe]  What is running and where it stands"
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
    echo "Options for 'start': --provider NAME, --model ID, --budget USD (default cap $(loki_budget_default_usd 2>/dev/null)), --isolation LVL (isolation dial: none | worktree | docker)"
    echo "Also: cost / estimate (spend before you build), resume (continue a paused or interrupted run)"
    echo "Exit codes: docs/exit-codes.md"
    echo ""
    echo "Examples:"
    echo "  loki start ./prd.md                 Build from a spec file"
    echo "  loki start owner/repo#123           Build from a GitHub issue"
    echo "  loki start ./prd.md --budget 20     Cap spend at 20 USD"
    echo "  loki plan ./prd.md                  Dry run: complexity, cost, plan"
    echo "  loki verify --json                  Machine-readable verification for CI"
    echo "  loki resume                         Continue a paused or interrupted run"
    echo "  loki status --json                  What is running, as JSON"
    echo "  loki cost ./prd.md                  Estimate spend before you build"
    echo "  loki doctor --fix                   Check setup and repair what it can"
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
  loki verify --fast           Static checks plus loki_wall_* files (repo code, executed); no model call
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
