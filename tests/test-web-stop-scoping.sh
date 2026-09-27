#!/usr/bin/env bash
# v7.29.1 (FIX-563) regression: `loki web stop` (cmd_web_stop) must NOT
# blanket-kill loki-run-* orchestrators machine-wide.
#
# Background: the user-invoked `loki web stop` is documented as "Stop the
# Purple Lab server" (the web UI session it owns). A prior unscoped
#   pgrep -f "loki-run-\|status-monitor\|resource-monitor"
# in cmd_web_stop reaped EVERY orchestrator on the machine, including foreign
# `loki start` builds launched from other terminals/CWDs that the web UI never
# started. Purple Lab's own build processes are reaped authoritatively via
# child-pids.json (the only PIDs this session actually spawned); the blanket
# loki-run-* kill was pure collateral damage.
#
# This suite asserts:
#   T1 static (LOAD-BEARING regression guard, cross-platform): the unscoped
#              loki-run-* blanket pgrep+kill is GONE from cmd_web_stop, and the
#              function still reaps its own children via child-pids.json.
#              Re-adding the block fails this check on every platform.
#   T2 behavioral (smoke check, NON-discriminating on macOS): a foreign
#              loki-run-* orchestrator (imitating run.sh:180, started from an
#              unrelated CWD with no child-pids.json entry) survives a real
#              `loki web stop` against a sandboxed HOME. NOTE: the removed
#              pattern used `pgrep -f "loki-run-\|..."` where `\|` is BRE
#              alternation; BSD pgrep (macOS) treats `\|` as a literal pipe, so
#              the buggy block matched nothing and this assertion passes against
#              BOTH the bug and the fix here. It is a positive smoke check that
#              the fixed path does not kill foreign builds, NOT the regression
#              guard. T1 is the guard.
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
LOKI="$REPO_ROOT/autonomy/loki"

# --- T1 static checks on cmd_web_stop --------------------------------------
# Isolate the cmd_web_stop function body so the assertions cannot be satisfied
# by an unrelated occurrence elsewhere in autonomy/loki.
WEBSTOP_BODY=$(awk '/^cmd_web_stop\(\)/{f=1} f{print} f&&/^}/{exit}' "$LOKI")

if [ -z "$WEBSTOP_BODY" ]; then
    bad "could not isolate cmd_web_stop() body"
else
    ok "isolated cmd_web_stop() body"
fi

# The dangerous unscoped blanket kill must NOT exist in cmd_web_stop. The prior
# vector was a pgrep -f over "loki-run-" inside this function followed by kill.
# Strip comment lines first so the explanatory FIX-563 comment (which names the
# old pattern) does not trip the check; only live code counts.
WEBSTOP_CODE=$(echo "$WEBSTOP_BODY" | grep -v '^[[:space:]]*#')
if echo "$WEBSTOP_CODE" | grep -q 'pgrep -f "loki-run-'; then
    bad "cmd_web_stop still blanket-pgreps loki-run-* (FIX-563 regression)"
else
    ok "cmd_web_stop no longer blanket-pgreps loki-run-* (FIX-563 fixed)"
fi

# It must still reap ITS OWN children authoritatively via child-pids.json.
if echo "$WEBSTOP_BODY" | grep -q 'child-pids.json'; then
    ok "cmd_web_stop reaps own children via child-pids.json (scoped)"
else
    bad "cmd_web_stop lost its child-pids.json scoped reap"
fi

# --- T2 behavioral smoke: a foreign loki-run-* orchestrator survives web stop -
# A fake runner imitating /tmp/loki-run-XXXXXX (run.sh:180): it does NOT exec,
# so the script name stays in argv exactly like the real runner. It is started
# from an unrelated CWD and is NOT recorded in any Purple Lab child-pids.json,
# so a correctly-scoped `loki web stop` must leave it alive. This is a positive
# smoke check on the fixed path (see header note): on macOS it does not
# discriminate fix-vs-bug, so T1 above is the real regression guard.
T2=$(
  set -u
  # Sandboxed HOME so cmd_web_stop only ever sees empty Purple Lab/dashboard
  # state (no real PID files, no child-pids.json) and cannot touch the real
  # user's sessions. The default Purple Lab/dashboard ports are not listening
  # in this sandbox, so the lsof-by-port and curl paths are no-ops.
  SBX_HOME=$(mktemp -d "${TMPDIR:-/tmp}/loki-webstop-home-XXXXXX")
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/loki-webstop-XXXXXX")
  mkdir -p "$WORK/.loki"
  # Unique marker so cleanup can scope any survivor kill to THIS run only.
  SCOPE_MARK="WEBSTOP-$$-${RANDOM}"
  rs=$(mktemp "${TMPDIR:-/tmp}/loki-run-${SCOPE_MARK}-XXXXXX")
  # The runner cd's itself and does NOT exec, so the script name (which contains
  # "loki-run-") stays in argv exactly like the real runner -- this is the
  # process a blanket `pgrep -f loki-run-` would have matched and killed. It
  # records its OWN pid so the survival assertion checks the loki-run- process.
  cat > "$rs" <<RUNNER
#!/usr/bin/env bash
cd "$WORK" || exit 1
echo \$\$ > "$WORK/.loki/loki.pid"
sleep 30
RUNNER
  chmod +x "$rs"
  # Launch detached in its own session (setsid where available) so SIGKILL on
  # cleanup does not surface an async job-control "Killed" monitor notice. Fall
  # back to a plain background job if setsid is unavailable.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$rs" >/dev/null 2>&1 </dev/null &
  else
    "$rs" >/dev/null 2>&1 </dev/null &
  fi
  sleep 0.4
  FPID=$(cat "$WORK/.loki/loki.pid" 2>/dev/null)
  result=""
  if [ -z "$FPID" ] || ! kill -0 "$FPID" 2>/dev/null; then
    echo "RUNNER_DID_NOT_START"
  else
    # Run `loki web stop` against the sandboxed HOME from yet another CWD. Use a
    # short hard timeout as a guard; the code path is designed not to hang.
    TBIN=""
    command -v timeout >/dev/null 2>&1 && TBIN="timeout -k 10 20"
    command -v gtimeout >/dev/null 2>&1 && [ -z "$TBIN" ] && TBIN="gtimeout -k 10 20"
    # Council R2 (v7.30.0): isolate the dashboard port too. cmd_web_stop's
    # companion-dashboard kill targets LOKI_DASHBOARD_PORT (default 57374)
    # machine-wide; without this override, running the suite on a machine
    # with a live dashboard would kill it - the exact foreign-kill class
    # this test exists to prevent.
    ( cd "$SBX_HOME" && HOME="$SBX_HOME" LOKI_DIR="$SBX_HOME/.loki" \
        SKILL_DIR="$REPO_ROOT" LOKI_DASHBOARD_PORT=59991 \
        $TBIN bash "$LOKI" web stop >/dev/null 2>&1 )
    sleep 0.6
    kill -0 "$FPID" 2>/dev/null && result="FOREIGN_ALIVE" || result="FOREIGN_DEAD"
    echo "$result"
  fi
  # cleanup: kill the foreign runner we made + remove temp dirs and script.
  # Disable job-control monitor so the SIGKILL does not print a "Killed" notice.
  set +m 2>/dev/null || true
  kill -9 "$FPID" 2>/dev/null
  wait "$FPID" 2>/dev/null || true
  rm -f "$rs"
  rm -rf "$WORK" "$SBX_HOME"
)
if [ "$T2" = "FOREIGN_ALIVE" ]; then
    ok "smoke: foreign build survives 'loki web stop' on fixed code (T1 is the guard)"
else
    bad "web-stop smoke: foreign build killed by web stop [$T2] (want: FOREIGN_ALIVE)"
fi

# --- T3: static -- every remaining kill site in cmd_web_stop must verify
# candidate identity through _loki_pid_looks_like_purplelab (anchored
# interpreter + exact server_py path + uid), not a substring re-test of the
# same pattern pgrep already matched on.
#
# THE CORE DEFECT THIS REPLACES (found by a 4-reviewer council, all four
# independently): the previous "argv identity check" on the dashboard branch
# re-tested the SAME substrings ("dashboard.server"/"dashboard/server"/
# "uvicorn") that `pgrep -f "dashboard.server\|dashboard/server"` had already
# matched on -- every candidate pgrep found automatically passed that check,
# and the SIGKILL loop afterward walked the entire UNFILTERED pgrep list with
# no check at all. A decoy `python3 <foreign>/dashboard/server.py` from an
# unrelated directory was killed. The prior regression test's dashboard decoy
# only "survived" because macOS's BSD pgrep treats `\|` as a literal pipe and
# the pattern never matched anything on that platform -- a false green from a
# platform quirk, not evidence the fix worked; on Linux procps it would kill
# the decoy.
#
# Fix: the dashboard argv-sweep in cmd_web_stop was DELETED, not hardened --
# cmd_dashboard_stop (PID-file authoritative, called before cmd_web_stop by
# cmd_web()'s "stop" case) is the single source of truth for "our" dashboard,
# and no argv-derived check can ever prove more than "this is A loki
# dashboard", never "the one THIS session started". The three remaining kill
# sites (PID-file branch, port branch, web-app/server.py orphan sweep) all now
# route through the shared _loki_pid_looks_like_purplelab helper, which
# collects only a verified PID before any kill loop runs.
if echo "$WEBSTOP_CODE" | grep -qE 'pgrep -f "dashboard\.server'; then
    bad "cmd_web_stop still runs the deleted dashboard argv-sweep pgrep (the vacuous-check regression)"
else
    ok "cmd_web_stop no longer runs a dashboard argv-sweep pgrep (deleted, not hardened)"
fi
LOKI_BODY_ALL=$(cat "$LOKI")
if echo "$LOKI_BODY_ALL" | grep -q '^_loki_pid_looks_like_purplelab()'; then
    ok "autonomy/loki defines a shared _loki_pid_looks_like_purplelab identity helper"
else
    bad "autonomy/loki does not define _loki_pid_looks_like_purplelab"
fi
# Every one of the three remaining kill sites must call the shared helper --
# count occurrences inside the function body, not just check for one.
HELPER_CALLS=$(echo "$WEBSTOP_BODY" | grep -c '_loki_pid_looks_like_purplelab "')
if [ "$HELPER_CALLS" -ge 3 ]; then
    ok "cmd_web_stop calls _loki_pid_looks_like_purplelab at all 3 remaining kill sites ($HELPER_CALLS calls)"
else
    bad "cmd_web_stop calls _loki_pid_looks_like_purplelab fewer than 3 times ($HELPER_CALLS) -- a kill site is unverified"
fi
# The helper itself must anchor on argv[1] EXACTLY equal to server_py, not a
# substring -- `case "$argv1" in *server.py*)` would still be vacuous (matches
# vim/tail/grep on the same path).
HELPER_BODY=$(echo "$LOKI_BODY_ALL" | awk '/^_loki_pid_looks_like_purplelab\(\) \{/,/^\}/')
if echo "$HELPER_BODY" | grep -qE '\[ "\$argv1" = "\$_want" \]'; then
    ok "_loki_pid_looks_like_purplelab requires argv[1] EXACTLY equal to server_py (not a substring)"
else
    bad "_loki_pid_looks_like_purplelab does not require exact argv[1] equality -- still substring-vacuous"
fi
if echo "$HELPER_BODY" | grep -q '_p_uid.*=.*_my_uid'; then
    ok "_loki_pid_looks_like_purplelab requires uid match (shared SKILL_DIR install path)"
else
    bad "_loki_pid_looks_like_purplelab does not require a uid match"
fi

# --- T3 behavioral, part A: a FOREIGN web-app/server.py -- one that WOULD
# match the old pgrep -f "web-app/server.py" pattern, launched with a REAL
# python3 interpreter (so argv[0] passes the interpreter-token check too) but
# at a path under a DIFFERENT, foreign SKILL_DIR than this test's own
# REPO_ROOT -- must SURVIVE `loki web stop`. This is the exact shape the
# council reproduced killing pre-fix: a decoy that satisfies every substring
# the old code checked, differing only in the one thing identity actually
# requires (the exact server_py path). The decoy records its own PID
# immediately after backgrounding -- never derived from a pattern match
# against real process argv.
T3A=$(
  set -u
  SBX_HOME=$(mktemp -d "${TMPDIR:-/tmp}/loki-webstop3a-home-XXXXXX")
  FOREIGN_SKILL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/loki-webstop3a-foreign-XXXXXX")
  mkdir -p "$FOREIGN_SKILL_DIR/web-app"
  # A real, syntactically valid server.py at the foreign path so `python3
  # <path>` is a genuine, sustained process (matches argv[0]=python AND
  # argv[1]=<the foreign path> exactly), not a decoy that merely mentions the
  # string in a comment or argument.
  cat > "$FOREIGN_SKILL_DIR/web-app/server.py" <<'PYEOF'
import time
time.sleep(30)
PYEOF
  PY_BIN="$(command -v python3.12 || command -v python3)"
  "$PY_BIN" "$FOREIGN_SKILL_DIR/web-app/server.py" &
  FOREIGN_PID=$!
  sleep 0.4

  if [ -z "$FOREIGN_PID" ] || ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
    echo "DECOY_DID_NOT_START"
  elif ! pgrep -f "web-app/server.py" 2>/dev/null | grep -qx "$FOREIGN_PID"; then
    echo "POSITIVE_CONTROL_FAILED"
  else
    mkdir -p "$SBX_HOME/.loki/dashboard"
    sleep 60 & DASH_PLACEHOLDER_PID=$!
    echo "$DASH_PLACEHOLDER_PID" > "$SBX_HOME/.loki/dashboard/dashboard.pid"
    TBIN=""
    command -v timeout >/dev/null 2>&1 && TBIN="timeout -k 10 20"
    command -v gtimeout >/dev/null 2>&1 && [ -z "$TBIN" ] && TBIN="gtimeout -k 10 20"
    # SKILL_DIR is THIS test's own repo root, deliberately different from
    # FOREIGN_SKILL_DIR where the decoy's server.py actually lives -- proving
    # the identity check is path-exact, not "any web-app/server.py".
    ( cd "$SBX_HOME" && HOME="$SBX_HOME" LOKI_DIR="$SBX_HOME/.loki" \
        SKILL_DIR="$REPO_ROOT" LOKI_DASHBOARD_PORT=59992 \
        $TBIN bash "$LOKI" web stop >/dev/null 2>&1 )
    sleep 0.6
    if kill -0 "$FOREIGN_PID" 2>/dev/null; then
      echo "FOREIGN_ALIVE"
    else
      echo "FOREIGN_KILLED"
    fi
    kill -9 "$DASH_PLACEHOLDER_PID" 2>/dev/null || true
  fi

  kill -9 "$FOREIGN_PID" 2>/dev/null || true
  rm -rf "$SBX_HOME" "$FOREIGN_SKILL_DIR"
)
case "$T3A" in
    FOREIGN_ALIVE)
        ok "foreign web-app/server.py (matches old pattern, wrong SKILL_DIR) survives 'loki web stop'"
        ;;
    POSITIVE_CONTROL_FAILED)
        bad "positive control failed: pgrep cannot even enumerate the foreign decoy on this platform -- a FOREIGN_ALIVE result would be vacuous"
        ;;
    DECOY_DID_NOT_START)
        bad "foreign decoy did not start (test setup broken, not the function under test)"
        ;;
    *)
        bad "web-stop identity check: foreign web-app/server.py decoy killed [$T3A] (want: FOREIGN_ALIVE) -- the bug is still present"
        ;;
esac

# --- T3 behavioral, part B: cmd_web_stop must still kill ITS OWN, genuine
# Purple Lab server (proving the fix did not just delete all kill logic). A
# real python3 process is launched at THIS repo's own web-app/server.py path
# (argv[1] exactly matches what _loki_pid_looks_like_purplelab expects for
# SKILL_DIR=$REPO_ROOT), its pid recorded in the PID file cmd_web_stop reads.
T3B=$(
  set -u
  SBX_HOME=$(mktemp -d "${TMPDIR:-/tmp}/loki-webstop3b-home-XXXXXX")
  # Do NOT actually import/run the real web-app/server.py (a FastAPI/uvicorn
  # app -- it could bind the real Purple Lab port or crash on a missing
  # dependency, both wrong for a unit test). Instead use perl's $0 rewrite
  # (portable, already proven in decoy A above) to present EXACTLY the real
  # server_py path as argv[1] on a harmless sleep -- `ps` (what the identity
  # helper reads) sees the identical command line python3 would produce for a
  # genuine launch, but nothing actually imports the app.
  PY_BIN="$(command -v python3.12 || command -v python3)"
  perl -e '
      $0 = "'"$PY_BIN"' '"$REPO_ROOT"'/web-app/server.py";
      sleep 30;
  ' &
  OWN_PID=$!
  sleep 0.4

  if [ -z "$OWN_PID" ] || ! kill -0 "$OWN_PID" 2>/dev/null; then
    echo "OWN_SERVER_DID_NOT_START"
  else
    mkdir -p "$SBX_HOME/.loki/purple-lab"
    echo "$OWN_PID" > "$SBX_HOME/.loki/purple-lab/purple-lab.pid"
    mkdir -p "$SBX_HOME/.loki/dashboard"
    sleep 60 & DASH_PLACEHOLDER_PID=$!
    echo "$DASH_PLACEHOLDER_PID" > "$SBX_HOME/.loki/dashboard/dashboard.pid"
    TBIN=""
    command -v timeout >/dev/null 2>&1 && TBIN="timeout -k 10 20"
    command -v gtimeout >/dev/null 2>&1 && [ -z "$TBIN" ] && TBIN="gtimeout -k 10 20"
    ( cd "$SBX_HOME" && HOME="$SBX_HOME" LOKI_DIR="$SBX_HOME/.loki" \
        SKILL_DIR="$REPO_ROOT" LOKI_DASHBOARD_PORT=59993 \
        $TBIN bash "$LOKI" web stop >/dev/null 2>&1 )
    sleep 1
    if kill -0 "$OWN_PID" 2>/dev/null; then
      echo "OWN_SERVER_SURVIVED"
    else
      echo "OWN_SERVER_KILLED"
    fi
    kill -9 "$DASH_PLACEHOLDER_PID" 2>/dev/null || true
  fi

  kill -9 "$OWN_PID" 2>/dev/null || true
  rm -rf "$SBX_HOME"
)
if [ "$T3B" = "OWN_SERVER_KILLED" ]; then
    ok "cmd_web_stop still kills ITS OWN genuine Purple Lab server (identity check does not just refuse everything)"
elif [ "$T3B" = "OWN_SERVER_DID_NOT_START" ]; then
    bad "own-server test setup broken (not the function under test): $T3B"
else
    bad "cmd_web_stop failed to kill its own genuine Purple Lab server [$T3B] -- identity check is over-restrictive, not just fixed"
fi

# --- T4 hygiene: no em dashes in changed files -----------------------------
if grep -lP '\xe2\x80\x94' "$LOKI" "$SCRIPT_DIR/test-web-stop-scoping.sh" \
     >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
