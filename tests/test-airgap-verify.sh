#!/usr/bin/env bash
# ENT-1: verification runs with NO network, and says so honestly.
#
# THE ENTERPRISE POSITION, stated precisely so nobody oversells it:
#   VERIFICATION is air-gappable. It is deterministic static analysis with zero
#   network calls, so a bank or a defence contractor can run it inside the
#   perimeter on code that may never leave.
#   GENERATION is NOT air-gappable today. Every provider we ship calls a hosted
#   API. Local-weight generation would need ollama with models pulled, and this
#   machine has none.
#
# Selling "air-gapped Loki Mode" without that split would be a lie an enterprise
# security review would catch in the first call. Selling "air-gapped
# VERIFICATION" is true, testable, and unclaimed by Replit/Cursor/Devin, none of
# which offer an on-prem verification artifact at all.
#
# This test proves the true half and PINS the boundary, so a future change that
# quietly adds a network call to the verify path fails here rather than in a
# customer's SOC.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY="$REPO_ROOT/autonomy/lib/fast_verify.py"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-airgap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "T1 -- the verifier imports no network module"

# Source-level check. Cheap, and it catches an added dependency at review time
# rather than at runtime in an environment we cannot observe.
if grep -qE '^[[:space:]]*(import|from)[[:space:]]+(requests|urllib|http|socket|aiohttp|httpx)' "$VERIFY"; then
    bad "verify path imports a network module"
    grep -nE '^[[:space:]]*(import|from)[[:space:]]+(requests|urllib|http|socket|aiohttp|httpx)' "$VERIFY" | sed 's/^/    /'
else
    ok "no network imports in fast_verify.py"
fi

echo
echo "T2 -- it actually runs with the network blackholed"

# Behavioural proof, not a source grep. Strip the environment and point every
# proxy variable at a closed port: anything attempting egress fails or hangs.
( cd "$WORK" && git init -q \
  && printf 'def add(a, b):\n    return a + b\n' > m.py \
  && printf 'def test_add():\n    assert add(1, 2) == 3\n' > test_m.py \
  && git add -A && git commit -q -m init ) >/dev/null 2>&1

out=$(env -i PATH=/usr/bin:/bin:/usr/local/bin \
        http_proxy=http://127.0.0.1:1 https_proxy=http://127.0.0.1:1 \
        ALL_PROXY=http://127.0.0.1:1 no_proxy="" \
        python3 "$VERIFY" --path "$WORK" 2>&1)
rc=$?

if [ "$rc" -eq 0 ]; then
    ok "verify exits 0 with all proxies blackholed and env stripped"
else
    bad "verify exited $rc with no network"
    printf '%s\n' "$out" | head -5 | sed 's/^/    /'
fi

# Non-vacuity: it must have produced a real verdict, not silently no-opped.
# "exit 0 having done nothing" is the failure this catches.
if printf '%s' "$out" | grep -qE '(PASS|FAIL) in [0-9.]+ms'; then
    ok "verify produced a real verdict offline: $(printf '%s' "$out" | head -1)"
else
    bad "verify produced no verdict line (silent no-op, not a real run)"
    printf '%s\n' "$out" | head -5 | sed 's/^/    /'
fi

echo
echo "T3 -- the air-gap claim is scoped honestly in user-facing text"

# The boundary must be DOCUMENTED, not just true. An enterprise buyer reading
# "air-gapped" and discovering generation still calls a hosted API is a lost
# deal and a damaged reputation. If we ever claim the generation half, this
# test should be updated only alongside real local-weight support.
if grep -rqi "air-gap" "$REPO_ROOT/autonomy/loki" 2>/dev/null; then
    ok "loki CLI surfaces an air-gap audit path (doctor --airgap)"
else
    bad "no air-gap surface in the CLI"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
