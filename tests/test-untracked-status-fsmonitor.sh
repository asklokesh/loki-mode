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

# Positive control: the same function with the config overrides zeroed runs
# the driver, so the legs above are not vacuous.
sed -e 's/"GIT_CONFIG_COUNT=\${n}"/"GIT_CONFIG_COUNT=0"/' \
    "$WORK/lib-real.sh" > "$WORK/lib-nofilter.sh"
if cmp -s "$WORK/lib-real.sh" "$WORK/lib-nofilter.sh"; then
    fail "filter mutation found no GIT_CONFIG_COUNT line to zero"
else
    outc="$(run_filter_case "$WORK/lib-nofilter.sh" nofilter clean)"
    case "$outc" in *MARKER=yes*) pass "control: without the filter overrides the driver runs (fixture is live)" ;;
        *) fail "control: filter driver did not run even without overrides; fixture is dead" "$outc" ;; esac
fi

# Driver names containing "=": `git -c` would split at the first "=" and miss
# them. run_eq_case <lib> <tag> <clean|process> <plain|real>: MARKER=yes|no.
# "plain" runs bare `git status` instead of the function (positive control).
run_eq_case() {
    local lib="$1" tag="$2" kind="$3" mode="$4" repo="$WORK/erepo-$2-$3-$4" marker="$WORK/emarker-$2-$3-$4"
    mkdir -p "$repo" || return 1
    git -C "$repo" init -q || return 1
    git -C "$repo" config user.email t@example.invalid
    git -C "$repo" config user.name t
    printf 'aa\n' > "$repo/f.txt"
    git -C "$repo" add f.txt && git -C "$repo" commit -q -m init || return 1
    git -C "$repo" config "filter.x=y.$kind" "touch '$marker'; cat"
    git -C "$repo" config "filter.x=y.required" true
    printf 'f.txt filter=x=y\n' > "$repo/.git/info/attributes"
    printf 'bb\n' > "$repo/f.txt"
    touch -t 203001010000 "$repo/f.txt"
    (
        cd "$repo" || exit 1
        if [ "$mode" = plain ]; then
            git status --porcelain >/dev/null 2>&1
        else
            # shellcheck source=/dev/null
            . "$lib"
            _loki_untracked_status "$WORK/estatus-$tag-$kind" || true
        fi
    ) >/dev/null 2>&1
    [ -e "$marker" ] && echo "MARKER=yes" || echo "MARKER=no"
}
for kind in clean process; do
    oute="$(run_eq_case "$WORK/lib-real.sh" eq "$kind" real)"
    case "$oute" in *MARKER=no*) pass "no hook run for driver name containing '=' ($kind)" ;;
        *) fail "driver named x=y ($kind) ran during _loki_untracked_status" "$oute" ;; esac
    outp="$(run_eq_case "$WORK/lib-real.sh" eq "$kind" plain)"
    case "$outp" in *MARKER=yes*) pass "control: plain git status runs the x=y $kind driver (fixture is live)" ;;
        *) fail "control: plain git status did not run the x=y $kind driver" "$outp" ;; esac
done

# Partial-clone lazy fetch: .gitattributes is skip-worktree with its blob
# missing, so status fetches it over core.sshCommand (a repo-config command).
run_lazy_case() {
    local lib="$1" tag="$2" mode="$3" repo="$WORK/lrepo-$2-$3" marker="$WORK/lmarker-$2-$3" blob=""
    mkdir -p "$repo" || return 1
    git -C "$repo" init -q || return 1
    git -C "$repo" config user.email t@example.invalid
    git -C "$repo" config user.name t
    printf 'f.txt text\n' > "$repo/.gitattributes"
    printf 'aa\n' > "$repo/f.txt"
    git -C "$repo" add .gitattributes f.txt && git -C "$repo" commit -q -m init || return 1
    blob="$(git -C "$repo" rev-parse HEAD:.gitattributes)"
    git -C "$repo" update-index --skip-worktree .gitattributes
    rm -f "$repo/.gitattributes" "$repo/.git/objects/${blob:0:2}/${blob:2}"
    printf '#!/bin/sh\ntouch "%s"\nexit 1\n' "$marker" > "$WORK/lhook-$tag-$mode.sh"
    chmod +x "$WORK/lhook-$tag-$mode.sh"
    git -C "$repo" config core.repositoryformatversion 1
    git -C "$repo" config extensions.partialClone origin
    git -C "$repo" config remote.origin.promisor true
    git -C "$repo" config remote.origin.url ssh://host/x
    git -C "$repo" config core.sshCommand "$WORK/lhook-$tag-$mode.sh"
    (
        cd "$repo" || exit 1
        if [ "$mode" = plain ]; then
            git status --porcelain >/dev/null 2>&1
        else
            # shellcheck source=/dev/null
            . "$lib"
            _loki_untracked_status "$WORK/lstatus-$tag" || true
        fi
    ) >/dev/null 2>&1
    [ -e "$marker" ] && echo "MARKER=yes" || echo "MARKER=no"
}
outl="$(run_lazy_case "$WORK/lib-real.sh" lazy real)"
case "$outl" in *MARKER=no*) pass "no core.sshCommand hook run by a partial-clone lazy fetch" ;;
    *) fail "lazy fetch ran core.sshCommand during _loki_untracked_status" "$outl" ;; esac
outlp="$(run_lazy_case "$WORK/lib-real.sh" lazy plain)"
case "$outlp" in *MARKER=yes*) pass "control: plain git status lazy-fetches and runs the hook (fixture is live)" ;;
    *) fail "control: plain git status did not run the lazy-fetch hook" "$outlp" ;; esac

if [ -e "$REPO_ROOT/.loki/state/provider" ] && [ "$REPO_ROOT/.loki/state/provider" -nt "$WORK" ]; then
    fail "a .loki/state/provider appeared in the repo during this test"
else
    pass "no .loki/state/provider written into the repo"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
