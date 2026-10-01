#!/usr/bin/env bash
#===============================================================================
# Loki Mode - v10-guard.sh fixture tests (slice S-73 rework, founder directive
# D26 guard 1)
#
# Exercises scripts/v10-guard.sh, the PreToolUse hook that blocks specific
# dangerous Bash tool calls, against the real hook contract: JSON on stdin
# shaped {"tool_name":"Bash","tool_input":{"command":...},"cwd":...}, exit 2
# + stderr message to block, exit 0 to allow (verified against
# code.claude.com/docs/en/hooks, 2026-09-27).
#
# GUARD can be overridden (V10_GUARD=/path/to/mutant) to run this same suite
# against a mutated copy for a mutation-kill check, without ever editing the
# tracked script while it runs.
#===============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TOTAL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="${V10_GUARD:-$SCRIPT_DIR/scripts/v10-guard.sh}"

# Run-owned temp dir per CLAUDE.md Test and Resource Cleanup mandate.
TEMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
LOKI_RUN_TMP="$(mktemp -d "${TEMP_ROOT}/loki-run.XXXXXXXX")"
chmod 700 "$LOKI_RUN_TMP"
printf '%s' "$LOKI_RUN_TMP" > "$LOKI_RUN_TMP/.loki-run-owned"
chmod 600 "$LOKI_RUN_TMP/.loki-run-owned"

# shellcheck disable=SC2329  # invoked indirectly via trap
cleanup() {
    # E-140: remove only the dir this script created (marker must match exactly).
    if [ "$(cat "$LOKI_RUN_TMP/.loki-run-owned" 2>/dev/null)" = "$LOKI_RUN_TMP" ]; then
        rm -rf -- "$LOKI_RUN_TMP"
    fi
}
trap cleanup EXIT

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

# payload COMMAND CWD -> JSON on stdout, matching the real hook contract.
payload() {
    local command="$1" cwd="$2"
    COMMAND="$command" CWD="$cwd" AGENT_ID="$AGENT_ID" python3 -c '
import json, os
print(json.dumps({
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {"command": os.environ["COMMAND"]},
    "cwd": os.environ["CWD"],
    **({"agent_id": os.environ["AGENT_ID"]} if os.environ.get("AGENT_ID") else {}),
}))
'
}

# AGENT_ID, when set, is added to the hook input (a subagent call).
AGENT_ID=""
# run_guard COMMAND CWD -> sets GUARD_EXIT and GUARD_STDERR
run_guard() {
    local command="$1" cwd="$2"
    payload "$command" "$cwd" | "$GUARD" >/dev/null 2>"$LOKI_RUN_TMP/stderr.$$"
    GUARD_EXIT=$?
    GUARD_STDERR="$(cat "$LOKI_RUN_TMP/stderr.$$")"
    rm -f "$LOKI_RUN_TMP/stderr.$$"
}

# assert_blocked NAME COMMAND CWD RULE_TAG
assert_blocked() {
    local name="$1" command="$2" cwd="$3" rule_tag="$4"
    TOTAL=$((TOTAL+1))
    run_guard "$command" "$cwd"
    if [ "$GUARD_EXIT" -eq 2 ] && printf '%s' "$GUARD_STDERR" | grep -q "$rule_tag"; then
        echo -e "${GREEN}[PASS]${NC} $name (exit=$GUARD_EXIT, names $rule_tag)"
        PASS=$((PASS+1))
    else
        echo -e "${RED}[FAIL]${NC} $name -- exit=$GUARD_EXIT stderr='$GUARD_STDERR'"
        FAIL=$((FAIL+1))
    fi
}

# assert_allowed NAME COMMAND CWD
assert_allowed() {
    local name="$1" command="$2" cwd="$3"
    TOTAL=$((TOTAL+1))
    run_guard "$command" "$cwd"
    if [ "$GUARD_EXIT" -eq 0 ]; then
        echo -e "${GREEN}[PASS]${NC} $name (exit=0, allowed)"
        PASS=$((PASS+1))
    else
        echo -e "${RED}[FAIL]${NC} $name -- exit=$GUARD_EXIT stderr='$GUARD_STDERR'"
        FAIL=$((FAIL+1))
    fi
}

echo -e "${BOLD}v10-guard.sh fixture tests${NC}"
echo "GUARD=$GUARD"
echo "=============================="

# ------------------------------------------------------------------
# Fixture git repos for rules 2 and 3 (need real git state).
# ------------------------------------------------------------------

# --- Repo for rule 2 (force-push / reset --hard on main) ---
REPO2="$LOKI_RUN_TMP/repo-rule2"
mkdir -p "$REPO2"
git -C "$REPO2" init -q -b main
git -C "$REPO2" config user.email test@example.com
git -C "$REPO2" config user.name "Test"
echo "hello" > "$REPO2/file.txt"
git -C "$REPO2" add file.txt
git -C "$REPO2" commit -q -m "init"

# A separate repo checked out on a non-main branch, for the "hard reset on
# non-main is allowed" case -- a second working directory so it does not
# disturb REPO2's main checkout used by the force-push cases above.
REPO2_FEATURE="$LOKI_RUN_TMP/repo-rule2-feature"
git clone -q "$REPO2" "$REPO2_FEATURE"
git -C "$REPO2_FEATURE" checkout -q -b feature-branch

# --- Repo for rule 3 (BOARD.md row drop) ---
REPO3="$LOKI_RUN_TMP/repo-rule3"
mkdir -p "$REPO3/docs/v10"
git -C "$REPO3" init -q -b main
git -C "$REPO3" config user.email test@example.com
git -C "$REPO3" config user.name "Test"
board_seed() {
    cat > "$REPO3/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
| S-2 | ready@2026-09-01T00:00Z | second |
| S-3 | ready@2026-09-01T00:00Z | third |
EOF
}
board_seed
git -C "$REPO3" add docs/v10/BOARD.md
git -C "$REPO3" commit -q -m "seed board"
# helper: reset repo3's index+worktree back to this clean HEAD
board_reset() { git -C "$REPO3" reset -q --hard; }

# A second, unrelated repo with its OWN valid (unmodified) BOARD.md -- used
# to prove pending-removal tracking is scoped to the repo it was queued
# against, not global. (REPO2 cannot serve this purpose: it has no
# docs/v10/BOARD.md at all, so rule3 short-circuits on "no baseline" before
# ever consulting the pending set, which would pass even without scoping.)
REPO3B="$LOKI_RUN_TMP/repo-rule3b"
mkdir -p "$REPO3B/docs/v10"
git -C "$REPO3B" init -q -b main
git -C "$REPO3B" config user.email test@example.com
git -C "$REPO3B" config user.name "Test"
cat > "$REPO3B/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-9 | ready@2026-09-01T00:00Z | unrelated |
EOF
git -C "$REPO3B" add docs/v10/BOARD.md
git -C "$REPO3B" commit -q -m "seed board"

echo ""
echo "--- Rule 1: process-kill-by-pattern (pkill/killall/kill-by-pattern) ---"
assert_blocked "R1 blocked: pkill -f" \
    "pkill -f loki-mode" "$SCRIPT_DIR" "RULE1"
assert_allowed "R1 allowed: kill exact recorded PID" \
    "kill -9 42123" "$SCRIPT_DIR"

echo ""
echo "--- Rule 1 continued: kill fed a pgrep/command-substitution PID list ---"
# shellcheck disable=SC2016  # literal text passed as the guarded command string, not expanded here
assert_blocked "R1 blocked: kill \$(pgrep pattern)" \
    'kill $(pgrep -f loki-mode)' "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: killall by name" \
    "killall node" "$SCRIPT_DIR" "RULE1"

echo ""
echo "--- Rule 1 continued: the recorded-PID pattern stays allowed ---"
# shellcheck disable=SC2016  # literal text passed as the guarded command string, not expanded here
assert_allowed "R1 allowed: kill \"\$PID\"" \
    'kill "$PID"' "$SCRIPT_DIR"
# shellcheck disable=SC2016
assert_allowed "R1 allowed: kill -9 \$(cat recorded-pid-file)" \
    'kill -9 $(cat "$LOKI_RUN_TMP/child.pid")' "$SCRIPT_DIR"
# shellcheck disable=SC2016
assert_allowed "R1 allowed: kill -0 \"\$pid\"" \
    'kill -0 "$pid"' "$SCRIPT_DIR"

echo ""
echo "--- Rule 1 continued: xargs kill piped from a process-search tool ---"
assert_blocked "R1 blocked: pgrep | xargs kill -9" \
    "pgrep -f loki | xargs kill -9" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: lsof -ti | xargs kill -9" \
    "lsof -ti:57374 | xargs kill -9" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: pgrep | grep -v x | xargs kill (multi-hop pipe)" \
    "pgrep -f loki | grep -v x | xargs kill" "$SCRIPT_DIR" "RULE1"
assert_allowed "R1 allowed: unrelated xargs pipe (no process-search source)" \
    "echo loki | xargs echo" "$SCRIPT_DIR"

echo ""
echo "--- Rule 1 continued: bash -c / sh -c payloads are unwrapped ---"
assert_blocked "R1 blocked: bash -c 'pkill ...'" \
    "bash -c 'pkill -f loki'" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: sh -c 'pkill ...'" \
    "sh -c 'pkill -f loki'" "$SCRIPT_DIR" "RULE1"
assert_allowed "R1 allowed: bash -c 'echo hi' (unrelated payload)" \
    "bash -c 'echo hi'" "$SCRIPT_DIR"

echo ""
echo "--- Rule 1 continued: kill \$VAR sourced from a process-search tool in the same command ---"
# shellcheck disable=SC2016
assert_blocked "R1 blocked: for p in \$(pgrep ...); do kill \$p; done" \
    'for p in $(pgrep -f loki); do kill $p; done' "$SCRIPT_DIR" "RULE1"

echo ""
echo "--- Rule 1 continued: shell keywords/negation before the real command ---"
assert_blocked "R1 blocked: if/then wrapping pkill" \
    "if true; then pkill -f loki; fi" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: brace group wrapping pkill" \
    "{ pkill -f loki; }" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: negation wrapping pkill" \
    "! pkill -f loki" "$SCRIPT_DIR" "RULE1"

echo ""
echo "--- Rule 1 continued: timeout/nice/sudo wrapper wraps the real command ---"
assert_blocked "R1 blocked: timeout N pkill ..." \
    "timeout 5 pkill -f loki" "$SCRIPT_DIR" "RULE1"
assert_allowed "R1 allowed: timeout N <safe command>" \
    "timeout 5 echo hi" "$SCRIPT_DIR"
assert_blocked "R1 blocked: sudo -u USER pkill ..." \
    "sudo -u www-data pkill -f loki" "$SCRIPT_DIR" "RULE1"

echo ""
echo "--- Rule 2: git push --force / git reset --hard on main ---"
assert_blocked "R2 blocked: git push --force" \
    "git push --force origin main" "$REPO2" "RULE2"
assert_blocked "R2 blocked: git push -f" \
    "git push -f origin main" "$REPO2" "RULE2"
assert_blocked "R2 blocked: git push --force-with-lease=main (attached value)" \
    "git push --force-with-lease=main origin main" "$REPO2" "RULE2"
assert_blocked "R2 blocked: git reset --hard on main" \
    "git reset --hard HEAD~1" "$REPO2" "RULE2"
assert_allowed "R2 allowed: git push origin main (no force)" \
    "git push origin main" "$REPO2"
assert_allowed "R2 allowed: git reset --hard on non-main branch" \
    "git reset --hard HEAD" "$REPO2_FEATURE"

echo ""
echo "--- Rule 2 continued: git -C / --git-dir= / --work-tree= target the NAMED repo, not hook cwd ---"
assert_blocked "R2 blocked: git -C <repo-on-main> reset --hard (cwd is unrelated)" \
    "git -C $REPO2 reset --hard HEAD~1" "$SCRIPT_DIR" "RULE2"
assert_allowed "R2 allowed: git -C <repo-on-feature-branch> reset --hard (cwd is unrelated)" \
    "git -C $REPO2_FEATURE reset --hard HEAD" "$SCRIPT_DIR"
assert_blocked "R2 blocked: git --git-dir=/--work-tree= targets a repo on main" \
    "git --git-dir=$REPO2/.git --work-tree=$REPO2 reset --hard HEAD~1" "$SCRIPT_DIR" "RULE2"

echo ""
echo "--- Rule 2 continued: moving 'main' without ever checking it out ---"
# REPO2_FEATURE is checked out on feature-branch, not main -- these all move
# the LOCAL main ref while a different branch is current, which the plain
# reset --hard-on-main check above cannot see (it only fires when main IS
# the current branch).
assert_blocked "R2 blocked: git branch -f main <ref> (current branch is feature-branch)" \
    "git branch -f main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git branch --force main <ref> (long flag)" \
    "git branch --force main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git update-ref refs/heads/main <ref>" \
    "git update-ref refs/heads/main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git update-ref -m <reason> refs/heads/main <ref> (value-flag before the ref)" \
    "git update-ref -m reason refs/heads/main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git update-ref -d refs/heads/main (delete)" \
    "git update-ref -d refs/heads/main" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git update-ref --stdin (can't verify ref updates read from stdin)" \
    "git update-ref --stdin" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git checkout -B main <ref>" \
    "git checkout -B main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git switch -C main <ref>" \
    "git switch -C main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git switch --force-create main <ref> (long flag)" \
    "git switch --force-create main HEAD" "$REPO2_FEATURE" "RULE2"
assert_blocked "R2 blocked: git branch -f main <ref> (current branch IS main)" \
    "git branch -f main HEAD~0" "$REPO2" "RULE2"
assert_allowed "R2 allowed: git branch -f <other-branch> <ref>" \
    "git branch -f other-branch HEAD" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git checkout -B <other-branch> <ref>" \
    "git checkout -B other-branch HEAD" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git switch -C <other-branch> <ref>" \
    "git switch -C other-branch HEAD" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git update-ref refs/heads/other-branch <ref>" \
    "git update-ref refs/heads/other-branch HEAD" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git update-ref refs/heads/other-branch refs/heads/main (main only appears as the SOURCE value, not the target)" \
    "git update-ref refs/heads/other-branch refs/heads/main" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git update-ref -m refs/heads/main refs/heads/other-branch HEAD (main only appears as the -m reason string)" \
    "git update-ref -m refs/heads/main refs/heads/other-branch HEAD" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git switch main (plain switch, no -C)" \
    "git switch main" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git checkout main (plain checkout, no -B)" \
    "git checkout main" "$REPO2_FEATURE"
assert_allowed "R2 allowed: git branch main (no force flag)" \
    "git branch main HEAD" "$REPO2_FEATURE"

echo ""
echo "--- Rule 3: git commit dropping a BOARD.md row (isolated: index only) ---"
board_reset
# Stage a BOARD.md that drops S-3, but restore the WORKING COPY to the full
# set afterward -- this isolates the index check (a mutation to only the
# working-tree check must not make this fixture pass).
cat > "$REPO3/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
| S-2 | ready@2026-09-01T00:00Z | second |
EOF
git -C "$REPO3" add docs/v10/BOARD.md
board_seed
assert_blocked "R3 blocked: staged BOARD.md drops S-3 (working copy intact)" \
    "git commit -m 'oops drop a row'" "$REPO3" "RULE3"
board_reset

echo ""
echo "--- Rule 3 continued: working-tree-only drop (isolated: combined short flags) ---"
# Index matches HEAD exactly; only the unstaged working copy drops a row.
# git commit -am/-qam commits the working-tree state for tracked files, so
# this must block without any short-flag-cluster parsing.
cat > "$REPO3/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
| S-2 | ready@2026-09-01T00:00Z | second |
EOF
assert_blocked "R3 blocked: git commit -am x (working copy drops S-3, index clean)" \
    "git commit -am x" "$REPO3" "RULE3"
assert_blocked "R3 blocked: git commit -qam x (combined short flags)" \
    "git commit -qam x" "$REPO3" "RULE3"
assert_blocked "R3 blocked: git commit -m x docs/ (broad pathspec, unstaged drop)" \
    "git commit -m x docs/" "$REPO3" "RULE3"
assert_blocked "R3 blocked: git commit -m x . (broad pathspec, unstaged drop)" \
    "git commit -m x ." "$REPO3" "RULE3"
assert_blocked "R3 blocked: git add docs && git commit (add not yet run, worktree already dropped)" \
    "git add docs && git commit -m x" "$REPO3" "RULE3"
assert_blocked "R3 blocked: git add -u && git commit" \
    "git add -u && git commit -m x" "$REPO3" "RULE3"
assert_blocked "R3 blocked: git stage <path> && git commit" \
    "git stage docs/v10/BOARD.md && git commit -m x" "$REPO3" "RULE3"
board_reset

echo ""
echo "--- Rule 3 continued: BOARD.md missing from the index (real staged delete) ---"
git -C "$REPO3" rm -q --cached docs/v10/BOARD.md
assert_blocked "R3 blocked: BOARD.md staged-removed from the index (worktree intact)" \
    "git commit -m x" "$REPO3" "RULE3"
board_reset
git -C "$REPO3" add docs/v10/BOARD.md >/dev/null 2>&1 || true

echo ""
echo "--- Rule 3 continued: a pending git rm/mv in the SAME command removes BOARD.md ---"
board_reset
assert_blocked "R3 blocked: git rm BOARD.md && git commit (not yet executed)" \
    "git rm docs/v10/BOARD.md && git commit -m x" "$REPO3" "RULE3"
board_reset
assert_blocked "R3 blocked: git mv BOARD.md away && git commit (not yet executed)" \
    "git mv docs/v10/BOARD.md docs/v10/OLD.md && git commit -m x" "$REPO3" "RULE3"
board_reset
assert_blocked "R3 blocked: git -C <repo> rm BOARD.md && git -C <same repo> commit" \
    "git -C $REPO3 rm docs/v10/BOARD.md && git -C $REPO3 commit -m x" "$SCRIPT_DIR" "RULE3"
board_reset
# Repo-scoped: a pending removal queued against REPO3 must never block an
# unrelated commit in a DIFFERENT repo (with its own valid, untouched
# board) in the same chained command.
assert_allowed "R3 allowed: pending removal in one repo does not block a commit in a different repo" \
    "git -C $REPO3 rm docs/v10/BOARD.md && git -C $REPO3B commit -m x" "$SCRIPT_DIR"
board_reset

echo ""
echo "--- Rule 3 continued: a BOARD.md write/checkout earlier in the command is also pending ---"
# Dedicated repo with two commits (older commit has S-1 only, HEAD has
# S-1+S-2) so `git checkout HEAD~1 -- BOARD.md` genuinely drops a row.
REPO_WRITE="$LOKI_RUN_TMP/repo-rule3-write"
mkdir -p "$REPO_WRITE/docs/v10"
git -C "$REPO_WRITE" init -q -b main
git -C "$REPO_WRITE" config user.email test@example.com
git -C "$REPO_WRITE" config user.name "Test"
cat > "$REPO_WRITE/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
EOF
git -C "$REPO_WRITE" add docs/v10/BOARD.md
git -C "$REPO_WRITE" commit -q -m "S-1 only"
cat > "$REPO_WRITE/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
| S-2 | ready@2026-09-01T00:00Z | second |
EOF
git -C "$REPO_WRITE" commit -q -am "add S-2"
assert_blocked "R3 blocked: a redirect write to BOARD.md earlier in the command" \
    ": > docs/v10/BOARD.md && git commit -am x" "$REPO_WRITE" "RULE3"
assert_blocked "R3 blocked: git checkout <rev> -- BOARD.md earlier in the command" \
    "git checkout HEAD~1 -- docs/v10/BOARD.md && git commit -m x" "$REPO_WRITE" "RULE3"
assert_allowed "R3 allowed: a redirect write to an unrelated file" \
    ": > docs/v10/OTHER.md && git commit -m x" "$REPO_WRITE"

echo ""
echo "--- Rule 3 continued: allowed cases (no row dropped anywhere) ---"
assert_allowed "R3 allowed: git commit -m x (nothing touched, board intact)" \
    "git commit -m x" "$REPO3"
cat > "$REPO3/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
| S-2 | ready@2026-09-01T00:00Z | second |
| S-3 | ready@2026-09-01T00:00Z | third |
| S-4 | ready@2026-09-01T00:00Z | fourth |
EOF
git -C "$REPO3" add docs/v10/BOARD.md
assert_allowed "R3 allowed: commit only adds a row (index and worktree agree)" \
    "git commit -m 'add S-4'" "$REPO3"
git -C "$REPO3" commit -q -m "add S-4" >/dev/null 2>&1 || true
board_seed
git -C "$REPO3" reset -q --hard HEAD~1 2>/dev/null || true
board_seed
git -C "$REPO3" checkout -q -- docs/v10/BOARD.md 2>/dev/null || true

echo ""
echo "--- Rule 3 continued: git commit -a from a repo SUBDIRECTORY resolves the real root ---"
mkdir -p "$REPO3/docs/v10"
board_reset
assert_allowed "R3 allowed: git commit -a from subdirectory, clean tree (subdir path bug fixed)" \
    "git commit -a -m x" "$REPO3/docs" "RULE3"
cat > "$REPO3/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
| S-2 | ready@2026-09-01T00:00Z | second |
EOF
assert_blocked "R3 blocked: git commit -a from subdirectory, real drop" \
    "git commit -a -m x" "$REPO3/docs" "RULE3"
board_reset

echo ""
echo "--- Rule 4: rm -rf outside allowed roots (location-independent target) ---"
assert_blocked "R4 blocked: rm -rf on a path outside any allowed root" \
    "rm -rf /nonexistent-v10-guard-test-target-$$/docs" "$SCRIPT_DIR" "RULE4"
mkdir -p "$SCRIPT_DIR/.claude/worktrees/scratch-fixture-$$"
assert_allowed "R4 allowed: rm -rf under .claude/worktrees" \
    "rm -rf .claude/worktrees/scratch-fixture-$$" "$SCRIPT_DIR"
rmdir "$SCRIPT_DIR/.claude/worktrees/scratch-fixture-$$" 2>/dev/null || true
assert_allowed "R4 allowed: rm -rf under \$TMPDIR-rooted run tmp" \
    "rm -rf $LOKI_RUN_TMP/scratch-under-tmp" "$SCRIPT_DIR"
# cwd="/" (not $SCRIPT_DIR): if the checkout itself sits under /tmp or
# $TMPDIR, $SCRIPT_DIR/.claude/worktrees would ALSO resolve strictly under
# the /tmp root and be correctly (per the rule's own literal wording)
# allowed on that basis alone, masking whether the worktrees-root-itself
# check works. cwd="/" keeps ONLY the worktrees-root check in play.
assert_blocked "R4 blocked: rm -rf on .claude/worktrees ITSELF (the root, not under it)" \
    "rm -rf .claude/worktrees" "/" "RULE4"
assert_blocked "R4 blocked: rm -rf on /tmp ITSELF (the root, not under it)" \
    "rm -rf /tmp" "$SCRIPT_DIR" "RULE4"
# Absolute, clearly-outside-any-root targets below (not SCRIPT_DIR-relative
# "docs") so these stay correct even when the checkout itself sits under
# /tmp or $TMPDIR.
assert_blocked "R4 blocked: for d in x; do rm -rf <outside>; done (shell keyword prefix)" \
    "for d in x; do rm -rf /nonexistent-v10-guard-test-target-$$; done" "$SCRIPT_DIR" "RULE4"
assert_blocked "R4 blocked: timeout N rm -rf <outside> (timeout wrapper)" \
    "timeout 10 rm -rf /nonexistent-v10-guard-test-target-$$" "$SCRIPT_DIR" "RULE4"

echo ""
echo "--- Rule 4: glob rm directly in a shared root (GUARDS.md section 11, S-181) ---"
assert_blocked "R4 glob blocked: rm -f /tmp/*.log" \
    "rm -f /tmp/*.log" "$SCRIPT_DIR" "glob rm in a shared root"
assert_blocked "R4 glob blocked: rm -f /private/tmp/loki-*" \
    "rm -f /private/tmp/loki-*" "$SCRIPT_DIR" "glob rm in a shared root"
assert_blocked "R4 glob blocked: rm -f <scratchpad>/*" \
    "rm -f /private/tmp/claude-501/proj/session/scratchpad/*" "$SCRIPT_DIR" "glob rm in a shared root"
assert_blocked "R4 glob blocked: rm <literal \$TMPDIR>/*.txt (no -f)" \
    "rm ${TMPDIR:-/tmp}/*.txt" "$SCRIPT_DIR" "glob rm in a shared root"
assert_blocked "R4 glob blocked: cwd-relative rm -f *.log with cwd=/tmp" \
    "rm -f *.log" "/tmp" "glob rm in a shared root"
assert_blocked "R4 glob blocked: rm -r /tmp/loki-*/ (trailing slash)" \
    "rm -r /tmp/loki-*/" "$SCRIPT_DIR" "glob rm in a shared root"
assert_blocked "R4 glob blocked: rm -f /tmp/*/x.log (glob in a middle component)" \
    "rm -f /tmp/*/x.log" "$SCRIPT_DIR" "glob rm in a shared root"
# cwd is a directory named scratchpad: the relative prefix joins to
# "<...>/scratchpad/.", whose raw basename is "." (review7 blocker). The
# guard follows `cd` only into a directory that exists, so make a real one.
SP_CWD="$LOKI_RUN_TMP/scratchpad"
mkdir -p "$SP_CWD"
assert_blocked "R4 glob blocked: rm -f * with cwd=<scratchpad>" \
    "rm -f *" "$SP_CWD" "glob rm in a shared root"
assert_blocked "R4 glob blocked: rm -f ./* with cwd=<scratchpad>" \
    "rm -f ./*" "$SP_CWD" "glob rm in a shared root"
assert_blocked "R4 glob blocked: cd <scratchpad> && rm -f * (cd chain)" \
    "cd $SP_CWD && rm -f *" "/" "glob rm in a shared root"
assert_allowed "R4 glob allowed: rm -f run-1/* with cwd=<scratchpad> (one level below)" \
    "rm -f run-1/*" "$SP_CWD"
assert_allowed "R4 glob allowed: rm -f /tmp/run-1/*.log (one level below)" \
    "rm -f /tmp/run-1/*.log" "$SCRIPT_DIR"
assert_allowed "R4 glob allowed: rm -f <scratchpad>/run-1/* (one level below)" \
    "rm -f /private/tmp/claude-501/proj/session/scratchpad/run-1/*" "$SCRIPT_DIR"
assert_allowed "R4 glob allowed: unexpanded variable parent (documented limit)" \
    'rm -f "$TMPDIR"/*.log' "$SCRIPT_DIR"
assert_allowed "R4 glob allowed: rm -f /tmp/exact-file.log (no glob)" \
    "rm -f /tmp/exact-file.log" "$SCRIPT_DIR"

echo ""
echo "--- Rule 5: writes to VERSION outside scripts/release.sh ---"
assert_blocked "R5 blocked: echo redirected into VERSION" \
    "echo '9.9.9' > VERSION" "$SCRIPT_DIR" "RULE5"
assert_blocked "R5 blocked: sed -i editing VERSION" \
    "sed -i '' 's/9.55.0/9.56.0/' VERSION" "$SCRIPT_DIR" "RULE5"
assert_blocked "R5 blocked: echo > ./VERSION (relative path prefix)" \
    "echo 1 > ./VERSION" "$SCRIPT_DIR" "RULE5"
assert_blocked "R5 blocked: echo > /abs/path/VERSION (absolute path prefix)" \
    "echo 1 > $LOKI_RUN_TMP/VERSION" "$SCRIPT_DIR" "RULE5"
assert_blocked "R5 blocked: no-space redirect (echo 9.9.9>VERSION)" \
    "echo 9.9.9>VERSION" "$SCRIPT_DIR" "RULE5"
assert_blocked "R5 blocked: noclobber-override redirect (printf 1 >| VERSION)" \
    "printf 1 >| VERSION" "$SCRIPT_DIR" "RULE5"
assert_allowed "R5 allowed: write to VERSION via scripts/release.sh" \
    "bash scripts/release.sh patch" "$SCRIPT_DIR"
assert_allowed "R5 allowed: reading VERSION (no write)" \
    "cat VERSION" "$SCRIPT_DIR"
assert_blocked "R5 blocked: release.sh exemption does not cover the WHOLE chained command" \
    "scripts/release.sh --help; echo 1 > VERSION" "$SCRIPT_DIR" "RULE5"

echo ""
echo "--- Rule 6: git add blanket staging (CLAUDE.md: stage files individually) ---"
assert_blocked "R6 blocked: git add -A" \
    "git add -A" "$SCRIPT_DIR" "RULE6"
assert_blocked "R6 blocked: git add ." \
    "git add ." "$SCRIPT_DIR" "RULE6"
assert_blocked "R6 blocked: git add --all" \
    "git add --all" "$SCRIPT_DIR" "RULE6"
assert_blocked "R6 blocked: git add :/" \
    "git add :/" "$SCRIPT_DIR" "RULE6"
assert_blocked "R6 blocked: git add -vA (combined short flag)" \
    "git add -vA" "$SCRIPT_DIR" "RULE6"
assert_blocked "R6 blocked: git add ./ (same as .)" \
    "git add ./" "$SCRIPT_DIR" "RULE6"
assert_allowed "R6 allowed: git add <file> (staged individually by name)" \
    "git add scripts/v10-guard.sh" "$SCRIPT_DIR"

echo ""
echo "--- Rule 7: checkout/restore that wipes the shared tree in the main checkout ---"
# A "main"-shaped fixture repo, plus a nested repo whose path runs through
# .claude/worktrees/ so it reads as a worktree checkout the same way a real
# `git worktree add .claude/worktrees/<name>` would.
REPO7="$LOKI_RUN_TMP/repo-rule7"
mkdir -p "$REPO7"
git -C "$REPO7" init -q -b main
git -C "$REPO7" config user.email test@example.com
git -C "$REPO7" config user.name "Test"
echo "hello" > "$REPO7/file.txt"
git -C "$REPO7" add file.txt
git -C "$REPO7" commit -q -m "init"

REPO7_WT="$REPO7/.claude/worktrees/wt1"
mkdir -p "$REPO7_WT"
git -C "$REPO7_WT" init -q -b slice-x
git -C "$REPO7_WT" config user.email test@example.com
git -C "$REPO7_WT" config user.name "Test"
echo "hello" > "$REPO7_WT/file.txt"
git -C "$REPO7_WT" add file.txt
git -C "$REPO7_WT" commit -q -m "init"

assert_blocked "R7 blocked: git checkout <ref> -- . in the main checkout" \
    "git checkout main -- ." "$REPO7" "RULE7"
assert_blocked "R7 blocked: git checkout <ref> -- :/ in the main checkout" \
    "git checkout HEAD -- :/" "$REPO7" "RULE7"
assert_blocked "R7 blocked: bare git checkout . (no ref, no --) in the main checkout" \
    "git checkout ." "$REPO7" "RULE7"
assert_blocked "R7 blocked: git restore --source=<ref> . in the main checkout" \
    "git restore --source=main ." "$REPO7" "RULE7"
assert_blocked "R7 blocked: git restore -s <ref> . in the main checkout" \
    "git restore -s main ." "$REPO7" "RULE7"
assert_allowed "R7 allowed: git checkout <ref> -- . inside a .claude/worktrees/* worktree" \
    "git checkout main -- ." "$REPO7_WT"
assert_allowed "R7 allowed: single-file git checkout -- <file> in the main checkout" \
    "git checkout -- file.txt" "$REPO7"
assert_blocked "R7 blocked: git -C <main> checkout x -- . run from elsewhere" \
    "git -C $REPO7 checkout x -- ." "$LOKI_RUN_TMP" "RULE7"

echo ""
echo "--- Heredocs: an apostrophe in a heredoc body must not cause a false PARSE block ---"
assert_allowed "Heredoc allowed: apostrophe in a plain heredoc body" \
    "cat > $LOKI_RUN_TMP/notes.txt <<EOF
we can't confirm this
EOF" "$SCRIPT_DIR"
assert_allowed "Heredoc allowed: apostrophe in a quoted-delimiter heredoc (commit -F -)" \
    "git commit -F - <<'EOF'
fix: it's done
EOF" "$REPO3"

echo ""
echo "--- Heredocs continued: the OPENER line still runs (round 3) ---"
assert_blocked "Heredoc opener: commit -F - <<'EOF' && git push --force (opener tail still runs)" \
    "git commit -F - <<'EOF' && git push --force origin main
msg
EOF" "$REPO2" "RULE2"
assert_blocked "Heredoc opener: cat <<EOF; pkill -f loki (opener tail still runs)" \
    "cat <<EOF; pkill -f loki
body
EOF" "$SCRIPT_DIR" "RULE1"
assert_blocked "Heredoc opener: cat <<EOF > VERSION (opener's own redirect still checked)" \
    "cat <<EOF > VERSION
9.9.9
EOF" "$SCRIPT_DIR" "RULE5"
assert_blocked "Heredoc opener: cat > x <<'EOF' && rm -rf <outside> (opener tail still runs)" \
    "cat > $LOKI_RUN_TMP/x <<'EOF' && rm -rf /nonexistent-v10-guard-test-target-$$
body
EOF" "$SCRIPT_DIR" "RULE4"
assert_allowed "Heredoc opener: a SAFE command chained on the opener line stays allowed" \
    "cat <<EOF; echo hi
body
EOF" "$SCRIPT_DIR"
# shellcheck disable=SC2016  # literal text passed as the guarded command string, not expanded here
assert_allowed "Heredoc: arithmetic << is not mistaken for a heredoc marker" \
    'echo $((1<<2))' "$SCRIPT_DIR"

echo ""
echo "--- Heredocs continued: no-terminator must strip NOTHING, not the rest of the command (round 4) ---"
assert_blocked "Heredoc: here-string <<< is not a heredoc marker (opener tail still runs)" \
    "cat <<< hello
pkill -f loki" "$SCRIPT_DIR" "RULE1"
assert_blocked "Heredoc: here-string <<< before a force-push (opener tail still runs)" \
    "grep x <<< word
git push --force origin main" "$REPO2" "RULE2"
assert_blocked "Heredoc: <<EOF inside a quoted grep pattern is not a marker (opener tail still runs)" \
    'grep -rn "<<EOF" scripts/
rm -rf docs' "/" "RULE4"
assert_blocked "Heredoc: <<X after an unquoted # comment is not a marker (opener tail still runs)" \
    "# note <<X
git push -f origin main" "$REPO2" "RULE2"
assert_blocked "Heredoc: arithmetic << with spaces is not a marker (opener tail still runs)" \
    "echo \$((1 << 2 ))
pkill -f loki" "$SCRIPT_DIR" "RULE1"
# shellcheck disable=SC2016  # literal text passed as the guarded command string, not expanded here
assert_blocked "Heredoc: arithmetic << with spaces and a variable is not a marker (opener tail still runs)" \
    'x=$(( n << 1 ))
rm -rf docs' "/" "RULE4"
assert_blocked "Heredoc: delimiter with a hyphen is a real heredoc (full shell-word, not just \\w+)" \
    "cat <<EOF-X
hi
EOF-X
pkill -f loki" "$SCRIPT_DIR" "RULE1"
# shellcheck disable=SC2016  # literal text (with embedded CR) passed as the guarded command string
assert_blocked "Heredoc: CRLF line endings, terminator line has a trailing \\r" \
    $'cat <<EOF\r\nhi\r\nEOF\r\ngit push --force origin main' "$REPO2" "RULE2"
assert_blocked "Heredoc: genuinely unterminated heredoc must strip NOTHING (not the whole rest of the command)" \
    "cat <<EOF
pkill -f loki" "$SCRIPT_DIR" "RULE1"
assert_allowed "Heredoc: a here-string alone is allowed" \
    "cat <<< hello" "$SCRIPT_DIR"
assert_allowed "Heredoc: bc <<< 2+2 (here-string, common real usage)" \
    "bc <<< 2+2" "$SCRIPT_DIR"
assert_allowed "Heredoc: a real, properly terminated heredoc with a safe trailing command" \
    "cat <<EOF
hi
EOF
echo done" "$SCRIPT_DIR"

echo ""
echo "--- Rule 1 continued: a trailing redirect must not be read as the kill target (round 3) ---"
assert_allowed "R1 allowed: kill 12345 2>/dev/null" \
    "kill 12345 2>/dev/null" "$SCRIPT_DIR"
# shellcheck disable=SC2016
assert_allowed "R1 allowed: kill \"\$pid\" 2>/dev/null || true" \
    'kill "$pid" 2>/dev/null || true' "$SCRIPT_DIR"
assert_allowed "R1 allowed: kill -9 12345 >/dev/null 2>&1" \
    "kill -9 12345 >/dev/null 2>&1" "$SCRIPT_DIR"
# shellcheck disable=SC2016
assert_allowed "R1 allowed: kill -0 \"\$pid\" 2>/dev/null && echo alive" \
    'kill -0 "$pid" 2>/dev/null && echo alive' "$SCRIPT_DIR"
assert_blocked "R1 blocked: pkill still caught despite a trailing redirect" \
    "pkill -f loki 2>/dev/null" "$SCRIPT_DIR" "RULE1"

echo ""
echo "--- Rule 1 continued: if/while/until were missing from SHELL_KEYWORDS (round 3) ---"
assert_blocked "R1 blocked: if pkill; then ...; fi" \
    "if pkill -f loki; then echo ok; fi" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: until pkill; do ...; done" \
    "until pkill -f loki; do sleep 1; done" "$SCRIPT_DIR" "RULE1"
assert_blocked "R2 blocked: if git push --force; then ...; fi" \
    "if git push --force origin main; then :; fi" "$REPO2" "RULE2"
assert_allowed "Sanity: if/then wrapping a safe command stays allowed" \
    "if true; then echo ok; fi" "$SCRIPT_DIR"

echo ""
echo "--- Rule 1 continued: process-search source reaching \$(cat f) / xargs < f (round 3) ---"
assert_blocked "R1 blocked: pgrep > f; kill \$(cat f) (pgrep earlier in the command)" \
    "pgrep -f loki > $LOKI_RUN_TMP/pf; kill \$(cat $LOKI_RUN_TMP/pf)" "$SCRIPT_DIR" "RULE1"
assert_blocked "R1 blocked: pgrep > f; xargs kill < f (pgrep earlier in the command)" \
    "pgrep -f loki > $LOKI_RUN_TMP/pf; xargs kill < $LOKI_RUN_TMP/pf" "$SCRIPT_DIR" "RULE1"
assert_allowed "R1 allowed: kill \$(cat f) with no process-search tool anywhere" \
    "kill \$(cat $LOKI_RUN_TMP/pf)" "$SCRIPT_DIR"
assert_allowed "R1 allowed: xargs kill < f with no process-search tool anywhere" \
    "xargs kill < $LOKI_RUN_TMP/pf" "$SCRIPT_DIR"

echo ""
echo "--- S-99 follow-ups: quote-carrying, strict terminator, quoted redirect, BOARD.md tool-writes (round 5) ---"
# (1) A double quote opened on one line and closed on a later line must keep
# its state across the boundary: a `<<X` that only appears inside that
# still-open quote must not be mistaken for a real heredoc opener, which
# would otherwise strip the real `pkill` in between as if it were the
# (fake) heredoc's body.
assert_blocked "S-99 R1: quote state carried across lines (fake <<X inside an open quote)" \
    "echo \"start
<<X\"
pkill -f loki
X" "$SCRIPT_DIR" "RULE1"

# (2) A terminator line must be EXACTLY the delimiter (plus an optional
# \r) -- a line with trailing whitespace is not a match, so the search
# must keep looking past it instead of stopping early and letting whatever
# comes next (here, a bare pkill) fall through as unstripped, unscanned
# heredoc "leftover".
assert_blocked "S-99 R2: terminator with trailing whitespace is not recognized (falls through to strip-nothing)" \
    "cat <<EOF
pkill -f loki
EOF " "$SCRIPT_DIR" "RULE1"

# (3) A quoted ">" must not be read as a live redirect operator that
# swallows the NEXT token as its target -- rm's real target list must keep
# every argument that was genuinely there.
assert_blocked "S-99 R4: quoted \">\" must not hide the real rm target after it" \
    'rm -rf /tmp/x ">" /srv/someone/important' "$SCRIPT_DIR" "RULE4"

# (4) sed -i (and cp/mv/tee/truncate/dd/perl -pi/python3 open()) rewriting
# BOARD.md in place, earlier in the same chained command, must set the
# pending flag before the trailing git commit -- the static index/worktree
# check alone would see the CURRENT (pre-rewrite) BOARD.md and miss it.
board_reset
assert_blocked "S-99 R3: sed -i rewriting BOARD.md earlier in the command sets pending before commit" \
    "sed -i '' '/S-3/d' docs/v10/BOARD.md && git commit -am x" "$REPO3" "RULE3"
board_reset

# S-99 rework: review findings 1-4.
# (F1) The redirect-char mask must be undone before a bash -c / sh -c
# payload is re-tokenized, or a quoted &&, >, & glues the payload into one
# segment and hides every rule after its first word.
assert_blocked "S-99 F1a: bash -c payload with && still scans the rm after it" \
    "bash -c 'true && rm -rf /srv/nonexistent-s99'" "$SCRIPT_DIR" "RULE4"
assert_blocked "S-99 F1b: sh -c payload with && still scans the force push after it" \
    'sh -c "true && git push --force"' "$SCRIPT_DIR" "RULE2"
assert_blocked "S-99 F1c: bash -c payload with > VERSION still blocked" \
    "bash -c 'echo 9.9.9 > VERSION'" "$SCRIPT_DIR" "RULE5"
# (F2) perl -i -pe (separate -i, combined -pe) is the common idiom.
board_reset
assert_blocked "S-99 F2: perl -i -pe rewriting BOARD.md sets pending before commit" \
    "perl -i -pe 's/S-3/X/' docs/v10/BOARD.md && git commit -am x" "$REPO3" "RULE3"
board_reset
# (F3) A backslash-escaped ">" outside quotes is a literal argument too.
assert_blocked "S-99 F3: escaped \\> must not hide the real rm target after it" \
    'rm -rf /tmp/x \> /srv/someone/important' "$SCRIPT_DIR" "RULE4"
# (F4) python open() with a keyword mode= argument.
board_reset
assert_blocked "S-99 F4: python3 open(path, mode='w') on BOARD.md sets pending before commit" \
    "python3 -c \"open('docs/v10/BOARD.md', mode='w').write('gone')\" && git commit -am x" "$REPO3" "RULE3"
board_reset

echo ""
echo "--- S-99 follow-ups continued: everyday commands stay allowed ---"
assert_allowed "S-99 sanity: bash -c with a quoted && of safe commands still allowed" \
    "bash -c 'true && echo ok > /dev/null'" "$SCRIPT_DIR"
assert_allowed "S-99 sanity: git status still allowed" "git status" "$SCRIPT_DIR"
assert_allowed "S-99 sanity: kill of a literal PID still allowed" "kill -9 42123" "$SCRIPT_DIR"
assert_allowed "S-99 sanity: heredoc commit message with an apostrophe still allowed" \
    "git commit -F - <<'EOF'
fix: it's done
EOF" "$REPO3"

echo ""
echo "--- Fail-closed on an internal guard crash (PY_EXIT != 0) ---"
# A staged BOARD.md with invalid UTF-8 bytes makes the (unwrapped) index
# read inside rule3 raise UnicodeDecodeError -- the python step crashes
# after a rule was already in play. The wrapper must block, not fail open.
REPO_CRASH="$LOKI_RUN_TMP/repo-crash"
mkdir -p "$REPO_CRASH/docs/v10"
git -C "$REPO_CRASH" init -q -b main
git -C "$REPO_CRASH" config user.email test@example.com
git -C "$REPO_CRASH" config user.name "Test"
cat > "$REPO_CRASH/docs/v10/BOARD.md" <<'EOF'
# Board

| Slice | Status | Notes |
|---|---|---|
| S-1 | ready@2026-09-01T00:00Z | first |
EOF
git -C "$REPO_CRASH" add docs/v10/BOARD.md
git -C "$REPO_CRASH" commit -q -m "seed"
printf '\xff\xfe not valid utf-8' > "$REPO_CRASH/docs/v10/BOARD.md"
git -C "$REPO_CRASH" add docs/v10/BOARD.md
assert_blocked "Guard blocked: invalid-UTF8 staged BOARD.md crashes the python step, fails closed" \
    "git commit -m x" "$REPO_CRASH" "PARSE"

echo ""
echo "--- Broad sanity checks: common commands must never be blocked ---"
assert_allowed "Sanity: git status" "git status" "$SCRIPT_DIR"
assert_allowed "Sanity: git log --oneline -5" "git log --oneline -5" "$SCRIPT_DIR"
assert_allowed "Sanity: ls -la" "ls -la" "$SCRIPT_DIR"
assert_allowed "Sanity: bash -n on a script" "bash -n scripts/v10-guard.sh" "$SCRIPT_DIR"
assert_allowed "Sanity: unrelated string mentioning pkill in a comment/grep" \
    "grep -rn 'pkill -f' tests/" "$SCRIPT_DIR"
assert_allowed "Sanity: quoted string mentioning git push --force" \
    "echo 'never run git push --force here'" "$SCRIPT_DIR"
assert_allowed "Sanity: 'confirm'/'term' do not false-trigger the rm/kill prefilter" \
    "echo 'we can confirm the terms'" "$SCRIPT_DIR"

echo ""
echo "--- Rule 8: checkout-moving git in the primary worktree (E-161) ---"
REPO8="$LOKI_RUN_TMP/repo-rule8"
mkdir -p "$REPO8"
git -C "$REPO8" init -q -b main
git -C "$REPO8" config user.email test@example.com
git -C "$REPO8" config user.name "Test"
echo a > "$REPO8/f.txt"
git -C "$REPO8" add f.txt
git -C "$REPO8" commit -q -m init
git -C "$REPO8" tag v1
git -C "$REPO8" branch other
git -C "$REPO8" worktree add -q -b wtb "$LOKI_RUN_TMP/wt8" main

assert_blocked "R8 blocked: git checkout --detach <tag> in the main checkout" \
    "git checkout --detach v1" "$REPO8" "RULE8"
assert_blocked "R8 blocked: git checkout <tag> in the main checkout" \
    "git checkout v1" "$REPO8" "RULE8"
assert_blocked "R8 blocked: git switch --detach in the main checkout" \
    "git switch --detach v1" "$REPO8" "RULE8"
assert_allowed "R8 allowed: git checkout --detach <tag> in a linked worktree" \
    "git checkout --detach v1" "$LOKI_RUN_TMP/wt8"
assert_allowed "R8 allowed: leader git checkout main in the main checkout" \
    "git checkout main" "$REPO8"
assert_allowed "R8 allowed: leader git merge / revert / commit in the main checkout" \
    "git merge --no-edit other && git revert --no-edit HEAD" "$REPO8"
AGENT_ID="agent-1"
assert_blocked "R8 blocked: subagent git reset --hard in the main checkout" \
    "git -C $REPO8 reset --hard" "$LOKI_RUN_TMP" "RULE"
assert_blocked "R8 blocked: subagent git checkout main in the main checkout" \
    "git checkout main" "$REPO8" "RULE8"
assert_blocked "R8 blocked: subagent git stash in the main checkout" \
    "git stash" "$REPO8" "RULE8"
assert_blocked "R8 blocked: subagent git clean -fd in the main checkout" \
    "git clean -fd" "$REPO8" "RULE8"
assert_blocked "R8 blocked: subagent git worktree remove of the main checkout" \
    "git worktree remove --force $REPO8" "$LOKI_RUN_TMP/wt8" "RULE8"
assert_allowed "R8 allowed: subagent git checkout in a linked worktree" \
    "git checkout other" "$LOKI_RUN_TMP/wt8"
assert_blocked "R8 blocked: subagent cd with no failure handling falls back to main checkout" \
    "cd $LOKI_RUN_TMP/wt8; git checkout --detach v1" "$REPO8" "RULE8"
assert_blocked "R8 blocked: unchecked cd, leader, detached checkout from main-checkout cwd" \
    "cd /nonexistent-dir-e161; git checkout --detach v1" "$REPO8" "RULE8"
assert_allowed "R8 allowed: cd guarded by && into a linked worktree" \
    "cd $LOKI_RUN_TMP/wt8 && git checkout --detach v1" "$REPO8"
AGENT_ID=""

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}ALL TESTS PASSED${NC}"
    exit 0
else
    echo -e "${RED}${BOLD}SOME TESTS FAILED${NC}"
    exit 1
fi
