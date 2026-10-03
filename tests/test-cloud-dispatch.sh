#!/usr/bin/env bash
# G-04: scripts/cloud-dispatch.sh. Dry-run is the only tested path. Fixture
# BOARD files and a stub governor live in a run-owned temp dir; the real
# docs/v10/BOARD.md is never written and no cloud session is ever started.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="$REPO_ROOT/scripts/cloud-dispatch.sh"
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "TEST: cloud-dispatch.sh (G-04)"
[ -f "$TOOL" ] || { echo "  FAIL: $TOOL missing"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$TMP"' EXIT

BOARD="$TMP/BOARD.md"
cat > "$BOARD" <<'BEOF'
# Board

| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| A-1 | eng | scripts/alpha.sh, tests/test-alpha.sh | LOW | building@2026-10-01T10:00Z | in flight |
| A-2 | eng | docs/v10/ | LOW | review@2026-10-01T10:00Z | in review |
| A-3 | eng | scripts/gamma.sh | LOW | merged@2026-10-01T10:00Z | done |
| A-4 | eng | scripts/delta.sh | LOW | released@2026-10-01T10:00Z | done |
| R-1 | po | scripts/free.sh, tests/test-free.sh | LOW | ready@2026-10-01T10:00Z | Depends on A-4. clean |
| R-2 | po | scripts/alpha.sh | LOW | ready@2026-10-01T10:00Z | overlaps A-1 file |
| R-3 | po | docs/v10/SWARM.md | LOW | ready@2026-10-01T10:00Z | inside dir of A-2 |
| R-4 | po | scripts/other.sh | LOW | ready@2026-10-01T10:00Z | Depends on A-1 and A-4. unmerged dep |
| R-5 | po | scripts/other2.sh | LOW | blocked@2026-10-01T10:00Z | blocked |
| R-6 | po | scripts/other3.sh | LOW | building@2026-10-01T10:00Z | already building |
| R-7 | po | scripts/g*.sh | LOW | ready@2026-10-01T10:00Z | glob overlaps nothing in flight |
| R-8 | po | scripts/al* | LOW | ready@2026-10-01T10:00Z | glob overlaps A-1 |
BEOF
BOARD_SUM_BEFORE="$(cksum < "$BOARD")"

GOV_OK="$TMP/gov-ok.json"
printf '{"governor":{"max_engineers_next_hour":5,"active_engineers_last_hour":1}}\n' > "$GOV_OK"
GOV_FULL="$TMP/gov-full.json"
printf '{"governor":{"max_engineers_next_hour":3,"active_engineers_last_hour":1}}\n' > "$GOV_FULL"
GOV_NULL="$TMP/gov-null.json"
printf '{"governor":{"max_engineers_next_hour":null,"max_engineers_reason":"uncalibrated"}}\n' > "$GOV_NULL"

run() { # $1 gov file, rest args
  local gov="$1"; shift
  CLOUD_DISPATCH_GOVERNOR_CMD="cat $gov" CLOUD_DISPATCH_NOW="2026-10-03T12:00Z" \
    bash "$TOOL" --board "$BOARD" "$@" 2>&1
}

# 1. clean dry-run: exit 0, command and row printed, board untouched
out="$(run "$GOV_OK" R-1)"; rc=$?
[ "$rc" -eq 0 ] && ok "clean slice dry-run exits 0" || bad "clean dry-run rc=$rc: $out"
case "$out" in *"DRY RUN"*) ok "dry-run is the default and says so" ;; *) bad "no DRY RUN marker: $out" ;; esac
case "$out" in *"claude --cloud "*) ok "prints the exact claude --cloud command" ;; *) bad "no command: $out" ;; esac
case "$out" in *"| R-1 |"*"building@2026-10-03T12:00Z"*"cloud/r-1"*) ok "prints the BOARD row it would write" ;; *) bad "no row: $out" ;; esac
[ "$(cksum < "$BOARD")" = "$BOARD_SUM_BEFORE" ] && ok "dry-run leaves the board byte-identical" || bad "board changed by dry-run"

# 2. explicit --dry-run behaves the same
out="$(run "$GOV_OK" --dry-run R-1)"; rc=$?
[ "$rc" -eq 0 ] && ok "explicit --dry-run exits 0" || bad "explicit --dry-run rc=$rc"

# 3. overlap refusals
for pair in "R-2:A-1" "R-3:A-2" "R-8:A-1"; do
  s="${pair%%:*}"; w="${pair##*:}"
  out="$(run "$GOV_OK" "$s")"; rc=$?
  if [ "$rc" -ne 0 ] && case "$out" in *"REFUSED"*overlap*"$w"*) true ;; *) false ;; esac; then
    ok "$s refused: overlaps $w"
  else bad "$s expected overlap refusal vs $w, rc=$rc: $out"; fi
done

# 4. no false overlap
out="$(run "$GOV_OK" R-7)"; rc=$?
[ "$rc" -eq 0 ] && ok "non-overlapping glob dispatches" || bad "R-7 rc=$rc: $out"

# 5. not ready / blocked / dependency
for s in R-5 R-6 A-3 R-4 NOPE-1; do
  out="$(run "$GOV_OK" "$s")"; rc=$?
  if [ "$rc" -ne 0 ] && case "$out" in *"REFUSED"*) true ;; *) false ;; esac; then
    ok "$s refused (not ready, dependency-blocked or unknown)"
  else bad "$s expected refusal, rc=$rc: $out"; fi
done
out="$(run "$GOV_OK" R-4)"
case "$out" in *"A-1"*"not merged"*) ok "R-4 refusal names the unmerged dependency" ;; *) bad "R-4 message: $out" ;; esac

# 6. governor refusals (board has 2 in flight: A-1 building, A-2 review, R-6 building = 3)
out="$(run "$GOV_FULL" R-1)"; rc=$?
if [ "$rc" -ne 0 ] && case "$out" in *"REFUSED"*governor*max*) true ;; *) false ;; esac; then
  ok "governor max reached refuses (3 in flight on board >= max 3)"
else bad "governor full: rc=$rc: $out"; fi
out="$(run "$GOV_NULL" R-1)"; rc=$?
if [ "$rc" -ne 0 ] && case "$out" in *"REFUSED"*governor*) true ;; *) false ;; esac; then
  ok "unknown governor max refuses (fail safe)"
else bad "governor null: rc=$rc: $out"; fi
CLOUD_DISPATCH_GOVERNOR_CMD="false" bash "$TOOL" --board "$BOARD" R-1 >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "governor command failure refuses" || bad "governor failure dispatched"

# 7. --live refuses when the cloud CLI is not available (stub with no --cloud)
STUB="$TMP/claude-stub"
printf '#!/bin/sh\necho "Usage: claude [options]"\n' > "$STUB"; chmod 755 "$STUB"
out="$(CLOUD_DISPATCH_GOVERNOR_CMD="cat $GOV_OK" CLAUDE_BIN="$STUB" bash "$TOOL" --board "$BOARD" --live R-1 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && case "$out" in *"cloud CLI not available"*) true ;; *) false ;; esac; then
  ok "--live refuses with 'cloud CLI not available' when --cloud is absent"
else bad "live stub: rc=$rc: $out"; fi
[ "$(cksum < "$BOARD")" = "$BOARD_SUM_BEFORE" ] && ok "refused live leaves the board untouched" || bad "board changed by refused live"

# 8. usage errors
bash "$TOOL" --board "$BOARD" >/dev/null 2>&1; [ $? -ne 0 ] && ok "missing slice id is an error" || bad "no slice id accepted"
bash "$TOOL" --board "$BOARD" --live --dry-run R-1 >/dev/null 2>&1; [ $? -ne 0 ] && ok "--live with --dry-run is an error" || bad "live+dry-run accepted"
bash "$TOOL" --board "$BOARD" --dry-run --live R-1 >/dev/null 2>&1; [ $? -ne 0 ] && ok "--dry-run then --live is an error" || bad "dry-run+live accepted"
bash "$TOOL" --board "$BOARD" --bogus R-1 >/dev/null 2>&1; [ $? -ne 0 ] && ok "unknown flag is an error" || bad "unknown flag accepted"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
