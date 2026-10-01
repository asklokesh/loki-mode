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
    if [ -n "${FAKE_NOBUN:-}" ]; then # no-bun leg: the plain error line, exit 1, nothing touched
        case "$FAKE_MODE" in
            nofb) exit 1 ;;
            wrongrc) echo "loki: the Loki 10 engine cannot run on this machine: no working bun (none on PATH, and the bundled bun for linux-x64 is missing). To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh." >&2; exit 0 ;;
            extraline) echo "loki: the Loki 10 engine cannot run on this machine: no working bun (none on PATH, and the bundled bun for linux-x64 is missing). To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh." >&2; echo "Running something else" >&2; exit 1 ;;
            touched) echo x > NOTES.md; echo "loki: the Loki 10 engine cannot run on this machine: no working bun (none on PATH, and the bundled bun for linux-x64 is missing). To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh." >&2; exit 1 ;;
            *) echo "loki: the Loki 10 engine cannot run on this machine: no working bun (none on PATH, and the bundled bun for linux-x64 is missing). To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh." >&2; exit 1 ;;
        esac
    fi
    [ "$FAKE_MODE" = skipmain ] && sed -i.bak "s/'sums all numbers', /'sums all numbers', { skip: true }, /" sum.test.js && rm -f sum.test.js.bak
    [ "$FAKE_MODE" = red0 ] || sed -i.bak 's/i = 1/i = 0/' sum.js
    rm -f sum.js.bak
    [ "$FAKE_MODE" = stray ] && echo x > NOTES.md
    [ "$FAKE_MODE" = delfile ] && rm sum.test.js
    [ "$FAKE_MODE" = truetest ] && sed -i.bak 's/node --test/true/' package.json && rm -f package.json.bak
    [ "$FAKE_MODE" = modpkg ] && sed -i.bak 's/1.0.0/1.0.1/' package.json && rm -f package.json.bak
    if [ "$FAKE_MODE" = fallback ]; then
        echo "loki: the Loki 10 engine cannot run on this machine: no working bun (none on PATH, and the bundled bun for linux-x64 is missing). To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh." >&2
        exit 1
    fi
    mkdir -p .loki/runs/r
    # a real v10 run: receipt carries cost.usd, the event log carries a cost event (0 + source marker when unmetered)
    echo '{"cost":{"usd":0}}' > .loki/runs/r/receipt.json
    if [ "$FAKE_MODE" = nocost ]; then
        echo '{"cost":{"usd":null}}' > .loki/runs/r/receipt.json; echo '{"type":"cost","data":{"usd":null}}' > .loki/runs/r/events.jsonl
    else echo '{"type":"cost","data":{"usd":0,"source":"cli-unmetered"}}' > .loki/runs/r/events.jsonl; fi
    # the v10 quiet summary: start line then Outcome, PR, Receipt, NOT PROVEN, Cost, Time (7 lines)
    if [ "$FAKE_MODE" = nostart ]; then echo "Loki engine starting"; else echo "Loki 10 engine"; fi
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
run_nobun() { # run_nobun <mode>: the --engine nobun leg
    OUT=$(env -u LOKI_RUN_TMP FAKE_NOBUN=1 FAKE_MODE="$1" FRG_LOKI="$T/fake-loki" FRG_REPORT="$T/report-L$1.txt" bash "$GATE" --stub --engine nobun 2>&1); RC=$?
}
expect() { # expect <mode> <assertion> <PASS|FAIL>
    if printf '%s\n' "$OUT" | grep -q "^$3 $2:"; then ok "$1: $2 $3"; else bad "$1: $2 expected $3"; printf '%s\n' "$OUT" | sed 's/^/     /'; fi
}

run_gate clean
for a in exit-honest tests-green no-stray-files digest-matches verify-ok receipt-signed output-lines wall-time engine-start-line cost-non-null engine-no-bun skip-not-verified skip-bare-verify; do expect clean $a PASS; done
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
run_gate fallback;   expect fallback engine-no-bun FAIL;  expect fallback cost-non-null FAIL
[ "$RC" -ne 0 ] && ok "fallback: exits non-zero" || bad "fallback: exit 0"
printf '%s\n' "$OUT" | grep -q 'the engine could not start' && ok "fallback: names the failure" || bad "fallback: not named"
printf '%s\n' "$OUT" | grep -q 'no v10 run dir' && ok "fallback: cost reports no run dir" || bad "fallback: no run-dir message"
printf '%s\n' "$OUT" | grep -q 'IndexError' && bad "fallback: IndexError crash" || ok "fallback: no IndexError"
run_gate nocost;     expect nocost cost-non-null FAIL;       [ "$RC" -ne 0 ] && ok "nocost: exits non-zero" || bad "nocost: exit 0"
run_gate skipbare;   expect skipbare skip-bare-verify FAIL;  [ "$RC" -ne 0 ] && ok "skipbare: exits non-zero" || bad "skipbare: exit 0"
run_gate skipver;    expect skipver skip-not-verified FAIL;  [ "$RC" -ne 0 ] && ok "skipver: exits non-zero" || bad "skipver: exit 0"

# P0-DASH-STATIC: dashboard-root assertion (needs fastapi+uvicorn; otherwise the gate prints SKIP, never FAIL)
DPY=""
for p in "$HOME/.loki/dashboard-venv/bin/python" python3; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then DPY="$p"; break; fi
done
run_gate clean
if [ -n "$DPY" ]; then
    expect clean dashboard-root PASS
    # a package whose dashboard/static is EMPTY must fail the assertion (the "frontend not found" regression)
    NOFE="$T/nofe"; mkdir -p "$NOFE/dashboard/static"
    for e in "$SCRIPT_DIR"/../*; do b="$(basename "$e")"; case "$b" in dashboard|dashboard-ui) ;; *) ln -s "$e" "$NOFE/$b" ;; esac; done
    for e in "$SCRIPT_DIR"/../dashboard/*; do b="$(basename "$e")"; [ "$b" = static ] || ln -s "$e" "$NOFE/dashboard/$b"; done
    OUT=$(env -u LOKI_RUN_TMP FAKE_MODE=clean FRG_LOKI="$T/fake-loki" FRG_DASH_PKG="$NOFE" FRG_REPORT="$T/report-nofe.txt" bash "$GATE" --stub 2>&1); RC=$?
    expect nofe dashboard-root FAIL; [ "$RC" -ne 0 ] && ok "nofe: exits non-zero" || bad "nofe: exit 0"
else
    printf '%s\n' "$OUT" | grep -q '^SKIP dashboard-root' && ok "dashboard-root: skipped without fastapi" || bad "dashboard-root: neither ran nor skipped"
fi

# no-bun leg: the plain error line, exit 1, nothing touched
run_nobun clean
for a in nobun-exit nobun-line nobun-untouched; do expect nobun-clean $a PASS; done
[ "$RC" -eq 0 ] && ok "nobun-clean: gate exits 0" || bad "nobun-clean: gate exit $RC"
printf '%s\n' "$OUT" | grep -Eq 'engine-start-line|cost-non-null|skip-not-verified:|skip-bare-verify|verify-ok' && bad "nobun-clean: a v10-only check ran" || ok "nobun-clean: v10-only checks skipped"
run_nobun nofb;      expect nobun-nofb nobun-line FAIL;       [ "$RC" -ne 0 ] && ok "nobun-nofb: exits non-zero" || bad "nobun-nofb: exit 0"
run_nobun wrongrc;   expect nobun-wrongrc nobun-exit FAIL;    [ "$RC" -ne 0 ] && ok "nobun-wrongrc: exits non-zero" || bad "nobun-wrongrc: exit 0"
run_nobun extraline; expect nobun-extraline nobun-line FAIL;  [ "$RC" -ne 0 ] && ok "nobun-extraline: exits non-zero" || bad "nobun-extraline: exit 0"
run_nobun touched;   expect nobun-touched nobun-untouched FAIL; [ "$RC" -ne 0 ] && ok "nobun-touched: exits non-zero" || bad "nobun-touched: exit 0"
# the v10 leg does not run the no-bun checks
run_gate clean; printf '%s\n' "$OUT" | grep -q 'nobun-' && bad "v10 leg ran a no-bun check" || ok "v10 leg unchanged: no no-bun check"

# --installed nobun leg: optional deps omitted, and a bun left in the install dir fails closed
mkdir -p "$T/fakebin"
cat > "$T/fakebin/npm" <<'NPM'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_NPM_ARGS"
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && P="$2"; shift; done
mkdir -p "$P/node_modules/.bin"; cp "$FAKE_LOKI_SRC" "$P/node_modules/.bin/loki"
[ -n "${FAKE_NPM_WARN:-}" ] && echo "npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts: bun@1.4.2 (postinstall: node install.js)"
[ -n "${FAKE_NPM_BUN:-}" ] && mkdir -p "$P/node_modules/bun"
exit 0
NPM
chmod +x "$T/fakebin/npm"
run_inst() { # run_inst <withbun|nobun>
    OUT=$(env -u LOKI_RUN_TMP PATH="$T/fakebin:$PATH" FAKE_NPM_ARGS="$T/npm-args" FAKE_LOKI_SRC="$T/fake-loki" FAKE_NOBUN=1 FAKE_MODE=clean \
        ${2:+FAKE_NPM_BUN=1} FRG_REPORT="$T/report-inst.txt" bash "$GATE" --stub --engine nobun --installed loki-mode@x 2>&1); RC=$?
}
rm -f "$T/npm-args"; run_inst nobun
grep -q -- '--omit=optional' "$T/npm-args" && ok "installed nobun: omits optional deps" || bad "installed nobun: no --omit=optional"
run_inst withbun withbun
[ "$RC" -ne 0 ] && printf '%s\n' "$OUT" | grep -q 'FAIL nobun-no-bun: bun is installed at' && ok "installed nobun: bun in install dir fails closed" || bad "installed nobun: bun not rejected"

# an allow-scripts/postinstall warning in the install output fails the installed legs
OUT=$(env -u LOKI_RUN_TMP PATH="$T/fakebin:$PATH" FAKE_NPM_ARGS="$T/npm-args" FAKE_LOKI_SRC="$T/fake-loki" FAKE_NOBUN=1 FAKE_MODE=clean \
    FAKE_NPM_WARN=1 FRG_REPORT="$T/report-inst.txt" bash "$GATE" --stub --engine nobun --installed loki-mode@x 2>&1); RC=$?
[ "$RC" -ne 0 ] && printf '%s\n' "$OUT" | grep -q 'FAIL install-clean' && ok "installed: allow-scripts warning fails the gate" || bad "installed: allow-scripts warning not rejected"
run_inst nobun; [ "$RC" -eq 0 ] && ok "installed: clean install output passes" || bad "installed: clean install rc=$RC"

# The gate matches bin/loki's fallback text literally; the two must not drift
# (promote of 10.5.25 failed when the message changed and the gate did not).
BINLOKI="$SCRIPT_DIR/../bin/loki"
for pat in 'the Loki 10 engine cannot run on this machine: no working bun' 'To fix: reinstall with npm install -g loki-mode'; do
    if grep -qF -- "$pat" "$GATE" && grep -qF -- "$pat" "$BINLOKI"; then ok "gate and bin/loki agree on: $pat"
    else bad "gate and bin/loki disagree on fallback text: $pat"; fi
done

echo "first-run-gate tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
