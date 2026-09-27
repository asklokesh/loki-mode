#!/usr/bin/env bash
# tests/test-council-managed-diff-target.sh
#
# S-196: council_managed_should_stop built diff_summary from
# `cd "${PROJECT_DIR:-$(pwd)}" && git diff --stat`. In production run.sh sets
# PROJECT_DIR to Loki's own install tree, so the managed council was handed
# Loki's diff instead of the target project's change. diff_summary must come
# from ${TARGET_DIR:-.}, the same root as loki_dir and LOKI_TARGET_DIR.
#
# A stub providers.managed (the S-173 stub shape) records _CC_DIFF in
# is_enabled() and declines, so the call stays hermetic (rc 1, Bash fallback).
#   1. The target-only change appears in _CC_DIFF; the install-only one does not.
#   2. No isolated interpreter resolves -> rc 1 and the stub is never reached.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="${COUNCIL_SH:-$REPO_ROOT/autonomy/completion-council.sh}"
[ -f "$COUNCIL_SH" ] || { echo "FAIL: cannot find $COUNCIL_SH"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git missing"; exit 0; }

PASS=0; FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || { echo "FAIL: mktemp"; exit 1; }
trap 'rm -rf -- "$WORK"' EXIT
provider_before="$([ -e "$REPO_ROOT/.loki/state/provider" ] && echo y || echo n)"

g() { local d="$1"; shift; git -C "$d" -c user.email=t@loki.local -c user.name=t -c commit.gpgsign=false "$@"; }

# Install tree: a git repo holding the stub modules plus an uncommitted change.
INSTALL="$WORK/install"
mkdir -p "$INSTALL/providers" "$INSTALL/memory/managed_memory"
: > "$INSTALL/providers/__init__.py"
: > "$INSTALL/memory/__init__.py"
: > "$INSTALL/memory/managed_memory/__init__.py"
printf '%s\n' 'def emit_managed_event(*a, **k): pass' > "$INSTALL/memory/managed_memory/events.py"
cat > "$INSTALL/providers/managed.py" <<'EOF'
import os
class ManagedUnavailable(Exception): pass
def run_completion_council(**k): raise ManagedUnavailable("stub")
def is_enabled():
    with open(os.environ["S196_CAPTURE"], "w") as fh:
        fh.write(os.environ.get("_CC_DIFF", ""))
    return False
EOF
printf 'seed\n' > "$INSTALL/install-only.txt"
git init -q "$INSTALL" && g "$INSTALL" add -A && g "$INSTALL" commit -qm seed
printf 'changed\n' >> "$INSTALL/install-only.txt"

# Target project: one committed file, then changed in the working tree only.
TARGET="$WORK/target"
mkdir -p "$TARGET"
printf 'seed\n' > "$TARGET/target-only.txt"
git init -q "$TARGET" && g "$TARGET" add target-only.txt && g "$TARGET" commit -qm seed
printf 'changed\n' >> "$TARGET/target-only.txt"

run_managed() { # <capture-file> [nopy] -> echoes rc
    (
        cd "$TARGET" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_debug() { :; }
        # shellcheck source=/dev/null
        source "$COUNCIL_SH" >/dev/null 2>&1 || exit 98
        [ "${2:-}" = nopy ] && _loki_snapshot_py_tool() { return 1; }
        export COUNCIL_STATE_DIR="$TARGET/.loki/council" TARGET_DIR="$TARGET" ITERATION_COUNT=3
        export PROJECT_DIR="$INSTALL" S196_CAPTURE="$1" LOKI_NO_BROWSER=1
        export LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true LOKI_EXPERIMENTAL_MANAGED_AGENTS=true LOKI_MANAGED_AGENTS=true
        council_managed_should_stop >/dev/null 2>&1
    )
    echo "$?"
}

# Leg 1: diff comes from the target.
cap="$WORK/diff.cap"
rc="$(run_managed "$cap")"
if [ ! -f "$cap" ]; then
    bad "stub never reached (rc $rc)"
else
    diff_seen="$(cat "$cap")"
    case "$diff_seen" in
        *target-only.txt*) ok "_CC_DIFF names the target-only change" ;;
        *) bad "_CC_DIFF lacks the target-only change: '$diff_seen'" ;;
    esac
    case "$diff_seen" in
        *install-only.txt*) bad "_CC_DIFF names the install-tree change: '$diff_seen'" ;;
        *) ok "_CC_DIFF does not name the install-tree change" ;;
    esac
    [ "$rc" = 1 ] && ok "declining stub -> rc 1 (Bash fallback)" || bad "declining stub rc $rc, want 1"
fi

# Leg 2: no isolated interpreter -> rc 1, never reaches the managed session.
cap2="$WORK/nopy.cap"
rc="$(run_managed "$cap2" nopy)"
[ "$rc" = 1 ] && ok "no interpreter -> rc 1" || bad "no interpreter rc $rc, want 1"
[ ! -e "$cap2" ] && ok "no interpreter -> managed session never started" || bad "no interpreter still ran the managed session"

provider_after="$([ -e "$REPO_ROOT/.loki/state/provider" ] && echo y || echo n)"
[ "$provider_before" = "$provider_after" ] && ok "no .loki/state/provider written into the repo" \
    || bad "a .loki/state/provider appeared in the repo"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
