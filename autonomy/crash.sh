#!/usr/bin/env bash
# Loki Mode crash-reporting bash helpers (Phase 0: local-only, zero egress).
#
# This module is the single source of truth for the unified opt-out that gates
# BOTH PostHog usage telemetry and local crash capture. It is sourceable for
# helpers only; it executes nothing on source.
#
# Opt-out (any one disables collection):
#   - LOKI_TELEMETRY=off            (case-insensitive)
#   - LOKI_TELEMETRY_DISABLED=true
#   - DO_NOT_TRACK=1
#   - ~/.loki/config line: TELEMETRY_DISABLED=true
#
# All capture is best-effort: it never blocks the parent and always returns 0.
# Phase 0 has zero network egress, so local capture is always safe and useful
# for the user to self-inspect what WOULD be sent.

# Double-source guard.
if [ -n "${_LOKI_CRASH_SH_SOURCED:-}" ]; then
    return 0 2>/dev/null || true
fi
_LOKI_CRASH_SH_SOURCED=1

# Self-locate so we do not depend on the caller's SCRIPT_DIR / _LOKI_SCRIPT_DIR.
_LOKI_CRASH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LOKI_CRASH_CAPTURE_PY="${_LOKI_CRASH_DIR}/lib/crash_capture.py"

# loki_collection_enabled: returns 0 (enabled) unless disabled by any switch.
# This is the SINGLE source of truth for telemetry + crash collection state.
loki_collection_enabled() {
    # Env: LOKI_TELEMETRY=off (case-insensitive)
    local telem_lower
    telem_lower="$(printf '%s' "${LOKI_TELEMETRY:-}" | tr '[:upper:]' '[:lower:]')"
    [ "$telem_lower" = "off" ] && return 1

    # Env: LOKI_TELEMETRY_DISABLED=true
    [ "${LOKI_TELEMETRY_DISABLED:-}" = "true" ] && return 1

    # Env: DO_NOT_TRACK=1 (community standard)
    [ "${DO_NOT_TRACK:-}" = "1" ] && return 1

    # Persistent opt-out in ~/.loki/config (matches autonomy/run.sh:643 format).
    if [ -f "${HOME}/.loki/config" ] && grep -q "^TELEMETRY_DISABLED=true" "${HOME}/.loki/config" 2>/dev/null; then
        return 1
    fi

    return 0
}

# _loki_crash_python: resolve a python3 interpreter, or return 1 if absent.
_loki_crash_python() {
    if command -v python3 >/dev/null 2>&1; then
        printf 'python3'
        return 0
    fi
    return 1
}

# loki_crash_capture <error_class> <message> <stack> <rarv_phase> <exit_code>
# Best-effort local capture. Always returns 0. Never blocks the parent.
# Gated by the unified opt-out: if the user has opted out (LOKI_TELEMETRY=off /
# DO_NOT_TRACK=1 / loki telemetry off / config TELEMETRY_DISABLED=true), NO
# local crash file is written, matching the first-run disclosure and
# docs/PRIVACY.md promise that opt-out disables crash reporting.
loki_crash_capture() {
    loki_collection_enabled || return 0

    local error_class="${1:-UnknownError}"
    local message="${2:-}"
    local stack="${3:-}"
    local rarv_phase="${4:-}"
    local exit_code="${5:-}"

    local py
    py="$(_loki_crash_python)" || return 0
    [ -f "$_LOKI_CRASH_CAPTURE_PY" ] || return 0

    # Bound the stack so we never pass an oversized argv (E2BIG). The capture
    # script reads the stack from stdin. Keep the last 200 lines, 16 KB cap.
    local bounded_stack
    bounded_stack="$(printf '%s' "$stack" | tail -c 16384 2>/dev/null)"

    local args=(
        "$_LOKI_CRASH_CAPTURE_PY"
        --error-class "$error_class"
        --message "$message"
        --rarv-phase "$rarv_phase"
        --exit-code "$exit_code"
        --target-dir "${TARGET_DIR:-.}"
    )

    # Short timeout if available; stock macOS has no `timeout`, so run bare then.
    if command -v timeout >/dev/null 2>&1; then
        printf '%s' "$bounded_stack" | timeout 5 "$py" "${args[@]}" --stack - >/dev/null 2>&1 || true
    else
        printf '%s' "$bounded_stack" | "$py" "${args[@]}" --stack - >/dev/null 2>&1 || true
    fi

    return 0
}

# loki_crash_friction <friction_kind> <context>
# Conservative: caller decides when a real threshold is hit. Best-effort.
# Always returns 0. friction_kind is one of: retry_loop | rate_limit_loop |
# gate_failure. The context string is mapped into --message (the capture
# contract has no --context arg). Gated by the unified opt-out: if the user has
# opted out, NO local friction file is written either.
loki_crash_friction() {
    loki_collection_enabled || return 0

    local friction_kind="${1:-unknown}"
    local context="${2:-}"

    local py
    py="$(_loki_crash_python)" || return 0
    [ -f "$_LOKI_CRASH_CAPTURE_PY" ] || return 0

    local args=(
        "$_LOKI_CRASH_CAPTURE_PY"
        --error-class "Friction"
        --message "$context"
        --friction-kind "$friction_kind"
        --target-dir "${TARGET_DIR:-.}"
    )

    if command -v timeout >/dev/null 2>&1; then
        timeout 5 "$py" "${args[@]}" </dev/null >/dev/null 2>&1 || true
    else
        "$py" "${args[@]}" </dev/null >/dev/null 2>&1 || true
    fi

    return 0
}

# loki_show_disclosure_once: print the first-run disclosure exactly once.
# Shown regardless of enabled/disabled state, before any egress. Uses the
# DISCLOSURE_SHOWN sentinel in ~/.loki/config (do not invent a new file).
# Safe if HOME is unwritable (best-effort).
loki_show_disclosure_once() {
    local config="${HOME}/.loki/config"

    # Already shown? Never re-show.
    if [ -f "$config" ] && grep -q "^DISCLOSURE_SHOWN=true" "$config" 2>/dev/null; then
        return 0
    fi

    # Disclosure copy (plan section 6a, verbatim; no emojis, no em dashes).
    {
        echo ""
        echo "Loki Mode auto-creates the issues you hit at github.com/asklokesh/loki-mode"
        echo "and tries to auto-resolve them. If it cannot, we encourage you to open an"
        echo "issue for anything causing hesitation."
        echo "We send anonymous diagnostics only (os, arch, version, error type, sanitized"
        echo "stack signatures). Never your code, prompts, paths, keys, or repo names."
        echo "See docs/PRIVACY.md. Turn this off anytime with: loki telemetry off"
        echo ""
    } >&2

    # Persist the sentinel (best-effort; never fail the caller).
    mkdir -p "${HOME}/.loki" 2>/dev/null || return 0
    echo "DISCLOSURE_SHOWN=true" >> "$config" 2>/dev/null || true

    return 0
}
