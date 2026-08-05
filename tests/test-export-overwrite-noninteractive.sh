#!/usr/bin/env bash
# tests/test-export-overwrite-noninteractive.sh -- regression guard for
# _export_check_overwrite() (autonomy/loki).
#
# WHAT THIS GUARDS
#   _export_check_overwrite() is the single chokepoint every export format
#   (_export_json / _export_markdown / _export_csv / _export_timeline, plus
#   `assets export`) routes through before clobbering an existing output file.
#   It used to prompt "Overwrite? [y/N]" with a bare `read` and NO
#   non-interactive guard, so whenever stdin was attached but unanswerable (a CI
#   lane, a pipeline, a test harness) the prompt BLOCKED FOREVER.
#
#   That is not hypothetical: it wedged local-ci for 40+ minutes at
#   tests/cli/test-alias-forwarding.sh. Three processes sat at 0.0% CPU with the
#   deepest descendant in state S waiting on a read that could never be
#   satisfied. `loki export markdown --json` also created a file literally named
#   "--json" in the repo root (export treats a trailing positional as the output
#   filename by design, see bin/loki), and the NEXT run then found that file and
#   hit the prompt.
#
#   The asserted contract:
#     1. non-interactive + existing file        -> TERMINATES (never hangs),
#                                                  declines the overwrite, and
#                                                  leaves the file BYTE-INTACT
#     2. LOKI_AUTO_CONFIRM=true                 -> overwrites, prints an
#                                                  auditable "(auto-confirmed)"
#     3. CI=true (fallback when AUTO_CONFIRM
#        is unset)                              -> same as 2
#     4. no pre-existing file                   -> no prompt at all
#
#   Property 1 is the load-bearing one: the bug was a HANG, so every case here
#   runs under `timeout` and a 124 exit is an explicit failure, never a pass.
#   Property 1 also asserts the file is unchanged -- "did not hang" is not
#   sufficient; silently clobbering a user's file in CI is the worse failure.
#
# No emojis. No em dashes.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 -- $2"; FAIL=$((FAIL + 1)); }

[ -f "$LOKI_BIN" ] || { echo "FATAL: autonomy/loki not found"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-export-overwrite-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cd "$WORK" || exit 2
mkdir -p .loki

SENTINEL="ORIGINAL-CONTENT-DO-NOT-CLOBBER"

# ---------------------------------------------------------------------------
# 1. Non-interactive with an existing file: must TERMINATE, not hang, and must
#    leave the file intact. `timeout` is the whole point: exit 124 == the
#    regression is back.
# ---------------------------------------------------------------------------
printf '%s\n' "$SENTINEL" > out.md
# `env -u CI -u LOKI_AUTO_CONFIRM` is load-bearing. This case asserts the DECLINE
# path: non-interactive with no auto-confirm signal must leave the file intact.
# Cases 2 and 3 below assert the opposite for LOKI_AUTO_CONFIRM=1 and CI=true --
# so inheriting CI here makes the suite contradict itself. GitHub Actions exports
# CI=true for every step, which is exactly what happened: this case failed on the
# runner while the CI=true case passed, for the same underlying behavior.
timeout 15 env -u CI -u LOKI_AUTO_CONFIRM bash "$LOKI_BIN" export markdown out.md > t1.log 2>&1
rc=$?
if [ "$rc" -eq 124 ]; then
    fail "non-interactive existing file terminates" "TIMED OUT (rc 124) -- the prompt is blocking again"
else
    pass "non-interactive existing file terminates (rc $rc, not a hang)"
fi
if grep -qF "$SENTINEL" out.md 2>/dev/null; then
    pass "non-interactive declines the overwrite (file byte-intact)"
else
    fail "non-interactive declines the overwrite" "out.md was clobbered without consent"
fi
if grep -qiE "non-interactive|LOKI_AUTO_CONFIRM" t1.log 2>/dev/null; then
    pass "non-interactive path names the opt-out env var"
else
    fail "non-interactive path names the opt-out env var" "no actionable message in output"
fi

# ---------------------------------------------------------------------------
# 2. LOKI_AUTO_CONFIRM=true: overwrites, and says so audibly.
# ---------------------------------------------------------------------------
printf '%s\n' "$SENTINEL" > out2.md
timeout 15 env LOKI_AUTO_CONFIRM=true bash "$LOKI_BIN" export markdown out2.md > t2.log 2>&1
rc=$?
if [ "$rc" -eq 124 ]; then
    fail "LOKI_AUTO_CONFIRM terminates" "TIMED OUT (rc 124)"
else
    pass "LOKI_AUTO_CONFIRM terminates (rc $rc)"
fi
if grep -qF "auto-confirmed" t2.log 2>/dev/null; then
    pass "LOKI_AUTO_CONFIRM prints an auditable auto-confirm line"
else
    fail "LOKI_AUTO_CONFIRM prints an auditable auto-confirm line" "no '(auto-confirmed)' in output"
fi

# ---------------------------------------------------------------------------
# 3. CI=true is the documented fallback when LOKI_AUTO_CONFIRM is unset
#    (see the env-var help: LOKI_AUTO_CONFIRM takes precedence over CI).
# ---------------------------------------------------------------------------
printf '%s\n' "$SENTINEL" > out3.md
timeout 15 env CI=true bash "$LOKI_BIN" export markdown out3.md > t3.log 2>&1
rc=$?
if [ "$rc" -eq 124 ]; then
    fail "CI=true terminates" "TIMED OUT (rc 124)"
else
    pass "CI=true terminates (rc $rc)"
fi
if grep -qF "auto-confirmed" t3.log 2>/dev/null; then
    pass "CI=true inherits the auto-confirm path"
else
    fail "CI=true inherits the auto-confirm path" "CI fallback did not auto-confirm"
fi

# ---------------------------------------------------------------------------
# 4. No pre-existing file: the guard must not fire at all.
# ---------------------------------------------------------------------------
rm -f fresh.md
timeout 15 bash "$LOKI_BIN" export markdown fresh.md > t4.log 2>&1
rc=$?
if [ "$rc" -eq 124 ]; then
    fail "fresh output path terminates" "TIMED OUT (rc 124)"
else
    pass "fresh output path terminates (rc $rc)"
fi
if grep -qF "already exists" t4.log 2>/dev/null; then
    fail "fresh output path does not prompt" "overwrite warning fired with no pre-existing file"
else
    pass "fresh output path does not prompt"
fi

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
