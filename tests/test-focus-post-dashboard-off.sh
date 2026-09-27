#!/usr/bin/env bash
#===============================================================================
# tests/test-focus-post-dashboard-off.sh
#
# S-195 (BACKLOG 17): the "Notify dashboard of active project directory" block
# in autonomy/run.sh POSTed to /api/focus even with ENABLE_DASHBOARD=false.
#
# The REAL block is extracted by its comment anchor (no full run.sh source),
# wrapped in a function, and run from a scratch dir with a curl shim on PATH.
# Legs:
#   1. ENABLE_DASHBOARD=false -> shim log empty
#   2. ENABLE_DASHBOARD=true  -> exactly one POST to /api/focus
#   3. mutation: the block with the ENABLE_DASHBOARD guard removed fails leg 1
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
BASH_BIN="${BASH:-bash}"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s195-XXXXXX")"
cleanup() { cd "$REPO_ROOT" 2>/dev/null || true; rm -rf "${WORK:-/nonexistent}"; }
trap cleanup EXIT INT TERM

provider_before=0
[ -e "$REPO_ROOT/.loki/state/provider" ] && provider_before=1

# Extract from the anchor comment to the first closing `fi` at block indent.
extract_block() {
    awk '/# Notify dashboard of active project directory/ {f=1}
         f {print}
         f && /^    fi$/ {exit}' "$1"
}

BLOCK_SRC="$WORK/block.src"
extract_block "$RUN_SH" > "$BLOCK_SRC"
if ! grep -q '/api/focus' "$BLOCK_SRC" || ! grep -q '^    fi$' "$BLOCK_SRC"; then
    echo "FAIL: could not extract the focus notify block from run.sh (anchor moved?)"
    exit 1
fi

# Curl shim: records every invocation's args, one line per call.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHIM_LOG"
exit 0
SHIM
chmod +x "$WORK/bin/curl"

# run_leg <block-file> <ENABLE_DASHBOARD value> -> prints POST count to /api/focus
run_leg() {
    local block="$1" val="$2" log="$WORK/curl.$RANDOM.log"
    : > "$log"
    mkdir -p "$WORK/proj"
    (
        cd "$WORK/proj" || exit 1
        PATH="$WORK/bin:$PATH" SHIM_LOG="$log" ENABLE_DASHBOARD="$val" \
            DASHBOARD_PORT=57374 "$BASH_BIN" -c \
            "_s195() {
$(cat "$block")
}
_s195"
    ) >/dev/null 2>&1
    # "<POSTs to /api/focus> <total curl calls>"
    echo "$(grep -c 'POST.*/api/focus' "$log" || true) $(wc -l < "$log" | tr -d ' ')"
}

r="$(run_leg "$BLOCK_SRC" false)"
[ "$r" = "0 0" ] && pass "ENABLE_DASHBOARD=false: shim log empty" || fail "ENABLE_DASHBOARD=false: expected empty shim log, got posts/calls=$r"

n="$(run_leg "$BLOCK_SRC" true)"; n="${n%% *}"
[ "$n" = "1" ] && pass "ENABLE_DASHBOARD=true: one POST" || fail "ENABLE_DASHBOARD=true: expected 1 POST, got $n"

# Mutation: strip the ENABLE_DASHBOARD guard in a scratch copy; leg 1 must go red.
MUT="$WORK/block.mut"
sed 's/\[\[ "\${ENABLE_DASHBOARD:-true}" == "true" \]\] && //' "$BLOCK_SRC" > "$MUT"
if cmp -s "$BLOCK_SRC" "$MUT"; then
    fail "mutation did not change the block (guard text moved?)"
else
    n="$(run_leg "$MUT" false)"; n="${n%% *}"
    [ "$n" = "1" ] && pass "mutation (guard removed) fails the false leg" || fail "mutation expected 1 POST, got $n"
fi

if [ "$provider_before" = "0" ] && [ -e "$REPO_ROOT/.loki/state/provider" ]; then
    fail "test created .loki/state/provider in the repo"
fi

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
