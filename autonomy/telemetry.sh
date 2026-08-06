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

_loki_telemetry_id() {
    local id_file="${HOME}/.loki-telemetry-id"
    if [ -f "$id_file" ] 2>/dev/null; then
        cat "$id_file" 2>/dev/null
        return
    fi
    local new_id
    new_id=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null) || \
    new_id=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]') || \
    new_id="anon-$(date +%s)-$$"
    printf '%s\n' "$new_id" > "$id_file" 2>/dev/null
    printf '%s' "$new_id"
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
        |completions|compliance|compound|config|context|cost|council|cp\
        |crash|ctx|dashboard|demo|deploy|docker|docs|doctor\
        |dogfood|enterprise|explain|export|failover|github|grill|handoff\
        |heal|help|import|init|internal|issue|kpis|logs\
        |magic|mcp|memory|metrics|migrate|modernize|monitor|next\
        |notify|onboard|open|optimize|otel|own|pause|plan\
        |preview|projects|proof|provider|quick|quickstart|rc|receipt\
        |remote|report|reset|resume|review|rollback|run|sandbox\
        |secrets|secure|self-update|self_update|sentrux|serve|setup-skill|share\
        |ship|spec|start|state|stats|status|steer|stop\
        |syslog|telemetry|template|test|tour|trigger|trust|trust-metrics\
        |ultracode|update|verify|version|voice|watch|watchdog|web\
        |welcome|why|wiki|worktree|wt)
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
        no_provider|not_logged_in|node|python3|jq|git|curl|disk|skill_symlink)
            printf '%s' "$1" ;;
        *)
            printf 'other' ;;
    esac
}

loki_telemetry() {
    _loki_telemetry_enabled || return 0
    local event="$1"; shift
    local distinct_id
    distinct_id=$(_loki_telemetry_id 2>/dev/null) || return 0
    local version
    version=$(cat "${SCRIPT_DIR:-${SKILL_DIR:-}}/VERSION" 2>/dev/null || cat "${SCRIPT_DIR:-${SKILL_DIR:-}}/../VERSION" 2>/dev/null || echo "unknown")
    version=$(echo "$version" | tr -d '[:space:]')
    local channel
    channel=$(_loki_detect_channel 2>/dev/null || echo "unknown")
    local os_name arch
    os_name=$(uname -s 2>/dev/null || echo "unknown")
    arch=$(uname -m 2>/dev/null || echo "unknown")

    # Build JSON payload safely using Python to prevent injection.
    # The extra key=value pairs are forwarded as "$@" -- one argv slot per pair,
    # QUOTED. They used to be joined into a single space-delimited string and
    # then re-split by an unquoted expansion, which broke two ways: a value
    # containing a space was truncated (`prd=my file.md` -> `prd=my`, rest
    # dropped) or, if a fragment itself contained `=`, forged an extra PostHog
    # property KEY; and the unquoted expansion also globbed, so `spec=*.md`
    # expanded against the cwd and injected file names into the payload. Callers
    # already pass each pair as its own quoted word, so "$@" is the array and no
    # caller signature changes.
    local payload
    payload=$(python3 -c "
import json, sys
props = {'os': sys.argv[1], 'arch': sys.argv[2], 'version': sys.argv[3], 'channel': sys.argv[4]}
for arg in sys.argv[5:]:
    if '=' in arg:
        k, v = arg.split('=', 1)
        props[k] = v
print(json.dumps({'api_key': '$LOKI_POSTHOG_KEY', 'event': sys.argv[5] if len(sys.argv) > 5 else '', 'distinct_id': '$distinct_id', 'properties': props}))
" "$os_name" "$arch" "$version" "$channel" "$@" 2>/dev/null) || return 0
    # Re-inject event and distinct_id properly
    payload=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
d['event'] = sys.argv[2]
d['distinct_id'] = sys.argv[3]
print(json.dumps(d))
" "$payload" "$event" "$distinct_id" 2>/dev/null) || return 0

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
    return 0
}
