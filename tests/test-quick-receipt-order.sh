#!/usr/bin/env bash
# D48: runs under LOKI_ENGINE=legacy (the legacy quick receipt order); the default `loki quick` is the Loki 10 engine.
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
[ -z "${STUB_SKIP:-}" ] || { [ "$STUB_SKIP" = reason ] && _sk="'flaky'" || _sk=true; sed -i.bak "s/'sums', /'sums', { skip: $_sk }, /" sum.test.js && rm -f sum.test.js.bak; }
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
      env ${3:+"$3"} HOME="$T/home" PATH="$T/bin:$PATH" LOKI_NO_BROWSER=1 LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_ENGINE=legacy \
          "$REPO_ROOT/bin/loki" quick ${4:+"$4"} "fix the bug that makes the failing test in sum.test.js fail" \
          < /dev/null > "$2" 2> "$2.err" )
}

FIX="$T/quiet"
mk_fix "$FIX"
run_quick "$FIX" "$T/out.log"
QRC=$?
echo "loki quick rc=$QRC"
# A-118 backward compat: an honest run (3 unproven gates, unsigned) keeps rc 0.
[ "$QRC" -eq 0 ] && ok "honest quiet run with unproven gates keeps rc 0" || bad "honest quiet run rc=$QRC (want 0)"
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
# A-121b round 2: a JUNK attestation (body edited, SIGNING_UNAVAILABLE injected, hash recomputed)
# must be non-zero on legacy, with a fresh HOME and with the signing key present.
mkdir -p "$T/home2"
junk_case() { # junk_case <label> <python expr for attestation>
    python3 - "$PJ.orig" "$PJ" "$REPO_ROOT/autonomy/lib/proof-verify.py" "$2" <<'PYJ'
import sys, json, hashlib, importlib.util
sp = importlib.util.spec_from_file_location("pv", sys.argv[3]); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
d = json.load(open(sys.argv[1]))
d["not_proven"] = ["SIGNING_UNAVAILABLE"]
body = {k: v for k, v in d.items() if k != "verification"}
v = d.get("verification") or {}
v["hash"] = hashlib.sha256(m._canonical(body).encode("utf-8")).hexdigest()
v.pop("gpg_signature", None)
v["attestation"] = eval(sys.argv[4])
d["verification"] = v
json.dump(d, open(sys.argv[2], "w"))
PYJ
    local h rc out
    for h in "$T/home2" "$T/home"; do
        out="$( cd "$FIX" && HOME="$h" "$REPO_ROOT/bin/loki" verify < /dev/null 2>&1 )"; rc=$?
        { [ "$rc" -ne 0 ] && ! printf '%s\n' "$out" | grep -q '^VERDICT: VERIFIED'; } \
            && ok "junk attestation ($1) refused rc=$rc (HOME=${h##*/})" || bad "junk attestation ($1) passed" "rc=$rc HOME=${h##*/}"
    done
}
junk_case "abc.def" '"abc.def"'
junk_case "int 0" '0'
junk_case "two-part" '"aaaa.bbbb"'
junk_case "non-base64 header" '"!!!.e30.sig"'
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
VRC=$?
[ "$VRC" -eq 0 ] && ok "honest verbose run keeps rc 0" || bad "honest verbose run rc=$VRC (want 0)"
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

# A-121b: the token-shape block of _deploy_receipt_verdict runs with the verified repo as cwd;
# a committed base64.py or json.py must not shadow the stdlib and disable it. Run the block
# exactly as autonomy/loki does (python3 -E - from the repo dir) on a junk "x.y.z".
SHAPE_PY="$T/shape.py"
sed -n "/<<'PYSHAPE'/,/^PYSHAPE\$/p" "$REPO_ROOT/autonomy/loki" | sed '1d;$d' > "$SHAPE_PY"
[ -s "$SHAPE_PY" ] || bad "could not extract the PYSHAPE block from autonomy/loki"
for shadow in base64 json; do
    SD="$T/shadow-$shadow"; mkdir -p "$SD"
    printf '{"verification":{"attestation":"x.y.z"}}\n' > "$SD/proof.json"
    if [ "$shadow" = base64 ]; then
        printf '%s\n' "def urlsafe_b64decode(x): return b'{\"alg\":\"EdDSA\"}'" > "$SD/base64.py"
    else
        printf 'def load(f): return {"verification": {}}\n' > "$SD/json.py"
    fi
    ( cd "$SD" && python3 -E - proof.json < "$SHAPE_PY" >/dev/null 2>&1 ); src=$?
    [ "$src" -ne 0 ] && ok "shape check refuses junk with a committed $shadow.py (rc=$src)" \
        || bad "committed $shadow.py shadows the shape check" "rc=$src"
done
# A-118 / D47: a stub that skips the target test exits 3 in quiet and verbose mode, and the
# quick headline names what was weakened.
SFIX="$T/skipq"; mk_fix "$SFIX"
STUB_SKIP=1 run_quick "$SFIX" "$T/sout.log"; SRC=$?
[ "$SRC" -eq 3 ] && ok "quiet run that adds a skip exits 3" || bad "quiet skip run rc=$SRC (want 3)"
sed 's/\x1b\[[0-9;]*m//g' "$T/sout.log" | grep -qE '^Evidence Receipt: NOT VERIFIED \(tests weakened: skip added in sum\.test\.js' \
    && ok "quiet headline names the weakening" || bad "quiet headline does not name the weakening" "$(grep 'Evidence Receipt' "$T/sout.log")"
SVFIX="$T/skipv"; mk_fix "$SVFIX"
STUB_SKIP=reason run_quick "$SVFIX" "$T/svout.log" LOKI_VERBOSE=1
SVRC=$?
[ "$SVRC" -eq 3 ] && ok "verbose run that adds a skip exits 3" || bad "verbose skip run rc=$SVRC (want 3)"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
