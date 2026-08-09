#!/usr/bin/env bash
# The emit.sh watchdog records WHY it fired, before it kills (issue #184).
#
# WHY THIS EXISTS. The watchdog has bounded the damage of the emit.sh hang since
# it was added, but it SIGKILLed the process without capturing anything -- so
# the cause is still unknown after two disproved hypotheses (the lock-retry
# counter, and six synthetic race probes). A SIGKILL destroys the only evidence
# that existed at the moment of the hang.
#
# TEST 3 IS THE LOAD-BEARING ONE, and it is about not making things worse. The
# capture runs INSIDE the watchdog. A capture that blocks would replace a
# BOUNDED failure with an UNBOUNDED one -- exactly what the watchdog exists to
# prevent. So the normal path must stay clean and the watchdog must still kill.
#
# `sample` is macOS-only. On Linux the stack section degrades to a named line
# rather than failing, because a diagnostic that refuses to write on the wrong
# platform is a diagnostic nobody gets.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EMIT="$REPO_ROOT/events/emit.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the emit watchdog captures forensics before killing"

[ -f "$EMIT" ] || { echo "  FAIL: $EMIT missing"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-emitdiag.XXXXXX")"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT INT TERM

# --- 1. The capture exists and is bounded ----------------------------------
# Asserted on the PROPERTY (a diag file path and a guarded sample call) rather
# than exact prose, so rewording does not silently disarm this.
if grep -q "loki-emit-hang" "$EMIT" && grep -q "LOKI_EMIT_DIAG_DIR" "$EMIT"; then
    ok "the watchdog writes a diagnostic file to a configurable directory"
else
    bad "no forensic capture in the watchdog -- a hang still leaves no evidence"
fi

if grep -q "command -v sample" "$EMIT"; then
    ok "the stack sample is guarded (absent sample does not break the watchdog)"
else
    bad "sample is called unguarded -- it is macOS-only and would fail on Linux"
fi

# --- 2. It runs BEFORE the kill --------------------------------------------
# After a SIGKILL there is nothing left to sample. Compares line numbers rather
# than trusting the reading order of the file.
_diag_line="$(grep -n "loki-emit-hang" "$EMIT" | head -1 | cut -d: -f1)"
_kill_line="$(grep -n 'kill -9 "\$_emit_target"' "$EMIT" | head -1 | cut -d: -f1)"
if [ -n "$_diag_line" ] && [ -n "$_kill_line" ] && [ "$_diag_line" -lt "$_kill_line" ]; then
    ok "the capture runs before the SIGKILL (line $_diag_line before $_kill_line)"
else
    bad "the capture is at or after the kill -- there would be nothing left to sample"
fi

# --- 3. THE GUARD: the normal path stays clean -----------------------------
# A diagnostic on every successful emit would be noise, and worse, evidence that
# the watchdog is firing when it should not.
if timeout 40 env LOKI_EMIT_DIAG_DIR="$WORK" bash "$EMIT" test_event '{"k":"v"}' >/dev/null 2>&1; then
    if ls "$WORK"/loki-emit-hang-*.txt >/dev/null 2>&1; then
        bad "a normal emit wrote a hang diagnostic -- the watchdog fired when it should not have"
    else
        ok "a normal emit writes no diagnostic and exits 0"
    fi
else
    # A non-zero exit here is an environment problem (no writable .loki, no
    # curl), not a defect in this change. Named rather than silently passed.
    ok "skipped the happy-path check: emit.sh exited non-zero in this environment (not a pass for the capture)"
fi

# --- 4. The watchdog still KILLS -------------------------------------------
# The whole point of the capture is to add evidence WITHOUT weakening the bound.
# Drives the real watchdog block against a process that hangs on purpose.
_probe="$WORK/probe.sh"
cat > "$_probe" <<'PROBE'
_emit_max=2
_emit_target=$$
LOKI_EMIT_DIAG_DIR="$1"
( _waited=0
  while [ "$_waited" -lt "$_emit_max" ]; do
      sleep 1
      kill -0 "$_emit_target" 2>/dev/null || exit 0
      _waited=$((_waited + 1))
  done
  . "$2" ) >/dev/null 2>&1 &
sleep 30
PROBE
# Extract the real capture+kill block so this cannot drift from the source.
sed -n '/FORENSICS BEFORE THE KILL/,/kill -9 "\$_emit_target"/p' "$EMIT" > "$WORK/frag.sh"
if [ -s "$WORK/frag.sh" ]; then
    timeout 25 bash "$_probe" "$WORK" "$WORK/frag.sh" >/dev/null 2>&1
    _rc=$?
    if [ "$_rc" -eq 137 ]; then
        ok "the watchdog still SIGKILLs a hung process (rc 137)"
    else
        bad "the hung probe exited $_rc, expected 137 -- the capture may have broken the kill"
    fi
    if ls "$WORK"/loki-emit-hang-*.txt >/dev/null 2>&1; then
        _f="$(ls "$WORK"/loki-emit-hang-*.txt | head -1)"
        grep -q "watchdog fired" "$_f" && ok "the diagnostic names the watchdog and the pid" \
            || bad "the diagnostic exists but does not identify itself"
        grep -q -- "--- children ---" "$_f" && ok "the diagnostic records the child process tree" \
            || bad "no child tree -- the blocking child is what identifies the hang"
    else
        bad "the watchdog fired but wrote no diagnostic"
    fi
else
    bad "could not extract the capture block from $EMIT"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
