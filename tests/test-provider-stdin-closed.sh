#!/usr/bin/env bash
# A-134c: provider calls that pass the prompt as an argument must not inherit stdin.
# A verbose run (LOKI_VERBOSE=1) with a non-TTY stdin that never closes must complete;
# the stub claude reads stdin on a real call and would hang if stdin were inherited.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/bin"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ ($2)}"; }

cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
echo "STUB_READING_STDIN" >> "${STUB_MARK:?}"
cat > /dev/null
echo "STUB_STDIN_CLOSED" >> "$STUB_MARK"
echo "stub provider failed"
exit 1
STUB
chmod +x "$T/bin/claude"

FIX="$T/fix"
mkdir -p "$FIX/.loki"
git -C "$FIX" init -q
git -C "$FIX" config user.email t@example.invalid
git -C "$FIX" config user.name t
echo hi > "$FIX/a.txt"
git -C "$FIX" add a.txt
git -C "$FIX" commit -q -m init
echo "fix it" > "$FIX/.loki/quick-prd-1.md"

mkfifo "$T/fifo"
sleep 600 > "$T/fifo" &
SLEEP_PID=$!
exec 4< "$T/fifo"
cleanup() {
    exec 4<&-
    kill "$SLEEP_PID" 2>/dev/null
    wait "$SLEEP_PID" 2>/dev/null
    loki_run_tmp_cleanup
}
trap cleanup EXIT
( cd "$FIX" && env HOME="$T/home" PATH="$T/bin:$PATH" STUB_MARK="$T/mark" LOKI_VERBOSE=1 LOKI_NO_BROWSER=1 \
    LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_MAX_RETRIES=1 LOKI_MAX_ITERATIONS=1 LOKI_BASE_WAIT=1 LOKI_MAX_WAIT=1 \
    timeout -k 5 60 bash "$REPO_ROOT/autonomy/run.sh" "$FIX/.loki/quick-prd-1.md" \
    <&4 > "$T/out" 2> "$T/err" )
RC=$?
echo "run.sh rc=$RC"
[ "$RC" -ne 124 ] && [ "$RC" -ne 137 ] && ok "verbose run with never-closing stdin completed" || bad "verbose run hung (stdin inherited)"
grep -q STUB_READING_STDIN "$T/mark" 2>/dev/null && ok "fixture: stub provider was invoked" || bad "fixture: stub provider never invoked"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
