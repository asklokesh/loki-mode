#!/usr/bin/env bash
# Healing docs must disclose that the healing modify hooks are not wired (issue #200).
#
# The pre/post modify hooks are defined in autonomy/hooks/migration-hooks.sh but
# nothing in production calls them, so the snapshot/revert pairing and the
# failure catalog append inside them never run in a real heal.
#
# Marker PRESENCE is asserted, never phrase absence, so this file and the
# corrected docs cannot trip the guard with their own explanatory text.
# The caller count ignores definition lines and comment lines.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-heal-docs-honesty"

MARKER="NOT WIRED"
ISSUE="issue #200"

callers=0
for hook in hook_pre_healing_modify hook_post_healing_modify; do
    n=$(grep -rn "$hook" autonomy bin loki-ts/src 2>/dev/null \
        | grep -v "node_modules" \
        | grep -vE ':[0-9]+:[[:space:]]*#' \
        | grep -vcE ":[0-9]+:[[:space:]]*${hook}\(\)")
    callers=$((callers + n))
done

if [ "$callers" -eq 0 ]; then
    pass "production caller count is zero"
    for doc in skills/healing.md docs/dev/architecture-reference.md; do
        if grep -q "$MARKER" "$doc" && grep -q "$ISSUE" "$doc"; then
            pass "$doc discloses the unwired hooks ($ISSUE)"
        else
            fail "$doc must carry '$MARKER' and '$ISSUE' while the hooks have no production caller"
        fi
    done
else
    fail "a production caller now exists ($callers); wire-up landed, so update skills/healing.md and docs/dev/architecture-reference.md to drop the unwired disclosure, then update this test"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
