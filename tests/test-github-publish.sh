#!/usr/bin/env bash
#===============================================================================
# loki github publish: receipt-stamped GitHub export (TEN-DEPLOY-07)
#
# gh and git are PATH shims that record argv and never reach the network. The
# git shim passes through to real git so a local bare repo serves as origin.
# Receipts come from the REAL generator (same builder as
# tests/test-deploy-receipt-gate.sh) so hash/signature verdicts are genuine.
# Positive control: the VERIFIED case must reach success, so a publish that
# always refuses cannot pass.
#===============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"
GENERATOR="$PROJECT_DIR/autonomy/lib/proof-generator.py"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; [ -n "${2:-}" ] && echo "        $2"; }

command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 missing"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "  SKIPPED: git missing"; exit 0; }
python3 -c "import cryptography" >/dev/null 2>&1 || { echo "  SKIPPED: cryptography missing (VERIFIED fixture unavailable)"; exit 0; }
REAL_GIT="$(command -v git)"

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-ghpub.XXXXXX")"
export HOME="$WORKROOT/home"; mkdir -p "$HOME"
unset LOKI_RECEIPT_SIGNING_KEY LOKI_RECEIPT_SIGNING_KEY_FILE
trap 'rm -rf "$WORKROOT" 2>/dev/null || true' EXIT INT TERM

FAKE_BIN="$WORKROOT/fake-bin"; mkdir -p "$FAKE_BIN"
GH_LOG="$WORKROOT/gh.log"; GIT_LOG="$WORKROOT/git.log"
cat > "$FAKE_BIN/gh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GH_LOG"
case "\$1" in
    auth) exit 0 ;;
    repo) echo "https://github.com/stub-owner/stub-repo"; exit 0 ;;
    api) echo "{}"; exit 0 ;;
esac
exit 0
EOF
cat > "$FAKE_BIN/git" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GIT_LOG"
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$FAKE_BIN/gh" "$FAKE_BIN/git"
reset_logs() { : > "$GH_LOG"; : > "$GIT_LOG"; }

# Fixture: two commits, real receipt for HEAD. signed=0 drops the attestation.
make_fixture() {
    local signed="$2" d="$WORKROOT/$1" base
    mkdir -p "$d"
    "$REAL_GIT" -C "$d" init -q .
    "$REAL_GIT" -C "$d" config user.email t@example.com
    "$REAL_GIT" -C "$d" config user.name t
    "$REAL_GIT" -C "$d" config commit.gpgsign false
    echo "# fixture" > "$d/README.md"; printf '.loki/\n' > "$d/.gitignore"
    "$REAL_GIT" -C "$d" add README.md .gitignore; "$REAL_GIT" -C "$d" commit -qm baseline
    base="$("$REAL_GIT" -C "$d" rev-parse HEAD)"
    echo '{ "name": "f", "version": "1.0.0" }' > "$d/package.json"
    "$REAL_GIT" -C "$d" add package.json; "$REAL_GIT" -C "$d" commit -qm app
    ( cd "$d" && _LOKI_RUN_START_SHA="$base" python3 "$GENERATOR" --loki-dir "$d/.loki" >/dev/null 2>&1 )
    if [ "$signed" = "0" ]; then
        python3 - "$d" <<'PY'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/.loki/proofs/*/proof.json"):
    p = json.load(open(f))
    p.get("verification", {}).pop("attestation", None)
    p.get("verification", {}).pop("attestation_kid", None)
    json.dump(p, open(f, "w"), indent=2)
PY
    fi
}

run_publish() {
    local d="$1"; shift
    ( cd "$d" && PATH="$FAKE_BIN:$PATH" LOKI_DIR="$d/.loki" bash "$LOKI_BIN" github publish "$@" 2>&1 )
}

echo "TEST: loki github publish"
echo "========================="

echo "1. usage on bad input"
OUT="$(cd "$WORKROOT" && PATH="$FAKE_BIN:$PATH" bash "$LOKI_BIN" github publish --bogus 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi "usage: loki github publish"; then
    ok "unknown flag prints usage with non-zero exit"
else
    bad "unknown flag did not print usage" "rc=$RC"
fi

echo "2. VERIFIED, no origin: private repo create + success status"
make_fixture a 1; reset_logs
OUT="$(run_publish "$WORKROOT/a" myrepo)"; RC=$?
HEADSHA="$("$REAL_GIT" -C "$WORKROOT/a" rev-parse HEAD)"
if [ "$RC" -eq 0 ] && grep -q "repo create myrepo --private --source . --push" "$GH_LOG"; then
    ok "gh repo create ... --private --source . --push"
else
    bad "repo create argv wrong" "rc=$RC log=$(cat "$GH_LOG") out=$OUT"
fi
if grep -q "^api repos/.*/statuses/$HEADSHA" "$GH_LOG" && grep -q "state=success" "$GH_LOG" && grep -q "context=loki/receipt" "$GH_LOG"; then
    ok "status state=success context=loki/receipt on HEAD"
else
    bad "status call wrong" "log=$(cat "$GH_LOG")"
fi
if printf '%s' "$OUT" | grep -q "https://github.com/stub-owner/stub-repo"; then
    ok "prints repo URL from gh output"
else
    bad "repo URL missing" "$OUT"
fi
if grep -qE '(^| )add( |$)' "$GIT_LOG"; then bad "git add was invoked" "$(cat "$GIT_LOG")"; else ok "no git add"; fi

echo "3. --public is opt-in"
make_fixture b 1; reset_logs
run_publish "$WORKROOT/b" pubrepo --public >/dev/null
if grep -q "repo create pubrepo --public --source . --push" "$GH_LOG"; then ok "--public in argv"; else bad "--public missing" "$(cat "$GH_LOG")"; fi
if grep -q -- "--private" "$GH_LOG"; then bad "--private present alongside --public"; else ok "default stays private"; fi

echo "4. dirty tree refuses with zero gh calls"
make_fixture c 1; echo x >> "$WORKROOT/c/package.json"; reset_logs
OUT="$(run_publish "$WORKROOT/c" r)"; RC=$?
if [ "$RC" -ne 0 ] && [ ! -s "$GH_LOG" ] && printf '%s' "$OUT" | grep -qi dirty; then
    ok "dirty tree refused, gh never called"
else
    bad "dirty tree not refused cleanly" "rc=$RC gh=$(cat "$GH_LOG")"
fi

echo "5. UNSIGNED receipt gives state=failure"
make_fixture d 0; reset_logs
run_publish "$WORKROOT/d" r >/dev/null
if grep -q "state=failure" "$GH_LOG" && ! grep -q "state=success" "$GH_LOG"; then
    ok "unsigned receipt -> failure, never success"
else
    bad "unsigned receipt status wrong" "$(cat "$GH_LOG")"
fi

echo "6. with origin: pushes HEAD after anchor check"
make_fixture e 1
"$REAL_GIT" init -q --bare "$WORKROOT/e-origin.git"
"$REAL_GIT" -C "$WORKROOT/e" remote add origin "$WORKROOT/e-origin.git"
reset_logs
OUT="$(run_publish "$WORKROOT/e")"
if grep -q "push origin HEAD" "$GIT_LOG" && ! grep -q "repo create" "$GH_LOG"; then
    ok "git push origin HEAD, no repo create"
else
    bad "origin path wrong" "git=$(cat "$GIT_LOG") gh=$(cat "$GH_LOG") out=$OUT"
fi

echo "7. with origin, stale receipt: no push"
make_fixture f 1
"$REAL_GIT" init -q --bare "$WORKROOT/f-origin.git"
"$REAL_GIT" -C "$WORKROOT/f" remote add origin "$WORKROOT/f-origin.git"
echo more > "$WORKROOT/f/more.txt"
"$REAL_GIT" -C "$WORKROOT/f" add more.txt
"$REAL_GIT" -C "$WORKROOT/f" commit -qm later
reset_logs
run_publish "$WORKROOT/f" >/dev/null; RC=$?
if [ "$RC" -ne 0 ] && ! grep -q " push " "$GIT_LOG"; then
    ok "HEAD not the receipt anchor: refused, no push"
else
    bad "stale receipt was pushed" "rc=$RC git=$(cat "$GIT_LOG")"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
