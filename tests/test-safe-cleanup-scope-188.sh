#!/usr/bin/env bash
# Regression for run-owned cleanup guidance in root CLAUDE.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CLAUDE_FILE="${ROOT}/CLAUDE.md"
TEMP_ROOT="$(cd /tmp && pwd -P)"
export TMPDIR="$TEMP_ROOT"
HARNESS_DIR=""
UNRELATED_WORKTREE=""
OWNED_DIR=""
# Every fixture path created after the harness dir is appended here, so a case
# added later cannot leak the temp directory this suite exists to protect.
FIXTURE_PATHS=()

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

pass() {
    printf 'ok: %s\n' "$*"
}

cleanup_fixture() {
    set +e
    for target in "$OWNED_DIR" "$UNRELATED_WORKTREE" "${FIXTURE_PATHS[@]+"${FIXTURE_PATHS[@]}"}" "$HARNESS_DIR"; do
        [ -n "$target" ] || continue
        case "$target" in
            "${TEMP_ROOT}"/loki-run.* | "${TEMP_ROOT}"/loki-cleanup-scope-188.*)
                rm -rf -- "$target"
                ;;
            *)
                printf 'Refusing fixture cleanup outside exact test namespaces: %s\n' "$target" >&2
                ;;
        esac
    done
}
trap cleanup_fixture EXIT

[ -f "$CLAUDE_FILE" ] || fail "root CLAUDE.md is missing"
if grep -F 'rm -rf /tmp/loki-' "$CLAUDE_FILE" >/dev/null; then
    fail "broad /tmp cleanup guidance remains"
fi
if grep -F 'rm -rf /tmp/test-' "$CLAUDE_FILE" >/dev/null; then
    fail "broad test-temp cleanup guidance remains"
fi

HARNESS_DIR="$(mktemp -d "${TEMP_ROOT}/loki-cleanup-scope-188.XXXXXXXX")"
HELPERS="${HARNESS_DIR}/helpers.sh"
awk '
    /^<!-- BEGIN LOKI_RUN_TMP_HELPERS -->$/ { capture = 1; next }
    /^<!-- END LOKI_RUN_TMP_HELPERS -->$/ { exit }
    capture && $0 !~ /^\`\`\`/ { print }
' "$CLAUDE_FILE" >"$HELPERS" && AWK_STATUS=0 || AWK_STATUS=$?
if [ ! -s "$HELPERS" ]; then
    # Diagnostics only: the extraction message alone cannot say WHICH step
    # failed. Same test path, no semantic change to the assertion above it.
    printf 'extraction produced %s bytes from %s\n' \
        "$(wc -c <"$HELPERS" | tr -d ' ')" "$CLAUDE_FILE" >&2
    printf 'awk exit status was %s; marker lines present in source:\n' "$AWK_STATUS" >&2
    grep -n 'LOKI_RUN_TMP_HELPERS' "$CLAUDE_FILE" >&2 || printf '  (no marker lines found)\n' >&2
    fail "safe cleanup helper block was not extracted"
fi
bash -n "$HELPERS" || fail "safe cleanup helper block has invalid shell syntax"
# shellcheck source=/dev/null
source "$HELPERS"

# ---------------------------------------------------------------------------
# Portable stat identity probe.
#
# GNU and BSD stat misparse each other's flag. GNU `-f` means --file-system:
# it exits non-zero but STILL prints a filesystem block to stdout, so the old
# `stat -f ... || stat -c ...` chain captured that block and appended the real
# uid to it, making every Linux cleanup return 64 and leak a run-owned dir.
#
# Each case below replaces `stat` with a stub that emulates ONE platform and
# logs the flag it was called with. The log is asserted non-empty and asserted
# to name each expected form individually, so a stub that never entered the
# code path cannot green-wash the case by leaving the real stat in play.
# ---------------------------------------------------------------------------

STAT_LOG=""

# The real stat form for THIS host, resolved once. The stubs below must read
# genuine uid/mode values without going through the broken `-f || -c` chain --
# using that chain here would reproduce the defect inside the test harness and
# make the Linux cases die before they reach the mode probe.
if command stat -c '%u' -- "$ROOT" >/dev/null 2>&1; then
    HOST_STAT_FLAG='-c'
    HOST_FMT_UID='%u'
    HOST_FMT_MODE='%a'
elif command stat -f '%u' -- "$ROOT" >/dev/null 2>&1; then
    HOST_STAT_FLAG='-f'
    HOST_FMT_UID='%u'
    HOST_FMT_MODE='%Lp'
else
    fail "neither GNU nor BSD stat form works on this host"
fi

host_stat() {
    local want="$1" path="$2" fmt
    case "$want" in
        uid) fmt="$HOST_FMT_UID" ;;
        *) fmt="$HOST_FMT_MODE" ;;
    esac
    command stat "$HOST_STAT_FLAG" "$fmt" -- "$path" 2>/dev/null
}

# Runs loki_run_tmp_cleanup in a subshell against a stub `stat`. Prints the
# helper's return code. $1 selects the stub flavour.
run_cleanup_with_stat_stub() {
    local flavour="$1" target="$2"
    (
        stat() {
            # The helper calls `stat <flag> <fmt> -- <path>`, so the path is the
            # LAST argument, not $3. Resolving it positionally would silently
            # stat "--" and make every stub case fall through.
            local flag="$1" fmt="$2" path
            eval "path=\${$#}"
            printf '%s %s\n' "$flag" "$fmt" >>"$STAT_LOG"
            case "$flavour:$flag" in
                gnu:-c|poison-gnu:-c|unowned:-c|nonnumeric:-c) ;;
                gnu:-f|unowned:-f|nonnumeric:-f)
                    # GNU --file-system: writes to STDOUT and exits non-zero.
                    printf '  File: "%s"\n    ID: 0 Namelen: 255 Type: overlayfs\n' "$path"
                    return 1
                    ;;
                bsd:-c)
                    printf 'stat: illegal option -- c\n' >&2
                    return 1
                    ;;
                bsd:-f) ;;
                fsblock:-c)
                    # No output at all, so the fallback is taken.
                    return 1
                    ;;
                fsblock:-f)
                    # The hosted failure verbatim: GNU --file-system prints a
                    # multi-line block to STDOUT and exits non-zero. The value
                    # must be rejected as non-numeric, not compared as-is.
                    printf '  File: "%s"\n    ID: 0 Namelen: 255 Type: overlayfs\nBlocks: Total: 1 Free: 1\n' "$path"
                    return 1
                    ;;
                poison-gnu:-f)
                    printf 'garbage\n'
                    return 1
                    ;;
                *) return 1 ;;
            esac
            case "$flavour" in
                unowned)
                    # A uid that is definitively not the current one; the mode
                    # stays faithful so the uid clause is what refuses.
                    case "$fmt" in
                        '%u') printf '%s\n' "$(( $(id -u) + 1 ))" ;;
                        *) host_stat mode "$path" ;;
                    esac
                    ;;
                nonnumeric|poison-gnu|fsblock)
                    printf 'not-a-number\n'
                    ;;
                *)
                    # Faithful values, read through this host's working form.
                    case "$fmt" in
                        '%u') host_stat uid "$path" ;;
                        *) host_stat mode "$path" ;;
                    esac
                    ;;
            esac
        }
        LOKI_RUN_TMP="$target"
        loki_run_tmp_cleanup >/dev/null 2>&1
        printf '%s' "$?"
    )
}

# Builds a fresh run-owned directory shaped exactly like loki_run_tmp_create's
# and assigns it to the caller-named variable. This deliberately does NOT print
# the path for capture: `dir=$(make_owned_fixture)` would run the append to
# FIXTURE_PATHS in a subshell, the parent would never learn the path, and the
# fixture would leak -- the exact bug class this suite exists to catch.
make_owned_fixture() {
    local __out_var="$1" dir
    dir="$(mktemp -d "${TEMP_ROOT}/loki-run.stub-188.XXXXXXXX")"
    chmod 700 "$dir"
    printf '%s\n' "$dir" >"${dir}/.loki-run-owned"
    chmod 600 "${dir}/.loki-run-owned"
    FIXTURE_PATHS+=("$dir")
    printf -v "$__out_var" '%s' "$dir"
}

assert_log_records() {
    local label="$1" form="$2"
    [ -s "$STAT_LOG" ] || fail "${label}: stat stub was never called (case is vacuous)"
    grep -qF -- "$form" "$STAT_LOG" ||
        fail "${label}: stub log never recorded '${form}' (case is vacuous)"
}

# Case 1: Linux/GNU. -c succeeds; -f would emit a filesystem block on stdout.
STAT_LOG="${HARNESS_DIR}/stat-gnu.log"
: >"$STAT_LOG"
make_owned_fixture GNU_DIR
GNU_RC="$(run_cleanup_with_stat_stub gnu "$GNU_DIR")"
# Outcome first: with the published defect restored this must report the LEAK,
# not "vacuous", or the suite misdiagnoses the very bug it exists to catch.
[ "$GNU_RC" = "0" ] || fail "GNU/Linux stat form: cleanup returned $GNU_RC, expected 0"
[ ! -e "$GNU_DIR" ] || fail "GNU/Linux stat form: run-owned directory leaked"
assert_log_records "GNU stub" "-c %u"
assert_log_records "GNU stub" "-c %a"
pass "GNU/Linux stat form removes the run-owned directory"

# Case 2: macOS/BSD. -c fails with a usage line on stderr; -f succeeds.
STAT_LOG="${HARNESS_DIR}/stat-bsd.log"
: >"$STAT_LOG"
make_owned_fixture BSD_DIR
BSD_RC="$(run_cleanup_with_stat_stub bsd "$BSD_DIR")"
[ "$BSD_RC" = "0" ] || fail "macOS/BSD stat form: cleanup returned $BSD_RC, expected 0"
[ ! -e "$BSD_DIR" ] || fail "macOS/BSD stat form: run-owned directory leaked"
assert_log_records "BSD stub" "-c %u"
assert_log_records "BSD stub" "-f %u"
pass "macOS/BSD stat form removes the run-owned directory"

# Case 3: the exact published defect. Both forms yield non-numeric text, which
# is what the old chain silently compared against $(id -u). Must fail closed.
STAT_LOG="${HARNESS_DIR}/stat-poison.log"
: >"$STAT_LOG"
make_owned_fixture POISON_DIR
POISON_RC="$(run_cleanup_with_stat_stub poison-gnu "$POISON_DIR")"
assert_log_records "poisoned stub" "-c %u"
[ "$POISON_RC" = "64" ] ||
    fail "contaminated stat output: cleanup returned $POISON_RC, expected 64"
[ -d "$POISON_DIR" ] || fail "contaminated stat output: directory was removed anyway"
pass "contaminated stat output fails closed and preserves the directory"

# Case 3b: the hosted defect verbatim -- a filesystem block arriving on STDOUT
# from the fallback form. Without numeric validation this block is compared
# against $(id -u) as an opaque string, which is exactly how the published
# helper returned 64 and leaked the directory on every Linux host.
STAT_LOG="${HARNESS_DIR}/stat-fsblock.log"
: >"$STAT_LOG"
make_owned_fixture FSBLOCK_DIR
FSBLOCK_RC="$(run_cleanup_with_stat_stub fsblock "$FSBLOCK_DIR")"
assert_log_records "filesystem-block stub" "-c %u"
assert_log_records "filesystem-block stub" "-f %u"
[ "$FSBLOCK_RC" = "64" ] ||
    fail "filesystem block on stdout: cleanup returned $FSBLOCK_RC, expected 64"
[ -d "$FSBLOCK_DIR" ] || fail "filesystem block on stdout: directory was removed anyway"
pass "a filesystem block on stdout fails closed and preserves the directory"

# Case 4: unowned. A uid other than the caller's must refuse, on either form.
STAT_LOG="${HARNESS_DIR}/stat-unowned.log"
: >"$STAT_LOG"
make_owned_fixture UNOWNED_DIR
UNOWNED_RC="$(run_cleanup_with_stat_stub unowned "$UNOWNED_DIR")"
assert_log_records "unowned stub" "-c %u"
[ "$UNOWNED_RC" = "64" ] || fail "foreign uid: cleanup returned $UNOWNED_RC, expected 64"
[ -d "$UNOWNED_DIR" ] || fail "foreign uid: directory was removed anyway"
pass "a uid other than the caller's fails closed"

# Case 5: mode identity. Reopening the directory to other users must refuse,
# even though uid and marker still match.
make_owned_fixture WIDE_DIR
chmod 755 "$WIDE_DIR"
LOKI_RUN_TMP="$WIDE_DIR"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup accepted a directory reopened to mode 755"
fi
[ -d "$WIDE_DIR" ] || fail "mode 755 directory was removed anyway"
unset LOKI_RUN_TMP
pass "a directory widened past 700 fails closed"

# Case 5b: setgid temp root. GNU '%a' reports the setuid/setgid/sticky digit and
# BSD '%Lp' does not, and `mktemp -d` under a g+s root inherits setgid that a
# three-digit `chmod 700` preserves. Comparing the raw value against "700"
# reads 2700 on Linux and leaks the run-owned directory -- the same
# platform-asymmetric fail-closed-and-leak this suite exists to prevent.
SETGID_ROOT="${TEMP_ROOT}/loki-cleanup-scope-188.setgid.$$"
mkdir -p "$SETGID_ROOT"
FIXTURE_PATHS+=("$SETGID_ROOT")
if chmod g+s "$SETGID_ROOT" 2>/dev/null &&
    case "$(host_stat mode "$SETGID_ROOT")" in *[2367]??) true ;; *) false ;; esac
then
    SETGID_DIR="$(mktemp -d "${SETGID_ROOT}/loki-run.setgid-188.XXXXXXXX")"
    chmod 700 "$SETGID_DIR"
    printf '%s\n' "$SETGID_DIR" >"${SETGID_DIR}/.loki-run-owned"
    chmod 600 "${SETGID_DIR}/.loki-run-owned"
    (
        TMPDIR="$SETGID_ROOT"
        export TMPDIR
        LOKI_RUN_TMP="$SETGID_DIR"
        export LOKI_RUN_TMP
        loki_run_tmp_cleanup
    ) || fail "setgid temp root: cleanup refused a genuinely run-owned directory"
    [ ! -e "$SETGID_DIR" ] || fail "setgid temp root: run-owned directory leaked"
    pass "a run-owned directory under a setgid temp root is removed"

    # And the widened case must STILL refuse when setgid is also present.
    SETGID_WIDE="$(mktemp -d "${SETGID_ROOT}/loki-run.setgid-wide-188.XXXXXXXX")"
    chmod 2755 "$SETGID_WIDE"
    printf '%s\n' "$SETGID_WIDE" >"${SETGID_WIDE}/.loki-run-owned"
    chmod 600 "${SETGID_WIDE}/.loki-run-owned"
    if (
        TMPDIR="$SETGID_ROOT"
        export TMPDIR
        LOKI_RUN_TMP="$SETGID_WIDE"
        export LOKI_RUN_TMP
        loki_run_tmp_cleanup
    ) >/dev/null 2>&1; then
        fail "setgid temp root: cleanup accepted a directory reopened to 755"
    fi
    [ -d "$SETGID_WIDE" ] || fail "setgid temp root: widened directory was removed anyway"
    pass "a widened directory under a setgid temp root still fails closed"
else
    # Stated, never silent: some filesystems refuse g+s outright.
    printf 'skip: host filesystem does not support a setgid temp root\n'
fi

# Case 6: missing marker. The ownership marker is the proof of provenance.
make_owned_fixture NOMARKER_DIR
rm -f -- "${NOMARKER_DIR}/.loki-run-owned"
LOKI_RUN_TMP="$NOMARKER_DIR"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup accepted a directory with no ownership marker"
fi
[ -d "$NOMARKER_DIR" ] || fail "unmarked directory was removed anyway"
unset LOKI_RUN_TMP
pass "a missing ownership marker fails closed"

# Case 7: forged marker. Marker content must equal the target's own path.
make_owned_fixture FORGED_DIR
printf '%s\n' "${TEMP_ROOT}/loki-run.some-other-run" >"${FORGED_DIR}/.loki-run-owned"
chmod 600 "${FORGED_DIR}/.loki-run-owned"
LOKI_RUN_TMP="$FORGED_DIR"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup accepted a marker naming a different path"
fi
[ -d "$FORGED_DIR" ] || fail "forged-marker directory was removed anyway"
unset LOKI_RUN_TMP
pass "a forged ownership marker fails closed"

# Case 8: symlink. The name is inside the namespace but the inode is not, so
# following it would delete an arbitrary directory.
SYMLINK_VICTIM="$(mktemp -d "${TEMP_ROOT}/loki-cleanup-scope-188.victim.XXXXXXXX")"
FIXTURE_PATHS+=("$SYMLINK_VICTIM")
printf '%s\n' "victim-must-survive" >"${SYMLINK_VICTIM}/sentinel"
SYMLINK_PATH="${TEMP_ROOT}/loki-run.symlink-188.$$"
FIXTURE_PATHS+=("$SYMLINK_PATH")
ln -s "$SYMLINK_VICTIM" "$SYMLINK_PATH"
LOKI_RUN_TMP="$SYMLINK_PATH"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup followed a symlink out of the run-owned namespace"
fi
[ -d "$SYMLINK_VICTIM" ] || fail "symlink target directory was removed"
grep -qx 'victim-must-survive' "${SYMLINK_VICTIM}/sentinel" ||
    fail "symlink target contents were changed"
unset LOKI_RUN_TMP
pass "a symlink inside the namespace fails closed"

# Case 9: refusal outside the namespace. Nothing outside the canonical temp
# root may be considered at all, regardless of markers or ownership.
OUTSIDE_DIR="$(mktemp -d "${TEMP_ROOT}/loki-cleanup-scope-188.outside.XXXXXXXX")"
FIXTURE_PATHS+=("$OUTSIDE_DIR")
printf '%s\n' "outside-must-survive" >"${OUTSIDE_DIR}/sentinel"
printf '%s\n' "$OUTSIDE_DIR" >"${OUTSIDE_DIR}/.loki-run-owned"
chmod 700 "$OUTSIDE_DIR"
chmod 600 "${OUTSIDE_DIR}/.loki-run-owned"
LOKI_RUN_TMP="$OUTSIDE_DIR"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup accepted a path outside the run-owned namespace"
fi
[ -d "$OUTSIDE_DIR" ] || fail "out-of-namespace directory was removed"
grep -qx 'outside-must-survive' "${OUTSIDE_DIR}/sentinel" ||
    fail "out-of-namespace contents were changed"
unset LOKI_RUN_TMP
pass "a correctly-marked path outside the namespace still fails closed"

# This is an unrelated Git worktree whose name deliberately matches the
# run-owned namespace and whose marker is forged. The .git guard must still
# make cleanup fail closed.
UNRELATED_WORKTREE="$(mktemp -d "${TEMP_ROOT}/loki-run.unrelated-scope-188.XXXXXXXX")"
git init -q "$UNRELATED_WORKTREE"
printf '%s\n' "unrelated-worktree-must-survive" >"${UNRELATED_WORKTREE}/sentinel"
printf '%s\n' "$UNRELATED_WORKTREE" >"${UNRELATED_WORKTREE}/.loki-run-owned"
chmod 600 "${UNRELATED_WORKTREE}/.loki-run-owned"

LOKI_RUN_TMP="$UNRELATED_WORKTREE"
export LOKI_RUN_TMP
if loki_run_tmp_cleanup >/dev/null 2>&1; then
    fail "cleanup accepted an unrelated Git worktree"
fi
[ -d "${UNRELATED_WORKTREE}/.git" ] || fail "unrelated Git metadata was removed"
grep -qx 'unrelated-worktree-must-survive' "${UNRELATED_WORKTREE}/sentinel" ||
    fail "unrelated sentinel was changed"
unset LOKI_RUN_TMP

loki_run_tmp_create
OWNED_DIR="$LOKI_RUN_TMP"
printf '%s\n' "owned-payload" >"${OWNED_DIR}/payload"
loki_run_tmp_cleanup

[ ! -e "$OWNED_DIR" ] || fail "explicit run-owned temp directory survived cleanup"
[ -d "${UNRELATED_WORKTREE}/.git" ] || fail "unrelated worktree did not survive owned cleanup"
grep -qx 'unrelated-worktree-must-survive' "${UNRELATED_WORKTREE}/sentinel" ||
    fail "unrelated sentinel did not survive owned cleanup"

printf '%s\n' "PASS: explicit run-owned temp removed; unrelated /tmp/loki-* worktree survived"
