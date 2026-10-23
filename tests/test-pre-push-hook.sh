#!/usr/bin/env bash
# Asserts the pre-push hook's post-D27 contract.
#
# D27 (docs/v10/DECISIONS.md) retired the local pytest run from this hook --
# GitHub CI is the gate now. This file used to be test-pre-push-scoped-pytest.sh
# and asserted the removed scoping logic; it now asserts what replaced it:
#
#   1. wrong git identity on a github.com push -> hook blocks
#   2. a bash -n syntax error in autonomy/run.sh or autonomy/loki -> hook blocks
#   3. the hook source contains no pytest invocation (D27 removed it for good,
#      not just "skipped this run" -- a source check is the right tool here
#      because the property under test IS "this code path does not exist",
#      not runtime behavior a stub could fake)
#   4. a clean push-equivalent invocation completes in under 5 seconds,
#      measured 3 times on the real hook (no stubs)
#
# Every case runs the real hook in a scratch clone, never the real repo.

set -uo pipefail

# The caller (a release shell) may carry these; the refusal cases below
# are only real measurements if they start from an unset environment.
unset LOKI_RELEASE_MANAGER PRE_PUSH_SKIP

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/.githooks/pre-push"

passed=0
failed=0

ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: pre-push hook (post-D27)"

[[ -f "$HOOK" ]] || { echo "  FAIL: hook not found at $HOOK"; exit 1; }
if bash -n "$HOOK" 2>/dev/null; then ok "hook parses"; else ko "hook parses"; fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-prepush-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Build a scratch repo with a valid identity, valid shell files, and the real
# hook installed. Callers mutate it per-case before running the hook.
setup_clone() {
    local dir="$1"
    rm -rf "$dir"; mkdir -p "$dir/autonomy"
    cd "$dir" || return 1

    git init -q .
    git -C "$dir" config user.name asklokesh
    git -C "$dir" config user.email lokeshmure@live.com
    git -C "$dir" config commit.gpgsign false

    mkdir -p .githooks && cp "$HOOK" .githooks/pre-push
    echo 'true' > autonomy/run.sh
    echo 'true' > autonomy/loki

    git -C "$dir" add -A >/dev/null 2>&1
    git -C "$dir" commit -q -m base --no-verify >/dev/null 2>&1
    git -C "$dir" branch -f main HEAD >/dev/null 2>&1
    git -C "$dir" remote add origin . >/dev/null 2>&1
    git -C "$dir" update-ref refs/remotes/origin/main HEAD
}

# Runs the hook the way git actually invokes it: remote name + URL on argv,
# the updated-ref line on stdin. Echoes "RC=<n>".
run_hook() {
    local dir="$1" url="${2:-https://github.com/asklokesh/loki-mode}"
    local rref="${3:-refs/heads/main}"
    cd "$dir" || return 1
    local sha
    sha="$(git -C "$dir" rev-parse HEAD)"
    printf 'refs/heads/main %s %s %s\n' "$sha" "$rref" "$sha" \
        | PRE_PUSH_NO_CI_CHECK=1 bash .githooks/pre-push origin "$url" \
              >"$dir/hook.out" 2>&1
    echo "RC=$?"
}

# Every git in this test must act on a scratch clone. A bare `git commit` run
# from the wrong cwd commits into the REAL repository -- that happened once
# during development and rewrote this branch's history. This wrapper makes it
# structurally impossible rather than a matter of remembering to cd.
g() {
    local d="$1"; shift
    case "$d" in
        "$SCRATCH"/*) : ;;
        *) echo "  FATAL: refusing git outside scratch: $d" >&2; exit 1 ;;
    esac
    git -C "$d" "$@"
}

# --- case 1: wrong identity on a github.com push blocks -----------------------
D="$SCRATCH/c1"; setup_clone "$D"
g "$D" config user.name murel002
g "$D" config user.email murel002@example.com
rc="$(LOKI_RELEASE_MANAGER=1 run_hook "$D")"
if [[ "$rc" == "RC=0" ]]; then
    ko "wrong identity blocks a github.com push" "hook exited 0; out: $(cat "$D/hook.out")"
elif grep -q "requires identity asklokesh" "$D/hook.out"; then
    ok "wrong identity blocks a github.com push"
else
    ko "wrong identity blocks a github.com push" "blocked but not on identity: $(cat "$D/hook.out")"
fi

# --- case 2: a bash -n syntax error blocks -------------------------------------
D="$SCRATCH/c2"; setup_clone "$D"
echo 'if [[ true' >> autonomy/run.sh
g "$D" add autonomy/run.sh >/dev/null 2>&1
g "$D" commit -q -m "break syntax" --no-verify >/dev/null 2>&1
rc="$(LOKI_RELEASE_MANAGER=1 run_hook "$D")"
if [[ "$rc" == "RC=0" ]]; then
    ko "a bash -n syntax error blocks the push" "hook exited 0; out: $(cat "$D/hook.out")"
elif grep -q "syntax errors" "$D/hook.out"; then
    ok "a bash -n syntax error blocks the push"
else
    ko "a bash -n syntax error blocks the push" "blocked but not on syntax: $(cat "$D/hook.out")"
fi

# --- case 3: no pytest invocation remains in the hook --------------------------
# A source check, not a behavioral one -- D27 removed the code path entirely,
# so there is nothing at runtime left to stub around. Strips comment lines
# first, then looks for the word anywhere else -- the D27 explanatory comment
# above legitimately names what was removed and why, but no non-comment line
# may reference pytest in any invocation shape (`-m pytest`, `pytest -q`,
# `pytest tests/`, ...).
if grep -v '^[[:space:]]*#' "$HOOK" | grep -qw pytest; then
    ko "the hook contains no pytest invocation" "found a non-comment pytest reference in $HOOK"
else
    ok "the hook contains no pytest invocation"
fi

# --- case 4: a clean run completes in under 5 seconds, 3 times -----------------
D="$SCRATCH/c4"; setup_clone "$D"
_slow=0
for _i in 1 2 3; do
    _start=$(date +%s)
    rc="$(LOKI_RELEASE_MANAGER=1 run_hook "$D")"
    _end=$(date +%s)
    _elapsed=$((_end - _start))
    if [[ "$rc" != "RC=0" ]]; then
        ko "clean run $_i passes" "out: $(cat "$D/hook.out")"
    elif [[ $_elapsed -ge 5 ]]; then
        ko "clean run $_i completes under 5s" "took ${_elapsed}s"
        _slow=1
    else
        ok "clean run $_i completes under 5s (${_elapsed}s)"
    fi
done

# --- only a release shell pushes main, never from a linked worktree -
# Incident 2026-09-27 18:35Z: an agent in a .claude/worktrees/* worktree pushed
# 28926937 to origin main. expect_refused <label> <out-pattern> <dir> [env...]
expect_refused() {
    local label="$1" pat="$2" dir="$3"; shift 3
    local rc
    # Args are KEY=VALUE pairs, so export "$@" exports each one (SC2163 false positive).
    # shellcheck disable=SC2163
    rc="$( [[ $# -gt 0 ]] && export "$@"; run_hook "$dir" )"
    if [[ "$rc" == "RC=0" ]]; then
        ko "$label" "hook exited 0; out: $(cat "$dir/hook.out")"
    elif grep -q "$pat" "$dir/hook.out"; then
        ok "$label"
    else
        ko "$label" "refused but not on '$pat': $(cat "$dir/hook.out")"
    fi
}

D="$SCRATCH/c5"; setup_clone "$D"
expect_refused "push of main without LOKI_RELEASE_MANAGER=1 is refused" \
    "LOKI_RELEASE_MANAGER=1" "$D"
expect_refused "PRE_PUSH_SKIP=1 does not bypass the main-push marker check" \
    "LOKI_RELEASE_MANAGER=1" "$D" PRE_PUSH_SKIP=1

rc="$(LOKI_RELEASE_MANAGER=1 run_hook "$D")"
if [[ "$rc" == "RC=0" ]]; then
    ok "push of main with LOKI_RELEASE_MANAGER=1 from the main checkout is allowed"
else
    ko "push of main with LOKI_RELEASE_MANAGER=1 from the main checkout is allowed" \
        "$rc; out: $(cat "$D/hook.out")"
fi

# A guard that refused every push would pass the refusal cases above; this is
# the allow path PR-branch pushes depend on.
rc="$(run_hook "$D" "https://github.com/asklokesh/loki-mode" refs/heads/feat)"
if [[ "$rc" == "RC=0" ]]; then
    ok "push of a non-main ref without the marker from the main checkout is allowed"
else
    ko "push of a non-main ref without the marker from the main checkout is allowed" \
        "$rc; out: $(cat "$D/hook.out")"
fi

WT="$D/.claude/worktrees/agent-1"
g "$D" worktree add -q -b agent-1 "$WT" >/dev/null 2>&1
expect_refused "push from a .claude/worktrees linked worktree is refused (marker set)" \
    "linked worktree" "$WT" LOKI_RELEASE_MANAGER=1
expect_refused "push from a .claude/worktrees worktree is refused under PRE_PUSH_SKIP=1" \
    "linked worktree" "$WT" LOKI_RELEASE_MANAGER=1 PRE_PUSH_SKIP=1

cd "$REPO_ROOT" || true
echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
