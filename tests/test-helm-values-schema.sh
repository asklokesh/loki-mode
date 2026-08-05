#!/usr/bin/env bash
# The chart must reject a bad values file with a field-level message.
#
# WHY. Before this schema existed, `helm install --set worker.mode=Deployment`
# (capital D) SUCCEEDED. The templates branch on the exact lowercase string, so
# the chart installed cleanly and rendered NO WORKER AT ALL. Nothing consumed
# the queue and the only symptom was builds that never started -- discovered by
# an operator, in production, with no error to search for.
#
# The same shape applies to image.pullPolicy (rejected later at admission, far
# from the typo) and storage.backend (a wrong value silently disables
# off-cluster sync rather than erroring).
#
# A schema that accepts everything is WORSE than no schema: it looks like
# validation and is not. So this asserts BOTH halves -- good values render, bad
# values are refused by name.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHART="$REPO_ROOT/deploy/helm/autonomi"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
note() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

if ! command -v helm >/dev/null 2>&1; then
    note "helm not installed; schema enforcement not exercised"
    echo "Results: 0 passed, 0 failed, 1 skipped"
    exit 0
fi

echo "T1 -- the schema ships and is valid JSON"
S="$CHART/values.schema.json"
if [ -f "$S" ]; then
    ok "values.schema.json present"
else
    bad "values.schema.json missing -- helm cannot validate values at all"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi
python3 -c "import json;json.load(open('$S'))" 2>/dev/null \
    && ok "schema parses as JSON" \
    || bad "schema is not valid JSON (helm will error on every install)"

echo
echo "T2 -- shipped values still install"
# Non-vacuity for T3: if the default values were rejected, every "bad value is
# refused" assertion below would pass for the wrong reason.
if helm template t "$CHART" >/dev/null 2>&1; then
    ok "default values render (schema does not block the happy path)"
else
    bad "default values REJECTED by the schema -- the chart is unusable"
    helm template t "$CHART" 2>&1 | head -3 | sed 's/^/    /'
fi

echo
echo "T3 -- bad values are refused BY NAME"
_refuses() {  # $1 = --set expr, $2 = expected path fragment
    local out; out=$(helm template t "$CHART" --set "$1" 2>&1)
    if printf '%s' "$out" | grep -q "don't meet the specifications"; then
        if printf '%s' "$out" | grep -q "$2"; then
            ok "$1 refused, message names $2"
        else
            bad "$1 refused but the message does not name $2 (operator cannot find the field)"
        fi
    else
        bad "$1 was ACCEPTED -- this is the silent-failure case the schema exists for"
    fi
}
# The load-bearing one: a capitalised mode renders no worker and installs clean.
_refuses "worker.mode=Deployment" "/worker/mode"
_refuses "image.pullPolicy=always" "/image/pullPolicy"
_refuses "storage.backend=s4"      "/storage/backend"
# A negative replica count is a type/range error k8s would reject far later.
_refuses "worker.replicas=-1"      "/worker/replicas"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
