#!/usr/bin/env bash
#===============================================================================
# Enterprise Pod-Loss Resilience Tests (ENT-1 .. ENT-4)
#
# Targeted coverage for the enterprise pod-loss / platform-retry changes in
# autonomy/run.sh:
#   ENT-1  assert_durable_state_mount()  (run.sh ~10388) -- LOKI_DURABLE_STATE=1
#          fail-fast on a missing / read-only working dir; no-op otherwise.
#   ENT-2  load_state() running-split    (run.sh ~12858) -- a crashed "running"
#          run RESUMES (ITERATION_COUNT preserved) only with LOKI_DURABLE_STATE=1
#          AND a non-empty .loki/state/start-sha; otherwise it RESETS to 0.
#   ENT-3  main() exit-code contract     (run.sh ~17995) -- final run status ->
#          process exit code (success/human-stop -> 0; terminal failure -> 20;
#          unknown/running -> leave nonzero as-is).
#   ENT-4  create_session_pr() (LOKI_AUTO_PR=1) check-before-create (run.sh
#          ~6701) -- if an OPEN PR already exists for the head, reuse it and do
#          NOT invoke `gh pr create`.
#
# HOW WE TEST (honesty note):
#  - ENT-1, ENT-2, ENT-4 are GENUINELY EXERCISED by SOURCING the real
#    autonomy/run.sh and calling the real functions. Sourcing is safe and
#    quiet: main() is guarded by the BASH_SOURCE==$0 check (run.sh:18034), and
#    with a temp HOME + temp cwd + LOKI_SKIP_PROJECT_REGISTRY=1 the top-level
#    init is silent (verified: 0 bytes stdout/stderr, returns 0). This tests the
#    REAL wiring (helpers, python3 state parsing, git/gh calls), not a copy.
#  - ENT-3 lives INSIDE main() (too large to source-and-call), so we EXTRACT the
#    literal `case "$_final_status" in ... esac` block by name anchor into a
#    tiny wrapper and drive the real, extracted case logic. This is NOT a
#    hand-retyped mirror: the exact source bytes are executed, and an extraction
#    guard fails loudly if the anchor drifts so the test can never go vacuous.
#
# HERMETIC + DETERMINISTIC: every case runs in its own temp dir under WORKROOT
# with a temp HOME; no network (gh is stubbed, git pushes target a local bare
# remote); LOKI_DURABLE_STATE / LOKI_AUTO_PR are set/unset per subshell so
# ambient env cannot leak in. All temp state is removed on exit.
#
# bash 3.2 compatible (Mac): no associative arrays, no mapfile.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_SH="$PROJECT_DIR/autonomy/run.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-ent-resilience.XXXXXX")"
FAKE_HOME="$WORKROOT/home"
mkdir -p "$FAKE_HOME"
cleanup() {
    # Restore any chmod'd dir so rm -rf can remove it, then nuke WORKROOT.
    [ -d "$WORKROOT/ent1-ro" ] && chmod u+rwx "$WORKROOT/ent1-ro" 2>/dev/null || true
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Enterprise Pod-Loss Resilience Tests (ENT-1 .. ENT-4)"
echo "====================================================="
echo ""

# A small preamble file sourced by each subshell. Sources the REAL run.sh under
# a temp HOME + hermetic env. main() does NOT run (BASH_SOURCE guard); top-level
# init is silent under these vars. Errors from source are surfaced (>&2) but the
# probe confirmed it is clean.
PREAMBLE="$WORKROOT/preamble.sh"
cat > "$PREAMBLE" <<EOF
export HOME="$FAKE_HOME"
export LOKI_SKIP_PROJECT_REGISTRY=1
export LOKI_NO_TELEMETRY=1
export LOKI_NO_BANNER=1
# shellcheck disable=SC1090
source "$RUN_SH" >/dev/null 2>&1
EOF

# Write a VALID autonomy-state.json (passes the BUG-ST-006 integrity gate in
# load_state, run.sh:12805-12823) so load_state takes the ENT-2 path, never the
# corrupt->reset path. Args: <dir> <status> <iterationCount> [retryCount]
write_state() {
    local dir="$1" status="$2" ic="$3" rc="${4:-0}"
    mkdir -p "$dir/.loki"
    printf '{"status":"%s","iterationCount":%s,"retryCount":%s}\n' \
        "$status" "$ic" "$rc" > "$dir/.loki/autonomy-state.json"
}

# =============================================================================
# ENT-1: assert_durable_state_mount()
# =============================================================================

# ENT-1a: LOKI_DURABLE_STATE unset -> no-op, returns 0, never exits, no probe.
echo "ENT-1a: LOKI_DURABLE_STATE unset -> no-op (return 0, no probe file)"
E1A="$WORKROOT/ent1-noop"
mkdir -p "$E1A"
out1a="$(
    cd "$E1A" || exit 1
    source "$PREAMBLE"
    unset LOKI_DURABLE_STATE
    export TARGET_DIR="$E1A"
    assert_durable_state_mount
    rc=$?
    # No probe should have been created/left behind, and no .loki forced.
    probe="$(ls "$E1A"/.loki-durable-probe.* 2>/dev/null | wc -l | tr -d ' ')"
    printf 'RC=%s PROBES=%s' "$rc" "$probe"
)"
if [ "$out1a" = "RC=0 PROBES=0" ]; then
    pass "unset -> return 0, no write probe (true no-op)"
else
    fail "ENT-1 no-op contract violated" "got: $out1a"
fi

# ENT-1b: LOKI_DURABLE_STATE=1 + writable dir -> success, return 0, probe cleaned.
echo "ENT-1b: durable + writable dir -> return 0, success log, probe removed"
E1B="$WORKROOT/ent1-ok"
mkdir -p "$E1B"
out1b="$(
    cd "$E1B" || exit 1
    source "$PREAMBLE"
    export LOKI_DURABLE_STATE=1
    export TARGET_DIR="$E1B"
    msg="$(assert_durable_state_mount 2>&1)"
    rc=$?
    probe="$(ls "$E1B"/.loki-durable-probe.* 2>/dev/null | wc -l | tr -d ' ')"
    honest="$(printf '%s' "$msg" | grep -qi 'writable mount verified' && echo yes || echo no)"
    printf 'RC=%s PROBES=%s HONEST=%s' "$rc" "$probe" "$honest"
)"
if [ "$out1b" = "RC=0 PROBES=0 HONEST=yes" ]; then
    pass "writable dir -> return 0, honest success log, probe cleaned up"
else
    fail "ENT-1 writable-dir contract violated" "got: $out1b"
fi

# ENT-1c: LOKI_DURABLE_STATE=1 + non-existent dir -> exit 20 (terminal config
# error, no-retry contract), honest message.
echo "ENT-1c: durable + non-existent dir -> exit 20, honest 'does not exist'"
out1c="$(
    cd "$WORKROOT" || exit 1
    source "$PREAMBLE"
    export LOKI_DURABLE_STATE=1
    export TARGET_DIR="$WORKROOT/this-path-does-not-exist-$$"
    # assert_durable_state_mount calls `exit 20`; isolate it in its own subshell
    # so it does not terminate THIS subshell before we can read the result.
    msg="$( ( assert_durable_state_mount ) 2>&1 )"
    rc=$?
    honest="$(printf '%s' "$msg" | grep -qi 'does not exist' && echo yes || echo no)"
    printf 'RC=%s HONEST=%s' "$rc" "$honest"
)"
case "$out1c" in
    "RC=20 HONEST=yes")
        pass "non-existent dir -> exit 20, honest 'does not exist' message" ;;
    *)
        fail "ENT-1 non-existent-dir contract violated" "got: $out1c" ;;
esac

# ENT-1d: LOKI_DURABLE_STATE=1 + read-only dir -> exit 20 via the write probe.
# Skipped as root (root can write to a 0500 dir, so the probe would not fail).
echo "ENT-1d: durable + read-only dir -> exit nonzero via write probe (honest 'not writable')"
if [ "$(id -u)" = "0" ]; then
    pass "SKIP (running as root: write probe cannot fail on a read-only dir)"
else
    E1D="$WORKROOT/ent1-ro"
    mkdir -p "$E1D"
    chmod 0500 "$E1D"   # r-x: not writable
    out1d="$(
        cd "$WORKROOT" || exit 1
        source "$PREAMBLE"
        export LOKI_DURABLE_STATE=1
        export TARGET_DIR="$E1D"
        msg="$( ( assert_durable_state_mount ) 2>&1 )"
        rc=$?
        honest="$(printf '%s' "$msg" | grep -qi 'not writable' && echo yes || echo no)"
        printf 'RC=%s HONEST=%s' "$rc" "$honest"
    )"
    chmod u+rwx "$E1D" 2>/dev/null || true
    case "$out1d" in
        "RC=20 HONEST=yes")
            pass "read-only dir -> exit 20 via write probe, honest 'not writable' message" ;;
        *)
            fail "ENT-1 read-only-dir contract violated" "got: $out1d" ;;
    esac
fi

# =============================================================================
# ENT-2: load_state() running-split (resume vs reset).
# We drive the REAL load_state(). It sets the globals RETRY_COUNT and
# ITERATION_COUNT; we echo ITERATION_COUNT and also assert no .corrupt.* backup
# was made (proves we hit the ENT-2 path, not the corruption->reset path).
# A distinctive iterationCount of 7 makes preserve(7) vs reset(0) unambiguous.
# =============================================================================

# Run load_state in dir $1 and print "IC=<n> CORRUPT=<count>".
run_load_state() {
    local dir="$1"
    (
        cd "$dir" || exit 1
        source "$PREAMBLE"
        # load_state reads from globals; init them to sentinel non-zero so a
        # missing reset would be visible.
        RETRY_COUNT=99
        ITERATION_COUNT=99
        load_state >/dev/null 2>&1
        corrupt="$(ls .loki/autonomy-state.json.corrupt.* 2>/dev/null | wc -l | tr -d ' ')"
        printf 'IC=%s CORRUPT=%s' "$ITERATION_COUNT" "$corrupt"
    )
}

# ENT-2a: durable + start-sha present + running -> ITERATION_COUNT PRESERVED (7).
echo "ENT-2a: durable + start-sha + running -> ITERATION_COUNT preserved (7)"
E2A="$WORKROOT/ent2-resume"
write_state "$E2A" running 7
mkdir -p "$E2A/.loki/state"
printf 'abc123\n' > "$E2A/.loki/state/start-sha"
out2a="$(
    export LOKI_DURABLE_STATE=1
    run_load_state "$E2A"
)"
if [ "$out2a" = "IC=7 CORRUPT=0" ]; then
    pass "durable resume: ITERATION_COUNT preserved at 7 (not reset), no corrupt backup"
else
    fail "ENT-2 durable-resume contract violated" "got: $out2a (expected IC=7 CORRUPT=0)"
fi

# ENT-2b: durable, NO start-sha + running -> ITERATION_COUNT RESET to 0.
echo "ENT-2b: durable, NO start-sha + running -> ITERATION_COUNT reset to 0"
E2B="$WORKROOT/ent2-nosha"
write_state "$E2B" running 7
# Deliberately no .loki/state/start-sha file.
out2b="$(
    export LOKI_DURABLE_STATE=1
    run_load_state "$E2B"
)"
if [ "$out2b" = "IC=0 CORRUPT=0" ]; then
    pass "durable but no start-sha: ITERATION_COUNT reset to 0 (safe default)"
else
    fail "ENT-2 no-start-sha reset contract violated" "got: $out2b (expected IC=0 CORRUPT=0)"
fi

# ENT-2c: NON-durable + start-sha present + running -> ITERATION_COUNT RESET to 0.
echo "ENT-2c: non-durable + start-sha + running -> ITERATION_COUNT reset to 0"
E2C="$WORKROOT/ent2-nondurable"
write_state "$E2C" running 7
mkdir -p "$E2C/.loki/state"
printf 'abc123\n' > "$E2C/.loki/state/start-sha"
out2c="$(
    unset LOKI_DURABLE_STATE   # default/local mode
    run_load_state "$E2C"
)"
if [ "$out2c" = "IC=0 CORRUPT=0" ]; then
    pass "non-durable + start-sha: ITERATION_COUNT reset to 0 (original safe behavior)"
else
    fail "ENT-2 non-durable reset contract violated" "got: $out2c (expected IC=0 CORRUPT=0)"
fi

# ENT-2d: durable + start-sha present BUT terminal status (failed) -> RESET to 0.
# Terminal statuses must reset regardless of mode; durable resume is "running"-only.
echo "ENT-2d: durable + start-sha + terminal (failed) -> ITERATION_COUNT reset to 0"
E2D="$WORKROOT/ent2-terminal"
write_state "$E2D" failed 7
mkdir -p "$E2D/.loki/state"
printf 'abc123\n' > "$E2D/.loki/state/start-sha"
out2d="$(
    export LOKI_DURABLE_STATE=1
    run_load_state "$E2D"
)"
if [ "$out2d" = "IC=0 CORRUPT=0" ]; then
    pass "terminal 'failed' in durable mode: ITERATION_COUNT reset to 0 (not resumed)"
else
    fail "ENT-2 terminal-reset contract violated" "got: $out2d (expected IC=0 CORRUPT=0)"
fi

# =============================================================================
# ENT-3: main() exit-code contract. EXTRACTED literal case block, driven for
# real (not a hand-typed mirror). We awk out the exact `case "$_final_status"
# in ... esac` from run.sh, wrap it in a function, and assert the status->code
# table. An extraction guard fails loudly if the anchors drift.
# =============================================================================
echo "ENT-3: exit-code contract (extracted real case block)"
ENT3_LIB="$WORKROOT/ent3-case.sh"
# Extract from the case header line (must mention _final_status) up to and
# including the FIRST `esac` after it. The block uses `result=...`, so we wrap
# it in a function that takes (_final_status, result) and echoes the resulting
# `result`. No log_info dependency: the extracted region is the case only.
{
    echo '_ent3_map() {'
    echo '    local _final_status="$1"'
    echo '    local result="$2"'
    awk '
        /case "\$_final_status" in/ { p=1 }
        p { print }
        p && /^[[:space:]]*esac[[:space:]]*$/ { exit }
    ' "$RUN_SH"
    echo '    printf "%s" "$result"'
    echo '}'
} > "$ENT3_LIB"

# Non-vacuity gate: the extracted block MUST contain the three signature arms.
_ent3_ok=true
grep -q 'council_approved' "$ENT3_LIB" || _ent3_ok=false
grep -q 'result=20' "$ENT3_LIB" || _ent3_ok=false
grep -q 'esac' "$ENT3_LIB" || _ent3_ok=false
if [ "$_ent3_ok" != true ]; then
    fail "ENT-3 extraction failed (case-block anchors drifted in run.sh)" \
        "$(head -40 "$ENT3_LIB")"
else
    # Drive the real extracted case. Table: status, incoming result -> expected.
    #   success/human-stop -> 0 ; terminal failure -> 20 ; unknown/running keeps
    #   nonzero (and a 0 becomes 1). Incoming result chosen to prove behavior:
    #     council_approved  99 -> 0   (success overrides any incoming)
    #     stopped           99 -> 0   (human-stop)
    #     failed             0 -> 20  (terminal failure overrides 0)
    #     max_iterations_reached 0 -> 20
    #     policy_blocked     0 -> 20
    #     running            7 -> 7   (unknown/running leaves nonzero as-is)
    #     running            0 -> 1   (unknown/running with 0 becomes 1)
    #     unknown            0 -> 1
    ent3_errors=""
    check_ent3() {
        local status="$1" inres="$2" want="$3" got
        got="$( source "$ENT3_LIB"; _ent3_map "$status" "$inres" )"
        if [ "$got" != "$want" ]; then
            ent3_errors="${ent3_errors}[${status},in=${inres}: want=${want} got=${got}] "
        fi
    }
    check_ent3 council_approved 99 0
    check_ent3 council_force_approved 99 0
    check_ent3 completion_promise_fulfilled 99 0
    check_ent3 force_stopped 99 0
    check_ent3 paused 99 0
    check_ent3 interrupted 99 0
    check_ent3 budget_exceeded 99 0
    check_ent3 stopped 99 0
    check_ent3 failed 0 20
    check_ent3 max_iterations_reached 0 20
    check_ent3 max_retries_exceeded 0 20
    check_ent3 policy_blocked 0 20
    # "exited" is a TRANSIENT per-iteration status, NOT a deterministic terminal:
    # it must map to the retryable arm (a SIGKILL while "exited" is persisted is a
    # recoverable crash that should resume), not to the no-retry 20.
    check_ent3 exited 0 1
    check_ent3 running 7 7
    check_ent3 running 0 1
    check_ent3 unknown 0 1
    if [ -z "$ent3_errors" ]; then
        pass "exit-code table correct: success/human-stop->0, terminal->20, unknown/running keeps nonzero (16 cases)"
    else
        fail "ENT-3 exit-code mapping wrong for some statuses" "$ent3_errors"
    fi

    # ENT-3 mutation (non-vacuity): flip the terminal-failure arm to result=0 in
    # a COPY of the extracted lib and prove `failed` then maps to 0, not 20.
    ENT3_MUT="$WORKROOT/ent3-case.mut.sh"
    sed 's/result=20/result=0/' "$ENT3_LIB" > "$ENT3_MUT"
    mut_got="$( source "$ENT3_MUT"; _ent3_map failed 0 )"
    if [ "$mut_got" = "0" ]; then
        pass "mutation detected: flipping the terminal arm makes 'failed'->0 (the ENT-3 assertion is non-vacuous)"
    else
        fail "ENT-3 mutation NOT detected (assertion may be vacuous)" "mutated 'failed' -> $mut_got (expected 0)"
    fi
fi

# =============================================================================
# ENT-4: create_session_pr() check-before-create (LOKI_AUTO_PR=1).
# Real bare remote so `git push` succeeds (run.sh:6693 returns 1 BEFORE the
# ENT-4 logic if push fails). gh is STUBBED on PATH: it differentiates by argv
# (`pr list` -> echo a URL or empty, toggled per case; `pr create` -> append to
# a log). We assert the log NEVER contains "pr create" when a PR already exists.
# =============================================================================

# Build a repo AHEAD of base by one commit on a loki/session-* branch, with a
# real local bare remote wired as origin. Echoes the repo path.
make_ahead_repo_with_remote() {
    local name="$1"
    local repo="$WORKROOT/$name"
    local bare="$WORKROOT/$name-remote.git"
    mkdir -p "$repo"
    git init -q --bare "$bare"
    (
        cd "$repo" || exit 1
        git init -q
        git config user.email "test@loki.local"
        git config user.name "Loki Test"
        git config commit.gpgsign false
        git remote add origin "$bare"
        git checkout -q -b develop
        echo "seed" > seed.txt
        git add seed.txt
        git commit -q -m "seed commit"
        git checkout -q -b loki/session-test
        echo "agent work" > work.txt
        git add work.txt
        git commit -q -m "agent commit"
        mkdir -p .loki/state
        printf '%s\n' "develop" > .loki/state/base-branch.txt
        printf '%s\n' "loki/session-test" > .loki/state/agent-branch.txt
    )
    echo "$repo"
}

# Install a gh stub on PATH. The stub logs argv to $GH_LOG. On `pr list` it
# echoes the contents of $GH_PRLIST_OUT (a file): empty file -> "no PR".
install_gh_stub() {
    local stub_dir="$1" log="$2" prlist_out="$3"
    mkdir -p "$stub_dir"
    cat > "$stub_dir/gh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log"
case "\$*" in
    *"pr list"*)
        cat "$prlist_out" 2>/dev/null || true
        ;;
    *"pr create"*)
        # Should NOT be reached in the existing-PR case. Echo a sentinel URL.
        echo "https://example.test/pr/created"
        ;;
esac
exit 0
EOF
    chmod +x "$stub_dir/gh"
}

# ENT-4a: an OPEN PR already exists -> reuse it, gh pr create is NOT invoked.
echo "ENT-4a: existing OPEN PR -> reuse, NO 'gh pr create' invoked"
R4A="$(make_ahead_repo_with_remote ent4-existing)"
GH4A="$WORKROOT/gh-stub-a"
GH4A_LOG="$WORKROOT/gh-a.log"
GH4A_PRLIST="$WORKROOT/gh-a-prlist.txt"
: > "$GH4A_LOG"
printf 'https://example.test/pr/42\n' > "$GH4A_PRLIST"   # pr list returns a URL
install_gh_stub "$GH4A" "$GH4A_LOG" "$GH4A_PRLIST"
out4a="$(
    cd "$R4A" || exit 1
    export PATH="$GH4A:$PATH"
    export LOKI_AUTO_PR=1
    source "$PREAMBLE"
    msg="$(create_session_pr 2>&1)"
    reused="$(printf '%s' "$msg" | grep -qi 'PR already exists' && echo yes || echo no)"
    printf 'REUSED=%s' "$reused"
)"
# grep -c already prints 0 and exits 1 on no match; do NOT append a fallback
# (that would yield "0\n0"). Capture the count as-is.
created4a="$(grep -c 'pr create' "$GH4A_LOG" 2>/dev/null)"; [ -n "$created4a" ] || created4a=0
listed4a="$(grep -c 'pr list' "$GH4A_LOG" 2>/dev/null)"; [ -n "$listed4a" ] || listed4a=0
if [ "$out4a" = "REUSED=yes" ] && [ "$created4a" = "0" ] && [ "$listed4a" -ge 1 ]; then
    pass "existing PR: reused (honest log), gh queried 'pr list' but NEVER 'pr create' (no duplicate)"
else
    fail "ENT-4 idempotency violated (duplicate PR risk)" \
        "out=$out4a pr_create_count=$created4a pr_list_count=$listed4a log='$(cat "$GH4A_LOG" 2>/dev/null)'"
fi

# ENT-4b: NO existing PR -> gh pr create IS invoked (with --base develop).
echo "ENT-4b: no existing PR -> 'gh pr create' invoked with --base develop"
R4B="$(make_ahead_repo_with_remote ent4-create)"
GH4B="$WORKROOT/gh-stub-b"
GH4B_LOG="$WORKROOT/gh-b.log"
GH4B_PRLIST="$WORKROOT/gh-b-prlist.txt"
: > "$GH4B_LOG"
: > "$GH4B_PRLIST"   # pr list returns EMPTY -> no existing PR
install_gh_stub "$GH4B" "$GH4B_LOG" "$GH4B_PRLIST"
out4b="$(
    cd "$R4B" || exit 1
    export PATH="$GH4B:$PATH"
    export LOKI_AUTO_PR=1
    source "$PREAMBLE"
    create_session_pr >/dev/null 2>&1
    printf 'done'
)"
created4b="$(grep -c 'pr create' "$GH4B_LOG" 2>/dev/null)"; [ -n "$created4b" ] || created4b=0
base4b="$(grep -q -- '--base develop' "$GH4B_LOG" 2>/dev/null && echo yes || echo no)"
if [ "$created4b" -ge 1 ] && [ "$base4b" = "yes" ]; then
    pass "no existing PR: gh pr create invoked WITH --base develop (create path reached)"
else
    fail "ENT-4 create-path contract violated" \
        "pr_create_count=$created4b base=$base4b log='$(cat "$GH4B_LOG" 2>/dev/null)'"
fi

echo ""
echo "====================================================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
