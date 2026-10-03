#!/usr/bin/env bash
# G-04: scripts/cloud-dispatch.sh. Dry-run is the only tested path. Fixture
# BOARD files and a stub governor live in a run-owned temp dir; the real
# docs/v10/BOARD.md is never written. The only --live invocations are refusal
# paths that must stop before any cloud command runs (a stub records any run).
# The runner invokes this under the host bash; the script under test is run
# with /bin/bash (3.2 on macOS) so a bash 3.2 parse error is caught.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="${CLOUD_DISPATCH_TOOL:-$REPO_ROOT/scripts/cloud-dispatch.sh}"
SUT_BASH="${CLOUD_DISPATCH_SUT_BASH:-/bin/bash}"
[ -x "$SUT_BASH" ] || SUT_BASH=bash
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
# expect_refusal NAME RC_REGEX OUTPUT_GLOB RC OUTPUT
expect_refusal() {
  local name="$1" want_rc="$2" glob="$3" rc="$4" out="$5"
  # shellcheck disable=SC2254  # $glob is a deliberate pattern
  if [ "$rc" -ne 0 ] && [ "$rc" = "$want_rc" ] && case "$out" in $glob) true ;; *) false ;; esac; then
    ok "$name"
  else
    bad "$name (want rc=$want_rc and '$glob'; got rc=$rc: $out)"
  fi
}

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
GOV_BIG="$TMP/gov-big.json"
printf '{"governor":{"max_engineers_next_hour":50,"active_engineers_last_hour":0}}\n' > "$GOV_BIG"
GOV_FULL="$TMP/gov-full.json"
printf '{"governor":{"max_engineers_next_hour":3,"active_engineers_last_hour":1}}\n' > "$GOV_FULL"
GOV_NULL="$TMP/gov-null.json"
printf '{"governor":{"max_engineers_next_hour":null,"max_engineers_reason":"uncalibrated"}}\n' > "$GOV_NULL"

# run_on BOARD_FILE GOV_FILE args...
run_on() {
  local b="$1" gov="$2"; shift 2
  CLOUD_DISPATCH_GOVERNOR_CMD="cat $gov" CLOUD_DISPATCH_NOW="2026-10-03T12:00Z" \
    "$SUT_BASH" "$TOOL" --board "$b" "$@" 2>&1
}
run() { local gov="$1"; shift; run_on "$BOARD" "$gov" "$@"; }

HDR='| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|'
# mkboard NAME < rows ; prints the path
mkboard() { { printf '# Board\n\n%s\n' "$HDR"; cat; } > "$TMP/$1.md"; printf '%s' "$TMP/$1.md"; }

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
  expect_refusal "$s refused: overlaps $w" 11 "*REFUSED*overlap*$w*" "$rc" "$out"
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

# 6. governor refusals (board has 3 in flight: A-1 building, A-2 review, R-6 building)
out="$(run "$GOV_FULL" R-1)"; rc=$?
expect_refusal "governor max reached refuses (3 in flight on board >= max 3)" 10 "*REFUSED*governor*max*" "$rc" "$out"
out="$(run "$GOV_NULL" R-1)"; rc=$?
expect_refusal "unknown governor max refuses (fail safe)" 10 "*REFUSED*governor*" "$rc" "$out"
CLOUD_DISPATCH_GOVERNOR_CMD="false" "$SUT_BASH" "$TOOL" --board "$BOARD" R-1 >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "governor command failure refuses" || bad "governor failure dispatched"

# 7. --live refuses when the cloud CLI is not available (stub with no --cloud)
STUB="$TMP/claude-stub"
printf '#!/bin/sh\necho "Usage: claude [options]"\n' > "$STUB"; chmod 755 "$STUB"
out="$(CLOUD_DISPATCH_GOVERNOR_CMD="cat $GOV_OK" CLAUDE_BIN="$STUB" "$SUT_BASH" "$TOOL" --board "$BOARD" --live R-1 2>&1)"; rc=$?
expect_refusal "--live refuses with 'cloud CLI not available' when --cloud is absent" 13 "*cloud CLI not available*" "$rc" "$out"
[ "$(cksum < "$BOARD")" = "$BOARD_SUM_BEFORE" ] && ok "refused live leaves the board untouched" || bad "board changed by refused live"

# 8. usage errors
"$SUT_BASH" "$TOOL" --board "$BOARD" >/dev/null 2>&1; [ $? -ne 0 ] && ok "missing slice id is an error" || bad "no slice id accepted"
"$SUT_BASH" "$TOOL" --board "$BOARD" --live --dry-run R-1 >/dev/null 2>&1; [ $? -ne 0 ] && ok "--live with --dry-run is an error" || bad "live+dry-run accepted"
"$SUT_BASH" "$TOOL" --board "$BOARD" --dry-run --live R-1 >/dev/null 2>&1; [ $? -ne 0 ] && ok "--dry-run then --live is an error" || bad "dry-run+live accepted"
"$SUT_BASH" "$TOOL" --board "$BOARD" --bogus R-1 >/dev/null 2>&1; [ $? -ne 0 ] && ok "unknown flag is an error" || bad "unknown flag accepted"

# ---- Round 2 ---------------------------------------------------------------

# F5. parses under the system bash (3.2 on macOS)
"$SUT_BASH" -n "$TOOL" 2>"$TMP/syntax.err" && ok "F5: $SUT_BASH -n parses the script" || bad "F5: $SUT_BASH -n failed: $(cat "$TMP/syntax.err")"

# F1. dependencies: odd id shapes, lowercase, parenthesised periods, "also depends on"
B1="$(mkboard f1 <<'EOF'
| B-1 | eng | scripts/b1.sh | LOW | building@2026-10-01T10:00Z | x |
| S41-13 | eng | scripts/s41.sh | LOW | building@2026-10-01T10:00Z | x |
| W1-S2 | eng | scripts/w1s2.sh | LOW | building@2026-10-01T10:00Z | x |
| D61-11b | eng | scripts/d61.sh | LOW | review@2026-10-01T10:00Z | x |
| A-4 | eng | scripts/delta.sh | LOW | released@2026-10-01T10:00Z | done |
| M-5 | eng | scripts/m5.sh | LOW | merged@2026-10-01T10:00Z | done |
| F1-1 | po | scripts/f11.sh | LOW | ready@2026-10-01T10:00Z | Depends on S41-13. |
| F1-2 | po | scripts/f12.sh | LOW | ready@2026-10-01T10:00Z | Depends on W1-S2 and A-4. |
| F1-3 | po | scripts/f13.sh | LOW | ready@2026-10-01T10:00Z | Depends on D61-11b. |
| F1-4 | po | scripts/f14.sh | LOW | ready@2026-10-01T10:00Z | needs review; depends on W1-S2. |
| F1-5 | po | scripts/f15.sh | LOW | ready@2026-10-01T10:00Z | Depends on A-4 (merged. verified) and W1-S2. |
| F1-6 | po | scripts/f16.sh | LOW | ready@2026-10-01T10:00Z | Depends on A-4. Done soon; also depends on W1-S2. |
| F1-7 | po | scripts/f17.sh | LOW | ready@2026-10-01T10:00Z | Depends on A-4 and M-5 (both landed). |
| F1-8 | po | scripts/f18.sh | LOW | ready@2026-10-01T10:00Z | Depends on NOPE-99. |
EOF
)"
for s in F1-1 F1-2 F1-3 F1-4 F1-5 F1-6 F1-8; do
  out="$(run_on "$B1" "$GOV_BIG" "$s")"; rc=$?
  expect_refusal "F1: $s refused as dependency-blocked" 12 "*REFUSED*dependency-blocked*" "$rc" "$out"
done
out="$(run_on "$B1" "$GOV_BIG" F1-7)"; rc=$?
[ "$rc" -eq 0 ] && ok "F1: all dependencies merged or released dispatches" || bad "F1-7 rc=$rc: $out"

# F2. unparsable in-flight rows must refuse, never be skipped
B2="$(mkboard f2 <<'EOF'
| C-1 | po | scripts/c1.sh | LOW | ready@2026-10-01T10:00Z | clean |
| D-6 | eng | scripts/d6.sh | building@2026-10-01T10:00Z | short row, 5 cells |
EOF
)"
out="$(run_on "$B2" "$GOV_BIG" C-1)"; rc=$?
expect_refusal "F2: short in-flight row refuses" 11 "*REFUSED*cannot be parsed*D-6*" "$rc" "$out"
B2B="$(mkboard f2b <<'EOF'
| C-1 | po | scripts/c1.sh | LOW | ready@2026-10-01T10:00Z | clean |
| D-7 | eng | scripts/d7.sh | LOW | building@2026-10-01T10:00Z (resumed) | status cell not exact |
EOF
)"
out="$(run_on "$B2B" "$GOV_BIG" C-1)"; rc=$?
expect_refusal "F2: inexact in-flight status cell refuses" 11 "*REFUSED*cannot be parsed*D-7*" "$rc" "$out"
B2C="$(mkboard f2c <<'EOF'
| C-1 | po | scripts/c1.sh | LOW | ready@2026-10-01T10:00Z | clean |
| D-8 | eng | scripts/d8.sh | LOW | review-blocked@2026-10-01T10:00Z | n | extra cell |
EOF
)"
out="$(run_on "$B2C" "$GOV_BIG" C-1)"; rc=$?
expect_refusal "F2: long review-blocked row refuses" 11 "*REFUSED*cannot be parsed*D-8*" "$rc" "$out"
B2D="$(mkboard f2d <<'EOF'
| C-1 | po | scripts/c1.sh | LOW | ready@2026-10-01T10:00Z | clean |
| D-9 | eng | scripts/d9.sh | LOW | released@2026-10-01T10:00Z | short | extra | cells but not in flight |
EOF
)"
out="$(run_on "$B2D" "$GOV_BIG" C-1)"; rc=$?
[ "$rc" -eq 0 ] && ok "F2: an unparsable row that is not in flight does not block" || bad "F2 control rc=$rc: $out"
B2E="$(mkboard f2e <<'EOF'
| C-1 | po | scripts/c1.sh | LOW | ready@2026-10-01T10:00Z | clean |
| C-1 | po | scripts/c1b.sh | LOW | ready@2026-10-01T10:00Z | duplicate id |
EOF
)"
out="$(run_on "$B2E" "$GOV_BIG" C-1)"; rc=$?
expect_refusal "F2: duplicate slice id refuses" 12 "*REFUSED*more than once*" "$rc" "$out"

# F3. overlap tokenisation
B3="$(mkboard f3 <<'EOF'
| I-1 | eng | VERSION | LOW | building@2026-10-01T10:00Z | x |
| I-2 | eng | Makefile, scripts/q2.sh | LOW | building@2026-10-01T10:00Z | x |
| I-3 | eng | scripts/{x,y}.sh | LOW | review@2026-10-01T10:00Z | x |
| I-4 | eng | scripts/lib | LOW | building@2026-10-01T10:00Z | x |
| I-5 | eng | scripts/p5.sh and scripts/q5.sh; scripts/r5.sh tests/t5.sh | LOW | building@2026-10-01T10:00Z | x |
| T-1 | po | VERSION | LOW | ready@2026-10-01T10:00Z | x |
| T-2 | po | Makefile | LOW | ready@2026-10-01T10:00Z | x |
| T-3 | po | scripts/y.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-4 | po | scripts/lib/a.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-5 | po | scripts/q5.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-6 | po | scripts/r5.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-7 | po | tests/t5.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-8 | po | scripts/{y,z}.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-9 | po | see docs/... | LOW | ready@2026-10-01T10:00Z | x |
| T-10 | po | scripts/{unbalanced.sh | LOW | ready@2026-10-01T10:00Z | x |
| T-11 | po | something here | LOW | ready@2026-10-01T10:00Z | x |
| T-12 | po | scripts/clear.sh | LOW | ready@2026-10-01T10:00Z | x |
EOF
)"
for pair in "T-1:I-1" "T-2:I-2" "T-3:I-3" "T-4:I-4" "T-5:I-5" "T-6:I-5" "T-7:I-5" "T-8:I-3"; do
  s="${pair%%:*}"; w="${pair##*:}"
  out="$(run_on "$B3" "$GOV_BIG" "$s")"; rc=$?
  expect_refusal "F3: $s overlaps $w" 11 "*REFUSED*overlap*$w*" "$rc" "$out"
done
for s in T-9 T-10 T-11; do
  out="$(run_on "$B3" "$GOV_BIG" "$s")"; rc=$?
  expect_refusal "F3: $s refused for an unusable file set" 12 "*REFUSED*file set unusable*" "$rc" "$out"
done
out="$(run_on "$B3" "$GOV_BIG" T-12)"; rc=$?
[ "$rc" -eq 0 ] && ok "F3: a clean disjoint slice still dispatches" || bad "T-12 rc=$rc: $out"
B3B="$(mkboard f3b <<'EOF'
| I-9 | eng | see docs/... | LOW | building@2026-10-01T10:00Z | x |
| T-12 | po | scripts/clear.sh | LOW | ready@2026-10-01T10:00Z | x |
EOF
)"
out="$(run_on "$B3B" "$GOV_BIG" T-12)"; rc=$?
expect_refusal "F3: an in-flight row with an elided file set refuses" 11 "*REFUSED*I-9*" "$rc" "$out"

# F4. the row to be written is verified; live checks run before any session
B4="$(mkboard f4 <<'EOF'
| P-1 | po | scripts/p1.sh | LOW | ready@2026-10-01T10:00Z | has an escaped \| pipe |
| P-2 | po | scripts/p2.sh | LOW | ready@2026-10-01T10:00Z | clean |
EOF
)"
printf '| P-3 | po | scripts/p3.sh | LOW | ready@2026-10-01T10:00Z | tab\there |\n' >> "$B4"
out="$(run_on "$B4" "$GOV_BIG" P-1)"; rc=$?
expect_refusal "F4: an escaped pipe in the row refuses" 17 "*REFUSED*escaped pipe*" "$rc" "$out"
out="$(run_on "$B4" "$GOV_BIG" P-3)"; rc=$?
expect_refusal "F4: a tab in the row refuses" 17 "*REFUSED*tab*" "$rc" "$out"

STUB2="$TMP/claude-stub2"
MARK="$TMP/stub-ran"
printf '#!/bin/sh\ncase "$1" in --help) echo "  --cloud [description]" ;; *) : > "%s" ;; esac\n' "$MARK" > "$STUB2"
chmod 755 "$STUB2"
live() { # leader-file args...
  local lf="$1"; shift
  CLOUD_DISPATCH_GOVERNOR_CMD="cat $GOV_BIG" CLAUDE_BIN="$STUB2" CLOUD_DISPATCH_LEADER_FILE="$lf" \
    "$SUT_BASH" "$TOOL" --board "$B4" --live "$@" 2>&1
}
B4_SUM="$(cksum < "$B4")"
out="$(live "$TMP/no-such-leader" P-2)"; rc=$?
expect_refusal "F4: --live without a leader lock refuses" 16 "*REFUSED*leader*" "$rc" "$out"
[ ! -e "$MARK" ] && ok "F4: no cloud command ran without a leader lock" || bad "F4: stub cloud command ran without a leader lock"
DEAD_PID="$("$SUT_BASH" -c 'echo $$')"
printf '%s 2026-10-03T00:00Z\n' "$DEAD_PID" > "$TMP/leader-dead"
out="$(live "$TMP/leader-dead" P-2)"; rc=$?
expect_refusal "F4: --live with a dead leader PID refuses" 16 "*REFUSED*leader*dead*" "$rc" "$out"
[ ! -e "$MARK" ] && ok "F4: no cloud command ran with a dead leader" || bad "F4: stub cloud command ran with a dead leader"
[ "$(cksum < "$B4")" = "$B4_SUM" ] && ok "F4: refused live leaves the board untouched" || bad "F4: board changed"

# F6. the dry-run governor call must not write the parse cache
grep -q -- '--json --no-cache' "$TOOL" && ok "F6: dry-run governor command passes --no-cache" || bad "F6: no --no-cache in the dry-run governor command"

# A1. governor timeout refuses
T0="$(date +%s)"
out="$(CLOUD_DISPATCH_GOVERNOR_CMD="sleep 30" CLOUD_DISPATCH_GOVERNOR_TIMEOUT=1 "$SUT_BASH" "$TOOL" --board "$BOARD" R-1 2>&1)"; rc=$?
T1="$(date +%s)"
expect_refusal "A1: a governor timeout refuses" 10 "*REFUSED*timed out*" "$rc" "$out"
[ $((T1 - T0)) -lt 15 ] && ok "A1: the hung governor was killed promptly" || bad "A1: took $((T1 - T0))s"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
