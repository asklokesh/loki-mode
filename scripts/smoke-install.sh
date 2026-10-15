#!/usr/bin/env bash
# scripts/smoke-install.sh -- install-from-artifact smoke test (LM-001). Run by hand; not
# registered in CI.
#
# Packs this repository with `npm pack`, installs the tarball into a throwaway prefix, and
# runs, with a throwaway HOME:
#   loki --version
#   loki doctor --json
#   loki route "add a health endpoint" --json
# Case 1 is a normal install. Case 2 repeats with the optional dependencies omitted
# (--omit=optional: no bundled Bun, no Claude Agent SDK) and Bun hidden from PATH.
# Everything is written to a reproducible log (tool versions, commit, tarball sha256, every
# command with its exit code and output). Exit 1 if any assertion fails.
#
# usage: scripts/smoke-install.sh [--log FILE]       (default log: ./smoke-install.log)
# A pass proves only this machine and OS; it is not an OS or runtime matrix.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOG="$PWD/smoke-install.log"
while [ $# -gt 0 ]; do
    case "$1" in
        --log) LOG="${2:-}"; [ -n "$LOG" ] || { echo "--log needs a file" >&2; exit 2; }; shift ;;
        *) echo "usage: $0 [--log FILE]" >&2; exit 2 ;;
    esac
    shift
done

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"

: >"$LOG" || { echo "cannot write log: $LOG" >&2; exit 2; }
FAILS=0
log() { printf '%s\n' "$*" >>"$LOG"; }
say() { printf '%s\n' "$*"; log "$*"; }
pass() { say "PASS  $*"; }
fail() { say "FAIL  $*"; FAILS=$((FAILS + 1)); }

log "smoke-install log"
log "commit: $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
log "version: $(cat "$REPO_ROOT/VERSION" 2>/dev/null || echo unknown)"
log "host: $(uname -srm)"
log "node: $(node --version 2>&1)"
log "npm: $(npm --version 2>&1)"
log "bun on host PATH: $(command -v bun || echo none)"
log ""

# 1. pack
mkdir -p "$T/pack" "$T/home1" "$T/home2" "$T/empty-nm"
if ! (cd "$REPO_ROOT" && npm pack --pack-destination "$T/pack" --silent >"$T/pack.out" 2>"$T/pack.err"); then
    log "$(cat "$T/pack.err")"
    fail "npm pack"
    exit 1
fi
TARBALL="$T/pack/$(tail -n 1 "$T/pack.out")"
[ -f "$TARBALL" ] || { fail "npm pack produced no tarball"; exit 1; }
log "tarball: $(basename "$TARBALL") sha256 $(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
pass "npm pack"

# Run one command against an installed prefix. run_case <label> <prefix> <home> <path> <args...>
# Output goes to $T/<label>.out; the log gets a head of it. Returns the command's exit code.
run_case() {
    local label="$1" prefix="$2" home="$3" path="$4"
    shift 4
    log ""
    log "--- $label: loki $*"
    (
        cd "$home" || exit 99
        env -i HOME="$home" PATH="$path" TERM=dumb NO_COLOR=1 LOKI_NO_BROWSER=1 CI=1 \
            LOKI_SDK_NODE_MODULES="${SMOKE_SDK_NM:-}" \
            "$prefix/bin/loki" "$@"
    ) >"$T/$label.out" 2>"$T/$label.err"
    local rc=$?
    log "exit code: $rc"
    log "stdout (first 60 lines):"
    head -n 60 "$T/$label.out" >>"$LOG"
    if [ -s "$T/$label.err" ]; then
        log "stderr (first 20 lines):"
        head -n 20 "$T/$label.err" >>"$LOG"
    fi
    return "$rc"
}

json_ok() { jq -e . "$1" >/dev/null 2>&1; }

exercise() {
    local name="$1" prefix="$2" home="$3" path="$4" want_version
    want_version="$(tr -d '[:space:]' <"$REPO_ROOT/VERSION")"

    run_case "$name-version" "$prefix" "$home" "$path" --version
    local rc=$?
    if [ "$rc" = 0 ] && grep -q "$want_version" "$T/$name-version.out"; then pass "$name: loki --version reports $want_version"
    else fail "$name: loki --version (exit $rc, expected $want_version)"; fi

    run_case "$name-doctor" "$prefix" "$home" "$path" doctor --json
    rc=$?
    # doctor exits 1 on a host with no provider CLI; what is asserted is a valid report.
    if json_ok "$T/$name-doctor.out" && jq -e '.requirements.paths | length > 0' "$T/$name-doctor.out" >/dev/null 2>&1; then
        pass "$name: loki doctor --json emits requirements by path (exit $rc, first_task_ready=$(jq -r '.requirements.first_task_ready' "$T/$name-doctor.out"))"
        log "requirements summary:"
        jq -r '.requirements.paths[] | "  \(.id): ready=\(.ready)"' "$T/$name-doctor.out" >>"$LOG"
    else fail "$name: loki doctor --json (exit $rc, no valid requirements report)"; fi

    run_case "$name-route" "$prefix" "$home" "$path" route "add a health endpoint" --json
    rc=$?
    if [ "$rc" = 0 ] && json_ok "$T/$name-route.out"; then pass "$name: loki route --json"
    else fail "$name: loki route --json (exit $rc)"; fi
}

BASE_PATH="$PATH"

# 2. case 1: normal install
say "case 1: normal install"
P1="$T/prefix1"
if npm install -g --prefix "$P1" --no-audit --no-fund "$TARBALL" >"$T/install1.out" 2>&1; then
    log "$(tail -n 5 "$T/install1.out")"
    pass "case 1: npm install -g from tarball"
    unset SMOKE_SDK_NM
    exercise case1 "$P1" "$T/home1" "$P1/bin:$BASE_PATH"
else
    log "$(tail -n 30 "$T/install1.out")"
    fail "case 1: npm install -g from tarball"
fi

# 3. case 2: optional dependencies absent (no bundled Bun, no Agent SDK), Bun not on PATH
say "case 2: --omit=optional, Bun and the Agent SDK absent"
P2="$T/prefix2"
SHIM="$T/shim"
mkdir -p "$SHIM"
for c in node npm python3 jq git curl bash sh env; do
    src="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$src" ] && ln -sf "$src" "$SHIM/$c"
done
PATH2="$P2/bin:$SHIM:/usr/bin:/bin"
if PATH="$PATH2" command -v bun >/dev/null 2>&1; then
    log "bun is still reachable on the restricted PATH: $(PATH="$PATH2" command -v bun)"
    fail "case 2: could not hide Bun from PATH"
elif npm install -g --prefix "$P2" --omit=optional --no-audit --no-fund "$TARBALL" >"$T/install2.out" 2>&1; then
    log "$(tail -n 5 "$T/install2.out")"
    pass "case 2: npm install -g --omit=optional from tarball"
    # npm does not always honor --omit=optional for a global tarball install (observed:
    # npm 11.17.0 still installed @oven/bun-* and the Agent SDK). Remove them so the case
    # models a machine where the optional dependencies are absent, and log what happened.
    NM2="$P2/lib/node_modules/loki-mode/node_modules"
    for d in "$NM2"/@oven "$NM2"/@anthropic-ai/claude-agent-sdk "$NM2"/@anthropic-ai/claude-agent-sdk-*; do
        if [ -e "$d" ]; then
            log "NOTE: --omit=optional left $d installed; removing it for this case"
            rm -rf -- "$d"
        fi
    done
    SMOKE_SDK_NM="$T/empty-nm"
    export SMOKE_SDK_NM
    exercise case2 "$P2" "$T/home2" "$PATH2"
    if jq -e '[.requirements.paths[] | select(.id == "api-key-sdk")][0].ready == false' "$T/case2-doctor.out" >/dev/null 2>&1; then
        pass "case 2: doctor reports the api-key-sdk path not ready"
    else fail "case 2: doctor did not report api-key-sdk not ready"; fi
else
    log "$(tail -n 30 "$T/install2.out")"
    fail "case 2: npm install -g --omit=optional from tarball"
fi

log ""
log "failures: $FAILS"
if [ "$FAILS" -gt 0 ]; then
    echo "smoke-install: $FAILS failure(s); log: $LOG"
    exit 1
fi
echo "smoke-install: all checks passed on this machine only; log: $LOG"
