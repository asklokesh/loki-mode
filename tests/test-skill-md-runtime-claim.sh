#!/usr/bin/env bash
# Drift guard: the "Runtime migration" paragraph in SKILL.md must not claim that
# only read-only commands run on the Bun route. bin/loki routes many mutating
# commands (rollback, trust, proof, control, answer, ...) to loki-ts/src/cli.ts,
# so a "read-only only / every other command stays on Bash" claim is false and
# misleads an agent about what `loki X` actually runs.
#
# Expectations derive from source: the bin/loki Bun-route case and cli.ts dispatch.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT" || exit 1

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL: $1"; }

para=$(grep -m1 '^\*\*Runtime migration:\*\*' SKILL.md || true)
if [ -z "$para" ]; then
    fail "SKILL.md has a '**Runtime migration:**' paragraph"
    echo "Results: $PASSED passed, $FAILED failed"
    exit 1
fi
pass "SKILL.md has a Runtime migration paragraph"

# Ground truth 1: bin/loki's final routing case sends non-read-only commands to Bun.
bun_route=$(grep -E '^[[:space:]]+version\|--version\|-v\|status\|' bin/loki | head -1)
if echo "$bun_route" | grep -q 'rollback'; then
    pass "bin/loki routes mutating command 'rollback' to the Bun route"
else
    fail "bin/loki Bun-route case no longer lists rollback; update this guard"
fi

# Ground truth 2: cli.ts dispatches 'start' (so "every other command is Bash" is false).
if grep -qE '^[[:space:]]+case "start":' loki-ts/src/cli.ts; then
    pass "loki-ts/src/cli.ts dispatches start"
else
    fail "cli.ts no longer dispatches start; update this guard"
fi

if echo "$para" | grep -qiE 'every other command (remains|stays) on the bash'; then
    fail "paragraph still claims every other command stays on the Bash runtime"
else
    pass "paragraph does not claim every other command stays on Bash"
fi

if echo "$para" | grep -qiE 'read-only commands \('; then
    fail "paragraph still presents the Bun route as a read-only list"
else
    pass "paragraph does not present the Bun route as a read-only list"
fi

if echo "$para" | grep -q 'bin/loki' && echo "$para" | grep -q 'cli.ts'; then
    pass "paragraph points at bin/loki and cli.ts as the source of truth"
else
    fail "paragraph must name bin/loki and loki-ts/src/cli.ts as the routing source of truth"
fi

if echo "$para" | grep -q 'LOKI_LEGACY_BASH=1'; then
    pass "paragraph keeps the LOKI_LEGACY_BASH=1 rollback"
else
    fail "paragraph lost the LOKI_LEGACY_BASH=1 rollback"
fi

echo "Results: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
