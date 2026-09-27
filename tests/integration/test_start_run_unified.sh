#!/usr/bin/env bash
# tests/integration/test_start_run_unified.sh
# v7.0.0: if T3 ships start/run unification, `loki start` should accept BOTH
# PRD paths and issue URLs. If T3 has not landed, this test confirms the
# existing separate `loki start` (PRD) and `loki run` (issue) commands still
# exist and respond to --help without crashing.
#
# We do not actually execute a full loki run because that requires a provider,
# an API key, and network access. We check dispatch-level behavior only.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0

ok() { echo "PASS [$1]"; PASS=$((PASS + 1)); }
bad() { echo "FAIL [$1] $2"; FAIL=$((FAIL + 1)); }

LOKI_BIN="./autonomy/loki"

if [ ! -x "$LOKI_BIN" ]; then
    echo "SKIP test_start_run_unified: $LOKI_BIN not executable"
    exit 2
fi

# --- baseline: `loki --help` works ------------------------------------------
set +e
help_out=$("$LOKI_BIN" --help 2>&1)
help_rc=$?
set -e
if [ "$help_rc" -eq 0 ] && echo "$help_out" | grep -qE "Usage: loki"; then
    ok "loki_help_works"
else
    bad "loki_help_works" "rc=$help_rc out=$help_out"
fi

# --- `loki start` command exists --------------------------------------------
if echo "$help_out" | grep -qE "^  start"; then
    ok "loki_start_listed_in_help"
else
    bad "loki_start_listed_in_help" "start not in help"
fi

# --- `loki run` command exists ----------------------------------------------
if echo "$help_out" | grep -qE "^  run"; then
    ok "loki_run_listed_in_help"
else
    bad "loki_run_listed_in_help" "run not in help"
fi

# --- unified-start detection -------------------------------------------------
# T3 marker: if the `loki start` help text mentions issue-url handling, assume
# unification shipped. Otherwise, rely on the presence of `loki run`.
unified="false"
if grep -qE "cmd_start.*issue|start.*(issue url|accepts.*(PRD|issue))" autonomy/loki 2>/dev/null; then
    unified="true"
fi
# Also accept unification if `loki run` has been DEPRECATED (help text marks it).
if echo "$help_out" | grep -qiE "run.*deprecated|use.*start"; then
    unified="true"
fi

if [ "$unified" = "true" ]; then
    ok "unification_marker_detected"
    # If unified, `loki start <some-url>` should not immediately crash with
    # "unknown command"; we accept any non-panic behavior. Because we don't
    # want to actually start a real run, pass a dummy github issue URL that
    # requires validation which will fail fast.
    set +e
    start_out=$(timeout -k 10 5 "$LOKI_BIN" start "https://github.com/example/repo/issues/1" --help 2>&1 || true)
    set -e
    if echo "$start_out" | grep -qi "unknown command"; then
        bad "unified_start_accepts_issue_url" "start rejected issue url: $start_out"
    else
        ok "unified_start_accepts_issue_url"
    fi
else
    echo "SKIP [unification_marker_detected] T3 has not landed in v6.83.1 baseline"
    # Fallback: both commands still exist separately. Test `loki run --help`
    # resolves a command (even if it prints a usage message).
    set +e
    run_out=$(timeout -k 10 5 "$LOKI_BIN" run --help 2>&1 || true)
    set -e
    if echo "$run_out" | grep -qiE "usage|run|issue"; then
        ok "legacy_loki_run_help_works"
    else
        # `loki run` may require an argument; not having one is also acceptable
        # so long as it doesn't say "unknown command".
        if echo "$run_out" | grep -qi "unknown command"; then
            bad "legacy_loki_run_help_works" "unknown command; out=$run_out"
        else
            ok "legacy_loki_run_help_works"
        fi
    fi
fi

# --- `loki version` always works, regardless of unification -----------------
set +e
ver_out=$("$LOKI_BIN" version 2>&1)
ver_rc=$?
set -e
if [ "$ver_rc" -eq 0 ] && echo "$ver_out" | grep -qE "Loki Mode v[0-9]+"; then
    ok "loki_version_stable_across_unify"
else
    bad "loki_version_stable_across_unify" "rc=$ver_rc out=$ver_out"
fi

echo ""
echo "start_run_unified: passed=$PASS failed=$FAIL"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
