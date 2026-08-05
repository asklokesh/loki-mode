#!/usr/bin/env bash
# The enterprise smoke path must exist, fail loudly, and not overclaim.
#
# WHY THE SCRIPT EXISTS. An evaluator has `npx loki-mode tour` -- a real result
# in seconds, no install. The Kubernetes path had no equivalent: read a chart,
# guess at values, find secrets, hope. That gap is an afternoon of reading
# between "we ship a Helm chart" and "you can see it work".
#
# WHY THIS TEST DOES NOT RUN IT. Creating a kind cluster pulls a ~1GB node image
# (measured: >25 minutes on a cold cache in this environment, with no output
# because kind prints nothing while pulling). A gate step that can hang for half
# an hour is a gate people disable. So this asserts the script's CONTRACT
# offline, and the script itself is run separately.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
S="$REPO_ROOT/scripts/enterprise-smoke.sh"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "T1 -- the script ships and is runnable"
[ -x "$S" ] && ok "enterprise-smoke.sh present and executable" || bad "missing or not executable"
bash -n "$S" 2>/dev/null && ok "parses" || bad "syntax error"

echo
echo "T2 -- a missing prerequisite fails loudly and by name"
# Verified by EXECUTION, not inspection: run it with a PATH that has no kind.
out=$(PATH="/usr/bin:/bin" bash "$S" 2>&1); rc=$?
[ "$rc" = "2" ] && ok "exits 2 on a missing prerequisite" || bad "exit was $rc, expected 2"
printf '%s' "$out" | grep -q "missing required tool: kind" \
  && ok "names WHICH tool is missing" \
  || bad "does not name the missing tool -- operator has to guess"

echo
echo "T3 -- failures are diagnosable, not a bare exit code"
# A non-zero exit with no cause costs an investigation. The supervisor-127 bug
# in this project cost two before anyone printed the child's own output.
grep -q "FAILED AT:" "$S" && ok "reports which STEP failed" || bad "no step attribution"
grep -q "_dump" "$S" && ok "dumps pod state and logs on failure" || bad "no diagnostics on failure"
# Teardown destroys the evidence, so diagnostics must run first.
python3 - "$S" <<'PY'
import sys
s=open(sys.argv[1]).read()
i=s.find('die()')
line=s[i:s.find('\n',i)]
sys.exit(0 if line.index('_dump') < line.index('_teardown') else 1)
PY
[ $? -eq 0 ] && ok "diagnostics run BEFORE teardown (evidence survives)" \
             || bad "teardown runs first and destroys the evidence"

echo
echo "T4 -- it does not claim more than it proves"
# A health check is not a build. Claiming one from the other would be exactly
# the overclaim the Evidence Receipt exists to prevent.
grep -q "NOT proven by this run" "$S" \
  && ok "states what the run does NOT prove" \
  || bad "no scope limit -- a health check would read as a working build"
grep -qi "needs a real provider key and spend" "$S" \
  && ok "names why the build half is out of scope" \
  || bad "does not explain the boundary"

echo
echo "T5 -- it cleans up after itself"
grep -q "kind delete cluster" "$S" && ok "tears the cluster down" || bad "leaves a cluster running"
grep -q "SMOKE_KEEP" "$S" \
  && ok "SMOKE_KEEP=1 preserves the cluster for debugging" \
  || bad "no way to keep the cluster when investigating a failure"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
