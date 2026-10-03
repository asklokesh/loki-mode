# shellcheck shell=bash
# Leg 1, D61 speed: LOKI_SPEED=1 on the 2-file fixture task; a receipt exists.
leg_01_speed() {
    local repo="$T/work/leg1" rc run
    mk_repo "$repo"
    ( cd "$repo" && cenv LOKI_SPEED=1 timeout -k 5 240 "$LOKI" quick "fix the bug that makes the failing test in sum.test.js fail" ) < /dev/null > "$T/logs/leg1.log" 2>&1
    rc=$?
    run="$(newest_run "$repo")"
    note "loki quick rc=$rc run=${run:-none}"
    if [ -z "$run" ] || [ ! -f "$repo/.loki/runs/$run/receipt.json" ]; then
        fail "no receipt.json under .loki/runs (rc=$rc; log $T/logs/leg1.log: $(tail -2 "$T/logs/leg1.log" | tr '\n' ' '))"; return
    fi
    ( cd "$repo" && node --test ) > "$T/logs/leg1-test.log" 2>&1 || fail "fixture tests not green after the run"
    [ "$rc" -eq 0 ] || fail "loki quick rc=$rc, expected 0"
    pass "receipt $run, rc=$rc, fixture green"
}
