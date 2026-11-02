#!/usr/bin/env bash
# scaffold-hook.sh -- opt-in seam that wires the contract-first scaffold (M1-M3)
# into the build lane. Mirrors the LOKI_SENTRUX_GATE pattern: sourced ONLY when
# the gate is enabled, and no-ops safely otherwise.
#
# ENABLED by LOKI_SCAFFOLD_CONTRACT_FIRST=1 (default OFF -> the default build path
# is byte-identical and completely unaffected). When ON, and ONLY for a GREENFIELD
# target (an effectively-empty project dir) whose PRD implies a web/API backend,
# it lays down the contract-first + real-backend + design-system skeleton BEFORE
# the SDLC loop, so the model builds ON a real wired substrate instead of
# hand-writing disconnected files. It NEVER touches a non-empty/brownfield repo.
#
# It is deliberately conservative: on any doubt it does nothing (returns 0) and
# lets the normal build proceed -- it can only ADD a starting skeleton, never
# remove or overwrite existing code.
#
# This is a bash-only ORCHESTRATION seam in run_autonomous, not part of
# build_prompt(). It follows the LOKI_SENTRUX_GATE precedent, which is likewise
# bash-orchestration only. It is DEFAULT-OFF.

# Is the target dir greenfield (no meaningful source yet)? Ignores .loki, .git,
# the PRD, and dotfiles. Echoes "yes"/"no".
_scaffold_is_greenfield() {
    local dir="${1:-.}"
    local n
    n=$(find "$dir" -type f \
        -not -path "*/.loki/*" -not -path "*/.git/*" \
        -not -name "PRD.md" -not -name "prd.md" -not -name ".*" \
        -not -path "*/node_modules/*" 2>/dev/null | head -5 | wc -l | tr -d ' ')
    [ "${n:-0}" -eq 0 ] && echo "yes" || echo "no"
}

# Derive a resource + fields from a PRD, conservatively. Only fires when the PRD
# clearly names a REST resource; otherwise echoes nothing (caller skips).
# Kept intentionally simple + general (no product-specific knowledge).
_scaffold_derive_resource() {
    local prd="$1"
    [ -f "$prd" ] || return 0
    # Look for an explicit "GET/POST /api/<collection>" the way FV-1 does.
    local coll
    coll=$(grep -oiE '(GET|POST)[[:space:]]+/api/[a-z][a-z0-9_-]+' "$prd" 2>/dev/null \
        | grep -oE '/api/[a-z][a-z0-9_-]+' | head -1 | sed 's#/api/##')
    [ -z "$coll" ] && return 0
    # singularize naively for the resource name
    local res="${coll%s}"; [ -z "$res" ] && res="$coll"
    echo "$res"
}

# The hook. Args: <target_dir> <prd_path>. Safe to call unconditionally; it
# self-gates on the flag + greenfield + a derivable resource.
run_contract_scaffold_hook() {
    [ "${LOKI_SCAFFOLD_CONTRACT_FIRST:-0}" = "1" ] || return 0
    local dir="${1:-.}" prd="${2:-}"
    local script_dir
    script_dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

    [ "$(_scaffold_is_greenfield "$dir")" = "yes" ] || {
        log_info "contract-scaffold: target is not greenfield -> skipping (never overwrites existing code)" 2>/dev/null || true
        return 0
    }
    local res
    res=$(_scaffold_derive_resource "$prd")
    [ -z "$res" ] && {
        log_info "contract-scaffold: no REST resource derivable from the PRD -> skipping" 2>/dev/null || true
        return 0
    }

    local scaffold="${script_dir}/lib/contract-scaffold/scaffold.sh"
    local generate="${script_dir}/lib/contract-scaffold/generate.mjs"
    [ -f "$scaffold" ] && [ -f "$generate" ] || return 0

    log_info "contract-scaffold: greenfield + resource '$res' -> laying down contract-first + backend + design skeleton" 2>/dev/null || true
    bash "$scaffold" "$dir" "$res" 2>/dev/null || true
    if command -v node >/dev/null 2>&1; then
        node "$generate" "$dir" "$res" 2>/dev/null || true
    fi
    return 0
}
