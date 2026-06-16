#!/usr/bin/env bash
# tests/test-bash-bun-parity.sh -- AUTOMATED bash<->Bun runtime parity test.
#
# Backlog P4-2. Until now, bash<->Bun parity for the load-bearing runtime
# invariants was MANUAL REVIEW ONLY (comments in the source say things like
# "MUST stay byte-identical"). Manual review is a recurring drift source. This
# test extracts the canonical values from BOTH routes and asserts equality,
# failing loudly with a diff when they drift.
#
# WHAT IS COVERED (the contract -- 6 invariants):
#   1. Autonomy-override system-prompt text
#        bash:  providers/claude.sh _loki_autonomy_override_text()
#        bun:   loki-ts/src/providers/claude_flags.ts AUTONOMY_OVERRIDE_TEXT
#        Byte-identical including the trailing newline.
#   2. PHASE_KEYS / SDLC phase list
#        bash:  autonomy/run.sh PHASE_* assignment block (the canonical 11)
#        bun:   loki-ts/src/runner/build_prompt.ts PHASE_KEYS
#   3. Effort-per-tier mapping (every tier x {standard,complex})
#        bash:  autonomy/lib/claude-flags.sh loki_effort_for_tier()
#        bun:   loki-ts/src/providers/claude_flags.ts effortForTier()
#   4. Model-fallback mapping (every primary x LOKI_ALLOW_HAIKU)
#        bash:  autonomy/lib/claude-flags.sh loki_fallback_for_primary()
#        bun:   loki-ts/src/providers/claude_flags.ts fallbackForPrimary()
#   5. Gate-toggle env var names (LOKI_GATE_*) referenced by both routes
#        bash:  grep over autonomy/
#        bun:   grep over loki-ts/src/
#   6. `report session` (bash canonical) == `stats` (Bun) stdout
#        bash:  autonomy/loki cmd_report -> cmd_stats
#        bun:   loki-ts/src/commands/stats.ts runStats
#        The `report` noun stays bash-routed by design (its other subcommands --
#        metrics/cost/export/share/dogfood -- are not Bun-ported), so
#        `report session` runs bash cmd_stats while `stats` runs the Bun port.
#        Those two MUST produce identical stdout (the deprecation-alias contract
#        in stats.ts). This invariant locks that, modulo the one-line stderr
#        deprecation pointer that fires only on the bare `stats` token.
#
# EXTRACTION STRATEGY: for the COMPUTED invariants (override text, effort,
# fallback) we EXECUTE the real code on both routes rather than regex-parsing
# source. Bash side sources the file in a subshell and calls the function across
# all inputs; Bun side runs tests/parity-extract.ts which imports and calls the
# same functions and prints one JSON blob. This tests BEHAVIOR (what a run
# actually sends), is robust to formatting/refactors, yet still catches real
# behavioral drift. PHASE_KEYS and the GATE_* set are static lists, extracted by
# text.
#
# ALLOWED ASYMMETRY (documented, explicitly excluded -- the test is honest about
# what it does and does not cover):
#   - LOKI_GATE_TIMEOUT: bash-only. It is a gate-execution VALUE knob (a timeout
#     in seconds for the pytest/mock/mutation gate subprocesses), NOT a gate
#     toggle. It is consumed only by bash gate-execution machinery
#     (autonomy/run.sh + autonomy/verify.sh); the Bun route does not run those
#     gate subprocesses itself (zero references in loki-ts/src). It is therefore
#     a legitimate bash-only knob and is subtracted from the GATE_* set on the
#     bash side before the set-equality assertion. Re-classify if the Bun route
#     ever runs those gates.
#   - The `report` NOUN dispatcher (autonomy/loki cmd_report) is bash-routed BY
#     DESIGN, not a Bun gap. bin/loki only routes `report kpis` to Bun (kpis has
#     no bash implementation); every other report subcommand
#     (session/metrics/cost/export/share/dogfood) forwards to the existing bash
#     cmd_* function. metrics/cost/export/share/dogfood are NOT Bun-ported, so a
#     native Bun `report` dispatcher would have to drag in five more commands --
#     out of scope. The one subcommand that DOES have a Bun port, `session`
#     (-> cmd_stats), is the deprecated alias of the Bun-native `stats`, and the
#     two are pinned byte-identical by invariant 6 above. So `report` being
#     bash-routed creates NO user-visible drift. Re-classify (port a Bun `report`
#     dispatcher) only if/when those other subcommands are themselves ported.
#   - context_gauge / format_tokens (autonomy/tui.sh): formerly bash-only and
#     called out as "not ported" in status.ts. PORTED in the P4-6 parity sweep
#     (loki-ts/src/commands/status.ts) so `loki status` renders the Budget and
#     Context visual gauges identically on both routes. No longer an asymmetry;
#     covered by loki-ts/tests/commands/status.test.ts (byte-for-byte verified
#     against `bash autonomy/loki status`). Listed here as a former entry so the
#     record stays honest.
#
# NOT COVERED (out of scope for this test, by design):
#   - The full build_prompt() output (the loki-ts fixture corpus in
#     loki-ts/tests/fixtures/build_prompt already does byte-for-byte prompt
#     parity via bun test; this test covers the load-bearing CONSTANTS, not the
#     whole assembled prompt).
#   - RARV / SDLC / autonomous-suffix instruction PROSE (covered by the fixture
#     corpus; re-verifying here would duplicate that and require placeholder
#     normalization that risks going toothless).
#   - MCP config / AGENTS.md / project-graph parity (separate dedicated tests:
#     tests/test-parity-mcp-config.sh, test-parity-agents-md.sh,
#     test-parity-project-graph.sh).
#
# No emojis, no em dashes (CLAUDE.md hard rule).

set -uo pipefail

# Resolve repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root"; exit 2; }

PASS=0
FAIL=0
FAILED_NAMES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() {
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$1")
    printf '  FAIL: %s\n' "$1"
    if [ -n "${2:-}" ]; then
        printf '%s\n' "$2" | sed 's/^/        /'
    fi
}

TMPDIR_PARITY="$(mktemp -d "${TMPDIR:-/tmp}/loki-parity-XXXXXX")"
cleanup() { rm -rf "$TMPDIR_PARITY" 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Locate bun (required for the Bun-route extraction).
# ---------------------------------------------------------------------------
BUN_BIN=""
for cand in bun "$HOME/.bun/bin/bun"; do
    if command -v "$cand" >/dev/null 2>&1; then BUN_BIN="$cand"; break; fi
    if [ -x "$cand" ]; then BUN_BIN="$cand"; break; fi
done
if [ -z "$BUN_BIN" ]; then
    echo "SKIP: bun not found on PATH; cannot extract Bun-route values. Install bun to run this parity test."
    # A clean skip is not a failure of parity; exit 0 so local-ci is not blocked
    # on a machine without bun. (local-ci itself runs bun checks, so in CI this
    # branch is not taken.)
    exit 0
fi

echo "=== bash<->Bun runtime parity (P4-2) ==="
echo "repo: $REPO_ROOT"
echo "bun:  $($BUN_BIN --version 2>/dev/null)"
echo ""

# ---------------------------------------------------------------------------
# Extract Bun-route values once (JSON blob).
# ---------------------------------------------------------------------------
BUN_JSON="$TMPDIR_PARITY/bun.json"
if ! "$BUN_BIN" run tests/parity-extract.ts > "$BUN_JSON" 2>"$TMPDIR_PARITY/bun.err"; then
    echo "FATAL: bun extraction failed:"
    sed 's/^/    /' "$TMPDIR_PARITY/bun.err"
    exit 2
fi
if [ ! -s "$BUN_JSON" ]; then
    echo "FATAL: bun extraction produced empty output"
    exit 2
fi

# Small python helper to read a field out of the Bun JSON blob.
bun_field() {
    BUN_JSON="$BUN_JSON" _FIELD="$1" python3 - <<'PY'
import json, os
with open(os.environ["BUN_JSON"]) as f:
    d = json.load(f)
field = os.environ["_FIELD"]
v = d[field]
if isinstance(v, (dict, list)):
    print(json.dumps(v, sort_keys=True))
else:
    print(v, end="")
PY
}

# ---------------------------------------------------------------------------
# INVARIANT 1: autonomy-override system-prompt text (byte-identical).
# Capture the bash heredoc to a FILE (preserves the trailing newline; command
# substitution would strip it and create a false drift). Emit the Bun value to a
# FILE from the JSON blob (preserves exact bytes). Compare with python byte-eq.
# ---------------------------------------------------------------------------
check_autonomy_override() {
    local name="autonomy-override text byte-identical (claude.sh <-> claude_flags.ts)"
    local bash_txt="$TMPDIR_PARITY/override.bash.txt"
    local bun_txt="$TMPDIR_PARITY/override.bun.txt"

    # Source providers/claude.sh in a subshell and dump the function output to a
    # file (NO command substitution -> trailing newline preserved).
    if ! ( set +u; . providers/claude.sh >/dev/null 2>&1; _loki_autonomy_override_text ) > "$bash_txt" 2>/dev/null; then
        fail "$name" "could not source providers/claude.sh / call _loki_autonomy_override_text"
        return
    fi
    if [ ! -s "$bash_txt" ]; then
        fail "$name" "bash override text empty (function missing or renamed)"
        return
    fi

    # Write the Bun value (exact bytes from JSON) to a file.
    BUN_JSON="$BUN_JSON" OUT="$bun_txt" python3 - <<'PY'
import json, os
with open(os.environ["BUN_JSON"]) as f:
    d = json.load(f)
with open(os.environ["OUT"], "w", newline="") as o:
    o.write(d["autonomy_override_text"])
PY

    if cmp -s "$bash_txt" "$bun_txt"; then
        pass "$name"
    else
        local d
        d="$(diff <(cat -A "$bash_txt") <(cat -A "$bun_txt") | head -40)"
        local bb bn
        bb="$(wc -c < "$bash_txt" | tr -d ' ')"
        bn="$(wc -c < "$bun_txt" | tr -d ' ')"
        fail "$name" "DRIFT: bash=${bb} bytes, bun=${bn} bytes. diff (cat -A, first 40 lines):
$d"
    fi
}

# ---------------------------------------------------------------------------
# INVARIANT 2: PHASE_KEYS / SDLC phase list.
# Both sides are extracted from the REAL source files (no hardcoded copy in the
# test -- that would compare against a third source of truth and pass while the
# two routes silently drift).
#   bash canonical: the PHASE_* assignment block in autonomy/run.sh (the 11 vars
#     assigned `PHASE_<KEY>=${LOKI_PHASE_<KEY>:-...}`). Extract the <KEY> tokens.
#   bun  canonical: the `const PHASE_KEYS = [ ... ] as const;` array literal in
#     loki-ts/src/runner/build_prompt.ts. Text-extracted (the const is module-
#     private, not exported, so it cannot be imported by parity-extract.ts).
# ---------------------------------------------------------------------------
check_phase_keys() {
    local name="PHASE_KEYS / SDLC phase list (run.sh <-> build_prompt.ts)"
    local bash_keys bun_keys

    # Extract from run.sh the lines like `PHASE_UNIT_TESTS=${LOKI_PHASE_UNIT_TESTS:-true}`
    # at column 0 (the canonical default-assignment block), strip to the KEY.
    # NOTE: the key charset MUST include digits ([0-9]) -- PHASE_E2E_TESTS has a
    # "2"; a [A-Z_]-only class silently drops E2E_TESTS and yields a false drift.
    bash_keys="$(grep -oE '^PHASE_[A-Z0-9_]+=\$\{LOKI_PHASE_[A-Z0-9_]+' autonomy/run.sh \
        | sed -E 's/^PHASE_([A-Z0-9_]+)=.*/\1/' \
        | python3 -c 'import sys,json; print(json.dumps(sorted(set(l.strip() for l in sys.stdin if l.strip()))))')"

    # Extract the array literal from the REAL build_prompt.ts (the block between
    # `const PHASE_KEYS = [` and `] as const`), then pull the quoted KEY tokens.
    local bp="loki-ts/src/runner/build_prompt.ts"
    if [ ! -f "$bp" ]; then
        fail "$name" "build_prompt.ts not found at $bp"
        return
    fi
    bun_keys="$(awk '/const PHASE_KEYS = \[/{f=1} f{print} /\] as const/{f=0}' "$bp" \
        | grep -oE '"[A-Z0-9_]+"' | tr -d '"' \
        | python3 -c 'import sys,json; print(json.dumps(sorted(set(l.strip() for l in sys.stdin if l.strip()))))')"

    if [ "$bash_keys" = "[]" ] || [ "$bun_keys" = "[]" ]; then
        fail "$name" "extraction yielded empty list (regex/awk broke):
  bash: $bash_keys
  bun:  $bun_keys"
        return
    fi

    if [ "$bash_keys" = "$bun_keys" ]; then
        pass "$name ($(printf '%s' "$bun_keys" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))') keys)"
    else
        fail "$name" "DRIFT:
  bash: $bash_keys
  bun:  $bun_keys"
    fi
}

# ---------------------------------------------------------------------------
# INVARIANT 3: effort-per-tier mapping.
# Build the bash matrix by sourcing claude-flags.sh and calling
# loki_effort_for_tier for every (tier, complexity); compare to the Bun matrix.
# ---------------------------------------------------------------------------
check_effort() {
    local name="effort-per-tier mapping (claude-flags.sh <-> claude_flags.ts)"
    local bash_json bun_json
    local tiers=(planning development fast best balanced cheap __default__)
    local cxs=(standard complex)

    # Compute the bash matrix in a single subshell.
    bash_json="$(
        set +u
        . autonomy/lib/claude-flags.sh >/dev/null 2>&1 || exit 9
        printf '{'
        first=1
        for t in "${tiers[@]}"; do
            arg="$t"
            [ "$t" = "__default__" ] && arg="totally-unknown-tier"
            for c in standard complex; do
                v="$(loki_effort_for_tier "$arg" "$c")"
                [ $first -eq 0 ] && printf ','
                first=0
                printf '"%s|%s":"%s"' "$t" "$c" "$v"
            done
        done
        printf '}'
    )"
    if [ -z "$bash_json" ]; then
        fail "$name" "could not source claude-flags.sh / call loki_effort_for_tier"
        return
    fi

    # Normalize both via python (sorted keys) so key ordering never matters.
    bash_json="$(printf '%s' "$bash_json" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin),sort_keys=True))' 2>/dev/null)"
    bun_json="$(bun_field effort)"

    if [ "$bash_json" = "$bun_json" ]; then
        pass "$name ($(printf '%s' "$bun_json" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))') cells)"
    else
        local d
        d="$(diff <(printf '%s' "$bash_json" | python3 -m json.tool) <(printf '%s' "$bun_json" | python3 -m json.tool))"
        fail "$name" "DRIFT (diff bash vs bun):
$d"
    fi
}

# ---------------------------------------------------------------------------
# INVARIANT 4: model-fallback mapping.
# bash loki_fallback_for_primary honors LOKI_ALLOW_HAIKU via env; set it per call.
# ---------------------------------------------------------------------------
check_fallback() {
    local name="model-fallback mapping (claude-flags.sh <-> claude_flags.ts)"
    local bash_json bun_json
    local primaries=(opus sonnet haiku gpt-5.3-codex)

    bash_json="$(
        set +u
        . autonomy/lib/claude-flags.sh >/dev/null 2>&1 || exit 9
        printf '{'
        first=1
        for p in "${primaries[@]}"; do
            for ah in false true; do
                v="$(LOKI_ALLOW_HAIKU="$ah" loki_fallback_for_primary "$p")"
                [ $first -eq 0 ] && printf ','
                first=0
                printf '"%s|%s":"%s"' "$p" "$ah" "$v"
            done
        done
        printf '}'
    )"
    if [ -z "$bash_json" ]; then
        fail "$name" "could not source claude-flags.sh / call loki_fallback_for_primary"
        return
    fi

    bash_json="$(printf '%s' "$bash_json" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin),sort_keys=True))' 2>/dev/null)"
    bun_json="$(bun_field fallback)"

    if [ "$bash_json" = "$bun_json" ]; then
        pass "$name ($(printf '%s' "$bun_json" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))') cells)"
    else
        local d
        d="$(diff <(printf '%s' "$bash_json" | python3 -m json.tool) <(printf '%s' "$bun_json" | python3 -m json.tool))"
        fail "$name" "DRIFT (diff bash vs bun):
$d"
    fi
}

# ---------------------------------------------------------------------------
# INVARIANT 5: LOKI_GATE_* env var name set referenced by both routes.
# Subtract the documented allowed-asymmetry list from the bash set, then assert
# set-equality in BOTH directions (a toggle added to one route only must fail).
# ---------------------------------------------------------------------------
# Allowed-asymmetry: gate names that are legitimately bash-only (documented in
# the header). Keep this list as small as possible and justify every entry.
GATE_ALLOWED_BASH_ONLY=("LOKI_GATE_TIMEOUT")
# Allowed-asymmetry: gate names that are legitimately bun-only. LSP diagnostics
# is a Bun-route verification gate (loki-ts/src/runner/quality_gates.ts) with no
# bash-route equivalent yet; bringing it to bash is a tracked follow-up.
GATE_ALLOWED_BUN_ONLY=("LOKI_GATE_LSP_DIAGNOSTICS")

check_gate_env() {
    local name="LOKI_GATE_* env var set (autonomy/ <-> loki-ts/src/)"

    local bash_set bun_set
    bash_set="$(grep -rhoE 'LOKI_GATE_[A-Z_]+' autonomy/ 2>/dev/null | sort -u)"
    bun_set="$(grep -rhoE 'LOKI_GATE_[A-Z_]+' loki-ts/src/ 2>/dev/null | sort -u)"

    if [ -z "$bash_set" ]; then
        fail "$name" "no LOKI_GATE_* found in autonomy/ (grep pattern broken?)"
        return
    fi
    if [ -z "$bun_set" ]; then
        fail "$name" "no LOKI_GATE_* found in loki-ts/src/ (grep pattern broken?)"
        return
    fi

    # Subtract the allowed bash-only names from the bash set.
    local allowed_pat=""
    local g
    for g in "${GATE_ALLOWED_BASH_ONLY[@]}"; do
        allowed_pat="${allowed_pat}${allowed_pat:+|}^${g}\$"
    done
    local bash_filtered
    if [ -n "$allowed_pat" ]; then
        bash_filtered="$(printf '%s\n' "$bash_set" | grep -vE "$allowed_pat" || true)"
    else
        bash_filtered="$bash_set"
    fi

    # Subtract the allowed bun-only names from the bun set.
    local allowed_bun_pat=""
    for g in "${GATE_ALLOWED_BUN_ONLY[@]}"; do
        allowed_bun_pat="${allowed_bun_pat}${allowed_bun_pat:+|}^${g}\$"
    done
    if [ -n "$allowed_bun_pat" ]; then
        bun_set="$(printf '%s\n' "$bun_set" | grep -vE "$allowed_bun_pat" || true)"
    fi

    # bash names present but not in bun (after allow-list subtraction).
    local only_bash only_bun
    only_bash="$(comm -23 <(printf '%s\n' "$bash_filtered") <(printf '%s\n' "$bun_set"))"
    only_bun="$(comm -13 <(printf '%s\n' "$bash_filtered") <(printf '%s\n' "$bun_set"))"

    if [ -z "$only_bash" ] && [ -z "$only_bun" ]; then
        local count
        count="$(printf '%s\n' "$bash_filtered" | grep -c . || true)"
        pass "$name ($count shared toggles; allowed bash-only: ${GATE_ALLOWED_BASH_ONLY[*]})"
    else
        local msg=""
        [ -n "$only_bash" ] && msg="${msg}Only in bash (not allowed-asymmetry, not in bun):
$(printf '%s\n' "$only_bash" | sed 's/^/  /')
"
        [ -n "$only_bun" ] && msg="${msg}Only in bun (not referenced by bash):
$(printf '%s\n' "$only_bun" | sed 's/^/  /')
"
        msg="${msg}If a new gate is genuinely route-specific, add it to GATE_ALLOWED_BASH_ONLY with a justification; otherwise wire it into BOTH routes."
        fail "$name" "$msg"
    fi
}

# ---------------------------------------------------------------------------
# INVARIANT 6: `report session` (bash canonical) == `stats` (Bun) stdout.
# The `report` noun is bash-routed by design (see ALLOWED ASYMMETRY); its
# `session` subcommand forwards to bash cmd_stats, which is the deprecated alias
# of the Bun-native `stats`. Run BOTH routes against the same seeded .loki and
# assert byte-identical stdout (ANSI-stripped). The Bun route also emits a
# one-line stderr deprecation pointer on the bare `stats` token; we compare
# STDOUT only, so that pointer is correctly excluded.
# ---------------------------------------------------------------------------
check_report_session_stats() {
    local name="report session (bash) == stats (Bun) stdout"
    local bun_cli="loki-ts/src/cli.ts"
    if [ ! -f "$bun_cli" ]; then
        fail "$name" "Bun CLI entry not found at $bun_cli"
        return
    fi

    # Seed a deterministic .loki so both routes aggregate identical inputs.
    local seed="$TMPDIR_PARITY/report-stats-loki"
    mkdir -p "$seed/metrics/efficiency" "$seed/state"
    printf '%s\n' '{"currentPhase":"design","currentIteration":2}' > "$seed/state/orchestrator.json"
    printf '%s\n' '{"input_tokens":1000,"output_tokens":500,"cost_usd":0.5,"duration_seconds":120}' \
        > "$seed/metrics/efficiency/iteration-1.json"
    printf '%s\n' '{"input_tokens":2000,"output_tokens":800,"cost_usd":1.2,"duration_seconds":200}' \
        > "$seed/metrics/efficiency/iteration-2.json"

    local bash_out="$TMPDIR_PARITY/report.bash.txt"
    local bun_out="$TMPDIR_PARITY/stats.bun.txt"

    # Strip ANSI on both sides (the existing route-parity normalization).
    LOKI_DIR="$seed" bash autonomy/loki report session 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*m//g' > "$bash_out"
    LOKI_DIR="$seed" "$BUN_BIN" "$bun_cli" stats 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*m//g' > "$bun_out"

    if [ ! -s "$bash_out" ]; then
        fail "$name" "bash 'report session' produced no stdout (cmd_report wiring broke?)"
        return
    fi
    if [ ! -s "$bun_out" ]; then
        fail "$name" "Bun 'stats' produced no stdout (runStats broke?)"
        return
    fi

    if cmp -s "$bash_out" "$bun_out"; then
        pass "$name"
    else
        local d
        d="$(diff "$bash_out" "$bun_out" | head -40)"
        fail "$name" "DRIFT between 'report session' (bash) and 'stats' (Bun) stdout:
$d"
    fi
}

# ---------------------------------------------------------------------------
# Run all checks.
# ---------------------------------------------------------------------------
check_autonomy_override
check_phase_keys
check_effort
check_fallback
check_gate_env
check_report_session_stats

echo ""
echo "=== parity summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -ne 0 ]; then
    echo "FAILED: ${FAILED_NAMES[*]}"
    echo "Drift detected between the bash and Bun routes. Fix the source-of-truth so"
    echo "both routes agree (these values are load-bearing -- a mismatch silently"
    echo "changes what a run sends depending on which route executed)."
    exit 1
fi
echo "All runtime parity invariants intact."
exit 0
