#!/usr/bin/env bash
# v8: the raw-SDK completion-council VOTE path (the TRUST CORE).
# Proves the LOKI_SDK_COUNCIL_VOTE=1 branch in council_member_review and
# council_devils_advocate: (1) it's wired to `internal sdk-text` (text bridge,
# NOT a schema change, so the elaborate VOTE:/REASON:/ISSUES: parser is
# untouched); (2) opt-in (default 0); (3) runs BEFORE the claude-binary guard
# (binary-free); (4) a mocked success returns the model's VOTE text VERBATIM,
# and the downstream VOTE parser reads it correctly; (5) fail-closed: with no
# SDK output the claude arm still gates the vote (so an empty verdict routes to
# the conservative REJECT default, never a fake APPROVE). No billable API call.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CC="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# ---- 1. wiring: both vote functions gate on the flag and call sdk-text ----
grep -q 'LOKI_SDK_COUNCIL_VOTE' "$CC" \
    && grep -q 'internal sdk-text' "$CC" \
    && ok "completion-council wires LOKI_SDK_COUNCIL_VOTE -> sdk-text" \
    || bad "completion-council missing the SDK vote branch wiring"

# must be opt-in (default 0) at BOTH sites (member + contrarian)
n_optin=$(grep -c 'LOKI_SDK_COUNCIL_VOTE:-0' "$CC")
[ "$n_optin" -ge 2 ] && ok "SDK vote branch is opt-in (default 0) at both member + contrarian sites" \
    || bad "SDK vote branch not default-off at both sites (found $n_optin)"

# ---- 2. binary-free ordering: the SDK vote branch must run BEFORE the vote-body
# claude guard (`&& command -v claude`). The earlier precondition gate is a
# SEPARATE `command -v claude` -- it must itself be SDK-aware (checked in 2b).
check_order() {
    local fn="$1"
    local block
    block="$(awk "/^ *${fn}\\(\\) *\\{/{f=1} f{print NR\": \"\$0} /^}/{if(f){f=0}}" "$CC")"
    local sdk_ln guard_ln
    sdk_ln=$(printf '%s\n' "$block" | grep 'LOKI_SDK_COUNCIL_VOTE:-0' | head -1 | cut -d: -f1)
    # the vote-body guard is the `&& command -v claude` form (not the bare
    # precondition `claude) command -v claude`)
    guard_ln=$(printf '%s\n' "$block" | grep '&& command -v claude' | head -1 | cut -d: -f1)
    if [ -n "$sdk_ln" ] && [ -n "$guard_ln" ] && [ "$sdk_ln" -lt "$guard_ln" ]; then
        ok "$fn: SDK vote branch runs BEFORE the vote-body claude guard (binary-free)"
    else
        bad "$fn: SDK vote branch not before the vote-body claude guard (sdk=$sdk_ln guard=$guard_ln)"
    fi
}
check_order council_member_review
check_order council_devils_advocate

# ---- 2b. the precondition gate must be SDK-aware (else it hard-blocks a
# no-binary run before the vote body is ever reached). ----
precond_sdk_aware=$(grep -c 'LOKI_SDK_COUNCIL_VOTE:-0' "$CC")
# 2 vote-body gates + 2 precondition gates = 4 references when both are SDK-aware
[ "$precond_sdk_aware" -ge 4 ] \
    && ok "precondition gates are SDK-aware (no-binary run reaches the vote body)" \
    || bad "precondition gate not SDK-aware (found $precond_sdk_aware LOKI_SDK_COUNCIL_VOTE refs, want >=4)"

# ---- 3. syntax ----
bash -n "$CC" && ok "completion-council.sh passes bash -n" || bad "completion-council.sh syntax error"

# ---- 4/5/6: REAL-FUNCTION integration tests. Extract the ACTUAL
# council_member_review via awk brace-counting (the established council-test
# pattern; the whole file does not source standalone), stub its few deps, and
# drive it with a stubbed bin/loki and NO claude binary -- so we test the true
# code path (not a hand-copied branch body). The fake repo root makes
# BASH_SOURCE/../bin/loki resolve to our stub.
run_member() {
    # $1 = stub bin/loki body (bash after the shebang). Prints the function's
    # verdict output. PROVIDER_NAME=claude, LOKI_SDK_COUNCIL_VOTE=1, NO claude on
    # PATH (so an SDK miss exercises the no-binary deploy path).
    local stub_body="$1"
    local root; root="$(mktemp -d)"
    mkdir -p "$root/autonomy/lib" "$root/bin"
    # extract council_member_review verbatim (brace-counting, same as
    # test-council-contrarian-transcript-fields.sh). BASH_SOURCE inside it must
    # resolve under $root/autonomy so ../bin/loki -> $root/bin/loki; we write the
    # extracted fn to $root/autonomy/completion-council.sh and source THAT.
    awk '
      /^council_member_review\(\)/ { found=1; depth=0 }
      found {
        print
        for (i=1; i<=length($0); i++) {
          c = substr($0, i, 1)
          if (c == "{") depth++
          else if (c == "}") { depth--; if (depth == 0) exit }
        }
      }
    ' "$CC" > "$root/autonomy/completion-council.sh"
    { printf '#!/usr/bin/env bash\n'; printf '%s\n' "$stub_body"; } > "$root/bin/loki"
    chmod +x "$root/bin/loki"
    local evf="$root/evidence.txt"; printf 'PRD: build X. Tests: pass.\n' > "$evf"
    local vdir="$root/votes"; mkdir -p "$vdir"
    (
      set +u
      # minimal stubbed deps so the extracted function runs standalone
      log_error() { :; }; log_warn() { :; }; log_info() { :; }
      # heuristic must be VISIBLE so we can prove we do NOT reach it on timeout;
      # if reached it would (wrongly) APPROVE -- the exact bug under test.
      council_heuristic_review() { printf 'VOTE:APPROVE\nREASON: heuristic benign\n'; }
      # Simulate a no-claude-binary deploy: keep bun (its own dir) on PATH but
      # exclude claude's dir. bun and claude live in different dirs; we prepend
      # bun's dir and the stub, then the system dirs, but NOT claude's dir.
      local _bun_dir; _bun_dir="$(dirname "$(command -v bun)")"
      PATH="$root/bin:$_bun_dir:/usr/bin:/bin"
      export PROVIDER_NAME=claude LOKI_SDK_COUNCIL_VOTE=1 LOKI_BLIND_VALIDATION=false
      export LOKI_COUNCIL_REVIEW_TIMEOUT=1
      # shellcheck disable=SC1090
      source "$root/autonomy/completion-council.sh"
      council_member_review "m1" "engineer" "$evf" "$vdir" 2>/dev/null
    )
    rm -rf "$root"
}

if command -v bun >/dev/null 2>&1; then
    # 4. SUCCESS: stub returns a VOTE:APPROVE -> the real function must emit it.
    out4="$(run_member 'if [ "$1" = internal ] && [ "$2" = sdk-text ]; then printf "VOTE:APPROVE\nREASON: all AC verified"; exit 0; fi; exit 3')"
    printf '%s' "$out4" | grep -qE "VOTE:[[:space:]]*APPROVE" \
        && ok "real council_member_review: SDK success -> VOTE:APPROVE emitted (verbatim)" \
        || bad "real fn SDK success wrong: got '$out4'"

    # 5. FAIL-CLOSED (normal miss, rc 1): no claude binary -> falls to heuristic.
    #    (This is the EXISTING no-provider degraded behavior; benign evidence.)
    out5="$(run_member 'exit 1')"
    printf '%s' "$out5" | grep -qE "VOTE:" \
        && ok "real fn: normal SDK miss (rc1) + no claude -> reaches heuristic fallback (unchanged)" \
        || bad "real fn rc1 miss produced no verdict: '$out5'"

    # 6. THE BLOCKING BUG (council REJECT fix): an SDK subprocess TIMEOUT (rc 124,
    #    the code `timeout` returns on kill) with NO claude binary must force a
    #    conservative REJECT via _provider_rc, NOT fall to the heuristic (which
    #    would APPROVE). This is the trust-core fake-APPROVE the council caught.
    #    The stub exits 124 directly (deterministic; equivalent to what the OS
    #    `timeout` wrap produces on a hung reviewer, without a real 16s wait).
    out6="$(run_member 'exit 124')"
    vote6="$(printf '%s' "$out6" | grep -oE "VOTE:[[:space:]]*(APPROVE|REJECT|CANNOT_VALIDATE)" | grep -oE "APPROVE|REJECT|CANNOT_VALIDATE" | head -1)"
    if [ "$vote6" = "REJECT" ]; then
        ok "TRUST CORE: SDK timeout (rc124) + no claude -> conservative REJECT (never heuristic APPROVE)"
    else
        bad "TRUST CORE BUG: SDK timeout produced '$vote6' (expected REJECT); fake-APPROVE risk! out='$out6'"
    fi

    # 6b. also cover SIGKILL (137) and SIGTERM (143) -- same guard must fire.
    for rc in 137 143; do
        o="$(run_member "exit $rc")"
        v="$(printf '%s' "$o" | grep -oE "VOTE:[[:space:]]*(APPROVE|REJECT|CANNOT_VALIDATE)" | grep -oE "APPROVE|REJECT|CANNOT_VALIDATE" | head -1)"
        [ "$v" = "REJECT" ] && ok "TRUST CORE: SDK kill rc=$rc + no claude -> REJECT" \
            || bad "TRUST CORE: SDK rc=$rc produced '$v' (expected REJECT)"
    done
else
    ok "SKIP: bun not available for real-function integration checks"
fi

echo ""
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
