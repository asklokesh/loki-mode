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

    # Build JSON payload safely using Python to prevent injection
    local extra_args=""
    for arg in "$@"; do
        extra_args="${extra_args}${extra_args:+ }${arg}"
    done

    local payload
    payload=$(python3 -c "
import json, sys
props = {'os': sys.argv[1], 'arch': sys.argv[2], 'version': sys.argv[3], 'channel': sys.argv[4]}
for arg in sys.argv[5:]:
    if '=' in arg:
        k, v = arg.split('=', 1)
        props[k] = v
print(json.dumps({'api_key': '$LOKI_POSTHOG_KEY', 'event': sys.argv[5] if len(sys.argv) > 5 else '', 'distinct_id': '$distinct_id', 'properties': props}))
" "$os_name" "$arch" "$version" "$channel" $extra_args 2>/dev/null) || return 0
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
