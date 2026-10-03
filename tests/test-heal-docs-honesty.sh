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

# Count production callers of the hooks across every tracked file under the
# given repo root. Excludes tests, markdown, built dist output, research docs
# and graphify output, then drops comment lines and the hook() definition.
count_callers() {
    local root="$1" hook n total=0
    for hook in hook_pre_healing_modify hook_post_healing_modify; do
        n=$(git -C "$root" grep -n -e "$hook" -- . \
            ':(exclude)tests' ':(exclude)*.md' ':(exclude)*/dist/*' \
            ':(exclude)docs/research*' ':(exclude)graphify-out' 2>/dev/null \
            | grep -vE ':[0-9]+:[[:space:]]*#' \
            | grep -vcE ":[0-9]+:[[:space:]]*${hook}\(\)")
        total=$((total + n))
    done
    echo "$total"
}

# Fixture: a caller outside the old autonomy/bin/loki-ts-src scan list must be seen.
# shellcheck source=/dev/null
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
FIX="$LOKI_RUN_TMP/fixture"
mkdir -p "$FIX/dashboard" "$FIX/autonomy"
git -C "$FIX" init -q
# shellcheck disable=SC2016
printf '%s\n' 'hook_pre_healing_modify "$f"' >"$FIX/dashboard/x.py"
printf '%s\n' 'hook_pre_healing_modify() {' > "$FIX/autonomy/h.sh"
git -C "$FIX" add dashboard/x.py autonomy/h.sh
old_scan=$(cd "$FIX" && grep -rn hook_pre_healing_modify autonomy bin loki-ts/src 2>/dev/null \
    | grep -vcE ':[0-9]+:[[:space:]]*hook_pre_healing_modify\(\)')
new_scan=$(count_callers "$FIX")
if [ "$new_scan" -eq 1 ] && [ "$old_scan" -eq 0 ]; then
    pass "fixture: dashboard caller counted 1 (old scan list counted $old_scan)"
else
    fail "fixture: expected new=1 old=0, got new=$new_scan old=$old_scan"
fi

callers=$(count_callers "$REPO_ROOT")

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
