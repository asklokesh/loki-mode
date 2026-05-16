#!/usr/bin/env bash
# Test: loki pick - retro-pixel provider picker (v7.6.0, LAP-parity)
# Unit test -- exercises pick.py in non-interactive modes (--list, --json)
# plus checks the cmd_pick CLI dispatch wire-up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PICK="$ROOT/autonomy/pick.py"
LOKI_CLI="$ROOT/autonomy/loki"

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. pick.py parses as Python
if python3 -c "import ast; ast.parse(open('$PICK').read())" 2>/dev/null; then
    pass "pick.py parses as Python"
else
    fail "pick.py has syntax errors"
fi

# 2. --list emits all 9 entries (5 providers + 4 meta)
list_out=$(python3 "$PICK" --list 2>&1)
count=$(echo "$list_out" | grep -cE '^[[:space:]]+[0-9]+[[:space:]]+[a-z]+[[:space:]]+tier-' || true)
if [[ "$count" -eq 9 ]]; then
    pass "--list emits 9 entries"
else
    fail "--list emitted $count entries (expected 9)"
fi

# 3. Providers-only mode trims to 5
po_out=$(python3 "$PICK" --list --providers-only 2>&1)
po_count=$(echo "$po_out" | grep -cE '^[[:space:]]+[0-9]+[[:space:]]+[a-z]+[[:space:]]+tier-' || true)
if [[ "$po_count" -eq 5 ]]; then
    pass "--providers-only trims to 5 entries"
else
    fail "--providers-only emitted $po_count entries (expected 5)"
fi

# 4. --json output validates as JSON and contains expected schema
json_out=$(python3 "$PICK" --json 2>&1)
if echo "$json_out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['schema']=='loki.pick/v1'; assert len(d['entries'])==9" 2>/dev/null; then
    pass "--json produces valid schema loki.pick/v1 with 9 entries"
else
    fail "--json failed schema validation"
    echo "$json_out" | head -5 | sed 's/^/    /'
fi

# 5. Each provider entry has expected fields
for required in name tier tagline env_var binary binary_present credential_present command category; do
    if echo "$json_out" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for e in d['entries']:
    assert '$required' in e, '$required missing'
" 2>/dev/null; then
        pass "--json entry contains field '$required'"
    else
        fail "--json entry missing field '$required'"
    fi
done

# 6. Each tier (1/2/3) is represented across the providers
for tier in 1 2 3; do
    if echo "$json_out" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert any(e['tier']==$tier and e['category']=='provider' for e in d['entries'])
" 2>/dev/null; then
        pass "tier-$tier provider present"
    else
        fail "tier-$tier provider missing"
    fi
done

# 7. cmd_pick wired into the loki CLI dispatch
if grep -qE '^[[:space:]]+pick\)' "$LOKI_CLI" && grep -q '^cmd_pick()' "$LOKI_CLI"; then
    pass "cmd_pick dispatch + function defined in autonomy/loki"
else
    fail "cmd_pick wire-up missing"
fi

# 8. cmd_pick guards python3 availability
if grep -A 12 '^cmd_pick()' "$LOKI_CLI" | grep -q 'command -v python3'; then
    pass "cmd_pick checks python3 availability"
else
    fail "cmd_pick missing python3 guard"
fi

# 9. Plain-list mode auto-engages when stdin is not a TTY (this script's case).
auto_out=$(echo "" | python3 "$PICK" 2>&1)
if echo "$auto_out" | grep -qE 'tier-[123]'; then
    pass "non-TTY auto-fallback to plain list"
else
    fail "non-TTY mode did not fall back to plain list"
fi

# 10. The five canonical providers are all present by name
all_names=$(echo "$json_out" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(' '.join(e['name'] for e in d['entries'] if e['category']=='provider'))
" 2>/dev/null || true)
expected=("claude" "cline" "codex" "gemini" "aider")
missing=""
for n in "${expected[@]}"; do
    case " $all_names " in
        *" $n "*) : ;;
        *) missing="$missing $n" ;;
    esac
done
if [[ -z "$missing" ]]; then
    pass "all 5 canonical providers present (claude, cline, codex, gemini, aider)"
else
    fail "missing providers:$missing"
fi

# 11. No emojis in output (CLAUDE.md mandate)
if echo "$list_out$json_out" | python3 -c "
import sys, unicodedata
text = sys.stdin.read()
# Check for any character in emoji-related Unicode blocks.
for ch in text:
    cp = ord(ch)
    if 0x1F300 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF:
        sys.exit(1)
sys.exit(0)
" 2>/dev/null; then
    pass "no emojis in picker output"
else
    fail "picker output contains an emoji"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
