#!/usr/bin/env bash
# Budget spend-key contract: every READER must read the key the WRITERS emit.
#
# Two shipped defects motivated this suite, both the same class and both
# invisible to the existing tests because every fixture wrote the key the
# reader wanted instead of the key production writes:
#
#   1. loki_remaining_budget (autonomy/lib/claude-flags.sh) and its byte-mirror
#      remainingBudget (loki-ts/src/providers/claude_flags.ts) read
#      "current_spend". NO production writer has ever emitted that key. Spend
#      therefore read 0 forever and --max-budget-usd received the FULL cap on
#      every call instead of the remainder, so the per-call backstop never
#      tightened as spend accumulated.
#
#   2. check_budget_threshold (autonomy/notification-checker.py) read "used"
#      from the "budget" sub-dict of dashboard-state.json. run.sh:7084 nests
#      .loki/metrics/budget.json there verbatim, and that file's key is
#      "budget_used", so the budget-80pct notification never fired in
#      production.
#
# Every fixture below is written in the EXACT shape run.sh emits
# (limit/budget_limit/budget_used/exceeded). That is load-bearing: a fixture
# carrying only the new key would still pass a reader that kept the old key as
# its first choice.
#
# Each assertion is individual and named. No count thresholds: a threshold
# cannot say WHICH reader regressed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-budget-keys.XXXXXX")" || exit 1
cleanup() { [ -n "${TMPROOT:-}" ] && rm -rf "$TMPROOT"; }
trap cleanup EXIT

# Exactly the object run.sh:17867-17870 writes.
write_bash_shaped_budget() {
    local dir="$1" limit="$2" used="$3" exceeded="$4"
    mkdir -p "$dir/.loki/metrics"
    cat > "$dir/.loki/metrics/budget.json" <<EOF
{
  "limit": $limit,
  "budget_limit": $limit,
  "budget_used": $used,
  "exceeded": $exceeded
}
EOF
}

# ---------------------------------------------------------------------------
# 1. No production writer may emit "current_spend".
#
# This is the assertion that would have caught the original defect. It scans
# production sources only; test fixtures may legitimately carry the legacy key
# to prove the fallback still parses.
# ---------------------------------------------------------------------------
producers=$(git grep -l '"current_spend"' -- autonomy/ dashboard/ web-app/ memory/ mcp/ 2>/dev/null \
            | grep -v '^autonomy/lib/claude-flags.sh$' || true)
if [ -z "$producers" ]; then
    ok "no production file writes the orphan key \"current_spend\""
else
    bad "production files emit \"current_spend\": $producers"
fi

# ---------------------------------------------------------------------------
# 2. loki_remaining_budget reads budget_used from a bash-shaped file.
# ---------------------------------------------------------------------------
# shellcheck source=../autonomy/lib/claude-flags.sh
if ! . autonomy/lib/claude-flags.sh 2>/dev/null; then
    bad "could not source autonomy/lib/claude-flags.sh"
    printf '\nTotal: %d  Passed: %d  Failed: %d\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
    exit 1
fi

if ! type loki_remaining_budget >/dev/null 2>&1; then
    bad "loki_remaining_budget is not defined after sourcing claude-flags.sh"
else
    D="$TMPROOT/a"; write_bash_shaped_budget "$D" 100.00 60.00 false
    v="$(LOKI_BUDGET_LIMIT="100.00" TARGET_DIR="$D" loki_remaining_budget)"
    [ "$v" = "40.00" ] \
        && ok "remaining_budget reads budget_used: 100 - 60 = 40.00" \
        || bad "remaining_budget on a bash-shaped file got [$v], want 40.00"

    # The legacy key must still parse, so a budget.json written by an older
    # in-flight run does not silently become "zero spent".
    D="$TMPROOT/b"; mkdir -p "$D/.loki/metrics"
    printf '{"current_spend": 60.00}\n' > "$D/.loki/metrics/budget.json"
    v="$(LOKI_BUDGET_LIMIT="100.00" TARGET_DIR="$D" loki_remaining_budget)"
    [ "$v" = "40.00" ] \
        && ok "remaining_budget still honors the legacy current_spend fallback" \
        || bad "legacy fallback got [$v], want 40.00"

    # budget_used must WIN over a stale current_spend in the same file.
    D="$TMPROOT/c"; mkdir -p "$D/.loki/metrics"
    printf '{"budget_used": 60.00, "current_spend": 5.00}\n' > "$D/.loki/metrics/budget.json"
    v="$(LOKI_BUDGET_LIMIT="100.00" TARGET_DIR="$D" loki_remaining_budget)"
    [ "$v" = "40.00" ] \
        && ok "budget_used takes precedence over a stale current_spend" \
        || bad "precedence got [$v], want 40.00"

    # Overspend emits empty, never 0 or a negative number.
    D="$TMPROOT/d"; write_bash_shaped_budget "$D" 100.00 150.00 true
    v="$(LOKI_BUDGET_LIMIT="100.00" TARGET_DIR="$D" loki_remaining_budget)"
    [ -z "$v" ] \
        && ok "remaining_budget emits empty when overspent (never 0 or negative)" \
        || bad "overspent got [$v], want empty"
fi

# ---------------------------------------------------------------------------
# 3. The budget-80pct notification fires against the real dashboard-state shape.
#
# Reads the notification STORE, never a filename grep: notification-checker.py
# writes its own triggers.json config on every run, and that file always
# contains the string "budget-80pct". Grepping filenames for the trigger id is
# vacuous and reports a pass whether or not the trigger ever fired.
# ---------------------------------------------------------------------------
notif_fired() {
    local state_json="$1"
    local D; D="$(mktemp -d "$TMPROOT/notif.XXXXXX")"
    mkdir -p "$D/.loki/notifications"
    printf '%s\n' "$state_json" > "$D/.loki/dashboard-state.json"
    python3 autonomy/notification-checker.py --iteration 3 --loki-dir "$D/.loki" >/dev/null 2>&1
    _LOKI_NOTIF_DIR="$D/.loki/notifications" python3 -c '
import json, os, glob
base = os.environ["_LOKI_NOTIF_DIR"]
recs = []
for p in glob.glob(os.path.join(base, "*.json")):
    if os.path.basename(p) == "triggers.json":
        continue
    try:
        d = json.load(open(p))
    except Exception:
        continue
    items = d if isinstance(d, list) else d.get("notifications", d)
    if isinstance(items, list):
        recs.extend(items)
    elif isinstance(items, dict):
        recs.append(items)
print(sum(1 for r in recs if isinstance(r, dict) and r.get("trigger_id") == "budget-80pct"))
'
}

n="$(notif_fired '{"budget": {"limit": 100.00, "budget_limit": 100.00, "budget_used": 85.00, "exceeded": false}}')"
[ "$n" = "1" ] \
    && ok "budget-80pct fires at 85% against the shape run.sh:7084 writes" \
    || bad "budget-80pct on a bash-shaped state fired $n times, want 1"

n="$(notif_fired '{"budget": {"limit": 100.00, "used": 85.00}}')"
[ "$n" = "1" ] \
    && ok "budget-80pct still fires on the /api/cost-shaped payload (used)" \
    || bad "budget-80pct on the legacy payload fired $n times, want 1"

# Negative control: without it, a reader that fired unconditionally would pass
# every assertion above.
n="$(notif_fired '{"budget": {"limit": 100.00, "budget_limit": 100.00, "budget_used": 10.00, "exceeded": false}}')"
[ "$n" = "0" ] \
    && ok "budget-80pct stays silent at 10% (negative control)" \
    || bad "budget-80pct fired $n times at 10% of cap, want 0"

printf '\nTotal: %d  Passed: %d  Failed: %d\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
