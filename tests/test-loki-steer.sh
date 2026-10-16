#!/usr/bin/env bash
# test-loki-steer.sh -- RUN-25 iter 22 (Wave D #3): `loki steer "<note>"` writes
# the operator directive to the file the running loop ACTUALLY reads
# (.loki/HUMAN_INPUT.md), replacing the dead .loki/steering.md hint the cockpit
# used to advertise (nothing read it -- a quiet lie to the operator). This test
# extracts the real cmd_steer from autonomy/loki and drives it, and asserts the
# cockpit hint no longer names the dead file.
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
COCKPIT="$SCRIPT_DIR/../autonomy/lib/cockpit-render.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$LOKI" ] || { echo "FATAL: autonomy/loki not found"; exit 2; }

# Extract cmd_steer (def to the closing brace at column 0).
FN="$(awk '/^cmd_steer\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$LOKI")"
[ -n "$FN" ] || { echo "FATAL: could not extract cmd_steer"; exit 2; }

run_steer() {
    # $1 = LOKI_DIR, rest = args. Stubs colors + emit_event. echo rc.
    local lokidir="$1"; shift
    bash -c '
        set -u
        GREEN=""; YELLOW=""; DIM=""; NC=""; BOLD=""; CYAN=""
        emit_event() { :; }
        LOKI_DIR="'"$lokidir"'"
        '"$FN"'
        cmd_steer "$@"
        echo "RC=$?"
    ' _ "$@"
}

# 1. writes the note to HUMAN_INPUT.md (the file the loop reads), NOT steering.md
D1="$(mktemp -d)"; mkdir -p "$D1/.loki"
run_steer "$D1/.loki" "focus on the auth flow" >/dev/null 2>&1
if [ -f "$D1/.loki/HUMAN_INPUT.md" ] && grep -q "focus on the auth flow" "$D1/.loki/HUMAN_INPUT.md"; then ok; else fail "steer note not written to HUMAN_INPUT.md"; fi
[ -f "$D1/.loki/steering.md" ] && fail "steer wrote the DEAD steering.md (nothing reads it)" || ok
rm -rf "$D1"

# 2. multiple steers accumulate (append, not overwrite)
D2="$(mktemp -d)"; mkdir -p "$D2/.loki"
run_steer "$D2/.loki" "first note" >/dev/null 2>&1
run_steer "$D2/.loki" "second note" >/dev/null 2>&1
if grep -q "first note" "$D2/.loki/HUMAN_INPUT.md" && grep -q "second note" "$D2/.loki/HUMAN_INPUT.md"; then ok; else fail "steer should append, not overwrite"; fi
rm -rf "$D2"

# 2b. each steer is a numbered revision with actor and source; rev counts
# pending headers plus already-archived revisions; actor/source are sanitized
D2B="$(mktemp -d)"; mkdir -p "$D2B/.loki"
LOKI_STEER_ACTOR="al ice;x" LOKI_STEER_SOURCE="https://github.com/o/r/issues/7#issuecomment-9" run_steer "$D2B/.loki" "one" >/dev/null 2>&1
run_steer "$D2B/.loki" "two" >/dev/null 2>&1
grep -q '^## Operator directive rev 1 (.*) actor=al-ice-x source=https://github.com/o/r/issues/7#issuecomment-9$' "$D2B/.loki/HUMAN_INPUT.md" && ok || fail "first steer header should be rev 1 with sanitized actor and source"
grep -q '^## Operator directive rev 2 (.*) actor=.* source=cli$' "$D2B/.loki/HUMAN_INPUT.md" && ok || fail "second steer header should be rev 2 source=cli"
rm -f "$D2B/.loki/HUMAN_INPUT.md"
printf '{"rev":1}\n{"rev":2}\n' > "$D2B/.loki/intent-revisions.jsonl"
run_steer "$D2B/.loki" "three" >/dev/null 2>&1
grep -q '^## Operator directive rev 3 ' "$D2B/.loki/HUMAN_INPUT.md" && ok || fail "steer after archive should continue at rev 3"
rm -rf "$D2B"

# 3. no .loki dir -> non-zero (nothing to steer)
D3="$(mktemp -d)"  # no .loki subdir
out="$(run_steer "$D3/.loki" "note" 2>&1)"
echo "$out" | grep -q "RC=0" && fail "steer with no .loki should return non-zero" || ok
rm -rf "$D3"

# 4. --help / no-arg prints usage naming HUMAN_INPUT.md (not steering.md)
help_out="$(run_steer "/tmp" --help 2>&1)"
echo "$help_out" | grep -q "HUMAN_INPUT.md" && ok || fail "steer help should name HUMAN_INPUT.md"
echo "$help_out" | grep -q "steering.md" && fail "steer help must not name the dead steering.md" || ok

# 5. the cockpit hint no longer advertises the dead steering.md
if [ -f "$COCKPIT" ]; then
    if grep -q "steering.md" "$COCKPIT"; then
        # allow it only inside a comment explaining the fix; a live echo is a fail
        if grep -E "^[[:space:]]*echo .*steering\.md" "$COCKPIT" >/dev/null; then
            fail "cockpit still prints the dead steering.md hint"
        else ok; fi
    else ok; fi
    grep -q "HUMAN_INPUT.md" "$COCKPIT" && ok || fail "cockpit hint should name HUMAN_INPUT.md"
fi

# 6. P12-15: chat /steer records source=chat and the chat user as actor
CHAT_SH="${CHAT_SH_OVERRIDE:-$SCRIPT_DIR/../autonomy/lib/chat.sh}"
D6="$(mktemp -d)"
cat > "$D6/loki" <<STUB
#!/usr/bin/env bash
printf 'src=%s actor=%s\n' "\${LOKI_STEER_SOURCE:-}" "\${LOKI_STEER_ACTOR:-}" > "$D6/seen"
STUB
chmod +x "$D6/loki"
USER=chatuser bash -c 'source "$1" 2>/dev/null; _chat_steer "$2" "go left"' _ "$CHAT_SH" "$D6/loki" >/dev/null 2>&1
if grep -q "^src=chat actor=chatuser$" "$D6/seen" 2>/dev/null; then ok; else fail "chat steer should export LOKI_STEER_SOURCE=chat and the user as actor (got: $(cat "$D6/seen" 2>/dev/null))"; fi
# both /steer call sites must route through the helper
[ "$(grep -c '_chat_steer "\$loki" "\$rest"' "$CHAT_SH")" -eq 2 ] && ok || fail "both chat /steer handlers should call _chat_steer"
rm -rf "$D6"

echo ""
echo "test-loki-steer: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
