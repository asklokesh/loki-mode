# shellcheck shell=bash
# Leg 7, multi-repo: two local git repos in loki.yaml give two runs plus integration.json.
leg_07_workspaces() {
    local root="$T/work/leg7" rc ij n
    mkdir -p "$root"
    mk_repo "$root/api"; mk_repo "$root/web"
    cat > "$root/loki.yaml" <<YML
workspaces:
  shop:
    repos:
      - {repo: e2e/api, path: $root/api}
      - {repo: e2e/web, path: $root/web, after: [e2e/api]}
    integration: {command: "true", timeout_s: 60}
YML
    ( cd "$root" && cenv timeout -k 5 420 "$LOKI" workspace run shop "fix the bug that makes the failing test in sum.test.js fail" ) < /dev/null > "$T/logs/leg7.log" 2>&1
    rc=$?
    note "loki workspace run rc=$rc"
    ij="$(find "$root/.loki/workspaces" -name integration.json 2> /dev/null | head -1)"
    n="$(find "$root" -path '*/.loki/runs/e10-*' -name receipt.json 2> /dev/null | wc -l | tr -d ' ')"
    note "receipts=$n integration.json=${ij:-none}"
    if [ -z "$ij" ]; then fail "no integration.json under .loki/workspaces (rc=$rc; $(tail -3 "$T/logs/leg7.log" | tr '\n' ' '))"; return; fi
    [ "$n" -ge 2 ] || fail "expected 2 runs (one per repo), found $n receipts"
    [ "$rc" -eq 0 ] || fail "workspace run rc=$rc, expected 0"
    pass "two runs ($n receipts) plus integration.json, rc=$rc"
}
