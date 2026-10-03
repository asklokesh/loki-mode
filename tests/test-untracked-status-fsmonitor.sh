#!/usr/bin/env bash
# shellcheck source=tests/lib/isolated-git-home.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1
# S-218 (BACKLOG 131c): _loki_untracked_status runs `git status` in the
# agent's repo. A repo-local core.fsmonitor names a command git executes on
# every status, so an agent that writes .git/config could run code inside the
# snapshot step. The status call must pass -c core.fsmonitor=false and
# -c core.untrackedCache=false.
#
# Leg 1: the real run.sh function writes no fsmonitor marker and still lists
# a real untracked file. Leg 2 (positive control): the same function with the
# two -c flags stripped DOES write the marker, so leg 1 is not vacuous.
# Functions are extracted by name; run.sh is never sourced whole.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${RUN_SH:-$SCRIPT_DIR/../autonomy/run.sh}"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; [ -n "${2:-}" ] && echo "  $2"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s218.XXXXXX")" || exit 1
trap 'rm -rf "$WORK" "$ISOLATED_GIT_HOME"' EXIT

extract() {
    # extract <run.sh> <out>: the two functions, by name, verbatim.
    awk '
        /^_loki_snapshot_git_tool\(\) \{/ || /^_loki_untracked_status\(\) \{/ { p = 1 }
        p { print }
        p && /^\}/ { p = 0 }
    ' "$1" > "$2"
    grep -q '^_loki_untracked_status() {' "$2" && grep -q '^_loki_snapshot_git_tool() {' "$2"
}

# run_case <lib> <tag>: fresh repo whose .git/config sets core.fsmonitor to a
# marker-writing hook; prints MARKER=yes|no and LISTED=yes|no.
run_case() {
    local lib="$1" tag="$2" repo="$WORK/repo-$2" marker="$WORK/marker-$2"
    mkdir -p "$repo" || return 1
    git -C "$repo" init -q || return 1
    printf '#!/bin/sh\ntouch "%s"\nexit 1\n' "$marker" > "$WORK/hook-$tag.sh"
    chmod +x "$WORK/hook-$tag.sh"
    git -C "$repo" config core.fsmonitor "$WORK/hook-$tag.sh"
    : > "$repo/real-untracked.txt"
    (
        cd "$repo" || exit 1
        # shellcheck source=/dev/null
        . "$lib"
        _loki_untracked_status "$WORK/status-$tag" || exit 1
    ) || { echo "STATUS_RC=nonzero"; }
    [ -e "$marker" ] && echo "MARKER=yes" || echo "MARKER=no"
    if [ -f "$WORK/status-$tag" ] && tr '\0' '\n' < "$WORK/status-$tag" | grep -qx '?? real-untracked.txt'; then
        echo "LISTED=yes"
    else
        echo "LISTED=no"
    fi
}

# Scratch cwd so nothing the functions do can land in the repo.
cd "$WORK" || exit 1

# Leg 1: the shipped function.
if extract "$RUN_SH" "$WORK/lib-real.sh"; then
    pass "extracted _loki_snapshot_git_tool and _loki_untracked_status by name"
else
    fail "could not extract the functions from $RUN_SH"
fi
out1="$(run_case "$WORK/lib-real.sh" real)"
case "$out1" in *MARKER=no*) pass "no fsmonitor marker written by _loki_untracked_status" ;;
    *) fail "core.fsmonitor hook ran during _loki_untracked_status" "$out1" ;; esac
case "$out1" in *LISTED=yes*) pass "real untracked file still listed" ;;
    *) fail "real untracked file missing from the status output" "$out1" ;; esac

# The untracked cache has no cheap behavioral probe; require its flag by text.
if grep -q -- '-c core\.fsmonitor=false -c core\.untrackedCache=false' "$WORK/lib-real.sh"; then
    pass "status call carries -c core.fsmonitor=false -c core.untrackedCache=false"
else
    fail "status call lacks -c core.fsmonitor=false -c core.untrackedCache=false"
fi

# Leg 2: positive control, flags stripped in a scratch copy.
sed -e 's/ -c core\.fsmonitor=false//' -e 's/ -c core\.untrackedCache=false//' \
    "$WORK/lib-real.sh" > "$WORK/lib-mut.sh"
if cmp -s "$WORK/lib-real.sh" "$WORK/lib-mut.sh"; then
    fail "mutation found no -c core.fsmonitor=false / core.untrackedCache=false flags to strip"
else
    out2="$(run_case "$WORK/lib-mut.sh" mut)"
    case "$out2" in *MARKER=yes*) pass "control: without the -c flags the hook runs (fixture is live)" ;;
        *) fail "control: hook did not run even without the flags; fixture is dead" "$out2" ;; esac
fi

# Filter-driver legs: a tracked, stat-dirty file plus a clean/process filter
# driver named in .git/info/attributes makes git run the driver during status.
# run_filter_case <lib> <tag> <clean|process>: prints MARKER=yes|no.
run_filter_case() {
    local lib="$1" tag="$2" kind="$3" repo="$WORK/frepo-$2-$3" marker="$WORK/fmarker-$2-$3"
    mkdir -p "$repo" || return 1
    git -C "$repo" init -q || return 1
    git -C "$repo" config user.email t@example.invalid
    git -C "$repo" config user.name t
    printf 'aa\n' > "$repo/tracked.txt"
    git -C "$repo" add tracked.txt && git -C "$repo" commit -q -m init || return 1
    git -C "$repo" config "filter.evil.$kind" "touch '$marker'; cat"
    git -C "$repo" config filter.evil.required true
    printf '* filter=evil\n' > "$repo/.git/info/attributes"
    printf 'bb\n' > "$repo/tracked.txt"
    touch -t 200001010000 "$repo/tracked.txt"
    (
        cd "$repo" || exit 1
        # shellcheck source=/dev/null
        . "$lib"
        _loki_untracked_status "$WORK/fstatus-$tag-$kind" || true
    ) >/dev/null 2>&1
    [ -e "$marker" ] && echo "MARKER=yes" || echo "MARKER=no"
}

for kind in clean process; do
    outf="$(run_filter_case "$WORK/lib-real.sh" real "$kind")"
    case "$outf" in *MARKER=no*) pass "no filter.evil.$kind marker written by _loki_untracked_status" ;;
        *) fail "filter driver ($kind) ran during _loki_untracked_status" "$outf" ;; esac
done

# Positive control: the same function without the filter neutralization runs
# the driver, so the legs above are not vacuous.
awk '/fargs\+=|"\$\{fargs\[@\]\}"|\$\{fargs\[@\]\+/ { next } { print }' \
    "$WORK/lib-real.sh" > "$WORK/lib-nofilter.sh"
if cmp -s "$WORK/lib-real.sh" "$WORK/lib-nofilter.sh"; then
    fail "filter mutation found no fargs lines to strip"
else
    outc="$(run_filter_case "$WORK/lib-nofilter.sh" nofilter clean)"
    case "$outc" in *MARKER=yes*) pass "control: without the filter overrides the driver runs (fixture is live)" ;;
        *) fail "control: filter driver did not run even without overrides; fixture is dead" "$outc" ;; esac
fi

if [ -e "$REPO_ROOT/.loki/state/provider" ] && [ "$REPO_ROOT/.loki/state/provider" -nt "$WORK" ]; then
    fail "a .loki/state/provider appeared in the repo during this test"
else
    pass "no .loki/state/provider written into the repo"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
