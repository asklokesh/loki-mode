#!/usr/bin/env bash
# tests/test-v10-pulse.sh -- regression tests for scripts/v10-pulse.sh.
#
# All external data sources are overridden via env vars (BOARD_MD,
# CONTROL_MD, PULSE_REPO_ROOT, PULSE_MAIN_REF, PULSE_NPM_CMD, PULSE_GH_CMD,
# PULSE_GOVERNOR_CMD, PULSE_WORKTREE_CMD, PULSE_MOAT_RESULT, PULSE_SWARM_START, PULSE_NOW,
# PULSE_LOOP_MARKER, PULSE_TRANSCRIPT_DIR). No test here makes a real npm/gh
# network call or depends on real wall-clock time or the real
# docs/v10/BOARD.md.
#
# PULSE_TEST_SHELL selects which shell interprets scripts/v10-pulse.sh
# ("bash" default, or "sh" for macOS's real bash 3.2.57 in POSIX mode) so
# the whole suite can be run twice to back the bash-3.2-compatible claim,
# not just bash -n on both files.
set -uo pipefail
# A git hook (this suite's eventual pre-push caller, per tests/moat/run.sh's
# own comment on the same hazard) exports GIT_DIR. Inherited here, every git
# command this file's fixture setup runs below -- git init, commit, tag,
# config, reset --hard -- would operate on the REAL repo's .git instead of
# the fake $FAKE_REPO it thinks it is building, silently corrupting shared
# state (branch position, tags, the repo-local user.email/name) rather than
# a throwaway fixture. Scrub before creating anything.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
    GIT_ALTERNATE_OBJECT_DIRECTORIES
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Overridable so mutation testing can point the whole suite at a mutated
# copy without ever touching the real script (see the loki-verify skill's
# guidance: a mutation must go red in a copy, never in the file under test).
PULSE_SH="${PULSE_SH:-$REPO_ROOT/scripts/v10-pulse.sh}"
TEST_SHELL="${PULSE_TEST_SHELL:-bash}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# One run-owned temp dir for every fixture this file writes, removed at exit.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-v10-pulse.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# A small git repo the script can run its real (harmless) git commands
# against: a v1.0.0 tag with two moat properties pending, then a "main"
# branch (explicit -b main: git's own default-branch default is not
# guaranteed, and PULSE_MAIN_REF defaults to "main").
FAKE_REPO="$WORK/repo"
mkdir -p "$FAKE_REPO"
(
    cd "$FAKE_REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    mkdir -p tests/moat
    printf 'P1.case-a milestone reason\nP2.case-b milestone reason\n' > tests/moat/pending.txt
    git add tests/moat/pending.txt
    GIT_AUTHOR_DATE="2026-09-20T00:00:00Z" GIT_COMMITTER_DATE="2026-09-20T00:00:00Z" \
        git commit -q -m "initial"
    git tag v1.0.0
)

CONTROL_OK="$WORK/CONTROL-ok.md"
python3 -c "
for i in range(10):
    print('line %d' % i)
" > "$CONTROL_OK"

CONTROL_OVERSIZE="$WORK/CONTROL-big.md"
python3 -c "
for i in range(50):
    print('line %d' % i)
" > "$CONTROL_OVERSIZE"

# PROGRESS.md fixtures for STALE_PROGRESS. COMMON_ARGS' PULSE_NOW is fixed at
# 2026-09-27T02:00:00Z below; PROGRESS_FRESH's heading is 10 minutes before
# that (well under the 35-minute budget) so every OTHER test in this suite
# that does not override PULSE_PROGRESS_MD never sees a stray STALE_PROGRESS
# violation from a fixture built for something else.
PROGRESS_FRESH="$WORK/PROGRESS-fresh.md"
printf '# Progress\n\n## 2026-09-27T01:50Z: fresh entry\n- on track\n' > "$PROGRESS_FRESH"

PROGRESS_STALE="$WORK/PROGRESS-stale.md"
printf '# Progress\n\n## 2026-09-27T01:24Z: old entry\n- 36 minutes before PULSE_NOW\n' > "$PROGRESS_STALE"

PROGRESS_UNPARSEABLE="$WORK/PROGRESS-unparseable.md"
printf '# Progress\n\n## Current\n- no ISO timestamp heading anywhere in this file\n\n## Cycle 1\n- still no timestamp\n' > "$PROGRESS_UNPARSEABLE"

PROGRESS_MISSING="$WORK/no-such-progress.md"

# Real tests/moat/run.sh summary-line fixtures (finding 3): a measured PASS
# result (7 of 9, no rule failures) and a measured FAIL result (SAME count,
# 7 of 9, with an unlisted REGRESSION line, so only the suite-failed check
# can explain a violation, not a count drop), matching run.sh's own exact
# wording ("moat: N of 9 properties proven", "moat suite: FAIL (K rule
# failure(s))").
MOAT_RESULT_PASS="$WORK/moat-result-pass.txt"
cat > "$MOAT_RESULT_PASS" <<'EOF'
P1 portable proof: PROVEN
moat: 7 of 9 properties proven
moat suite: no rule failed (7 of 9 proven; the moat is NOT proven)
EOF

# Deliberately the SAME count as the v1.0.0 baseline (7 of 9): this isolates
# the suite_failed check from the separate count-drop check. If the count
# path alone explained a violation here, mutating away the suite_failed
# check (finding 3's actual fix) would not turn this test red -- exactly the
# real-repo case (measured 2 of 9 with baseline ALSO 2 of 9; P7 has no
# pending.txt line at either ref, so only the live FAIL line reveals it).
MOAT_RESULT_FAIL="$WORK/moat-result-fail.txt"
cat > "$MOAT_RESULT_FAIL" <<'EOF'
FAIL: REGRESSION P7.dashboard-client-routes-exist: FAIL but not listed in tests/moat/pending.txt
moat: 7 of 9 properties proven
moat suite: FAIL (1 rule failure(s))
EOF

# write_moat_sha RESULT_FILE REPO REF -- writes RESULT_FILE.sha holding the
# full SHA `git rev-parse REF` currently resolves to in REPO (BACKLOG 133:
# the sidecar convention scripts/v10-pulse.sh now requires). Must be called
# AFTER any fixture commit that moves REF, and again after each later commit
# that moves it further, or the sidecar goes stale exactly like the real bug.
write_moat_sha() {
    local result_file="$1" repo="$2" ref="$3"
    (cd "$repo" && git rev-parse "$ref") > "${result_file}.sha"
}

# A fabricated, well-formed-looking but wrong SHA: proves the comparison is a
# real inequality check against the CURRENT resolved ref, not a vacuous
# "sidecar exists" check.
STALE_SHA="0000000000000000000000000000000000dead"

# A worktree-list fixture builder. Writes a porcelain listing (primary
# worktree first, always skipped by position) followed by N builder
# worktrees, each a real .git-file + gitdir with HEAD/index/logs/HEAD, whose
# mtimes are set explicitly relative to a given "now" epoch (never left to
# the real wall clock, which is already past any fixed PULSE_NOW and would
# make every untouched file read as freshly modified).
# make_worktree DIR AGE_MINUTES NOW_EPOCH
make_worktree() {
    local dir="$1" age_min="$2" now_epoch="$3"
    local gitdir="$dir/.git-real"
    mkdir -p "$gitdir/logs"
    : > "$gitdir/HEAD"
    : > "$gitdir/index"
    : > "$gitdir/logs/HEAD"
    printf 'gitdir: %s\n' "$gitdir" > "$dir/.git"
    local mt
    mt=$(python3 -c "print(int($now_epoch - $age_min * 60))")
    python3 -c "
import os
mt = $mt
for p in ['$gitdir/HEAD', '$gitdir/index', '$gitdir/logs/HEAD']:
    os.utime(p, (mt, mt))
os.utime('$gitdir', (mt, mt))
"
}

# worktree_cmd_for REPO_PATH DIR... -> a PULSE_WORKTREE_CMD value (a shell
# command printing porcelain output) with REPO_PATH listed first (primary,
# always skipped) followed by each DIR.
worktree_cmd_for() {
    local out="worktree $1\nHEAD dead\nbranch refs/heads/main\n\n"
    shift
    local d
    for d in "$@"; do
        out="${out}worktree $d\nHEAD dead\n\n"
    done
    printf 'printf %s' "$(printf '%q' "$out")"
}

# run_pulse ENV_ARGS... -- runs scripts/v10-pulse.sh under $TEST_SHELL with
# the given env assignments (as separate "VAR=val" args), captures stdout
# into $OUT, returns the real exit code.
run_pulse() {
    local out="$WORK/out.$$"
    env "$@" "$TEST_SHELL" "$PULSE_SH" > "$out" 2>"$WORK/err.$$"
    local rc=$?
    OUT="$(cat "$out")"
    rm -f "$out" "$WORK/err.$$"
    return $rc
}

# run_pulse_from DIR ENV_ARGS... -- same as run_pulse, but runs with the
# shell's cwd set to DIR first (E-107: proves SESSION_STALLED's transcript
# dir no longer depends on the invoking shell's cwd).
run_pulse_from() {
    local dir="$1"; shift
    local out="$WORK/out.$$"
    (cd "$dir" && env "$@" "$TEST_SHELL" "$PULSE_SH") > "$out" 2>"$WORK/err.$$"
    local rc=$?
    OUT="$(cat "$out")"
    rm -f "$out" "$WORK/err.$$"
    return $rc
}

# A non-streak fixture for the CI_CANCELLED_STREAK check's default in
# COMMON_ARGS below: a clean, completed, non-cancelled run. Using "false"
# here (like PULSE_GH_CMD's own placeholder) would make ci_cancelled_streak
# UNKNOWN on every test that does not explicitly override it, turning every
# "rc = 0" clean-case assertion (T4 etc.) into rc = 2.
GH_STREAK_OK_JSON="$WORK/gh-streak-ok.json"
printf '[{"status":"completed","conclusion":"success"}]' > "$GH_STREAK_OK_JSON"

# Same rationale as GH_STREAK_OK_JSON above, for the G-02 usage-governor
# checks: fully calibrated, 10%% window/weekly, no opus share, plenty of
# next-hour headroom -- so OPUS_SHARE/BUDGET_BURN stay silent (not UNKNOWN)
# on every test below that does not explicitly override PULSE_GOVERNOR_CMD.
GOVERNOR_OK_JSON="$WORK/governor-ok.json"
cat > "$GOVERNOR_OK_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "weekly": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "governor": {
    "active_engineers_last_hour": 2,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1000.0,
    "max_engineers_next_hour": 10,
    "last_hour_output_tokens": 0,
    "hours_to_weekly_reset": 100.0
  }
}
EOF

COMMON_ARGS=(
    "PULSE_REPO_ROOT=$FAKE_REPO"
    "PULSE_MAIN_REF=main"
    "CONTROL_MD=$CONTROL_OK"
    "PULSE_PROGRESS_MD=$PROGRESS_FRESH"
    "PULSE_NPM_CMD=false"
    "PULSE_GH_CMD=false"
    "PULSE_GH_FALLBACK_CMD=false"
    "PULSE_GOVERNOR_CMD=cat $GOVERNOR_OK_JSON"
    "PULSE_GH_STREAK_CMD=cat $GH_STREAK_OK_JSON"
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO")"
    "PULSE_MOAT_RESULT="
    "PULSE_SWARM_START=2026-09-26T23:00Z"
    "PULSE_NOW=2026-09-27T02:00:00Z"
    # A nonexistent directory, not the real ~/loki-ci-logs: without this,
    # every test below would read the ACTUAL host's push-log mtimes for
    # TRAIN_LATE, making exact-VIOLATION assertions (T2, T11) depend on real
    # host state instead of the fixture. Dedicated TRAIN_LATE tests (T29)
    # override this explicitly.
    "PULSE_PUSH_LOG_DIR=$WORK/no-such-push-logs"
    # S-109: without these, HIGH_LOAD/ORPHAN_TEST/STRAY_CONTAINER would read
    # THIS machine's real load, process table and docker daemon, making
    # exact-VIOLATION assertions depend on host state instead of the
    # fixture (a real stray container or a loaded CI box would fire them
    # unpredictably). Dedicated tests (T34-T36) override these explicitly.
    # No PULSE_RELEASE_TESTS default needed: FAKE_REPO never touches VERSION,
    # so RELEASE_ON_RED reads n/a rather than UNKNOWN (see resolve_version_bump_sha).
    "PULSE_LOADAVG=1.00 1.00 1.00"
    "PULSE_PS_OUTPUT=  PID  PPID     ELAPSED COMMAND"
    "PULSE_DOCKER_PS="
)

assert_exact_violations() {
    # assert_exact_violations "case name" "expected\nlines"
    local name="$1" expected="$2"
    local actual
    actual="$(printf '%s\n' "$OUT" | grep '^VIOLATION:' || true)"
    if [ "$actual" = "$expected" ]; then
        ok "$name: exact VIOLATION block matches"
    else
        bad "$name: VIOLATION block mismatch"
        echo "  --- expected ---"
        printf '%s\n' "$expected"
        echo "  --- actual ---"
        printf '%s\n' "$actual"
    fi
}

echo "T1 -- idle builders (fewer than 6 active builder worktrees while ready slices exist)"
BOARD_IDLE="$WORK/BOARD-idle.md"
cat > "$BOARD_IDLE" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | |
| S-03 | a | x | LOW | building@2026-09-27T01:00Z | |
EOF
# PULSE_NOW for COMMON_ARGS is 2026-09-27T02:00:00Z = epoch 1790474400. One
# worktree active 5 minutes ago, plus five more aged 120 minutes (over the
# 30-minute cutoff) -- both to prove the filter actually filters (a mutant
# that deletes the age check would count all six as active, not one).
WT1="$WORK/wt1"; mkdir -p "$WT1"; make_worktree "$WT1" 5 1790474400
WT1_STALE=()
for i in 1 2 3 4 5; do
    d="$WORK/wt1stale$i"; mkdir -p "$d"; make_worktree "$d" 120 1790474400
    WT1_STALE+=("$d")
done
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_IDLE" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "$WT1" "${WT1_STALE[@]}")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Active builder worktrees (last 30 min): 1 of 6 checked"; then
    ok "worktree age filter: 1 of 6 counted active (5 stale ones correctly excluded)"
else
    bad "worktree age filter mismatch: output follows"
    printf '%s\n' "$OUT"
fi
EXPECTED_T1="VIOLATION: AGENT_OVER_BUDGET: agent(s) past their role/tier time budget: S-03 building LOW (60.0 min, budget 15 min)
VIOLATION: IDLE_BUILDERS: only 1 active builder worktree(s) while 2 ready slice(s) exist on BOARD (S-01, S-02)
VIOLATION: LOW_READY: only 2 ready slice(s) on BOARD (want at least 8); cut 6 more"
assert_exact_violations "T1 IDLE_BUILDERS" "$EXPECTED_T1"

echo "T1b -- E-91: ID_RE is not a hardcoded prefix whitelist; G-02 and E-98a rows are counted"
# Before E-91, ID_RE = (GF|PF|S|E|EV|M)-\d+ made a G- prefix and any lettered
# sub-slice suffix (E-98a) invisible to parse_board: never counted, never
# budget-checked. Both rows below are 60 minutes into a 15-minute LOW budget,
# same as T1's S-03, so a fixed AGENT_OVER_BUDGET violation naming both proves
# they were parsed and counted, not silently skipped.
BOARD_NEWPREFIX="$WORK/BOARD-newprefix.md"
cat > "$BOARD_NEWPREFIX" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| G-02 | a | x | LOW | building@2026-09-27T01:00Z | |
| E-98a | a | x | LOW | building@2026-09-27T01:00Z | |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_NEWPREFIX"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: AGENT_OVER_BUDGET:" \
    && printf '%s\n' "$OUT" | grep -qF "G-02 building LOW (60.0 min, budget 15 min)" \
    && printf '%s\n' "$OUT" | grep -qF "E-98a building LOW (60.0 min, budget 15 min)"; then
    ok "a G-02 row and a lettered E-98a row are both parsed and budget-checked"
else
    bad "T1b new-prefix case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T2 -- merged-but-unreleased slice older than 30 min, CI green"
BOARD_UNRELEASED="$WORK/BOARD-unreleased.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6; do echo "| S-0$i | a | x | LOW | building@2026-09-27T01:00Z | |"; done
    for i in 7 8 9; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
    for i in 10 11 12 13 14; do echo "| S-$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
    echo "| S-15 | a | x | LOW | merged@2026-09-27T01:00Z | |"
} > "$BOARD_UNRELEASED"
(
    cd "$FAKE_REPO" || exit 1
    echo "change" > file.txt
    git add file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased change"
)
UNRELEASED_SHA="$(cd "$FAKE_REPO" && git rev-parse --short=8 HEAD)"
GH_GREEN_JSON="$WORK/gh-green.json"
printf '[{"status":"completed","conclusion":"success","workflowName":"Tests"}]' > "$GH_GREEN_JSON"
WT_MANY=()
for i in 1 2 3 4 5 6; do
    d="$WORK/wtu$i"; mkdir -p "$d"; make_worktree "$d" 5 1790474400
    WT_MANY+=("$d")
done
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_UNRELEASED" \
    "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_MANY[@]}")"; then rc=0; else rc=$?; fi
EXPECTED_T2="VIOLATION: UNRELEASED_MERGE: S-15 1 commit(s) merged but unreleased for 60.0 minutes since v1.0.0 (oldest $UNRELEASED_SHA) while CI is green
VIOLATION: AGENT_OVER_BUDGET: agent(s) past their role/tier time budget: S-01 building LOW (60.0 min, budget 15 min), S-02 building LOW (60.0 min, budget 15 min), S-03 building LOW (60.0 min, budget 15 min), S-04 building LOW (60.0 min, budget 15 min), S-05 building LOW (60.0 min, budget 15 min), S-06 building LOW (60.0 min, budget 15 min)
VIOLATION: UNDERSTAFFED: 8 ready slice(s) on BOARD but only 6 building (want at least 8 staffed)"
assert_exact_violations "T2 UNRELEASED_MERGE" "$EXPECTED_T2"
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T3 -- main CI red (a failure alongside an in_progress run still fires CI_RED)"
GH_RED_JSON="$WORK/gh-red.json"
python3 -c "
import json
print(json.dumps([
    {'status': 'completed', 'conclusion': 'failure', 'workflowName': 'Lint'},
    {'status': 'in_progress', 'conclusion': None, 'workflowName': 'Tests'},
]))
" > "$GH_RED_JSON"
BOARD_ANY="$WORK/BOARD-any.md"
cat > "$BOARD_ANY" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=cat $GH_RED_JSON"; then rc=0; else rc=$?; fi
head_sha_short="$(cd "$FAKE_REPO" && git rev-parse --short=8 main)"
EXPECTED_T3="VIOLATION: CI_RED: main CI is RED at $head_sha_short (Lint)
VIOLATION: IDLE_BUILDERS: only 0 active builder worktree(s) while 1 ready slice(s) exist on BOARD (S-01)
VIOLATION: LOW_READY: only 1 ready slice(s) on BOARD (want at least 8); cut 7 more"
assert_exact_violations "T3 CI_RED" "$EXPECTED_T3"
if [ "$(printf '%s\n' "$OUT" | grep '^VIOLATION:' | head -1)" = "VIOLATION: CI_RED: main CI is RED at $head_sha_short (Lint)" ]; then
    ok "CI_RED is printed first (priority 1), pinned by exact ordering"
else
    bad "CI_RED not first in the ordered VIOLATIONS block"
    printf '%s\n' "$OUT"
fi

echo "T3b -- cancelled-only CI run is UNKNOWN, never CI_RED"
GH_CANCELLED_JSON="$WORK/gh-cancelled.json"
printf '[{"status":"completed","conclusion":"cancelled","workflowName":"Tests"}]' > "$GH_CANCELLED_JSON"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=cat $GH_CANCELLED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): UNKNOWN" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED"; then
    ok "cancelled-only CI run: UNKNOWN, no CI_RED violation"
else
    bad "cancelled-only case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T3c -- E-75: primary gh call fails, Tests-only fallback says failure -> CI_RED"
GH_FALLBACK_RED_JSON="$WORK/gh-fallback-red.json"
printf '[{"status":"completed","conclusion":"failure","databaseId":4242}]' > "$GH_FALLBACK_RED_JSON"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=false" \
    "PULSE_GH_FALLBACK_CMD=cat $GH_FALLBACK_RED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): RED .*fallback.*run 4242" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED: main CI is RED at $head_sha_short (Tests (fallback))"; then
    ok "primary gh check failed outright, Tests-only fallback resolved it to CI_RED with the run id"
else
    bad "T3c fallback-red case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T3d -- E-75: both primary and fallback fail -> still UNKNOWN, never a fabricated verdict"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=false" \
    "PULSE_GH_FALLBACK_CMD=false"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): UNKNOWN" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED"; then
    ok "primary and fallback both failed: UNKNOWN, no CI_RED violation"
else
    bad "T3d both-fail case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T3e -- E-75: primary fails, Tests-only fallback says success -> GREEN with the run id"
GH_FALLBACK_GREEN_JSON="$WORK/gh-fallback-green.json"
printf '[{"status":"completed","conclusion":"success","databaseId":7}]' > "$GH_FALLBACK_GREEN_JSON"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=false" \
    "PULSE_GH_FALLBACK_CMD=cat $GH_FALLBACK_GREEN_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): GREEN .*fallback.*run 7" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED"; then
    ok "primary failed, Tests-only fallback resolved it to GREEN with the run id"
else
    bad "T3e fallback-green case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T3f -- E-75: primary fails, Tests-only fallback says still running -> PENDING with the run id"
GH_FALLBACK_PENDING_JSON="$WORK/gh-fallback-pending.json"
printf '[{"status":"in_progress","conclusion":null,"databaseId":9}]' > "$GH_FALLBACK_PENDING_JSON"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=false" \
    "PULSE_GH_FALLBACK_CMD=cat $GH_FALLBACK_PENDING_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): PENDING .*fallback.*run 9" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED"; then
    ok "primary failed, Tests-only fallback resolved it to PENDING with the run id"
else
    bad "T3f fallback-pending case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T3g -- E-75: primary SUCCEEDS but is ambiguous (cancelled-only, rc=0), fallback says failure -> CI_RED"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=cat $GH_CANCELLED_JSON" \
    "PULSE_GH_FALLBACK_CMD=cat $GH_FALLBACK_RED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): RED .*fallback.*run 4242" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED: main CI is RED at $head_sha_short (Tests (fallback))"; then
    ok "primary succeeded but ambiguous (cancelled-only): fallback still consulted and resolves to CI_RED"
else
    bad "T3g ambiguous-primary case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T3h -- E-75 precedence: primary resolves cleanly (GREEN); a failing fallback must never override it"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_GH_FALLBACK_CMD=cat $GH_FALLBACK_RED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $head_sha_short): GREEN" \
    && ! printf '%s\n' "$OUT" | grep -q "fallback" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED"; then
    ok "a conclusive primary result is never overridden by the fallback, whatever the fallback says"
else
    bad "T3h precedence case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T4 -- clean case: no violations, full status block still prints, exact ordering"
BOARD_CLEAN="$WORK/BOARD-clean.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
    # UNDERSTAFFED (E-89): 8 ready rows alone would now fire UNDERSTAFFED
    # (fewer than 8 building) on every "clean" test below that reuses this
    # fixture, so it also carries 8 fresh (5 min old, well under the
    # 30-minute MEDIUM budget) building rows -- a genuinely staffed board,
    # not just a ready-heavy one.
    for i in 9 10 11 12 13 14 15 16; do echo "| S-$i | a | x | MEDIUM | building@2026-09-27T01:55:00Z | |"; done
} > "$BOARD_CLEAN"
NPM_TIME_JSON="$WORK/npm-time.json"
# Latest key deliberately "1.0.0", matching FAKE_REPO's v1.0.0 tag exactly
# (S-139's tag-vs-npm-latest cross-check): every test below that reuses this
# fixture keeps its unreleased-merge-age assertions unaffected by that check.
# Dedicated NPM_MISMATCH_JSON below covers the disagreeing case.
python3 -c "
import json
print(json.dumps({
    'created': '2020-01-01T00:00:00.000Z',
    'modified': '2026-09-27T01:55:00.000Z',
    '0.9.0': '2026-09-27T01:00:00.000Z',
    '1.0.0': '2026-09-27T01:50:00.000Z',
}))
" > "$NPM_TIME_JSON"
WT_CLEAN=()
for i in 1 2 3 4 5 6; do
    d="$WORK/wtc$i"; mkdir -p "$d"; make_worktree "$d" 5 1790474400
    WT_CLEAN+=("$d")
done
# One extra worktree aged 120 minutes: proves the "6 of 7 checked" count
# reflects the age filter, not just how many were listed.
WT_CLEAN_STALE="$WORK/wtc-stale"; mkdir -p "$WT_CLEAN_STALE"
make_worktree "$WT_CLEAN_STALE" 120 1790474400
write_moat_sha "$MOAT_RESULT_PASS" "$FAKE_REPO" main
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if [ "$rc" = 0 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^=== v10-pulse status" \
    && printf '%s\n' "$OUT" | grep -q "^BOARD status counts:" \
    && printf '%s\n' "$OUT" | grep -q "^Moat proven (pending-derived, informational, NOT suite-verified):" \
    && printf '%s\n' "$OUT" | grep -qF "Moat proven (measured, PULSE_MOAT_RESULT): 7 of 9" \
    && printf '%s\n' "$OUT" | grep -qF "Active builder worktrees (last 30 min): 6 of 7 checked" \
    && printf '%s\n' "$OUT" | grep -q "^CONTROL.md line count:"; then
    ok "clean case: exit 0, no VIOLATION lines, full status block present, worktree count 6 of 7, measured moat 7 of 9"
else
    bad "clean case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T4b -- clean case but with NO PULSE_MOAT_RESULT: moat regression is UNKNOWN, not falsely clean"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (no PULSE_MOAT_RESULT supplied"; then
    ok "no PULSE_MOAT_RESULT: moat_regression reports UNKNOWN (exit 2), never a false clean"
else
    bad "T4b no-measured-result case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T4c -- BACKLOG 133: a STALE PULSE_MOAT_RESULT (sidecar SHA does not match current main) is UNKNOWN, never a false clean"
# Same real, parseable, clean (7 of 9, no rule failures) MOAT_RESULT_PASS
# fixture as T4 -- proves the false-clean this fixes: without the SHA check,
# this input alone would report exit 0 with no MOAT_REGRESSION violation.
MOAT_RESULT_STALE="$WORK/moat-result-stale.txt"
cp "$MOAT_RESULT_PASS" "$MOAT_RESULT_STALE"
printf '%s\n' "$STALE_SHA" > "${MOAT_RESULT_STALE}.sha"
MAIN_SHA_T4C="$(cd "$FAKE_REPO" && git rev-parse main)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_STALE" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (moat result is stale, measured against ${STALE_SHA:0:8} but main is now at ${MAIN_SHA_T4C:0:8})"; then
    ok "stale sidecar SHA: moat_regression reports UNKNOWN with the stale reason, never a false clean"
else
    bad "T4c stale-sha case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T4d -- BACKLOG 133: a PULSE_MOAT_RESULT with NO sidecar SHA at all is UNKNOWN, never a confident verdict"
# A real FAIL result (would otherwise fire MOAT_REGRESSION) with no
# "<file>.sha" sidecar present -- the older-style capture with no provenance.
# Must fail closed to UNKNOWN, not fire the violation and not read as clean.
MOAT_RESULT_NO_SHA="$WORK/moat-result-no-sha.txt"
cp "$MOAT_RESULT_FAIL" "$MOAT_RESULT_NO_SHA"
rm -f "${MOAT_RESULT_NO_SHA}.sha"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_NO_SHA" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (PULSE_MOAT_RESULT has no provenance:"; then
    ok "no sidecar SHA: moat_regression reports UNKNOWN, never a confident verdict from unprovenanced input"
else
    bad "T4d no-sha case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T5 -- CONTROL.md over the 40-line budget"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OVERSIZE" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] && printf '%s\n' "$OUT" | grep -qF "VIOLATION: CONTROL_OVERSIZE: docs/v10/CONTROL.md is 50 lines (budget is 40); trim 10 line(s)"; then
    ok "exact CONTROL_OVERSIZE violation line fires, exit 1"
else
    bad "CONTROL_OVERSIZE case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T5b -- STALE_PROGRESS: a fresh PROGRESS.md entry (10 min old) does not fire"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: STALE_PROGRESS" \
    && printf '%s\n' "$OUT" | grep -qF "PROGRESS.md last entry: 10 min ago"; then
    ok "fresh PROGRESS.md entry: no STALE_PROGRESS violation"
else
    bad "T5b fresh-entry case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T5c -- STALE_PROGRESS: a 36-minute-old entry (over the 35-minute budget) fires"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PROGRESS_MD=$PROGRESS_STALE" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: STALE_PROGRESS: PROGRESS.md last updated 36 min ago (budget 35)" \
    && printf '%s\n' "$OUT" | grep -qF "NEXT ACTION: STALE_PROGRESS: append a PROGRESS.md entry: Part 1 gate numbers, Part 2 slices done, top blocker"; then
    ok "36-minute-old PROGRESS.md entry fires STALE_PROGRESS with the matching NEXT ACTION"
else
    bad "T5c stale-entry case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T5d -- STALE_PROGRESS: a missing PROGRESS.md reports UNKNOWN, never a pass"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PROGRESS_MD=$PROGRESS_MISSING" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: STALE_PROGRESS" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*progress_last_entry" \
    && printf '%s\n' "$OUT" | grep -qF "PROGRESS.md last entry: UNKNOWN (missing $PROGRESS_MISSING or no parseable '## <timestamp>Z' heading)"; then
    ok "missing PROGRESS.md: progress_last_entry reports UNKNOWN, never a false clean"
else
    bad "T5d missing-file case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T5e -- STALE_PROGRESS: a PROGRESS.md with no parseable '## <timestamp>Z' heading reports UNKNOWN"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PROGRESS_MD=$PROGRESS_UNPARSEABLE" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: STALE_PROGRESS" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*progress_last_entry" \
    && printf '%s\n' "$OUT" | grep -qF "PROGRESS.md last entry: UNKNOWN (missing $PROGRESS_UNPARSEABLE or no parseable '## <timestamp>Z' heading)"; then
    ok "unparseable PROGRESS.md headings: progress_last_entry reports UNKNOWN, never a false clean"
else
    bad "T5e unparseable-headings case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T6 -- finding-3 exact repro: pending.txt UNCHANGED (ratchet-legal) between baseline and current,"
echo "      but a measured/live moat result reports FAIL -- MOAT_REGRESSION must still fire, not stay clean"
# pending.txt at HEAD is byte-identical to v1.0.0's (no widening at all, the
# ratchet's most favorable case for the old, broken heuristic) yet the
# measured result (as tests/moat/run.sh would really report, see the P7
# fixture above) says the suite FAILED. The old pending-only logic could
# never flag this: proven-by-absence at both refs reads as "no drop". Fixed
# logic must fire on the measured FAIL regardless. MOAT_RESULT_FAIL's count
# (7 of 9) deliberately equals the baseline's 7 of 9, isolating the
# suite-failed check from the separate count-drop check -- only the fixed
# suite_failed path can explain this violation, so a clean CLEAN_ARGS give a
# meaningful exit-code assertion: exit 1 becomes exit 0 if that check is
# ever reverted (verified: mutation testing exit 0 under the reverted code).
CLEAN_MOAT_ARGS=(
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON"
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"
)
write_moat_sha "$MOAT_RESULT_FAIL" "$FAKE_REPO" main
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT=$MOAT_RESULT_FAIL" \
    "${CLEAN_MOAT_ARGS[@]}"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -qF "Moat proven (pending-derived, informational, NOT suite-verified): 7 of 9" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: MOAT_REGRESSION: measured moat suite reports FAIL (1 rule failure(s))" \
    && [ "$(printf '%s\n' "$OUT" | grep -c '^VIOLATION:')" = 1 ]; then
    ok "unchanged/ratchet-legal pending.txt still correctly flags MOAT_REGRESSION from the measured FAIL (exit 1, the ONLY violation)"
else
    bad "T6 finding-3 repro case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T6c -- measured count drop with no suite failure also fires MOAT_REGRESSION (count-based path)"
MOAT_RESULT_COUNT_DROP="$WORK/moat-result-count-drop.txt"
cat > "$MOAT_RESULT_COUNT_DROP" <<'EOF'
moat: 6 of 9 properties proven
moat suite: no rule failed (6 of 9 proven; the moat is NOT proven)
EOF
write_moat_sha "$MOAT_RESULT_COUNT_DROP" "$FAKE_REPO" main
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT=$MOAT_RESULT_COUNT_DROP"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: MOAT_REGRESSION: measured moat proven count dropped to 6 of 9 (was 7 of 9 pending-derived at last release)"; then
    ok "measured count drop with no live suite failure still fires MOAT_REGRESSION"
else
    bad "T6c count-drop case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi


echo "T7 -- timeout case: all three external calls hang, script still finishes fast with honest UNKNOWNs, exit 2"
SLOW_CMD="$WORK/slow.sh"
cat > "$SLOW_CMD" <<'EOF'
#!/bin/sh
sleep 30
EOF
chmod +x "$SLOW_CMD"
start_ts=$(date +%s)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=$SLOW_CMD" "PULSE_GH_CMD=$SLOW_CMD" "PULSE_WORKTREE_CMD=$SLOW_CMD" \
    "PULSE_GH_STREAK_CMD=$SLOW_CMD" \
    "PULSE_DEADLINE_SECS=2"; then rc=0; else rc=$?; fi
end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))
if [ "$elapsed" -lt 10 ] \
    && printf '%s\n' "$OUT" | grep -q "^Releases (24h): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^Active builder worktrees: UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^CI cancelled streak (Tests, main): UNKNOWN" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: NO_RECENT_RELEASE" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: LOW_RELEASE_VOLUME" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: IDLE_BUILDERS" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_CANCELLED_STREAK" \
    && [ "$rc" = 2 ]; then
    ok "all-hung external calls: UNKNOWN metrics (including the new streak check), no false violation, ${elapsed}s elapsed (< 10s), exit 2"
else
    bad "timeout case: rc=$rc elapsed=${elapsed}s output follows"
    printf '%s\n' "$OUT"
fi

echo "T7b -- npm hangs alone; gh still answers (finish_proc timeout floor, not starved to UNKNOWN)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=$SLOW_CMD" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")" \
    "PULSE_DEADLINE_SECS=3"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Releases (24h): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^Main CI (main @ .*): GREEN"; then
    ok "npm-only hang: releases UNKNOWN but Main CI still resolves GREEN (not starved)"
else
    bad "npm-only-hang case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T8 -- unreadable BOARD.md: other metrics still print, exit 2, no false violation"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$WORK/does-not-exist.md"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && printf '%s\n' "$OUT" | grep -q "^BOARD.md: UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^CONTROL.md line count:" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:"; then
    ok "missing BOARD.md: UNKNOWN reported, rest of block prints, exit 2, no false violation"
else
    bad "missing BOARD.md case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T9 -- moat baseline UNKNOWN when the last-release tag is unreadable (not 'no prior release')"
NO_GIT_REPO="$WORK/no-git-repo"
mkdir -p "$NO_GIT_REPO/tests/moat"
printf 'P1.case-a milestone reason\n' > "$NO_GIT_REPO/tests/moat/pending.txt"
if run_pulse "PULSE_REPO_ROOT=$NO_GIT_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO")" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
# No .git at all in NO_GIT_REPO: the pending-derived informational count is
# now read via `git show MAIN_REF:...` (never the raw working tree, per
# finding 1's fix applied here too), so with no git repository present at
# all it correctly reads UNKNOWN rather than falling back to a working-tree
# file read that would silently ignore PULSE_MAIN_REF.
if printf '%s\n' "$OUT" | grep -qF "Moat proven (pending-derived, informational, NOT suite-verified): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_baseline" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_proven"; then
    ok "moat baseline AND pending-derived count both UNKNOWN (no .git at all), reported honestly, not as 'no prior release'"
else
    bad "moat-baseline-unknown case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T9b -- BACKLOG 133 supersedes the old contract here: with NO .git at all, PULSE_MAIN_REF's HEAD"
echo "      cannot be resolved either, so SHA provenance can't be verified -- a measured FAIL must now"
echo "      report UNKNOWN (fail closed), NOT fire MOAT_REGRESSION, even though the result itself parses"
# Before BACKLOG 133's SHA-pinning fix, this case fired MOAT_REGRESSION
# because the suite-FAIL check did not need the pending-derived baseline at
# all. It now ALSO needs to resolve PULSE_MAIN_REF's current HEAD to verify
# the result's sidecar SHA is current -- and NO_GIT_REPO has no .git, so that
# resolution fails too. A result that cannot be proven current must not be
# trusted to fire a violation, so this correctly downgrades to UNKNOWN.
write_moat_sha "$MOAT_RESULT_FAIL" "$FAKE_REPO" main
if run_pulse "PULSE_REPO_ROOT=$NO_GIT_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO")" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_FAIL" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
# rc=1 here, not 2: BOARD_CLEAN's 8 ready slices with zero builder worktrees
# passed independently fire IDLE_BUILDERS -- an unrelated, correct violation
# from this fixture's shape. The assertion below isolates the thing this test
# actually verifies: MOAT_REGRESSION must NOT be among the fired violations,
# and moat_regression must be UNKNOWN with the provenance-unresolvable reason.
# This fixture also has no resolvable main_sha (no .git at all), so main_ci
# itself reads UNKNOWN here too -- IDLE_BUILDERS firing anyway is exactly
# finding 3's contract: an UNKNOWN main-CI reading must never suppress an
# unrelated violation that should still fire.
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: MOAT_REGRESSION" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*main_ci" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_baseline" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (could not verify PULSE_MOAT_RESULT's provenance: main's current HEAD could not be resolved)" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: IDLE_BUILDERS"; then
    ok "with no .git anywhere, MAIN_REF's HEAD cannot be resolved either, so the measured FAIL correctly downgrades to UNKNOWN instead of firing, AND IDLE_BUILDERS still fires despite main_ci also being UNKNOWN (finding 3)"
else
    bad "T9b baseline-unknown-but-measured case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T10 -- oldest review-pending slice reports the MAXIMUM age, not the minimum"
BOARD_REVIEWS="$WORK/BOARD-reviews.md"
cat > "$BOARD_REVIEWS" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | review@2026-09-27T01:50Z | |
| S-02 | a | x | LOW | review@2026-09-27T01:40Z | |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_REVIEWS"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Oldest review-pending slice: S-02 (20.0 min)" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: REVIEW_STALE"; then
    ok "oldest review-pending slice is the one with the LARGEST age (S-02, 20 min), no REVIEW_STALE (under 45)"
else
    bad "oldest-review-age case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T11 -- everything-except-CI_RED fires together, in the spec's fixed priority order"
BOARD_ALL="$WORK/BOARD-all.md"
cat > "$BOARD_ALL" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | review@2026-09-27T01:00Z | |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | |
EOF
NPM_OLD_JSON="$WORK/npm-old.json"
# Same "1.0.0" convention as NPM_TIME_JSON above, matching v1.0.0 exactly so
# S-139's tag-vs-npm-latest cross-check stays a no-op here too.
python3 -c "
import json
print(json.dumps({
    'created': '2020-01-01T00:00:00.000Z',
    'modified': '2026-09-25T00:00:00.000Z',
    '1.0.0': '2026-09-25T00:00:00.000Z',
}))
" > "$NPM_OLD_JSON"
(
    cd "$FAKE_REPO" || exit 1
    printf 'P1.case-a milestone reason\nP2.case-b milestone reason\nP3.case-c milestone reason\n' > tests/moat/pending.txt
    echo "change" > file2.txt
    git add file2.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased change 2"
)
write_moat_sha "$MOAT_RESULT_FAIL" "$FAKE_REPO" main
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ALL" \
    "PULSE_NPM_CMD=cat $NPM_OLD_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_FAIL" \
    "PULSE_SWARM_START=2026-09-01T00:00Z"; then rc=0; else rc=$?; fi
UNRELEASED_ALL_SHA="$(cd "$FAKE_REPO" && git rev-parse --short=8 main)"
EXPECTED_ALL="VIOLATION: MOAT_REGRESSION: measured moat suite reports FAIL (1 rule failure(s)) -- a live suite failure is always a regression regardless of the proven count (see $MOAT_RESULT_FAIL)
VIOLATION: UNRELEASED_MERGE: 1 commit(s) merged but unreleased for 60.0 minutes since v1.0.0 (oldest $UNRELEASED_ALL_SHA) while CI is green
VIOLATION: RELEASE_CADENCE: 1 merged-unreleased slice commit(s) since v1.0.0, 60.0 minutes since the later of the oldest commit and the release tag while main CI is green (D37 threshold 25)
VIOLATION: REVIEW_STALE: review-pending past 45 minutes: S-01 (60.0 min)
VIOLATION: AGENT_OVER_BUDGET: agent(s) past their role/tier time budget: S-01 review LOW (60.0 min, budget 30 min)
VIOLATION: IDLE_BUILDERS: only 0 active builder worktree(s) while 1 ready slice(s) exist on BOARD (S-02)
VIOLATION: LOW_READY: only 1 ready slice(s) on BOARD (want at least 8); cut 7 more
VIOLATION: NO_RECENT_RELEASE: no release in the last 90 minutes (3000.0 minutes since last release)
VIOLATION: LOW_RELEASE_VOLUME: only 0 release(s) in the last 24h (want at least 30) after 626.0 hours of swarm operation"
assert_exact_violations "T11 all-except-CI_RED" "$EXPECTED_ALL"
EXPECTED_NEXT_ALL="NEXT ACTION: MOAT_REGRESSION: identify which moat property regressed and revert or fix it before any further merge -- measured moat suite reports FAIL (1 rule failure(s)) -- a live suite failure is always a regression regardless of the proven count (see $MOAT_RESULT_FAIL)
NEXT ACTION: UNRELEASED_MERGE: cut a release now, main has been unreleased past the 30-minute budget -- 1 commit(s) merged but unreleased for 60.0 minutes since v1.0.0 (oldest $UNRELEASED_ALL_SHA) while CI is green
NEXT ACTION: RELEASE_CADENCE: cut a release now (D37 cadence) -- 1 merged-unreleased slice commit(s) since v1.0.0, 60.0 minutes since the later of the oldest commit and the release tag while main CI is green (D37 threshold 25)
NEXT ACTION: REVIEW_STALE: escalate or finish review for the named slice(s), they have exceeded the 45-minute budget -- review-pending past 45 minutes: S-01 (60.0 min)
NEXT ACTION: AGENT_OVER_BUDGET: check in on the named agent(s), they have exceeded their role/tier time budget -- agent(s) past their role/tier time budget: S-01 review LOW (60.0 min, budget 30 min)
NEXT ACTION: IDLE_BUILDERS: dispatch more builders against the named ready slice(s) in docs/v10/BOARD.md -- only 0 active builder worktree(s) while 1 ready slice(s) exist on BOARD (S-02)
NEXT ACTION: LOW_READY: the Product Owner should cut the named number of additional slices onto the ready queue -- only 1 ready slice(s) on BOARD (want at least 8); cut 7 more
NEXT ACTION: NO_RECENT_RELEASE: cut a release now, none has shipped in over 90 minutes -- no release in the last 90 minutes (3000.0 minutes since last release)
NEXT ACTION: LOW_RELEASE_VOLUME: investigate why release throughput is below the 30/day target -- only 0 release(s) in the last 24h (want at least 30) after 626.0 hours of swarm operation"
actual_next_all="$(printf '%s\n' "$OUT" | grep '^NEXT ACTION:' || true)"
if [ "$actual_next_all" = "$EXPECTED_NEXT_ALL" ]; then
    ok "T11 NEXT ACTIONS: exact block matches (deleting the whole section would go red here)"
else
    bad "T11 NEXT ACTIONS mismatch"
    echo "  --- expected ---"
    printf '%s\n' "$EXPECTED_NEXT_ALL"
    echo "  --- actual ---"
    printf '%s\n' "$actual_next_all"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T11b -- same fixture, swarm started under 24h ago: LOW_RELEASE_VOLUME must be absent"
(
    cd "$FAKE_REPO" || exit 1
    printf 'P1.case-a milestone reason\nP2.case-b milestone reason\nP3.case-c milestone reason\n' > tests/moat/pending.txt
    echo "change" > file2.txt
    git add file2.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased change 2"
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ALL" \
    "PULSE_NPM_CMD=cat $NPM_OLD_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_SWARM_START=2026-09-27T01:00Z"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: LOW_RELEASE_VOLUME"; then
    ok "swarm started under 24h ago: LOW_RELEASE_VOLUME correctly absent"
else
    bad "T11b: LOW_RELEASE_VOLUME incorrectly fired"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T12 -- D7: an importable cwd cannot shadow a stdlib module the script needs"
SHADOW_DIR="$WORK/shadow-cwd"
mkdir -p "$SHADOW_DIR"
python3 -c "
open('$SHADOW_DIR/calendar.py', 'w').write('raise SystemExit(99)\n')
open('$SHADOW_DIR/json.py', 'w').write('raise SystemExit(99)\n')
"
_prev_pwd="$PWD"
cd "$SHADOW_DIR" || exit 1
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN"; then rc=0; else rc=$?; fi
cd "$_prev_pwd" || exit 1
if [ "$rc" != 99 ] && printf '%s\n' "$OUT" | grep -q "^=== v10-pulse status"; then
    ok "a shadow calendar.py/json.py in cwd cannot hijack the script (rc=$rc, status block printed)"
else
    bad "D7 shadow case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T13 -- excepthook backstop: a bad env var gives PULSE ERROR + exit 2, never an uncaught exit 1"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_DEADLINE_SECS=not-a-number"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] && printf '%s\n' "$OUT" | grep -q "^PULSE ERROR:"; then
    ok "malformed PULSE_DEADLINE_SECS: PULSE ERROR line, exit 2 (not 1)"
else
    bad "excepthook case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T14 -- finding 1: git-derived metrics pin to PULSE_MAIN_REF, not the calling process's own HEAD"
# Build a second tag (v2.0.0) ahead of v1.0.0 on main, add tests/moat/pending.txt
# content that differs between the two tags, then run the script with
# PULSE_REPO_ROOT's HEAD DETACHED at the OLDER tag (v1.0.0) while main has
# moved on to v2.0.0 -- exactly the reviewer's repro ("a scratch checkout at
# an older tag"). If the tag lookup, the moat-baseline read, or the pending-
# derived informational read ever again followed the calling process's own
# HEAD/working-tree instead of PULSE_MAIN_REF, this would resolve v1.0.0
# (2 pending -> 7 of 9) instead of v2.0.0 (0 pending -> 9 of 9), and would
# compute unreleased-merge age from v1.0.0 instead of v2.0.0's (later,
# smaller) commit set.
(
    cd "$FAKE_REPO" || exit 1
    printf '' > tests/moat/pending.txt
    git add tests/moat/pending.txt
    GIT_AUTHOR_DATE="2026-09-25T00:00:00Z" GIT_COMMITTER_DATE="2026-09-25T00:00:00Z" \
        git commit -q -m "close out remaining moat properties"
    git tag v2.0.0
    # One commit after v2.0.0 so "merged but unreleased" has something to
    # measure relative to the NEWER tag, not the older one.
    echo "post-v2 change" > post-v2.txt
    git add post-v2.txt
    GIT_AUTHOR_DATE="2026-09-27T01:30:00Z" GIT_COMMITTER_DATE="2026-09-27T01:30:00Z" \
        git commit -q -m "unreleased after v2.0.0"
    # Detach HEAD at the OLDER tag: this is what a "scratch checkout at an
    # older tag" (the reviewer's repro) looks like. main still points at the
    # tip. PULSE_REPO_ROOT is this same working copy either way -- only HEAD
    # differs from main.
    git checkout -q v1.0.0
)
DETACHED_HEAD_SHA="$(cd "$FAKE_REPO" && git rev-parse --short=8 HEAD)"
MAIN_TIP_SHA="$(cd "$FAKE_REPO" && git rev-parse --short=8 main)"
if [ "$DETACHED_HEAD_SHA" = "$MAIN_TIP_SHA" ]; then
    bad "T14 fixture setup: detached HEAD accidentally matches main tip, test would not discriminate"
fi
MOAT_RESULT_T14="$WORK/moat-result-t14.txt"
cat > "$MOAT_RESULT_T14" <<'EOF'
moat: 9 of 9 properties proven
moat suite: all 9 properties proven
EOF
# BACKLOG 133: the sidecar SHA must likewise be resolved against
# PULSE_MAIN_REF (main's tip), never the calling process's own detached HEAD
# -- write it against main here, so this run stays a real "SHA matches"
# clean measurement rather than tripping the new stale-SHA check.
write_moat_sha "$MOAT_RESULT_T14" "$FAKE_REPO" main
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT=$MOAT_RESULT_T14"; then rc=0; else rc=$?; fi
# Both the pending-derived informational count and the release-baseline read
# via `git show`, so both must resolve against PULSE_MAIN_REF's v2.0.0 (empty
# pending.txt -> 9 of 9), NEVER the detached HEAD's own working tree (which
# still holds v1.0.0's 2 pending ids -> 7 of 9, if either read regressed back
# to a raw file read). The unreleased-merge age must likewise read "since
# v2.0.0", never "since v1.0.0".
if printf '%s\n' "$OUT" | grep -qF "Moat proven (pending-derived, informational, NOT suite-verified): 9 of 9" \
    && printf '%s\n' "$OUT" | grep -qF "Moat proven at last release (pending-derived baseline): 9 of 9" \
    && printf '%s\n' "$OUT" | grep -qF "Moat proven (measured, PULSE_MOAT_RESULT): 9 of 9" \
    && printf '%s\n' "$OUT" | grep -q "since v2.0.0" \
    && ! printf '%s\n' "$OUT" | grep -q "since v1.0.0"; then
    ok "moat pending-derived count, baseline, unreleased-merge age, and the SHA-pinned measured result all resolve against PULSE_MAIN_REF's v2.0.0 tag, not the detached HEAD's v1.0.0"
else
    bad "T14 finding-1 repro case: rc=$rc output follows (HEAD detached at $DETACHED_HEAD_SHA, main at $MAIN_TIP_SHA)"
    printf '%s\n' "$OUT"
fi

echo "T14b -- BACKLOG 133: same fixture, but the sidecar SHA is written against the DETACHED HEAD"
echo "        (the v1.0.0 tag), not main -- must report UNKNOWN as stale, proving the SHA compare"
echo "        pins to PULSE_MAIN_REF and does not silently accept the calling process's own HEAD"
write_moat_sha "$MOAT_RESULT_T14" "$FAKE_REPO" HEAD
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT=$MOAT_RESULT_T14" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (moat result is stale, measured against ${DETACHED_HEAD_SHA} but main is now at ${MAIN_TIP_SHA})"; then
    ok "sidecar SHA pinned to the calling process's own detached HEAD (not main) correctly reports stale/UNKNOWN"
else
    bad "T14b HEAD-vs-main-pinning case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git checkout -q main; git tag -d v2.0.0 >/dev/null; git reset -q --hard v1.0.0)

echo "T15 -- finding 2: merged-but-unreleased age walks --first-parent, not into a merged branch's own history"
# A side branch with a commit dated BEFORE the release tag, merged into main
# AFTER it. Non-first-parent history would find the side commit's original
# (pre-release) timestamp and report a much older "oldest since tag" -- a
# false UNRELEASED_MERGE age. --first-parent must instead report the merge
# commit's own (post-release) time.
(
    cd "$FAKE_REPO" || exit 1
    git checkout -q -b side-branch v1.0.0
    echo "side work" > side.txt
    git add side.txt
    # Committed on the side branch BEFORE v1.0.0 was tagged (backdated,
    # simulating work started earlier and merged much later).
    GIT_AUTHOR_DATE="2026-09-10T00:00:00Z" GIT_COMMITTER_DATE="2026-09-10T00:00:00Z" \
        git commit -q -m "side branch work, authored well before the release"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-27T01:45:00Z" GIT_COMMITTER_DATE="2026-09-27T01:45:00Z" \
        git merge -q --no-ff -m "merge: side branch work" side-branch
)
MERGE_SHA="$(cd "$FAKE_REPO" && git rev-parse --short=8 main)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT="; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Merged-but-unreleased age: 15.0 min (1 commit(s) since v1.0.0, oldest $MERGE_SHA)"; then
    ok "first-parent walk reports the MERGE commit's time (15.0 min), not the side branch's backdated commit"
else
    bad "T15 finding-2 repro case: rc=$rc output follows (merge sha $MERGE_SHA)"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git branch -D side-branch >/dev/null; git reset -q --hard v1.0.0)

echo "T16 -- finding 3 (verdict-line strictness): a bare count line with no terminal verdict line is UNKNOWN"
# A truncated or unrelated capture could contain a "moat: N of 9" substring
# without ever reaching tests/moat/run.sh's actual conclusion. Requiring one
# of its recognized terminal verdict lines guards against reading that as a
# real measurement.
MOAT_RESULT_NO_VERDICT="$WORK/moat-result-no-verdict.txt"
cat > "$MOAT_RESULT_NO_VERDICT" <<'EOF'
some unrelated log noise mentioning moat: 9 of 9 properties proven in passing
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT=$MOAT_RESULT_NO_VERDICT" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (PULSE_MOAT_RESULT file did not contain a parseable"; then
    ok "count line without a terminal verdict line is rejected as UNKNOWN, not treated as a real measurement"
else
    bad "T16 no-verdict-line case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T16b -- finding 3: tests/moat/run.sh's own COULD-NOT-CHECK verdict is never read as a measured clean"
# tests/moat/run.sh exits 2 (could not check, e.g. no release tag reachable)
# and in that case prints "moat suite: COULD NOT CHECK (...)" -- NOT one of
# the PASS/FAIL verdict lines -- even though it still unconditionally prints
# the "moat: N of 9 properties proven" count line first (see tests/moat/run.sh
# around its final echo block). If pulse's verdict-line regex ever matched
# this wording (or matched on the count line alone), a run that could not
# even check the ratchets would silently read as a real measured result.
MOAT_RESULT_COULD_NOT_CHECK="$WORK/moat-result-could-not-check.txt"
cat > "$MOAT_RESULT_COULD_NOT_CHECK" <<'EOF'
could not check: no release tag reachable; fetch tags
moat: 0 of 9 properties proven
moat suite: COULD NOT CHECK (the ratchets did not run; this is not a pass)
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_MOAT_RESULT=$MOAT_RESULT_COULD_NOT_CHECK" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_regression" \
    && printf '%s\n' "$OUT" | grep -qF "Moat regression check: UNKNOWN (PULSE_MOAT_RESULT file did not contain a parseable"; then
    ok "a real 'COULD NOT CHECK' capture is rejected as UNKNOWN, never read as a measured clean"
else
    bad "T16b could-not-check case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T17 -- finding 3 (decoupling): a failed pending-derived read AND an UNKNOWN release baseline do not"
echo "      blank the measured MOAT_REGRESSION check, once its own SHA provenance still checks out"
# A real .git repo (so PULSE_MAIN_REF's HEAD CAN be resolved for the BACKLOG
# 133 SHA check) tagged v1.0.0 but with no tests/moat/pending.txt blob AT
# EITHER the tag or main -- so BOTH the pending-derived informational read
# (`git show main:...`) and the release-baseline read (`git show v1.0.0:...`,
# used by the count-drop path and reported as moat_baseline UNKNOWN) fail on
# their own, while a measured, SHA-matched PULSE_MOAT_RESULT result must
# still be evaluated and still fire on a live suite FAIL. The three checks
# (pending-derived, baseline, measured) are independent safe() calls
# specifically so one's failure cannot silently blank another -- this is the
# same case T9b/T17 covered before BACKLOG 133 (an UNKNOWN baseline must not
# gate the measured suite-FAIL check), reconstructed here with a repo whose
# main IS resolvable so the new SHA check does not also fire. (Pre-BACKLOG-133
# this used NO_GIT_REPO, which had no .git at all -- that now also makes
# MAIN_REF's HEAD unresolvable, which is the different, UNKNOWN-provenance
# case T9b covers instead.)
NO_PENDING_REPO="$WORK/no-pending-repo"
mkdir -p "$NO_PENDING_REPO"
(
    cd "$NO_PENDING_REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    echo "no moat dir here" > README.md
    git add README.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "no tests/moat/pending.txt on this repo"
    git tag v1.0.0
)
write_moat_sha "$MOAT_RESULT_FAIL" "$NO_PENDING_REPO" main
if run_pulse "PULSE_REPO_ROOT=$NO_PENDING_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO")" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_FAIL" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -qF "Moat proven (pending-derived, informational, NOT suite-verified): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*moat_baseline" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: MOAT_REGRESSION: measured moat suite reports FAIL"; then
    ok "pending-derived read AND release-baseline both UNKNOWN (no pending.txt blob anywhere) do not stop the independent, SHA-verified measured-result check from firing"
else
    bad "T17 decoupling case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T18 -- CI_CANCELLED_STREAK: 3 consecutive cancelled Tests runs (skipping the in_progress head) fires"
GH_STREAK_3="$WORK/gh-streak-3.json"
python3 -c "
import json
print(json.dumps([
    {'status': 'in_progress', 'conclusion': None},
    {'status': 'completed', 'conclusion': 'cancelled'},
    {'status': 'completed', 'conclusion': 'cancelled'},
    {'status': 'completed', 'conclusion': 'cancelled'},
    {'status': 'completed', 'conclusion': 'success'},
]))
" > "$GH_STREAK_3"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_STREAK_CMD=cat $GH_STREAK_3"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "CI cancelled streak (Tests, main): 3 consecutive" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: CI_CANCELLED_STREAK: 3 consecutive cancelled Tests runs on main (threshold 3)"; then
    ok "3 consecutive cancelled runs (in_progress head correctly skipped, not counted as a break): CI_CANCELLED_STREAK fires"
else
    bad "T18 streak-fires case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T18b -- CI_CANCELLED_STREAK: non-consecutive cancelled runs never fire"
GH_STREAK_NONCONSEC="$WORK/gh-streak-nonconsec.json"
python3 -c "
import json
print(json.dumps([
    {'status': 'completed', 'conclusion': 'cancelled'},
    {'status': 'completed', 'conclusion': 'cancelled'},
    {'status': 'completed', 'conclusion': 'success'},
    {'status': 'completed', 'conclusion': 'cancelled'},
]))
" > "$GH_STREAK_NONCONSEC"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_STREAK_CMD=cat $GH_STREAK_NONCONSEC"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "CI cancelled streak (Tests, main): 2 consecutive" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_CANCELLED_STREAK"; then
    ok "2 consecutive (broken by an intervening success) stays under threshold, no violation"
else
    bad "T18b non-consecutive case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T18c -- CI_CANCELLED_STREAK: no completed runs at all (all still in progress) is UNKNOWN, not a false 0"
GH_STREAK_NONE_COMPLETED="$WORK/gh-streak-none-completed.json"
printf '[{"status":"in_progress","conclusion":null},{"status":"queued","conclusion":null}]' > "$GH_STREAK_NONE_COMPLETED"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" "PULSE_GH_STREAK_CMD=cat $GH_STREAK_NONE_COMPLETED"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^CI cancelled streak (Tests, main): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*ci_cancelled_streak" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_CANCELLED_STREAK"; then
    ok "no completed runs yet: UNKNOWN, never a false streak of 0"
else
    bad "T18c no-completed-runs case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T19 -- finding 2/3: UNRELEASED_MERGE fires past 45 minutes even when main CI is UNKNOWN"
BOARD_UNRELEASED_UNKNOWN="$WORK/BOARD-unreleased-unknown.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_UNRELEASED_UNKNOWN"
(
    cd "$FAKE_REPO" || exit 1
    echo "change" > file.txt
    git add file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased change, CI unknown"
)
UNRELEASED_UNKNOWN_SHA="$(cd "$FAKE_REPO" && git rev-parse --short=8 HEAD)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_UNRELEASED_UNKNOWN" \
    "PULSE_GH_CMD=cat $GH_CANCELLED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ $UNRELEASED_UNKNOWN_SHA): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: UNRELEASED_MERGE: 1 commit(s) merged but unreleased for 60.0 minutes since v1.0.0 (oldest $UNRELEASED_UNKNOWN_SHA) (CI status: UNKNOWN)"; then
    ok "60-minute unreleased-merge age fires UNRELEASED_MERGE even though main CI reads UNKNOWN (finding 2/3 fixed)"
else
    bad "T19 unreleased-merge-under-unknown-ci case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T19b -- UNRELEASED_MERGE threshold: 40 minutes with UNKNOWN CI does NOT fire (45-min budget pinned)"
(
    cd "$FAKE_REPO" || exit 1
    echo "change" > file.txt
    git add file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:20:00Z" GIT_COMMITTER_DATE="2026-09-27T01:20:00Z" \
        git commit -q -m "unreleased change, 40 min old"
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_UNRELEASED_UNKNOWN" \
    "PULSE_GH_CMD=cat $GH_CANCELLED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Merged-but-unreleased age: 40.0 min" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNRELEASED_MERGE"; then
    ok "40 minutes under UNKNOWN CI stays under the 45-minute independent budget, no violation"
else
    bad "T19b threshold case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T20 -- finding 3: an UNKNOWN main CI reading does not suppress LOW_READY, an unrelated violation"
BOARD_LOW_READY_ONLY="$WORK/BOARD-low-ready-only.md"
cat > "$BOARD_LOW_READY_ONLY" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | |
EOF
WT_T20=()
for i in 1 2 3 4 5 6; do
    d="$WORK/wt20-$i"; mkdir -p "$d"; make_worktree "$d" 5 1790474400
    WT_T20+=("$d")
done
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_LOW_READY_ONLY" \
    "PULSE_GH_CMD=cat $GH_CANCELLED_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_T20[@]}")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ .*): UNKNOWN" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*main_ci" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 1 ready slice(s) on BOARD (want at least 8); cut 7 more" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: IDLE_BUILDERS"; then
    ok "main CI UNKNOWN does not suppress LOW_READY (6 active worktrees correctly means no IDLE_BUILDERS here either)"
else
    bad "T20 unknown-does-not-suppress case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T21 -- AGENT_OVER_BUDGET (S-75, D26 guard 3): LOW builder at 20 min (over the 15-min budget) fires"
BOARD_LOW_BUILDER_OVER="$WORK/BOARD-low-builder-over.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | LOW | building@2026-09-27T01:40Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_LOW_BUILDER_OVER"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_LOW_BUILDER_OVER"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: AGENT_OVER_BUDGET: agent(s) past their role/tier time budget: S-01 building LOW (20.0 min, budget 15 min)"; then
    ok "LOW builder at 20 min (over its 15-min budget): AGENT_OVER_BUDGET fires naming the slice, elapsed time, and budget"
else
    bad "T21 LOW-builder-over case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T21b -- AGENT_OVER_BUDGET: the same LOW builder slice at 10 min (under budget) does NOT fire"
BOARD_LOW_BUILDER_UNDER="$WORK/BOARD-low-builder-under.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | LOW | building@2026-09-27T01:50Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_LOW_BUILDER_UNDER"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_LOW_BUILDER_UNDER"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET"; then
    ok "LOW builder at 10 min (under its 15-min budget): AGENT_OVER_BUDGET correctly does not fire"
else
    bad "T21b LOW-builder-under case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T21c -- AGENT_OVER_BUDGET: HIGH-tier review at 45 min (under its 60-min budget) does NOT fire"
BOARD_HIGH_REVIEW_UNDER="$WORK/BOARD-high-review-under.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | HIGH | review@2026-09-27T01:15Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_HIGH_REVIEW_UNDER"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_HIGH_REVIEW_UNDER"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET"; then
    ok "HIGH review at 45 min (under its 60-min budget): AGENT_OVER_BUDGET correctly does not fire"
else
    bad "T21c HIGH-review-under case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T21d -- AGENT_OVER_BUDGET: HIGH-tier review at 65 min (over its 60-min budget) fires"
BOARD_HIGH_REVIEW_OVER="$WORK/BOARD-high-review-over.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | HIGH | review@2026-09-27T00:55Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_HIGH_REVIEW_OVER"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_HIGH_REVIEW_OVER"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "AGENT_OVER_BUDGET: agent(s) past their role/tier time budget: S-01 review HIGH (65.0 min, budget 60 min)"; then
    ok "HIGH review at 65 min (over its 60-min budget): AGENT_OVER_BUDGET fires"
else
    bad "T21d HIGH-review-over case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T21e -- AGENT_OVER_BUDGET: an active row with no parseable Tier cell reports UNKNOWN, never silently skipped"
BOARD_NO_TIER="$WORK/BOARD-no-tier.md"
{
    echo "| ID | Owner | File set | Status | Notes |"
    echo "|---|---|---|---|---|"
    echo "| S-01 | a | x | building@2026-09-27T01:00Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_NO_TIER"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_NO_TIER"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Agent budget: UNKNOWN for S-01 (no parseable Tier cell on an active row)" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*agent_budget" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET"; then
    ok "no Tier cell on an active building row: reported UNKNOWN, never silently treated as in-budget"
else
    bad "T21e no-tier case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T22 -- S-75 rework: a malformed BOARD.md building@ timestamp (month/day/hour/min all"
echo "      out of range, matches STATUS_TOKEN_RE's digit-shape regex but not a real"
echo "      calendar date) downgrades that row to UNKNOWN instead of crashing the script"
BOARD_BAD_TS_BUILD="$WORK/BOARD-bad-ts-build.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | LOW | building@2026-99-99T99:99Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_BAD_TS_BUILD"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_BAD_TS_BUILD"; then rc=0; else rc=$?; fi
if [ "$rc" = "1" ] \
    && ! printf '%s\n' "$OUT" | grep -q "PULSE ERROR" \
    && printf '%s\n' "$OUT" | grep -q "^=== v10-pulse status" \
    && printf '%s\n' "$OUT" | grep -qF "Agent budget: UNKNOWN for S-01 (no parseable Status timestamp on an active row)" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*agent_budget" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET"; then
    ok "malformed building@ timestamp: no PULSE ERROR, normal violation exit code (1, from LOW_READY), status block renders, row reports UNKNOWN"
else
    bad "T22 bad-timestamp building row: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T23 -- S-75 rework: the same malformed timestamp on a review@ row (REVIEW_STALE's"
echo "      identical pre-existing parse_time_value call) also downgrades to UNKNOWN"
BOARD_BAD_TS_REVIEW="$WORK/BOARD-bad-ts-review.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | LOW | review@2026-99-99T99:99Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_BAD_TS_REVIEW"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_BAD_TS_REVIEW"; then rc=0; else rc=$?; fi
if [ "$rc" = "1" ] \
    && ! printf '%s\n' "$OUT" | grep -q "PULSE ERROR" \
    && printf '%s\n' "$OUT" | grep -q "^=== v10-pulse status" \
    && printf '%s\n' "$OUT" | grep -qF "Review-pending age: UNKNOWN for S-01 (no parseable Status timestamp on a review-pending row)" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*review_pending_age" \
    && printf '%s\n' "$OUT" | grep -qF "Agent budget: UNKNOWN for S-01 (no parseable Status timestamp on an active row)" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: REVIEW_STALE" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET"; then
    ok "malformed review@ timestamp: no PULSE ERROR, normal violation exit code (1, from LOW_READY), status block renders, row reports UNKNOWN"
else
    bad "T23 bad-timestamp review row: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T24 -- AGENT_OVER_BUDGET: a future building@ timestamp stays 'not over budget'"
echo "      (pins existing behavior: negative age is never > any budget)"
BOARD_FUTURE_TS="$WORK/BOARD-future-ts.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    echo "| S-01 | a | x | LOW | building@2026-09-27T03:00Z | |"
    for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_FUTURE_TS"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_FUTURE_TS"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "PULSE ERROR" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET" \
    && ! printf '%s\n' "$OUT" | grep -q "agent_budget"; then
    ok "a building@ timestamp one hour in the future: no AGENT_OVER_BUDGET, no UNKNOWN (negative age parses fine, just never exceeds budget)"
else
    bad "T24 future-timestamp case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

# assert_bad_ts_row <fixture-slug> <building|review> <bad-timestamp> <description>
# -- builds an 8-row BOARD.md with S-01 at the given token@timestamp and 7
# ready rows, then asserts: no PULSE ERROR, normal violation exit code (1,
# from LOW_READY), no AGENT_OVER_BUDGET violation, and the row reports
# UNKNOWN for agent_budget; for a review@ row, also asserts no REVIEW_STALE
# violation and the row reports UNKNOWN for review_pending_age too.
assert_bad_ts_row() {
    local slug="$1" token="$2" ts="$3" desc="$4"
    local board="$WORK/BOARD-$slug.md" pass=1
    {
        echo "| ID | Owner | File set | Tier | Status | Notes |"
        echo "|---|---|---|---|---|---|"
        echo "| S-01 | a | x | LOW | ${token}@${ts} | |"
        for i in 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
    } > "$board"
    if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$board"; then rc=0; else rc=$?; fi
    printf '%s\n' "$OUT" | grep -q "PULSE ERROR" && pass=0
    [ "$rc" = "1" ] || pass=0
    printf '%s\n' "$OUT" | grep -q "^VIOLATION: AGENT_OVER_BUDGET" && pass=0
    printf '%s\n' "$OUT" | grep -qF "Agent budget: UNKNOWN for S-01 (no parseable Status timestamp on an active row)" || pass=0
    printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*agent_budget" || pass=0
    if [ "$token" = "review" ]; then
        printf '%s\n' "$OUT" | grep -q "^VIOLATION: REVIEW_STALE" && pass=0
        printf '%s\n' "$OUT" | grep -qF "Review-pending age: UNKNOWN for S-01 (no parseable Status timestamp on a review-pending row)" || pass=0
        printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*review_pending_age" || pass=0
    fi
    if [ "$pass" = "1" ]; then
        ok "$desc"
    else
        bad "$desc: rc=$rc output follows"
        printf '%s\n' "$OUT"
    fi
}

echo "T25 -- S-75 rework round 2 (re-review REJECT, reproduced): calendar.timegm validates the"
echo "      MONTH via datetime.date(y, mo, 1) but adds day/hour/minute as unchecked arithmetic --"
echo "      a valid month with an out-of-range day must still downgrade to UNKNOWN"
assert_bad_ts_row "bad-day-build" "building" "2026-09-99T10:00Z" \
    "building@ with day=99 (valid month, invalid day): UNKNOWN, no silent false green"
assert_bad_ts_row "bad-day-review" "review" "2026-09-99T10:00Z" \
    "review@ with day=99 (valid month, invalid day): UNKNOWN, no silent false green"

echo "T26 -- round 2: hour=24 (calendar.timegm's unchecked arithmetic would otherwise accept it)"
assert_bad_ts_row "bad-hour24-build" "building" "2026-09-27T24:00Z" \
    "building@ with hour=24: UNKNOWN, no silent false green"
assert_bad_ts_row "bad-hour24-review" "review" "2026-09-27T24:00Z" \
    "review@ with hour=24: UNKNOWN, no silent false green"

echo "T27 -- round 2: minute=61 (the exact reported repro: '2026-09-27T24:61Z' parsed with a"
echo "      negative age and no error before this fix)"
assert_bad_ts_row "bad-min61-build" "building" "2026-09-27T23:61Z" \
    "building@ with minute=61: UNKNOWN, no silent false green"
assert_bad_ts_row "bad-min61-review" "review" "2026-09-27T23:61Z" \
    "review@ with minute=61: UNKNOWN, no silent false green"

echo "T28 -- round 2: Feb 30 (day 30 does not exist in February; before this fix,"
echo "      calendar.timegm's unchecked day arithmetic silently normalized it to March 2"
echo "      and fabricated a real AGENT_OVER_BUDGET violation)"
assert_bad_ts_row "feb30-build" "building" "2026-02-30T10:00Z" \
    "building@ Feb 30: UNKNOWN, never silently normalized to March 2"
assert_bad_ts_row "feb30-review" "review" "2026-02-30T10:00Z" \
    "review@ Feb 30: UNKNOWN, never silently normalized to March 2"

echo "T29 -- TRAIN_LATE (D27 item 6): fires only with merged-but-unreleased commits AND"
echo "      more than 25 minutes since the last train push"
BOARD_TRAIN="$WORK/BOARD-train.md"
cat > "$BOARD_TRAIN" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | |
EOF
# PULSE_NOW (COMMON_ARGS) = 2026-09-27T02:00:00Z = epoch 1790474400 (see T1).
# 26 min before = 1790472840, 24 min before = 1790472960.

echo "T29c -- does not fire with zero merged-but-unreleased commits, even past 25 minutes"
# Run BEFORE the unreleased commit below is added: FAKE_REPO is still clean
# at v1.0.0 here (no test between the last reset at T20 and this one added a
# commit), so this genuinely exercises the zero-unreleased-commits path.
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_LAST_TRAIN_PUSH=1790472840"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE" \
    && printf '%s\n' "$OUT" | grep -qF "Train push cadence: n/a (no merged-but-unreleased commits)"; then
    ok "TRAIN_LATE does not fire with zero unreleased commits regardless of push age"
else
    bad "T29c TRAIN_LATE-none case: output follows"
    printf '%s\n' "$OUT"
fi

(
    cd "$FAKE_REPO" || exit 1
    echo "train change" > train-file.txt
    git add train-file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased train change"
)

echo "T29a -- fires at 26 minutes since last train push"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_TRAIN" "PULSE_LAST_TRAIN_PUSH=1790472840"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE: 26.0 minutes since the last train push"; then
    ok "TRAIN_LATE fires at 26 minutes with merged-but-unreleased commits present"
else
    bad "T29a TRAIN_LATE-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T29b -- does not fire at 24 minutes (same unreleased commits, under the 25-minute threshold)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_TRAIN" "PULSE_LAST_TRAIN_PUSH=1790472960"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE" \
    && printf '%s\n' "$OUT" | grep -qF "Minutes since last train push: 24.0"; then
    ok "TRAIN_LATE does not fire at 24 minutes"
else
    bad "T29b TRAIN_LATE-24min case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T29d -- UNKNOWN (never a false negative) with no override and no push-*.log directory"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_TRAIN"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*train_late" \
    && printf '%s\n' "$OUT" | grep -qF "Train push cadence: UNKNOWN (no PULSE_LAST_TRAIN_PUSH override, no reflog for refs/remotes/origin/main, and no push-*.log under $WORK/no-such-push-logs)" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE"; then
    ok "TRAIN_LATE reports UNKNOWN, never fires, when neither source is available"
else
    bad "T29d TRAIN_LATE-unknown case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T29e -- PULSE_PUSH_LOG_DIR fallback: newest push-*.log mtime wins over an older one and a non-matching name"
LOGDIR="$WORK/push-logs"
mkdir -p "$LOGDIR"
: > "$LOGDIR/push-old.log"
: > "$LOGDIR/push-new.log"
: > "$LOGDIR/not-a-push-log.txt"
python3 -c "
import os
os.utime('$LOGDIR/push-old.log', (1790472000, 1790472000))
os.utime('$LOGDIR/push-new.log', (1790472840, 1790472840))
os.utime('$LOGDIR/not-a-push-log.txt', (1790400000, 1790400000))
"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_TRAIN" "PULSE_PUSH_LOG_DIR=$LOGDIR"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE: 26.0 minutes"; then
    ok "PULSE_PUSH_LOG_DIR fallback uses the NEWEST push-*.log mtime (26.0 min), ignoring an older log and a non-matching filename"
else
    bad "T29e push-log-dir fallback case: output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T29f -- reflog fallback: a real \`git push\` (how every train is actually pushed,"
echo "      and writes no push-*.log) moves refs/remotes/origin/main's reflog, and that"
echo "      reflog time is read directly, with no override and an empty log dir"
TRAIN_REMOTE_REPO="$WORK/train-remote-repo"
TRAIN_REMOTE_BARE="$WORK/train-remote-bare.git"
mkdir -p "$TRAIN_REMOTE_REPO"
(
    cd "$TRAIN_REMOTE_REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    echo init > f.txt
    git add f.txt
    GIT_AUTHOR_DATE="2026-09-20T00:00:00Z" GIT_COMMITTER_DATE="2026-09-20T00:00:00Z" \
        git commit -q -m "initial"
    git tag v1.0.0
    echo train > train-file.txt
    git add train-file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased train change"
)
git init -q --bare "$TRAIN_REMOTE_BARE"
(
    cd "$TRAIN_REMOTE_REPO" || exit 1
    git remote add origin "$TRAIN_REMOTE_BARE"
    # PULSE_NOW (COMMON_ARGS) = 2026-09-27T02:00:00Z = epoch 1790474400 (see
    # T1/T29). Push 30 seconds before it: GIT_COMMITTER_DATE sets the actual
    # push's reflog timestamp (git records the reflog "when" from the
    # committer ident in effect at push time, not any commit's own date), so
    # the resulting age is deterministic, never a real-wall-clock race.
    GIT_COMMITTER_DATE="2026-09-27T01:59:30Z" git push -q origin main
)

if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_TRAIN" "PULSE_REPO_ROOT=$TRAIN_REMOTE_REPO"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Minutes since last train push: 0\.[0-9]" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE"; then
    ok "refs/remotes/origin/main's reflog (a real git push, no push-*.log written, PULSE_PUSH_LOG_DIR empty) reads under 1 minute"
else
    bad "T29f reflog-fallback case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T29g -- reflog wins over a stale push-*.log: an old log file must never shadow a fresh push"
STALE_LOGDIR="$WORK/push-logs-stale"
mkdir -p "$STALE_LOGDIR"
: > "$STALE_LOGDIR/push-old.log"
python3 -c "
import os
os.utime('$STALE_LOGDIR/push-old.log', (1790400000, 1790400000))
"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_TRAIN" "PULSE_REPO_ROOT=$TRAIN_REMOTE_REPO" \
    "PULSE_PUSH_LOG_DIR=$STALE_LOGDIR"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^Minutes since last train push: 0\.[0-9]" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: TRAIN_LATE"; then
    ok "a fresh reflog wins over a stale push-old.log (~20 hours old, would have fired TRAIN_LATE if used)"
else
    bad "T29g reflog-over-stale-log case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

# T29d above already covers "no reflog and empty log dir yields UNKNOWN": FAKE_REPO
# never gets an origin remote in this suite, so its refs/remotes/origin/main reflog
# lookup fails exactly like a fresh clone with no push history.

echo "T30 -- D26 guard 4: UNEVIDENCED_CLAIM fires on an added claim line with no citation"
# A dedicated, isolated repo (its own docs/v10/BOARD.md and PROGRESS.md, like
# NO_PENDING_REPO above) so this test never depends on or mutates FAKE_REPO's
# shared history. One commit adds a claim word ("verified", "no fix needed")
# to PROGRESS.md with nothing next to it that could count as a citation: no
# backticked command, no rc=/exit, no N/N count, no SHA.
CLAIM_REPO_FLAGGED="$WORK/claim-repo-flagged"
mkdir -p "$CLAIM_REPO_FLAGGED/docs/v10"
(
    cd "$CLAIM_REPO_FLAGGED" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "seed docs"
    printf 'S-99 verified and merged, no fix needed.\n' >> docs/v10/PROGRESS.md
    git add docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" \
        git commit -q -m "docs(v10): S-99 status (unevidenced-claim fixture)"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_FLAGGED" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_FLAGGED")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -qF "Unevidenced-claim check: 2 commit(s) scanned touching BOARD.md/PROGRESS.md, 1 flagged line(s)" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:" \
    && printf '%s\n' "$OUT" | grep -qF "S-99 verified and merged, no fix needed."; then
    ok "an added claim line with no citation fires UNEVIDENCED_CLAIM and quotes the offending line"
else
    bad "T30 flagged case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T30b -- D26 guard 4: a claim line WITH a citation (N/N count + backticked command) is not flagged"
CLAIM_REPO_CLEAN="$WORK/claim-repo-clean"
mkdir -p "$CLAIM_REPO_CLEAN/docs/v10"
(
    cd "$CLAIM_REPO_CLEAN" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "seed docs"
    printf 'S-100 verified: full suite 42/42 passing (`bash tests/run-all-tests.sh`).\n' >> docs/v10/PROGRESS.md
    git add docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" \
        git commit -q -m "docs(v10): S-100 status (evidenced-claim fixture)"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_CLEAN" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_CLEAN")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:" \
    && printf '%s\n' "$OUT" | grep -qF "Unevidenced-claim check: 2 commit(s) scanned touching BOARD.md/PROGRESS.md, 0 flagged line(s)"; then
    ok "a claim line carrying an N/N count and a backticked command is not flagged"
else
    bad "T30b clean case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T30e -- D26 guard 4: an uncited claim later edited to carry a citation (or retracted) is no longer flagged"
# The same uncited line as T30, then a later commit rewrites it with a SHA
# citation, and another uncited line is added then deleted. Neither survives
# verbatim on main, so neither is flagged; a still-present uncited line would be.
CLAIM_REPO_FIXED="$WORK/claim-repo-fixed"
mkdir -p "$CLAIM_REPO_FIXED/docs/v10"
(
    cd "$CLAIM_REPO_FIXED" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" git commit -q -m "seed docs"
    printf 'S-99 verified and merged, no fix needed.\nS-98 fixed.\n' >> docs/v10/PROGRESS.md
    git add docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" git commit -q -m "uncited claims"
    printf '# Progress\nS-99 verified and merged in abc1234def (rc=0).\n' > docs/v10/PROGRESS.md
    git add docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:10:00Z" GIT_COMMITTER_DATE="2026-09-27T00:10:00Z" git commit -q -m "cite S-99, retract S-98"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_FIXED" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_FIXED")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:" \
    && printf '%s\n' "$OUT" | grep -qF "Unevidenced-claim check: 3 commit(s) scanned touching BOARD.md/PROGRESS.md, 0 flagged line(s)"; then
    ok "an uncited claim that was later cited or retracted is not flagged"
else
    bad "T30e cited-or-retracted case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T30f -- D26 guard 4: a BOARD row's Wall-check spec is not a claim; its notes cell still is"
CLAIM_REPO_WALL="$WORK/claim-repo-wall"
mkdir -p "$CLAIM_REPO_WALL/docs/v10"
(
    cd "$CLAIM_REPO_WALL" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" git commit -q -m "seed docs"
    printf '| S-201 | spec row | a.sh | LOW | node --test a.mjs passes | ready@2026-09-27T00:05Z | Source: cut. |\n' >> docs/v10/BOARD.md
    printf '| S-202 | claim row | b.sh | LOW | run b | merged@2026-09-27T00:05Z | Verified and fixed. |\n' >> docs/v10/BOARD.md
    git add docs/v10/BOARD.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" git commit -q -m "rows"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_WALL" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_WALL")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:.*S-202" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:.*S-201" \
    && printf '%s\n' "$OUT" | grep -qF "2 commit(s) scanned touching BOARD.md/PROGRESS.md, 1 flagged line(s)"; then
    ok "a Wall-check spec is not flagged; an uncited notes-cell claim is"
else
    bad "T30f wall-check case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T30g -- D26 guard 4: an M row's title/Wall-check spec cells are not a claim; its notes cell still is"
CLAIM_REPO_MROW="$WORK/claim-repo-mrow"
mkdir -p "$CLAIM_REPO_MROW/docs/v10"
(
    cd "$CLAIM_REPO_MROW" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" git commit -q -m "seed docs"
    printf '| M-01 | a green base is an error until proven | a.ts | LOW | bash a.sh passes | ready@2026-09-27T00:05Z | Source: cut. |\n' >> docs/v10/BOARD.md
    printf '| M-02 | modernize step | b.ts | LOW | run b | merged@2026-09-27T00:05Z | Verified manually. |\n' >> docs/v10/BOARD.md
    git add docs/v10/BOARD.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" git commit -q -m "rows"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_MROW" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_MROW")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:.*M-02" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:.*M-01" \
    && printf '%s\n' "$OUT" | grep -qF "2 commit(s) scanned touching BOARD.md/PROGRESS.md, 1 flagged line(s)"; then
    ok "an M row's title/Wall-check 'green' is not flagged; an uncited notes-cell 'verified' is"
else
    bad "T30g M-row case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T30h -- D26 guard 4: a DEP-03 row's 'green' Wall cell is not a claim; the same word in its Notes cell is"
CLAIM_REPO_DEP="$WORK/claim-repo-dep"
mkdir -p "$CLAIM_REPO_DEP/docs/v10"
(
    cd "$CLAIM_REPO_DEP" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" git commit -q -m "seed docs"
    printf '| DEP-03 | dep row | c.sh | LOW | run green build passes | ready@2026-09-27T00:05Z | Source: cut. |\n' >> docs/v10/BOARD.md
    printf '| DEP-05 | dep row | c.sh | LOW | run build | ready@2026-09-27T00:05Z | Deploy green, no citation. |\n' >> docs/v10/BOARD.md
    git add docs/v10/BOARD.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" git commit -q -m "rows"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_DEP" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_DEP")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:.*DEP-05" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:.*DEP-03" \
    && printf '%s\n' "$OUT" | grep -qF "2 commit(s) scanned touching BOARD.md/PROGRESS.md, 1 flagged line(s)"; then
    ok "'green' in a Wall cell is not flagged (and a non-whitelisted DEP- prefix is still checked); 'green' in the Notes cell with no citation is flagged"
else
    bad "T30h DEP- row case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T31 -- D26 guard 4: a bare 'exit' with no number, and no other citation, is not evidence"
CLAIM_REPO_EXIT="$WORK/claim-repo-exit"
mkdir -p "$CLAIM_REPO_EXIT/docs/v10"
(
    cd "$CLAIM_REPO_EXIT" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "seed docs"
    printf 'S-101 fixed the login exit flow, no test run.\n' >> docs/v10/PROGRESS.md
    git add docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" \
        git commit -q -m "docs(v10): S-101 status (bare-exit fixture)"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_EXIT" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_EXIT")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:" \
    && printf '%s\n' "$OUT" | grep -qF "S-101 fixed the login exit flow, no test run."; then
    ok "a bare 'exit' with no number is not treated as a citation, claim is flagged"
else
    bad "T31 bare-exit case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T32 -- D26 guard 4: an N/N shape that is a date, not a test count, is not evidence"
CLAIM_REPO_DATE="$WORK/claim-repo-date"
mkdir -p "$CLAIM_REPO_DATE/docs/v10"
(
    cd "$CLAIM_REPO_DATE" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '# Board\n' > docs/v10/BOARD.md
    printf '# Progress\n' > docs/v10/PROGRESS.md
    git add docs/v10/BOARD.md docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "seed docs"
    printf 'S-102 verified 9/27 with the team.\n' >> docs/v10/PROGRESS.md
    git add docs/v10/PROGRESS.md
    GIT_AUTHOR_DATE="2026-09-27T00:05:00Z" GIT_COMMITTER_DATE="2026-09-27T00:05:00Z" \
        git commit -q -m "docs(v10): S-102 status (date-shaped-N/N fixture)"
)
if run_pulse "PULSE_REPO_ROOT=$CLAIM_REPO_DATE" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$CLAIM_REPO_DATE")" \
    "PULSE_MOAT_RESULT=" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNEVIDENCED_CLAIM:" \
    && printf '%s\n' "$OUT" | grep -qF "S-102 verified 9/27 with the team."; then
    ok "a date-shaped N/N with no test word next to it is not treated as a citation, claim is flagged"
else
    bad "T32 date-shaped-N/N case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T33 -- network cache (S-104): real gh/npm stubbed on PATH, no *_CMD override"
# Stub gh and npm record every invocation. With no PULSE_*_CMD override the
# script is in cache mode: a fresh cache must mean ZERO network calls; a stale
# one must print STALE with its age and be refreshed in the background; an
# absent one must read UNKNOWN, never a value.
STUB_BIN="$WORK/stub-bin"
CALLS="$WORK/net-calls.log"
CACHE="$WORK/pulse-cache"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<EOF
#!/bin/sh
echo "gh \$*" >> "$CALLS"
printf '[{"status":"completed","conclusion":"success","workflowName":"Tests"}]'
EOF
cat > "$STUB_BIN/npm" <<EOF
#!/bin/sh
echo "npm \$*" >> "$CALLS"
printf '{"created":"2026-01-01T00:00:00.000Z","1.0.0":"2026-09-27T01:30:00.000Z"}'
EOF
chmod +x "$STUB_BIN/gh" "$STUB_BIN/npm"
T33_SHA="$(cd "$FAKE_REPO" && git rev-parse main)"
# write_cache AGE_SECONDS: all three cache entries, written AGE seconds ago
# (real wall clock: cache age deliberately ignores PULSE_NOW).
write_cache() {
    mkdir -p "$CACHE"
    python3 - "$CACHE" "$1" "$T33_SHA" <<'PYEOF'
import json, sys, time
d, age, sha = sys.argv[1], float(sys.argv[2]), sys.argv[3]
t = time.time() - age
recs = {
    "npm": '{"1.0.0":"2026-09-27T01:30:00.000Z"}',
    "gh_ci": '[{"status":"completed","conclusion":"failure","workflowName":"Lint"}]',
    "gh_streak": '[{"status":"completed","conclusion":"success"}]',
    # gh_ci above already resolves cleanly (RED), so the E-75 fallback is
    # never consulted -- this entry only exists so a missing cache file for
    # it does not itself count as a cache miss and force a spurious refresh.
    "gh_fallback": '[{"status":"completed","conclusion":"success","databaseId":1}]',
    # G-02: same reasoning -- without this entry, a governor cache miss alone
    # would force a background refresh (and a real, ~125s usage-governor.py
    # scan) even on the "everything else is fresh" T33a case.
    "governor": '{"calibration":{"opus_weight_assumption":1.4},"window":{"source":"estimate","current_pct":10.0,"current_tokens_output":100},"weekly":{"source":"estimate","current_pct":10.0,"current_tokens_output":100},"governor":{"active_engineers_last_hour":1,"burn_per_engineer_output_last_hour":1000.0,"burn_per_engineer_opus_weighted_last_hour":1000.0,"max_engineers_next_hour":10,"last_hour_output_tokens":0,"hours_to_weekly_reset":100.0}}',
}
for name, out in recs.items():
    json.dump({"t": t, "out": out, "sha": sha if name in ("gh_ci", "gh_fallback") else None},
              open("%s/%s.json" % (d, name), "w"))
PYEOF
}
T33_ARGS=(
    "PATH=$STUB_BIN:$PATH"
    "PULSE_REPO_ROOT=$FAKE_REPO" "PULSE_MAIN_REF=main" "CONTROL_MD=$CONTROL_OK"
    "BOARD_MD=$BOARD_CLEAN" "PULSE_NPM_CMD=" "PULSE_GH_CMD=" "PULSE_GH_STREAK_CMD="
    # Unlike npm/gh above (real binary names, intercepted via PATH stub),
    # the governor's default argv is a real path under $PULSE_REPO_ROOT
    # ($FAKE_REPO here, which has no scripts/usage-governor.py) -- it would
    # fail every refresh forever and keep forcing a fresh npm/gh refresh
    # alongside it too (one shared _need_refresh per run_network() call), so
    # it gets its own working fixture instead, same as GH_STREAK_OK_JSON.
    "PULSE_GOVERNOR_CMD=cat $GOVERNOR_OK_JSON"
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")" "PULSE_MOAT_RESULT="
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"
    "PULSE_PUSH_LOG_DIR=$WORK/no-such-push-logs" "PULSE_CACHE_DIR=$CACHE"
    "PULSE_LOADAVG=1.00 1.00 1.00" "PULSE_PS_OUTPUT=  PID  PPID     ELAPSED COMMAND"
    "PULSE_DOCKER_PS="
)
# wait_refresh: poll (max ~10s) until the background refresher removed its pid file.
wait_refresh() {
    local i=0
    while [ -e "$CACHE/refresh.pid" ] && [ "$i" -lt 50 ]; do
        python3 -c "import time; time.sleep(0.2)"
        i=$((i + 1))
    done
}

# T33a: fresh cache -> no network call at all, cached values used, no refresh.
rm -rf "$CACHE"; : > "$CALLS"
write_cache 5
run_pulse "${T33_ARGS[@]}"; rc=$?
python3 -c "import time; time.sleep(1)"
if [ ! -s "$CALLS" ] && [ ! -e "$CACHE/refresh.pid" ] \
    && printf '%s\n' "$OUT" | grep -q "^Main CI (main @ .*): RED (cached [0-9]*s ago)" \
    && printf '%s\n' "$OUT" | grep -q "^Releases (24h): 1 (cached [0-9]*s ago)" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED: main CI is RED" \
    && ! printf '%s\n' "$OUT" | grep -q "STALE"; then
    ok "fresh cache: zero gh/npm calls, cached values reported with their age, CI_RED still fires"
else
    bad "T33a fresh-cache case: rc=$rc calls=[$(cat "$CALLS")] output follows"
    printf '%s\n' "$OUT"
fi

# T33b: stale cache -> STALE with age (never fresh), background refresh runs.
rm -rf "$CACHE"; : > "$CALLS"
write_cache 600
run_pulse "${T33_ARGS[@]}"; rc=$?
wait_refresh
if printf '%s\n' "$OUT" | grep -q "^Main CI (main @ .*): RED (STALE: cached 6[0-9][0-9]s ago" \
    && printf '%s\n' "$OUT" | grep -q "^STALE metrics .*main_ci (6[0-9][0-9]s)" \
    && ! printf '%s\n' "$OUT" | grep -q "(cached 6[0-9][0-9]s ago)" \
    && grep -q "^gh run list" "$CALLS" && grep -q "^npm view" "$CALLS" \
    && [ ! -e "$CACHE/refresh.pid" ]; then
    : > "$CALLS"
    run_pulse "${T33_ARGS[@]}"
    if [ ! -s "$CALLS" ] && printf '%s\n' "$OUT" | grep -q "^Main CI (main @ .*): GREEN (cached [0-9]*s ago)"; then
        ok "stale cache: STALE with age, background refresh called gh+npm, next run serves the refreshed value with no call"
    else
        bad "T33b post-refresh run: calls=[$(cat "$CALLS")] output follows"
        printf '%s\n' "$OUT"
    fi
else
    bad "T33b stale-cache case: rc=$rc calls=[$(cat "$CALLS")] output follows"
    printf '%s\n' "$OUT"
fi

# T33c: no cache -> UNKNOWN (exit 2), never a value; refresh started.
rm -rf "$CACHE"; : > "$CALLS"
run_pulse "${T33_ARGS[@]}"; rc=$?
wait_refresh
if [ "$rc" = 2 ] \
    && printf '%s\n' "$OUT" | grep -q "^Main CI (main @ .*): UNKNOWN .*background refresh started" \
    && printf '%s\n' "$OUT" | grep -q "^Releases (24h): UNKNOWN" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: CI_RED"; then
    ok "missing cache: UNKNOWN (exit 2), no fabricated value, background refresh started"
else
    bad "T33c missing-cache case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T34 -- D28 rule 3: HIGH_LOAD fires when the 1-min load average is above PULSE_LOAD_MAX (default 28)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_LOADAVG=35.20 10.00 5.00"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: HIGH_LOAD: 1-minute load average 35.20 is above the 28 max"; then
    ok "1-min load average above the default 28 max fires HIGH_LOAD"
else
    bad "T34 HIGH_LOAD-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T34b -- HIGH_LOAD does not fire under a raised PULSE_LOAD_MAX (same load as T34)"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")" "PULSE_LOADAVG=35.20 10.00 5.00" "PULSE_LOAD_MAX=50"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: HIGH_LOAD"; then
    ok "PULSE_LOAD_MAX override raises the threshold, same load no longer fires"
else
    bad "T34b HIGH_LOAD-no-fire case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T35 -- D28 rule 3: ORPHAN_TEST fires on a tests/*.sh|py process with PPID 1, or running past 30 min"
ORPHAN_PS_FIRE="  PID  PPID     ELAPSED COMMAND
  100     1      00:02:00 tests/test-a.sh --flag
  200  6789      00:45:00 tests/test-b.py --slow"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PS_OUTPUT=$ORPHAN_PS_FIRE"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: ORPHAN_TEST: pid 100 etime 00:02:00: tests/test-a.sh --flag" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: ORPHAN_TEST: pid 200 etime 00:45:00: tests/test-b.py --slow"; then
    ok "a parentless (PPID 1) tests/ process and a 45-minute-old one both fire ORPHAN_TEST, PID/etime/command reported, never killed"
else
    bad "T35 ORPHAN_TEST-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T35b -- ORPHAN_TEST does not fire on a normal tests/ process, or a parentless non-tests process"
ORPHAN_PS_CLEAN="  PID  PPID     ELAPSED COMMAND
  300  6789      00:02:00 tests/test-c.sh
  400     1      00:01:00 some-other-daemon --arg"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")" "PULSE_PS_OUTPUT=$ORPHAN_PS_CLEAN"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: ORPHAN_TEST"; then
    ok "a short-lived non-parentless tests/ process, and a parentless non-tests process, neither fires ORPHAN_TEST"
else
    bad "T35b ORPHAN_TEST-no-fire case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T35c -- E-00: ORPHAN_WORKTREE fires on a 24h .claude/worktrees/ run.sh and a 35-minute /tmp/loki-run-*.sh, both from the SAME ps listing as ORPHAN_TEST"
ORPHAN_WT_PS_FIRE="  PID  PPID     ELAPSED COMMAND
  500  6789   1-00:00:00 bash /repo/.claude/worktrees/agent-afe77b46/autonomy/run.sh
  600  6789      00:35:00 bash /tmp/loki-run-e6I21L.sh"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PS_OUTPUT=$ORPHAN_WT_PS_FIRE" "PULSE_PROC_CWD_JSON={\"600\": \"/tmp/loki-moat-p6.X/intr/repo\"}"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: ORPHAN_WORKTREE: pid 500 etime 1-00:00:00: bash /repo/.claude/worktrees/agent-afe77b46/autonomy/run.sh" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: ORPHAN_WORKTREE: pid 600 etime 00:35:00: bash /tmp/loki-run-e6I21L.sh"; then
    ok "a 24h .claude/worktrees/ run.sh and a 35-minute /tmp/loki-run-*.sh both fire ORPHAN_WORKTREE, PID/etime/command reported, never killed"
else
    bad "T35c ORPHAN_WORKTREE-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T35f -- a backgrounded user 'loki start' (/tmp/loki-run-*.sh, cwd in a project checkout) is not an orphan; the same script with a temp-root cwd is"
ORPHAN_WT_PS_USER="  PID  PPID     ELAPSED COMMAND
  610     1      01:53:00 bash /tmp/loki-run-kf6HzN.sh .loki/prd-issue-52.md --provider claude
  620     1      01:30:00 bash /tmp/loki-run-9xdJsg.sh"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PS_OUTPUT=$ORPHAN_WT_PS_USER" "PULSE_PROC_CWD_JSON={\"610\": \"/Users/someone/git/augmentiq\", \"620\": \"/tmp/loki-moat-p6.Y/intr/repo\"}"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: ORPHAN_WORKTREE: pid 610 " \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: ORPHAN_WORKTREE: pid 620 etime 01:30:00: bash /tmp/loki-run-9xdJsg.sh"; then
    ok "a live user run in a project checkout is not flagged; a temp-root fixture run is"
else
    bad "T35f user-run vs fixture-run case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T35d -- ORPHAN_WORKTREE does not fire on a 5-minute worktree process, or an unrelated long-running process"
ORPHAN_WT_PS_CLEAN="  PID  PPID     ELAPSED COMMAND
  700  6789      00:05:00 bash /repo/.claude/worktrees/agent-fresh/autonomy/run.sh
  800  6789      01:30:00 some-other-daemon --arg"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")" "PULSE_PS_OUTPUT=$ORPHAN_WT_PS_CLEAN"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: ORPHAN_WORKTREE"; then
    ok "a 5-minute-old worktree process, and an unrelated long-running non-worktree process, neither fires ORPHAN_WORKTREE"
else
    bad "T35d ORPHAN_WORKTREE-no-fire case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T35e -- PULSE_ORPHAN_WORKTREE_MAX_MIN overrides the default 30-minute threshold"
ORPHAN_WT_PS_15MIN="  PID  PPID     ELAPSED COMMAND
  900  6789      00:15:00 bash /repo/.claude/worktrees/agent-x/autonomy/run.sh"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PS_OUTPUT=$ORPHAN_WT_PS_15MIN"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: ORPHAN_WORKTREE"; then
    ok "a 15-minute worktree process does not fire under the default 30-minute threshold"
else
    bad "T35e default-threshold case unexpectedly fired: output follows"
    printf '%s\n' "$OUT"
fi
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PS_OUTPUT=$ORPHAN_WT_PS_15MIN" "PULSE_ORPHAN_WORKTREE_MAX_MIN=10"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: ORPHAN_WORKTREE: pid 900 etime 00:15:00: bash /repo/.claude/worktrees/agent-x/autonomy/run.sh"; then
    ok "PULSE_ORPHAN_WORKTREE_MAX_MIN=10 makes the same 15-minute process fire"
else
    bad "T35e override case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T36 -- D28 rule 3: STRAY_CONTAINER fires on a swarm container over 1h old, or with a non-'no' restart policy"
DOCKER_PS_FIRE="abc123456789	loki-build-9	90		no
def456789abc	s1-worker	5		always"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_DOCKER_PS=$DOCKER_PS_FIRE"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: STRAY_CONTAINER: loki-build-9 (abc123456789): age 90 min" \
    && printf '%s\n' "$OUT" | grep -qF "VIOLATION: STRAY_CONTAINER: s1-worker (def456789abc): restart policy always"; then
    ok "a container over 1h old, and a container with a non-'no' restart policy, both fire STRAY_CONTAINER"
else
    bad "T36 STRAY_CONTAINER-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T36b -- STRAY_CONTAINER does not fire on a recent compliant container, or a non-swarm-named one"
DOCKER_PS_CLEAN="111122223333	loki-build-1	30		no
444455556666	unrelated-app	200		no"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")" "PULSE_DOCKER_PS=$DOCKER_PS_CLEAN"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: STRAY_CONTAINER"; then
    ok "a recent compliant swarm container, and an old non-swarm-named container, neither fires STRAY_CONTAINER"
else
    bad "T36b STRAY_CONTAINER-no-fire case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T37 -- D28 rule 2: RELEASE_ON_RED fires when the newest VERSION-bump commit's cached Tests conclusion is failure/cancelled"
RELEASE_REPO="$WORK/release-repo"
mkdir -p "$RELEASE_REPO"
(
    cd "$RELEASE_REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    printf '9.0.0\n' > VERSION
    git add VERSION
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "release: v9.0.0"
)
RELEASE_ARGS=(
    "PULSE_REPO_ROOT=$RELEASE_REPO" "PULSE_MAIN_REF=main"
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK"
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=cat $GH_STREAK_OK_JSON"
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$RELEASE_REPO" "${WT_CLEAN[@]}")" "PULSE_MOAT_RESULT="
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"
    "PULSE_PUSH_LOG_DIR=$WORK/no-such-push-logs"
    "PULSE_LOADAVG=1.00 1.00 1.00" "PULSE_PS_OUTPUT=  PID  PPID     ELAPSED COMMAND"
    "PULSE_DOCKER_PS="
)
RELEASE_SHA="$(cd "$RELEASE_REPO" && git rev-parse HEAD)"
if run_pulse "${RELEASE_ARGS[@]}" 'PULSE_RELEASE_TESTS=[{"status":"completed","conclusion":"failure","workflowName":"Tests"}]'; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: RELEASE_ON_RED: the newest VERSION-bump commit on main (${RELEASE_SHA:0:8}) has a failure Tests run"; then
    ok "a failure Tests conclusion for the VERSION-bump SHA fires RELEASE_ON_RED"
else
    bad "T37 RELEASE_ON_RED-failure case: rc=$rc sha=$RELEASE_SHA output follows"
    printf '%s\n' "$OUT"
fi
if run_pulse "${RELEASE_ARGS[@]}" 'PULSE_RELEASE_TESTS=[{"status":"completed","conclusion":"cancelled","workflowName":"Tests"}]'; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: RELEASE_ON_RED: the newest VERSION-bump commit on main (${RELEASE_SHA:0:8}) has a cancelled Tests run"; then
    ok "a cancelled Tests conclusion for the VERSION-bump SHA also fires RELEASE_ON_RED"
else
    bad "T37 RELEASE_ON_RED-cancelled case: rc=$rc sha=$RELEASE_SHA output follows"
    printf '%s\n' "$OUT"
fi

echo "T37b -- RELEASE_ON_RED does not fire on a success Tests conclusion, and reads n/a with no VERSION history"
if run_pulse "${RELEASE_ARGS[@]}" 'PULSE_RELEASE_TESTS=[{"status":"completed","conclusion":"success","workflowName":"Tests"}]'; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_ON_RED" \
    && printf '%s\n' "$OUT" | grep -qF "Release-on-red (newest VERSION bump on main, ${RELEASE_SHA:0:8}): Tests SUCCESS"; then
    ok "a success Tests conclusion for the VERSION-bump SHA does not fire RELEASE_ON_RED"
else
    bad "T37b RELEASE_ON_RED-success case: rc=$rc sha=$RELEASE_SHA output follows"
    printf '%s\n' "$OUT"
fi
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Release-on-red (newest VERSION bump on main): n/a (no commit has ever touched VERSION)"; then
    ok "FAKE_REPO has no VERSION history: RELEASE_ON_RED reads n/a, never UNKNOWN, never a false violation"
else
    bad "T37b no-version-history case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T38 -- S-94: WORKTREE_COUNT does not fire at exactly 15 worktrees under .claude/worktrees"
WT15_LIST=""
for i in $(seq 1 15); do
    WT15_LIST="${WT15_LIST}worktree /repo/.claude/worktrees/wf-${i}
HEAD dead

"
done
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_LIST=$WT15_LIST"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: WORKTREE_COUNT" \
    && printf '%s\n' "$OUT" | grep -qF "Worktrees under .claude/worktrees: 15 (max 15)"; then
    ok "exactly 15 worktrees under .claude/worktrees does not fire WORKTREE_COUNT"
else
    bad "T38 WORKTREE_COUNT-at-max case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T38b -- WORKTREE_COUNT fires at 16 worktrees under .claude/worktrees"
WT16_LIST="${WT15_LIST}worktree /repo/.claude/worktrees/wf-16
HEAD dead

"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_LIST=$WT16_LIST"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: WORKTREE_COUNT: 16 worktrees under .claude/worktrees exceeds the 15 max"; then
    ok "16 worktrees under .claude/worktrees fires WORKTREE_COUNT"
else
    bad "T38b WORKTREE_COUNT-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T39 -- S-139/BACKLOG 136: RELEASED_AHEAD_OF_NPM fires when a released@ row is stamped"
echo "      after npm's own newest publish time"
BOARD_RELEASED_AHEAD="$WORK/BOARD-released-ahead.md"
cat > "$BOARD_RELEASED_AHEAD" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | released@2026-09-27T01:54Z | |
EOF
# NPM_TIME_JSON's newest publish stamp is 2026-09-27T01:50Z (see its fixture
# above); the BOARD row claims a release 4 minutes AFTER that -- npm has no
# record of a publish that recent.
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_RELEASED_AHEAD" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: RELEASED_AHEAD_OF_NPM: S-01 (released@2026-09-27T01:54Z) marked released after npm's newest publish (2026-09-27T01:50Z); npm shows no publish that recent"; then
    ok "released@ row stamped after npm's newest publish fires RELEASED_AHEAD_OF_NPM"
else
    bad "T39 RELEASED_AHEAD_OF_NPM-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T39b -- RELEASED_AHEAD_OF_NPM does not fire when the released@ row is stamped"
echo "       before (or at) npm's newest publish time"
BOARD_RELEASED_OK="$WORK/BOARD-released-ok.md"
cat > "$BOARD_RELEASED_OK" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | released@2026-09-27T01:40Z | |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_RELEASED_OK" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASED_AHEAD_OF_NPM"; then
    ok "released@ row stamped before npm's newest publish does not fire RELEASED_AHEAD_OF_NPM"
else
    bad "T39b RELEASED_AHEAD_OF_NPM-no-fire case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T40 -- S-139/BACKLOG 136: unreleased-merge age reports UNKNOWN, not a confident"
echo "      'N commit(s) since', when the local release tag disagrees with npm's latest version"
# A dedicated, isolated repo (like RELEASE_REPO/CLAIM_REPO_FLAGGED above) so
# this never touches FAKE_REPO's shared v1.0.0 tag history. Exact repro of
# the red-case bullet: local tag v9.54.2, npm's latest published version
# 9.55.0 (from the SAME npm_result computed above -- no second npm call).
TAG_MISMATCH_REPO="$WORK/tag-mismatch-repo"
mkdir -p "$TAG_MISMATCH_REPO"
(
    cd "$TAG_MISMATCH_REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    echo "seed" > file.txt
    git add file.txt
    GIT_AUTHOR_DATE="2026-09-27T00:00:00Z" GIT_COMMITTER_DATE="2026-09-27T00:00:00Z" \
        git commit -q -m "seed"
    git tag v9.54.2
    echo "change" > file2.txt
    git add file2.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "unreleased change after v9.54.2"
)
NPM_MISMATCH_JSON="$WORK/npm-mismatch.json"
python3 -c "
import json
print(json.dumps({
    'created': '2020-01-01T00:00:00.000Z',
    'modified': '2026-09-27T01:50:00.000Z',
    '9.55.0': '2026-09-27T01:50:00.000Z',
}))
" > "$NPM_MISMATCH_JSON"
if run_pulse "${COMMON_ARGS[@]}" "PULSE_REPO_ROOT=$TAG_MISMATCH_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "PULSE_NPM_CMD=cat $NPM_MISMATCH_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$TAG_MISMATCH_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Merged-but-unreleased age: UNKNOWN (local tag v9.54.2 disagrees with npm's latest published version 9.55.0)" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*unreleased_merge_age" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNRELEASED_MERGE" \
    && ! printf '%s\n' "$OUT" | grep -q "commit(s) since v9.54.2"; then
    ok "tag/npm-latest disagreement reports UNKNOWN, never the confident 'N commit(s) since' line"
else
    bad "T40 tag-vs-npm-mismatch case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T40b -- unreleased-merge age reports normally when the local tag AGREES with npm's latest version"
NPM_MATCH_JSON="$WORK/npm-match.json"
python3 -c "
import json
print(json.dumps({
    'created': '2020-01-01T00:00:00.000Z',
    'modified': '2026-09-27T01:50:00.000Z',
    '9.54.2': '2026-09-27T01:50:00.000Z',
}))
" > "$NPM_MATCH_JSON"
UNRELEASED_MISMATCH_SHA="$(cd "$TAG_MISMATCH_REPO" && git rev-parse --short=8 main)"
if run_pulse "${COMMON_ARGS[@]}" "PULSE_REPO_ROOT=$TAG_MISMATCH_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "PULSE_NPM_CMD=cat $NPM_MATCH_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$TAG_MISMATCH_REPO" "${WT_CLEAN[@]}")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Merged-but-unreleased age: 60.0 min (1 commit(s) since v9.54.2, oldest $UNRELEASED_MISMATCH_SHA)"; then
    ok "tag/npm-latest agreement (v9.54.2 == 9.54.2) keeps the normal confident report"
else
    bad "T40b tag-vs-npm-match case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

# touch_mtime FILE AGE_MIN NOW_EPOCH -- creates/updates FILE with an mtime
# AGE_MIN minutes before NOW_EPOCH. Same technique as make_worktree's mtime
# setting above: never the real wall clock, which is already past every
# fixed PULSE_NOW this suite uses.
touch_mtime() {
    local file="$1" age_min="$2" now_epoch="$3"
    mkdir -p "$(dirname "$file")"
    : > "$file"
    python3 -c "
import os
mt = int($now_epoch - $age_min * 60)
os.utime('$file', (mt, mt))
"
}

echo "T41 -- SESSION_STALLED: fires when the loop-active marker is fresh but the newest transcript is older than the 20-minute budget"
# Same clean baseline as T4 (BOARD_CLEAN, NPM_TIME_JSON, GH_GREEN_JSON,
# MOAT_RESULT_PASS, WT_CLEAN/WT_CLEAN_STALE), reused rather than rebuilt, so
# SESSION_STALLED is provably the ONLY thing that can explain the violation.
MARKER_FRESH="$WORK/loop-active-fresh"
touch_mtime "$MARKER_FRESH" 1 1790474400
TRANSCRIPT_DIR_STALE="$WORK/transcripts-stale"
touch_mtime "$TRANSCRIPT_DIR_STALE/a.jsonl" 25 1790474400
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")" \
    "PULSE_LOOP_MARKER=$MARKER_FRESH" "PULSE_TRANSCRIPT_DIR=$TRANSCRIPT_DIR_STALE"; then rc=0; else rc=$?; fi
EXPECTED_T41="VIOLATION: SESSION_STALLED: no assistant turn in 25.0 minutes while the /loop is active (budget 20)"
assert_exact_violations "T41 SESSION_STALLED" "$EXPECTED_T41"
if [ "$rc" = 1 ]; then
    ok "T41: exit code 1"
else
    bad "T41: expected exit 1, got $rc"
fi

echo "T41b -- SESSION_STALLED does not fire when the newest transcript is under the 20-minute budget (marker fresh)"
TRANSCRIPT_DIR_FRESH="$WORK/transcripts-fresh"
touch_mtime "$TRANSCRIPT_DIR_FRESH/a.jsonl" 5 1790474400
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")" \
    "PULSE_LOOP_MARKER=$MARKER_FRESH" "PULSE_TRANSCRIPT_DIR=$TRANSCRIPT_DIR_FRESH"; then rc=0; else rc=$?; fi
if [ "$rc" = 0 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -qF "Minutes since last assistant turn: 5.0 (loop active, budget 20)"; then
    ok "T41b: fresh transcript, no SESSION_STALLED violation, exit 0"
else
    bad "T41b fresh-transcript case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T41c -- SESSION_STALLED does not fire, and is never UNKNOWN, when no loop-active marker exists (stale transcript, no marker)"
NO_SUCH_MARKER="$WORK/no-such-loop-active"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")" \
    "PULSE_LOOP_MARKER=$NO_SUCH_MARKER" "PULSE_TRANSCRIPT_DIR=$TRANSCRIPT_DIR_STALE"; then rc=0; else rc=$?; fi
if [ "$rc" = 0 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && ! printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*session_stalled" \
    && printf '%s\n' "$OUT" | grep -qF "Session stall: n/a (no fresh .loki/state/loop-active marker; /loop not active)"; then
    ok "T41c: no marker, loop not active, n/a, never a violation or UNKNOWN"
else
    bad "T41c no-marker case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T41d -- SESSION_STALLED reports UNKNOWN, not clean, when the transcript dir cannot be listed (marker fresh)"
# Root-safe, deterministic listdir failure (a regular file, never a
# directory) rather than chmod 000, which is a no-op for root -- CI may run
# as root (see tests/test-branch-lifecycle.sh's own comment on this).
NOT_A_DIR="$WORK/transcripts-not-a-dir"
touch_mtime "$NOT_A_DIR" 5 1790474400
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_MOAT_RESULT=$MOAT_RESULT_PASS" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")" \
    "PULSE_LOOP_MARKER=$MARKER_FRESH" "PULSE_TRANSCRIPT_DIR=$NOT_A_DIR"; then rc=0; else rc=$?; fi
if [ "$rc" = 2 ] \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION:" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*session_stalled" \
    && printf '%s\n' "$OUT" | grep -qF "Session stall: UNKNOWN (could not read transcript dir $NOT_A_DIR)"; then
    ok "T41d: unreadable/non-directory transcript dir is UNKNOWN (exit 2), never a false clean"
else
    bad "T41d unreadable-dir case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42 -- E-79: LOW_READY only counts a ready row toward the queue when its Depends-on slices are merged/released; blocked ready rows are named"
BOARD_DEPS="$WORK/BOARD-deps.md"
cat > "$BOARD_DEPS" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| M-01 | modernize step | y | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-02 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-01. |
| M-03 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-02. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 6 ready slice(s) on BOARD (want at least 8); cut 2 more; blocked by dependency: M-03 (needs M-02)" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: M-03 (needs M-02)"; then
    ok "M-02 (deps merged) counts as ready; M-03 (deps only ready) is named as blocked, not counted"
else
    bad "T42 dependency-gated LOW_READY case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42b -- E-79: 'Depends on none.' and an already-merged dependency both count the row as ready (no blocked names)"
BOARD_DEPS_MET="$WORK/BOARD-deps-met.md"
cat > "$BOARD_DEPS_MET" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-06 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| M-01 | modernize step | y | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-02 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-01. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_MET"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qE "^VIOLATION: LOW_READY: only 7 ready slice\(s\) on BOARD \(want at least 8\); cut 1 more\$" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: none"; then
    ok "no unmet dependency: LOW_READY text has no blocked-by-dependency suffix, status line reads none"
else
    bad "T42b deps-met case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42c -- E-79: a lowercase 'depends on' inside unrelated narrative prose is not read as a dependency clause"
BOARD_DEPS_PROSE="$WORK/BOARD-deps-prose.md"
cat > "$BOARD_DEPS_PROSE" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-06 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-07 | a | x | LOW | ready@2026-09-27T01:00Z | Source: wave 1; depends on S-06 Phase A, build then review. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_PROSE"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qE "^VIOLATION: LOW_READY: only 7 ready slice\(s\) on BOARD \(want at least 8\); cut 1 more\$" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: none"; then
    ok "lowercase 'depends on' narrative prose (not the capitalized BOARD.md convention) does not gate S-07"
else
    bad "T42c lowercase-prose case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42d -- E-79-81-r2: IDLE_BUILDERS uses the same dependency-filtered ready set as LOW_READY, so it never names a dependency-blocked row as a dispatch target"
# Reviewer's exact reproduction: M-01 merged, M-02 ready depends-on M-01
# (deps met), M-03 ready depends-on M-02 (deps unmet). Before this fix,
# IDLE_BUILDERS scanned raw board_rows and named M-03 too, contradicting
# LOW_READY's own "blocked by dependency" line in the same run.
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: IDLE_BUILDERS: only 0 active builder worktree(s) while 6 ready slice(s) exist on BOARD (S-01, S-02, S-03, S-04, S-05, M-02)" \
    && ! printf '%s\n' "$OUT" | grep "^VIOLATION: IDLE_BUILDERS" | grep -qF "M-03"; then
    ok "IDLE_BUILDERS names M-02 (deps met) but never M-03 (deps unmet, named by LOW_READY as blocked instead)"
else
    bad "T42d IDLE_BUILDERS dependency-filter case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42e -- E-117: 'Depends on E-98a..c' range shorthand expands to all three ids; an unmerged middle id (E-98b) blocks the row"
BOARD_DEPS_RANGE_LETTER_UNMET="$WORK/BOARD-deps-range-letter-unmet.md"
cat > "$BOARD_DEPS_RANGE_LETTER_UNMET" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| E-98a | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| E-98b | a | x | LOW | ready@2026-09-27T01:00Z | Depends on none. |
| E-98c | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-10 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on E-98a..c. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_RANGE_LETTER_UNMET"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 6 ready slice(s) on BOARD (want at least 8); cut 2 more; blocked by dependency: M-10 (needs E-98b)" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: M-10 (needs E-98b)"; then
    ok "E-98a..c expands to E-98a/E-98b/E-98c; unmerged E-98b blocks M-10 (E-98a and E-98c alone would not have)"
else
    bad "T42e letter-range-unmet case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42f -- E-117: 'Depends on E-98a..c' with all three merged does not block the row"
BOARD_DEPS_RANGE_LETTER_MET="$WORK/BOARD-deps-range-letter-met.md"
cat > "$BOARD_DEPS_RANGE_LETTER_MET" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| E-98a | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| E-98b | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| E-98c | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-10 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on E-98a..c. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_RANGE_LETTER_MET"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 6 ready slice(s) on BOARD (want at least 8); cut 2 more" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: LOW_READY:.*blocked by dependency" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: none"; then
    ok "E-98a, E-98b, E-98c all merged: M-10 counts as ready, not blocked"
else
    bad "T42f letter-range-met case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42g -- E-117: numeric range 'Depends on M-20..M-23' expands to all four ids; an unmerged middle id (M-22) blocks the row"
BOARD_DEPS_RANGE_NUMERIC="$WORK/BOARD-deps-range-numeric.md"
cat > "$BOARD_DEPS_RANGE_NUMERIC" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| M-20 | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-21 | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-22 | a | x | LOW | ready@2026-09-27T01:00Z | Depends on none. |
| M-23 | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-99 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-20..M-23. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_RANGE_NUMERIC"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 6 ready slice(s) on BOARD (want at least 8); cut 2 more; blocked by dependency: M-99 (needs M-22)" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: M-99 (needs M-22)"; then
    ok "M-20..M-23 expands to M-20/M-21/M-22/M-23; unmerged M-22 blocks M-99 (an endpoints-only match would have missed it)"
else
    bad "T42g numeric-range case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T42h -- E-117: a numeric range over the 50-id cap ('M-1..M-9999') is left as literal text, not expanded"
BOARD_DEPS_RANGE_NUMERIC_HUGE="$WORK/BOARD-deps-range-numeric-huge.md"
cat > "$BOARD_DEPS_RANGE_NUMERIC_HUGE" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| M-1 | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-9999 | a | x | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-100 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-1..M-9999. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_RANGE_NUMERIC_HUGE"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 6 ready slice(s) on BOARD (want at least 8); cut 2 more" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: LOW_READY:.*blocked by dependency" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: none"; then
    ok "M-1..M-9999 (9999 ids, over the 50 cap) is left as literal M-1/M-9999 endpoints, not expanded; both merged so M-100 is not blocked"
else
    bad "T42h numeric-range-over-cap case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T43 -- E-80: PROGRESS.md age is never negative; a future entry heading reports FUTURE_TIMESTAMP"
PROGRESS_FUTURE="$WORK/PROGRESS-future.md"
printf '# Progress\n\n## 2026-09-27T03:30:00Z: future entry\n- clock skew or a mistyped heading\n' > "$PROGRESS_FUTURE"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_PROGRESS_MD=$PROGRESS_FUTURE"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "PROGRESS.md last entry: FUTURE_TIMESTAMP (2026-09-27T03:30:00Z is 90 min ahead of now)" \
    && printf '%s\n' "$OUT" | grep -qF "PROGRESS.md last entry: 0 min ago" \
    && ! printf '%s\n' "$OUT" | grep -Eq "PROGRESS\.md last entry: -[0-9]+ min ago" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: STALE_PROGRESS"; then
    ok "a future PROGRESS.md heading reports FUTURE_TIMESTAMP, age clamped to 0, never negative"
else
    bad "T43 future-timestamp case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T44 -- E-81: STRAY_WORKTREE fires on a worktree registered inside the repo root but outside .claude/worktrees"
STRAY_LIST="worktree $FAKE_REPO
HEAD dead
branch refs/heads/main

worktree $FAKE_REPO/.claude/worktrees/wf-ok
HEAD dead

worktree $FAKE_REPO/scratch-worktree
HEAD dead

"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_LIST=$STRAY_LIST"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: STRAY_WORKTREE: worktree(s) registered inside the repo root but outside .claude/worktrees: $FAKE_REPO/scratch-worktree" \
    && printf '%s\n' "$OUT" | grep -qF "Stray worktrees (inside repo root, outside .claude/worktrees): 1"; then
    ok "a worktree inside the repo root but outside .claude/worktrees fires STRAY_WORKTREE, naming the path; the primary and the .claude/worktrees entry do not"
else
    bad "T44 STRAY_WORKTREE case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T44b -- E-81: STRAY_WORKTREE does not fire when every non-primary worktree is under .claude/worktrees, or entirely outside the repo root"
CLEAN_LIST="worktree $FAKE_REPO
HEAD dead
branch refs/heads/main

worktree $FAKE_REPO/.claude/worktrees/wf-ok
HEAD dead

worktree /tmp/an-unrelated-checkout-outside-the-repo
HEAD dead

"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_WORKTREE_LIST=$CLEAN_LIST"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: STRAY_WORKTREE" \
    && printf '%s\n' "$OUT" | grep -qF "Stray worktrees (inside repo root, outside .claude/worktrees): 0"; then
    ok "a .claude/worktrees entry and one entirely outside the repo root both stay clean"
else
    bad "T44b STRAY_WORKTREE-clean case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T44c -- E-81: the repo root for containment is the listing's own primary worktree, never PULSE_REPO_ROOT (this script runs FROM a builder worktree, where those two differ)"
OTHER_ROOT="$WORK/other-root"
DIFFROOT_LIST="worktree $OTHER_ROOT
HEAD dead
branch refs/heads/main

worktree $OTHER_ROOT/.claude/worktrees/wf-ok
HEAD dead

worktree $OTHER_ROOT/scratch-worktree
HEAD dead

"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_REPO_ROOT=$FAKE_REPO" "PULSE_WORKTREE_LIST=$DIFFROOT_LIST"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: STRAY_WORKTREE: worktree(s) registered inside the repo root but outside .claude/worktrees: $OTHER_ROOT/scratch-worktree" \
    && printf '%s\n' "$OUT" | grep -qF "Stray worktrees (inside repo root, outside .claude/worktrees): 1"; then
    ok "a stray under the listing's primary path fires even though PULSE_REPO_ROOT (this run's own worktree) points elsewhere"
else
    bad "T44c primary-vs-PULSE_REPO_ROOT case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T45 -- RELEASE_CADENCE (D37, E-89): fires only with a merged-unreleased slice commit AND"
echo "      main CI green AND more than 25 minutes since the later of its commit time / the release tag"
# PULSE_NOW (COMMON_ARGS) = 2026-09-27T02:00:00Z = epoch 1790474400 (see T1).
# 26 min before = 2026-09-27T01:34:00Z, 24 min before = 2026-09-27T01:36:00Z.
# FAKE_REPO is still clean at v1.0.0 here: nothing between T41d and here adds
# a commit or a tag.

echo "T45a -- fires at 26 minutes with main CI green"
(
    cd "$FAKE_REPO" || exit 1
    echo "cadence change" > cadence-file.txt
    git add cadence-file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:34:00Z" GIT_COMMITTER_DATE="2026-09-27T01:34:00Z" \
        git commit -q -m "unreleased cadence change"
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): 26.0 min, 1 merged-unreleased slice commit(s) since v1.0.0" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE: 1 merged-unreleased slice commit(s) since v1.0.0, 26.0 minutes" \
    && printf '%s\n' "$OUT" | grep -qF "NEXT ACTION: RELEASE_CADENCE: cut a release now (D37 cadence) --"; then
    ok "RELEASE_CADENCE fires at 26 minutes with main CI green"
else
    bad "T45a RELEASE_CADENCE-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T45b -- does not fire at 24 minutes (same shape, under the 25-minute threshold)"
(
    cd "$FAKE_REPO" || exit 1
    echo "cadence change" > cadence-file.txt
    git add cadence-file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:36:00Z" GIT_COMMITTER_DATE="2026-09-27T01:36:00Z" \
        git commit -q -m "unreleased cadence change"
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE" \
    && printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): 24.0 min, 1 merged-unreleased slice commit(s) since v1.0.0"; then
    ok "RELEASE_CADENCE does not fire at 24 minutes"
else
    bad "T45b RELEASE_CADENCE-24min case: output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T45c -- does not fire when main CI is red, even past the threshold"
(
    cd "$FAKE_REPO" || exit 1
    echo "cadence change" > cadence-file.txt
    git add cadence-file.txt
    GIT_AUTHOR_DATE="2026-09-27T01:34:00Z" GIT_COMMITTER_DATE="2026-09-27T01:34:00Z" \
        git commit -q -m "unreleased cadence change"
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_ANY" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_RED_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE" \
    && printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): 26.0 min, 1 merged-unreleased slice commit(s) since v1.0.0"; then
    ok "RELEASE_CADENCE does not fire when main CI is red (the count/age status line is still reported)"
else
    bad "T45c RELEASE_CADENCE-red-main case: output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T45d -- a docs-only commit never counts as a merged-unreleased slice commit"
(
    cd "$FAKE_REPO" || exit 1
    mkdir -p docs
    echo "docs change" > docs/notes.md
    git add docs/notes.md
    GIT_AUTHOR_DATE="2026-09-27T01:34:00Z" GIT_COMMITTER_DATE="2026-09-27T01:34:00Z" \
        git commit -q -m "docs-only change"
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE" \
    && printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): n/a (no merged-unreleased slice commits since v1.0.0)"; then
    ok "a docs-only commit is excluded, RELEASE_CADENCE reads n/a"
else
    bad "T45d RELEASE_CADENCE-docs-only case: output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git reset -q --hard v1.0.0)

echo "T45e -- UNKNOWN, never a silent pass, when the release tag cannot be read"
if run_pulse "PULSE_REPO_ROOT=$NO_GIT_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_CLEAN" "CONTROL_MD=$CONTROL_OK" \
    "PULSE_NPM_CMD=false" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO")" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): UNKNOWN (release tag or commit history could not be read)" \
    && printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*release_cadence" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE"; then
    ok "RELEASE_CADENCE reports UNKNOWN, never fires, when the release tag cannot be read"
else
    bad "T45e RELEASE_CADENCE-unknown-tag case: output follows"
    printf '%s\n' "$OUT"
fi

echo "T47 -- RELEASE_CADENCE walks --first-parent, not into a merged branch's own history (same finding-2 class as T15)"
# A side branch with a commit dated WEEKS before the release tag, merged
# into main only 22 minutes before NOW. Non-first-parent history would find
# the side commit's own ancient timestamp reachable via tag..MAIN_REF and
# report a huge age -- a false RELEASE_CADENCE fire well past the 25-minute
# threshold. --first-parent must instead report the MERGE commit's own
# (recent, under-threshold) landing time.
(
    cd "$FAKE_REPO" || exit 1
    git checkout -q -b cadence-side-branch v1.0.0
    echo "side work" > cadence-side.txt
    git add cadence-side.txt
    GIT_AUTHOR_DATE="2026-09-10T00:00:00Z" GIT_COMMITTER_DATE="2026-09-10T00:00:00Z" \
        git commit -q -m "side branch work, authored weeks before the release"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-27T01:38:00Z" GIT_COMMITTER_DATE="2026-09-27T01:38:00Z" \
        git merge -q --no-ff -m "merge: cadence side branch work" cadence-side-branch
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): 22.0 min, 1 merged-unreleased slice commit(s) since v1.0.0" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE"; then
    ok "first-parent walk reports the MERGE commit's time (22.0 min, under threshold), not the side branch's weeks-old commit"
else
    bad "T47 RELEASE_CADENCE-first-parent case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git branch -D cadence-side-branch >/dev/null; git reset -q --hard v1.0.0)

echo "T47b -- RELEASE_CADENCE classifies a MERGE commit's docs-only changeset correctly (diff against first parent, not 'git show' combined diff)"
(
    cd "$FAKE_REPO" || exit 1
    git checkout -q -b cadence-docs-branch v1.0.0
    mkdir -p docs
    echo "docs work" > docs/cadence-notes.md
    git add docs/cadence-notes.md
    GIT_AUTHOR_DATE="2026-09-27T01:33:00Z" GIT_COMMITTER_DATE="2026-09-27T01:33:00Z" \
        git commit -q -m "docs-only side branch work"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-27T01:34:00Z" GIT_COMMITTER_DATE="2026-09-27T01:34:00Z" \
        git merge -q --no-ff -m "merge: cadence docs-only branch" cadence-docs-branch
)
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=cat $GH_GREEN_JSON" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$FAKE_REPO" "${WT_CLEAN[@]}" "$WT_CLEAN_STALE")"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: RELEASE_CADENCE" \
    && printf '%s\n' "$OUT" | grep -qF "Release cadence (D37): n/a (no merged-unreleased slice commits since v1.0.0)"; then
    ok "a docs-only MERGE commit reads n/a, correctly excluded even though it lands 26 minutes ago"
else
    bad "T47b RELEASE_CADENCE-docs-only-merge case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
(cd "$FAKE_REPO" || exit 1; git branch -D cadence-docs-branch >/dev/null; git reset -q --hard v1.0.0)

echo "T46 -- UNDERSTAFFED (founder 17:22Z, E-89): fires when the dependency-filtered ready count is 8 or"
echo "       more and fewer than 8 BOARD rows are building"
BOARD_UNDERSTAFFED="$WORK/BOARD-understaffed.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_UNDERSTAFFED"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_UNDERSTAFFED"; then rc=0; else rc=$?; fi
if [ "$rc" = 1 ] && printf '%s\n' "$OUT" | grep -qF "VIOLATION: UNDERSTAFFED: 8 ready slice(s) on BOARD but only 0 building (want at least 8 staffed)"; then
    ok "8 ready, 0 building fires UNDERSTAFFED naming both counts, exit 1"
else
    bad "T46 UNDERSTAFFED-fires case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T46b -- UNDERSTAFFED fires on 4 building + 4 review (review does NOT count as staffed, founder's exact wording is 'building'); does not fire once 8 rows are building"
BOARD_MIXED="$WORK/BOARD-mixed-staffed.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
    for i in 9 10 11 12; do echo "| S-$i | a | x | MEDIUM | building@2026-09-27T01:55:00Z | |"; done
    for i in 13 14 15 16; do echo "| S-$i | a | x | MEDIUM | review@2026-09-27T01:55:00Z | |"; done
} > "$BOARD_MIXED"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_MIXED"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: UNDERSTAFFED: 8 ready slice(s) on BOARD but only 4 building (want at least 8 staffed)"; then
    ok "8 ready, 4 building + 4 review still fires UNDERSTAFFED: review is not staffing"
else
    bad "T46b UNDERSTAFFED-review-not-staffed case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

BOARD_STAFFED="$WORK/BOARD-staffed.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6 7 8; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
    for i in 9 10 11 12 13 14 15 16; do echo "| S-$i | a | x | MEDIUM | building@2026-09-27T01:55:00Z | |"; done
} > "$BOARD_STAFFED"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_STAFFED"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNDERSTAFFED"; then
    ok "8 ready, 8 building does not fire UNDERSTAFFED"
else
    bad "T46b UNDERSTAFFED-staffed case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T46c -- UNDERSTAFFED does not fire below the 8-ready floor, even with 0 staffed"
BOARD_UNDERSTAFFED_LOW="$WORK/BOARD-understaffed-low.md"
{
    echo "| ID | Owner | File set | Tier | Status | Notes |"
    echo "|---|---|---|---|---|---|"
    for i in 1 2 3 4 5 6 7; do echo "| S-0$i | a | x | LOW | ready@2026-09-27T01:00Z | |"; done
} > "$BOARD_UNDERSTAFFED_LOW"
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_UNDERSTAFFED_LOW"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNDERSTAFFED"; then
    ok "only 7 ready, 0 staffed: UNDERSTAFFED does not fire (LOW_READY is the applicable violation instead)"
else
    bad "T46c UNDERSTAFFED-below-floor case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T46d -- UNDERSTAFFED reuses the dependency-filtered ready set: 8 raw ready rows but only 7 with deps met stays under the floor"
BOARD_DEPS8="$WORK/BOARD-deps8.md"
cat > "$BOARD_DEPS8" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-06 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| M-01 | modernize step | y | LOW | merged@2026-09-27T01:00Z | Depends on none. |
| M-02 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-01. |
| M-03 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on M-02. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS8"; then rc=0; else rc=$?; fi
if ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: UNDERSTAFFED"; then
    ok "8 raw ready rows but M-03's dependency on M-02 is unmet: filtered count is 7, under the floor, no false UNDERSTAFFED"
else
    bad "T46d UNDERSTAFFED-dependency-filtered case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T48 -- OPUS_SHARE / BUDGET_BURN (D13, D39; G-02): usage governor pulse checks"
# 1 active engineer, burn_per_engineer_output_last_hour=1000, opus_weight=1.4.
# opus_weighted = total + opus_share_frac * total * (weight-1), so 31%% share
# -> weighted=1124, 29%% -> weighted=1116 (see scripts/v10-pulse.sh's
# compute_opus_share_pct comment for the derivation this fixture proves).
GOV_OPUS_31_JSON="$WORK/governor-opus31.json"
cat > "$GOV_OPUS_31_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "weekly": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "governor": {
    "active_engineers_last_hour": 1,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1124.0,
    "max_engineers_next_hour": 10,
    "last_hour_output_tokens": 0,
    "hours_to_weekly_reset": 100.0
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_OPUS_31_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Opus share (active engineers, last hour): 31.0%" \
    && printf '%s\n' "$OUT" | grep -q "^VIOLATION: OPUS_SHARE: opus is 31.0% of active-engineer output tokens" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: BUDGET_BURN"; then
    ok "T48a opus 31%% of last-hour active-engineer output tokens fires OPUS_SHARE"
else
    bad "T48a opus-31%% case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

GOV_OPUS_29_JSON="$WORK/governor-opus29.json"
cat > "$GOV_OPUS_29_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "weekly": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "governor": {
    "active_engineers_last_hour": 1,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1116.0,
    "max_engineers_next_hour": 10,
    "last_hour_output_tokens": 0,
    "hours_to_weekly_reset": 100.0
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_OPUS_29_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Opus share (active engineers, last hour): 29.0%" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: OPUS_SHARE"; then
    ok "T48b opus 29%% of last-hour active-engineer output tokens does not fire OPUS_SHARE"
else
    bad "T48b opus-29%% case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

GOV_WINDOW_86_JSON="$WORK/governor-window86.json"
cat > "$GOV_WINDOW_86_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 86.0, "current_tokens_output": 100},
  "weekly": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "governor": {
    "active_engineers_last_hour": 1,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1000.0,
    "max_engineers_next_hour": 10,
    "last_hour_output_tokens": 0,
    "hours_to_weekly_reset": 100.0
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_WINDOW_86_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: BUDGET_BURN: 5h window projected at 86.0% (ceiling 85%)" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: OPUS_SHARE"; then
    ok "T48c 5h window projection at 86%% fires BUDGET_BURN"
else
    bad "T48c window-86%% case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

GOV_WEEKLY_91_JSON="$WORK/governor-weekly91.json"
cat > "$GOV_WEEKLY_91_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "weekly": {"source": "estimate", "current_pct": 91.0, "current_tokens_output": 100},
  "governor": {
    "active_engineers_last_hour": 1,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1000.0,
    "max_engineers_next_hour": 10,
    "last_hour_output_tokens": 0,
    "hours_to_weekly_reset": 100.0
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_WEEKLY_91_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: BUDGET_BURN: weekly window projected at 91.0% (ceiling 90%)"; then
    ok "T48d weekly projection at 91%% fires BUDGET_BURN"
else
    bad "T48d weekly-91%% case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

GOV_MAX_BELOW_ACTIVE_JSON="$WORK/governor-max-below-active.json"
cat > "$GOV_MAX_BELOW_ACTIVE_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "weekly": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 100},
  "governor": {
    "active_engineers_last_hour": 5,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1000.0,
    "max_engineers_next_hour": 3,
    "last_hour_output_tokens": 0,
    "hours_to_weekly_reset": 100.0
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_MAX_BELOW_ACTIVE_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: BUDGET_BURN: max engineers for next hour (3) is below the 5 currently active"; then
    ok "T48e max_engineers_next_hour (3) below active engineers (5) fires BUDGET_BURN"
else
    bad "T48e max-below-active case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

GOV_UNCALIBRATED_JSON="$WORK/governor-uncalibrated.json"
cat > "$GOV_UNCALIBRATED_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "uncalibrated", "current_pct": null},
  "weekly": {"source": "uncalibrated", "current_pct": null},
  "governor": {
    "active_engineers_last_hour": 0,
    "burn_per_engineer_output_last_hour": null,
    "burn_per_engineer_opus_weighted_last_hour": null,
    "max_engineers_next_hour": null
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_UNCALIBRATED_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "Budget burn (5h window / weekly): UNKNOWN (usage governor uncalibrated)" \
    && printf '%s\n' "$OUT" | grep -q "UNKNOWN metrics:.*budget_burn" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: BUDGET_BURN" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: OPUS_SHARE"; then
    ok "T48f uncalibrated governor: BUDGET_BURN reads UNKNOWN, raises no violation"
else
    bad "T48f uncalibrated case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T48g -- BUDGET_BURN projects forward (D39: 'projected... at window end'), not just current_pct: a"
echo "        window at 50%% now that doubled in the last hour projects to 100%% and fires, though 50%% alone would not"
GOV_WINDOW_GROWTH_JSON="$WORK/governor-window-growth.json"
cat > "$GOV_WINDOW_GROWTH_JSON" <<'EOF'
{
  "calibration": {"opus_weight_assumption": 1.4},
  "window": {"source": "estimate", "current_pct": 50.0, "current_tokens_output": 1000000},
  "weekly": {"source": "estimate", "current_pct": 10.0, "current_tokens_output": 1000000},
  "governor": {
    "active_engineers_last_hour": 1,
    "burn_per_engineer_output_last_hour": 1000.0,
    "burn_per_engineer_opus_weighted_last_hour": 1000.0,
    "max_engineers_next_hour": 10,
    "last_hour_output_tokens": 1000000,
    "hours_to_weekly_reset": 1.0
  }
}
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_CLEAN" "PULSE_GOVERNOR_CMD=cat $GOV_WINDOW_GROWTH_JSON"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: BUDGET_BURN: 5h window projected at 100.0% (ceiling 85%)"; then
    ok "T48g current 50%% window that doubled last hour projects to 100%% and fires BUDGET_BURN (proves this is a projection, not current_pct)"
else
    bad "T48g growth-projection case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi
echo "T49 -- E-107: SESSION_STALLED resolves the transcript dir from the MAIN repo root (git rev-parse --git-common-dir), never the shell's cwd"
SLUG49=$(python3 -c "
import os, re
root = os.path.realpath('$FAKE_REPO')
print('-' + re.sub(r'[^a-zA-Z0-9]', '-', root.lstrip('/')))
")
HOME49="$WORK/home49"
TRANSCRIPT49="$HOME49/.claude/projects/$SLUG49"
mkdir -p "$TRANSCRIPT49"
LOOP_MARKER49="$WORK/loop-active49"
: > "$LOOP_MARKER49"
: > "$TRANSCRIPT49/session.jsonl"
python3 -c "
import os
now = 1790474400  # COMMON_ARGS' PULSE_NOW (2026-09-27T02:00:00Z)
os.utime('$LOOP_MARKER49', (now - 60, now - 60))         # fresh: 1 min old
os.utime('$TRANSCRIPT49/session.jsonl', (now - 300, now - 300))  # 5 min old
"
SESSION_ARGS49=("${COMMON_ARGS[@]}" "HOME=$HOME49" "PULSE_LOOP_MARKER=$LOOP_MARKER49")

if run_pulse "${SESSION_ARGS49[@]}"; then rc=0; else rc=$?; fi
ROOT_LINE49="$(printf '%s\n' "$OUT" | grep '^Minutes since last assistant turn:' || true)"

SUBDIR49="$FAKE_REPO/loki-ts"
mkdir -p "$SUBDIR49"
if run_pulse_from "$SUBDIR49" "${SESSION_ARGS49[@]}"; then rc=0; else rc=$?; fi
SUBDIR_LINE49="$(printf '%s\n' "$OUT" | grep '^Minutes since last assistant turn:' || true)"

if [ -n "$ROOT_LINE49" ] && [ "$ROOT_LINE49" = "$SUBDIR_LINE49" ] \
    && printf '%s\n' "$ROOT_LINE49" | grep -qF "Minutes since last assistant turn: 5.0 "; then
    ok "T49a: running from a subdirectory reports the same minutes-since-last-turn as the repo root ($ROOT_LINE49)"
else
    bad "T49a subdirectory-vs-root case: root=[$ROOT_LINE49] subdir=[$SUBDIR_LINE49]"
fi

echo "T49b -- E-107: from a linked worktree, SESSION_STALLED resolves to the main checkout's transcript dir"
WT49="$WORK/repo-wt49"
git -C "$FAKE_REPO" worktree add -q --detach "$WT49" >/dev/null
if run_pulse "${SESSION_ARGS49[@]}" "PULSE_REPO_ROOT=$WT49"; then rc=0; else rc=$?; fi
WT_LINE49="$(printf '%s\n' "$OUT" | grep '^Minutes since last assistant turn:' || true)"
if [ -n "$WT_LINE49" ] && [ "$WT_LINE49" = "$ROOT_LINE49" ]; then
    ok "T49b: run from a linked worktree resolves the same transcript dir as the main checkout ($WT_LINE49)"
else
    bad "T49b linked-worktree case: rc=$rc expected=[$ROOT_LINE49] actual=[$WT_LINE49] output follows"
    printf '%s\n' "$OUT"
fi
git -C "$FAKE_REPO" worktree remove --force "$WT49" >/dev/null 2>&1 || true

echo "T50 -- MERGED_NOT_RELEASED_STALE (D37, E-90): a 'merged' BOARD row whose own merge"
echo "      commit already reached the latest published tag over-reports the backlog"
MNS_REPO="$WORK/mns-repo"
mkdir -p "$MNS_REPO"
(
    cd "$MNS_REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    echo "seed" > seed.txt
    git add seed.txt
    GIT_AUTHOR_DATE="2026-09-20T00:00:00Z" GIT_COMMITTER_DATE="2026-09-20T00:00:00Z" \
        git commit -q -m "initial"
    git checkout -q -b feature-s01
    echo "s01" > s01.txt
    git add s01.txt
    GIT_AUTHOR_DATE="2026-09-20T00:05:00Z" GIT_COMMITTER_DATE="2026-09-20T00:05:00Z" \
        git commit -q -m "S-01 work"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-20T00:10:00Z" GIT_COMMITTER_DATE="2026-09-20T00:10:00Z" \
        git merge -q --no-ff -m "merge slice-S-01" feature-s01
    git tag v1.0.0
    git checkout -q -b feature-s02
    echo "s02" > s02.txt
    git add s02.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "S-02 work"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-27T01:05:00Z" GIT_COMMITTER_DATE="2026-09-27T01:05:00Z" \
        git merge -q --no-ff -m "merge slice-S-02" feature-s02
)
# S-01's merge commit is an ancestor of v1.0.0 (merged before the tag) --
# its `merged@` row is stale and over-reports the backlog. S-02's merge
# commit landed AFTER v1.0.0, so it is genuinely unreleased and must never
# be named.
BOARD_MNS="$WORK/BOARD-mns.md"
cat > "$BOARD_MNS" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | merged@2026-09-20T00:10Z | |
| S-02 | a | x | LOW | merged@2026-09-27T01:05Z | |
EOF
if run_pulse "PULSE_REPO_ROOT=$MNS_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_MNS" "CONTROL_MD=$CONTROL_OK" "PULSE_PROGRESS_MD=$PROGRESS_FRESH" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$MNS_REPO")" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^VIOLATION: MERGED_NOT_RELEASED_STALE: S-01 (merge " \
    && ! printf '%s\n' "$OUT" | grep -q "S-02 (merge "; then
    ok "MERGED_NOT_RELEASED_STALE names S-01 (merge commit already in v1.0.0), never S-02 (merged after the tag)"
else
    bad "T50 MERGED_NOT_RELEASED_STALE case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T51 -- MERGED_NOT_RELEASED_STALE reports UNKNOWN, never 'none', when a row's ID breaks the"
echo "      underlying git lookup (a real git failure must never read as 'nothing to flag')"
BOARD_MNS_BAD="$WORK/BOARD-mns-bad.md"
cat > "$BOARD_MNS_BAD" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-( | a | x | LOW | merged@2026-09-20T00:10Z | |
EOF
if run_pulse "PULSE_REPO_ROOT=$MNS_REPO" "PULSE_MAIN_REF=main" \
    "BOARD_MD=$BOARD_MNS_BAD" "CONTROL_MD=$CONTROL_OK" "PULSE_PROGRESS_MD=$PROGRESS_FRESH" \
    "PULSE_NPM_CMD=cat $NPM_TIME_JSON" "PULSE_GH_CMD=false" "PULSE_GH_STREAK_CMD=false" \
    "PULSE_WORKTREE_CMD=$(worktree_cmd_for "$MNS_REPO")" \
    "PULSE_SWARM_START=2026-09-26T23:00Z" "PULSE_NOW=2026-09-27T02:00:00Z"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -q "^UNKNOWN metrics:.*merged_not_released_stale" \
    && printf '%s\n' "$OUT" | grep -qF "Merged rows already released (D37/E-90): UNKNOWN (release tag, " \
    && ! printf '%s\n' "$OUT" | grep -qF "Merged rows already released (D37/E-90): none" \
    && ! printf '%s\n' "$OUT" | grep -q "^VIOLATION: MERGED_NOT_RELEASED_STALE"; then
    ok "an ID that breaks the git --grep pattern reports UNKNOWN, never a false 'none'"
else
    bad "T51 MERGED_NOT_RELEASED_STALE-git-failure case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T52 -- E-121: ID_RE accepts a digit-bearing prefix (S41-01); a building S41-01 row is"
echo "      counted and budget-checked, not silently invisible to parse_board"
BOARD_DIGITPREFIX="$WORK/BOARD-digitprefix.md"
cat > "$BOARD_DIGITPREFIX" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S41-01 | a | x | LOW | building@2026-09-27T01:00Z | |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DIGITPREFIX"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: AGENT_OVER_BUDGET:" \
    && printf '%s\n' "$OUT" | grep -qF "S41-01 building LOW (60.0 min, budget 15 min)"; then
    ok "S41-01 (digit-bearing prefix) is parsed and budget-checked"
else
    bad "T52 digit-prefix case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T53 -- E-121: 'Depends on S41-06' (digit-bearing prefix) blocks the ready row when S41-06 is unmerged"
BOARD_DEPS_DIGITPREFIX="$WORK/BOARD-deps-digitprefix.md"
cat > "$BOARD_DEPS_DIGITPREFIX" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-02 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-04 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S-05 | a | x | LOW | ready@2026-09-27T01:00Z | Source: cut. |
| S41-06 | a | x | LOW | ready@2026-09-27T01:00Z | Depends on none. |
| M-10 | modernize step | y | LOW | ready@2026-09-27T01:00Z | Depends on S41-06. |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_DEPS_DIGITPREFIX"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: LOW_READY: only 6 ready slice(s) on BOARD (want at least 8); cut 2 more; blocked by dependency: M-10 (needs S41-06)" \
    && printf '%s\n' "$OUT" | grep -qF "Ready rows blocked by dependency: M-10 (needs S41-06)"; then
    ok "S41-06 (ready, not merged) blocks M-10; digit-bearing prefix parses in Depends-on clause"
else
    bad "T53 digit-prefix dependency case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo "T54 -- E-121: the digit-prefix fix does not regress plain-letter ids (E-98a, G-02, DEP-03)"
BOARD_OLDPREFIXES="$WORK/BOARD-oldprefixes.md"
cat > "$BOARD_OLDPREFIXES" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| E-98a | a | x | LOW | building@2026-09-27T01:00Z | |
| G-02 | a | x | LOW | building@2026-09-27T01:00Z | |
| DEP-03 | a | x | LOW | building@2026-09-27T01:00Z | |
EOF
if run_pulse "${COMMON_ARGS[@]}" "BOARD_MD=$BOARD_OLDPREFIXES"; then rc=0; else rc=$?; fi
if printf '%s\n' "$OUT" | grep -qF "VIOLATION: AGENT_OVER_BUDGET:" \
    && printf '%s\n' "$OUT" | grep -qF "E-98a building LOW (60.0 min, budget 15 min)" \
    && printf '%s\n' "$OUT" | grep -qF "G-02 building LOW (60.0 min, budget 15 min)" \
    && printf '%s\n' "$OUT" | grep -qF "DEP-03 building LOW (60.0 min, budget 15 min)"; then
    ok "E-98a, G-02 and DEP-03 all still parse and budget-check"
else
    bad "T54 existing-prefix regression case: rc=$rc output follows"
    printf '%s\n' "$OUT"
fi

echo ""
echo "=== bash 3.2 syntax + full-suite check (via /bin/sh, real bash 3.2.57 on macOS) ==="
if command -v /bin/sh >/dev/null 2>&1 && /bin/sh -c 'case "$BASH_VERSION" in 3.2*) exit 0;; *) exit 1;; esac' 2>/dev/null; then
    if /bin/sh -n "$PULSE_SH"; then
        ok "scripts/v10-pulse.sh: /bin/sh -n (bash 3.2.57) syntax OK"
    else
        bad "scripts/v10-pulse.sh: /bin/sh -n syntax check FAILED"
    fi
    if /bin/sh -n "$SCRIPT_DIR/test-v10-pulse.sh"; then
        ok "tests/test-v10-pulse.sh: /bin/sh -n (bash 3.2.57) syntax OK"
    else
        bad "tests/test-v10-pulse.sh: /bin/sh -n syntax check FAILED"
    fi
    if [ "$TEST_SHELL" = "bash" ]; then
        echo "  (this run interprets scripts/v10-pulse.sh with bash; re-run with"
        echo "   PULSE_TEST_SHELL=sh to execute the whole suite under real bash 3.2.57)"
    fi
else
    echo "  [SKIP] /bin/sh is not bash 3.2.x on this host; bash -n fallback only"
fi
if bash -n "$PULSE_SH"; then
    ok "scripts/v10-pulse.sh: bash -n syntax OK"
else
    bad "scripts/v10-pulse.sh: bash -n syntax check FAILED"
fi
if bash -n "$SCRIPT_DIR/test-v10-pulse.sh"; then
    ok "tests/test-v10-pulse.sh: bash -n syntax OK"
else
    bad "tests/test-v10-pulse.sh: bash -n syntax check FAILED"
fi

echo ""
TOTAL=$((PASS + FAIL))
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ]
