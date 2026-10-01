#!/usr/bin/env bash
# A-134: `loki quick` prints its Evidence Receipt only after the session commit, so
# the printed Head equals git HEAD and the printed diff sha equals proof.json; the
# printed receipt_sha256 equals what `loki verify` reports; default stdout is at most
# 15 lines; LOKI_VERBOSE=1 brings the setup chatter back. Stub provider, clean HOME,
# fixtures under the run-owned temp dir (every git call is `git -C "$FIX"`).
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

cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
chmod +x "$T/bin/claude"

mk_fix() { # mk_fix <dir>
    local d="$1"
    mkdir -p "$d"
    printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$d/package.json"
    printf 'function sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$d/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n" > "$d/sum.test.js"
    git -C "$d" init -q
    git -C "$d" config user.email t@example.invalid
    git -C "$d" config user.name t
    git -C "$d" add package.json sum.js sum.test.js
    git -C "$d" commit -q -m init
}
run_quick() { # run_quick <dir> <stdout-file> [extra env assignment] [loki quick flag]
    ( cd "$1" || exit 2
      env ${3:+"$3"} HOME="$T/home" PATH="$T/bin:$PATH" LOKI_NO_BROWSER=1 LOKI_SKIP_AUTH_PREFLIGHT=1 \
          "$REPO_ROOT/bin/loki" quick ${4:+"$4"} "fix the bug that makes the failing test in sum.test.js fail" \
          < /dev/null > "$2" 2> "$2.err" )
}

FIX="$T/quiet"
mk_fix "$FIX"
run_quick "$FIX" "$T/out.log"
echo "loki quick rc=$?"
OUT="$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log")"

HEAD_SHA="$(git -C "$FIX" rev-parse HEAD)"
PJ="$(ls "$FIX"/.loki/proofs/*/proof.json 2>/dev/null | head -1)"
[ -f "$PJ" ] || bad "no proof.json written"
PRINTED_HEAD="$(printf '%s\n' "$OUT" | sed -n 's/^Head sha: \([0-9a-f]\{40\}\).*$/\1/p' | head -1)"
PRINTED_DIFF="$(printf '%s\n' "$OUT" | sed -n 's/^.*Diff sha256: \([0-9a-f]\{64\}\).*$/\1/p' | head -1)"
PRINTED_DIGEST="$(printf '%s\n' "$OUT" | sed -n 's/^receipt_sha256: \([0-9a-f]\{64\}\)$/\1/p' | head -1)"
PROOF_DIFF="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['facts']['git']['diff_sha256'])" "$PJ" 2>/dev/null)"

[ -n "$PRINTED_HEAD" ] && [ "$PRINTED_HEAD" = "$HEAD_SHA" ] \
    && ok "printed Head equals git rev-parse HEAD" || bad "printed Head differs from HEAD" "printed=${PRINTED_HEAD:-none} head=$HEAD_SHA"
[ -n "$PRINTED_DIFF" ] && [ "$PRINTED_DIFF" = "$PROOF_DIFF" ] \
    && ok "printed diff sha256 equals proof.json" || bad "printed diff sha256 differs from proof.json" "printed=${PRINTED_DIFF:-none} proof=${PROOF_DIFF:-none}"

VOUT="$( cd "$FIX" && HOME="$T/home" "$REPO_ROOT/bin/loki" verify < /dev/null 2>&1 )"
VERIFIED_DIGEST="$(printf '%s\n' "$VOUT" | sed -n 's/^receipt_sha256: \([0-9a-f]\{64\}\)$/\1/p' | head -1)"
[ -n "$PRINTED_DIGEST" ] && [ "$PRINTED_DIGEST" = "$VERIFIED_DIGEST" ] \
    && ok "loki verify reports the printed receipt_sha256" || bad "digest mismatch" "printed=${PRINTED_DIGEST:-none} verify=${VERIFIED_DIGEST:-none}"

# Count stdout plus stderr, the way scripts/first-run-gate.sh does (2>&1).
SIGNED="$(python3 -c "import json,sys; v=json.load(open(sys.argv[1])).get('verification') or {}; print('yes' if v.get('gpg_signature') or v.get('attestation') else 'no')" "$PJ" 2>/dev/null)"
if [ "$SIGNED" = yes ]; then
    printf '%s\n' "$VOUT" | grep -q '^attestation: VERIFIED$' \
        && ok "loki verify reports attestation: VERIFIED" || bad "no attestation: VERIFIED line" "$(printf '%s\n' "$VOUT" | grep attestation)"
fi

# D47 / A-121b: a receipt with verification.attestation (and gpg_signature) stripped is
# UNSIGNED; the hash excludes `verification`, so it still recomputes. loki verify must
# refuse it unless --allow-unsigned (or LOKI_VERIFY_ALLOW_UNSIGNED=1) is given.
cp "$PJ" "$PJ.orig"
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); v=d.setdefault('verification', {}); v.pop('attestation', None); v.pop('gpg_signature', None); json.dump(d, open(p,'w'))" "$PJ"
UOUT="$( cd "$FIX" && HOME="$T/home" "$REPO_ROOT/bin/loki" verify < /dev/null 2>&1 )"; URC=$?
[ "$URC" -ne 0 ] && printf '%s\n' "$UOUT" | grep -q 'attestation: UNSIGNED, integrity not attested; refusing' \
    && ok "stripped receipt: verify refuses (rc=$URC)" || bad "stripped receipt not refused" "rc=$URC"
AOUT="$( cd "$FIX" && HOME="$T/home" "$REPO_ROOT/bin/loki" verify --allow-unsigned < /dev/null 2>&1 )"; ARC=$?
[ "$ARC" -eq 0 ] && printf '%s\n' "$AOUT" | grep -q 'accepted by --allow-unsigned' \
    && ok "stripped receipt: --allow-unsigned passes with the explicit line" || bad "--allow-unsigned did not pass" "rc=$ARC"
cp "$PJ.orig" "$PJ"

# Tamper: edit proof.json, verify must exit non-zero, say BLOCKED and TAMPERED, and
# evidence.json must not record VERIFIED.
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['iterations']=999; json.dump(d, open(p,'w'))" "$PJ"
TOUT="$( cd "$FIX" && HOME="$T/home" "$REPO_ROOT/bin/loki" verify < /dev/null 2>&1 )"
TRC=$?
EVV="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['verdict'])" "$FIX/.loki/verify/evidence.json" 2>/dev/null)"
{ [ "$TRC" -ne 0 ] && printf '%s\n' "$TOUT" | grep -q '^VERDICT: BLOCKED' && printf '%s\n' "$TOUT" | grep -q 'TAMPERED' && [ "$EVV" = BLOCKED ]; } \
    && ok "tampered receipt: non-zero exit, BLOCKED/TAMPERED, evidence.json BLOCKED" \
    || bad "tampered receipt not blocked everywhere" "rc=$TRC evidence=${EVV:-none}"

LINES="$(cat "$T/out.log" "$T/out.log.err" | wc -l | tr -d ' ')"
[ "$LINES" -le 15 ] && ok "default output is $LINES lines (max 15)" || bad "default output is $LINES lines (max 15)"
if [ "$LINES" -gt 15 ]; then echo "--- stdout ($T/out.log)"; cat "$T/out.log"; echo "--- stderr ($T/out.log.err)"; cat "$T/out.log.err"; echo "--- end"; fi
printf '%s\n' "$OUT" | grep -q '^\[INFO\]' && bad "log_info chatter printed by default" || ok "no [INFO] chatter by default"

VFIX="$T/verbose"
mk_fix "$VFIX"
run_quick "$VFIX" "$T/vout.log" LOKI_VERBOSE=1
VLINES="$(wc -l < "$T/vout.log" | tr -d ' ')"
if grep -q '\[INFO\]' "$T/vout.log" && [ "$VLINES" -gt 15 ]; then ok "LOKI_VERBOSE=1 restores the chatter ($VLINES lines)"; else bad "LOKI_VERBOSE=1 did not restore the chatter" "lines=$VLINES"; fi

# B3: the quiet headline line carries the unsigned and not-proven facts.
if [ "$SIGNED" = no ]; then
    printf '%s\n' "$OUT" | grep -E '^Evidence Receipt: .*unsigned' >/dev/null \
        && ok "quiet headline says unsigned" || bad "quiet headline does not say unsigned"
else
    printf '%s\n' "$OUT" | grep -E '^Evidence Receipt: .*unsigned' >/dev/null \
        && bad "signed receipt reported as unsigned" || ok "signed receipt is not labelled unsigned"
fi
printf '%s\n' "$OUT" | grep -E '^Evidence Receipt: .*[0-9]+ not proven' >/dev/null \
    && ok "quiet headline carries the not-proven count" || bad "quiet headline has no not-proven count"

# B1: --verbose is a flag, not task text, and restores the chatter.
GFIX="$T/flag"
mk_fix "$GFIX"
run_quick "$GFIX" "$T/gout.log" "" --verbose
grep -q '\[INFO\]' "$T/gout.log" && ok "--verbose restores the [INFO] lines" || bad "--verbose stayed quiet"
grep -q 'Task:.*--verbose' "$T/gout.log" && bad "--verbose leaked into the task text" || ok "task text has no --verbose"
grep -rq -- '--verbose' "$GFIX/.loki"/quick-prd-*.md && bad "--verbose leaked into the quick PRD" || ok "quick PRD has no --verbose"

# Ordering: the verbose run prints the markdown receipt table; its Head sha must be the
# commit Loki made, not the pre-commit base (the A-134 defect).
VHEAD="$(git -C "$VFIX" rev-parse HEAD)"
VTABLE_HEAD="$(sed 's/\x1b\[[0-9;]*m//g' "$T/vout.log" | sed -n 's/^| Head sha | `\([0-9a-f]\{40\}\)` |$/\1/p' | head -1)"
[ -n "$VTABLE_HEAD" ] && [ "$VTABLE_HEAD" = "$VHEAD" ] \
    && ok "verbose receipt table Head equals HEAD" || bad "verbose receipt table Head differs from HEAD" "table=${VTABLE_HEAD:-none} head=$VHEAD"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
