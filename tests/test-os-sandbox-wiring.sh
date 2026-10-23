#!/usr/bin/env bash
# #334 AC6: the run.sh provider launch is wrapped by autonomy/lib/os_sandbox.py.
# Sources the real _loki_os_confine_init out of run.sh, then proves (1) the
# provider launch sites carry the prefix, (2) on macOS and Linux the prefix refuses a
# symlink read out of the workspace, (3) LOKI_OS_SANDBOX=off leaves the argv bare.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${LOKI_WIRING_RUN_SH:-$ROOT/autonomy/run.sh}"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# 1. every provider launch site carries the prefix (claude twice, argv providers once)
PFX='_LOKI_CONFINE_PREFIX\[@\]+"${_LOKI_CONFINE_PREFIX\[@\]}"}'
n_claude="$(grep -c "${PFX} claude " "$RUN_SH")"
n_argv="$(grep -c "${PFX} \"\${_LOKI_INVOKE_ARGV\[@\]}\"" "$RUN_SH")"
n_init="$(grep -c '^ *_loki_os_confine_init$' "$RUN_SH")"
[ "$n_claude" = "2" ] && ok "claude launch forms wrapped ($n_claude)" || bad "claude launch forms wrapped: $n_claude, want 2"
[ "$n_argv" = "1" ] && ok "argv-provider launch wrapped" || bad "argv-provider launch wrapped: $n_argv, want 1"
[ "$n_init" = "2" ] && ok "confinement initialised before both launch paths" || bad "init calls: $n_init, want 2"
n_guard="$(grep -c '^ *_loki_git_pointer_guard ||' "$RUN_SH")"
[ "$n_guard" = "2" ] && ok "git pointer guard runs after both confined provider returns" || bad "guard call sites: $n_guard, want 2"

# 2. the real function, sourced
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.wiring.XXXXXX")"
# The temp roots are readable by design, so the symlink target lives under $HOME.
OUTD="$(mktemp -d "${HOME}/.loki-wiring-out.XXXXXX")"
trap 'python3 -c "import shutil,sys; [shutil.rmtree(p, ignore_errors=True) for p in sys.argv[1:]]" "$TMPD" "$OUTD"' EXIT
WS="$TMPD/ws"; mkdir -p "$WS/.loki"
echo outside > "$OUTD/outside.txt"
ln -s "$OUTD/outside.txt" "$WS/link.txt"
log_error() { echo "ERR $*" >&2; }; log_info() { :; }; log_warn() { :; }
eval "$(awk '/^_LOKI_CONFINE_READY=/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH")"
eval "$(awk '/^_loki_git_pointer_guard\(\)/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH")"
export TARGET_DIR="$WS" SCRIPT_DIR="$ROOT/autonomy" PROVIDER_NAME=claude

_LOKI_CONFINE_READY=""; unset LOKI_OS_SANDBOX
_loki_os_confine_init
if [ "${#_LOKI_CONFINE_PREFIX[@]}" = "0" ]; then ok "default (unset) leaves the argv bare"; else bad "default produced a prefix"; fi
_LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=off _loki_os_confine_init
if [ "${#_LOKI_CONFINE_PREFIX[@]}" = "0" ]; then ok "off leaves the argv bare"; else bad "off produced a prefix"; fi
if grep -q 'none' "$WS/.loki/state/os-sandbox.json" 2>/dev/null; then ok "off recorded in the status file"; else bad "status file missing for off"; fi

# off must not spawn python3 at all (status file still written)
PYLOG="$TMPD/py-calls"; : >"$PYLOG"
python3() { echo called >>"$PYLOG"; command python3 "$@"; }
rm -f "$WS/.loki/state/os-sandbox.json"
_LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=off _loki_os_confine_init
if [ ! -s "$PYLOG" ]; then ok "off does not spawn python3"; else bad "off spawned python3"; fi
if grep -q '"kind": "none"' "$WS/.loki/state/os-sandbox.json" 2>/dev/null; then ok "off short-circuit still writes kind none"; else bad "off short-circuit lost the status file"; fi

# on + codex fails closed: init exits 2 (run in a subshell, init calls exit)
rc=0; ( PROVIDER_NAME=codex; _LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=on _loki_os_confine_init ) >/dev/null 2>&1 || rc=$?
[ "$rc" = "2" ] && ok "on + codex exits 2 through _loki_os_confine_init" || bad "on + codex rc=$rc, want 2"
rc=0; ( PROVIDER_NAME=codex; _LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=auto _loki_os_confine_init ) >/dev/null 2>&1 || rc=$?
[ "$rc" = "0" ] && ok "auto + codex stays unconfined (rc 0)" || bad "auto + codex rc=$rc, want 0"
unset -f python3

# with confinement active, git on the agent tree ignores a planted fsmonitor and a repointed
# .git/commondir that carries a clean filter (rev-c repro on 8f8a5b51f). The plant is written
# directly here, as a Linux bwrap run could, so this proves the GIT_DIR/GIT_COMMON_DIR pin
# independently of the kernel deny.
git_escape_check() {
    local repo="$TMPD/gitws" marker="$TMPD/fsmonitor-fired" fmark="$TMPD/filter-fired"
    python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$repo"
    rm -f "$marker" "$fmark"; mkdir -p "$repo"
    command git -C "$repo" init -q . 2>/dev/null
    printf 'x\n' > "$repo/g.txt"; printf '* filter=pwn\n' > "$repo/.gitattributes"
    command git -C "$repo" config core.fsmonitor "touch '$marker'; true"
    ( cd "$repo" && command git status >/dev/null 2>&1 )
    if [ -e "$marker" ]; then ok "positive control: a planted fsmonitor fires under plain git"; else bad "positive control did not fire (probe is blind)"; return; fi
    rm -f "$marker"
    # re-initialise confinement on this repo so the pin records its real git dir
    TARGET_DIR="$repo" _LOKI_CONFINE_READY="" LOKI_OS_SANDBOX=auto _loki_os_confine_init
    ( cd "$repo" && git status >/dev/null 2>&1 )
    if [ -e "$marker" ]; then bad "planted fsmonitor fired through the hardened git"; else ok "hardened git ignores a planted fsmonitor"; fi
    # repoint commondir at a copy whose config defines a clean filter
    cp -R "$repo/.git" "$repo/.evil"
    command git config --file "$repo/.evil/config" filter.pwn.clean "touch '$fmark'; cat"
    command git config --file "$repo/.evil/config" --unset core.fsmonitor
    printf '../.evil\n' > "$repo/.git/commondir"
    ( cd "$repo" && command git -c core.fsmonitor= -c core.hooksPath=/dev/null add g.txt >/dev/null 2>&1 )
    if [ -e "$fmark" ]; then ok "positive control: a repointed commondir runs its clean filter under unpinned git"; else bad "commondir positive control did not fire (probe is blind)"; return; fi
    rm -f "$fmark"; command git -C "$repo" reset -q 2>/dev/null
    ( cd "$repo" && git add g.txt >/dev/null 2>&1 )
    ( cd "$repo" && git -C "$repo" add g.txt >/dev/null 2>&1 )
    if [ -e "$fmark" ]; then bad "repointed commondir filter fired through the pinned git"; else ok "pinned git ignores a repointed .git/commondir and its clean filter"; fi
    # Linux gap: bwrap cannot deny CREATING a missing .git/commondir, and unpinned callers
    # (preedit_snapshot.py runs right after the provider) would follow it. The guard removes
    # the pointer and fails closed before any of them run.
    python3 -c "import os,sys; os.path.exists(sys.argv[1]) and os.remove(sys.argv[1])" "$repo/.git/commondir"
    rm -f "$fmark"
    ( cd "$repo" && command git add -A >/dev/null 2>&1; command git -c user.name=t -c user.email=t@t commit -q -m init >/dev/null 2>&1 )
    printf 'y\n' > "$repo/g.txt"
    # the evil common dir must hold the committed objects for diff HEAD to resolve through it
    python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$repo/.evil"
    cp -R "$repo/.git" "$repo/.evil"
    command git config --file "$repo/.evil/config" filter.pwn.clean "touch '$fmark'; cat"
    command git config --file "$repo/.evil/config" --unset core.fsmonitor
    printf '../.evil\n' > "$repo/.git/commondir"
    PYTHONPATH="$ROOT" python3 -c "import sys; from autonomy.lib.preedit_snapshot import _git; _git(['diff','HEAD','--'], sys.argv[1])" "$repo" >/dev/null 2>&1
    if [ -e "$fmark" ]; then ok "positive control: preedit_snapshot._git fires the filter through a planted commondir"; else bad "preedit positive control did not fire (probe is blind)"; return; fi
    rm -f "$fmark"; printf 'z\n' > "$repo/g.txt"
    grc=0; _loki_git_pointer_guard 2>/dev/null || grc=$?
    if [ "$grc" = "1" ] && [ ! -e "$repo/.git/commondir" ]; then ok "guard removes a commondir created during the run and fails closed"; else bad "guard rc=$grc, commondir present=$([ -e "$repo/.git/commondir" ] && echo yes || echo no)"; fi
    PYTHONPATH="$ROOT" python3 -c "import sys; from autonomy.lib.preedit_snapshot import _git; _git(['diff','HEAD','--'], sys.argv[1])" "$repo" >/dev/null 2>&1
    if [ -e "$fmark" ]; then bad "filter fired through preedit_snapshot after the guard"; else ok "no filter fires through preedit_snapshot after the guard"; fi
    grc=0; _loki_git_pointer_guard 2>/dev/null || grc=$?
    [ "$grc" = "0" ] && ok "guard is quiet on a clean .git" || bad "guard rc=$grc on a clean .git"
    export TARGET_DIR="$WS"
}

if [ "$(uname)" = "Darwin" ] && [ -x /usr/bin/sandbox-exec ]; then
    _LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=auto _loki_os_confine_init
    if [ "${_LOKI_CONFINE_PREFIX[0]:-}" = "/usr/bin/sandbox-exec" ]; then ok "launch prefix is sandbox-exec"; else bad "prefix[0]=${_LOKI_CONFINE_PREFIX[0]:-none}"; fi
    if "${_LOKI_CONFINE_PREFIX[@]}" /bin/cat "$WS/link.txt" >/dev/null 2>&1; then bad "symlink read out of the workspace succeeded"; else ok "symlink read out of the workspace refused"; fi
    if "${_LOKI_CONFINE_PREFIX[@]}" /bin/sh -c "echo hi > '$WS/inside.txt'" 2>/dev/null; then ok "workspace write allowed"; else bad "workspace write refused"; fi
    if grep -q 'seatbelt' "$WS/.loki/state/os-sandbox.json"; then ok "status file records seatbelt"; else bad "status file lacks seatbelt"; fi
    git_escape_check
elif [ "$(uname)" = "Linux" ] && command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / true >/dev/null 2>&1; then
    _LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=auto _loki_os_confine_init
    case "${_LOKI_CONFINE_PREFIX[0]:-}" in */bwrap) ok "launch prefix is bwrap" ;; *) bad "prefix[0]=${_LOKI_CONFINE_PREFIX[0]:-none}" ;; esac
    if "${_LOKI_CONFINE_PREFIX[@]}" /bin/cat "$WS/link.txt" >/dev/null 2>&1; then bad "symlink read out of the workspace succeeded"; else ok "symlink read out of the workspace refused"; fi
    if "${_LOKI_CONFINE_PREFIX[@]}" /bin/sh -c "echo hi > '$WS/inside.txt'" 2>/dev/null; then ok "workspace write allowed"; else bad "workspace write refused"; fi
    if grep -q 'bwrap' "$WS/.loki/state/os-sandbox.json"; then ok "status file records bwrap"; else bad "status file lacks bwrap"; fi
    git_escape_check
else
    echo "SKIP: kernel probes need macOS sandbox-exec or Linux bwrap"
fi
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = "0" ]
