#!/usr/bin/env bash
# test-start-bash-diversion.sh -- RUN-25 iter 2 (T3(c)): when LOKI_SDK_LOOP is on,
# bin/loki must DIVERT `loki start` back to the bash route for orchestration flags
# / issue-refs the Bun runAutonomous loop does not handle (parallel worktrees,
# GitHub/issue import, docker sandbox, API server, backgrounding, alt spec
# sources), while keeping RUNNER flags + plain PRDs on the Bun loop. This is the
# "pre-loop handled, not rejected" guarantee that makes the loop default-flip a
# no-regression. Drives the REAL _loki_start_needs_bash extracted from bin/loki.
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_LOKI="$SCRIPT_DIR/../bin/loki"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }

[ -f "$BIN_LOKI" ] || { echo "FATAL: bin/loki not found"; exit 2; }

# Extract the real diversion function.
FN="$(awk '/^_loki_start_needs_bash\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$BIN_LOKI")"
[ -n "$FN" ] || { echo "FATAL: could not extract _loki_start_needs_bash from bin/loki"; exit 2; }

# route <expected: bash|bun> <args...> : run the real fn, map rc -> route.
route() {
    local want="$1"; shift
    local got
    if bash -c "$FN"$'\n'"_loki_start_needs_bash \"\$@\"" _ "$@" 2>/dev/null; then
        got="bash"  # rc 0 = divert to bash
    else
        got="bun"   # rc 1 = stay on Bun loop
    fi
    if [ "$got" = "$want" ]; then ok; else fail "want $want got $got for args: $*"; fi
}

# --- RUNNER flags + plain specs STAY on the Bun loop -----------------------
route bun ./prd.md
route bun ./specs/app.md --max-iterations 5
route bun --simple ./prd.md
route bun ./prd.md --allow-haiku
route bun --regen-prd ./prd.md
route bun ./prd.md --skip-memory
route bun --provider claude ./prd.md
route bun --isolation none ./prd.md
route bun --brief "build a todo app"

# --- Orchestration flags DIVERT to bash ------------------------------------
route bash --parallel ./prd.md
route bash --github ./prd.md
route bash ./prd.md --sandbox
route bash --api ./prd.md
route bash --bg ./prd.md
route bash --background ./prd.md
route bash --detach ./prd.md
route bash --isolation worktree ./prd.md
route bash --isolation docker ./prd.md
route bash --bmad-project ./proj
route bash --openspec ./change
route bash --mirofish ./prd.md
route bash --issue 42
route bash --pr ./prd.md
route bash --ship ./prd.md
route bash ./repo --fast
route bash ./repo --repo-fast
route bash ./repo --full
route bash ./repo --repo-full

# --- Issue-ref positionals DIVERT to bash ----------------------------------
route bash owner/repo#123
route bash "https://github.com/o/r/issues/5"
route bash "https://company.atlassian.net/browse/PROJ-12"

# --- Edge: a runner flag alongside an orchestration flag still diverts ------
# (orchestration wins -- the whole run needs bash's pre-loop work)
route bash --simple --github ./prd.md

# --- BRIEF-SHIP-FIX: brief runs have no issue (synthetic ref b<epoch>) ------
LOKI_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/loki"
chk() { if "${@:2}"; then PASS=$((PASS + 1)); echo "PASS: $1"; else FAIL=$((FAIL + 1)); echo "FAIL: $1"; fi; }
chk "detached auto-merge closes issues only for numeric refs" \
    grep -q '\[\[ "${LOKI_ISSUE_NUMBER:-}" =~ \^\[0-9\]+\$ \]\]' "$LOKI_SRC"
chk "no bare non-empty LOKI_ISSUE_NUMBER close guard remains" \
    bash -c '! grep -q -- "-n \"\${LOKI_ISSUE_NUMBER:-}\" \]\]" "$1"' _ "$LOKI_SRC"
chk "non-detached auto-merge arm accepts brief" \
    bash -c 'grep -A3 "Auto-merging" "$1" | grep -q "github|brief)"' _ "$LOKI_SRC"
chk "loki run --help marks --brief-text internal" \
    bash -c 'bash "$1" run --help 2>&1 | grep -- "--brief-text" | grep -q "(internal)"' _ "$LOKI_SRC"

echo ""
echo "test-start-bash-diversion: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
