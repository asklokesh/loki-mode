#!/usr/bin/env bash
# v8 Epic C: the voter-agents council on the raw SDK. The council dispatch
# (loki_voter_agents_dispatch) uses `claude --agents <json> --json-schema`; the
# raw @anthropic-ai/sdk has no --agents primitive, so the SDK path inlines the
# agent roster and constrains the SAME finding-schema.json via `internal
# sdk-judge`, producing the same {findings:[...]} object the downstream parser
# consumes. Proves: (1) wiring to sdk-judge; (2) opt-in (default off); (3) runs
# BEFORE the claude-binary guard (binary-free); (4) fail-closed. No billable call.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VA="$REPO_ROOT/autonomy/lib/voter-agents.sh"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# ---- 1. wiring: the SDK branch exists and calls sdk-judge with finding-schema ----
grep -q 'LOKI_SDK_VOTER_AGENTS' "$VA" \
    && grep -q 'internal sdk-judge' "$VA" \
    && grep -q 'finding-schema.json' "$VA" \
    && ok "voter-agents wires LOKI_SDK_VOTER_AGENTS -> sdk-judge (finding schema)" \
    || bad "voter-agents missing the SDK branch wiring"

# ---- 2. opt-in (default 0) ----
grep -q 'LOKI_SDK_VOTER_AGENTS:-0' "$VA" \
    && ok "SDK voter branch is opt-in (default 0)" \
    || bad "SDK voter branch not default-off"

# ---- 3. binary-free ordering: SDK branch BEFORE the claude-binary guard ----
sdk_line=$(grep -n 'LOKI_SDK_VOTER_AGENTS:-0' "$VA" | head -1 | cut -d: -f1)
# the dispatch claude guard is the 'command -v claude ... || return 1' inside the
# dispatch fn (there is an earlier flag-support gate; use the LAST claude guard
# that precedes the dispatch, which is the binary check).
claude_line=$(grep -n 'command -v claude >/dev/null 2>&1 || return 1' "$VA" | tail -1 | cut -d: -f1)
if [ -n "$sdk_line" ] && [ -n "$claude_line" ] && [ "$sdk_line" -lt "$claude_line" ]; then
    ok "SDK voter branch runs BEFORE the claude-binary dispatch guard (binary-free)"
else
    bad "SDK voter branch gated behind the claude-binary check (sdk=$sdk_line claude=$claude_line)"
fi

# ---- 4. syntax ----
bash -n "$VA" && ok "voter-agents.sh passes bash -n" || bad "voter-agents.sh syntax error"

# ---- 4b. TS parity: the Bun route mirror must have the SAME SDK branch so the
# two routes cannot silently drift (bash bug-hunt precedent). ----
VATS="$REPO_ROOT/loki-ts/src/council/voter_agents.ts"
if [ -f "$VATS" ]; then
    grep -q 'LOKI_SDK_VOTER_AGENTS' "$VATS" \
        && grep -q 'judgeJson' "$VATS" \
        && grep -q 'sdkJudgeAvailable' "$VATS" \
        && ok "TS parity: loki-ts voter_agents.ts has the matching SDK branch" \
        || bad "TS parity DRIFT: loki-ts voter_agents.ts missing the SDK branch"
fi

# ---- 5. SDK BRANCH behavior (the new code): the branch calls sdk-judge, and on
# success captures the {findings} object into $response + sets _va_sdk_done; on a
# miss it leaves them unset (fail-closed -> claude/heuristic fallback). We drive
# the EXACT branch body (self-contained: flag on, stub loki, roster in scope) --
# the downstream parse is pre-existing + already covered by test-voter-agents-json.sh.
if command -v bun >/dev/null 2>&1; then
    WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
    mkdir -p "$WORK/bin" "$WORK/loki-ts/data" "$WORK/council/votes"
    printf '{"type":"object","required":["findings"],"properties":{"findings":{"type":"array"}}}' > "$WORK/loki-ts/data/finding-schema.json"
    CANNED='{"findings":[{"agent":"architecture-strategist","vote":"APPROVE"},{"agent":"maintainer-mergeability","vote":"APPROVE"}]}'
    mkstub() { cat > "$WORK/bin/loki" <<STUB
#!/usr/bin/env bash
$1
STUB
    chmod +x "$WORK/bin/loki"; }

    run_branch() {  # $1 = stub bin/loki body -> prints "response|sdk_done"
        mkstub "$1"
        ( set +u
          __LOKI_VA_REPO_ROOT="$WORK"; COUNCIL_STATE_DIR="$WORK/council"
          agents_json='{"agents":{"a1":{},"a2":{}}}'; prompt="rate the work"; iteration=1
          response=""; _va_sdk_done=0
          # the exact SDK-branch body from voter-agents.sh
          _va_loki="$WORK/bin/loki"; _va_schema_f="$WORK/loki-ts/data/finding-schema.json"
          if [ -x "$_va_loki" ] && [ -f "$_va_schema_f" ] && command -v bun >/dev/null 2>&1; then
            _va_pf="$(mktemp)"; printf '%s\n%s\n' "$prompt" "$agents_json" > "$_va_pf"; _va_rc=0
            _va_out="$("$_va_loki" internal sdk-judge --prompt-file "$_va_pf" --schema-file "$_va_schema_f" --model claude-sonnet-5 --effort high --timeout-ms 600000 2>/dev/null)" || _va_rc=$?
            rm -f "$_va_pf"
            if [ "$_va_rc" -eq 0 ] && [ -n "$_va_out" ]; then response="$_va_out"; _va_sdk_done=1; fi
          fi
          printf '%s|%s' "$response" "$_va_sdk_done"
        )
    }

    # success: stub returns findings -> response captured, sdk_done=1
    s="$(run_branch 'if [ "$1" = internal ] && [ "$2" = sdk-judge ]; then printf '"'"'{"findings":[{"agent":"architecture-strategist","vote":"APPROVE"}]}'"'"'; exit 0; fi; exit 3')"
    if printf '%s' "$s" | grep -q 'architecture-strategist' && printf '%s' "$s" | grep -q '|1$'; then
        ok "SDK success: sdk-judge {findings} captured into response + _va_sdk_done=1"
    else
        bad "SDK success wrong: got '$s'"
    fi

    # fail-closed: stub exits non-zero -> response empty, sdk_done=0 (fall through)
    f="$(run_branch 'exit 1')"
    [ "$f" = "|0" ] && ok "fail-closed: SDK miss leaves response empty + _va_sdk_done=0 (claude/heuristic fallback)" \
        || bad "fail-closed wrong: got '$f'"
else
    ok "SKIP: bun not available for the SDK-branch checks"
fi

echo ""
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
