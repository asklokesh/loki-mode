#!/usr/bin/env bash
# E-154 / E-155 guards for tests/run-all-tests.sh. Everything runs in a run-owned
# temp dir with a fake HOME and a throwaway git repo: the real HOME, the real
# ~/.loki/keys and the real checkout are never used as a cwd or written.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup || true' EXIT
T="$LOKI_RUN_TMP"

PASS=0
FAIL=0
ok() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "=== E-154/E-155 run-all-tests guards ==="

# Build a mini repo + a runner copy: the real preamble and run_test body, with
# only our fake registrations, so the real guard code is what gets exercised.
mkdir -p "$T/repo/tests" "$T/repo/eval/loki10" "$T/home"
cp "$ROOT/eval/loki10/lib-tmp.sh" "$T/repo/eval/loki10/"
cp "$ROOT/tests/shard-durations.tsv" "$T/repo/tests/"
cp -R "$ROOT/tests/lib" "$T/repo/tests/lib"
[ -f "$ROOT/tests/quarantine.txt" ] && cp "$ROOT/tests/quarantine.txt" "$T/repo/tests/"
first=$(awk '/^run_test "/ {print NR; exit}' "$ROOT/tests/run-all-tests.sh")
sum=$(awk '/TEST SUITE SUMMARY/ {print NR - 2; exit}' "$ROOT/tests/run-all-tests.sh")
mk_runner() {
    { head -n $((first - 1)) "$ROOT/tests/run-all-tests.sh"
      cat
      tail -n +"$sum" "$ROOT/tests/run-all-tests.sh"; } >"$T/repo/tests/run-all-tests.sh"
}
git -C "$T/repo" init -q -b main
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$T/repo" branch stale

cat >"$T/repo/tests/t-noop.sh" <<'EOF'
echo noop
EOF
cat >"$T/repo/tests/t-switch.sh" <<'EOF'
git -C "$(dirname "$0")/.." checkout -q stale
EOF
cat >"$T/repo/tests/t-keys.sh" <<'EOF'
H="${LOKI_REAL_HOME:-$HOME}" # the runner is hermetic now (FC-07); this suite deliberately reaches past it
mkdir -p "$H/.loki/keys"; : >"$H/.loki/keys/receipt-ed25519.pem"
EOF
cat >"$T/repo/tests/t-printkey.sh" <<'EOF'
echo "KEYFILE=$LOKI_RECEIPT_SIGNING_KEY_FILE"
echo "CHILD_RUN_TMP=[${LOKI_RUN_TMP-unset}]"
EOF

run_runner() { (cd "$T/repo" && HOME="$T/home" env -u LOKI_TEST_LIST -u LOKI_TEST_SHARD -u LOKI_RECEIPT_SIGNING_KEY_FILE -u LOKI_RUN_TMP "$@" bash tests/run-all-tests.sh 2>&1); }

# E-155: a suite that switches the parent branch is named and fails the run.
mk_runner <<'EOF'
run_test "noop suite" "$SCRIPT_DIR/t-noop.sh"
run_test "switcher suite" "$SCRIPT_DIR/t-switch.sh"
EOF
out="$(run_runner TMPDIR="$T")"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "switcher suite FAILED: it changed the parent checkout HEAD"; then
    ok "E-155: branch switch fails the run and names the suite"
else bad "E-155: branch switch not caught (rc=$rc)"; fi
if printf '%s' "$out" | grep -q "noop suite FAILED"; then bad "E-155: clean suite falsely flagged"; else ok "E-155: clean suite not flagged"; fi

# E-154: a suite that writes the fake HOME's ~/.loki/keys fails the run.
rm -rf "$T/home/.loki"; git -C "$T/repo" checkout -q main
mk_runner <<'EOF'
run_test "key writer suite" "$SCRIPT_DIR/t-keys.sh"
EOF
out="$(run_runner TMPDIR="$T")"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "key writer suite FAILED: it changed the real"; then
    ok "E-154: writing ~/.loki/keys fails the run"
else bad "E-154: key write not caught (rc=$rc)"; fi

# E-154: default key file lives in a run-owned temp dir, not under HOME, and is removed at exit.
mk_runner <<'EOF'
run_test "printkey suite" "$SCRIPT_DIR/t-printkey.sh"
EOF
out="$(run_runner TMPDIR="$T")"
kf="$(printf '%s\n' "$out" | sed -n 's/^KEYFILE=//p' | head -n 1)"
case "$kf" in
    "$T"/loki-run.*/receipt-ed25519.pem) ok "E-154: default key file is under a run-owned temp dir" ;;
    *) bad "E-154: unexpected default key file '$kf'" ;;
esac
# A child suite must not inherit LOKI_RUN_TMP, or its own loki_run_tmp_create refuses.
printf '%s\n' "$out" | grep -qx 'CHILD_RUN_TMP=\[unset\]' && ok "E-154: child suite sees LOKI_RUN_TMP unset" || bad "E-154: LOKI_RUN_TMP leaked to child suite"
[ ! -e "$(dirname -- "${kf:-/nonexistent/x}")" ] && ok "E-154: run-owned dir removed at exit" || bad "E-154: run-owned dir leaked"
out="$(cd "$T/repo" && env -u LOKI_TEST_LIST -u LOKI_TEST_SHARD -u LOKI_RUN_TMP HOME="$T/home" TMPDIR="$T" LOKI_RECEIPT_SIGNING_KEY_FILE=/caller/key.pem bash tests/run-all-tests.sh 2>&1)"
printf '%s' "$out" | grep -q "KEYFILE=/caller/key.pem" && ok "E-154: caller-set key file is kept" || bad "E-154: caller key file overridden"

# E-154c: CI drives the runner with LOKI_TEST_SHARD only, so the guards must be
# active in shard mode (LOKI_TEST_LIST is a no-execution listing mode, not CI).
mk_runner <<'EOF2'
run_test "key writer suite" "$SCRIPT_DIR/t-keys.sh"
EOF2
rm -rf "$T/home/.loki"
out="$(run_runner TMPDIR="$T" LOKI_TEST_SHARD=0/1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "key writer suite FAILED: it changed the real"; then
    ok "E-154c: key guard active under LOKI_TEST_SHARD"
else bad "E-154c: key guard inactive under LOKI_TEST_SHARD (rc=$rc)"; fi
rm -rf "$T/home/.loki"
mk_runner <<'EOF2'
run_test "switcher suite" "$SCRIPT_DIR/t-switch.sh"
EOF2
out="$(run_runner TMPDIR="$T" LOKI_TEST_SHARD=0/1)"; rc=$?
git -C "$T/repo" checkout -q main
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "switcher suite FAILED: it changed the parent checkout HEAD"; then
    ok "E-155: HEAD guard active under LOKI_TEST_SHARD"
else bad "E-155: HEAD guard inactive under LOKI_TEST_SHARD (rc=$rc)"; fi
mk_runner <<'EOF2'
run_test "printkey suite" "$SCRIPT_DIR/t-printkey.sh"
EOF2
out="$(run_runner TMPDIR="$T" LOKI_TEST_SHARD=0/1)"
printf '%s\n' "$out" | grep -q "^KEYFILE=$T/loki-run\." && ok "E-154c: run-owned key default set under LOKI_TEST_SHARD" || bad "E-154c: no run-owned key default under LOKI_TEST_SHARD"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
