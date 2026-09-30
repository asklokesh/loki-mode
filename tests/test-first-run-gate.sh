#!/usr/bin/env bash
# tests/test-first-run-gate.sh -- tests the assertion logic of scripts/first-run-gate.sh
# with a fake `loki` (FRG_LOKI) that misbehaves in one chosen way. No provider, no network.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="$SCRIPT_DIR/../scripts/first-run-gate.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"

cat > "$T/fake-loki" <<'FAKE'
#!/usr/bin/env bash
D=$(printf 'a%.0s' $(seq 64))
case "$1" in
quick)
    [ "$FAKE_MODE" = red0 ] || sed -i.bak 's/i = 1/i = 0/' sum.js
    rm -f sum.js.bak
    [ "$FAKE_MODE" = stray ] && echo x > NOTES.md
    mkdir -p .loki/runs/r .loki/proofs/p
    J='"jwt": "tok"'; [ "$FAKE_MODE" = unsigned ] && J='"jwt": null'
    echo "{\"verification\": {$J}}" > .loki/runs/r/receipt.json
    if [ "$FAKE_MODE" = baddigest ]; then echo '{"d":"bbbb"}' > .loki/proofs/p/proof.json
    else echo "{\"d\":\"$D\"}" > .loki/proofs/p/proof.json; fi
    echo "Diff sha256 \`$D\`"
    [ "$FAKE_MODE" = long ] && seq 1 30
    [ "$FAKE_MODE" = unsigned ] && echo "receipts will be UNSIGNED"
    exit 0 ;;
verify) echo "VERDICT: VERIFIED"; exit 0 ;;
*) exit 0 ;;
esac
FAKE
chmod +x "$T/fake-loki"

PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

# run_gate <mode>: sets OUT and RC
run_gate() {
    OUT=$(env -u LOKI_RUN_TMP FAKE_MODE="$1" FRG_LOKI="$T/fake-loki" FRG_REPORT="$T/report-$1.txt" bash "$GATE" --stub 2>&1); RC=$?
}
expect() { # expect <mode> <assertion> <PASS|FAIL>
    if printf '%s\n' "$OUT" | grep -q "^$3 $2:"; then ok "$1: $2 $3"; else bad "$1: $2 expected $3"; printf '%s\n' "$OUT" | sed 's/^/     /'; fi
}

run_gate clean
for a in exit-honest tests-green no-stray-files digest-matches verify-ok receipt-signed output-lines wall-time; do expect clean $a PASS; done
[ "$RC" -eq 0 ] && ok "clean: gate exits 0" || bad "clean: gate exit $RC"
[ -s "$T/report-clean.txt" ] && ok "clean: report written" || bad "clean: no report"

run_gate stray;      expect stray no-stray-files FAIL;       [ "$RC" -ne 0 ] && ok "stray: exits non-zero" || bad "stray: exit 0"
run_gate red0;       expect red0 exit-honest FAIL;           expect red0 tests-green FAIL; [ "$RC" -ne 0 ] && ok "red0: exits non-zero" || bad "red0: exit 0"
run_gate long;       expect long output-lines FAIL;          [ "$RC" -ne 0 ] && ok "long: exits non-zero" || bad "long: exit 0"
run_gate unsigned;   expect unsigned receipt-signed FAIL;    [ "$RC" -ne 0 ] && ok "unsigned: exits non-zero" || bad "unsigned: exit 0"
run_gate baddigest;  expect baddigest digest-matches FAIL;   [ "$RC" -ne 0 ] && ok "baddigest: exits non-zero" || bad "baddigest: exit 0"

echo "first-run-gate tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
