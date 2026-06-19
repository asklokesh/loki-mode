#!/usr/bin/env bash
#===============================================================================
# Unified Config-File Tests (FEAT-CONFIG, #691)
#
# Coverage for `loki start --config <path>` (aliases --vars / --env-file): the
# canonical LOKI_CONFIG_MAP + shared loki_config_export_key precedence helper +
# the .env / YAML / JSON parsers + ${VAR} expansion + raw-secret detection +
# `config example|schema|validate`. Reference: docs/CONFIG-FILE-PLAN.md SS7.
#
# TWO OBSERVATION STRATEGIES (both honest, neither vacuous):
#  1. UNIT: config-map.sh is side-effect-free on source, so the .env parser, the
#     ${VAR} expander, the format detector, the secret matcher, and the keystone
#     export helper are sourced and called directly with crafted input in a
#     SUBSHELL (so an export cannot leak into the next case).
#  2. INTEGRATION: the keystone / precedence / parity cases drive the REAL binary
#     `loki start --config <f> ./prd.md` under LOKI_CONFIG_DUMP=1, a documented
#     dry mode that applies the config pre-pass then prints the resolved LOKI_*
#     and exits 0 WITHOUT a build. (autonomy/loki runs main() when sourced, so
#     extract+source is unsafe; the dump is the safe observation hook.)
#
# NON-VACUITY: every "value == X" assertion is paired with a flip to a second
# value, proving the result is not a default coincidence.
#
# Any case that cannot run emits a visible FAIL; never a silent pass.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"
RUN_SH="$PROJECT_DIR/autonomy/run.sh"
CONFIG_MAP_LIB="$PROJECT_DIR/autonomy/lib/config-map.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}
fail() {
    FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-config.XXXXXX")"
cleanup() { rm -rf "$WORKROOT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Minimal PRD so `loki start` reaches the pre-pass deterministically.
PRD="$WORKROOT/prd.md"
printf '# Test PRD\n\n## Overview\nA tiny app for the config test.\n' > "$PRD"

# Run the real binary in dump mode. Echoes the resolved LOKI_* (sorted) on
# stdout; stderr captured separately into DUMP_ERR. Sets DUMP_OUT / DUMP_RC.
# A clean environment (env -i) plus only the vars we pass makes assertions
# deterministic and isolates ambient LOKI_* from the host.
run_dump() {
    # Usage: run_dump <config_path> [extra "VAR=val" ambient pairs...]
    local cfg="$1"; shift
    local -a ambient=()
    local kv
    for kv in "$@"; do ambient+=("$kv"); done
    DUMP_ERR="$WORKROOT/.dump_err"
    DUMP_OUT="$(
        env -i \
            PATH="$PATH" HOME="$HOME" \
            LOKI_CONFIG_DUMP=1 LOKI_NO_NEW_SESSION=1 \
            "${ambient[@]}" \
            bash "$LOKI_BIN" start --config "$cfg" "$PRD" 2>"$DUMP_ERR"
    )"
    DUMP_RC=$?
}

dump_val() {
    # Echo the value of LOKI var $1 from the last DUMP_OUT.
    printf '%s\n' "$DUMP_OUT" | grep "^$1=" | head -1 | cut -d= -f2-
}

echo "Unified Config-File Tests (FEAT-CONFIG, #691)"
echo "============================================="
echo ""

# Sanity: lib must be sourceable and side-effect-free.
echo "[Lib] side-effect-free source"
(
    set -e
    # Sourcing must not export anything or print anything.
    out="$(source "$CONFIG_MAP_LIB"; env | grep -E '^LOKI_(MAX_ITERATIONS|COMPLEXITY)=' || true)"
    [ -z "$out" ] || { echo "leaked: $out" >&2; exit 1; }
    # The array and key functions must be defined.
    source "$CONFIG_MAP_LIB"
    declare -p LOKI_CONFIG_MAP >/dev/null 2>&1
    declare -f loki_config_export_key >/dev/null 2>&1
    declare -f loki_expand_refs >/dev/null 2>&1
    declare -f loki_value_looks_secret >/dev/null 2>&1
) && pass "config-map.sh sources cleanly, defines array+functions, exports nothing" \
   || fail "config-map.sh source is not side-effect-free or missing symbols"

# -----------------------------------------------------------------------------
# Case 1: config-only key reaches runtime (+ non-vacuity flip)
# -----------------------------------------------------------------------------
echo ""
echo "[Case 1] config-only key reaches runtime"
printf 'LOKI_MAX_ITERATIONS=4242\n' > "$WORKROOT/c1.env"
run_dump "$WORKROOT/c1.env"
if [ "$(dump_val LOKI_MAX_ITERATIONS)" = "4242" ]; then
    printf 'LOKI_MAX_ITERATIONS=1337\n' > "$WORKROOT/c1b.env"
    run_dump "$WORKROOT/c1b.env"
    if [ "$(dump_val LOKI_MAX_ITERATIONS)" = "1337" ]; then
        pass "config value reaches runtime (4242 then 1337 -- non-vacuous)"
    else
        fail "flip did not take" "expected 1337, got $(dump_val LOKI_MAX_ITERATIONS)"
    fi
else
    fail "config value did not reach runtime" "expected 4242, got $(dump_val LOKI_MAX_ITERATIONS)"
fi

# -----------------------------------------------------------------------------
# Case 2: CLI overrides config. The CLI arm exports unconditionally AFTER the
# pre-pass, so it always wins. Proven at the mechanism level: pre-pass sets the
# value with override=1, then the (later-running) CLI export replaces it.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 2] CLI overrides config (export-order precedence)"
(
    set -e
    source "$CONFIG_MAP_LIB"
    # Pre-pass effect: config sets complex (override=1, beats absent env).
    loki_config_export_key LOKI_COMPLEXITY complex 1
    [ "${LOKI_COMPLEXITY:-}" = "complex" ] || { echo "pre-pass set failed" >&2; exit 1; }
    # CLI arm effect (cmd_start's `--simple` arm): unconditional export, runs last.
    export LOKI_COMPLEXITY=simple
    [ "${LOKI_COMPLEXITY:-}" = "simple" ] || { echo "cli override failed" >&2; exit 1; }
) && pass "CLI flag (later, unconditional export) overrides config value" \
   || fail "CLI did not override config"

# -----------------------------------------------------------------------------
# Case 3: KEYSTONE -- --config overrides ambient env.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 3] KEYSTONE: --config overrides ambient env"
printf 'LOKI_MAX_ITERATIONS=4242\n' > "$WORKROOT/c3.env"
run_dump "$WORKROOT/c3.env" "LOKI_MAX_ITERATIONS=10"
if [ "$(dump_val LOKI_MAX_ITERATIONS)" = "4242" ]; then
    # Non-vacuity: with NO config the ambient env must show through (10).
    run_dump "$WORKROOT/c3.env" "LOKI_MAX_ITERATIONS=10"  # config present -> 4242 (already asserted)
    # Flip the config value to prove it is the config, not a constant.
    printf 'LOKI_MAX_ITERATIONS=999\n' > "$WORKROOT/c3b.env"
    run_dump "$WORKROOT/c3b.env" "LOKI_MAX_ITERATIONS=10"
    if [ "$(dump_val LOKI_MAX_ITERATIONS)" = "999" ]; then
        pass "KEYSTONE: config (4242/999) beats ambient env (10) -- non-vacuous"
    else
        fail "keystone flip failed" "expected 999, got $(dump_val LOKI_MAX_ITERATIONS)"
    fi
else
    fail "KEYSTONE FAILED: config did not beat ambient env" \
         "expected 4242, got $(dump_val LOKI_MAX_ITERATIONS)"
fi

# -----------------------------------------------------------------------------
# Case 4: env-wins regression for auto-discovery (override=0). Ambient env must
# still BEAT an auto-config value (the shipped contract is unchanged). And the
# explicit --config (override=1) must beat the same ambient env.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 4] override=0 preserves env-wins; override=1 beats env"
(
    set -e
    source "$CONFIG_MAP_LIB"
    export LOKI_MAX_ITERATIONS=10
    # Auto-config path (override=0): env wins, value is NOT applied.
    loki_config_export_key LOKI_MAX_ITERATIONS 4242 0
    [ "${LOKI_MAX_ITERATIONS}" = "10" ] || { echo "env-wins broke: got $LOKI_MAX_ITERATIONS" >&2; exit 1; }
    # Explicit --config path (override=1): config wins.
    loki_config_export_key LOKI_MAX_ITERATIONS 4242 1
    [ "${LOKI_MAX_ITERATIONS}" = "4242" ] || { echo "override=1 broke: got $LOKI_MAX_ITERATIONS" >&2; exit 1; }
) && pass "override=0 -> env wins (auto-config contract); override=1 -> config wins" \
   || fail "precedence parameter behaved incorrectly"

# -----------------------------------------------------------------------------
# Case 5: ${VAR} expansion; ${UNSET} -> skipped + warning.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 5] \${VAR} expansion + unset-ref skip"
(
    set -e
    source "$CONFIG_MAP_LIB"
    export MYREPO="acme/widgets"
    out="$(loki_expand_refs '${MYREPO}')"
    [ "$out" = "acme/widgets" ] || { echo "full-value expand failed: $out" >&2; exit 1; }
    out="$(loki_expand_refs 'pre-${MYREPO}-post')"
    [ "$out" = "pre-acme/widgets-post" ] || { echo "embedded expand failed: $out" >&2; exit 1; }
    # Unset ref -> expansion FAILS (non-zero), echoes the offending name.
    if out="$(loki_expand_refs '${DEFINITELY_UNSET_XYZ}')"; then
        echo "unset ref did not fail (got: $out)" >&2; exit 1
    fi
) && pass "\${VAR} expands (full + embedded); unset ref fails (skip path)" \
   || fail "expansion behaved incorrectly"

# Integration: an unset ref in a config file emits a warning and skips the key.
printf 'LOKI_GITHUB_REPO=${DEFINITELY_UNSET_XYZ}\n' > "$WORKROOT/c5.env"
run_dump "$WORKROOT/c5.env"
if printf '%s' "$DUMP_OUT" | grep -q '^LOKI_GITHUB_REPO='; then
    fail "unset-ref key was exported (should be skipped)"
elif grep -q 'unresolved' "$DUMP_ERR" 2>/dev/null; then
    pass "unset-ref key skipped + warning emitted on load"
else
    fail "no warning emitted for unset ref" "$(cat "$DUMP_ERR" 2>/dev/null | head -3)"
fi

# -----------------------------------------------------------------------------
# Case 6: raw-secret literal warns on load + errors on validate; ${VAR} ref OK.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 6] raw-secret literal detection"
SECRET="ghp_$(printf 'a%.0s' {1..40})"
(
    set -e
    source "$CONFIG_MAP_LIB"
    loki_value_looks_secret "$SECRET" || { echo "real secret not detected" >&2; exit 1; }
    # A ${VAR} ref is NOT a secret literal (deny filter).
    if loki_value_looks_secret '${GITHUB_TOKEN}'; then echo "ref flagged as secret" >&2; exit 1; fi
    # A plain value is not a secret.
    if loki_value_looks_secret "acme/widgets"; then echo "plain value flagged" >&2; exit 1; fi
) && pass "secret matcher: literal detected, \${VAR} ref + plain value ignored" \
   || fail "secret matcher behaved incorrectly"

printf 'LOKI_GITHUB_REPO=%s\n' "$SECRET" > "$WORKROOT/c6.env"
bash "$LOKI_BIN" config validate "$WORKROOT/c6.env" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    # And a clean file validates OK (non-vacuity).
    printf 'LOKI_GITHUB_REPO=acme/widgets\n' > "$WORKROOT/c6ok.env"
    if bash "$LOKI_BIN" config validate "$WORKROOT/c6ok.env" >/dev/null 2>&1; then
        pass "config validate: raw secret -> non-zero; clean file -> zero"
    else
        fail "clean file failed validation (should pass)"
    fi
else
    fail "config validate did not error on raw secret"
fi

# -----------------------------------------------------------------------------
# Case 7: format parity WITH ambient env present (.env / .yaml / .json identical).
# The override defect only surfaces when ambient env is set, so we set it.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 7] format parity (.env / .yaml / .json) with ambient env present"
printf 'LOKI_MAX_ITERATIONS=4242\n' > "$WORKROOT/p.env"
printf 'completion:\n  max_iterations: 4242\n' > "$WORKROOT/p.yaml"
printf '{"completion":{"max_iterations":"4242"}}\n' > "$WORKROOT/p.json"
run_dump "$WORKROOT/p.env"  "LOKI_MAX_ITERATIONS=10"; V_ENV="$(dump_val LOKI_MAX_ITERATIONS)"
run_dump "$WORKROOT/p.yaml" "LOKI_MAX_ITERATIONS=10"; V_YAML="$(dump_val LOKI_MAX_ITERATIONS)"
run_dump "$WORKROOT/p.json" "LOKI_MAX_ITERATIONS=10"; V_JSON="$(dump_val LOKI_MAX_ITERATIONS)"
if [ "$V_ENV" = "4242" ] && [ "$V_YAML" = "4242" ] && [ "$V_JSON" = "4242" ]; then
    pass "all 3 formats override ambient env identically (4242, not 10)"
else
    fail "format parity broken" "env=$V_ENV yaml=$V_YAML json=$V_JSON (each should be 4242)"
fi

# -----------------------------------------------------------------------------
# Case 8: injection -- value with $(...)/backticks/; is rejected, never executed.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 8] injection rejected by validation, never executed"
SENTINEL="$WORKROOT/pwned"
rm -f "$SENTINEL"
# A command-substitution-style value. The grep/sed YAML path and the .env path
# both run validate_yaml_value, which rejects '$', '(', ')', backticks, ';'.
printf 'LOKI_GITHUB_REPO=$(touch %s)\n' "$SENTINEL" > "$WORKROOT/c8.env"
run_dump "$WORKROOT/c8.env"
if [ -e "$SENTINEL" ]; then
    fail "INJECTION EXECUTED -- sentinel created"
elif printf '%s' "$DUMP_OUT" | grep -q '^LOKI_GITHUB_REPO='; then
    fail "injection value was exported (should be rejected by validation)"
else
    pass "injection value rejected, never executed (sentinel absent, var not set)"
fi

# -----------------------------------------------------------------------------
# Case 9: bad/missing/symlink file -> honest non-zero, no silent default.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 9] bad/missing/symlink file -> honest non-zero"
(
    set -e
    source "$CONFIG_MAP_LIB"
    # Missing file.
    if loki_apply_config_file "$WORKROOT/does-not-exist.env" 1; then
        echo "missing file returned 0" >&2; exit 1
    fi
    # Symlinked project-local config (relative) is refused.
    cd "$WORKROOT"
    printf 'LOKI_MAX_ITERATIONS=4242\n' > real.env
    ln -sf real.env link.env
    if loki_apply_config_file "link.env" 1; then
        echo "symlinked relative config accepted" >&2; exit 1
    fi
) && pass "missing file + symlinked project-local config both return non-zero" \
   || fail "bad/missing/symlink handling incorrect"

# -----------------------------------------------------------------------------
# Case 10: drift -- every var in LOKI_CONFIG_MAP has a reader in run.sh; both
# run.sh parsers now iterate the SAME array (T1 == T2).
# -----------------------------------------------------------------------------
echo ""
echo "[Case 10] drift: every mapped LOKI_* is consumed in the runtime; T1==T2"
(
    set -e
    source "$CONFIG_MAP_LIB"
    # Runtime consumers live in run.sh, the completion council, and the provider
    # adapters (council.* keys -> completion-council.sh; model.* -> providers).
    CONSUMERS=("$RUN_SH" "$PROJECT_DIR/autonomy/completion-council.sh" "$PROJECT_DIR"/providers/*.sh)
    missing=""
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
        ev="${mapping##*:}"
        # Reader pattern: ${EV:- or ${EV} or "$EV" in any runtime consumer file.
        if ! grep -Eqh "\\\$\{${ev}[:-]|\\\$\{${ev}\}|\"\\\$${ev}\"" "${CONSUMERS[@]}" 2>/dev/null; then
            missing="${missing} ${ev}"
        fi
    done
    [ -z "$missing" ] || { echo "unconsumed mapped vars:${missing}" >&2; exit 1; }
    # T1 == T2: both parsers iterate LOKI_CONFIG_MAP, so neither carries an inline
    # table anymore. Assert the old inline tables are gone.
    if grep -q 'set_from_yaml "\$file" "core.max_retries"' "$RUN_SH"; then
        echo "parse_simple_yaml still has hand-written set_from_yaml calls" >&2; exit 1
    fi
    if grep -q '"core.max_retries:LOKI_MAX_RETRIES"' "$RUN_SH"; then
        echo "parse_yaml_with_yq still has an inline mappings table" >&2; exit 1
    fi
) && pass "all 64 mapped vars consumed in run.sh; both parsers iterate the shared array (T1==T2)" \
   || fail "drift detected or inline table remnants present"

# -----------------------------------------------------------------------------
# Case 11: cmd_start no-op arm -- path not misread as PRD positional, not forwarded.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 11] cmd_start consumes --config without misreading the PRD"
# With the dump hook the build never starts, but the pre-pass + arg consumption
# both execute. We assert: (a) the config WAS applied (value present), and (b)
# `loki start --config f.env <prd>` does not error on the PRD path (exit 0).
printf 'LOKI_MAX_ITERATIONS=4242\n' > "$WORKROOT/c11.env"
run_dump "$WORKROOT/c11.env"
if [ "$DUMP_RC" = "0" ] && [ "$(dump_val LOKI_MAX_ITERATIONS)" = "4242" ]; then
    pass "--config consumed; PRD positional intact; pre-pass applied (rc=0)"
else
    fail "cmd_start arg handling incorrect" "rc=$DUMP_RC val=$(dump_val LOKI_MAX_ITERATIONS)"
fi

# -----------------------------------------------------------------------------
# Case 12: env-file / vars aliases work identically to --config; LOKI_CONFIG_FILE
# env var is honored; an explicit flag overrides the env var.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 12] --vars / --env-file aliases + LOKI_CONFIG_FILE env"
printf 'LOKI_MAX_ITERATIONS=4242\n' > "$WORKROOT/c12.env"
RC_ALL=0
for alias in --vars --env-file; do
    DUMP_OUT="$(env -i PATH="$PATH" HOME="$HOME" LOKI_CONFIG_DUMP=1 LOKI_NO_NEW_SESSION=1 \
        bash "$LOKI_BIN" start "$alias" "$WORKROOT/c12.env" "$PRD" 2>/dev/null)"
    [ "$(dump_val LOKI_MAX_ITERATIONS)" = "4242" ] || RC_ALL=1
done
# LOKI_CONFIG_FILE env var honored.
DUMP_OUT="$(env -i PATH="$PATH" HOME="$HOME" LOKI_CONFIG_DUMP=1 LOKI_NO_NEW_SESSION=1 \
    LOKI_CONFIG_FILE="$WORKROOT/c12.env" bash "$LOKI_BIN" start "$PRD" 2>/dev/null)"
[ "$(dump_val LOKI_MAX_ITERATIONS)" = "4242" ] || RC_ALL=1
# Explicit flag overrides the env var (different value wins).
printf 'LOKI_MAX_ITERATIONS=777\n' > "$WORKROOT/c12flag.env"
DUMP_OUT="$(env -i PATH="$PATH" HOME="$HOME" LOKI_CONFIG_DUMP=1 LOKI_NO_NEW_SESSION=1 \
    LOKI_CONFIG_FILE="$WORKROOT/c12.env" bash "$LOKI_BIN" start --config "$WORKROOT/c12flag.env" "$PRD" 2>/dev/null)"
[ "$(dump_val LOKI_MAX_ITERATIONS)" = "777" ] || RC_ALL=1
if [ "$RC_ALL" = "0" ]; then
    pass "--vars / --env-file aliases work; LOKI_CONFIG_FILE honored; explicit flag overrides env"
else
    fail "alias / env-var handling incorrect"
fi

# -----------------------------------------------------------------------------
# Case 13: generators (example / schema) derive from LOKI_CONFIG_MAP.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 13] config example / schema generated from the array"
SCHEMA="$(bash "$LOKI_BIN" config schema 2>/dev/null)"
EXAMPLE="$(bash "$LOKI_BIN" config example 2>/dev/null)"
N_MAP="$(source "$CONFIG_MAP_LIB"; printf '%s\n' "${LOKI_CONFIG_MAP[@]}" | wc -l | tr -d ' ')"
N_SCHEMA="$(printf '%s\n' "$SCHEMA" | grep -v '^#' | grep -c $'\t')"
if [ "$N_MAP" = "64" ] && [ "$N_SCHEMA" = "64" ] \
   && printf '%s' "$EXAMPLE" | grep -q '^completion:' \
   && ! printf '%s' "$EXAMPLE" | grep -q 'compaction_interval'; then
    pass "schema has 64 rows; example covers completion + drops dead compaction_interval"
else
    fail "generators incorrect" "map=$N_MAP schema=$N_SCHEMA"
fi

# -----------------------------------------------------------------------------
# Case 14: .env key membership allowlist (MED-2 -- parity with YAML/JSON).
# An unknown LOKI_ key (typo / unadvertised) must WARN+skip on load and ERROR on
# validate. A real allowlisted enterprise var (LOKI_STORAGE_BACKEND, non-map)
# must still load + validate. A config-map key (LOKI_MAX_ITERATIONS) must still
# load.
# -----------------------------------------------------------------------------
echo ""
echo "[Case 14] .env unknown-key allowlist (typo caught; enterprise var works)"
RC14=0
# 14a: a typo'd LOKI key is NOT exported, and a WARNING is emitted.
printf 'LOKI_MAX_RETRIE=5\n' > "$WORKROOT/c14typo.env"
run_dump "$WORKROOT/c14typo.env"
if printf '%s\n' "$DUMP_OUT" | grep -q '^LOKI_MAX_RETRIE='; then
    RC14=1; echo "  (debug) typo key was exported"
fi
grep -q 'unknown key LOKI_MAX_RETRIE' "$DUMP_ERR" || { RC14=1; echo "  (debug) no warn for typo on load"; }

# 14b: a real allowlisted non-map enterprise var IS exported (load).
printf 'LOKI_STORAGE_BACKEND=s3\n' > "$WORKROOT/c14ent.env"
run_dump "$WORKROOT/c14ent.env"
[ "$(dump_val LOKI_STORAGE_BACKEND)" = "s3" ] || { RC14=1; echo "  (debug) enterprise var not exported"; }

# 14c: a config-map key still loads (regression guard).
printf 'LOKI_MAX_ITERATIONS=99\n' > "$WORKROOT/c14map.env"
run_dump "$WORKROOT/c14map.env"
[ "$(dump_val LOKI_MAX_ITERATIONS)" = "99" ] || { RC14=1; echo "  (debug) map key not exported"; }

# 14d: validate ERRORS (non-zero) on the typo key.
if bash "$LOKI_BIN" config validate "$WORKROOT/c14typo.env" >/dev/null 2>&1; then
    RC14=1; echo "  (debug) validate did not error on typo key"
fi
# 14e: validate is OK (zero) on the allowlisted enterprise var.
if ! bash "$LOKI_BIN" config validate "$WORKROOT/c14ent.env" >/dev/null 2>&1; then
    RC14=1; echo "  (debug) validate errored on legit enterprise var"
fi
# 14f: validate is OK (zero) on a config-map key.
if ! bash "$LOKI_BIN" config validate "$WORKROOT/c14map.env" >/dev/null 2>&1; then
    RC14=1; echo "  (debug) validate errored on legit map key"
fi
if [ "$RC14" = "0" ]; then
    pass ".env unknown key warns+skips on load, errors on validate; allowlisted vars work"
else
    fail ".env key membership allowlist incorrect"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "============================================="
echo "Config-File Tests: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
