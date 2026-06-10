#!/usr/bin/env bash
# provider-offer.sh -- shared, self-contained provider install offer (v7.29.0).
#
# Single source of truth for "no AI provider CLI found" handling, used by BOTH
# the bash CLI (autonomy/loki, sourced) and the Bun-routed doctor
# (loki-ts/src/commands/doctor.ts, via child_process). Parity is by
# construction: there is exactly one prompt + npm install + login handoff
# implementation, and both routes call it.
#
# Self-containment contract (load-bearing for parity): this file depends ONLY
# on bash builtins + npm/claude on PATH. It defines its own colors and never
# reads $RED/$NC or any other variable owned by autonomy/loki, because when
# doctor.ts spawns it standalone those variables are unset. If this file ever
# starts depending on loki's environment, the bash-route and Bun-route bytes
# diverge and the bun-parity matrix breaks.
#
# Security posture (design 1.7): the ONLY command ever executed on the user's
# behalf is `npm install -g @anthropic-ai/claude-code`, only after explicit
# consent, with the exact command printed first. No sudo. No curl-pipe-bash.
# Non-interactive / CI contexts never run an install.

# Guard against double-source (loki may source this more than once via reloads).
if [ -n "${_LOKI_PROVIDER_OFFER_SOURCED:-}" ]; then
    return 0 2>/dev/null || true
fi
_LOKI_PROVIDER_OFFER_SOURCED=1

# --- Self-contained colors (honor NO_COLOR; no dependency on loki) ----------
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
    _PO_RED=''; _PO_YELLOW=''; _PO_BOLD=''; _PO_DIM=''; _PO_NC=''
else
    _PO_RED=$'\033[0;31m'
    _PO_YELLOW=$'\033[1;33m'
    _PO_BOLD=$'\033[1m'
    _PO_NC=$'\033[0m'
fi

# The one canonical install command. Quoted everywhere; never re-derived.
_PO_INSTALL_CMD="npm install -g @anthropic-ai/claude-code"

# detect_any_provider: true (0) if any supported provider CLI is on PATH.
# Extracted verbatim from the loki doctor detection loop (design 1.2).
detect_any_provider() {
    local _dp
    for _dp in claude codex cline aider; do
        command -v "$_dp" >/dev/null 2>&1 && return 0
    done
    return 1
}

# _po_assume_yes: true when the user has opted into unattended confirmation.
# Honors --yes (LOKI_AUTO_CONFIRM, set by loki:1013) and LOKI_ASSUME_YES.
_po_assume_yes() {
    [ "${LOKI_ASSUME_YES:-}" = "1" ] && return 0
    [ "${LOKI_AUTO_CONFIRM:-}" = "true" ] && return 0
    return 1
}

# _po_non_interactive: true when we must NEVER prompt (non-TTY or CI).
# Mirrors cmd_welcome_maybe_firstrun (loki:4286) and maybe_show_auto_plan.
_po_non_interactive() {
    [ ! -t 1 ] && return 0
    [ ! -t 0 ] && return 0
    [ -n "${CI:-}" ] && return 0
    return 1
}

# _po_run_login: offer (or auto-accept) the claude login handoff after a
# successful install. Inherited stdio; Loki never handles credentials.
_po_run_login() {
    # claude must actually be on PATH for login to make sense.
    if ! command -v claude >/dev/null 2>&1; then
        printf "%sInstalled, but 'claude' is not on your PATH yet. You may need to restart your shell or add npm's global bin to PATH (npm config get prefix). Run 'loki doctor' to recheck.%s\n" "$_PO_YELLOW" "$_PO_NC"
        return 0
    fi

    local do_login=""
    if _po_assume_yes; then
        do_login="y"
    else
        printf 'Claude Code installed.\n'
        printf '\n'
        printf 'You still need to authenticate. Run the login flow now? [Y/n] '
        read -r do_login || do_login="n"
    fi
    case "$do_login" in
        ""|y|Y|yes|YES)
            if claude login; then
                printf "%sProvider ready. Run 'loki doctor' to confirm, or 'loki quickstart' to build.%s\n" "$_PO_BOLD" "$_PO_NC"
                return 0
            fi
            printf "Login not completed. Run 'claude login' when ready, then 'loki doctor'.\n"
            return 0
            ;;
        *)
            printf "Login not completed. Run 'claude login' when ready, then 'loki doctor'.\n"
            return 0
            ;;
    esac
}

# _po_do_install: run the one consented command, print it first, handle result.
# Returns 0 on success, non-zero on failure (caller decides exit behavior).
_po_do_install() {
    printf 'Installing Claude Code (%s) ...\n' "$_PO_INSTALL_CMD"
    # The exact, fixed argv. No interpolation, no extra flags. (design 1.7)
    # Capture npm's exit code directly (not via `if`, whose statement status is
    # 0 when the condition is false with no else, masking the real npm code).
    local code=0
    npm install -g @anthropic-ai/claude-code || code=$?
    if [ "$code" -eq 0 ]; then
        printf '\n'
        _po_run_login
        return 0
    fi
    printf '%sInstall failed (npm exited %s). You can retry manually:%s\n' "$_PO_RED" "$code" "$_PO_NC"
    printf '  %s\n' "$_PO_INSTALL_CMD"
    printf 'If this is a permissions error, see https://docs.npmjs.com/resolving-eacces-permissions-errors\n'
    return "$code"
}

# offer_provider_install <mode>
#   mode = "report"  -> doctor: append the offer on a TTY; on non-TTY/CI do
#                       NOTHING (doctor already printed the FAIL + install line,
#                       and we must keep non-TTY/json bytes identical for parity).
#                       Never exits the process.
#   mode = "gate"    -> start/demo/quick pre-flight: on non-TTY/CI print the
#                       honest one-liner to stderr and return 2. On a TTY, prompt;
#                       on decline return 2. On accept install + login.
#
# Honors:
#   LOKI_NO_INSTALL_OFFER=1  -> never prompt; print manual command (1.4)
#   --yes / LOKI_ASSUME_YES  -> auto-accept install + login (1.4)
offer_provider_install() {
    local mode="${1:-gate}"

    # Opt-out: never offer, just surface the manual command.
    if [ "${LOKI_NO_INSTALL_OFFER:-}" = "1" ]; then
        if [ "$mode" = "gate" ]; then
            printf 'No AI provider CLI found. Install one when ready:\n' >&2
            printf '  %s   (then: claude login)\n' "$_PO_INSTALL_CMD" >&2
            return 2
        fi
        printf '\n'
        printf 'Install a provider when ready:\n'
        printf '  %s   (then: claude login)\n' "$_PO_INSTALL_CMD"
        printf '  Other supported providers: codex, cline, aider.\n'
        return 0
    fi

    # Non-interactive / CI: NEVER prompt, NEVER install.
    #
    # gate (start/demo/quick): print the honest one-liner to stderr and return 2
    #   so the caller exits with an actionable message before any spend.
    # report (doctor): stay SILENT. doctor has already printed the FAIL line and
    #   the install command on stdout, so no information is lost. Silence here is
    #   load-bearing for parity: doctor.ts gates its child_process bridge on
    #   process.stdout.isTTY, so on a non-TTY/CI run the Bun route emits nothing
    #   extra. If report-mode printed a stderr line, the bash route would diverge
    #   from Bun in exactly the no-provider/non-TTY case the bun-parity matrix
    #   captures (2>&1) on CI runners, which have no provider installed.
    if _po_non_interactive; then
        if [ "$mode" = "gate" ]; then
            printf 'No AI provider CLI found; cannot prompt to install in a non-interactive shell. Run: %s\n' "$_PO_INSTALL_CMD" >&2
            return 2
        fi
        return 0
    fi

    # npm missing: degraded path, never attempt a non-npm install.
    if ! command -v npm >/dev/null 2>&1; then
        printf '\n'
        printf '%sNo AI provider CLI was found, and npm is not installed either, so Loki%s\n' "$_PO_BOLD" "$_PO_NC"
        printf 'cannot install one for you.\n'
        printf '\n'
        printf 'Install Node.js + npm first (https://nodejs.org), then run:\n'
        printf '  %s\n' "$_PO_INSTALL_CMD"
        printf '  claude login\n'
        printf '\n'
        printf "Already have a provider via another method? Make sure 'claude' (or codex,\n"
        printf "cline, aider) is on your PATH, then run 'loki doctor'.\n"
        [ "$mode" = "gate" ] && return 2
        return 0
    fi

    # TTY, npm present: the interactive offer.
    printf '\n'
    printf 'No AI provider CLI was found. Loki needs one agent CLI to run a build.\n'
    printf '\n'
    printf 'Claude Code is the recommended provider (full feature support).\n'
    printf '  Install:  %s\n' "$_PO_INSTALL_CMD"
    printf '  Then:     claude login\n'
    printf '\n'

    local answer=""
    if _po_assume_yes; then
        answer="y"
    else
        printf 'Install Claude Code now? [Y/n] '
        read -r answer || answer="n"
    fi

    case "$answer" in
        ""|y|Y|yes|YES)
            if _po_do_install; then
                return 0
            fi
            # Install failed: honest failure already printed by _po_do_install.
            [ "$mode" = "gate" ] && return 2
            return 1
            ;;
        *)
            printf 'Skipped. Install a provider when ready:\n'
            printf '  %s   (then: claude login)\n' "$_PO_INSTALL_CMD"
            printf 'Other supported providers: codex, cline, aider.\n'
            [ "$mode" = "gate" ] && return 2
            return 0
            ;;
    esac
}

# provider_offer_gate: convenience wrapper for the start/demo/quick pre-flight.
# Returns 0 if a provider is present (or one was just installed); returns 2 to
# signal the caller should `exit 2` (no provider, declined or non-interactive).
provider_offer_gate() {
    detect_any_provider && return 0
    offer_provider_install gate || return 2
    # After an accepted install, re-detect; if still absent, fail the gate.
    detect_any_provider && return 0
    return 2
}

# Executed directly (doctor.ts child_process bridge, or manual): run the offer.
# When sourced by autonomy/loki, this block does not run.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "${1:-report}" in
        offer|report) offer_provider_install report ;;
        gate)         offer_provider_install gate ;;
        detect)       detect_any_provider ;;
        *)            offer_provider_install report ;;
    esac
fi
