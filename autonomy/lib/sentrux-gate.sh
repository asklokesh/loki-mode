#!/usr/bin/env bash
# Loki Mode -- sentrux architectural-drift helper (v7.5.14).
#
# Why this exists:
#   Loki's existing 8 quality gates and 3-reviewer council catch correctness
#   and behavioral regressions, but no current gate emits a deterministic,
#   per-iteration architecture-drift signal. sentrux (https://github.com/sentrux/sentrux)
#   is a Rust CLI that scores codebase structure (modularity, acyclicity,
#   depth, equality, redundancy) into a single 0-1 number, with a
#   `gate --save` baseline plus `gate` compare workflow that catches when
#   an iteration silently degrades architecture.
#
# Why opt-in only:
#   sentrux is an external Rust binary (v0.5.x as of this release) that users
#   install themselves via brew or curl. We do NOT bundle it, do NOT auto-install,
#   and do NOT touch the iteration hot path by default. Every entry point in
#   this file no-ops gracefully when sentrux is not on PATH.
#
# Verified facts (v7.5.14, 2026-05-03):
#   - sentrux v0.5.7 binary works on darwin-arm64.
#   - `sentrux gate --save <path>` writes <path>/.sentrux/baseline.json with
#     real JSON: {timestamp, quality_signal (0..1), coupling_score, cycle_count,
#     god_file_count, hotspot_count, complex_fn_count, max_depth,
#     total_import_edges, cross_module_edges}.
#   - `sentrux gate <path>` prints a "Quality:      <before> -> <after>"
#     line and either "DEGRADED" or "No degradation detected".
#   - Defect: `sentrux gate` exits 0 even when output reports DEGRADED. This
#     helper parses stdout and the JSON file rather than relying on exit code.
#
# Public API:
#   sentrux_available                       -> 0 if binary on PATH, 1 otherwise
#   sentrux_version                         -> prints "X.Y.Z" or empty on fail
#   sentrux_baseline_save <path>            -> writes <path>/.sentrux/baseline.json
#   sentrux_baseline_quality <path>         -> prints quality_signal*10000 as int
#                                              (or empty on missing/malformed)
#   sentrux_gate_diff <path>                -> prints "<before>|<after>|<verdict>"
#                                              where verdict is OK|DEGRADED|UNKNOWN
#
# All functions are pure helpers: no global state mutations, no side effects
# beyond what sentrux itself writes inside <path>/.sentrux/.

# Guard against double-source.
if [ "${__LOKI_SENTRUX_GATE_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_SENTRUX_GATE_SH_LOADED=1

sentrux_available() {
    command -v sentrux >/dev/null 2>&1
}

sentrux_version() {
    if ! sentrux_available; then
        return 1
    fi
    sentrux --version 2>/dev/null | head -1 | awk '{print $NF}' | tr -d 'v'
}

# Run sentrux gate --save against <path>. Returns 0 on success, 1 on failure
# or if sentrux is unavailable. stderr from sentrux is preserved for debugging
# but stdout is suppressed.
sentrux_baseline_save() {
    local path="${1:-.}"
    if ! sentrux_available; then
        return 1
    fi
    if [ ! -d "$path" ]; then
        return 1
    fi
    sentrux gate --save "$path" >/dev/null 2>&1
}

# Read quality_signal from <path>/.sentrux/baseline.json and print it as an
# integer in the 0-10000 range (matching sentrux's stdout convention). Prints
# empty string and returns 1 on missing file, malformed JSON, or missing field.
sentrux_baseline_quality() {
    local path="${1:-.}"
    local baseline="$path/.sentrux/baseline.json"
    if [ ! -f "$baseline" ]; then
        return 1
    fi
    # Use python3 for JSON parsing -- jq is not always installed and python3
    # is already a hard requirement in cmd_doctor. Pin float math to int via
    # round() so callers get a stable, comparable integer.
    local q
    q=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    v = d.get('quality_signal')
    if v is None:
        sys.exit(1)
    print(int(round(float(v) * 10000)))
except Exception:
    sys.exit(1)
" "$baseline" 2>/dev/null)
    if [ -z "$q" ]; then
        return 1
    fi
    printf '%s' "$q"
}

# Run sentrux gate against <path> and print "<before>|<after>|<verdict>".
# verdict is OK | DEGRADED | UNKNOWN. Returns 0 if a valid verdict was parsed,
# 1 only when sentrux is unavailable, the path is missing, or no Quality line
# could be parsed from output. before/after are integers (0-10000) or empty.
#
# Important: sentrux gate's exit code is inconsistent in v0.5.7 -- it has been
# observed to exit 0 on DEGRADED in some shapes and 1 in others. This helper
# captures stdout regardless of exit code and relies on text parsing as the
# source of truth.
sentrux_gate_diff() {
    local path="${1:-.}"
    if ! sentrux_available; then
        return 1
    fi
    if [ ! -d "$path" ]; then
        return 1
    fi
    local out
    # Deliberately do NOT gate on sentrux's exit code -- capture output either
    # way. The `|| true` on the substitution keeps a nonzero gate exit from
    # tripping callers running under `set -e`.
    out=$(sentrux gate "$path" 2>/dev/null || true)
    if [ -z "$out" ]; then
        printf '%s' "||UNKNOWN"
        return 1
    fi
    local quality_line before after verdict
    # Match "Quality:      4333 -> 4321" or with arrow variants.
    quality_line=$(printf '%s\n' "$out" | grep -E '^Quality:' | head -1 || true)
    if [ -n "$quality_line" ]; then
        before=$(printf '%s' "$quality_line" | grep -oE '[0-9]+' | sed -n '1p')
        after=$(printf '%s' "$quality_line" | grep -oE '[0-9]+' | sed -n '2p')
    fi
    if printf '%s' "$out" | grep -q 'DEGRADED'; then
        verdict="DEGRADED"
    elif printf '%s' "$out" | grep -q 'No degradation detected'; then
        verdict="OK"
    else
        verdict="UNKNOWN"
    fi
    printf '%s|%s|%s' "${before:-}" "${after:-}" "$verdict"
}
