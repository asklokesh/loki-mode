#!/usr/bin/env bash
# The shared-dashboard teardown must not kill a pid it cannot identify.
#
# THE BUG (measured in this checkout, not hypothetical).
# loki_mark_project_stopped_and_maybe_kill_shared_dashboard() reads a pid from
# ~/.loki/dashboard/dashboard.pid and sends it `kill` then `kill -9`. That file
# is removed ONLY on the explicit stop paths (run.sh:16608, :16658, :17399) --
# no trap covers a crash or a Ctrl+C, so it outlives its dashboard.
#
# Evidence: .loki/dashboard/dashboard.pid in this working copy held pid 87992,
# already DEAD, with an mtime 8 days old. PIDs recycle, so a stale number
# eventually names an unrelated LIVE process. The pid file is machine-global
# (~/.loki), so the victim need not even belong to this project.
#
# `kill -0` is NOT a sufficient guard and that is the whole point: a recycled
# pid IS alive, so a liveness check passes and the kill lands on the wrong
# process. This is the identical insufficiency that the loki.pgid self-check
# had (see tests/test-pgid-stale-reap.sh). The guard must check IDENTITY.
#
# TEST 2 IS THE LOAD-BEARING ONE: a live pid that is NOT a dashboard must be
# refused. That is the recycled-pid case that kills a user's unrelated process.
#
# TEST 3 IS THE POSITIVE CONTROL: a real dashboard-looking pid must still be
# accepted, or the teardown silently stops working and leaks dashboards.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: shared-dashboard teardown refuses an unidentifiable pid"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-dashpid-test.XXXXXX")"
cleanup_work() {
  [ -n "${SLEEPER_PID:-}" ] && kill -9 "$SLEEPER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup_work EXIT

# --- Extract the REAL function ----------------------------------------------
# By name, not line number. Sourcing run.sh would execute main().
EXTRACT="$WORK/extracted.sh"
sed -n '/^_loki_pid_looks_like_dashboard() {/,/^}/p' "$SRC" > "$EXTRACT"
if ! grep -q "^_loki_pid_looks_like_dashboard() {" "$EXTRACT"; then
  echo "  FAIL: could not extract _loki_pid_looks_like_dashboard from run.sh"; exit 1
fi
# shellcheck disable=SC1090
. "$EXTRACT"

# --- 1. A DEAD pid is refused ------------------------------------------------
# The measured case: 87992, dead, 8-day-old file. ps returns nothing for the
# command of a dead pid, but the pid is also gone, so nothing is signalled.
# Use a pid we just reaped so it is genuinely absent.
sleep 300 & _dead_pid=$!
kill -9 "$_dead_pid" 2>/dev/null; wait "$_dead_pid" 2>/dev/null
if _loki_pid_looks_like_dashboard "$_dead_pid"; then
  # ps prints nothing -> fail-open. Acceptable ONLY because the pid is dead:
  # the subsequent kill is a no-op. Assert that reasoning holds.
  if kill -0 "$_dead_pid" 2>/dev/null; then
    bad "a DEAD pid was accepted AND is somehow live -- would signal a stranger"
  else
    ok "a dead pid is accepted only vacuously (kill is a no-op, nothing to hit)"
  fi
else
  ok "a dead pid is refused outright"
fi

# --- 2. THE RECYCLED-PID CASE: a LIVE non-dashboard pid is refused -----------
# This is the process a user loses today. `sleep` stands in for their editor or
# another agent session: alive, so kill -0 would pass, but plainly not a
# dashboard.
sleep 300 & SLEEPER_PID=$!
if ! kill -0 "$SLEEPER_PID" 2>/dev/null; then
  echo "  SKIPPED: could not start a live probe process (not a pass)"; exit 0
fi
if _loki_pid_looks_like_dashboard "$SLEEPER_PID"; then
  bad "a LIVE unrelated process was accepted -- the recycled-pid kill is BACK"
else
  ok "a live non-dashboard process is refused (the recycled-pid bug)"
fi
# Prove the weaker guard would NOT have caught it, so the test documents why
# kill -0 is insufficient rather than merely asserting the stronger one.
if kill -0 "$SLEEPER_PID" 2>/dev/null; then
  ok "...and kill -0 alone WOULD have accepted it (why liveness is not enough)"
else
  bad "probe process died early -- test 2 proved nothing"
fi

# --- 3. POSITIVE CONTROL: a dashboard-looking pid IS accepted ----------------
# Without this, a guard that refuses everything passes 1-2 while silently
# disabling teardown and leaking a dashboard per run. $$ is this bash process;
# its command line contains the test path, which contains "loki", matching the
# same token the real dashboard command carries.
if _loki_pid_looks_like_dashboard "$$"; then
  ok "a pid whose command matches the dashboard pattern IS accepted"
else
  bad "a matching pid was refused -- teardown is dead, dashboards leak"
fi

# --- 4. pid 0/1 and malformed input are refused (never signal init) ---------
_bad_inputs=0
for _junk in "" "0" "1" "abc" "-5" "12x"; do
  _loki_pid_looks_like_dashboard "$_junk" && _bad_inputs=$((_bad_inputs+1))
done
if [ "$_bad_inputs" -eq 0 ]; then
  ok "pid 0/1, empty and malformed inputs are all refused"
else
  bad "$_bad_inputs unsafe input(s) accepted -- could signal init"
fi

# --- 5. The call site actually USES the guard -------------------------------
# A guard nobody calls is decoration. Assert the kill is gated on it, with
# comments stripped so the function's own prose cannot satisfy the match.
_call_site="$(sed -n '/^loki_mark_project_stopped_and_maybe_kill_shared_dashboard() {/,/^}/p' "$SRC" | sed 's/#.*//')"
if printf '%s' "$_call_site" | grep -q '_loki_pid_looks_like_dashboard "\$_shared_pid"'; then
  ok "the shared-dashboard kill is gated on the identity guard"
else
  bad "the kill is NOT gated on the guard -- stale pids are signalled again"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
