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
# behind, so the name-independent sweep REPORTS by default and only kills with
# --aggressive. The known-name sweep kills outright, because those names are
# ours by construction.
#
# Usage:
#   scripts/cleanup-test-processes.sh              # kill known, report unknown
#   scripts/cleanup-test-processes.sh --aggressive # also kill orphaned CPU hogs
#   scripts/cleanup-test-processes.sh --dry-run    # report only, kill nothing

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

_kill() {
    local pat="$1" label="$2" n
    n="$(pgrep -f "$pat" 2>/dev/null | wc -l | tr -d ' ')"
    [ "${n:-0}" -eq 0 ] && return 0
    if [ "$MODE" = "dry" ]; then
        echo "  WOULD KILL: $n x $label"
    else
        pkill -9 -f "$pat" 2>/dev/null || true
        echo "  killed: $n x $label"
        killed=$((killed + n))
    fi
}

echo "== known test/build leftovers =="
# Names this project spawns by construction. Safe to kill unconditionally.
_kill "mutation-probe"  "mutation-probe"
_kill "loki-run-"       "loki-run-*"
_kill "loadgen"         "loadgen (the 2026-08-01 runaway)"

# Ports this project binds.
for port in 57374; do
    pids="$(lsof -ti:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        if [ "$MODE" = "dry" ]; then
            echo "  WOULD FREE: port $port ($(echo "$pids" | wc -l | tr -d ' ') pid(s))"
        else
            echo "$pids" | xargs kill -9 2>/dev/null || true
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
for d in /tmp "${TMPDIR:-/tmp}"; do
    for pat in "$d"/loki-* "$d"/mutprobe-* "$d"/test-* "$d"/package "$d"/*.tgz; do
        [ -e "$pat" ] || continue
        if [ "$MODE" = "dry" ]; then echo "  WOULD REMOVE: $pat"
        else rm -rf "$pat" 2>/dev/null && echo "  removed: $pat"; fi
    done
done

echo ""
echo "== verify =="
for pat in mutation-probe loki-run- loadgen; do
    n="$(pgrep -f "$pat" 2>/dev/null | wc -l | tr -d ' ')"
    printf '  %-16s %s\n' "$pat" "$([ "${n:-0}" -eq 0 ] && echo clean || echo "STILL RUNNING: $n")"
done
echo ""
echo "  processes killed: $killed"
