#!/usr/bin/env bash
#
# test-core-bare-selfheal.sh
#
# Guards scripts/watch-core-bare.sh's --restore path, which local-ci.sh now
# uses unconditionally (scripts/local-ci.sh: "parent checkout is not falsely
# marked bare"). The fault this replays: something outside this repo flips
# core.bare=true on a checkout that still has a working tree, which breaks
# git status/log ("must be run in a work tree") until someone notices and
# repairs it by hand. The gate must still fail closed on detection (evidence
# of the recurrence is not optional), but must no longer leave the checkout
# broken -- it must restore core.bare=false before returning.
#
# Every case runs against a throwaway temp repo via LOKI_PARENT_REPO /
# LOKI_CORE_BARE_LOG. Never touches the real parent checkout or its log.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH="$REPO_ROOT/scripts/watch-core-bare.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); echo "[PASS] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

WORKDIR="$(mktemp -d)"
cleanup() {
  chmod 755 "$WORKDIR"/*/.git 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

new_fixture() {
  # $1: name. Sets FIXTURE/LOG to a fresh non-bare repo with core.bare unset.
  local name="$1"
  FIXTURE="$WORKDIR/$name"
  LOG="$WORKDIR/$name.log"
  mkdir -p "$FIXTURE"
  git init -q "$FIXTURE"
  touch "$FIXTURE/.git/index"
}

echo "=== core-bare self-heal tests ==="

# ---------------------------------------------------------------------------
# 1. Healthy: core.bare unset/false on a repo with a working tree -> exit 0,
#    nothing logged, no --restore side effect needed.
# ---------------------------------------------------------------------------
new_fixture healthy
out=$(LOKI_PARENT_REPO="$FIXTURE" LOKI_CORE_BARE_LOG="$LOG" bash "$WATCH" --restore 2>&1)
rc=$?
if [ "$rc" = "0" ]; then ok "healthy repo exits 0"; else bad "healthy repo exit ($rc): $out"; fi
[ -f "$LOG" ] && bad "healthy repo wrote a log file" || ok "healthy repo wrote no log"

# ---------------------------------------------------------------------------
# 1b. Healthy: a GENUINELY bare repo (core.bare=true, no .git/index) must not
#     be "healed". The has_index guard is what distinguishes mutation from a
#     real bare repo, and self-healing must not weaken it.
# ---------------------------------------------------------------------------
FIXTURE="$WORKDIR/genuinely_bare"
LOG="$WORKDIR/genuinely_bare.log"
git init -q --bare "$FIXTURE/.git"
out=$(LOKI_PARENT_REPO="$FIXTURE" LOKI_CORE_BARE_LOG="$LOG" bash "$WATCH" --restore 2>&1)
rc=$?
if [ "$rc" = "0" ]; then ok "genuinely bare repo exits 0 (not healed)"; else bad "genuinely bare repo exit ($rc): $out"; fi
[ -f "$LOG" ] && bad "genuinely bare repo wrote a log file" || ok "genuinely bare repo wrote no log"

# ---------------------------------------------------------------------------
# 2. Detected + restored: mutated repo, --restore passed -> gate still fails
#    (exit 1, evidence preserved), but core.bare is false again on return.
# ---------------------------------------------------------------------------
new_fixture mutated
git -C "$FIXTURE" config core.bare true
out=$(LOKI_PARENT_REPO="$FIXTURE" LOKI_CORE_BARE_LOG="$LOG" bash "$WATCH" --restore 2>&1)
rc=$?
if [ "$rc" = "1" ]; then ok "mutated+restored still fails the gate (exit 1)"; else bad "mutated+restored exit ($rc): $out"; fi

after="$(git -C "$FIXTURE" config --get core.bare)"
if [ "$after" = "false" ]; then ok "mutated+restored: core.bare restored to false"; else bad "mutated+restored: core.bare still '$after'"; fi

echo "$out" | grep -q "MUTATED" && ok "mutated+restored: reports MUTATED" || bad "mutated+restored: missing MUTATED report"

# ---------------------------------------------------------------------------
# 3. Backup + log: the mutated config was backed up, and the log carries both
#    MUTATED and RESTORED lines (the cp is best-effort `|| true`, so file
#    existence is the only thing that actually catches a broken backup).
# ---------------------------------------------------------------------------
backup_count=$(find "$FIXTURE/.git" -maxdepth 1 -name 'config.bak-*' | wc -l | tr -d ' ')
if [ "$backup_count" -ge 1 ]; then ok "mutated+restored: config backup written"; else bad "mutated+restored: no config.bak-* found"; fi

if [ -f "$LOG" ] && grep -q "MUTATED" "$LOG" && grep -q "RESTORED" "$LOG"; then
  ok "log contains MUTATED and RESTORED"
else
  bad "log missing MUTATED/RESTORED: $(cat "$LOG" 2>&1)"
fi

# ---------------------------------------------------------------------------
# 4. Failure to restore: .git is made unwritable so `git config` cannot write
#    config.lock. The gate must fail with a signal DISTINGUISHABLE from the
#    detected+restored case (exit 65, not 1), core.bare must still read
#    true, and the log must carry RESTORE_FAILED.
# ---------------------------------------------------------------------------
new_fixture unrestorable
git -C "$FIXTURE" config core.bare true
chmod 555 "$FIXTURE/.git"
out=$(LOKI_PARENT_REPO="$FIXTURE" LOKI_CORE_BARE_LOG="$LOG" bash "$WATCH" --restore 2>&1)
rc=$?
chmod 755 "$FIXTURE/.git"

if [ "$rc" = "65" ]; then ok "restore failure exits 65 (distinguishable from 1)"; else bad "restore failure exit ($rc): $out"; fi

still="$(git -C "$FIXTURE" config --get core.bare)"
if [ "$still" = "true" ]; then ok "restore failure: core.bare still true"; else bad "restore failure: core.bare unexpectedly '$still'"; fi

if [ -f "$LOG" ] && grep -q "RESTORE_FAILED" "$LOG"; then
  ok "log contains RESTORE_FAILED"
else
  bad "log missing RESTORE_FAILED: $(cat "$LOG" 2>&1)"
fi

# ---------------------------------------------------------------------------
# 5. Standalone default (no --restore) is unchanged: mutation detected,
#    reported, logged, exit 1, but core.bare is left as-is (still true).
# ---------------------------------------------------------------------------
new_fixture readonly_default
git -C "$FIXTURE" config core.bare true
out=$(LOKI_PARENT_REPO="$FIXTURE" LOKI_CORE_BARE_LOG="$LOG" bash "$WATCH" 2>&1)
rc=$?
if [ "$rc" = "1" ]; then ok "no --restore: still exits 1"; else bad "no --restore exit ($rc): $out"; fi
still="$(git -C "$FIXTURE" config --get core.bare)"
if [ "$still" = "true" ]; then ok "no --restore: core.bare left untouched"; else bad "no --restore: core.bare unexpectedly '$still'"; fi

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
