#!/usr/bin/env bash
# Anonymous usage telemetry for Loki Mode
# Collection is ON BY DEFAULT for individual interactive installs, but AUTO-OFF
# in enterprise / CI / air-gapped contexts (see _loki_telemetry_auto_off), so
# enterprise + air-gapped deployments stay silent out of the box (GDPR / FedRAMP
# safe). Only anonymous diagnostics are ever sent (os, arch, version, error type,
# sanitized stack signatures); never code, prompts, paths, keys, or repo names.
# Opt-out (always wins): LOKI_TELEMETRY=off / LOKI_TELEMETRY_DISABLED=true /
#                        DO_NOT_TRACK=1 / ~/.loki/config: TELEMETRY_DISABLED=true
# Force-on:  LOKI_TELEMETRY=on  OR  ~/.loki/config: TELEMETRY_ENABLED=true
# All calls are fire-and-forget, silent on failure, non-blocking.
# Disclosed in docs/PRIVACY.md + a one-time disclosure on first use (never covert).

# _loki_telemetry_auto_off: returns 0 (true, auto-disable) when the environment is
# enterprise / CI / non-interactive / air-gapped, where on-by-default would be
# inappropriate. Keeps "enterprise + air-gapped safe out of the box" literally
# true while still defaulting ON for ordinary individual users. Shared by every
# gate (crash.sh, dashboard/telemetry.py mirror this list).
#   - CI/automation: CI / GITHUB_ACTIONS / GITLAB_CI / BUILDKITE / JENKINS_URL /
#     TEAMCITY_VERSION / CONTINUOUS_INTEGRATION
#   - Enterprise opt-out: LOKI_ENTERPRISE=true / LOKI_AIRGAP=true
#   - Non-interactive: no TTY on stdout AND stdin (scripts/pipes/detached)
_loki_telemetry_auto_off() {
    [ "${CI:-}" = "true" ] && return 0
    [ -n "${GITHUB_ACTIONS:-}" ] && return 0
    [ -n "${GITLAB_CI:-}" ] && return 0
    [ -n "${BUILDKITE:-}" ] && return 0
    [ -n "${JENKINS_URL:-}" ] && return 0
    [ -n "${TEAMCITY_VERSION:-}" ] && return 0
    [ "${CONTINUOUS_INTEGRATION:-}" = "true" ] && return 0
    [ "${LOKI_ENTERPRISE:-}" = "true" ] && return 0
    [ "${LOKI_AIRGAP:-}" = "true" ] && return 0
    # Non-interactive detection (council cH_r1 AC2). Interactivity is resolved
    # EXACTLY ONCE at the real entry point (bin/loki shim top / autonomy/loki
    # main), while the user's TTY is present, and exported as LOKI_TTY_INTERACTIVE.
    # We must trust that explicit signal here instead of a fresh `-t` probe,
    # because this gate runs inside FD-detached subshells (the bin/loki gate-check
    # and the backgrounded emit) where a `-t` probe always sees non-TTY and would
    # wrongly auto-off a real interactive user.
    # Precedence:
    #   - LOKI_TTY_INTERACTIVE=1  -> interactive (do NOT auto-off here)
    #   - LOKI_TTY_INTERACTIVE=0/other set -> non-interactive (auto-off)
    #   - UNSET (gate ran without passing an entry point, e.g. an isolated unit
    #     test) -> fall back to the live `-t` probe so isolated gate tests behave.
    if [ -n "${LOKI_TTY_INTERACTIVE:-}" ]; then
        [ "${LOKI_TTY_INTERACTIVE}" = "1" ] && return 1
        return 0
    fi
    if [ ! -t 1 ] && [ ! -t 0 ]; then
        return 0
    fi
    return 1
}

# BASH_SOURCE is empty when sourced under zsh: skip the lookup rather than
# resolve dirname "" to the current directory.
_LOKI_TELEMETRY_SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
    _LOKI_TELEMETRY_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || _LOKI_TELEMETRY_SELF_DIR=""
fi
LOKI_POSTHOG_HOST="${LOKI_TELEMETRY_ENDPOINT:-https://us.i.posthog.com}"
LOKI_POSTHOG_KEY="phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87"

# _loki_disclose_telemetry_once: one-time, route-shared disclosure (council
# cH_r1 AC4). Prints a single anonymous-diagnostics disclosure to the user's
# REAL stderr the first time collection is ACTUALLY enabled at egress time, then
# records its OWN marker so it never repeats. This is the SINGLE shared impl used
# by BOTH the Bun route (bin/loki, which sources this file at top level just for
# this helper) and the bash route (autonomy/loki main, before its foreground
# cli_command egress) so no first command is ever covert and the copy never
# drifts between routes. Keyed on ~/.loki/.telemetry-disclosed, NOT the
# .loki-first-run sentinel: a first run in CI/auto-off sets .loki-first-run while
# suppressing disclosure, which must NOT permanently silence the disclosure on a
# later interactive (enabled) run (the sentinel edge, AC5). Guarded so a single
# definition wins if both this file and another loader define it.
if ! declare -f _loki_disclose_telemetry_once >/dev/null 2>&1; then
_loki_disclose_telemetry_once() {
    local _marker="${HOME}/.loki/.telemetry-disclosed"
    [ -f "$_marker" ] 2>/dev/null && return 0
    printf '%s\n' \
      "Loki Mode sends anonymous diagnostics (os, arch, version, error type only --" \
      "never your code, prompts, paths, or keys) to help fix bugs. Off in enterprise/" \
      "CI/air-gapped setups. Turn it off anytime: loki telemetry off  (docs/PRIVACY.md)" >&2
    mkdir -p "${HOME}/.loki" 2>/dev/null || return 0
    : > "$_marker" 2>/dev/null || true
    return 0
}
fi

_loki_telemetry_enabled() {
    # Unified gate. Default ON for individual interactive installs; auto-OFF in
    # enterprise/CI/air-gapped contexts; explicit opt-out always wins. Precedence
    # MUST mirror loki_collection_enabled in autonomy/crash.sh and _is_enabled in
    # dashboard/telemetry.py so one model gates BOTH usage telemetry and crash
    # reporting.
    #   1. Any opt-out flag present     -> 1 (hard kill, always wins)
    #   2. Else explicit opt-in present -> 0 (force-on, even in CI/enterprise)
    #   3. Else enterprise/CI/air-gapped -> 1 (auto-off, safe out of the box)
    #   4. Else (individual default)    -> 0 (on, anonymous diagnostics)
    # All enabled paths still require curl (no egress tool -> off).
    local _telem_lower
    _telem_lower="$(printf '%s' "${LOKI_TELEMETRY:-}" | tr '[:upper:]' '[:lower:]')"

    # --- 1. Opt-out always wins ---
    [ "$_telem_lower" = "off" ] && return 1
    [ "${LOKI_TELEMETRY_DISABLED:-}" = "true" ] && return 1
    [ "${DO_NOT_TRACK:-}" = "1" ] && return 1
    if [ -f "${HOME}/.loki/config" ] && grep -q "^TELEMETRY_DISABLED=true" "${HOME}/.loki/config" 2>/dev/null; then
        return 1
    fi

    # --- 2. Explicit opt-in forces ON (overrides the enterprise/CI auto-off) ---
    if [ "$_telem_lower" = "on" ]; then
        command -v curl >/dev/null 2>&1 || return 1
        return 0
    fi
    if [ -f "${HOME}/.loki/config" ] && grep -q "^TELEMETRY_ENABLED=true" "${HOME}/.loki/config" 2>/dev/null; then
        command -v curl >/dev/null 2>&1 || return 1
        return 0
    fi

    # --- 3. Enterprise / CI / air-gapped: auto-off (safe out of the box) ---
    _loki_telemetry_auto_off && return 1

    # --- 4. Individual interactive default: ON (anonymous diagnostics) ---
    command -v curl >/dev/null 2>&1 || return 1
    return 0
}

# _loki_telemetry_id_load: sets _LOKI_TID (the id), _LOKI_TID_MINTED (1 when this
# process created it) and _LOKI_TID_AGE (whole days since the id file was
# written). Called directly, never in a command substitution, so the globals
# survive. The id file is always mode 0600. The last-resort fallback id is random
# hex, never derived from the clock or pid.
_loki_telemetry_id_load() {
    local id_file="${HOME}/.loki-telemetry-id" mtime now
    _LOKI_TID_MINTED=0
    _LOKI_TID_AGE=0
    if [ -f "$id_file" ] 2>/dev/null; then
        _LOKI_TID=$(cat "$id_file" 2>/dev/null)
        if [ -n "$_LOKI_TID" ]; then
            mtime=$(stat -c %Y "$id_file" 2>/dev/null)
            case "$mtime" in ''|*[!0-9]*) mtime=$(stat -f %m "$id_file" 2>/dev/null) ;; esac
            case "$mtime" in
                ''|*[!0-9]*) ;;
                *)
                    now=$(date +%s 2>/dev/null)
                    case "$now" in ''|*[!0-9]*) ;; *)
                        [ "$now" -ge "$mtime" ] && _LOKI_TID_AGE=$(( (now - mtime) / 86400 ))
                    ;; esac
                    ;;
            esac
            return 0
        fi
    fi
    _LOKI_TID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null) || \
    _LOKI_TID=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]') || \
    _LOKI_TID="anon-$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    _LOKI_TID_MINTED=1
    ( umask 077; printf '%s\n' "$_LOKI_TID" > "$id_file" ) 2>/dev/null
    chmod 600 "$id_file" 2>/dev/null
    return 0
}

_loki_telemetry_id() {
    _loki_telemetry_id_load
    printf '%s' "$_LOKI_TID"
}

_loki_detect_channel() {
    local dir="${PROJECT_DIR:-${SKILL_DIR:-${SCRIPT_DIR:-}}}"
    if [ -f "/.dockerenv" ] 2>/dev/null; then printf 'docker'; return; fi
    case "$dir" in
        */Cellar/*|*/homebrew/*) printf 'homebrew' ;;
        */node_modules/*) printf 'npm' ;;
        */.claude/skills/*) printf 'skill' ;;
        *) printf 'source' ;;
    esac
}

# _loki_known_command <token>: FIXED ALLOWLIST at the telemetry boundary. Prints
# the token verbatim when it is a real loki subcommand, else the literal "other".
#
# WHY THIS EXISTS. Every command-shaped telemetry value is the user's raw first
# CLI token, and loki_telemetry's payload builder is a PASS-THROUGH dict, not an
# allowlist. So the honest typo of dropping the subcommand off this project's own
# documented quickstart --
#     loki ./client-acme-merger-prd.md
# -- put a user-authored file name on the wire verbatim. Spec file names routinely
# carry client and codename. Sanitizing at this boundary bounds the value space to
# a fixed, public vocabulary by construction, so no path, flag value, or spec name
# can reach PostHog through a command field regardless of what the user typed.
#
# The arms below mirror autonomy/loki's own `case "$command" in` dispatch (whose
# final `*)` arm is literally this same unknown bucket), UNIONed with the
# bin/loki Bun-route arm (`internal` is Bun-only) and the `report` pre-route.
# A token missing from this list degrades to "other": lossy, never leaky, so a
# stale list after a new subcommand lands is safe by construction.
_loki_known_command() {
    case "${1:-}" in
        --help|--version|-h|-v|agent|analyze|api|assets\
        |audit|bench|checkpoint|ci|cleanup|cluster|cockpit|code\
        |completion|completions|compliance|compound|config|context|control|cost|council|cp\
        |crash|ctx|dashboard|demo|deploy|docker|docs|doctor\
        |dogfood|enterprise|explain|export|factory|failover|github|grill|handoff\
        |heal|help|import|init|internal|issue|kpis|logs\
        |magic|mcp|memory|metrics|migrate|modernize|monitor|next\
        |notify|onboard|open|optimize|otel|own|pause|plan\
        |preview|projects|proof|provider|quick|quickstart|rc|receipt\
        |remote|report|reset|resume|review|rollback|run|sandbox\
        |secrets|secure|self-update|self_update|sentrux|serve|setup-skill|share\
        |ship|spec|start|state|stats|status|steer|stop\
        |syslog|telemetry|template|test|tour|trigger|trust|trust-metrics\
        |ultracode|update|verify|version|voice|watch|watchdog|web\
        |welcome|why|wiki|worktree|wow|wt)
            printf '%s' "$1" ;;
        *)
            printf 'other' ;;
    esac
}

# Clamp a doctor blocker to a FIXED ENUM. Same discipline as
# _loki_known_command: an unrecognized value becomes "other" rather than being
# forwarded, so a new blocker string added later cannot silently start leaking
# text. Deliberately coarse -- we need to know WHICH CLASS of dependency stops
# a first run, never the user's paths, versions, or hostnames.
_loki_known_blocker() {
    case "${1:-}" in
        # not_logged_in is distinct from no_provider on purpose. They are the two
        # halves of the same wall and they need opposite fixes: no_provider means
        # "install something", not_logged_in means "authenticate the thing you
        # already installed". Collapsing the second into `other` would make the
        # single most common post-install failure unactionable in the data --
        # and it is the worst-placed one, since without this the user only learns
        # of it after confirming the spend.
        no_provider|not_logged_in|not_a_repo|git_identity|dirty_tracked_tree|prd_missing|unsupported_flag|node|python3|jq|git|curl|disk|skill_symlink)
            printf '%s' "$1" ;;
        *)
            printf 'other' ;;
    esac
}

# _loki_os_family: raw `uname -s` collapsed to a fixed enum (MINGW64_NT-10.0-19045
# and friends are one family, not one value per Windows build).
_loki_os_family() {
    case "${1:-}" in
        Linux*) printf 'linux' ;;
        Darwin*) printf 'darwin' ;;
        MINGW*|MSYS*|CYGWIN*|Windows*) printf 'windows' ;;
        *) printf 'other' ;;
    esac
}

_loki_arch_family() {
    case "${1:-}" in
        x86_64|amd64|x64) printf 'x64' ;;
        arm64|aarch64) printf 'arm64' ;;
        *) printf 'other' ;;
    esac
}

# _loki_traffic: who is driving this process, as the enum user | ci | internal,
# so analytics can filter bots and our own seats. internal wins, then ci (CI env
# vars or a non-interactive session), else user. Mirrors _traffic in
# dashboard/telemetry.py.
_loki_traffic() {
    if [ "${LOKI_INTERNAL:-}" = "1" ] || [ "${LOKI_SEAT_TICK:-}" = "1" ] || [ -n "${LOKI_SEAT:-}" ] || [ -n "${LOKI_COMPANY_SEAT:-}" ]; then
        printf 'internal'; return
    fi
    if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${GITLAB_CI:-}" ] \
        || [ -n "${BUILDKITE:-}" ] || [ -n "${JENKINS_URL:-}" ] \
        || [ -n "${TEAMCITY_VERSION:-}" ] || [ -n "${CONTINUOUS_INTEGRATION:-}" ]; then
        printf 'ci'; return
    fi
    if [ -n "${LOKI_TTY_INTERACTIVE:-}" ]; then
        [ "${LOKI_TTY_INTERACTIVE}" = "1" ] && printf 'user' || printf 'ci'
        return
    fi
    if [ ! -t 1 ] && [ ! -t 0 ]; then printf 'ci'; return; fi
    printf 'user'
}

# loki_telemetry <event> [key=value...]: the ONE send path of the bash senders.
# Order is load-bearing: the opt-out gate runs before anything else, so with
# LOKI_TELEMETRY=off or DO_NOT_TRACK=1 no python, no curl and no network code is
# reached. Then every key and value is filtered through
# autonomy/lib/telemetry-schema.json (unlisted event: nothing is sent; unknown
# key or out-of-enum value: dropped). Callers' pairs are untrusted by design;
# the trusted base properties are appended last so a caller cannot override them.
loki_telemetry() {
    _loki_telemetry_enabled || return 0
    local event="${1:-}"; shift
    [ -n "$event" ] || return 0
    # The schema sits next to this file; prefer that over SCRIPT_DIR, which some
    # callers leave unset when they only source this file.
    local _lib="${_LOKI_TELEMETRY_SELF_DIR:-}/lib"
    [ -f "$_lib/telemetry-schema.json" ] || _lib="${SCRIPT_DIR:-${SKILL_DIR:-}}/lib"
    [ -f "$_lib/telemetry-schema.json" ] && [ -f "$_lib/proof-analytics-props.py" ] || return 0
    local distinct_id
    _loki_telemetry_id_load 2>/dev/null
    distinct_id="${_LOKI_TID:-}"
    [ -n "$distinct_id" ] || return 0
    local version
    version=$(cat "${SCRIPT_DIR:-${SKILL_DIR:-}}/VERSION" 2>/dev/null || cat "${SCRIPT_DIR:-${SKILL_DIR:-}}/../VERSION" 2>/dev/null || cat "${_LOKI_TELEMETRY_SELF_DIR:-}/../VERSION" 2>/dev/null || echo "unknown")
    version=$(echo "$version" | tr -d '[:space:]')
    local channel
    channel=$(_loki_detect_channel 2>/dev/null || echo "unknown")
    local os_family arch
    os_family=$(_loki_os_family "$(uname -s 2>/dev/null)")
    arch=$(_loki_arch_family "$(uname -m 2>/dev/null)")

    # ephemeral_home: the id was minted by this very process inside a container,
    # so the home is not persisted and every run looks like a new user.
    local ephemeral_home=false
    [ "${_LOKI_TID_MINTED:-0}" = "1" ] && [ "$channel" = "docker" ] && ephemeral_home=true

    # The extra key=value pairs are forwarded as "$@" -- one argv slot per pair,
    # QUOTED, so a value with spaces or glob characters is neither split nor
    # expanded. The python side splits on the first "=" only.
    local payload
    payload=$(python3 "$_lib/proof-analytics-props.py" --payload "$event" "$distinct_id" "$LOKI_POSTHOG_KEY" \
        "$@" "os_family=$os_family" "arch=$arch" "version=$version" "channel=$channel" \
        "traffic=$(_loki_traffic)" \
        "id_age=${_LOKI_TID_AGE:-0}" "ephemeral_home=$ephemeral_home" 2>/dev/null) || return 0
    [ -n "$payload" ] || return 0

    # LOKI_TELEMETRY_DEBUG=1: record and print the event name and the property
    # KEYS (never values, ids or paths) and send nothing. Runs after the opt-out
    # gate and the schema filter, so it shows exactly what would have been sent.
    # `loki telemetry show` reads the same record.
    if [ "${LOKI_TELEMETRY_DEBUG:-}" = "1" ]; then
        local _dbg_line
        _dbg_line=$(printf '%s' "$payload" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(str(d.get("event", "")) + ": " + ", ".join(sorted((d.get("properties") or {}).keys())))
' 2>/dev/null) || return 0
        [ -n "$_dbg_line" ] || return 0
        local _dbg_file="${HOME}/.loki/telemetry-last.log"
        mkdir -p "${HOME}/.loki" 2>/dev/null || true
        { tail -n 19 "$_dbg_file" 2>/dev/null; printf '%s\n' "$_dbg_line"; } > "${_dbg_file}.tmp" 2>/dev/null \
            && mv "${_dbg_file}.tmp" "$_dbg_file" 2>/dev/null
        printf 'telemetry debug (not sent) %s\n' "$_dbg_line" >&2
        return 0
    fi

    (curl -sS --max-time 3 -X POST "${LOKI_POSTHOG_HOST}/capture/" \
        -H "Content-Type: application/json" \
        -d "$payload" >/dev/null 2>&1 &) 2>/dev/null
    return 0
}

# _loki_analytics_enabled: STRICTER, second-layer gate for opt-in build-outcome
# analytics. Sits BELOW the telemetry gate: build_verified fires ONLY when
#   1. telemetry is enabled at all (_loki_telemetry_enabled -- so every opt-out
#      that kills telemetry also kills analytics), AND
#   2. the user EXPLICITLY turned analytics on (LOKI_ANALYTICS/LOKI_POSTHOG=on or
#      ~/.loki/config: ANALYTICS_ENABLED=true).
# Default OFF even for diagnostics-on users: anonymous crash diagnostics are one
# thing, per-build outcome metrics are a separate, explicit consent. Zero-egress-
# by-default is a moat, so this stays strictly opt-in. Only already-computed proof
# scalars are ever sent (see _loki_proof_analytics_props) -- never code, spec text,
# paths, or file names.
_loki_analytics_enabled() {
    _loki_telemetry_enabled || return 1
    local _lower
    _lower="$(printf '%s' "${LOKI_ANALYTICS:-${LOKI_POSTHOG:-}}" | tr '[:upper:]' '[:lower:]')"
    [ "$_lower" = "on" ] && return 0
    [ "$_lower" = "1" ] && return 0
    if [ -f "${HOME}/.loki/config" ] && grep -q "^ANALYTICS_ENABLED=true" "${HOME}/.loki/config" 2>/dev/null; then
        return 0
    fi
    return 1
}

# loki_emit_funnel_once <marker-name> <event> [key=value...]: fire ONE
# first-run-funnel event, at most once per machine, under the SAME strict double
# gate as build_verified (telemetry enabled AND analytics explicitly opted in --
# default OFF even for diagnostics-on users). No new consent knob, no new
# endpoint: it reuses loki_telemetry, so every existing opt-out kills it too.
#
# ORDERING IS LOAD-BEARING. Disclosure runs before the emit, and the marker is
# written only AFTER the gate has passed and we have actually emitted. The
# reverted attempt burned its marker unconditionally, which meant a first run
# under CI/auto-off consumed the one-shot and permanently silenced the event for
# that user. Mirrors _loki_disclose_telemetry_once: act, then mark.
#
# Values must already be bounded (see _loki_known_command). Best-effort: every
# step returns 0, nothing blocks, nothing throws.
loki_emit_funnel_once() {
    local _marker_name="$1"; shift
    local _event="$1"; shift
    _loki_analytics_enabled || return 0
    local _mfile="${HOME}/.loki/funnel-${_marker_name}"
    [ -f "$_mfile" ] 2>/dev/null && return 0
    if declare -f _loki_disclose_telemetry_once >/dev/null 2>&1; then
        _loki_disclose_telemetry_once
    fi
    loki_telemetry "$_event" "$@" 2>/dev/null || true
    mkdir -p "${HOME}/.loki" 2>/dev/null || return 0
    : > "$_mfile" 2>/dev/null || true
    return 0
}

# loki_emit_build_verified <proof.json path>: fire ONE build_verified event
# carrying a FIXED ALLOWLIST of already-computed scalars from a finished
# proof.json. Trust-core untouched -- reads the receipt after it is written,
# never influences the verdict. Fires only under the strict analytics gate.
# The allowlist is enforced in Python (below); anything not named is never read,
# so a schema change cannot silently start leaking a new field. Free-text-shaped
# fields are excluded on purpose: headline is a bounded enum (VERIFIED / VERIFIED
# WITH GAPS / NOT VERIFIED), never spec/project text; files_changed is a COUNT,
# never paths.
# loki_emit_first_run_blocked <blocker-key>: fire ONE first_run_blocked event
# naming the CLASS of dependency that stopped a first run.
#
# WHY THIS EXISTS. `first_start_attempted` already fires, so we know a first run
# was ATTEMPTED and nothing about whether it succeeded. That is the wrong half:
# an attempt that dies at `doctor` looks identical to one that built something.
# Without this, the question that decides an adoption strategy -- does a trial
# fail on capability, discoverability, or trust -- has no data behind it.
#
# The measured motivation is concrete: on a host with no provider CLI the Bun
# route used to print "Some required prerequisites are missing" and stop, while
# bash pointed at `loki tour`. That was a dead end for a first-time evaluator
# and nobody could see it happening.
#
# WHAT IT SENDS, and deliberately no more: one enum from _loki_known_blocker.
# Never a path, a version, a hostname, a spec, or a command line. Coarse on
# purpose -- "node" is actionable, "/Users/x/.nvm/versions/node/v18" is a leak.
# An adoption tool that exfiltrates a user's environment would cost exactly the
# trust this product sells.
#
# Once per install (the funnel marker), under the strict analytics gate, and
# every existing opt-out still wins because it routes through the same
# _loki_analytics_enabled check as everything else.
loki_emit_first_run_blocked() {
    local _blocker
    _blocker="$(_loki_known_blocker "${1:-}")"
    loki_emit_funnel_once "first-run-blocked" "first_run_blocked" \
        "blocker=${_blocker}" 2>/dev/null || true
    return 0
}

loki_emit_build_verified() {
    _loki_analytics_enabled || return 0
    local _proof="$1"
    [ -f "$_proof" ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    local _reader="${SCRIPT_DIR:-${SKILL_DIR:-}}/lib/proof-analytics-props.py"
    [ -f "$_reader" ] || return 0
    local _props
    _props=$(python3 "$_reader" "$_proof" 2>/dev/null) || return 0
    [ -n "$_props" ] || return 0
    # Feed the allowlisted key=value pairs into loki_telemetry (which re-checks
    # the base gate and owns the injection-safe payload build).
    local _args=()
    while IFS= read -r _line; do
        [ -n "$_line" ] && _args+=("$_line")
    done <<< "$_props"
    loki_telemetry "build_verified" "${_args[@]}"
    # Only a VERIFIED headline is the first_verified milestone.
    case "$_props" in
        "headline=VERIFIED"|"headline=VERIFIED"$'\n'*|*$'\n'"headline=VERIFIED"|*$'\n'"headline=VERIFIED"$'\n'*)
            loki_emit_activation first_verified ;;
    esac
    return 0
}

# loki_emit_seal_hook_decision <allow|block> <reason>: one event per loki-seal
# Stop hook decision (the Claude Code wedge). Enum args only: any decision or
# reason outside the fixed lists sends nothing, and the schema re-filters. Never
# a path, file name, test name or error text. Same strict analytics gate as
# build_verified, so every existing opt-out wins.
loki_emit_seal_hook_decision() {
    _loki_analytics_enabled || return 0
    case "${1:-}" in allow|block) ;; *) return 0 ;; esac
    case "${2:-}" in none|tests_failed|tests_weakened|no_tests|contract_unverified|released|error) ;; *) return 0 ;; esac
    loki_telemetry "seal_hook_decision" "decision=$1" "reason=$2"
    return 0
}

# loki_emit_build_verified_enum <headline> <route>: build_verified for the
# default engine10 route, which has no proof.json reader. Enum args only:
# anything but headline=VERIFIED and route=engine10 sends nothing. Same strict
# analytics gate as loki_emit_build_verified.
loki_emit_build_verified_enum() {
    _loki_analytics_enabled || return 0
    [ "${1:-}" = "VERIFIED" ] || return 0
    [ "${2:-}" = "engine10" ] || return 0
    loki_telemetry "build_verified" "headline=VERIFIED" "route=engine10"
    loki_emit_activation first_verified
    return 0
}

# AN-10 activation funnel: five once-per-machine milestones, each carrying a
# coarse since_install bucket. Same strict analytics gate as every other funnel
# event. The install clock is a private epoch file written the first time any
# milestone passes the gate; only the bucket (never the epoch) is sent.
_loki_since_install_bucket() {
    local _f="${HOME}/.loki/funnel-install-ts" _now _t _d
    _now=$(date +%s 2>/dev/null) || return 1
    _t=$(cat "$_f" 2>/dev/null)
    case "$_t" in ''|*[!0-9]*)
        mkdir -p "${HOME}/.loki" 2>/dev/null || return 1
        printf '%s\n' "$_now" > "$_f" 2>/dev/null || true
        _t="$_now" ;;
    esac
    _d=$((_now - _t))
    if [ "$_d" -lt 3600 ]; then printf 'lt_1h'
    elif [ "$_d" -lt 86400 ]; then printf 'lt_1d'
    elif [ "$_d" -lt 604800 ]; then printf 'lt_7d'
    elif [ "$_d" -lt 2592000 ]; then printf 'lt_30d'
    else printf 'ge_30d'; fi
}

# loki_emit_activation <install|first_start|first_run_finished|first_verified|
# second_run_within_7d>: emits activation_<step> at most once per machine. The
# step is claimed atomically (mkdir) after the analytics gate and before the
# send, so concurrent emitters send it once. The marker (holding the emit epoch)
# is written after the gate and the send attempt, not after confirmed delivery,
# so an opted-out machine never burns it. Any step first ensures the install
# step has fired, so the order install -> ... holds.
loki_emit_activation() {
    local _step="${1:-}"
    case "$_step" in install|first_start|first_run_finished|first_verified|second_run_within_7d) ;; *) return 0 ;; esac
    _loki_analytics_enabled || return 0
    local _dir="${HOME}/.loki"
    [ -f "${_dir}/funnel-activation-${_step}" ] 2>/dev/null && return 0
    mkdir -p "$_dir" 2>/dev/null || return 0
    mkdir "${_dir}/funnel-activation-${_step}.d" 2>/dev/null || return 0
    if [ "$_step" != "install" ]; then
        loki_emit_activation install
    fi
    local _bucket
    _bucket=$(_loki_since_install_bucket) || return 0
    if declare -f _loki_disclose_telemetry_once >/dev/null 2>&1; then
        _loki_disclose_telemetry_once
    fi
    case "$_step" in
        install) loki_telemetry "activation_install" "since_install=${_bucket}" 2>/dev/null || true ;;
        first_start) loki_telemetry "activation_first_start" "since_install=${_bucket}" 2>/dev/null || true ;;
        first_run_finished) loki_telemetry "activation_first_run_finished" "since_install=${_bucket}" 2>/dev/null || true ;;
        first_verified) loki_telemetry "activation_first_verified" "since_install=${_bucket}" 2>/dev/null || true ;;
        second_run_within_7d) loki_telemetry "activation_second_run_within_7d" "since_install=${_bucket}" 2>/dev/null || true ;;
    esac
    mkdir -p "$_dir" 2>/dev/null || return 0
    date +%s > "${_dir}/funnel-activation-${_step}" 2>/dev/null || true
    return 0
}

# _loki_activation_run_started: the first run start is first_start; a later
# run start inside 7 days of it is second_run_within_7d.
_loki_activation_run_started() {
    _loki_analytics_enabled || return 0
    local _m="${HOME}/.loki/funnel-activation-first_start" _t _now
    if [ ! -f "$_m" ]; then
        loki_emit_activation first_start
        return 0
    fi
    _t=$(cat "$_m" 2>/dev/null)
    case "$_t" in ''|*[!0-9]*) return 0 ;; esac
    _now=$(date +%s 2>/dev/null) || return 0
    if [ "$_now" -gt "$_t" ] && [ $((_now - _t)) -le 604800 ]; then
        loki_emit_activation second_run_within_7d
    fi
    return 0
}

# loki_emit_run_started: one run_started event for a default-route (engine10)
# run. Fixed engine value, no caller input. Same strict analytics gate as the
# other run-outcome events, so every existing opt-out wins.
loki_emit_run_started() {
    _loki_analytics_enabled || return 0
    loki_telemetry "run_started" "engine=engine10"
    _loki_activation_run_started
    return 0
}

# loki_emit_run_finished <verdict> [key=value...]: one run_finished event.
# Enum and integer args only: a verdict outside the fixed list sends nothing,
# and a pair is forwarded only when its key is duration_s, fix_rounds, provider_failovers, exit_code
# or stage_s_<engine stage> AND its value is a plain non-negative integer, or
# its key is a context bucket (provider, model_tier, lang_bucket,
# repo_size_bucket, test_runner, cost_bucket, token_bucket) AND its value is
# lowercase ASCII letters, digits or underscore, checked against an explicit
# character list so no locale collation can widen it (the schema holds the exact
# enum, and the Python send-time filter is the authority). Never
# a path, repo, branch, prompt or error text; the schema re-filters at send.
loki_emit_run_finished() {
    _loki_analytics_enabled || return 0
    local _verdict="${1:-}"; shift
    case "$_verdict" in VERIFIED|PARTIAL|ALREADY_SATISFIED|SPEC_CONFLICT|FAILED|INTERRUPTED|BLOCKED) ;; *) return 0 ;; esac
    local _args=("engine=engine10" "verdict=${_verdict}") _kv _k _v
    for _kv in "$@"; do
        _k="${_kv%%=*}"; _v="${_kv#*=}"
        case "$_k" in
            duration_s|fix_rounds|provider_failovers|exit_code|stage_s_intake|stage_s_plan|stage_s_wall|stage_s_implement|stage_s_verify|stage_s_fix|stage_s_commit|stage_s_seal|stage_s_pr|stage_s_deep)
                case "$_v" in ''|*[!0-9]*) continue ;; esac
                [ "${#_v}" -le 9 ] || continue ;;
            provider|model_tier|lang_bucket|repo_size_bucket|test_runner|cost_bucket|token_bucket)
                case "$_v" in ''|*[!abcdefghijklmnopqrstuvwxyz0123456789_]*) continue ;; esac
                [ "${#_v}" -le 16 ] || continue ;;
            *) continue ;;
        esac
        _args+=("${_k}=${_v}")
    done
    loki_telemetry "run_finished" "${_args[@]}"
    loki_emit_activation first_run_finished
    [ "$_verdict" = "VERIFIED" ] && loki_emit_activation first_verified
    return 0
}
