#!/usr/bin/env bash
# tests/test-review-diff-moat.sh -- Moat hardening for the code-review gate
# (Findings #596 + #598).
#
# Strategy: source the REAL autonomy/run.sh (its bottom guard runs main() only
# when executed directly, so sourcing is side-effect-light), then exercise the
# real run_code_review() and ensure_completion_test_evidence() inside per-case
# throwaway git repos. The provider invocation is intercepted by overriding
# invoke_claude_capture() AFTER sourcing, so no network / real model is needed.
#
# Behaviors under test (the three the task requires non-vacuous proof of):
#   1. Finding #596 A1: the code-review diff EXCLUDES .loki/ even when .loki is
#      git-tracked. Without the fix the diff bloats with runtime state; we assert
#      a tracked .loki file never reaches the reviewer diff while a real source
#      file does.
#   2. Finding #596 A2: an all-NO_OUTPUT review (every reviewer returns EMPTY)
#      does NOT pass. run_code_review must return non-zero and record
#      inconclusive=true / real_verdict_count=0 in aggregate.json.
#      Control case: a real PASS verdict from every reviewer still passes (proves
#      the block is specific to zero real verdicts, not a blanket block).
#   3. Finding #598: absent test-results.json no longer leaves the evidence
#      gate's test axis half-blind -- ensure_completion_test_evidence() RUNS the
#      project's test command and persists .loki/quality/test-results.json with a
#      real pass/fail before the gate reads it. A red suite yields pass:false.
#
# Skips gracefully (exit 0) when git/python3 unavailable, or when the impl has
# not landed (functions undefined). The absent-impl skip is LOUD on purpose.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v git >/dev/null 2>&1; then
    echo "SKIP: git not installed. (Not a fail.)"; exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

# Source the real run.sh. The bottom guard keeps main() from running.
# shellcheck source=/dev/null
source "$RUN_SH" 2>/dev/null || true

if ! type run_code_review >/dev/null 2>&1; then
    echo "SKIP (LOUD): run_code_review not defined after sourcing run.sh -- impl not landed?"; exit 0
fi
if ! type ensure_completion_test_evidence >/dev/null 2>&1; then
    echo "SKIP (LOUD): ensure_completion_test_evidence not defined -- Finding #598 impl not landed?"; exit 0
fi

# Quiet the log_* helpers so case output stays readable. They exist after source.
log_header() { :; }; log_step() { :; }; log_info() { :; }
log_warn()  { :; }; log_error() { :; }
emit_event_json() { :; }
register_pid() { :; }; unregister_pid() { :; }

# ---------------------------------------------------------------------------
# Configurable provider stub. run_code_review's reviewer loop (PROVIDER_NAME=
# claude) invokes the real `claude` binary directly. We shadow it with a PATH
# stub whose body is the file $STUB_BODY_FILE points at; an EMPTY file simulates
# the model returning nothing (the 2.18MB-overflow NO_OUTPUT condition).
# ---------------------------------------------------------------------------
STUB_BIN="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-stubbin.XXXXXX")"
STUB_BODY_FILE="$STUB_BIN/body.txt"
STUB_EMPTY_REVIEWER_FILE="$STUB_BIN/empty_reviewer.txt"
: > "$STUB_BODY_FILE"
: > "$STUB_EMPTY_REVIEWER_FILE"
cat > "$STUB_BIN/claude" <<'STUB'
#!/usr/bin/env bash
# Print the configured review body (empty => NO_OUTPUT). The prompt (the arg
# after -p) always opens with "You are <reviewer_name>." (see run.sh's
# BUILD_PROMPT heredoc), so a single reviewer can be singled out for EMPTY
# output via empty_reviewer.txt while the rest print the shared body -- same
# file-stub mechanism as body.txt, just keyed by name for the mixed case.
self_dir="$(dirname "$0")"
empty_name="$(cat "$self_dir/empty_reviewer.txt" 2>/dev/null)"
prompt=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-p" ]; then
        case "$arg" in
            --*) ;;
            *) prompt="$arg" ;;
        esac
    fi
    prev="$arg"
done
[ -n "$prompt" ] || prompt="$(cat)"
if [ -n "$empty_name" ]; then
    if printf '%s' "$prompt" | grep -q "^You are ${empty_name}\."; then
        exit 0
    fi
fi
cat "$self_dir/body.txt"
STUB
chmod +x "$STUB_BIN/claude"
export PATH="$STUB_BIN:$PATH"
set_review_body() { printf '%s' "$1" > "$STUB_BODY_FILE"; }
set_empty_reviewer() { printf '%s' "$1" > "$STUB_EMPTY_REVIEWER_FILE"; }

setup_repo() {
    local dir="$1"
    rm -rf "$dir"; mkdir -p "$dir"
    ( cd "$dir" \
        && git init -q \
        && git config user.email t@t.t \
        && git config user.name t \
        && git config commit.gpgsign false )
}

# ===========================================================================
# Case 1 -- Finding #596 A1: review diff excludes .loki/ even when tracked.
# ===========================================================================
case1() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c1.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        # Baseline commit.
        echo "init" > README.md
        git add README.md && git commit -qm init
        # Real source change + a TRACKED .loki bloat file (the bug condition).
        mkdir -p .loki/quality src
        echo "export const real = 1;" > src/app.ts
        # Make the .loki content large + uniquely greppable.
        python3 -c "print('LOKI_BLOAT_MARKER ' * 5000)" > .loki/quality/bloat.json
        git add src/app.ts .loki/quality/bloat.json
        git commit -qm "work + tracked .loki state"

        set_review_body $'VERDICT: PASS\nFINDINGS:\n- None'
        TARGET_DIR="$dir" PROVIDER_NAME=claude ITERATION_COUNT=1 \
            run_code_review >/dev/null 2>&1 || true

        local review_dir; review_dir="$dir/.loki/quality/reviews"
        local diff_file; diff_file="$(find "$review_dir" -name diff.txt 2>/dev/null | head -1)"
        if [ -z "$diff_file" ] || [ ! -f "$diff_file" ]; then
            echo "NO_DIFF_FILE"; exit 0
        fi
        if grep -q "LOKI_BLOAT_MARKER" "$diff_file"; then
            echo "LOKI_LEAKED"
        elif grep -q "src/app.ts" "$diff_file"; then
            echo "CLEAN_AND_NONVACUOUS"
        else
            echo "MISSING_REAL_FILE"
        fi
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    case "$r" in
        CLEAN_AND_NONVACUOUS) ok "A1: .loki/ excluded from review diff even when tracked; real source file present" ;;
        LOKI_LEAKED)          bad "A1: tracked .loki content LEAKED into the reviewer diff" "$r" ;;
        *)                    bad "A1: unexpected review-diff state" "$r" ;;
    esac
    rm -rf "$dir"
}

# ===========================================================================
# Case 2 -- Finding #596 A2: all-NO_OUTPUT review must NOT pass.
# Retry disabled so the single empty pass is the terminal state.
# ===========================================================================
case2_no_output() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c2.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        echo "init" > README.md; git add README.md && git commit -qm init
        echo "export const real = 2;" > src.ts
        git add src.ts && git commit -qm work

        local rc agg
        set_review_body ""
        TARGET_DIR="$dir" PROVIDER_NAME=claude ITERATION_COUNT=1 \
        LOKI_REVIEW_RETRY=0 \
            run_code_review >/dev/null 2>&1
        rc=$?
        agg="$(find "$dir/.loki/quality/reviews" -name aggregate.json 2>/dev/null | head -1)"
        local inconclusive="?" real="?" score="?"
        if [ -n "$agg" ] && [ -f "$agg" ]; then
            inconclusive="$(python3 -c "import json,sys;print(json.load(open('$agg')).get('inconclusive'))" 2>/dev/null)"
            real="$(python3 -c "import json,sys;print(json.load(open('$agg')).get('real_verdict_count'))" 2>/dev/null)"
            score="$(python3 -c "import json,sys;print(json.load(open('$agg')).get('quality_score'))" 2>/dev/null)"
        fi
        echo "rc=$rc inconclusive=$inconclusive real=$real score=$score"
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    if echo "$r" | grep -q "rc=0 "; then
        bad "A2: all-NO_OUTPUT review PASSED the gate (rc=0)" "$r"
    elif echo "$r" | grep -q "inconclusive=True" \
         && echo "$r" | grep -q "real=0" \
         && echo "$r" | grep -q "score=0"; then
        ok "A2: all-NO_OUTPUT review BLOCKED with quality_score=0"
    else
        bad "A2: unexpected aggregate state" "$r"
    fi
    rm -rf "$dir"
}

# ===========================================================================
# Case 2b -- control: a real PASS from every reviewer still passes (the block
# is specific to zero real verdicts, not a blanket regression).
# ===========================================================================
case2_real_pass() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c2b.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        echo "init" > README.md; git add README.md && git commit -qm init
        echo "export const real = 3;" > src.ts
        git add src.ts && git commit -qm work
        local rc
        set_review_body $'VERDICT: PASS\nFINDINGS:\n- None'
        TARGET_DIR="$dir" PROVIDER_NAME=claude ITERATION_COUNT=1 \
        LOKI_REVIEW_RETRY=0 \
            run_code_review >/dev/null 2>&1
        rc=$?
        echo "rc=$rc"
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    if echo "$r" | grep -q "rc=0"; then
        ok "A2 control: real PASS verdicts from all reviewers still pass (rc=0)"
    else
        bad "A2 control: real PASS review was wrongly blocked" "$r"
    fi
    rm -rf "$dir"
}

# ===========================================================================
# Case 2d -- Finding #596 partial NO_OUTPUT: some reviewers answer, one does
# not. The real battery for an unset/standard complexity is always 4
# reviewers (2 always-on + a 2-specialist floor; see SPECIALIST_COUNT_BY_TIER
# in run.sh), so this proves the guard on 3-of-4 real verdicts: 3 reviewers
# return non-empty "VERDICT: PASS" bodies, 1 (maintainer-mergeability, always
# dispatched second) returns EMPTY (crashed/overflowed). The gate must NOT
# ship green on the survivors -- it must block and record the exact
# real_verdict_count/reviewer_count split, not just "some real verdicts".
# reviewer_count itself is not a field on aggregate.json (only
# real_verdict_count/inconclusive are), so the total is read from the sibling
# selection.json that run_code_review already writes in the same review dir.
# ===========================================================================
case2_partial_no_output() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c2d.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        echo "init" > README.md; git add README.md && git commit -qm init
        echo "export const real = 5;" > src.ts
        git add src.ts && git commit -qm work

        local rc agg
        set_review_body $'VERDICT: PASS\nFINDINGS:\n- None'
        set_empty_reviewer "maintainer-mergeability"
        TARGET_DIR="$dir" PROVIDER_NAME=claude ITERATION_COUNT=1 \
        LOKI_REVIEW_RETRY=0 \
            run_code_review >/dev/null 2>&1
        rc=$?
        agg="$(find "$dir/.loki/quality/reviews" -name aggregate.json 2>/dev/null | head -1)"
        local sel="?"
        [ -n "$agg" ] && sel="$(dirname "$agg")/selection.json"
        local inconclusive="?" real="?" total="?"
        if [ -n "$agg" ] && [ -f "$agg" ]; then
            inconclusive="$(python3 -c "import json,sys;print(json.load(open('$agg')).get('inconclusive'))" 2>/dev/null)"
            real="$(python3 -c "import json,sys;print(json.load(open('$agg')).get('real_verdict_count'))" 2>/dev/null)"
        fi
        if [ -n "$sel" ] && [ -f "$sel" ]; then
            total="$(python3 -c "import json,sys;print(len(json.load(open('$sel'))['reviewers']))" 2>/dev/null)"
        fi
        echo "rc=$rc inconclusive=$inconclusive real=$real total=$total"
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    set_empty_reviewer ""
    if echo "$r" | grep -q "rc=0 "; then
        bad "A2 partial: MIXED review (survivors PASS, 1 EMPTY) PASSED the gate (rc=0) -- majority-passes-on-survivors" "$r"
    elif echo "$r" | grep -q "inconclusive=True"; then
        # real_verdict_count must be strictly less than reviewer_count (some
        # answered) and strictly greater than 0 (not the already-covered
        # all-empty case) -- the genuine partial-NO_OUTPUT signature.
        local real_n total_n
        real_n="$(echo "$r" | sed -E 's/.*real=([0-9]+).*/\1/')"
        total_n="$(echo "$r" | sed -E 's/.*total=([0-9]+).*/\1/')"
        if [ -n "$real_n" ] && [ -n "$total_n" ] && [ "$real_n" -gt 0 ] && [ "$total_n" -gt 0 ] && [ "$real_n" -lt "$total_n" ]; then
            ok "A2 partial: MIXED review BLOCKED (rc!=0, inconclusive=True, real_verdict_count=$real_n < reviewer_count=$total_n)"
        else
            bad "A2 partial: aggregate counts do not show a genuine partial split" "$r"
        fi
    else
        bad "A2 partial: unexpected aggregate state" "$r"
    fi
    rm -rf "$dir"
}

case3_test_capture() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c3.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        # Minimal Node project whose `npm test` (via jest detection path needs
        # npx); to avoid network we instead use the pytest path with a stub, OR
        # the go path. Simplest deterministic runner here: a Python project whose
        # pytest FAILS. Requires pytest on PATH; if absent, fall back to no-runner
        # assertion (file still written with runner:none).
        local tr=".loki/quality/test-results.json"
        rm -f "$tr"

        if command -v pytest >/dev/null 2>&1; then
            cat > pyproject.toml <<'EOF'
[project]
name = "t"
version = "0"
EOF
            mkdir -p tests
            cat > tests/test_fail.py <<'EOF'
def test_red():
    assert False
EOF
            TARGET_DIR="$dir" ITERATION_COUNT=1 ensure_completion_test_evidence >/dev/null 2>&1 || true
            if [ ! -f "$tr" ]; then echo "NO_FILE"; exit 0; fi
            local p; p="$(python3 -c "import json;d=json.load(open('$tr'));print(d.get('runner'),d.get('pass'))" 2>/dev/null)"
            echo "RED_RUNNER:$p"
        else
            # No pytest: prove the file is still written (no-runner => pass-through
            # is legitimate, but the file MUST exist so the gate is deterministic).
            TARGET_DIR="$dir" ITERATION_COUNT=1 ensure_completion_test_evidence >/dev/null 2>&1 || true
            if [ -f "$tr" ]; then echo "NORUNNER_FILE_WRITTEN"; else echo "NO_FILE"; fi
        fi
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    case "$r" in
        RED_RUNNER:pytest\ False) ok "B: ensure_completion_test_evidence ran pytest and persisted pass:false (gate sees red tests)" ;;
        RED_RUNNER:*)             bad "B: test-results.json written but did not record the failing pytest run" "$r" ;;
        NORUNNER_FILE_WRITTEN)    ok "B: ensure_completion_test_evidence persisted test-results.json (no pytest on PATH; file present => gate deterministic)" ;;
        NO_FILE)                  bad "B: test-results.json was NOT written -- evidence gate would stay half-blind" "$r" ;;
        *)                        bad "B: unexpected state" "$r" ;;
    esac
    rm -rf "$dir"
}

# ===========================================================================
# Case 3b -- Finding #598 freshness/opt-out: with results already present for
# this iteration, the capture reuses them (cheap); opt-out skips entirely.
# ===========================================================================
case3_optout() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c3b.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        local tr=".loki/quality/test-results.json"
        mkdir -p .loki/quality
        rm -f "$tr"
        # Opt-out: file must NOT be created.
        TARGET_DIR="$dir" ITERATION_COUNT=1 LOKI_COMPLETION_TEST_CAPTURE=0 \
            ensure_completion_test_evidence >/dev/null 2>&1 || true
        if [ -f "$tr" ]; then echo "OPTOUT_RAN"; exit 0; fi
        echo "OPTOUT_OK"
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    if [ "$r" = "OPTOUT_OK" ]; then
        ok "B opt-out: LOKI_COMPLETION_TEST_CAPTURE=0 skips capture (no file written)"
    else
        bad "B opt-out: capture ran despite opt-out" "$r"
    fi
    rm -rf "$dir"
}

# ===========================================================================
# Case 4 - reviewers receive unchanged function context plus recorded checks.
# ===========================================================================
case4_grounded_context() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c4.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        mkdir -p src .loki/quality
        cat > src/App.tsx <<'EOF'
import { useState } from "react";

export default function App() {
  const [status, setStatus] = useState("");
  const submit = () => setStatus("Saved");
  return (
    <>
      <a href="#main-content">Skip to content</a>
      <main id="main-content">
        <h1>Original title</h1>
        <form onSubmit={submit}><button>Save</button></form>
        <p aria-live="polite">{status}</p>
      </main>
    </>
  );
}
EOF
        git add src/App.tsx && git commit -qm baseline
        sed -i.bak 's/Original title/Improved title/' src/App.tsx
        rm -f src/App.tsx.bak
        printf '%s\n' '{"status":"verified","pass":true,"runner":"vitest","command":"vitest","exit_code":0,"passed_count":3,"failed_count":0}' > .loki/quality/test-results.json
        printf '%s\n' '{"status":"verified","ran":true,"command":"npm run build","exit_code":0,"applicable":true}' > .loki/quality/build-results.json

        set_review_body $'VERDICT: PASS\nFINDINGS:\n- None'
        TARGET_DIR="$dir" PROVIDER_NAME=claude ITERATION_COUNT=1 \
        LOKI_REVIEW_RETRY=0 run_code_review >/dev/null 2>&1 || true

        local review_root diff_file prompt_file
        review_root="$(find "$dir/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
        diff_file="$review_root/diff.txt"
        prompt_file="$(find "$review_root" -name '*-prompt.txt' | head -1)"
        if [ -f "$diff_file" ] && [ -f "$prompt_file" ] \
           && grep -q 'useState' "$diff_file" \
           && grep -q 'onSubmit' "$diff_file" \
           && grep -q 'Skip to content' "$diff_file" \
           && grep -q '"exit_code": 0' "$prompt_file" \
           && grep -q '"runner": "vitest"' "$prompt_file"; then
            echo "GROUNDED"
        else
            echo "MISSING_CONTEXT"
        fi
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    if [ "$r" = "GROUNDED" ]; then
        ok "C: review prompt includes unchanged function context and passing check evidence"
    else
        bad "C: review prompt lacks current implementation or check evidence" "$r"
    fi
    rm -rf "$dir"
}

# ===========================================================================
# Case 2c -- regression guard for FIX A2: a NON-"PASS" acceptance token still
# counts as a real, passing verdict (the gate keys on the PRESENCE of a VERDICT
# line + non-FAIL, NOT on the literal token "PASS"). A reviewer that drifts to
# "VERDICT: APPROVE" or "VERDICT: PASS with concerns" must NOT be false-blocked
# as inconclusive. This is the regression the strict-token approach would cause.
# ===========================================================================
case2_verbose_pass() {
    local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-reviewdiff-c2c.XXXXXX")"
    setup_repo "$dir"
    (
        cd "$dir" || exit 1
        echo "init" > README.md; git add README.md && git commit -qm init
        echo "export const real = 4;" > src.ts
        git add src.ts && git commit -qm work
        local rc agg
        set_review_body $'VERDICT: APPROVE\nFINDINGS:\n- [Low] minor nit'
        TARGET_DIR="$dir" PROVIDER_NAME=claude ITERATION_COUNT=1 \
        LOKI_REVIEW_RETRY=0 \
            run_code_review >/dev/null 2>&1
        rc=$?
        agg="$(find "$dir/.loki/quality/reviews" -name aggregate.json 2>/dev/null | head -1)"
        local real inconclusive
        real="$(python3 -c "import json;print(json.load(open('$agg')).get('real_verdict_count'))" 2>/dev/null)"
        inconclusive="$(python3 -c "import json;print(json.load(open('$agg')).get('inconclusive'))" 2>/dev/null)"
        echo "rc=$rc real=$real inconclusive=$inconclusive"
    ) > "$dir/result.txt" 2>/dev/null
    local r; r="$(cat "$dir/result.txt" 2>/dev/null)"
    if echo "$r" | grep -q "rc=0" && echo "$r" | grep -q "inconclusive=False"; then
        ok "A2 regression guard: non-'PASS' acceptance token (APPROVE) counts as real verdict and passes (rc=0)"
    else
        bad "A2 regression guard: verbose/APPROVE verdict was false-blocked" "$r"
    fi
    rm -rf "$dir"
}

case1
case2_no_output
case2_real_pass
case2_verbose_pass
case2_partial_no_output
case3_test_capture
case3_optout
case4_grounded_context

rm -rf "$STUB_BIN" 2>/dev/null || true

echo "----------------------------------------"
echo "test-review-diff-moat: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
