#!/usr/bin/env bash
# test-heuristic-council-affirmative.sh -- RUN-25 iter 14 (Wave B #9): when no AI
# reviewer CLI is installed the council falls to council_heuristic_review. Its
# test_auditor arm used to APPROVE unless the evidence text merely lacked a
# "fail"/"error" token -- i.e. it approved on the ABSENCE of a negative signal, a
# fake-green: a build whose suite NEVER RAN has no failure text either. The fix
# requires AFFIRMATIVE evidence (.loki/quality/test-results.json with a real
# runner AND pass==true) before the auditor can approve.
#
# Sources the real completion-council.sh + stubs loggers. No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="$SCRIPT_DIR/../autonomy/completion-council.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }

[ -f "$CC" ] || { echo "FATAL: completion-council.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

log_info() { :; }
log_warn() { :; }
log_error() { :; }
log_success() { :; }
log_header() { :; }
record_trust_event_bash() { :; }

# shellcheck disable=SC1090
source "$CC" 2>/dev/null || true
type council_heuristic_review >/dev/null 2>&1 \
  || { echo "FATAL: council_heuristic_review not defined"; exit 2; }

# vote <cwd> <test-results-json-or-empty> : write results if given, run the real
# test_auditor heuristic against a benign evidence file, echo the VOTE token.
vote() {
    local dir="$1" trjson="$2"
    (
        cd "$dir" || exit 3
        if [ -n "$trjson" ]; then
            mkdir -p .loki/quality
            printf '%s' "$trjson" > .loki/quality/test-results.json
        fi
        local ev; ev="$(mktemp)"
        # benign evidence that MENTIONS tests and has no fail/error token -- the
        # exact input the old logic would have rubber-stamped APPROVE.
        printf 'evidence: the test suite and spec files look present, all good\n' > "$ev"
        council_heuristic_review "test_auditor" "$ev" | grep -oE 'VOTE:[A-Z]+' | head -1
        rm -f "$ev"
    )
}

# 1. NO test-results.json (tests never ran) -> REJECT (was fake-green APPROVE)
D1="$(mktemp -d)"
[ "$(vote "$D1" "")" = "VOTE:REJECT" ] && ok || fail "no test evidence should REJECT (fake-green closed), got APPROVE"
rm -rf "$D1"

# 2. real runner + pass true -> APPROVE (affirmative evidence)
D2="$(mktemp -d)"
[ "$(vote "$D2" '{"runner":"vitest","pass":true}')" = "VOTE:APPROVE" ] && ok || fail "real passing tests should APPROVE"
rm -rf "$D2"

# 3. runner none / inconclusive -> REJECT
D3="$(mktemp -d)"
[ "$(vote "$D3" '{"runner":"none","pass":"inconclusive"}')" = "VOTE:REJECT" ] && ok || fail "inconclusive tests should REJECT (not affirmative)"
rm -rf "$D3"

# 4. real runner but pass false -> REJECT
D4="$(mktemp -d)"
[ "$(vote "$D4" '{"runner":"vitest","pass":false}')" = "VOTE:REJECT" ] && ok || fail "real failing tests should REJECT"
rm -rf "$D4"

# 5. corrupt test-results.json -> REJECT (unparseable is not affirmative)
D5="$(mktemp -d)"
[ "$(vote "$D5" 'not json {{{')" = "VOTE:REJECT" ] && ok || fail "corrupt test-results should REJECT"
rm -rf "$D5"

echo ""
echo "test-heuristic-council-affirmative: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
