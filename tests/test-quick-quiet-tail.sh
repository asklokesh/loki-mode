#!/usr/bin/env bash
# A-134b: the quiet `loki quick` failure tail never dumps a long prompt line that merely
# contains "failed"; a non-TTY stdin that never closes does not hang the quiet run
# (TTY keypress resume is verified by inspection only); standalone
# autonomy/verify.sh prints an attestation line (UNCHECKED).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/bin"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ ($2)}"; }

# Stub provider: records its stdin on the --version probe, prints a long non-log line
# containing "failed", then fails.
cat > "$T/bin/claude" <<STUB
#!/usr/bin/env bash
case " \$* " in *" --help "*|*" --version "*) cat > /dev/null; echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
cat > /dev/null
printf 'RALPH prompt: %s failed\n' "\$(printf 'x%.0s' \$(seq 1 1500))"
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

# Never-closing, non-TTY stdin: the stub provider does `cat`, so any leaked pipe hangs.
mkfifo "$T/fifo"
sleep 600 > "$T/fifo" &
SLEEP_PID=$!
exec 4< "$T/fifo"
trap 'kill "$SLEEP_PID" 2>/dev/null; loki_run_tmp_cleanup' EXIT
( cd "$FIX" && env HOME="$T/home" PATH="$T/bin:$PATH" LOKI_NO_BROWSER=1 \
    LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_MAX_RETRIES=1 LOKI_MAX_ITERATIONS=1 LOKI_BASE_WAIT=1 LOKI_MAX_WAIT=1 timeout 60 bash "$REPO_ROOT/autonomy/run.sh" "$FIX/.loki/quick-prd-1.md" \
    <&4 > "$T/out" 2> "$T/err" )
RC=$?
echo "run.sh rc=$RC"
[ "$RC" -ne 124 ] || bad "run timed out (failure tail never printed)"
LONGEST="$(cat "$T/out" "$T/err" | awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }')"
if grep -q 'RALPH prompt' "$FIX/.loki/quick-run.log" 2>/dev/null; then
    ok "fixture: long failed line reached the inner log"
else
    bad "fixture: long line missing from inner log (stub never ran)"
fi
if grep -q 'RALPH prompt' "$T/out" "$T/err"; then bad "failure tail printed the long prompt line"; else ok "failure tail omits the long prompt line"; fi
[ "$LONGEST" -le 400 ] && ok "no printed line over 400 chars (longest $LONGEST)" || bad "printed line of $LONGEST chars"

# Deterministic note 2: run the wrapper's real tail lines (extracted from run.sh) against
# a log where the long prompt line is among the last matches (the live run above is
# padded by later WARN lines, so it cannot prove the anchor on its own).
mkdir -p "$T/tail"
{
    printf 'RALPH WIGGUM MODE ACTIVE. %s failed before\n' "$(printf 'y%.0s' $(seq 1 1500))"
    printf '\033[1;33m[WARN]\033[0m Will retry in 1s...\n'
} > "$T/tail/quick-run.log"
sed -n '/^            _qr=\$(grep/,/^            echo "\${_qr/p' "$REPO_ROOT/autonomy/run.sh" > "$T/tail/snippet.sh"
[ -s "$T/tail/snippet.sh" ] || bad "could not extract the failure-tail lines from run.sh"
TAIL="$(_qd="$T/tail" bash "$T/tail/snippet.sh" 2>&1)"
printf '%s\n' "$TAIL" | grep -q 'WIGGUM' && bad "synthetic log: prompt line printed" "${#TAIL} chars" || ok "synthetic log: prompt line not printed"
printf '%s\n' "$TAIL" | grep -q 'Will retry' && ok "synthetic log: the real [WARN] line is printed" || bad "synthetic log: [WARN] line lost" "$TAIL"

# Standalone verify.sh (no _deploy_receipt_verdict in scope) prints the attestation line.
PF="$T/pfix"
mkdir -p "$PF/.loki/state" "$PF/.loki/proofs/p1"
echo p1 > "$PF/.loki/state/last-proof-id.txt"
python3 - "$PF/.loki/proofs/p1/proof.json" "$REPO_ROOT/autonomy/lib" <<'PY'
import sys, json, hashlib
sys.path.insert(0, sys.argv[2])
import importlib.util
sp = importlib.util.spec_from_file_location('pv', sys.argv[2] + '/proof-verify.py')
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
p = {"facts": {}}
p["verification"] = {"hash": hashlib.sha256(m._canonical(p).encode()).hexdigest()}
json.dump(p, open(sys.argv[1], "w"))
PY
VOUT="$( cd "$PF" && bash -c '. "$1/autonomy/verify.sh"; _verify_receipt_digest' _ "$REPO_ROOT" 2>&1 )"
printf '%s\n' "$VOUT" | grep -q '^receipt_sha256: ' || bad "fixture receipt digest not printed" "$VOUT"
printf '%s\n' "$VOUT" | grep -qx 'attestation: UNCHECKED (run via loki verify)' \
    && ok "standalone verify.sh prints attestation: UNCHECKED" || bad "standalone verify.sh printed no attestation line" "$VOUT"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
