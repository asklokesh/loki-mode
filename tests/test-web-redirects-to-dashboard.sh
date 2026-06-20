#!/usr/bin/env bash
# F55 regression: `loki web` (the command a user intuitively types) used to
# launch the DEPRECATED Purple Lab, whose '/' redirects to '/lab/' and whose
# port serves none of the real dashboard APIs (/api/status, /trust, etc. all
# 404). A real user landed on the wrong, broken-looking surface.
#
# Fix: the START path now launches the real dashboard (cmd_dashboard_start)
# instead of Purple Lab (cmd_web_start). 'loki web stop|status|logs' still
# operate on Purple Lab so anyone who started one the old way is not stranded.
#
# This suite asserts:
#   T1 static  : the START dispatch (default + unknown-args-as-start) routes to
#                the redirect helper, the helper calls cmd_dashboard_start, and
#                it does NOT call cmd_web_start. stop/status still hit Purple Lab.
#   T2 behavior: `loki web --port abc` is rejected by the DASHBOARD port
#                validator ("Invalid port" / "Port must be a number."), not the
#                Purple Lab validator ("Port must be a number, got"). The error
#                string is a server-free discriminator for which start function
#                ran. No server is started.
#   T3 behavior: `loki web --no-open` (used in CI) is accepted, not rejected as
#                an unknown option (the flag is filtered before delegating).
#   T4 behavior: machine-output (`--json`) suppresses the human redirect line.
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
LOKI="$REPO_ROOT/autonomy/loki"

# --- T1 static checks on the dispatch + redirect helper ---------------------
# Isolate cmd_web() so a match elsewhere cannot satisfy the assertion.
WEB_BODY=$(awk '/^cmd_web\(\)/{f=1} f{print} f&&/^}/{exit}' "$LOKI")
REDIR_BODY=$(awk '/^cmd_web_redirect_to_dashboard\(\)/{f=1} f{print} f&&/^}/{exit}' "$LOKI")

if [ -z "$WEB_BODY" ]; then
    bad "could not isolate cmd_web() body"
else
    ok "isolated cmd_web() body"
fi
if [ -z "$REDIR_BODY" ]; then
    bad "could not isolate cmd_web_redirect_to_dashboard() body"
else
    ok "isolated cmd_web_redirect_to_dashboard() body"
fi

# Strip comments so explanatory text naming old patterns does not trip checks.
WEB_CODE=$(echo "$WEB_BODY" | grep -v '^[[:space:]]*#')
REDIR_CODE=$(echo "$REDIR_BODY" | grep -v '^[[:space:]]*#')

# The START path must NOT call cmd_web_start (that is Purple Lab) anymore.
if echo "$WEB_CODE" | grep -q 'cmd_web_start'; then
    bad "cmd_web() still routes start to cmd_web_start (Purple Lab) -- F55 regression"
else
    ok "cmd_web() no longer routes start to cmd_web_start (Purple Lab)"
fi

# The START path must route to the redirect helper.
if echo "$WEB_CODE" | grep -q 'cmd_web_redirect_to_dashboard'; then
    ok "cmd_web() routes start to the dashboard redirect helper"
else
    bad "cmd_web() does not route start to the dashboard redirect helper"
fi

# The redirect helper must launch the real dashboard.
if echo "$REDIR_CODE" | grep -q 'cmd_dashboard_start'; then
    ok "redirect helper launches cmd_dashboard_start (the real dashboard)"
else
    bad "redirect helper does not launch cmd_dashboard_start"
fi

# stop/status must STILL operate on Purple Lab so old-way users are not stranded.
if echo "$WEB_CODE" | grep -q 'cmd_web_stop' && echo "$WEB_CODE" | grep -q 'cmd_web_status'; then
    ok "cmd_web() still routes stop/status to Purple Lab (cmd_web_stop/status)"
else
    bad "cmd_web() lost the Purple Lab stop/status routes"
fi

# --- T2 behavioral: invalid port hits the DASHBOARD validator ---------------
# Distinguishing error strings:
#   dashboard validator  -> "Invalid port:" and "Port must be a number."
#   Purple Lab validator -> "Port must be a number, got '...'"
SBX_HOME=$(mktemp -d "${TMPDIR:-/tmp}/loki-webredir-home-XXXXXX")
T2_OUT=$(HOME="$SBX_HOME" "$LOKI" web --port abc 2>&1 || true)
if echo "$T2_OUT" | grep -q "Port must be a number, got"; then
    bad "loki web --port abc hit the Purple Lab port validator (still launching Purple Lab)"
elif echo "$T2_OUT" | grep -q "Invalid port:"; then
    ok "loki web --port abc hit the dashboard port validator (start -> dashboard)"
else
    bad "loki web --port abc produced neither validator message: $T2_OUT"
fi

# It must also announce the dashboard handoff (human-readable path).
if echo "$T2_OUT" | grep -qi "Launching the dashboard"; then
    ok "loki web prints the dashboard-handoff notice"
else
    bad "loki web did not print the dashboard-handoff notice"
fi

# --- T3 behavioral: --no-open is filtered, not rejected ----------------------
# Pair it with an invalid port so the run still fails fast (no server starts),
# but the failure must be the port validator, NOT "Unknown option: --no-open".
T3_OUT=$(HOME="$SBX_HOME" "$LOKI" web --no-open --port abc 2>&1 || true)
if echo "$T3_OUT" | grep -qi "Unknown option"; then
    bad "loki web --no-open rejected as unknown option (CI invocation broken)"
else
    ok "loki web --no-open accepted (filtered before delegating to dashboard)"
fi

# --- T4 behavioral: machine-output suppresses the human redirect line -------
T4_OUT=$(HOME="$SBX_HOME" "$LOKI" web --json --port abc 2>&1 || true)
if echo "$T4_OUT" | grep -qi "Launching the dashboard"; then
    bad "loki web --json still printed the human redirect line (machine-output not suppressed)"
else
    ok "loki web --json suppresses the human redirect line"
fi

rm -rf "$SBX_HOME" 2>/dev/null || true

# --- Summary ----------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
