#!/usr/bin/env bash
# FC-07 / D86 guard: tests never touch the real ~/.loki.
#
# Phase A: a runner copy (real preamble + run_test body) runs a synthetic suite
#          that writes ~/.loki/control, ~/.loki/dashboard/projects.json,
#          ~/.loki/control/answers and ~/.loki/keys. HOME for that runner is a
#          stand-in "real home"; none of it may be touched.
# Phase B: real suites run through a runner copy under the REAL home (captured
#          before any isolation: LOKI_REAL_HOME when this suite itself runs
#          inside the runner, else HOME). The real ~/.loki listing and mtimes
#          (read-only stat, contents never read) must not change.
# Phase C: _loki_control_ui must honor LOKI_CONTROL=0 and never start a detached
#          `control serve` or write ~/.loki/control.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_HOME="${LOKI_REAL_HOME:-$HOME}"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup || true' EXIT
T="$LOKI_RUN_TMP"

PASS=0
FAIL=0
ok() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Listing + mtime fingerprint of a directory tree. stat only; never reads contents.
snap() {
    local d="$1" p m
    [ -d "$d" ] || { echo "absent"; return 0; }
    # Files a LIVE developer daemon owns and rewrites on its own clock (the running
    # Control Plane's sqlite store, the engine socket) are not test writes; a leak
    # into them is covered by phase A, which uses a stand-in home with no daemon.
    find "$d" -print 2>/dev/null | grep -v -E '/control/control\.db(-wal|-shm)?$|/\.loki/run(/|$)' | LC_ALL=C sort | while IFS= read -r p; do
        m="$(stat -c '%Y' -- "$p" 2>/dev/null)"
        case "$m" in '' | *[!0-9]*) m="$(stat -f '%m' -- "$p" 2>/dev/null)" ;; esac
        printf '%s %s\n' "$m" "$p"
    done
}

# Runner copy: the real preamble and run_test body with only our registrations.
mkdir -p "$T/repo/tests" "$T/repo/eval/loki10" "$T/fakehome"
cp "$ROOT/eval/loki10/lib-tmp.sh" "$T/repo/eval/loki10/"
cp "$ROOT/tests/shard-durations.tsv" "$T/repo/tests/"
[ -f "$ROOT/tests/quarantine.txt" ] && cp "$ROOT/tests/quarantine.txt" "$T/repo/tests/"
[ -d "$ROOT/tests/lib" ] && cp -R "$ROOT/tests/lib" "$T/repo/tests/lib"
first=$(awk '/^run_test "/ {print NR; exit}' "$ROOT/tests/run-all-tests.sh")
sum=$(awk '/TEST SUITE SUMMARY/ {print NR - 2; exit}' "$ROOT/tests/run-all-tests.sh")
mk_runner() {
    { head -n $((first - 1)) "$ROOT/tests/run-all-tests.sh"
      cat
      tail -n +"$sum" "$ROOT/tests/run-all-tests.sh"; } >"$T/repo/tests/run-all-tests.sh"
}
git -C "$T/repo" init -q -b main
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
run_runner() { # $1 = home the runner starts with
    (cd "$T/repo" || exit 1
     HOME="$1" TMPDIR="$T" env -u LOKI_TEST_LIST -u LOKI_TEST_SHARD -u LOKI_RECEIPT_SIGNING_KEY_FILE \
        -u LOKI_RUN_TMP -u LOKI_HERMETIC_HOME -u LOKI_REAL_HOME -u GIT_CONFIG_GLOBAL -u ISOLATED_GIT_HOME LOKI_TEST_SUITE_TIMEOUT=300 \
        bash tests/run-all-tests.sh 2>&1)
}

echo "=== FC-07 hermetic HOME guard ==="

# Phase A
cat >"$T/repo/tests/t-leak.sh" <<'LEAK'
mkdir -p "$HOME/.loki/control/answers" "$HOME/.loki/dashboard" "$HOME/.loki/keys"
: >"$HOME/.loki/control/answers/a1"
echo '{}' >"$HOME/.loki/dashboard/projects.json"
: >"$HOME/.loki/keys/receipt-ed25519.pem"
git config --global user.name probe 2>/dev/null || true
LEAK
cat >"$T/repo/tests/t-env.sh" <<'ENVT'
echo "SEEN_HOME=$HOME"
echo "SEEN_REAL=${LOKI_REAL_HOME-unset}"
echo "SEEN_RUN_TMP=[${LOKI_RUN_TMP-unset}]"
if git config --global user.name >/dev/null 2>&1; then echo "GIT_IDENTITY=yes"; else echo "GIT_IDENTITY=no"; fi
ENVT
mk_runner <<'EOF'
run_test "synthetic leaking suite" "$SCRIPT_DIR/t-leak.sh"
run_test "env probe suite" "$SCRIPT_DIR/t-env.sh"
EOF
before_a="$(snap "$T/fakehome")"
out_a="$(run_runner "$T/fakehome")"; rc_a=$?
after_a="$(snap "$T/fakehome")"
if [ "$rc_a" -eq 0 ]; then ok "A: runner passes with leaking suite (rc=0)"; else bad "A: runner rc=$rc_a"; fi
if [ "$before_a" = "$after_a" ] && [ ! -e "$T/fakehome/.loki" ] && [ ! -e "$T/fakehome/.gitconfig" ]; then
    ok "A: stand-in real HOME untouched by leaking suite"
else
    bad "A: leaking suite reached the stand-in real HOME (.loki or .gitconfig created)"
fi
if printf '%s' "$out_a" | grep -q "SEEN_HOME=$T/fakehome\$"; then bad "A: suite saw the real HOME"; else ok "A: suite HOME differs from real HOME"; fi
if printf '%s' "$out_a" | grep -q "SEEN_REAL=$T/fakehome\$"; then ok "A: LOKI_REAL_HOME exported to suites"; else bad "A: LOKI_REAL_HOME missing"; fi
if printf '%s' "$out_a" | grep -q "SEEN_RUN_TMP=\[unset\]"; then ok "A: LOKI_RUN_TMP not exported to children (E-154)"; else bad "A: LOKI_RUN_TMP leaked to children"; fi
if printf '%s' "$out_a" | grep -q "GIT_IDENTITY=yes"; then ok "A: git identity preserved in hermetic HOME"; else bad "A: git identity lost"; fi

# Phase B
B_SUITES="test-cross-project-learning.sh test-first-run-gate.sh test-doctor-optional-skill-not-blocking.sh test-local-receipt-attestation.sh test-dashboard-multiproject.sh"
reg=""
for s in $B_SUITES; do
    [ -f "$ROOT/tests/$s" ] || continue
    reg="${reg}run_test \"real: $s\" \"$ROOT/tests/$s\"
"
done
printf '%s' "$reg" | mk_runner
before_b="$(snap "$REAL_HOME/.loki")"
out_b="$(run_runner "$REAL_HOME")"; rc_b=$?
after_b="$(snap "$REAL_HOME/.loki")"
if [ "$rc_b" -eq 0 ]; then
    ok "B: real suites pass through the runner"
else
    bad "B: real suites rc=$rc_b"
    printf '%s\n' "$out_b" | grep -E "^.\[0;31m|^FAIL|^  FAIL|TIMEOUT|not ok|rror" | head -15
fi
if [ "$before_b" = "$after_b" ]; then
    ok "B: real ~/.loki listing and mtimes unchanged"
else
    bad "B: real ~/.loki changed (paths below, contents never read)"
    diff <(printf '%s\n' "$before_b") <(printf '%s\n' "$after_b") | head -10
fi

# Phase D: loki-ts/tests/engine10/ship_hook.test.ts (reads a host signing key) is
# deterministic with and without a key, and the bun preload keeps the real ~/.loki clean.
if command -v bun >/dev/null 2>&1; then
    before_d="$(snap "$REAL_HOME/.loki")"
    (cd "$ROOT/loki-ts" || exit 1; HOME="$REAL_HOME" env -u LOKI_HERMETIC_HOME -u LOKI_REAL_HOME timeout -k 10 300 bun test tests/engine10/ship_hook.test.ts >"$T/bun-d.log" 2>&1)
    rc_d=$?
    after_d="$(snap "$REAL_HOME/.loki")"
    if [ "$rc_d" -eq 0 ] && grep -q "with a signing key" "$ROOT/loki-ts/tests/engine10/ship_hook.test.ts" && grep -q "without a signing key" "$ROOT/loki-ts/tests/engine10/ship_hook.test.ts"; then
        ok "D: ship_hook.test.ts passes with and without a pinned signing key"
    else
        bad "D: ship_hook.test.ts rc=$rc_d"; tail -5 "$T/bun-d.log"
    fi
    if [ "$before_d" = "$after_d" ]; then ok "D: bun preload left the real ~/.loki unchanged"; else bad "D: bun test changed the real ~/.loki"; fi
else
    echo "  SKIP: D (bun not installed)"
fi

# Phase C
body="$(awk '/^_loki_control_ui\(\) \{/,/^}/' "$ROOT/autonomy/loki")"
mkdir -p "$T/bin" "$T/chome"
cat >"$T/bin/bun" <<BUN
#!/bin/sh
echo started >>"$T/bun-called"
exit 1
BUN
chmod +x "$T/bin/bun"
cat >"$T/c.sh" <<CSH
SKILL_DIR="$ROOT"
_loki_control_live_url() { return 1; }
loki_open_url() { :; }
$body
_loki_control_ui --no-open
CSH
PATH="$T/bin:$PATH" HOME="$T/chome" LOKI_CONTROL=0 timeout -k 5 30 bash "$T/c.sh" >/dev/null 2>&1
if [ ! -e "$T/bun-called" ] && [ ! -e "$T/chome/.loki" ]; then
    ok "C: _loki_control_ui with LOKI_CONTROL=0 starts nothing, writes nothing"
else
    bad "C: _loki_control_ui spawned control serve or wrote ~/.loki under LOKI_CONTROL=0"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
