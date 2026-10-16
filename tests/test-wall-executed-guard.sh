#!/usr/bin/env bash
# tests/test-wall-executed-guard.sh -- FC-68: scripts/assert-wall-executed.sh and its wiring.
# Deterministic and unbilled: fixture receipts only, no model is called.
#   11.3.1 shape (2 executed checks, Wall executed)            -> passes
#   11.3.2 shape (1 executed check, Wall discarded as not_run) -> FAILS
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$SCRIPT_DIR/.."
GUARD="$ROOT/scripts/assert-wall-executed.sh"
# shellcheck source=/dev/null
. "$ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1
FAILS=0
check() { if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi; }
expect_fail() { if [ "$2" -ne 0 ]; then check "$1" 0 ""; else check "$1" 1 "$3"; fi; }

# Shapes mirror what seal.ts writes: checks[].result, wall.files, wall.passed, not_proven[].
cat > "$T/r-11.3.1.json" <<'J'
{"verdict":"VERIFIED",
 "checks":[{"name":"wall:loki_wall_sum.test.js","cmd":"node --test","result":"pass","duration_s":0.4},
           {"name":"node:test","cmd":"node --test","result":"pass","duration_s":0.5}],
 "wall":{"files":[{"path":"loki_wall_sum.test.js","sha256":"aa"}],"passed":true},
 "not_proven":["signing unavailable"]}
J
cat > "$T/r-11.3.2.json" <<'J'
{"verdict":"VERIFIED",
 "checks":[{"name":"node:test","cmd":"node --test","result":"pass","duration_s":0.5}],
 "wall":{"files":[],"passed":null},
 "not_proven":["wall base run not_run: 1","wall test discarded: loki_wall_sum.test.js (not_run)"]}
J

rc=0; bash "$GUARD" "$T/r-11.3.1.json" > "$T/g1.log" 2>&1 || rc=$?
check "11.3.1 shape (2 executed, Wall executed) passes" "$rc" "$(cat "$T/g1.log")"
rc=0; bash "$GUARD" "$T/r-11.3.2.json" > "$T/g2.log" 2>&1 || rc=$?
expect_fail "11.3.2 shape (1 executed, Wall discarded not_run) fails" "$rc" "exit 0: $(cat "$T/g2.log")"
for needle in "executed checks >= 2 (got 1" "Wall test present" "Wall test executed" "wall test discarded"; do
    grep -F "FAIL wall-guard:" "$T/g2.log" | grep -qF "$needle"; check "11.3.2 failure names: $needle" "$?" "$(cat "$T/g2.log")"
done

# Each leg alone is enough to fail.
sed 's/"result":"pass","duration_s":0.4/"result":"not_run","duration_s":0.4/' "$T/r-11.3.1.json" > "$T/only-one-ran.json"
rc=0; bash "$GUARD" "$T/only-one-ran.json" > /dev/null 2>&1 || rc=$?
expect_fail "a not_run check does not count as executed" "$rc" "exit 0"
sed 's/"passed":true/"passed":null/' "$T/r-11.3.1.json" > "$T/wall-unrun.json"
rc=0; bash "$GUARD" "$T/wall-unrun.json" > /dev/null 2>&1 || rc=$?
expect_fail "Wall present but never executed fails" "$rc" "exit 0"
printf 'not json' > "$T/garbage.json"
rc=0; bash "$GUARD" "$T/garbage.json" > /dev/null 2>&1 || rc=$?
expect_fail "unreadable receipt fails (unmeasured is not clean)" "$rc" "exit 0"

# Wiring: the billed real-run scenarios apply the guard, so --check-receipt goes red on the 11.3.2 shape.
for s in trivial-sum two-bug; do
    grep -q '^SC_WALL_EXECUTED=1' "$ROOT/tests/real-run/scenarios/$s.sh"; check "scenario $s sets SC_WALL_EXECUTED=1" "$?" "missing"
    for f in 11.3.1 11.3.2; do
        # add the fields the other assertions read, so only the guard decides
        node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));r.cost={usd:0.1,input_tokens:1,output_tokens:1};r.time={wall_s:5};fs.writeFileSync(process.argv[2],JSON.stringify(r))' "$T/r-$f.json" "$T/rr-$f.json"
    done
    rc=0; bash "$ROOT/scripts/real-run.sh" --check-receipt "$T/rr-11.3.1.json" "$s" > "$T/w1.log" 2>&1 || rc=$?
    check "real-run $s accepts the 11.3.1 shape" "$rc" "$(cat "$T/w1.log")"
    rc=0; bash "$ROOT/scripts/real-run.sh" --check-receipt "$T/rr-11.3.2.json" "$s" > "$T/w2.log" 2>&1 || rc=$?
    expect_fail "real-run $s rejects the 11.3.2 shape" "$rc" "exit 0: $(cat "$T/w2.log")"
done

# Q17-04: an expected non-Wall check (lint, mutation proof, cross review) missing from checks[] fails.
cat > "$T/r-full.json" <<'J'
{"verdict":"VERIFIED",
 "checks":[{"name":"wall:loki_wall_sum.test.js","result":"pass"},
           {"name":"node:test","result":"pass"},
           {"name":"lint:eslint","result":"pass"},
           {"name":"mutation:proof","result":"pass"},
           {"name":"cross-review","result":"pass"}],
 "wall":{"files":[{"path":"loki_wall_sum.test.js","sha256":"aa"}],"passed":true},
 "not_proven":[]}
J
grep -v 'lint:eslint' "$T/r-full.json" > "$T/r-nolint.json"
sed 's/"lint:eslint","result":"pass"/"lint:eslint","result":"not_run"/' "$T/r-full.json" > "$T/r-lint-notrun.json"
rc=0; bash "$GUARD" "$T/r-full.json" 2 lint,mutation,review > "$T/q1.log" 2>&1 || rc=$?
check "Q17-04 complete receipt stays green with expected checks" "$rc" "$(cat "$T/q1.log")"
rc=0; bash "$GUARD" "$T/r-nolint.json" 2 lint,mutation,review > "$T/q2.log" 2>&1 || rc=$?
expect_fail "Q17-04 receipt with lint dropped goes red" "$rc" "exit 0: $(cat "$T/q2.log")"
grep -F "FAIL wall-guard:" "$T/q2.log" | grep -qF 'expected check "lint"'; check "Q17-04 failure names the lint check" "$?" "$(cat "$T/q2.log")"
rc=0; bash "$GUARD" "$T/r-lint-notrun.json" 2 lint > /dev/null 2>&1 || rc=$?
expect_fail "Q17-04 expected check with result not_run goes red" "$rc" "exit 0"
rc=0; bash "$GUARD" "$T/r-nolint.json" 2 > /dev/null 2>&1 || rc=$?
check "Q17-04 knob unset: dropped lint is ignored (behavior unchanged)" "$rc" "exit $rc"
rc=0; bash "$GUARD" "$T/garbage.json" 2 lint > /dev/null 2>&1 || rc=$?
expect_fail "Q17-04 malformed JSON with expected checks fails closed" "$rc" "exit 0"
rc=0; bash "$GUARD" "$T/r-full.json" 2 'li;nt' > /dev/null 2>&1 || rc=$?
usage_ok=1; [ "$rc" -eq 2 ] && usage_ok=0
check "Q17-04 malformed expected list is a usage error (rc 2)" "$usage_ok" "rc=$rc"
# Wiring: a scenario with SC_EXPECT_CHECKS makes --check-receipt go red on a receipt missing the check.
mkdir -p "$T/sc"
{ cat "$ROOT/tests/real-run/scenarios/trivial-sum.sh"; echo 'SC_EXPECT_CHECKS=lint,mutation,review'; } > "$T/sc/trivial-sum.sh"
for f in full nolint; do
    node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));r.cost={usd:0.1,input_tokens:1,output_tokens:1};r.time={wall_s:5};fs.writeFileSync(process.argv[2],JSON.stringify(r))' "$T/r-$f.json" "$T/rr-$f.json"
done
rc=0; REAL_RUN_SCENARIO_DIR="$T/sc" bash "$ROOT/scripts/real-run.sh" --check-receipt "$T/rr-nolint.json" trivial-sum > "$T/w3.log" 2>&1 || rc=$?
expect_fail "Q17-04 real-run --check-receipt with SC_EXPECT_CHECKS rejects a dropped lint" "$rc" "exit 0: $(cat "$T/w3.log")"
rc=0; REAL_RUN_SCENARIO_DIR="$T/sc" bash "$ROOT/scripts/real-run.sh" --check-receipt "$T/rr-full.json" trivial-sum > "$T/w4.log" 2>&1 || rc=$?
check "Q17-04 real-run --check-receipt with SC_EXPECT_CHECKS accepts a complete receipt" "$rc" "$(cat "$T/w4.log")"

# Post-Release Smoke must run the guard as a blocking step (no continue-on-error, no || true).
WF="$ROOT/.github/workflows/post-release-smoke.yml"
python3 -I - "$WF" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
steps = wf["jobs"]["npm-smoke"]["steps"]
hit = [s for s in steps if "test-wall-executed-guard" in str(s.get("run", ""))]
assert hit, "no npm-smoke step runs test-wall-executed-guard"
for s in hit:
    assert not s.get("continue-on-error"), "guard step is masked"
    assert "|| true" not in s["run"], "guard step is masked with || true"
print("ok", [s["name"] for s in hit])
PY
check "Post-Release Smoke npm-smoke has a blocking Wall guard step" "$?" "see above"

[ "$FAILS" -eq 0 ]
