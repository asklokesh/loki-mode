#!/usr/bin/env bash
# Guard: a test suite must never leave a dashboard behind or touch the REAL
# ~/.loki/dashboard registry. Incident (P0-DASH-STATIC): a suite ran
# `loki dashboard start` under the real HOME; the dashboard outlived the suite
# (PYTHONPATH/LOKI_SKILL_DIR pointing at a deleted temp tree, so no frontend), the
# registry advertised it, and `loki start` reused it as "healthy".
#   1. Static: every suite that executes a dashboard server arms a trap that
#      kills it, and every suite that runs `loki dashboard start` sets HOME.
#   2. Dynamic: run the one suite that really starts dashboards, then check the
#      real registry is byte-identical and every PID it recorded is dead.
#      PIDs come from the suite's own record (LOKI_TEST_PID_LOG), never a name match.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }

# --- 1. static ---------------------------------------------------------------
# Executed-command lines only: strip comments, drop grep/echo/printf/sed prose lines.
exec_lines() { sed 's/#.*//' "$1" | grep -vE '^\s*(echo|printf|grep|sed|test_source|ok|bad)\b' || true; }
SPAWN='(-m +dashboard\.server|uvicorn +dashboard\.server|dashboard\.server:app)'
START='(bash +"?\$[A-Za-z_]+"? +dashboard +start|loki +dashboard +start$)'
n=0
for f in "$ROOT"/tests/*.sh "$ROOT"/tests/integration/*.sh "$ROOT"/scripts/run-dashboard-*.sh; do
    [ -f "$f" ] || continue
    [ "$f" = "$0" ] && continue
    body="$(exec_lines "$f")"
    if printf '%s\n' "$body" | grep -Eq "$SPAWN"; then
        n=$((n+1))
        if printf '%s\n' "$body" | grep -Eq '^\s*trap .*(kill|cleanup|_reap)' || grep -Eq '^\s*trap ' "$f"; then
            printf '%s\n' "$body" | grep -Eq '\bkill\b' \
                && ok "$(basename "$f"): spawns a dashboard server and arms a trap + kill" \
                || bad "$(basename "$f"): spawns a dashboard server, trap present but nothing kills it"
        else
            bad "$(basename "$f"): spawns a dashboard server without an EXIT trap"
        fi
    fi
    if printf '%s\n' "$body" | grep -Eq "$START"; then
        n=$((n+1))
        printf '%s\n' "$body" | grep -Eq '\bHOME=' \
            && ok "$(basename "$f"): runs 'dashboard start' under a throwaway HOME" \
            || bad "$(basename "$f"): runs 'dashboard start' against the REAL HOME registry"
    fi
done
[ "$n" -gt 0 ] && ok "static scan found $n dashboard-spawning suite checks (not vacuous)" || bad "static scan matched nothing (vacuous)"

# --- 2. dynamic --------------------------------------------------------------
REG="$HOME/.loki/dashboard"
snap() { for x in port host scheme dashboard.pid; do
             if [ -f "$REG/$x" ]; then printf '%s=%s\n' "$x" "$(cat "$REG/$x")"; else printf '%s=ABSENT\n' "$x"; fi
         done; }
BEFORE="$(snap)"
# Ports are machine-global (P0-DASH-LEAK2): record who LISTENs on the real default
# range 57374-57399 so only a listener this suite ADDED fails the check.
listeners() { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:57374-57399 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2":"$9}' | sort -u; }
LBEFORE="$(listeners)"
LOKI_TEST_PID_LOG="$WORK/pids" timeout -k 5 280 bash "$ROOT/tests/test-dashboard-bind-auth-guard.sh" >"$WORK/suite.log" 2>&1
SRC=$?
[ "$SRC" -eq 0 ] && ok "dashboard-starting suite passed (rc 0)" || bad "dashboard-starting suite rc=$SRC: $(tail -3 "$WORK/suite.log" | tr '\n' ' ')"
[ "$(snap)" = "$BEFORE" ] && ok "real ~/.loki/dashboard registry unchanged by the suite" || bad "suite modified the REAL ~/.loki/dashboard registry"
sleep 2
LNEW="$(comm -13 <(printf '%s\n' "$LBEFORE") <(listeners))"
[ -z "$LNEW" ] && ok "suite bound nothing in the real default range 57374-57399" \
    || bad "suite left a listener on the real default port range: $(printf '%s' "$LNEW" | tr '\n' ' ')"
LEAK=""
if [ -s "$WORK/pids" ]; then
    while read -r p; do
        case "$p" in ''|*[!0-9]*) continue ;; esac
        kill -0 "$p" 2>/dev/null && LEAK="$LEAK $p"
    done <"$WORK/pids"
    [ -z "$LEAK" ] && ok "every dashboard PID the suite recorded is dead ($(wc -l <"$WORK/pids" | tr -d ' ') recorded)" \
        || { bad "dashboard PID(s) outlived the suite:$LEAK"; for p in $LEAK; do kill "$p" 2>/dev/null; done; }
else
    ok "suite recorded no dashboard PIDs (nothing started, nothing to leak)"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
