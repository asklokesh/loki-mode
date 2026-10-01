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
    if [ -n "${FRG_SKIP:-}" ]; then # the gate's legacy G8 leg: D47 says rc 3 when tests are weakened
        case "$FAKE_MODE" in
            skipver) echo "Evidence Receipt: VERIFIED"; exit 0 ;;
            skiprc0) echo "Evidence Receipt: NOT VERIFIED"; exit 0 ;;
            *) echo "Evidence Receipt: NOT VERIFIED (tests weakened: skip added in sum.test.js)"; exit 3 ;;
        esac
    fi
    [ "$FAKE_MODE" = skipmain ] && sed -i.bak "s/'sums all numbers', /'sums all numbers', { skip: true }, /" sum.test.js && rm -f sum.test.js.bak
    [ "$FAKE_MODE" = red0 ] || sed -i.bak 's/i = 1/i = 0/' sum.js
    rm -f sum.js.bak
    [ "$FAKE_MODE" = stray ] && echo x > NOTES.md
    [ "$FAKE_MODE" = delfile ] && rm sum.test.js
    [ "$FAKE_MODE" = truetest ] && sed -i.bak 's/node --test/true/' package.json && rm -f package.json.bak
    [ "$FAKE_MODE" = modpkg ] && sed -i.bak 's/1.0.0/1.0.1/' package.json && rm -f package.json.bak
    mkdir -p .loki/runs/r
    # a real v10 run: receipt carries cost.usd, the event log carries a cost event (0 + source marker when unmetered)
    echo '{"cost":{"usd":0}}' > .loki/runs/r/receipt.json
    if [ "$FAKE_MODE" = nocost ]; then
        echo '{"cost":{"usd":null}}' > .loki/runs/r/receipt.json; echo '{"type":"cost","data":{"usd":null}}' > .loki/runs/r/events.jsonl
    else echo '{"type":"cost","data":{"usd":0,"source":"cli-unmetered"}}' > .loki/runs/r/events.jsonl; fi
    # the v10 quiet summary: start line then Outcome, PR, Receipt, NOT PROVEN, Cost, Time (7 lines)
    if [ "$FAKE_MODE" = nostart ]; then echo "Loki engine starting"; else echo "Loki 10 engine (set LOKI_ENGINE=legacy to use the old engine)"; fi
    echo "Outcome:    VERIFIED"
    echo "PR:         none (local)"
    if [ "$FAKE_MODE" = prefix ]; then echo "Receipt:    receipt ${D:0:12}"; else echo "Receipt:    receipt_sha256: $D"; fi
    if [ "$FAKE_MODE" = nolabel ]; then echo "Proof gaps: none"; else echo "NOT PROVEN: none"; fi
    echo "Cost:       \$0.00"
    echo "Time:       1s"
    [ "$FAKE_MODE" = long ] && seq 1 30
    [ "$FAKE_MODE" = exit1 ] && exit 1
    exit 0 ;;
verify)
    if [ -f .loki/failed-run ] && [ "$FAKE_MODE" != skipbare ]; then echo "Outcome: FAILED (no sealed receipt)"; exit 4; fi # bare verify after a failed v10 run
    echo "VERDICT: VERIFIED"
    if [ "$FAKE_MODE" = baddigest ]; then echo "receipt_sha256: $(printf 'b%.0s' $(seq 64))"; else echo "receipt_sha256: $D"; fi
    if [ "$FAKE_MODE" = unsigned ]; then echo "attestation: UNSIGNED (no key)"; else echo "attestation: VERIFIED against the local JWKS"; fi
    exit 0 ;;
*) # the gate's G8 run: loki "<task>" --no-pr with FRG_SKIP set
    mkdir -p .loki; : > .loki/failed-run
    if [ "$FAKE_MODE" = skipver ]; then echo "Outcome:    VERIFIED"; exit 0; fi
    echo "Outcome:    FAILED"; exit 1 ;;
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
for a in exit-honest tests-green no-stray-files digest-matches verify-ok receipt-signed output-lines wall-time engine-start-line cost-non-null skip-not-verified skip-bare-verify skip-not-verified-legacy; do expect clean $a PASS; done
[ "$RC" -eq 0 ] && ok "clean: gate exits 0" || bad "clean: gate exit $RC"
[ -s "$T/report-clean.txt" ] && ok "clean: report written" || bad "clean: no report"

run_gate stray;      expect stray no-stray-files FAIL;       [ "$RC" -ne 0 ] && ok "stray: exits non-zero" || bad "stray: exit 0"
run_gate red0;       expect red0 exit-honest FAIL;           expect red0 tests-green FAIL; [ "$RC" -ne 0 ] && ok "red0: exits non-zero" || bad "red0: exit 0"
run_gate long;       expect long output-lines FAIL;          [ "$RC" -ne 0 ] && ok "long: exits non-zero" || bad "long: exit 0"
run_gate unsigned;   expect unsigned receipt-signed FAIL;    [ "$RC" -ne 0 ] && ok "unsigned: exits non-zero" || bad "unsigned: exit 0"
run_gate delfile;    expect delfile no-stray-files FAIL;     expect delfile tests-green FAIL
run_gate truetest;   expect truetest no-stray-files FAIL;    [ "$RC" -ne 0 ] && ok "truetest: exits non-zero" || bad "truetest: exit 0"
run_gate modpkg;     expect modpkg no-stray-files FAIL
run_gate exit1;      expect exit1 exit-honest FAIL;          [ "$RC" -ne 0 ] && ok "exit1: exits non-zero" || bad "exit1: exit 0"
run_gate prefix;     expect prefix digest-matches FAIL
run_gate baddigest;  expect baddigest digest-matches FAIL;   [ "$RC" -ne 0 ] && ok "baddigest: exits non-zero" || bad "baddigest: exit 0"
run_gate skipmain;   expect skipmain exit-honest FAIL;       expect skipmain tests-green FAIL;  [ "$RC" -ne 0 ] && ok "skipmain: exits non-zero" || bad "skipmain: exit 0"
run_gate nostart;    expect nostart engine-start-line FAIL;  [ "$RC" -ne 0 ] && ok "nostart: exits non-zero" || bad "nostart: exit 0"
run_gate nolabel;    expect nolabel engine-start-line FAIL
run_gate nocost;     expect nocost cost-non-null FAIL;       [ "$RC" -ne 0 ] && ok "nocost: exits non-zero" || bad "nocost: exit 0"
run_gate skipbare;   expect skipbare skip-bare-verify FAIL;  [ "$RC" -ne 0 ] && ok "skipbare: exits non-zero" || bad "skipbare: exit 0"
run_gate skiprc0;    expect skiprc0 skip-not-verified-legacy FAIL;  [ "$RC" -ne 0 ] && ok "skiprc0: 9b needs rc 3" || bad "skiprc0: exit 0"
run_gate skipver;    expect skipver skip-not-verified FAIL;  expect skipver skip-not-verified-legacy FAIL;  [ "$RC" -ne 0 ] && ok "skipver: exits non-zero" || bad "skipver: exit 0"

echo "first-run-gate tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
