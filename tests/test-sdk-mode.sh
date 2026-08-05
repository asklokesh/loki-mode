#!/usr/bin/env bash
# test-sdk-mode.sh -- v8.1 Story 1: one-switch SDK activation resolver.
#
# Drives the REAL autonomy/lib/sdk-mode.sh (source + call loki_sdk_resolve_mode
# in a clean env subshell per case) and asserts the resolved LOKI_SDK_* flags.
# No framework, no mocks -- exercises the shipped resolver directly.
#
# Invariants under test:
#   INV-OFF      unset mode        -> writes NOTHING (all 8 vars unset)
#   judges tier  7 judge flags = 1, LOKI_SDK_LOOP = 0
#   full tier    all 8 flags = 1
#   INV-OVERRIDE explicit per-site flag wins over the mode (both directions)
#   alias        LOKI_SDK=1 -> judges ; LOKI_SDK=full -> full
#   unknown      LOKI_SDK_MODE=garbage -> off (never on)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../autonomy/lib/sdk-mode.sh"

PASS=0
FAIL=0

fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok()   { PASS=$((PASS + 1)); }

# The 8 vars (judges first, loop last), matching the lib's stable order.
JUDGE_VARS="LOKI_SDK_DONE_RECOG LOKI_SDK_COUNCIL_V2 LOKI_SDK_CODE_REVIEW LOKI_SDK_COUNCIL_VOTE LOKI_SDK_VOTER_AGENTS LOKI_SDK_GRILL LOKI_SDK_PRD_ENRICH"
LOOP_VAR="LOKI_SDK_LOOP"
ALL_VARS="$JUDGE_VARS $LOOP_VAR"

# resolve <env-assignments...> : run the resolver in a clean subshell that has
# every SDK var unset, apply the given assignments, source+resolve, then print
# each var as "NAME=<value|UNSET>" so the caller can assert exact state.
resolve() {
    env -i bash -c '
        set -u
        LIB="$1"; shift
        # apply case-specific assignments passed as KEY=VAL args
        for kv in "$@"; do export "$kv"; done
        # shellcheck disable=SC1090
        . "$LIB"
        loki_sdk_resolve_mode
        for v in LOKI_SDK_DONE_RECOG LOKI_SDK_COUNCIL_V2 LOKI_SDK_CODE_REVIEW \
                 LOKI_SDK_COUNCIL_VOTE LOKI_SDK_VOTER_AGENTS LOKI_SDK_GRILL \
                 LOKI_SDK_PRD_ENRICH LOKI_SDK_LOOP; do
            eval "cur=\${$v+set}"
            if [ -z "$cur" ]; then echo "$v=UNSET"; else eval "echo \"$v=\$$v\""; fi
        done
    ' _ "$LIB" "$@"
}

# assert_var <output> <NAME> <expected>
assert_var() {
    local out="$1" name="$2" want="$3"
    local got
    got="$(printf '%s\n' "$out" | grep "^${name}=" | head -1 | cut -d= -f2-)"
    if [ "$got" = "$want" ]; then ok; else fail "$name: want '$want' got '$got' [$TEST]"; fi
}

# ---- Case 1: INV-OFF (mode unset) -> everything UNSET ------------------------
TEST="off/unset"
OUT="$(resolve)"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "UNSET"; done

# ---- Case 2: explicit LOKI_SDK_MODE=off -> everything UNSET ------------------
TEST="mode=off"
OUT="$(resolve LOKI_SDK_MODE=off)"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "UNSET"; done

# ---- Case 3: judges tier -> 7 judge=1, loop=0 -------------------------------
TEST="mode=judges"
OUT="$(resolve LOKI_SDK_MODE=judges)"
for v in $JUDGE_VARS; do assert_var "$OUT" "$v" "1"; done
assert_var "$OUT" "$LOOP_VAR" "0"

# ---- Case 4: full tier -> all 8 = 1 -----------------------------------------
TEST="mode=full"
OUT="$(resolve LOKI_SDK_MODE=full)"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "1"; done

# ---- Case 5: INV-OVERRIDE, explicit 0 wins under full ------------------------
TEST="override 0 under full"
OUT="$(resolve LOKI_SDK_MODE=full LOKI_SDK_LOOP=0)"
assert_var "$OUT" "$LOOP_VAR" "0"
assert_var "$OUT" "LOKI_SDK_GRILL" "1"   # untouched vars still take the tier default

# ---- Case 6: INV-OVERRIDE, explicit 1 wins under judges (loop forced on) -----
TEST="override 1 under judges"
OUT="$(resolve LOKI_SDK_MODE=judges LOKI_SDK_LOOP=1)"
assert_var "$OUT" "$LOOP_VAR" "1"

# ---- Case 7: alias LOKI_SDK=1 -> judges -------------------------------------
TEST="alias LOKI_SDK=1"
OUT="$(resolve LOKI_SDK=1)"
for v in $JUDGE_VARS; do assert_var "$OUT" "$v" "1"; done
assert_var "$OUT" "$LOOP_VAR" "0"

# ---- Case 8: alias LOKI_SDK=full -> full ------------------------------------
TEST="alias LOKI_SDK=full"
OUT="$(resolve LOKI_SDK=full)"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "1"; done

# ---- Case 9: LOKI_SDK_MODE takes precedence over LOKI_SDK alias --------------
TEST="mode beats alias"
OUT="$(resolve LOKI_SDK_MODE=off LOKI_SDK=full)"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "UNSET"; done

# ---- Case 10: unknown mode value -> off (fail-safe, never on) ----------------
TEST="unknown mode"
OUT="$(resolve LOKI_SDK_MODE=garbage)"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "UNSET"; done

# ---- Case 11: case-insensitive mode (JUDGES) --------------------------------
TEST="mode=JUDGES uppercase"
OUT="$(resolve LOKI_SDK_MODE=JUDGES)"
assert_var "$OUT" "LOKI_SDK_DONE_RECOG" "1"
assert_var "$OUT" "$LOOP_VAR" "0"

# ---- Case 12: INV-OVERRIDE for EXPLICIT EMPTY STRING (catches +set vs :-) -----
# An operator who exports LOKI_SDK_LOOP="" has EXPLICITLY set it (to empty). The
# resolver must NOT overwrite it with the tier default -- only a truly UNSET var
# is written. This is the exact case a `+set`->`:-` regression would break, so it
# must be tested (the mutation slipped past the suite before this case existed).
TEST="explicit empty LOOP under full stays empty"
OUT="$(resolve LOKI_SDK_MODE=full LOKI_SDK_LOOP=)"
assert_var "$OUT" "$LOOP_VAR" ""          # preserved as set-empty, NOT 1
assert_var "$OUT" "LOKI_SDK_GRILL" "1"    # a genuinely-unset var still takes the default

TEST="explicit empty GRILL under judges stays empty"
OUT="$(resolve LOKI_SDK_MODE=judges LOKI_SDK_GRILL=)"
assert_var "$OUT" "LOKI_SDK_GRILL" ""     # preserved as set-empty, NOT 1
assert_var "$OUT" "LOKI_SDK_DONE_RECOG" "1"

# ---- Case 13: idempotency -- resolving twice is a no-op ----------------------
# The write-once design's core safety property: a second resolve must not change
# anything (INV-OVERRIDE holds across repeated calls). Drive the real resolver
# twice in one subshell and compare the two snapshots.
TEST="idempotent double-resolve (full)"
DBL="$(env -i bash -c '
    set -u
    . "'"$LIB"'"
    export LOKI_SDK_MODE=full
    loki_sdk_resolve_mode
    first=""
    for v in '"$ALL_VARS"'; do eval "first=\"\$first \$$v\""; done
    loki_sdk_resolve_mode
    second=""
    for v in '"$ALL_VARS"'; do eval "second=\"\$second \$$v\""; done
    [ "$first" = "$second" ] && echo IDEMPOTENT || echo "DRIFT first=[$first] second=[$second]"
')"
if [ "$DBL" = "IDEMPOTENT" ]; then ok; else fail "double-resolve drifted: $DBL [$TEST]"; fi

# ---- Case 14: whitespace-padded mode canonicalizes like TS (INV-PARITY) ------
# A padded env var (trailing space from YAML/.env/CI) must resolve to the SAME
# tier bash<->TS. Before the trim fix, bash gave off while TS gave full: a real
# cross-route split. Assert the padded value now activates on the bash side.
TEST="padded ' full ' -> full"
OUT="$(resolve "LOKI_SDK_MODE= full ")"
for v in $ALL_VARS; do assert_var "$OUT" "$v" "1"; done

TEST="padded ' judges ' -> judges"
OUT="$(resolve "LOKI_SDK_MODE=  judges")"
assert_var "$OUT" "LOKI_SDK_DONE_RECOG" "1"
assert_var "$OUT" "$LOOP_VAR" "0"

# ---- Case 15: SHARED parity fixture (same ground truth as the TS test) -------
# Assert the bash resolver reproduces loki-ts/test/fixtures/sdk-mode-table.json
# for each mode. This is the load-bearing bash<->TS parity check: both sides bind
# to the same JSON. Empty string in the fixture means UNSET.
FIXTURE="$SCRIPT_DIR/../loki-ts/test/fixtures/sdk-mode-table.json"
if command -v python3 >/dev/null 2>&1 && [ -f "$FIXTURE" ]; then
    for mode in off judges full; do
        TEST="fixture parity ($mode)"
        if [ "$mode" = "off" ]; then OUT="$(resolve)"; else OUT="$(resolve "LOKI_SDK_MODE=$mode")"; fi
        for v in $ALL_VARS; do
            want="$(python3 -c "import json,sys; print(json.load(open('$FIXTURE'))['modes']['$mode']['$v'])")"
            [ -z "$want" ] && want="UNSET"
            assert_var "$OUT" "$v" "$want"
        done
    done
else
    echo "SKIP: fixture parity (python3 or fixture missing)"
fi

# ---- Case 16: the LIB's var set == the fixture's key set (9th-var drift) ------
# The value-parity above only checks the 8 KNOWN vars. If someone adds a 9th SDK
# site to the lib's _LOKI_SDK_JUDGE_VARS but does NOT regenerate the fixture, the
# value cases stay green (they never look at the new var). This asserts the lib's
# ACTUAL resolved var set equals the fixture's key set, so a lib-only addition is
# caught on the bash side too (parity with the TS fixture-drift guard). Binds the
# lib list -> fixture directly, not via the test's hardcoded ALL_VARS.
TEST="lib var set == fixture keys (no drift)"
if command -v python3 >/dev/null 2>&1 && [ -f "$FIXTURE" ]; then
    # The lib's OWN var list (sourced), sorted newline-joined: the 7 judge vars
    # plus the loop var. Bound to the lib, not the test's hardcoded ALL_VARS.
    LIB_VARS="$(env -i bash -c 'LIB="'"$LIB"'"; . "$LIB"; { for v in $_LOKI_SDK_JUDGE_VARS; do echo "$v"; done; echo "$_LOKI_SDK_LOOP_VAR"; } | sort')"
    FIX_KEYS="$(python3 -c "import json; print('\n'.join(sorted(json.load(open('$FIXTURE'))['modes']['full'].keys())))")"
    if [ "$LIB_VARS" = "$FIX_KEYS" ]; then ok; else fail "lib var set != fixture keys [$TEST]: lib=[$LIB_VARS] fixture=[$FIX_KEYS]"; fi
else
    echo "SKIP: lib-var-set drift (python3 or fixture missing)"
fi

# ---- Case 17: idempotency PAIRED with an override (catches unconditional write)
# Case 13 proves double-resolve is stable, but with no override present an
# unconditional rewrite of the tier default is indistinguishable from the
# idempotent write. Pairing idempotency with an explicit override makes the
# +set guard load-bearing across BOTH calls (parity with the TS suite's
# "second resolve does not overturn an override").
TEST="idempotent double-resolve preserves override"
DBL2="$(env -i bash -c '
    set -u
    LIB="'"$LIB"'"; . "$LIB"
    export LOKI_SDK_MODE=full LOKI_SDK_LOOP=0
    loki_sdk_resolve_mode
    loki_sdk_resolve_mode
    echo "$LOKI_SDK_LOOP"
')"
if [ "$DBL2" = "0" ]; then ok; else fail "override lost across double-resolve: LOOP=[$DBL2] [$TEST]"; fi

# ---- Summary ----------------------------------------------------------------
echo ""
echo "test-sdk-mode: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
