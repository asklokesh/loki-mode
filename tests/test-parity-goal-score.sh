#!/usr/bin/env bash
# tests/test-parity-goal-score.sh -- behavioral bash/Bun parity for goal scoring.
#
# loki-ts/src/runner/goal_score.ts goalSharpeningInstruction() and the
# goal_sharpening_instruction block in autonomy/run.sh must return the same
# bytes for the same goal. Instead of grepping for constants, this extracts the
# LIVE run.sh block, runs it in bash for every corpus goal, runs the real TS
# function in Bun for the same goals, and cmp's the outputs. The corpus is built
# from every regex alternative found on BOTH sides, so a token added, dropped or
# renamed on either side changes one line. Skips cleanly without bun.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Overridable so the red check can point at a mutated copy.
RUN_SH="${GOAL_PARITY_RUN_SH:-$REPO_ROOT/autonomy/run.sh}"
TS_SRC="${GOAL_PARITY_TS:-$REPO_ROOT/loki-ts/src/runner/goal_score.ts}"

PASS=0
FAIL=0
TMPROOT=""
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }
cleanup() { [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"; }
trap cleanup EXIT

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not on PATH; goal_score parity unverified"
    exit 0
fi

TMPROOT=$(mktemp -d -t loki-parity-goal-score-XXXX)

# Extract the live block: from the init line to the compose comment. Wrapped in
# a function so its `local` declarations are legal.
block_file="$TMPROOT/block.sh"
{
    echo 'goal_fn() {'
    awk '/^    local goal_sharpening_instruction=""/{p=1}
         /^    # Compose-first instruction/{p=0}
         p' "$RUN_SH"
    # shellcheck disable=SC2016  # literal text written into the extracted file
    echo '    printf "%s" "$goal_sharpening_instruction"'
    echo '}'
} > "$block_file"

if [ "$(wc -l < "$block_file")" -lt 20 ]; then
    bad "could not extract the goal_sharpening block from run.sh"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi
if ! bash -n "$block_file"; then
    bad "extracted block is not valid bash"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi

if ! summary=$(timeout -k 5 120 bun "$SCRIPT_DIR/goal-score-parity-corpus.ts" "$TS_SRC" "$RUN_SH" "$TMPROOT" 2>&1); then
    bad "bun corpus helper failed: $summary"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi
echo "$summary"

# Run the corpus through every grep implementation present: BSD and GNU differ
# on \b, and the run.sh block must not depend on which one is installed.
GREPS=()
for g in /usr/bin/grep /opt/homebrew/bin/grep /opt/homebrew/bin/ggrep /usr/local/bin/ggrep; do
    [ -x "$g" ] && GREPS+=("$g")
done
if [ "${#GREPS[@]}" -lt 2 ]; then
    echo "NOTE: no second (GNU) grep found at ggrep or /opt/homebrew/bin/grep; only ${GREPS[*]} exercised"
fi

# shellcheck disable=SC1090
. "$block_file"
mismatch=0
n_greps=0
for GREP_BIN in "${GREPS[@]}"; do
    n_greps=$((n_greps+1))
    mkdir -p "$TMPROOT/sh$n_greps"
    # Shadow grep for the extracted block only.
    # shellcheck disable=SC2329  # invoked by the sourced goal_fn block
    grep() { "$GREP_BIN" "$@"; }
    i=0
    while IFS= read -r goal; do
        ( COMPLETION_PROMISE="$goal"; export COMPLETION_PROMISE
          unset LOKI_GOAL_SCORING AUTONOMY_MODE PERPETUAL_MODE
          goal_fn ) > "$TMPROOT/sh$n_greps/$i.out"
        if ! cmp -s "$TMPROOT/sh$n_greps/$i.out" "$TMPROOT/ts/$i.out"; then
            mismatch=$((mismatch+1))
            bad "[$GREP_BIN] diverged on goal [$goal]: bash=$(head -c 60 "$TMPROOT/sh$n_greps/$i.out") ts=$(head -c 60 "$TMPROOT/ts/$i.out")"
        fi
        i=$((i+1))
    done < "$TMPROOT/corpus.txt"
    [ "$mismatch" -eq 0 ] && ok "[$GREP_BIN] bash and TS agree on all $i corpus goals"
done
unset -f grep
mkdir -p "$TMPROOT/sh"
cp "$TMPROOT"/sh1/*.out "$TMPROOT/sh/"

# Kill switch: both sides return empty.
off=$( COMPLETION_PROMISE="make it fast" LOKI_GOAL_SCORING=0 goal_fn )
if [ -z "$off" ] && [ ! -s "$TMPROOT/ts/off.out" ]; then
    ok "LOKI_GOAL_SCORING=0 suppresses both sides"
else
    bad "LOKI_GOAL_SCORING=0 not honored identically"
fi

# Perpetual mode is suppressed in bash; TS callers skip it (build_prompt.ts).
pp=$( COMPLETION_PROMISE="make it fast" AUTONOMY_MODE=perpetual goal_fn )
if [ -z "$pp" ]; then ok "perpetual mode suppresses bash side"; else bad "perpetual mode not suppressed in bash"; fi

# Positive control: the flagged path must be exercised, not vacuously equal.
idx=$(grep -n -x 'make it fast' "$TMPROOT/corpus.txt" | head -1 | cut -d: -f1)
if [ -n "$idx" ] && [ -s "$TMPROOT/ts/$((idx-1)).out" ] && [ -s "$TMPROOT/sh/$((idx-1)).out" ]; then
    ok "positive control: an unmeasurable goal produces an instruction on both sides"
else
    bad "positive control failed: no instruction for 'make it fast'"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
