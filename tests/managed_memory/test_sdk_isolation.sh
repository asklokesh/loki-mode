#!/usr/bin/env bash
# tests/managed_memory/test_sdk_isolation.sh
# v6.83.0 Phase 1: enforce that the anthropic SDK is imported from ONE place.
#
# Rationale: Phase 1 must keep blast-radius small. memory/managed_memory/ is
# the only package permitted to `import anthropic`. If this test fails after
# future work, decide deliberately whether to extend the allowlist or extract
# a shim.

set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1

echo "Scanning for 'import anthropic' outside memory/managed_memory/ ..."

# Only scan code directories listed in the spec.
DIRS=(autonomy providers mcp dashboard)
offenders=()

for d in "${DIRS[@]}"; do
    if [ ! -d "$d" ]; then
        continue
    fi
    # grep -r with --include so it's bounded to source files. Match either
    # 'import anthropic' or 'from anthropic' at the start of a line.
    while IFS= read -r hit; do
        [ -n "$hit" ] && offenders+=("$hit")
    done < <(grep -RnE '^(import|from) anthropic' \
        --include='*.py' --include='*.sh' "$d" 2>/dev/null || true)
done

# Also assert the expected allowlist file DOES import anthropic. If it
# doesn't, something is wrong with the code under test.
if ! grep -qE '^\s*import anthropic' memory/managed_memory/client.py; then
    echo "FAIL: memory/managed_memory/client.py does not import anthropic -- unexpected"
    exit 1
fi

if [ "${#offenders[@]}" -ne 0 ]; then
    echo "FAIL: SDK isolation invariant broken. Offenders:"
    for h in "${offenders[@]}"; do echo "  $h"; done
    exit 1
fi

echo "PASS: anthropic SDK is imported only from memory/managed_memory/"
exit 0
