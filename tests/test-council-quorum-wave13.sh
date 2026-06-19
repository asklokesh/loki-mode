#!/usr/bin/env bash
# tests/test-council-quorum-wave13.sh -- WAVE13 CRITICAL regression test.
#
# Proves the completion-council live-vote quorum fix in
# autonomy/lib/voter-agents.sh: the embedded python parser must judge the
# COMPLETE/CONTINUE verdict against the EXPECTED council size (COUNCIL_SIZE),
# never against the number of findings the model happened to return.
#
# Pre-fix bug: threshold = (returned*2+2)//3. A degraded response with a single
# APPROVE finding gave returned=1, threshold=1, and a COMPLETE verdict from a
# SINGLE voter -- fail OPEN on the completion-detection trust core.
#
# Cases driven through the REAL parser (via loki_council_dispatch_agents with a
# stubbed claude on PATH):
#   1. 1 finding, APPROVE                 -> verdict NOT COMPLETE (undercount)
#   2. 3 findings, 2 APPROVE + 1 REJECT   -> verdict COMPLETE (legit 2-of-3)
#   3. 3 findings, 1 APPROVE + 2 REJECT   -> verdict CONTINUE (below threshold)
#   4. mutation guard: with the parser temporarily reverted to the returned-
#      count denominator, case 1 WRONGLY becomes COMPLETE (proves non-vacuity)
#
# The test stubs `claude` so no real model is invoked. The stub answers
# `claude --help` with both required flags and answers the dispatch prompt
# with the canned findings JSON for the active case (selected via env var).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/voter-agents.sh"
FLAGS_HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# The mutated helper copy MUST live in autonomy/lib/ so that its
# __LOKI_VA_REPO_ROOT (derived from BASH_SOURCE via ../..) still resolves to the
# real repo root and loki_finding_schema_path finds the schema. A copy in a temp
# dir would resolve the repo root wrong and the dispatch would bail early
# (return 1) before ever reaching the parser, making the mutation test vacuous.
MUT_HELPER="$REPO_ROOT/autonomy/lib/.voter-agents-wave13-mut.sh"

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
    [ -n "${MUT_HELPER:-}" ] && [ -f "$MUT_HELPER" ] && rm -f "$MUT_HELPER"
}
trap cleanup EXIT

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-quorum-wave13.XXXXXX")"

# ---------- Static check ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "voter-agents.sh parses with bash -n"
else
    bad "voter-agents.sh failed bash -n"
fi

# ---------- Build a fake claude on PATH ----------
# The stub:
#   * `claude --help`        -> prints lines containing --agents and --json-schema
#   * `claude ... -p ...`    -> prints the canned findings JSON from $FAKE_FINDINGS_FILE
BIN_DIR="$TMPROOT/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/claude" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
    if [ "$arg" = "--help" ]; then
        printf '  --agents <json>        custom agents\n'
        printf '  --json-schema <path>   output schema\n'
        exit 0
    fi
done
# Dispatch invocation: emit the canned findings JSON.
if [ -n "${FAKE_FINDINGS_FILE:-}" ] && [ -f "${FAKE_FINDINGS_FILE}" ]; then
    cat "${FAKE_FINDINGS_FILE}"
    exit 0
fi
exit 1
STUB
chmod +x "$BIN_DIR/claude"

# ---------- Canned response fixtures ----------
write_findings() {
    # $1 = file, $2 = JSON
    printf '%s' "$2" > "$1"
}

F1="$TMPROOT/findings-1approve.json"
write_findings "$F1" '{"findings":[{"role":"requirements-verifier","vote":"APPROVE","reason":"looks done","confidence":0.9}]}'

F2="$TMPROOT/findings-3-2approve.json"
write_findings "$F2" '{"findings":[{"role":"requirements-verifier","vote":"APPROVE","reason":"ok","confidence":0.9},{"role":"test-auditor","vote":"APPROVE","reason":"tests green","confidence":0.8},{"role":"convergence-voter","vote":"REJECT","reason":"not yet","confidence":0.7}]}'

F3="$TMPROOT/findings-3-1approve.json"
write_findings "$F3" '{"findings":[{"role":"requirements-verifier","vote":"APPROVE","reason":"ok","confidence":0.9},{"role":"test-auditor","vote":"REJECT","reason":"no tests","confidence":0.8},{"role":"convergence-voter","vote":"REJECT","reason":"not yet","confidence":0.7}]}'

# Overcount: 4 findings (an unprompted 4th 'devils-advocate'), 2 APPROVE. With
# the fixed threshold=2 this would clear a returned-count >= check, so the gate
# must fail closed on a count that does NOT equal the expected council size.
F4="$TMPROOT/findings-4-2approve.json"
write_findings "$F4" '{"findings":[{"role":"requirements-verifier","vote":"APPROVE","reason":"ok","confidence":0.9},{"role":"test-auditor","vote":"APPROVE","reason":"tests green","confidence":0.8},{"role":"convergence-voter","vote":"REJECT","reason":"not yet","confidence":0.7},{"role":"devils-advocate","vote":"REJECT","reason":"skeptical","confidence":0.6}]}'

# ---------- Driver: run the real dispatch parser for one case ----------
# Returns the verdict on stdout, or "DISPATCH_FAILED" if the helper returned
# non-zero (which itself is a valid fail-closed outcome -> treated as not COMPLETE).
run_case() {
    # $1 = findings file, $2 = which helper file to source (lets the mutation
    #      case point at a temporarily-reverted copy)
    local findings_file="$1"
    local helper_file="$2"
    local iter=7
    local state_dir
    state_dir="$(mktemp -d "$TMPROOT/state.XXXXXX")"

    (
        set -u
        export PATH="$BIN_DIR:$PATH"
        export FAKE_FINDINGS_FILE="$findings_file"
        export COUNCIL_STATE_DIR="$state_dir"
        export COUNCIL_SIZE=3
        export LOKI_ITER="$iter"
        # Fresh help cache per subshell so the stub is consulted.
        unset __LOKI_CLAUDE_HELP_CACHE
        # shellcheck disable=SC1090
        . "$FLAGS_HELPER"
        # shellcheck disable=SC1090
        . "$helper_file"
        if loki_council_dispatch_agents "$iter" "" >/dev/null 2>&1; then
            local rf="$state_dir/votes/round-${iter}.json"
            if [ -f "$rf" ]; then
                _RF="$rf" python3 -c "import json,os; print(json.load(open(os.environ['_RF'])).get('verdict','CONTINUE'))" 2>/dev/null || echo "PARSE_ERR"
            else
                echo "NO_ROUND_FILE"
            fi
        else
            echo "DISPATCH_FAILED"
        fi
    )
}

# Sanity: the stub claude must be invokable and report the flags.
if PATH="$BIN_DIR:$PATH" claude --help 2>/dev/null | grep -q -- "--agents"; then
    ok "stub claude reports --agents in help"
else
    bad "stub claude did not report --agents"
fi

# ---------- Case 1: single APPROVE finding must NOT be COMPLETE ----------
v1="$(run_case "$F1" "$HELPER")"
if [ "$v1" != "COMPLETE" ]; then
    ok "1-finding APPROVE -> NOT COMPLETE (verdict: $v1)"
else
    bad "1-finding APPROVE wrongly COMPLETE (fail-open quorum bug!)"
fi

# ---------- Case 2: 3 findings, 2 APPROVE -> COMPLETE ----------
v2="$(run_case "$F2" "$HELPER")"
if [ "$v2" = "COMPLETE" ]; then
    ok "3-finding 2-APPROVE -> COMPLETE (verdict: $v2)"
else
    bad "3-finding 2-APPROVE should be COMPLETE but got: $v2"
fi

# ---------- Case 3: 3 findings, 1 APPROVE -> CONTINUE ----------
v3="$(run_case "$F3" "$HELPER")"
if [ "$v3" != "COMPLETE" ]; then
    ok "3-finding 1-APPROVE -> NOT COMPLETE (verdict: $v3)"
else
    bad "3-finding 1-APPROVE wrongly COMPLETE"
fi

# ---------- Case 3b: 4 findings (overcount), 2 APPROVE -> NOT COMPLETE ----------
# Fail-closed on overcount: a degraded response with extra findings must not
# clear the fixed threshold. This is the other half of exact-quorum.
v3b="$(run_case "$F4" "$HELPER")"
if [ "$v3b" != "COMPLETE" ]; then
    ok "4-finding (overcount) 2-APPROVE -> NOT COMPLETE (verdict: $v3b)"
else
    bad "4-finding overcount wrongly COMPLETE (fail-open overcount bug!)"
fi

# ---------- Case 4: mutation guard (non-vacuity) ----------
# Build a copy of the helper with the fix reverted to the buggy returned-count
# denominator, and confirm case 1 then WRONGLY becomes COMPLETE. If it does
# NOT flip, the test is not actually exercising the guarded code path.
# Revert: force the parser to use returned-count threshold and drop the
# undercount fail-closed branch. We do this with a targeted python rewrite so
# the mutation is unambiguous and independent of source line numbers.
python3 - "$HELPER" "$MUT_HELPER" <<'PYEOF'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    src = f.read()
# Re-introduce the bug: denominator from returned count, no undercount guard.
buggy = '''threshold = (total * 2 + 2) // 3
if False:
    verdict = "CONTINUE"
else:
    verdict = "COMPLETE" if complete >= threshold else "CONTINUE"'''
good = '''threshold = (expected_count * 2 + 2) // 3
if total != expected_count:
    # Fail closed on ANY quorum mismatch:
    #   - undercount (total < expected): missing voters count as non-approval.
    #   - overcount  (total > expected): extra/unprompted findings (e.g. a model
    #     adding a 4th finding) would otherwise let a low-approval-ratio response
    #     clear the fixed threshold. A degraded response in either direction must
    #     never reach COMPLETE on the returned subset.
    verdict = "CONTINUE"
else:
    verdict = "COMPLETE" if complete >= threshold else "CONTINUE"'''
if good not in src:
    sys.stderr.write("MUTATION_ANCHOR_NOT_FOUND\n")
    sys.exit(9)
src = src.replace(good, buggy)
with open(dst_path, "w") as f:
    f.write(src)
PYEOF
mut_rc=$?
if [ "$mut_rc" -ne 0 ]; then
    bad "mutation guard: could not anchor the fix block in voter-agents.sh (rc=$mut_rc)"
elif ! bash -n "$MUT_HELPER" 2>/dev/null; then
    bad "mutation guard: mutated helper failed bash -n"
else
    v_mut="$(run_case "$F1" "$MUT_HELPER")"
    if [ "$v_mut" = "COMPLETE" ]; then
        ok "mutation guard: reverted (returned-count) parser WRONGLY COMPLETE on 1 finding -> fix is non-vacuous"
    else
        bad "mutation guard: reverted parser did NOT flip to COMPLETE (got: $v_mut); test may not exercise the guarded path"
    fi
fi

# ---------- Summary ----------
printf '\n%s\n' "----------------------------------------"
printf 'WAVE13 council quorum: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
exit 0
