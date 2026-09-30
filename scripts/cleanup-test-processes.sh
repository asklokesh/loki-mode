#!/usr/bin/env bash
# Kill test/build leftovers and report honestly what was found.
#
# WHY THIS EXISTS. On 2026-08-01 the founder sent an Activity Monitor screenshot:
# ~18 visible `bash` processes at 31-44% CPU each, 0.00% idle, User 97.3%. The
# real count was **44 copies of `loadgen.sh 40`**, orphaned to PPID 1, each with
# 310 MINUTES of CPU time over 16.5 hours. They survived every prior cleanup
# because those cleanups only ever matched `loki-*` and `mutation-probe`.
#
# The lesson is the pattern, not the script name: a cleanup that greps for the
# names you REMEMBER spawning cannot catch what you did not remember. This adds
# a second, name-independent sweep -- any long-lived, high-CPU, orphaned shell
# started under this workspace is reported whether or not we recognise it.
#
# FAIL-SAFE DIRECTION. Killing the wrong process is worse than leaving one
# behind, so every sweep below REPORTS by default and only kills with
# --aggressive (D14/D15/D16: even a name that is "ours by construction" can
# coincidentally match another user's process on a shared machine, or an
# operator's own live dashboard on the shared port, so nothing here kills
# unconditionally any more; every pgrep/pkill is also scoped to this user's
# own uid).
#
# Usage:
#   scripts/cleanup-test-processes.sh              # report everything found
#   scripts/cleanup-test-processes.sh --aggressive # kill everything found (this user's own processes only)
#   scripts/cleanup-test-processes.sh --dry-run    # same as default: report only, kill nothing

set -uo pipefail

MODE="normal"
case "${1:-}" in
    --aggressive) MODE="aggressive" ;;
    --dry-run)    MODE="dry" ;;
    "")           ;;
    *) echo "usage: $0 [--aggressive|--dry-run]" >&2; exit 64 ;;
esac

killed=0
found_unknown=0

# ponytail: -u "$(id -u)" on every pgrep/pkill below scopes matching to THIS
# user's own processes. "mutation-probe"/"loki-run-"/"loadgen" are ours by
# construction, but on a shared machine another user could coincidentally run
# something matching the same substring; -u makes that impossible to hit
# (D14/D15/D16 class). This is a manual, explicitly-invoked dev tool (lower
# risk than something firing automatically on session end), but the known-name
# kills and the port-57374 sweep are moved behind --aggressive anyway: this
# script's own design already treats "report by default, kill only with
# --aggressive" as the safe default for anything not 100% certain to be ours,
# and a live port-57374 holder could be the operator's own real dashboard.
MY_UID="$(id -u)"

_kill() {
    local pat="$1" label="$2" n
    n="$(pgrep -u "$MY_UID" -f "$pat" 2>/dev/null | wc -l | tr -d ' ')"
    [ "${n:-0}" -eq 0 ] && return 0
    if [ "$MODE" != "aggressive" ]; then
        echo "  FOUND (not killed): $n x $label -- re-run with --aggressive to kill"
    else
        pkill -9 -u "$MY_UID" -f "$pat" 2>/dev/null || true
        echo "  killed: $n x $label"
        killed=$((killed + n))
    fi
}

echo "== known test/build leftovers (report by default; --aggressive to kill) =="
_kill "mutation-probe"  "mutation-probe"
_kill "loki-run-"       "loki-run-*"
_kill "loadgen"         "loadgen (the 2026-08-01 runaway)"

# Ports this project binds. Scoped to PIDs owned by this user before any kill
# decision, and gated behind --aggressive: an unscoped `lsof -ti:PORT | xargs
# kill` would kill whoever else holds the port, including the operator's own
# live dashboard.
# SC2043: the list is deliberately one element today. Kept as a loop because
# the body is port-generic and a second port is added by extending this list,
# not by restructuring the block. Silencing rather than rewriting keeps the
# extension point obvious.
# shellcheck disable=SC2043
for port in 57374; do
    pids="$(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        if [ "$MODE" != "aggressive" ]; then
            echo "  FOUND (not freed): port $port -- re-run with --aggressive to free"
        else
            for p in $pids; do
                [ "$(ps -o uid= -p "$p" 2>/dev/null | tr -d ' ')" = "$MY_UID" ] && kill -9 "$p" 2>/dev/null || true
            done
            echo "  freed: port $port"
        fi
    fi
done

echo ""
echo "== unrecognised CPU hogs (name-independent) =="
# The sweep that would have caught loadgen.sh. Criteria, all three required:
#   - owned by this user
#   - a shell or interpreter (not a GUI app or system daemon)
#   - >5 minutes of accumulated CPU TIME
# CPU TIME, not %CPU: a process can idle at 0% right now and still have burned
# hours. That distinction is why the screenshot's 310-minute processes matter.
while read -r pid cputime cmd; do
    [ -z "${pid:-}" ] && continue
    # cputime is [dd-]hh:mm.ss or mm:ss.ss -- convert the leading fields.
    mins="$(printf '%s' "$cputime" | awk -F: '
        { if (NF==3) print $1*60 + $2; else if (NF==2) print $1; else print 0 }')"
    [ "${mins:-0}" -lt 5 ] && continue
    found_unknown=$((found_unknown + 1))
    echo "  pid=$pid cpu_time=$cputime cmd=$(printf '%s' "$cmd" | cut -c1-60)"
    if [ "$MODE" = "aggressive" ]; then
        kill -9 "$pid" 2>/dev/null && { echo "    killed"; killed=$((killed + 1)); }
    fi
done < <(ps -eo pid,time,command -u "$(id -u)" 2>/dev/null \
         | awk 'NR>1 && ($3 ~ /\/(ba)?sh$/ || $3 ~ /\/(ba)?sh /) {print $1, $2, substr($0, index($0,$3))}')

if [ "$found_unknown" -eq 0 ]; then
    echo "  none"
elif [ "$MODE" != "aggressive" ]; then
    echo ""
    echo "  ^ reported, NOT killed. Re-run with --aggressive to kill these."
    echo "    (killing the wrong process is worse than leaving one behind)"
fi

echo ""
echo "== temp files =="
# E-140: never remove temp entries by glob. A pattern sweep of loki-* under TMPDIR
# deleted another agent's live run-owned loki-run.* dir (2026-09-30). Foreign
# entries are only reported; the sole removal is this session's own validated
# LOKI_RUN_TMP, and only with --aggressive.
for d in /tmp "${TMPDIR:-/tmp}"; do
    for pat in "$d"/loki-* "$d"/mutprobe-* "$d"/test-* "$d"/package "$d"/*.tgz; do
        [ -e "$pat" ] || continue
        echo "  found (not removed, may belong to another run): $pat"
    done
done
if [ -n "${LOKI_RUN_TMP:-}" ]; then
    if [ "$MODE" = "aggressive" ]; then
        # shellcheck disable=SC1091
        . "$(dirname "$0")/../eval/loki10/lib-tmp.sh"
        loki_run_tmp_cleanup && echo "  removed own run tmp" || echo "  own run tmp cleanup refused"
    else
        echo "  own run tmp: $LOKI_RUN_TMP (removed only with --aggressive)"
    fi
fi

echo ""
echo "== verify =="
for pat in mutation-probe loki-run- loadgen; do
    n="$(pgrep -u "$MY_UID" -f "$pat" 2>/dev/null | wc -l | tr -d ' ')"
    printf '  %-16s %s\n' "$pat" "$([ "${n:-0}" -eq 0 ] && echo clean || echo "STILL RUNNING: $n")"
done
echo ""
echo "  processes killed: $killed"
