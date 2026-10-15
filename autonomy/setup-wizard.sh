#!/usr/bin/env bash
# setup-wizard.sh -- `loki setup`: the single first-run wizard.
# Sourced by autonomy/loki; relies on cmd_config_set and SKILL_DIR from that
# file. `loki welcome` (intro), `loki quickstart` (first build) and
# `loki doctor` (health) remain separate entry points.
#
# REQUIRED (doctor fails without them): node >= 20, python3 >= 3.8, jq, git, curl
# AT LEAST ONE of: a provider CLI (claude, codex, cline, aider, opencode) or the
#   bundled Claude Agent SDK with credentials. Claude Code is the default.
# OPTIONAL: bun (bundled by npm), bash >= 4, codex/cline/aider/opencode, ollama.

_lsw_ask() {
    # _lsw_ask PROMPT DEFAULT -> echoes the answer; DEFAULT when --yes or no TTY
    local prompt="$1" def="$2" ans=""
    if [ "$_LSW_YES" = "1" ] || [ ! -t 0 ]; then
        printf '%s' "$def"
        return 0
    fi
    printf '%s [%s]: ' "$prompt" "$def" >&2
    read -r ans || ans=""
    printf '%s' "${ans:-$def}"
}

_lsw_confirm() {
    # _lsw_confirm PROMPT -> 0 for yes; --yes accepts, no TTY declines
    local ans=""
    [ "$_LSW_YES" = "1" ] && return 0
    [ ! -t 0 ] && return 1
    printf '%s [y/N] ' "$1" >&2
    read -r ans || ans=""
    case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

_lsw_fix() {
    # _lsw_fix ID FALLBACK -> the one-line fix from the shared requirements table
    # (autonomy/lib/setup-requirements.json), the same text loki doctor prints.
    local out=""
    out="$(jq -r --arg id "$1" '.requirements[] | select(.id == $id) | .fix' "${SKILL_DIR}/autonomy/lib/setup-requirements.json" 2>/dev/null | head -n 1)" || out=""
    printf '%s' "${out:-$2}"
}

_lsw_tool() {
    # _lsw_tool NAME LABEL INSTALL_HINT
    if command -v "$1" >/dev/null 2>&1; then
        printf '  [ OK ]  %-10s %s\n' "$1" "$2"
        return 0
    fi
    printf '  [MISS]  %-10s %s. Install: %s\n' "$1" "$2" "$3"
    [ "$2" = "REQUIRED" ] && _LSW_MISSING=$((_LSW_MISSING + 1))
    return 1
}

_lsw_help() {
    echo "loki setup - first-run wizard (tools, provider, model route, spend cap)"
    echo ""
    echo "Usage: loki setup [--yes] [--provider NAME] [--model ROUTE] [--budget USD] [--global] [--check]"
    echo ""
    echo "  --yes, -y         Non-interactive: accept defaults, never prompt"
    echo "  --provider NAME   claude (default), codex, cline, aider, opencode"
    echo "  --model ROUTE     claude (default), ollama/<model>, openrouter/<vendor>/<model>"
    echo "  --budget USD      Spend cap in USD (default: none)"
    echo "  --global          Write to ~/.config/loki-mode instead of .loki/config"
    echo "  --check           Report only; change nothing"
    echo ""
    echo "Related: loki welcome (intro), loki quickstart (first build), loki doctor (health)."
}

cmd_setup() {
    _LSW_YES=0
    _LSW_MISSING=0
    local provider="" model="" budget="" use_global="" check_only=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --yes|-y) _LSW_YES=1 ;;
            --provider) provider="${2:-}"; shift ;;
            --model) model="${2:-}"; shift ;;
            --budget) budget="${2:-}"; shift ;;
            --global) use_global="--global" ;;
            --check) check_only=1 ;;
            --help|-h) _lsw_help; return 0 ;;
            *) echo "Unknown option: $1" >&2; _lsw_help >&2; return 2 ;;
        esac
        shift
    done
    [ -n "${CI:-}" ] && _LSW_YES=1

    echo "Loki Mode setup"
    echo ""
    echo "1. Required tools"
    _lsw_tool node REQUIRED "$(_lsw_fix node "install Node 20+ from https://nodejs.org")" || true
    _lsw_tool python3 REQUIRED "$(_lsw_fix python3 "install python3")" || true
    _lsw_tool jq REQUIRED "$(_lsw_fix jq "install jq")" || true
    _lsw_tool git REQUIRED "$(_lsw_fix git "install git")" || true
    _lsw_tool curl REQUIRED "$(_lsw_fix curl "install curl")" || true
    _lsw_tool bun OPTIONAL "$(_lsw_fix bun "bundled by npm; else see https://bun.sh")" || true
    if [ "$_LSW_MISSING" -gt 0 ]; then
        echo ""
        echo "Install the missing REQUIRED tools above with your package manager (setup never installs system packages), then rerun: loki setup"
        return 1
    fi

    echo ""
    echo "2. Provider CLI (Claude Code is the default and the only Tier-1 provider)"
    local p
    for p in codex cline aider opencode; do
        _lsw_tool "$p" OPTIONAL "$(_lsw_fix "$p" "see 'loki doctor' for the command")" || true
    done
    if command -v claude >/dev/null 2>&1; then
        printf '  [ OK ]  %-10s DEFAULT\n' claude
        if claude auth status 2>/dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
            echo "          claude is logged in."
        else
            echo "          claude is installed but not logged in. Run: claude auth login"
            if [ "$check_only" = 0 ] && _lsw_confirm "Run 'claude auth login' now?"; then
                claude auth login || true
            fi
        fi
    else
        echo "  [MISS]  claude     DEFAULT. Install: $(_lsw_fix claude "npm install -g @anthropic-ai/claude-code")   (then: claude auth login)"
        if [ "$check_only" = 0 ] && [ -f "${SKILL_DIR}/autonomy/provider-offer.sh" ]; then
            if _lsw_confirm "Run that install command now?"; then
                # shellcheck disable=SC1091
                . "${SKILL_DIR}/autonomy/provider-offer.sh"
                LOKI_ASSUME_YES="$_LSW_YES" _po_do_install || true
            fi
        fi
        if ! command -v claude >/dev/null 2>&1; then
            echo "          Claude Code is not mandatory if another provider above is installed,"
            echo "          or if you use the Anthropic API-key path (LOKI_SDK_MODE=full with ANTHROPIC_API_KEY)."
            echo "          Requirements per path: loki doctor --requirements"
        fi
    fi

    if [ "$check_only" = 1 ]; then
        echo ""
        echo "Check only: no config written."
        return 0
    fi

    echo ""
    echo "3. Provider and model route"
    [ -z "$provider" ] && provider="$(_lsw_ask "Provider (claude|codex|cline|aider|opencode)" claude)"
    [ -z "$model" ] && model="$(_lsw_ask "Model route (claude | ollama/<model> | openrouter/<vendor>/<model>)" claude)"
    echo ""
    echo "4. Spend cap"
    [ -z "$budget" ] && budget="$(_lsw_ask "Spend cap in USD (blank for none)" "")"

    echo ""
    echo "5. Writing config"
    # shellcheck disable=SC2086
    cmd_config_set $use_global provider "$provider" || return 1
    if [ -n "$budget" ]; then
        # shellcheck disable=SC2086
        cmd_config_set $use_global budget "$budget" || return 1
    fi
    case "$model" in
        ""|claude) ;;
        ollama/*)
            echo "  Model route: pass '--model $model' to loki start (Ollama must be running: ollama serve)."
            ;;
        openrouter/*)
            echo "  Model route: pass '--model $model' and export OPENROUTER_API_KEY (setup never stores keys)."
            ;;
        *) echo "  Unrecognized route '$model'; using the provider default." ;;
    esac

    echo ""
    echo "Done. Next: loki doctor (verify), loki quickstart (first build). Inspect: loki config list"
    return 0
}
