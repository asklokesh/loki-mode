#!/usr/bin/env bash
# tests/test-real-run.sh -- scripts/real-run.sh: scenario parsing, the --dry install from the packed
# tarball, and assertion failure on a doctored receipt. No model is called.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RR="$SCRIPT_DIR/../scripts/real-run.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1 LOKI_NO_SKILL_LINK_HEAL=1
FAILS=0
check() { if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi; }
expect_fail() { if [ "$2" -ne 0 ]; then check "$1" 0 ""; else check "$1" 1 "$3"; fi; }

# 1. all five scenarios exist and parse
for s in trivial-sum two-bug attempts-2 router-on issues-dry-run; do
    rc=0; bash "$RR" --validate "$s" > "$T/v-$s.log" 2>&1 || rc=$?
    check "scenario parses: $s" "$rc" "$(tail -3 "$T/v-$s.log")"
done
rc=0; bash "$RR" --validate no-such-scenario > "$T/v-bad.log" 2>&1 || rc=$?
expect_fail "unknown scenario rejected" "$rc" "exit 0"
printf 'SC_DESC=x\nSC_RECEIPT=("verdict ~~ x")\n' > "$T/bad.sh"
rc=0; REAL_RUN_SCENARIO_DIR="$T" bash "$RR" --validate bad > "$T/v-bad2.log" 2>&1 || rc=$?
expect_fail "malformed assertion rejected" "$rc" "exit 0"

# 2. doctored receipt: a good receipt passes, a doctored one fails
cat > "$T/good.json" <<'J'
{"verdict":"VERIFIED","cost":{"usd":0.08,"input_tokens":1200,"output_tokens":300},"time":{"wall_s":42}}
J
sed 's/"VERIFIED"/"FAILED"/' "$T/good.json" > "$T/bad.json"
rc=0; bash "$RR" --check-receipt "$T/good.json" trivial-sum > "$T/c-good.log" 2>&1 || rc=$?
check "good receipt passes" "$rc" "$(cat "$T/c-good.log")"
rc=0; bash "$RR" --check-receipt "$T/bad.json" trivial-sum > "$T/c-bad.log" 2>&1 || rc=$?
expect_fail "doctored receipt fails" "$rc" "exit 0"
grep -q '^FAIL' "$T/c-bad.log"; check "doctored receipt prints FAIL line" "$?" "$(cat "$T/c-bad.log")"
grep -q '^PASS' "$T/c-good.log"; check "good receipt prints PASS line" "$?" "$(cat "$T/c-good.log")"

# 3. --dry installs the packed tarball into a temp prefix and runs the installed binary
rc=0; timeout -k 10 600 bash "$RR" --dry trivial-sum > "$T/dry.log" 2>&1 || rc=$?
check "--dry exits 0" "$rc" "$(tail -8 "$T/dry.log")"
grep -q 'installed binary:.*node_modules/\.bin/loki' "$T/dry.log"; check "--dry uses the installed binary" "$?" "$(tail -8 "$T/dry.log")"

[ "$FAILS" -eq 0 ]
