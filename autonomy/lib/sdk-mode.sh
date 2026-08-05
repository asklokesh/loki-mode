#!/usr/bin/env bash
# sdk-mode.sh -- v8.1 one-switch SDK activation resolver (bash side).
#
# v8 gave every claude judge/text site and the RARV loop an SDK path, each behind
# its own LOKI_SDK_* flag. This adds ONE operator switch, LOKI_SDK_MODE, that sets
# the default for all of them at once, so an operator flips the whole engine to the
# SDK without learning 8 flags.
#
#   LOKI_SDK_MODE=off    (default) -- writes NOTHING; every site resolves to its
#                                     own :-0 default. Byte-identical to v8. INV-OFF.
#   LOKI_SDK_MODE=judges           -- turn on the 7 one-shot JUDGE/TEXT sites; the
#                                     RARV loop stays OFF (a behavior change we do
#                                     NOT ship default this release). Recommended
#                                     scale tier.
#   LOKI_SDK_MODE=full             -- all 8 on, including the RARV loop (LOKI_SDK_LOOP).
#                                     Pre-flight tier; the loop default-flip is a
#                                     later release.
#   LOKI_SDK=1  is an alias for LOKI_SDK_MODE=judges; LOKI_SDK=full == full.
#
# DESIGN (write-once, zero call-site edits): every existing site reads its flag AT
# CALL TIME as `[ "${LOKI_SDK_X:-0}" = "1" ]` (bash) / `=== "1"` (TS). So we only
# need to EXPORT the resolved "0"/"1" into the env ONCE, before the loop runs, and
# every existing read honors it. We write a var ONLY when it is UNSET (`+set`
# guard), so an explicit per-site flag ALWAYS wins over the mode (INV-OVERRIDE) --
# even an explicit `LOKI_SDK_X=0` under `LOKI_SDK_MODE=full`.
#
# Call loki_sdk_resolve_mode ONCE, early, after this file is sourced and before any
# judge lib or the main loop runs.
#
# No emojis. No em dashes. bash 3.2 safe.

# The 8 activation vars, in a stable order. LOKI_SDK_LOOP is last (loop tier).
# Keep this list in sync with loki-ts/src/runner/sdk_mode.ts (parity fixture).
_LOKI_SDK_JUDGE_VARS="LOKI_SDK_DONE_RECOG LOKI_SDK_COUNCIL_V2 LOKI_SDK_CODE_REVIEW LOKI_SDK_COUNCIL_VOTE LOKI_SDK_VOTER_AGENTS LOKI_SDK_GRILL LOKI_SDK_PRD_ENRICH"
_LOKI_SDK_LOOP_VAR="LOKI_SDK_LOOP"

# Trim leading/trailing whitespace AND lowercase a value. Kept identical to the
# TS side's `.trim().toLowerCase()` (sdk_mode.ts) so bash and TS canonicalize a
# padded env var THE SAME WAY -- an operator who sets `LOKI_SDK_MODE=" full "`
# (trailing space from a YAML/.env/CI var) must get the same tier on both routes,
# not off-on-bash / full-on-TS (a real INV-PARITY split the shared fixture cannot
# catch). bash 3.2 safe: the extglob-free sed strips surrounding [:space:].
_loki_sdk_trim_lower() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]'
}

# Normalize LOKI_SDK / LOKI_SDK_MODE to a canonical mode: off | judges | full.
_loki_sdk_canonical_mode() {
    local mode
    mode="$(_loki_sdk_trim_lower "${LOKI_SDK_MODE:-}")"
    # LOKI_SDK alias (only when LOKI_SDK_MODE is empty/unset): "1"/"on"/"judges"
    # -> judges; "full" -> full; else ignored.
    if [ -z "$mode" ] && [ -n "${LOKI_SDK:-}" ]; then
        case "$(_loki_sdk_trim_lower "$LOKI_SDK")" in
            1|on|true|yes|judges) mode="judges" ;;
            full) mode="full" ;;
            0|off|false|no) mode="off" ;;
            *) mode="" ;;
        esac
    fi
    case "$mode" in
        judges) printf 'judges' ;;
        full)   printf 'full' ;;
        off|"") printf 'off' ;;
        *)      printf 'off' ;;  # unknown value -> safe default (off), never on
    esac
}

# Write $2 into var $1 ONLY when $1 is unset (so an explicit per-site flag wins).
_loki_sdk_default_if_unset() {
    local var="$1" val="$2"
    # `${!var+set}` is empty only when $var is UNSET (not when it is set-empty).
    eval "local _cur=\"\${$var+set}\""
    if [ -z "$_cur" ]; then
        export "$var=$val"
    fi
}

# The resolver. Idempotent + safe to call more than once.
loki_sdk_resolve_mode() {
    local mode
    mode="$(_loki_sdk_canonical_mode)"
    [ "$mode" = "off" ] && return 0  # INV-OFF: write nothing.

    local v
    for v in $_LOKI_SDK_JUDGE_VARS; do
        _loki_sdk_default_if_unset "$v" 1
    done
    if [ "$mode" = "full" ]; then
        _loki_sdk_default_if_unset "$_LOKI_SDK_LOOP_VAR" 1
    else
        # judges tier: the loop stays OFF unless the operator set it explicitly.
        _loki_sdk_default_if_unset "$_LOKI_SDK_LOOP_VAR" 0
    fi
    # Observability (opt-in): fanning one switch to 8 vars is action-at-a-distance;
    # a debug operator should be able to see what got turned on. Off by default so
    # INV-OFF and normal runs stay silent. Mirrored by sdk_mode.ts.
    if [ "${LOKI_SDK_MODE_DEBUG:-0}" = "1" ]; then
        printf 'loki: SDK mode=%s -> judges on, loop=%s\n' \
            "$mode" "${LOKI_SDK_LOOP:-0}" >&2
    fi
    return 0
}
