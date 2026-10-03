# shellcheck shell=bash
# Leg 6, spec to contract: a .loki/contract.json fixture gives a receipt containing the contract section.
# The repo stays in $T/work/leg6 for leg 8 (MCP status and verify).
leg_06_contract() {
    local repo="$T/work/leg6" rc run rj
    mk_repo "$repo"
    mkdir -p "$repo/.loki"
    printf '{"source":"spec.md","criteria":[{"id":"AC-1","text":"sum adds every element of the array","source_line":3},{"id":"AC-2","text":"empty array sums to 0","source_line":4}]}\n' > "$repo/.loki/contract.json"
    ( cd "$repo" && cenv timeout -k 5 240 "$LOKI" quick "fix the bug that makes the failing test in sum.test.js fail" ) < /dev/null > "$T/logs/leg6.log" 2>&1
    rc=$?
    run="$(newest_run "$repo")"
    note "loki quick rc=$rc run=${run:-none}"
    rj="$repo/.loki/runs/${run:-none}/receipt.json"
    if [ -z "$run" ] || [ ! -f "$rj" ]; then fail "no receipt.json (rc=$rc; $(tail -2 "$T/logs/leg6.log" | tr '\n' ' '))"; return; fi
    if ! grep -q '"contract"' "$rj"; then fail "receipt.json has no contract section (rc=$rc)"; return; fi
    grep -q 'AC-1' "$rj" || { fail "contract section lacks criterion AC-1"; return; }
    pass "receipt $run carries the contract section (rc=$rc)"
}
