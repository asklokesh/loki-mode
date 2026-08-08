#!/usr/bin/env bash
# reap_own_process_group() must refuse a pgid stamp it cannot prove belongs to
# THIS run.
#
# THE BUG (measured on a real machine, not hypothetical). run.sh writes the
# orchestrator's process-group id to .loki/loki.pgid, and the completion path
# TERM/KILLs every pid sharing that group. The file was written as a bare
# number and removed ONLY on the normal exit path, so a Ctrl+C'd or crashed run
# left it behind indefinitely -- two orphans were found aged 155h and 202h.
#
# macOS recycles PIDs (they wrap near 99999; 99762 was observed live). Given a
# week-old pgid, the number eventually names a LIVE, unrelated process group --
# the user's other terminal, their editor, another agent session. The only
# safety check at the time was `[ "$_pgid" = "$_my_pgid" ]`, which PASSES in
# exactly that case, because by then the stale number really is our group. The
# reap then killed the user's sibling sessions.
#
# The fix stamps `pgid=<n> boot=<id> started=<epoch>` and requires both to
# match before signalling anything. A recycled pgid cannot forge either:
# a pre-reboot file can never match this boot, and a stale file is always OLDER
# than the process now reading it.
#
# TEST 2 IS THE USER'S ACTUAL BUG: same boot, pgid genuinely equal to our own
# group, but a `started` that predates this process. That is precisely the
# recycled-pgid shape, and it is the one the old self-check waved through.
#
# TEST 5 IS THE POSITIVE CONTROL and is load-bearing: without it, a guard that
# refuses EVERYTHING passes tests 1-4 while silently reintroducing the v7.41.x
# orphaned-agent regression this reap exists to prevent.
#
# `kill` is stubbed to a recorder; `ps` is deliberately NOT stubbed, because
# stubbing it would make the pgid self-check vacuous. So the guards under test
# all execute for real against the real process group.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: reap_own_process_group refuses an unprovable pgid stamp"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-pgid-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- Extract the REAL functions ---------------------------------------------
# By name, not by line number, so the test survives line drift. Sourcing run.sh
# directly would execute main().
EXTRACT="$WORK/extracted.sh"
: > "$EXTRACT"
for _fn in _loki_pgid_field _loki_boot_id _loki_proc_start_epoch reap_own_process_group; do
  sed -n "/^${_fn}() {/,/^}/p" "$SRC" >> "$EXTRACT"
  if ! grep -q "^${_fn}() {" "$EXTRACT"; then
    echo "  FAIL: could not extract $_fn from run.sh (renamed?)"; exit 1
  fi
done

# shellcheck disable=SC1090
. "$EXTRACT"

# --- Harness ----------------------------------------------------------------
KILLS="$WORK/kills.log"

# Recorder, NOT the real kill: the positive control runs the genuine reaper
# against our own live process group, whose siblings include this harness and
# any concurrent CI lane.
kill() { echo "$*" >> "$KILLS"; return 0; }

MY_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
MY_BOOT="$(_loki_boot_id)"
MY_STARTED="$(_loki_proc_start_epoch $$)"

if [ -z "$MY_PGID" ] || [ -z "$MY_BOOT" ] || [ -z "$MY_STARTED" ]; then
  echo "  SKIPPED: host cannot report pgid/boot/start epoch (not a pass)"; exit 0
fi

# Run the real reaper against a stamp, report what it signalled.
# Each case gets its own TARGET_DIR so nothing leaks between them.
run_reap() {
  local _label="$1" _content="$2" _dir
  _dir="$WORK/$_label"; mkdir -p "$_dir/.loki"
  printf '%s' "$_content" > "$_dir/.loki/loki.pgid"
  : > "$KILLS"
  TARGET_DIR="$_dir" LOKI_SESSION_ID="" reap_own_process_group >/dev/null 2>&1 || true
}

signalled() { [ -s "$KILLS" ]; }

# --- 1. A stamp from a DIFFERENT BOOT is refused ----------------------------
# Orthogonal to test 2 on purpose: `started` here is VALID (not stale), so the
# ONLY thing that can refuse this stamp is the boot check. If the age check
# were also refusing it, reverting the boot guard would leave the test green
# and the mutation check would prove nothing.
run_reap boot "pgid=$MY_PGID boot=$((MY_BOOT - 86400)) started=$MY_STARTED"
if signalled; then
  bad "a stamp from a previous boot was reaped -- pre-reboot pgid is trusted"
else
  ok "a stamp from a different boot id is refused"
fi

# --- 2. THE USER'S ACTUAL BUG: a stamp OLDER than this process --------------
# Valid boot, pgid genuinely equal to our own group. Only `started` gives it
# away. This is the recycled-pgid case that killed the user's other terminal
# sessions, and the old `[ pgid = my_pgid ]` self-check PASSED it.
run_reap age "pgid=$MY_PGID boot=$MY_BOOT started=$((MY_STARTED - 3600))"
if signalled; then
  bad "a stamp predating this process was reaped -- THE SESSION-KILLER IS BACK"
else
  ok "a stamp older than this process is refused (the recycled-pgid bug)"
fi

# --- 3. A LEGACY bare-number file is refused --------------------------------
# Every pgid file written before the fix looks like this, including the 155h
# and 202h orphans found on the real machine. It carries no proof at all.
run_reap legacy "$MY_PGID"
if signalled; then
  bad "a legacy bare-number pgid file was reaped -- existing orphans still kill"
else
  ok "a legacy unstamped bare-number file is refused"
fi

# --- 4. Malformed and empty files are refused (fail CLOSED) -----------------
_malformed_leaks=0
for _junk in "" "   " "pgid= boot= started=" "pgid=abc boot=$MY_BOOT started=$MY_STARTED" "garbage"; do
  run_reap "malformed" "$_junk"
  signalled && _malformed_leaks=$((_malformed_leaks + 1))
done
if [ "$_malformed_leaks" -eq 0 ]; then
  ok "malformed and empty stamps are refused (fails closed)"
else
  bad "$_malformed_leaks malformed stamp(s) reaped -- the guard fails OPEN"
fi

# --- 5. POSITIVE CONTROL: a valid stamp for our own group IS accepted -------
# Without this, refusing everything would pass 1-4 and silently restore the
# v7.41.x orphaned-agent hole. `started` is the real value, so the <= skew
# comparison is exercised rather than side-stepped.
run_reap valid "pgid=$MY_PGID boot=$MY_BOOT started=$MY_STARTED"
if signalled; then
  ok "a correctly-stamped file for our own live group IS reaped"
else
  bad "a valid stamp was refused -- the reap is dead, orphaned agents survive"
fi

# --- 6. The WRITER emits all three fields and they round-trip ---------------
# Guards against the halves drifting apart: a writer that stops emitting `boot`
# turns every future run into case 1 and disables the reap entirely.
_writer="$(sed -n '/_loki_pgid_started="\$(_loki_proc_start_epoch \$\$)"/,/> "\$_LOKI_PGID_FILE"/p' "$SRC")"
_missing=""
for _field in 'pgid=%s' 'boot=%s' 'started=%s'; do
  printf '%s' "$_writer" | grep -q -- "$_field" || _missing="$_missing $_field"
done
if [ -n "$_missing" ]; then
  bad "writer no longer emits:$_missing"
else
  # Round-trip the writer's exact format through the real reader.
  _stamp="$(printf 'pgid=%s boot=%s started=%s\n' "$MY_PGID" "$MY_BOOT" "$MY_STARTED")"
  _rt_ok=1
  [ "$(_loki_pgid_field "$_stamp" pgid)"    = "$MY_PGID" ]    || _rt_ok=0
  [ "$(_loki_pgid_field "$_stamp" boot)"    = "$MY_BOOT" ]    || _rt_ok=0
  [ "$(_loki_pgid_field "$_stamp" started)" = "$MY_STARTED" ] || _rt_ok=0
  if [ "$_rt_ok" -eq 1 ]; then
    ok "writer emits pgid/boot/started and all three round-trip through the reader"
  else
    bad "writer format does not round-trip through _loki_pgid_field"
  fi
fi

# --- 7. The pgid file is removed on EVERY exit path, not just completion ----
# The orphan files existed because removal lived only on the normal-completion
# path. The removal now hangs off the EXIT trap, which also covers the INT/TERM
# paths (they terminate via `exit`), and is guarded by BASHPID so a SUBSHELL
# exiting cannot delete a live parent's file.
_rm_fn="$(sed -n '/^_loki_remove_pgid_file() {/,/^}/p' "$SRC")"
if [ -z "$_rm_fn" ]; then
  bad "_loki_remove_pgid_file is gone -- the pgid file outlives interrupted runs again"
else
  _sub_guard=0
  # $$ does NOT change in a bash subshell, so a $$-based guard is a no-op here.
  # Strip comments first: this function's own comment explains BASHPID, and a
  # bare grep matched that PROSE while the code used the useless $$ form.
  printf '%s' "$_rm_fn" | sed 's/#.*//' | grep -q 'BASHPID' && _sub_guard=1
  if [ "$_sub_guard" -eq 1 ]; then
    ok "pgid removal is BASHPID-guarded (a subshell exit cannot delete a live parent's file)"
  else
    bad "pgid removal lacks a BASHPID subshell guard -- a subshell EXIT can delete a live run's file"
  fi
  if sed -n '/^_loki_session_exit_cleanup() {/,/^}/p' "$SRC" | grep -q '_loki_remove_pgid_file'; then
    ok "removal is wired into the EXIT trap (covers Ctrl+C and crash, not just completion)"
  else
    bad "removal is not on the EXIT trap -- an interrupted run leaks its pgid file again"
  fi
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
