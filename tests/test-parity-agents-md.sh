#!/usr/bin/env bash
# tests/test-parity-agents-md.sh -- bash/Bun parity for the AGENTS.md
# conventions instruction string.
#
# The instruction MUST be byte-identical between:
#   - bash: autonomy/run.sh build_prompt() local agents_md_instruction
#   - TS:   loki-ts/src/runner/build_prompt.ts AGENTS_MD_INSTRUCTION
#
# Same precedent as AUTONOMY_OVERRIDE_TEXT (providers/claude_flags.ts), which is
# "kept byte-identical" across routes. Skips cleanly if `bun` is not on PATH.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_TS_DIR="$REPO_ROOT/loki-ts"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not on PATH; AGENTS.md parity unverified"
    exit 0
fi

TMPROOT=$(mktemp -d -t loki-parity-agents-md-XXXX)

# ---------- bash route ----------
# Source run.sh and echo the local var by re-declaring the same expression.
# We extract it from the live function so we test the actual shipped value,
# not a hand-copied literal. Strategy: source run.sh, then grep the function
# body line and eval it in isolation to capture the value.
bash_val=$(
    # The variable is `local`, so we cannot read it after the function returns.
    # Instead, extract the assignment line from the source and evaluate it.
    line=$(grep -m1 'local agents_md_instruction=' "$RUN_SH")
    # Strip the leading `local ` so it assigns in the current shell.
    expr="${line#*local }"
    eval "$expr"
    # shellcheck disable=SC2154  # assigned dynamically via the eval above
    printf '%s' "$agents_md_instruction"
)

if [ -z "$bash_val" ]; then
    bad "bash: could not extract agents_md_instruction from run.sh"
    echo
    echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
    exit 1
fi
printf '%s' "$bash_val" > "$TMPROOT/bash.txt"

# ---------- Bun route ----------
(cd "$LOKI_TS_DIR" && bun run --silent - <<'BUNEOF' 2>/dev/null) > "$TMPROOT/bun.txt"
import { _internals } from "./src/runner/build_prompt.ts";
process.stdout.write(_internals.AGENTS_MD_INSTRUCTION);
BUNEOF

if [ ! -s "$TMPROOT/bun.txt" ]; then
    bad "bun: AGENTS_MD_INSTRUCTION export empty or missing"
    echo
    echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
    exit 1
fi

# ---------- byte-for-byte comparison ----------
if diff "$TMPROOT/bash.txt" "$TMPROOT/bun.txt" >/dev/null 2>&1; then
    ok "AGENTS.md instruction byte-identical across bash and Bun"
else
    bad "AGENTS.md instruction MISMATCH between routes"
    echo "  --- bash ---"
    cat "$TMPROOT/bash.txt"; echo
    echo "  --- bun ---"
    cat "$TMPROOT/bun.txt"; echo
fi

# Sanity: forbid em/en dashes in the shipped string (project rule).
# Build the forbidden chars from unicode code points so this test file itself
# stays free of literal em/en dashes (the no-dash CI check greps source).
EMDASH=$(printf '\xe2\x80\x94')
ENDASH=$(printf '\xe2\x80\x93')
if grep -q "$EMDASH" "$TMPROOT/bash.txt" || grep -q "$ENDASH" "$TMPROOT/bash.txt"; then
    bad "AGENTS.md instruction contains an em/en dash"
else
    ok "AGENTS.md instruction free of em/en dashes"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
