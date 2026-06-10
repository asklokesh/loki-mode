#!/usr/bin/env bash
# autonomy/grill.sh - Loki spec interrogation (loki grill).
#
# Net-new capability (internal/SDD-PANEL-A.md ranks it HIGHEST: no Claude Code
# equivalent, no Loki equivalent). It exposes the Devil's-Advocate /
# anti-sycophancy posture that today fires only INSIDE the build loop
# (run.sh:7807) as a standalone PRE-build interrogation of a spec.
#
# What it does: invokes the provider ONCE (claude -p, the same single-shot
# pattern used for in-loop adversarial review and the haiku USAGE regen at
# run.sh:9832) with a Devil's-Advocate prompt that produces the 10-15 hardest
# questions exposing ambiguities, missing acceptance criteria, unstated
# assumptions, and security/scale blind spots. Output is a structured markdown
# report at .loki/grill/report.md. With --apply it appends a "Grill findings"
# section to the spec itself.
#
# Honest about provider dependency: requires the provider CLI; clean error when
# absent (no fabricated questions, no silent success).
#
# Spec source resolution (first match wins, same as loki spec):
#   1. explicit path argument
#   2. prd.md
#   3. .loki/generated-prd.md
#   4. PRD.md
#   5. docs/prd.md
#
# Exit codes:
#   0  report written
#   2  usage / spec-not-found error
#   3  provider unavailable or interrogation failed (never silent)

set -uo pipefail

GRILL_EXIT_OK=0
GRILL_EXIT_USAGE=2
GRILL_EXIT_ERROR=3

GRILL_DIR_DEFAULT=".loki/grill"
GRILL_REPORT_NAME="report.md"

_grill_log() { printf '[grill] %s\n' "$*" >&2; }
_grill_err() { printf '[grill][error] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Resolve the spec source path. Echoes the path on success, empty on failure.
# Default order favors a hand-written prd.md over a generated one for grilling,
# since grilling is a pre-build hardening step on the human's intent.
# ---------------------------------------------------------------------------
grill_resolve_source() {
    local explicit="${1:-}"
    if [ -n "$explicit" ]; then
        if [ -f "$explicit" ]; then
            printf '%s\n' "$explicit"
            return 0
        fi
        return 1
    fi
    local candidate
    for candidate in \
        "prd.md" \
        ".loki/generated-prd.md" \
        "PRD.md" \
        "docs/prd.md"; do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Build the Devil's-Advocate interrogation prompt for a given spec body.
# ---------------------------------------------------------------------------
grill_build_prompt() {
    local spec_path="$1"
    local spec_body="$2"
    cat <<EOF
You are a Devil's Advocate spec reviewer. Your job is to interrogate the
following specification and surface its weaknesses BEFORE any code is written.
Do not praise it. Do not summarize it. Do not propose an implementation.

Produce the 10 to 15 HARDEST questions that expose:
  - ambiguities and underspecified behavior
  - missing or untestable acceptance criteria
  - unstated assumptions and implicit requirements
  - security blind spots (authn/authz, input validation, secrets, data exposure)
  - scale and reliability blind spots (concurrency, failure modes, limits)
  - edge cases the spec does not address

Output STRICT markdown in exactly this shape and nothing else:

## Grill findings

### Ambiguities and missing acceptance criteria
1. <hard question>
2. <hard question>

### Unstated assumptions
1. <hard question>

### Security blind spots
1. <hard question>

### Scale and reliability blind spots
1. <hard question>

Each question must be specific to THIS spec (quote or reference the relevant
part), answerable, and uncomfortable. Total questions across all sections: 10
to 15. If a category has no real issue, write "None identified." under it
rather than padding.

=== SPEC: $spec_path ===
$spec_body
=== END SPEC ===
EOF
}

# ---------------------------------------------------------------------------
# Invoke the provider once and capture the interrogation report.
# Echoes the report markdown on success; returns nonzero on failure.
# ---------------------------------------------------------------------------
grill_invoke_provider() {
    local prompt="$1"
    local provider="${LOKI_PROVIDER:-claude}"

    case "$provider" in
        claude)
            if ! command -v claude >/dev/null 2>&1; then
                _grill_err "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
                return $GRILL_EXIT_ERROR
            fi
            local out
            # Single-shot, non-interactive. Same pattern as the in-loop
            # adversarial reviewer (run.sh:7807) and USAGE regen (run.sh:9832).
            out="$(printf '%s' "$prompt" \
                | timeout "${LOKI_GRILL_TIMEOUT:-180}" claude --dangerously-skip-permissions --model "${LOKI_GRILL_MODEL:-sonnet}" -p - 2>/dev/null)"
            if [ -z "$out" ]; then
                _grill_err "provider returned no output (timeout or invocation error)"
                return $GRILL_EXIT_ERROR
            fi
            printf '%s\n' "$out"
            return 0
            ;;
        codex)
            if ! command -v codex >/dev/null 2>&1; then
                _grill_err "Codex CLI not found."
                return $GRILL_EXIT_ERROR
            fi
            local out
            out="$(printf '%s' "$prompt" | timeout "${LOKI_GRILL_TIMEOUT:-180}" codex exec --full-auto - 2>/dev/null)"
            if [ -z "$out" ]; then
                _grill_err "provider returned no output"
                return $GRILL_EXIT_ERROR
            fi
            printf '%s\n' "$out"
            return 0
            ;;
        *)
            _grill_err "grill currently supports the claude and codex providers (got: $provider)"
            return $GRILL_EXIT_ERROR
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
grill_help() {
    cat <<'EOF'
loki grill - interrogate a spec with the hardest questions before you build it.

USAGE:
    loki grill [<spec-path>] [options]

DESCRIPTION:
    Invokes the provider once with a Devil's-Advocate prompt to produce the
    10-15 hardest questions exposing ambiguities, missing acceptance criteria,
    unstated assumptions, and security/scale blind spots in a spec. Writes a
    structured markdown report to .loki/grill/report.md.

    This is a PRE-build hardening step: a grilled spec is a better Reason input
    to the RARV-C loop. It requires the provider CLI and fails cleanly (no
    fabricated questions) when the provider is unavailable.

SPEC RESOLUTION (when <spec-path> is omitted, first match wins):
    prd.md  ->  .loki/generated-prd.md  ->  PRD.md  ->  docs/prd.md

OPTIONS:
    --apply       Append the "Grill findings" section to the spec file itself.
    --out <dir>   Output directory for the report. Default: .loki/grill
    -h, --help    Show this help.

ENVIRONMENT:
    LOKI_PROVIDER        Provider to use (claude default; codex supported).
    LOKI_GRILL_MODEL     Claude model for the interrogation (default: sonnet).
    LOKI_GRILL_TIMEOUT   Per-invocation timeout in seconds (default: 180).

EXIT CODES:
    0  report written
    2  usage error (spec not found)
    3  provider unavailable or interrogation failed (never silent)

OUTPUT:
    <out>/report.md   the structured interrogation report
EOF
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
grill_main() {
    local spec_arg=""
    local out_dir="$GRILL_DIR_DEFAULT"
    local apply="false"

    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help) grill_help; return $GRILL_EXIT_OK ;;
            --apply) apply="true"; shift ;;
            --out) out_dir="${2:-}"; shift 2 ;;
            --) shift; break ;;
            -*) _grill_err "unknown option: $1"; grill_help; return $GRILL_EXIT_USAGE ;;
            *)
                if [ -z "$spec_arg" ]; then spec_arg="$1"; else
                    _grill_err "unexpected argument: $1"; return $GRILL_EXIT_USAGE
                fi
                shift ;;
        esac
    done

    local spec_path
    if ! spec_path="$(grill_resolve_source "$spec_arg")"; then
        if [ -n "$spec_arg" ]; then
            _grill_err "spec file not found: $spec_arg"
        else
            _grill_err "no spec found (looked for prd.md, .loki/generated-prd.md, PRD.md, docs/prd.md). Pass a path explicitly."
        fi
        return $GRILL_EXIT_USAGE
    fi

    local spec_body
    spec_body="$(cat "$spec_path" 2>/dev/null)"
    if [ -z "$spec_body" ]; then
        _grill_err "spec file is empty: $spec_path"
        return $GRILL_EXIT_USAGE
    fi

    local prompt
    prompt="$(grill_build_prompt "$spec_path" "$spec_body")"

    _grill_log "interrogating $spec_path via ${LOKI_PROVIDER:-claude}..."
    local report
    report="$(grill_invoke_provider "$prompt")" || return $GRILL_EXIT_ERROR

    mkdir -p "$out_dir" || { _grill_err "cannot create $out_dir"; return $GRILL_EXIT_ERROR; }
    local report_path="$out_dir/$GRILL_REPORT_NAME"

    {
        printf '# Spec grill report\n\n'
        printf '- Spec: %s\n' "$spec_path"
        printf '- Generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf '- Provider: %s\n\n' "${LOKI_PROVIDER:-claude}"
        printf '%s\n' "$report"
    } >"$report_path" || { _grill_err "failed to write $report_path"; return $GRILL_EXIT_ERROR; }

    _grill_log "report written: $report_path"
    printf 'Grill report: %s\n' "$report_path"

    if [ "$apply" = "true" ]; then
        {
            printf '\n\n<!-- loki grill: appended %s -->\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            printf '%s\n' "$report"
        } >>"$spec_path" || { _grill_err "failed to append findings to $spec_path"; return $GRILL_EXIT_ERROR; }
        _grill_log "appended Grill findings to $spec_path"
        printf 'Appended Grill findings to: %s\n' "$spec_path"
    fi

    return $GRILL_EXIT_OK
}

# Allow direct execution: bash autonomy/grill.sh [args]
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    grill_main "$@"
    exit $?
fi
