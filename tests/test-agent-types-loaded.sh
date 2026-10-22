#!/usr/bin/env bash
# The shipped agent roles must actually reach the review pool.
#
# WHAT THIS IS NOT: an earlier version of this file claimed the roles never
# loaded, because a probe that ran the selector standalone showed the pool going
# from 4 to 14 when LOKI_AGENTS_TYPES_FILE was set. That probe was wrong -- it
# omitted the export run.sh already performs. autonomy/run.sh:14764
# unconditionally exports LOKI_AGENTS_TYPES_FILE="${PROJECT_DIR}/agents/types.json"
# ten lines above the selector, so the 41 roles DO load in production today.
# The premise was refuted by mutation testing before anything shipped.
#
# What this suite does instead is PIN the working behaviour, because it is a
# three-part chain and any link can break silently:
#   1. agents/types.json exists,
#   2. agents/ is in package.json files[] so npm users get it,
#   3. run.sh exports the path, and the selector actually enlarges the pool.
# Break any one and the specialized roles quietly stop reaching reviews, with no
# error anywhere. Specialized reviewer roles are the axis competitors compete
# on, so a silent regression here is expensive and invisible.
#
# The assertions drive the REAL selector extracted from run.sh rather than a
# copy, so a change to the selector cannot leave this test green against a
# stale duplicate.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-agent-types-loaded"

if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 unavailable: specialist loading was not measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# 1. The shipped file must exist and be declared in files[]. Either half missing
#    means the default below points at nothing for npm users.
if [ -f agents/types.json ]; then
    pass "agents/types.json exists in the tree"
else
    fail "agents/types.json is missing; the production default has no target"
fi

if python3 -c "
import json,sys
f=json.load(open('package.json')).get('files',[])
sys.exit(0 if any(e.rstrip('/')=='agents' or e.startswith('agents/') for e in f) else 1)
" 2>/dev/null; then
    pass "agents/ is declared in package.json files[] (ships to npm users)"
else
    fail "agents/ is NOT in package.json files[]; the roles would not ship"
fi

# 2. run.sh must export the path, and the file it names must EXIST. Matching a
#    literal string alone is not enough: repointing the export at agents/NOPE.json
#    left a string-only assertion green. Resolve what run.sh actually names.
DEFAULT_PATH="$(grep -oE 'export LOKI_AGENTS_TYPES_FILE="\$\{?PROJECT_DIR\}?/[^"]+"' autonomy/run.sh \
                | head -1 | sed -E 's|.*PROJECT_DIR\}?/||; s|"$||')"
if [ -z "$DEFAULT_PATH" ]; then
    fail "run.sh no longer exports LOKI_AGENTS_TYPES_FILE; shipped roles will not load"
elif [ -f "$DEFAULT_PATH" ]; then
    pass "run.sh exports LOKI_AGENTS_TYPES_FILE to an existing file ($DEFAULT_PATH)"
else
    fail "run.sh exports LOKI_AGENTS_TYPES_FILE as $DEFAULT_PATH, which does not exist"
fi

# 2b. The export must sit in the SAME function as the selector and BEFORE it.
#     An export that drifts below the selector, or into another function, is
#     dead: the quoted heredoc reads only what was exported before it ran.
EXPORT_LINE="$(grep -n 'export LOKI_AGENTS_TYPES_FILE=' autonomy/run.sh | head -1 | cut -d: -f1)"
SELECTOR_LINE="$(grep -n "selected_specialists=\$(python3 << 'SPECIALIST_SELECT'" autonomy/run.sh | head -1 | cut -d: -f1)"
if [ -z "$EXPORT_LINE" ] || [ -z "$SELECTOR_LINE" ]; then
    fail "could not locate the export or the selector (unmeasured, not clean)"
elif [ "$EXPORT_LINE" -lt "$SELECTOR_LINE" ] \
     && [ $((SELECTOR_LINE - EXPORT_LINE)) -lt 100 ]; then
    pass "the export precedes the selector (line $EXPORT_LINE before $SELECTOR_LINE)"
else
    fail "the export at line $EXPORT_LINE does not precede the selector at $SELECTOR_LINE closely enough; it may no longer reach it"
fi

# 3. BEHAVIOUR, not just presence. Extract the real selector and run it both
#    ways. This is what attributes the gain to the file rather than to anything
#    else that happens to be true.
python3 - <<'PY' > "$WORK/extract.log" 2>&1
import io
s = io.open('autonomy/run.sh', encoding='utf-8').read()
start = s.index("selected_specialists=$(python3 << 'SPECIALIST_SELECT'")
start = s.index("\n", start) + 1
end = s.index("SPECIALIST_SELECT", start)
io.open('SELECTOR_OUT', 'w').write(s[start:end])
PY
mv SELECTOR_OUT "$WORK/sel.py" 2>/dev/null

if [ ! -s "$WORK/sel.py" ]; then
    fail "could not extract the specialist selector from run.sh (unmeasured, not clean)"
else
    pool_of() {
        printf '%s' "$1" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print('UNREADABLE'); raise SystemExit
print(d.get('pool_size','NONE'))
" 2>/dev/null
    }

    without="$( unset LOKI_AGENTS_TYPES_FILE
        LOKI_REVIEW_COMPLEXITY=standard LOKI_TARGET_DIR="$REPO_ROOT" \
        python3 "$WORK/sel.py" 2>/dev/null )"
    with="$( LOKI_AGENTS_TYPES_FILE="$REPO_ROOT/agents/types.json" \
        LOKI_REVIEW_COMPLEXITY=standard LOKI_TARGET_DIR="$REPO_ROOT" \
        python3 "$WORK/sel.py" 2>/dev/null )"

    p_without="$(pool_of "$without")"
    p_with="$(pool_of "$with")"

    case "$p_without$p_with" in
        *UNREADABLE*|*NONE*)
            fail "selector produced no usable pool_size (without=$p_without with=$p_with) -- unmeasured, not clean"
            ;;
        *)
            if [ "$p_with" -gt "$p_without" ]; then
                pass "the types file enlarges the specialist pool ($p_without -> $p_with)"
            else
                fail "the types file changed nothing (without=$p_without with=$p_with); the roles are not reaching the pool"
            fi
            ;;
    esac

    # 4. Name the roles individually rather than trusting a count: a threshold
    #    cannot say WHICH role vanished and picks up slack it was never meant to
    #    have. These four are dispatchable entries of the FOCUS_KEYWORDS table.
    for role in eng-backend eng-qa review-security ops-security; do
        if printf '%s' "$with" | grep -q "\"$role\""; then
            pass "role $role reaches the specialist pool"
        else
            fail "role $role ships in types.json but never reaches the pool"
        fi
    done
fi

# 5. The README must not say the orchestrator "assembles an agent team from 41
#    specialized agent roles". Measured: types.json carries 41 role definitions,
#    the review selector can keyword-score 10 of them (run.sh FOCUS_KEYWORDS),
#    and the other 31 exist only as descriptions in references/agent-types.md, which
#    nothing injects into the prompt. Marker-PRESENCE on the precise wording,
#    because a grep for "41" fires on the honest sentence too.
if [ ! -f README.md ]; then
    fail "README.md is missing; cannot verify its agent-roles claim"
elif grep -q 'assembles an agent team from 41 specialized agent roles' README.md; then
    fail "README claims an agent team is assembled from 41 roles; only 10 are selector-scoreable"
elif grep -q 'selects reviewers from a specialist pool' README.md; then
    pass "README describes the specialist pool precisely"
else
    fail "README no longer describes how reviewers are selected; re-check the claim against run.sh"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
