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

# Section colors for render_provider_availability. Deliberately gated on
# NO_COLOR ALONE, unlike the _PO_* set above which also blanks on a non-TTY.
# The section is printed inside `loki doctor` next to blocks colored by loki own
# CYAN/GREEN/NC, and those are blanked on NO_COLOR only (autonomy/loki:37). A
# TTY test here would strip color from this one section whenever doctor stdout
# is piped while every neighbour kept its escapes.
if [ -n "${NO_COLOR:-}" ]; then
    _PO_S_CYAN=''; _PO_S_GREEN=''; _PO_S_YELLOW=''; _PO_S_DIM=''; _PO_S_NC=''
else
    _PO_S_CYAN=$'\033[0;36m'
    _PO_S_GREEN=$'\033[0;32m'
    _PO_S_YELLOW=$'\033[1;33m'
    _PO_S_DIM=$'\033[2m'
    _PO_S_NC=$'\033[0m'
fi

# The one canonical install command. Quoted everywhere; never re-derived.
_PO_INSTALL_CMD="npm install -g @anthropic-ai/claude-code"

# detect_any_provider: true (0) if any supported provider CLI is on PATH.
# Extracted verbatim from the loki doctor detection loop (design 1.2).
#
# DELIBERATELY PATH-ONLY. Do NOT fold the bundled-SDK predicate below into this
# function. Its callers include cmd_demo (loki:12369 -> bash cmd_start) and
# cmd_quick (loki:12701 -> execs run.sh), both of which stay on the BASH route
# even under LOKI_SDK_MODE=full and therefore genuinely require a binary on PATH
# (providers/claude.sh:108 provider_detect is `command -v claude`). Opening this
# gate for them would be a fail-open: a green pre-flight followed by a runner
# that cannot invoke anything.
# The list must match auto_detect_provider() in providers/loader.sh, which is
# the authority on what counts as a usable provider. It omitted `opencode`, so
# an opencode-only machine failed this gate entirely: quickstart told the user
# they had no provider CLI and offered to install claude, and cmd_start exited
# 2 -- a fully working machine blocked from starting a build.
#
# Kept PATH-only on purpose (see above): this gate must stay a real binary
# check, so the fix is the missing NAME, never a looser mechanism.
detect_any_provider() {
    local _dp
    for _dp in claude cline codex aider opencode; do
        command -v "$_dp" >/dev/null 2>&1 && return 0
    done
    return 1
}

# detect_bundled_sdk_provider: true (0) only when the bundled Claude Agent SDK
# can ACTUALLY run this machine's main loop with no separate CLI install.
#
# FAIL CLOSED BY CONSTRUCTION. A green doctor followed by a failed first build is
# worse than today's honest blocker, so all THREE conditions must hold:
#
#   1. USABLE, not merely declared. @anthropic-ai/claude-agent-sdk is an
#      optionalDependency whose own per-platform binary is itself an
#      optionalDependency, so `--no-optional`, an offline install, or an
#      unsupported platform all leave the package listed in package.json (or even
#      sdk.mjs on disk) with NO runnable executable. We therefore probe for the
#      extracted binary at @anthropic-ai/claude-agent-sdk-<platform>/claude, not
#      for the JS entrypoint. Glob over the platform suffix instead of mapping
#      uname, so a new platform tuple needs no edit here.
#   2. CREDENTIALS present. The SDK is pure HTTPS: ANTHROPIC_API_KEY, an
#      ANTHROPIC_AUTH_TOKEN, or an ANTHROPIC_BASE_URL gateway. Absent all three,
#      the loop would stall exactly like a logged-out CLI.
#   3. THE SDK LOOP IS ACTIVE. This is the condition that is easy to miss: with
#      the SDK installed and a key set but LOKI_SDK_MODE unset, `loki start`
#      never forks to Bun (bin/loki:255 tests LOKI_SDK_LOOP) and dies on the bash
#      route at loki:1940. We read LOKI_SDK_LOOP because autonomy/lib/sdk-mode.sh
#      has already resolved LOKI_SDK_MODE=full into it at bin/loki:41-46, which
#      runs for every subcommand. Reading the resolved flag (not the mode string)
#      also honors an explicit per-site LOKI_SDK_LOOP=1.
#
# Any doubt -> return 1 and the caller keeps today's behavior verbatim.
detect_bundled_sdk_provider() {
    # MATCH bin/loki:255 EXACTLY -- only "1" and "true" fork to the Bun SDK loop.
    # bin/loki's own comment concedes it cannot cheaply reproduce truthy()'s
    # yes/on spellings, so accepting a wider set here is a proven fail-open:
    # LOKI_SDK_LOOP=yes made doctor print PASS while the very next `loki start`
    # stayed on the bash route and exited 2 at the provider gate. Doctor green,
    # build dead. Keep these two sets byte-identical; widening either one alone
    # reopens the hole.
    case "${LOKI_SDK_LOOP:-}" in
        1|true) : ;;
        *) return 1 ;;
    esac

    # The Bun runtime must actually exist. bin/loki:200-203 silently execs the
    # BASH CLI when `command -v bun` fails ("keeps users on systems without Bun
    # working"), and the bash route needs a binary on PATH. Without this check a
    # bun-less machine with the SDK + a key would pass doctor and then die.
    command -v bun >/dev/null 2>&1 || return 1

    if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] \
        && [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
        return 1
    fi

    # Search the node_modules trees Loki is actually installed into. The root is
    # derived from THIS FILE's location (self-containment contract, see header):
    # SKILL_DIR belongs to autonomy/loki and is NOT exported, so it would be
    # empty when doctor.ts spawns this script standalone -- which would silently
    # answer "no SDK" on the Bun route while the bash route said yes, exactly the
    # kind of route split the parity gate exists to prevent.
    # LOKI_SDK_NODE_MODULES is a TEST-ONLY seam (never set in production) so the
    # shell tests can point at a fixture tree without mutating real node_modules.
    local _po_root
    _po_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || _po_root=""
    # Array, not a word-split string: install roots can contain spaces.
    local _po_search=()
    if [ -n "${LOKI_SDK_NODE_MODULES:-}" ]; then
        # When the test seam is set it is AUTHORITATIVE (not merely first): the
        # real tree must not be consulted as a fallback, or a fixture asserting
        # "no usable SDK" would silently pass by finding the repo's own binary.
        _po_search=("$LOKI_SDK_NODE_MODULES")
    elif [ -n "$_po_root" ]; then
        # Two layouts, both real:
        #   repo clone      -> <root>/node_modules, <root>/loki-ts/node_modules
        #   npm install     -> npm HOISTS the SDK out of node_modules/loki-mode/
        #                      up to the installing tree's top-level
        #                      node_modules/ (verified by packing this repo and
        #                      installing the tarball). Without the hoisted
        #                      candidates the predicate silently returns 1 for
        #                      every npm-installed user, i.e. the feature would
        #                      be dead for exactly the audience it targets.
        # <root> is .../node_modules/loki-mode, so ../ is the @scope-less
        # top-level node_modules and ../../ covers a scoped install.
        _po_search=(
            "$_po_root/node_modules"
            "$_po_root/loki-ts/node_modules"
            "$_po_root/.."
            "$_po_root/../.."
        )
    fi
    local _nm
    for _nm in ${_po_search+"${_po_search[@]}"}; do
        [ -n "$_nm" ] || continue
        set -- "$_nm"/@anthropic-ai/claude-agent-sdk-*/claude
        # Unmatched globs stay literal in bash, so test the expansion for real.
        while [ "$#" -gt 0 ]; do
            [ -x "$1" ] && return 0
            shift
        done
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

# _po_run_login: offer (or auto-accept) the claude auth login handoff after a
# successful install. Inherited stdio; Loki never handles credentials.
_po_run_login() {
    # claude must actually be on PATH for login to make sense.
    # If the install succeeded but the binary is not yet resolvable, npm's
    # global bin is almost certainly not on PATH. Print the exact copy-paste
    # fix. We print the literal $(npm config get prefix) form (single-quoted,
    # NOT executed here) so the user runs it in their own shell and so this
    # post-install path makes no extra npm invocation.
    if ! command -v claude >/dev/null 2>&1; then
        printf "%sInstalled, but 'claude' is not on your PATH yet. Add npm's global bin to your shell:%s\n" "$_PO_YELLOW" "$_PO_NC"
        printf '  export PATH="$(npm config get prefix)/bin:$PATH"\n'
        printf "Then restart your shell (or source your rc) and run: loki doctor\n"
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
            if claude auth login; then
                # Do not trust the exit code alone: verify the session is
                # actually authenticated before claiming readiness (council
                # HIGH: the old path could falsely report success).
                if claude auth status 2>/dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
                    printf "%sProvider ready. Run 'loki doctor' to confirm, or 'loki quickstart' to build.%s\n" "$_PO_BOLD" "$_PO_NC"
                    return 0
                fi
                printf "Login finished but authentication could not be confirmed. Run 'claude auth status' to check, then 'loki doctor'.\n"
                return 0
            fi
            printf "Login not completed. Run 'claude auth login' when ready, then 'loki doctor'.\n"
            return 0
            ;;
        *)
            printf "Login not completed. Run 'claude auth login' when ready, then 'loki doctor'.\n"
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
            printf '  %s   (then: claude auth login)\n' "$_PO_INSTALL_CMD" >&2
            return 2
        fi
        printf '\n'
        printf 'Install a provider when ready:\n'
        printf '  %s   (then: claude auth login)\n' "$_PO_INSTALL_CMD"
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
        printf '  claude auth login\n'
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
    printf '  Then:     claude auth login\n'
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
            printf '  %s   (then: claude auth login)\n' "$_PO_INSTALL_CMD"
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
    offer_provider_install gate || { _provider_gate_emit_blocked; return 2; }
    # After an accepted install, re-detect; if still absent, fail the gate.
    detect_any_provider && return 0
    _provider_gate_emit_blocked
    return 2
}

# Report that a first run died here. THIS is the wall most first runs hit --
# every one of `loki start`, `demo`, `quick` and `quickstart` funnels through
# provider_offer_gate and exits 2 -- and until now not one of those four exits
# emitted anything. `first_start_attempted` fired, so the funnel recorded that a
# first run was ATTEMPTED and nothing about whether it survived: an attempt that
# died for want of a provider CLI looked identical to one that shipped a build.
#
# Emitting from the gate rather than from each of the four callers is deliberate:
# one site cannot drift out of sync with the others, and a future caller of the
# gate is instrumented by construction rather than by remembering.
#
# Sends the bounded enum `no_provider` and nothing else -- no path, no version,
# no hostname, no command line -- and routes through loki_emit_first_run_blocked,
# so every existing opt-out and the once-per-machine marker still apply. Silent
# and non-fatal if telemetry is unavailable: a diagnostic must never be able to
# break the command it is diagnosing.
_provider_gate_emit_blocked() {
    if declare -f loki_emit_first_run_blocked >/dev/null 2>&1; then
        ( loki_emit_first_run_blocked "no_provider" >/dev/null 2>&1 </dev/null & ) 2>/dev/null || true
    fi
    return 0
}

# render_provider_availability: print the "Provider Availability" doctor section.
#
# WHY IT LIVES HERE. `loki doctor` stdout is compared byte for byte between the
# bash route and the Bun route (tests/test-doctor-blocker-parity.sh, and the
# bun-parity workflow). Two independent renderers drift; one shared renderer
# cannot. This is the same parity-by-construction seam the install offer and the
# detect-sdk probe already use, so doctor.ts calls this instead of reimplementing
# the priority list in TypeScript.
#
# WHY IT DOES NOT REUSE THE EXISTING "AI Providers" BLOCK. That block answers a
# different question -- is each CLI on PATH, and how do I install it. This one
# answers "which provider would a build actually pick", which is a property of
# providers/loader.sh auto_detect_provider, not of PATH. It also covers opencode,
# which the older block never listed.
#
# THE ORDER IS NOT SUPPORTED_PROVIDERS. auto_detect_provider walks
# claude cline codex aider opencode; SUPPORTED_PROVIDERS is declared
# claude codex cline aider opencode -- codex and cline are SWAPPED. Marking the
# first installed entry of SUPPORTED_PROVIDERS would name codex on a machine
# where a build would really pick cline. So the selected provider is always
# whatever auto_detect_provider returns, never re-derived here.
#
# DEGRADES SILENTLY. Requirement: if loader.sh cannot be sourced, the section is
# skipped rather than erroring. Everything runs inside one subshell, so a missing
# or broken loader returns non-zero with nothing printed and doctor continues.
render_provider_availability() {
    # Path derived from THIS FILE, never from SKILL_DIR or _LOKI_SCRIPT_DIR:
    # those belong to autonomy/loki and are unset when doctor.ts spawns this
    # script standalone, which would blank the section on the Bun route only.
    local _po_here
    _po_here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || return 1
    local _loader="$_po_here/providers/loader.sh"
    [ -f "$_loader" ] || return 1

    (
        # shellcheck source=/dev/null
        source "$_loader" >/dev/null 2>&1 || exit 1
        declare -f auto_detect_provider >/dev/null 2>&1 || exit 1
        [ "${#SUPPORTED_PROVIDERS[@]}" -gt 0 ] 2>/dev/null || exit 1

        local _selected
        _selected="$(auto_detect_provider 2>/dev/null)"

        printf '%s\n' "${_PO_S_CYAN}Provider Availability:${_PO_S_NC}"
        local _p
        for _p in "${SUPPORTED_PROVIDERS[@]}"; do
            if check_provider_installed "$_p" >/dev/null 2>&1; then
                if [ "$_p" = "$_selected" ]; then
                    printf '%s\n' "  ${_PO_S_GREEN}PASS${_PO_S_NC}  $_p - installed ${_PO_S_DIM}(auto-selected)${_PO_S_NC}"
                else
                    printf '%s\n' "  ${_PO_S_GREEN}PASS${_PO_S_NC}  $_p - installed"
                fi
            else
                printf '%s\n' "  ${_PO_S_YELLOW}WARN${_PO_S_NC}  $_p - not installed"
            fi
        done

        if [ -n "$_selected" ]; then
            printf '%s\n' "  ${_PO_S_DIM}Auto-selected provider: ${_selected} (override with LOKI_PROVIDER)${_PO_S_NC}"
        else
            printf '%s\n' "  ${_PO_S_DIM}Auto-selected provider: none (no supported CLI installed)${_PO_S_NC}"
        fi
    ) || return 1
}

# provider_availability_json: the same data as one JSON object, for doctor --json.
# Separate from the renderer so neither format has to parse the other. Same
# degrade rule: no loader means no output and a non-zero status.
provider_availability_json() {
    local _po_here
    _po_here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || return 1
    local _loader="$_po_here/providers/loader.sh"
    [ -f "$_loader" ] || return 1

    (
        # shellcheck source=/dev/null
        source "$_loader" >/dev/null 2>&1 || exit 1
        declare -f auto_detect_provider >/dev/null 2>&1 || exit 1
        [ "${#SUPPORTED_PROVIDERS[@]}" -gt 0 ] 2>/dev/null || exit 1

        local _selected _p _rows=""
        _selected="$(auto_detect_provider 2>/dev/null)"
        for _p in "${SUPPORTED_PROVIDERS[@]}"; do
            if check_provider_installed "$_p" >/dev/null 2>&1; then
                _rows="${_rows}${_p}=true"$'\n'
            else
                _rows="${_rows}${_p}=false"$'\n'
            fi
        done
        _PA_SELECTED="$_selected" _PA_ROWS="$_rows" python3 -c '
import json, os
rows = []
for line in os.environ.get("_PA_ROWS", "").splitlines():
    if not line:
        continue
    name, _, installed = line.partition("=")
    rows.append({"name": name, "installed": installed == "true"})
selected = os.environ.get("_PA_SELECTED", "") or None
print(json.dumps({"selected": selected, "providers": rows}, indent=2))
' 2>/dev/null || exit 1
    ) || return 1
}

# Executed directly (doctor.ts child_process bridge, or manual): run the offer.
# When sourced by autonomy/loki, this block does not run.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "${1:-report}" in
        offer|report) offer_provider_install report ;;
        gate)         offer_provider_install gate ;;
        detect)       detect_any_provider ;;
        # Silent, exit-status-only probe for the Bun doctor bridge
        # (loki-ts/src/commands/doctor.ts). Prints nothing, so it cannot perturb
        # the parity-captured stdout.
        detect-sdk)   detect_bundled_sdk_provider ;;
        # Doctor "Provider Availability" section + its --json payload. Both
        # routes call these so the two renderings cannot drift apart.
        providers)      render_provider_availability ;;
        providers-json) provider_availability_json ;;
        *)            offer_provider_install report ;;
    esac
fi
