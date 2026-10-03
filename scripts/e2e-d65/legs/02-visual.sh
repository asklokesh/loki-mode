# shellcheck shell=bash
# Leg 2, visual evidence: no Playwright in the repo gives a NOT PROVEN line, never a failure.
leg_02_visual() {
    local repo="$T/work/leg2" rc run
    mk_repo "$repo"
    ( cd "$repo" && cenv LOKI_VISUAL_EVIDENCE=1 E2E_STUB_PAGE=1 timeout -k 5 240 "$LOKI" quick "fix the bug that makes the failing test in sum.test.js fail" ) < /dev/null > "$T/logs/leg2.log" 2>&1
    rc=$?
    run="$(newest_run "$repo")"
    note "loki quick rc=$rc run=${run:-none}"
    if [ -z "$run" ] || [ ! -f "$repo/.loki/runs/$run/receipt.json" ]; then fail "no receipt.json (rc=$rc)"; return; fi
    if [ -e "$repo/node_modules/.bin/playwright" ]; then skip "playwright present in fixture"; return; fi
    if ! grep -rqi 'visual evidence skipped' "$repo/.loki/runs/$run" "$T/logs/leg2.log"; then
        fail "no 'visual evidence skipped' NOT PROVEN line in the receipt, run dir or output"; return
    fi
    [ "$rc" -eq 0 ] || { fail "missing Playwright turned the run into rc=$rc (must be NOT PROVEN, not a failure)"; return; }
    pass "NOT PROVEN line present, rc=0, no failure"
}
