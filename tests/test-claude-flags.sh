#!/usr/bin/env bash
# tests/test-claude-flags.sh -- Phase B (v7.5.19) regression test for autonomy/lib/claude-flags.sh.
#
# Verifies:
# - loki_effort_for_tier maps RARV tiers to effort levels per spec
# - loki_effort_for_tier shifts up one notch when complexity=complex
# - loki_remaining_budget emits empty when LOKI_BUDGET_LIMIT unset/0
# - loki_remaining_budget computes correctly when budget.json exists
# - loki_remaining_budget emits empty when remaining <= 0 (never emits 0)
# - loki_fallback_for_primary maps opus->sonnet always; sonnet->haiku only with LOKI_ALLOW_HAIKU=true
# - loki_claude_flag_supported caches the help output and returns 0/1 honestly

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

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

# Source the helper for the function tests.
# shellcheck disable=SC1090
. "$HELPER"

# ---------- loki_effort_for_tier ----------
v=$(loki_effort_for_tier planning); [ "$v" = "xhigh" ] && ok "effort planning=xhigh" || bad "effort planning got [$v]"
v=$(loki_effort_for_tier development); [ "$v" = "high" ] && ok "effort development=high" || bad "effort development got [$v]"
v=$(loki_effort_for_tier fast); [ "$v" = "medium" ] && ok "effort fast=medium" || bad "effort fast got [$v]"

# Capability alias inputs
v=$(loki_effort_for_tier best); [ "$v" = "xhigh" ] && ok "effort best=xhigh" || bad "effort best got [$v]"
v=$(loki_effort_for_tier balanced); [ "$v" = "high" ] && ok "effort balanced=high" || bad "effort balanced got [$v]"
v=$(loki_effort_for_tier cheap); [ "$v" = "low" ] && ok "effort cheap=low" || bad "effort cheap got [$v]"

# Unknown tier defaults to high
v=$(loki_effort_for_tier mystery); [ "$v" = "high" ] && ok "effort unknown=high (default)" || bad "effort unknown got [$v]"

# Complexity=complex shifts one notch up
v=$(loki_effort_for_tier development complex); [ "$v" = "xhigh" ] && ok "effort development+complex=xhigh" || bad "effort development+complex got [$v]"
v=$(loki_effort_for_tier fast complex); [ "$v" = "high" ] && ok "effort fast+complex=high" || bad "effort fast+complex got [$v]"
v=$(loki_effort_for_tier cheap complex); [ "$v" = "medium" ] && ok "effort cheap+complex=medium" || bad "effort cheap+complex got [$v]"
v=$(loki_effort_for_tier planning complex); [ "$v" = "xhigh" ] && ok "effort planning+complex=xhigh (no auto-max)" || bad "effort planning+complex got [$v]"

# ---------- loki_remaining_budget ----------
TMPROOT=$(mktemp -d -t loki-claude-flags-XXXX)
mkdir -p "$TMPROOT/.loki/metrics"

# Empty LOKI_BUDGET_LIMIT -> empty output
v=$(LOKI_BUDGET_LIMIT="" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: unset limit -> empty" || bad "remaining_budget unset got [$v]"

# Zero LOKI_BUDGET_LIMIT -> empty
v=$(LOKI_BUDGET_LIMIT="0" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: limit=0 -> empty" || bad "remaining_budget limit=0 got [$v]"

v=$(LOKI_BUDGET_LIMIT="0.00" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: limit=0.00 -> empty" || bad "remaining_budget limit=0.00 got [$v]"

# Limit + no budget.json -> emit full limit (no spend recorded)
v=$(LOKI_BUDGET_LIMIT="50" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ "$v" = "50.00" ] && ok "remaining_budget: limit=50, no spend -> 50.00" || bad "remaining_budget no spend got [$v]"

# Limit + budget.json with spend -> emit difference
python3 -c "import json; open('$TMPROOT/.loki/metrics/budget.json','w').write(json.dumps({'limit': 50, 'budget_limit': 50, 'budget_used': 12.34, 'exceeded': False}))"
v=$(LOKI_BUDGET_LIMIT="50" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ "$v" = "37.66" ] && ok "remaining_budget: 50 - 12.34 = 37.66" || bad "remaining_budget got [$v]"

# Spend exceeds limit -> emit empty (never emit 0 or negative)
python3 -c "import json; open('$TMPROOT/.loki/metrics/budget.json','w').write(json.dumps({'limit': 50, 'budget_limit': 50, 'budget_used': 60.00, 'exceeded': True}))"
v=$(LOKI_BUDGET_LIMIT="50" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: overspent -> empty (no 0 or negative)" || bad "remaining_budget overspent got [$v]"

# ---------- loki_fallback_for_primary ----------
v=$(loki_fallback_for_primary opus); [ "$v" = "sonnet" ] && ok "fallback opus -> sonnet" || bad "fallback opus got [$v]"

# sonnet -> haiku ONLY when LOKI_ALLOW_HAIKU=true
v=$(LOKI_ALLOW_HAIKU=false loki_fallback_for_primary sonnet)
[ -z "$v" ] && ok "fallback sonnet (no haiku) -> empty" || bad "fallback sonnet no-haiku got [$v]"

v=$(LOKI_ALLOW_HAIKU=true loki_fallback_for_primary sonnet)
[ "$v" = "haiku" ] && ok "fallback sonnet (allow-haiku) -> haiku" || bad "fallback sonnet allow-haiku got [$v]"

v=$(LOKI_ALLOW_HAIKU=true loki_fallback_for_primary haiku)
[ -z "$v" ] && ok "fallback haiku -> empty (no further fallback)" || bad "fallback haiku got [$v]"

v=$(loki_fallback_for_primary claude-opus-4-7)
[ -z "$v" ] && ok "fallback dated id -> empty (no auto-fallback)" || bad "fallback dated got [$v]"

# ---------- Phase E: --exclude-dynamic-system-prompt-sections via auto-flags ----------
# Source the provider helper so we can call _loki_build_claude_auto_flags.
# shellcheck disable=SC1090
. "$REPO_ROOT/providers/claude.sh" 2>/dev/null

# Fake claude --help text to control flag detection
export __LOKI_CLAUDE_HELP_CACHE="  --exclude-dynamic-system-prompt-sections  Move per-machine sections"
_loki_build_claude_auto_flags "development" "standard" "opus"
joined="${_LOKI_CLAUDE_AUTO_FLAGS[*]}"
if [[ "$joined" == *"--exclude-dynamic-system-prompt-sections"* ]]; then
    ok "Phase E: flag included when supported (default on)"
else
    bad "Phase E: flag missing when supported, got [$joined]"
fi

# Suppress with LOKI_DYNAMIC_PROMPT_SECTIONS=keep
LOKI_DYNAMIC_PROMPT_SECTIONS=keep _loki_build_claude_auto_flags "development" "standard" "opus"
joined="${_LOKI_CLAUDE_AUTO_FLAGS[*]}"
if [[ "$joined" != *"--exclude-dynamic-system-prompt-sections"* ]]; then
    ok "Phase E: flag suppressed when LOKI_DYNAMIC_PROMPT_SECTIONS=keep"
else
    bad "Phase E: flag should be suppressed, got [$joined]"
fi

# Omit when CLI lacks support
export __LOKI_CLAUDE_HELP_CACHE="  --effort"
_loki_build_claude_auto_flags "development" "standard" "opus"
joined="${_LOKI_CLAUDE_AUTO_FLAGS[*]}"
if [[ "$joined" != *"--exclude-dynamic-system-prompt-sections"* ]]; then
    ok "Phase E: flag omitted when CLI lacks support"
else
    bad "Phase E: flag should be omitted when unsupported, got [$joined]"
fi
unset __LOKI_CLAUDE_HELP_CACHE

# ---------- loki_claude_flag_supported ----------
if command -v claude >/dev/null 2>&1; then
    if loki_claude_flag_supported "--effort"; then
        ok "flag_supported --effort detected"
    else
        bad "flag_supported --effort NOT detected (Claude CLI version may be old)"
    fi
    if loki_claude_flag_supported "--definitely-not-a-real-flag-xyz123"; then
        bad "flag_supported false positive on fake flag"
    else
        ok "flag_supported correctly rejects unknown flag"
    fi
else
    ok "SKIP: claude not on PATH; flag_supported behavior untested"
fi

# ---------- S2: loki_lean_child_flags / loki_child_ledger_append ----------
LEAN_HELP="  --bare  --setting-sources  --strict-mcp-config  --mcp-config  --disable-slash-commands  --tools"
LEAN_TMP=$(mktemp -d)
TMPROOT="$LEAN_TMP"
REAL_HOME="$HOME"
export HOME="$LEAN_TMP/home"
mkdir -p "$HOME/.claude" "$LEAN_TMP/proj"
export __LOKI_CLAUDE_HELP_CACHE="$LEAN_HELP"
unset LOKI_LEAN_CHILDREN LOKI_BARE_SUBCALLS ANTHROPIC_API_KEY
cd "$LEAN_TMP/proj" || exit 1

has_line() { printf '%s\n' "$1" | grep -qxF -- "$2"; }

# OAuth-only host: never --bare, lean fallback flags present
out=$(loki_lean_child_flags grill)
if has_line "$out" "--bare"; then
    bad "S2: OAuth-only host got --bare"
elif has_line "$out" "--setting-sources" && has_line "$out" "project" \
    && has_line "$out" "--strict-mcp-config" && has_line "$out" "--disable-slash-commands" \
    && has_line "$out" '{"mcpServers":{}}'; then
    ok "S2: OAuth-only host gets lean fallback flags, no --bare"
else
    bad "S2: OAuth-only lean flags missing: [$out]"
fi

# API key host: --bare
out=$(ANTHROPIC_API_KEY=sk-test loki_lean_child_flags review)
if has_line "$out" "--bare" && ! has_line "$out" "--strict-mcp-config"; then
    ok "S2: API key host gets --bare"
else
    bad "S2: API key host flags wrong: [$out]"
fi

# whitespace-only key does not count
out=$(ANTHROPIC_API_KEY="   " loki_lean_child_flags review)
has_line "$out" "--bare" && bad "S2: blank key got --bare" || ok "S2: blank API key does not enable --bare"

# apiKeyHelper host: --bare
printf '{"apiKeyHelper": "echo k"}\n' > "$HOME/.claude/settings.json"
out=$(loki_lean_child_flags review)
has_line "$out" "--bare" && ok "S2: apiKeyHelper host gets --bare" || bad "S2: apiKeyHelper host no --bare: [$out]"
rm -f "$HOME/.claude/settings.json"

# text-only role: --tools followed by an empty-string line; tool role: no --tools
# (read line by line: command substitution would strip the trailing empty line)
lines=()
while IFS= read -r l; do lines+=("$l"); done < <(loki_lean_child_flags grill)
last=$(( ${#lines[@]} - 1 ))
if [ "${lines[$last]}" = "" ] && [ "${lines[$((last - 1))]}" = "--tools" ]; then
    ok "S2: text-only role gets --tools followed by empty-string line"
else
    bad "S2: text-only role --tools value wrong: [${lines[*]}]"
fi
out=$(loki_lean_child_flags implement)
has_line "$out" "--tools" && bad "S2: tool role got --tools" || ok "S2: tool role never gets --tools"

# unsupported flag dropped together with its value
export __LOKI_CLAUDE_HELP_CACHE="  --setting-sources --strict-mcp-config --disable-slash-commands"
out=$(loki_lean_child_flags grill)
if has_line "$out" "--tools" || has_line "$out" "--mcp-config" || has_line "$out" '{"mcpServers":{}}'; then
    bad "S2: unsupported flag or value leaked: [$out]"
else
    ok "S2: unsupported flags and their values are dropped"
fi
export __LOKI_CLAUDE_HELP_CACHE="$LEAN_HELP"

# opt-out
out=$(LOKI_LEAN_CHILDREN=0 loki_lean_child_flags grill)
[ -z "$out" ] && ok "S2: LOKI_LEAN_CHILDREN=0 prints nothing" || bad "S2: opt-out printed [$out]"

# ledger
loki_child_ledger_append grill '{"type":"result","total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40},"modelUsage":{"claude-sonnet-x":{}}}'
loki_child_ledger_append council '{"usage":{"input_tokens":1,"output_tokens":2}}'
loki_child_ledger_append broken 'not json'
bad_rc=$?
LEDGER="$LEAN_TMP/proj/.loki/metrics/child-sessions.jsonl"
if python3 -I - "$LEDGER" "$bad_rc" <<'PY'
import json, sys
lines = open(sys.argv[1]).read().splitlines()
assert len(lines) == 2, lines
a, b = map(json.loads, lines)
assert a["phase"] == "grill" and a["usd"] == 0.0123 and a["model"] == "claude-sonnet-x", a
assert (a["input_tokens"], a["output_tokens"], a["cache_creation_tokens"], a["cache_read_tokens"]) == (10, 20, 30, 40), a
assert isinstance(a["source"], str) and a["source"], a
assert b["phase"] == "council" and "usd" not in b and b["input_tokens"] == 1 and b["cache_read_tokens"] == 0, b
assert sys.argv[2] == "1"
PY
then ok "S2: ledger lines match S1 format; missing usd omitted; invalid json skipped"; else bad "S2: ledger format check failed"; fi

cd "$SCRIPT_DIR" || true
export HOME="$REAL_HOME"
unset __LOKI_CLAUDE_HELP_CACHE
rm -rf "$LEAN_TMP"
TMPROOT=""

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
