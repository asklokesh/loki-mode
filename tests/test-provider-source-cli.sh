#!/usr/bin/env bash
# tests/test-provider-source-cli.sh -- UT2-13: verify provider_source="cli" in loki status --json
#
# Tests:
#   1. Fresh cli-provider file -> provider_source=cli, provider=codex
#   2. Stale cli-provider file (>24h) -> falls back to saved/env/default
#   3. No cli-provider file, env set -> provider_source=env
#   4. No cli-provider file, no env -> provider_source=default

set -euo pipefail

LOKI_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/loki"
PASS=0
FAIL=0

_pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
_fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

cleanup_tmp() {
    rm -rf /tmp/loki-ut2-13 2>/dev/null || true
}
trap cleanup_tmp EXIT

# ---------------------------------------------------------------------------
# Test 1: fresh cli-provider file -> provider_source=cli
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
FRESH_TS="$(date +%s)"
printf 'codex:%s\n' "$FRESH_TS" > /tmp/loki-ut2-13/.loki/state/cli-provider

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki unset LOKI_PROVIDER 2>/dev/null; \
      cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')=='cli', d; assert d.get('provider')=='codex', d" 2>/dev/null; then
    _pass "fresh cli-provider: provider_source=cli, provider=codex"
else
    _fail "fresh cli-provider: expected provider_source=cli provider=codex, got: $OUT"
fi

# ---------------------------------------------------------------------------
# Test 2: stale cli-provider (>24h) -> falls back, no saved/env -> default
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
STALE_TS=$(( $(date +%s) - 90000 ))
printf 'codex:%s\n' "$STALE_TS" > /tmp/loki-ut2-13/.loki/state/cli-provider

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source') != 'cli', d" 2>/dev/null; then
    _pass "stale cli-provider: does not report provider_source=cli"
else
    _fail "stale cli-provider: expected fallback away from cli, got: $OUT"
fi

# ---------------------------------------------------------------------------
# Test 3: no cli-provider file, LOKI_PROVIDER set -> env
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
# No cli-provider file written.

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki LOKI_PROVIDER=cline "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')=='env', d; assert d.get('provider')=='cline', d" 2>/dev/null; then
    _pass "no cli-provider, LOKI_PROVIDER=cline -> provider_source=env"
else
    _fail "no cli-provider, LOKI_PROVIDER=cline: expected env, got: $OUT"
fi

# ---------------------------------------------------------------------------
# Test 4: no cli-provider file, no LOKI_PROVIDER -> default
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')=='default', d; assert d.get('provider')=='claude', d" 2>/dev/null; then
    _pass "no cli-provider, no env -> provider_source=default, provider=claude"
else
    _fail "no cli-provider, no env: expected default/claude, got: $OUT"
fi

# ---------------------------------------------------------------------------
# Test 5: cli source wins over saved provider file
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
FRESH_TS="$(date +%s)"
printf 'codex:%s\n' "$FRESH_TS" > /tmp/loki-ut2-13/.loki/state/cli-provider
# Also write a saved provider -- cli should win.
printf 'aider\n' > /tmp/loki-ut2-13/.loki/state/provider

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')=='cli', d; assert d.get('provider')=='codex', d" 2>/dev/null; then
    _pass "cli wins over saved provider: provider_source=cli, provider=codex"
else
    _fail "cli vs saved: expected cli to win, got: $OUT"
fi

# ---------------------------------------------------------------------------
# v7.7.11 (council fix): invalid provider name in marker -> ignored
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
FRESH_TS="$(date +%s)"
printf 'xyz:%s:%s\n' "$FRESH_TS" "$$" > /tmp/loki-ut2-13/.loki/state/cli-provider

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')!='cli', d; assert d.get('provider')=='claude', d" 2>/dev/null; then
    _pass "invalid provider 'xyz' in marker: ignored, fallback to default/claude"
else
    _fail "invalid provider 'xyz': expected fallback, got: $OUT"
fi

# ---------------------------------------------------------------------------
# v7.7.11 (council fix): PID-aware format with dead PID -> ignored
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
FRESH_TS="$(date +%s)"
# Find a PID guaranteed not to exist (highest possible + 1 is safest).
DEAD_PID=999999
printf 'codex:%s:%s\n' "$FRESH_TS" "$DEAD_PID" > /tmp/loki-ut2-13/.loki/state/cli-provider

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')!='cli', d" 2>/dev/null; then
    _pass "PID-aware marker with dead PID 999999: ignored"
else
    _fail "PID-aware dead PID: expected ignore, got: $OUT"
fi

# ---------------------------------------------------------------------------
# v7.7.11 (council fix): PID-aware format with live PID (this shell) -> accepted
# ---------------------------------------------------------------------------
cleanup_tmp
mkdir -p /tmp/loki-ut2-13/.loki/state
FRESH_TS="$(date +%s)"
printf 'codex:%s:%s\n' "$FRESH_TS" "$$" > /tmp/loki-ut2-13/.loki/state/cli-provider

OUT=$(cd /tmp/loki-ut2-13 && LOKI_DIR=.loki "$LOKI_BIN" status --json 2>/dev/null || true)

if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('provider_source')=='cli', d; assert d.get('provider')=='codex', d" 2>/dev/null; then
    _pass "PID-aware marker with live PID $$: accepted as cli"
else
    _fail "PID-aware live PID: expected cli, got: $OUT"
fi

# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
