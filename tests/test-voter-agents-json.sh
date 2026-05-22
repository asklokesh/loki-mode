#!/usr/bin/env bash
# tests/test-voter-agents-json.sh -- Phase C (v7.5.20) regression test.
#
# Verifies autonomy/lib/voter-agents.sh:
#   - loki_voter_agents_json emits valid JSON with exactly 3 top-level keys
#   - models are pinned per architect: opus for requirements-verifier,
#     sonnet for test-auditor and convergence-voter
#   - loki_finding_schema_path echoes a path containing "finding-schema.json"
#   - loki_council_dispatch_agents returns 1 cleanly when --agents missing
#     from cached help output (fallback path)
#   - loki_council_dispatch_agents returns 1 cleanly when help mentions both
#     flags but no claude binary is on PATH (avoids invoking real claude)

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/voter-agents.sh"
FLAGS_HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

# ---------- Static checks ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "helper parses with bash -n"
else
    bad "helper failed bash -n"
fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S error "$HELPER" >/dev/null 2>&1; then
        ok "helper shellcheck -S error clean"
    else
        bad "helper shellcheck -S error reported issues"
    fi
else
    ok "SKIP: shellcheck not on PATH"
fi

# Source the helper (and the claude-flags dependency).
# shellcheck disable=SC1090
. "$FLAGS_HELPER"
# shellcheck disable=SC1090
. "$HELPER"

# ---------- loki_voter_agents_json ----------
# Missing required env -> empty object.
v=$(LOKI_ITER="" LOKI_PRD_PATH="" loki_voter_agents_json)
if [ "$v" = "{}" ]; then
    ok "voter_agents_json: missing LOKI_ITER -> {}"
else
    bad "voter_agents_json: missing LOKI_ITER expected {}, got [$v]"
fi

# With required env: must be valid JSON with exactly 3 top-level keys.
json=$(LOKI_ITER=5 LOKI_PRD_PATH=/tmp/fake.prd loki_voter_agents_json)
key_count=$(_J="$json" python3 -c "import json, os; d=json.loads(os.environ['_J']); print(len(d) if isinstance(d, dict) else -1)" 2>/dev/null || echo "-1")
if [ "$key_count" = "3" ]; then
    ok "voter_agents_json: exactly 3 top-level keys"
else
    bad "voter_agents_json: expected 3 keys, got [$key_count]"
fi

# Must contain the three expected role keys.
for role in "requirements-verifier" "test-auditor" "convergence-voter"; do
    has=$(_J="$json" _R="$role" python3 -c "import json, os; d=json.loads(os.environ['_J']); print('1' if os.environ['_R'] in d else '0')" 2>/dev/null || echo "0")
    if [ "$has" = "1" ]; then
        ok "voter_agents_json: contains key $role"
    else
        bad "voter_agents_json: missing key $role"
    fi
done

# Model assertions per architect.
m=$(_J="$json" python3 -c "import json, os; print(json.loads(os.environ['_J'])['requirements-verifier'].get('model',''))" 2>/dev/null)
if [ "$m" = "opus" ]; then
    ok "voter_agents_json: requirements-verifier model=opus"
else
    bad "voter_agents_json: requirements-verifier model expected opus, got [$m]"
fi

m=$(_J="$json" python3 -c "import json, os; print(json.loads(os.environ['_J'])['test-auditor'].get('model',''))" 2>/dev/null)
if [ "$m" = "sonnet" ]; then
    ok "voter_agents_json: test-auditor model=sonnet"
else
    bad "voter_agents_json: test-auditor model expected sonnet, got [$m]"
fi

m=$(_J="$json" python3 -c "import json, os; print(json.loads(os.environ['_J'])['convergence-voter'].get('model',''))" 2>/dev/null)
if [ "$m" = "sonnet" ]; then
    ok "voter_agents_json: convergence-voter model=sonnet"
else
    bad "voter_agents_json: convergence-voter model expected sonnet, got [$m]"
fi

# ---------- loki_devils_advocate_json ----------
da_json=$(loki_devils_advocate_json "base voters all approved")
has_da=$(_J="$da_json" python3 -c "import json, os; d=json.loads(os.environ['_J']); print('1' if 'devils-advocate' in d and len(d)==1 else '0')" 2>/dev/null || echo "0")
if [ "$has_da" = "1" ]; then
    ok "devils_advocate_json: single-key object with devils-advocate"
else
    bad "devils_advocate_json: expected single devils-advocate key"
fi

# ---------- loki_finding_schema_path ----------
sp=$(loki_finding_schema_path || true)
case "$sp" in
    *finding-schema.json)
        ok "finding_schema_path: contains finding-schema.json"
        ;;
    *)
        bad "finding_schema_path: expected finding-schema.json suffix, got [$sp]"
        ;;
esac

# Path must be absolute.
case "$sp" in
    /*) ok "finding_schema_path: absolute path" ;;
    *)  bad "finding_schema_path: not absolute [$sp]" ;;
esac

# ---------- loki_council_dispatch_agents fallback paths ----------
TMPROOT=$(mktemp -d -t loki-voter-agents-XXXX)
mkdir -p "$TMPROOT/.loki/council/verdicts" "$TMPROOT/.loki/council/votes"
COUNCIL_STATE_DIR="$TMPROOT/.loki/council"
ITERATION_COUNT=7
export COUNCIL_STATE_DIR ITERATION_COUNT

# Case A: cached help LACKS --agents -> immediate return 1 (no claude call).
export __LOKI_CLAUDE_HELP_CACHE="  --effort  --json-schema  --max-budget-usd"
rc=0
loki_council_dispatch_agents 7 "" || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "dispatch_agents: --agents missing -> return 1 (fallback)"
else
    bad "dispatch_agents: expected 1 when --agents missing, got [$rc]"
fi

# Case B: cached help LACKS --json-schema -> return 1.
export __LOKI_CLAUDE_HELP_CACHE="  --agents  --effort"
rc=0
loki_council_dispatch_agents 7 "" || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "dispatch_agents: --json-schema missing -> return 1 (fallback)"
else
    bad "dispatch_agents: expected 1 when --json-schema missing, got [$rc]"
fi

# Case C: help mentions BOTH flags. We avoid invoking real claude by stubbing
# PATH so `command -v claude` returns false. The helper must still return 1
# cleanly (not crash, not hang).
export __LOKI_CLAUDE_HELP_CACHE="  --agents  --json-schema  --effort"
rc=0
PATH="$TMPROOT/empty-bin:/usr/bin:/bin" loki_council_dispatch_agents 7 "" || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "dispatch_agents: both flags supported but no claude binary -> return 1"
else
    bad "dispatch_agents: expected 1 when claude absent, got [$rc]"
fi

# Verify the helper did NOT leave a partial round file on the no-claude path.
if [ ! -f "$COUNCIL_STATE_DIR/votes/round-7.json" ]; then
    ok "dispatch_agents: no partial round file written on fallback"
else
    bad "dispatch_agents: should not write round file on fallback"
fi

unset __LOKI_CLAUDE_HELP_CACHE

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
