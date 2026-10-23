#!/usr/bin/env bash
# #334 AC6: the run.sh provider launch is wrapped by autonomy/lib/os_sandbox.py.
# Sources the real _loki_os_confine_init out of run.sh, then proves (1) the
# provider launch sites carry the prefix, (2) on macOS the prefix refuses a
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
export TARGET_DIR="$WS" SCRIPT_DIR="$ROOT/autonomy" PROVIDER_NAME=claude

_LOKI_CONFINE_READY=""; unset LOKI_OS_SANDBOX
_loki_os_confine_init
if [ "${#_LOKI_CONFINE_PREFIX[@]}" = "0" ]; then ok "default (unset) leaves the argv bare"; else bad "default produced a prefix"; fi
_LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=off _loki_os_confine_init
if [ "${#_LOKI_CONFINE_PREFIX[@]}" = "0" ]; then ok "off leaves the argv bare"; else bad "off produced a prefix"; fi
if grep -q 'none' "$WS/.loki/state/os-sandbox.json" 2>/dev/null; then ok "off recorded in the status file"; else bad "status file missing for off"; fi

if [ "$(uname)" = "Darwin" ] && [ -x /usr/bin/sandbox-exec ]; then
    _LOKI_CONFINE_READY=""; LOKI_OS_SANDBOX=auto _loki_os_confine_init
    if [ "${_LOKI_CONFINE_PREFIX[0]:-}" = "/usr/bin/sandbox-exec" ]; then ok "launch prefix is sandbox-exec"; else bad "prefix[0]=${_LOKI_CONFINE_PREFIX[0]:-none}"; fi
    if "${_LOKI_CONFINE_PREFIX[@]}" /bin/cat "$WS/link.txt" >/dev/null 2>&1; then bad "symlink read out of the workspace succeeded"; else ok "symlink read out of the workspace refused"; fi
    if "${_LOKI_CONFINE_PREFIX[@]}" /bin/sh -c "echo hi > '$WS/inside.txt'" 2>/dev/null; then ok "workspace write allowed"; else bad "workspace write refused"; fi
    if grep -q 'seatbelt' "$WS/.loki/state/os-sandbox.json"; then ok "status file records seatbelt"; else bad "status file lacks seatbelt"; fi
else
    echo "SKIP: kernel probes need macOS sandbox-exec"
fi
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = "0" ]
