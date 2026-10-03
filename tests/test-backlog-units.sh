#!/usr/bin/env bash
# Test: `loki backlog --dag` unit runner (D61 slice 10).
#
# The launcher is a stub (LOKI_BACKLOG_LAUNCHER) that records start and end
# events and its own concurrency. Asserts: max concurrency is never exceeded
# with units and issues sharing one slot pool, a dependent unit starts only
# after every parent finished and passed, a failed parent skips its dependents,
# units run on branches loki/unit-<group>-<n>, and a cyclic DAG is refused.

# shellcheck disable=SC2015
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
export LOKI_NO_BROWSER=1

TO=""
if command -v timeout >/dev/null 2>&1; then TO="timeout -k 10 120"
elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout -k 10 120"; fi

PASS=0; FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-backlog-units.XXXXXXXX")"
trap 'rm -rf "$TMP"' EXIT
TMP="$(cd "$TMP" && pwd -P)"
export HOME="$TMP/home"; mkdir -p "$HOME"
export MOCK_DIR="$TMP"

# Stub launcher. Unit runs carry LOKI_UNIT_ID; issue runs get owner/repo#N.
cat > "$TMP/launcher.sh" <<'LEOF'
#!/usr/bin/env bash
id="${LOKI_UNIT_ID:-issue-${1##*#}}"
echo "start $id $(git branch --show-current) args=$*" >> "$MOCK_DIR/events"
mkdir "$MOCK_DIR/lock.$id"
ls -d "$MOCK_DIR"/lock.* | wc -l | tr -d ' ' >> "$MOCK_DIR/conc"
sleep 1
rmdir "$MOCK_DIR/lock.$id"
if [ "$id" = "${MOCK_FAIL:-}" ]; then echo "Outcome:    FAILED"; echo "Reason:     boom"; echo "end $id fail" >> "$MOCK_DIR/events"; exit 1; fi
echo "end $id ok" >> "$MOCK_DIR/events"
echo "Outcome:    VERIFIED"; echo "PR:         none"
exit 0
LEOF
chmod +x "$TMP/launcher.sh"
export LOKI_BACKLOG_LAUNCHER="$TMP/launcher.sh"

REPO="$TMP/repo"
git init -q "$REPO"
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$REPO" remote add origin https://github.com/acme/widgets.git
cd "$REPO" || exit 1

# a -> b -> d, c -> d, e independent.
cat > "$TMP/dag.json" <<'DEOF'
{"group":"g1","units":[
 {"id":"a","items":["do a"],"writeSet":["a.ts"]},
 {"id":"b","items":["do b"],"writeSet":["b.ts"]},
 {"id":"c","items":["do c"],"writeSet":["c.ts"]},
 {"id":"d","items":["do d"],"writeSet":["d.ts"]},
 {"id":"e","items":["do e"],"writeSet":["e.ts"]}],
 "sharedFiles":[],
 "edges":[{"from":"a","to":"b","via":"x"},{"from":"b","to":"d","via":"y"},{"from":"c","to":"d","via":"z"}]}
DEOF

reset_mock() { rm -rf "$TMP"/lock.* "$TMP"/events "$TMP"/conc "$HOME/.loki"; MOCK_FAIL=""; export MOCK_FAIL; }
# Line number of the first event matching $1 in the events file.
ev() { grep -n "$1" "$TMP/events" | head -1 | cut -d: -f1; }
maxconc() { sort -n "$TMP/conc" | tail -1; }

echo "== units with a shared slot pool"
reset_mock
out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dag.json" --issues 1,2 --concurrency 2 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "dag plus issues exits 0" || fail "dag plus issues" "rc=$rc out=$out"
mc="$(maxconc)"
[ "${mc:-0}" -eq 2 ] && pass "concurrency reaches but never exceeds 2 across units and issues" || fail "concurrency" "max=$mc"
[ "$(grep -c '^start' "$TMP/events")" = "7" ] && pass "all 5 units and 2 issues ran" || fail "run count" "$(cat "$TMP/events")"
[ "$(ev 'start b ')" -gt "$(ev 'end a ')" ] && pass "b starts after parent a ended ok" || fail "b ordering" "$(cat "$TMP/events")"
[ "$(ev 'start d ')" -gt "$(ev 'end b ')" ] && [ "$(ev 'start d ')" -gt "$(ev 'end c ')" ] && pass "d starts after both parents b and c" || fail "d ordering" "$(cat "$TMP/events")"
grep -q "^start a loki/unit-g1-1 args=do a --no-pr" "$TMP/events" && pass "unit a on branch loki/unit-g1-1 with --no-pr" || fail "unit a branch" "$(cat "$TMP/events")"
grep -q "^start d loki/unit-g1-4 " "$TMP/events" && pass "unit d on branch loki/unit-g1-4" || fail "unit d branch" "$(cat "$TMP/events")"
grep -q "^start issue-1 loki/backlog-1 " "$TMP/events" && pass "issue mode still uses loki/backlog-N" || fail "issue branch" "$(cat "$TMP/events")"
git -C "$REPO" rev-parse --verify -q loki/unit-g1-1 >/dev/null && pass "passing unit branch is kept for the integrator" || fail "unit branch kept" "missing"
git -C "$REPO" rev-parse --verify -q loki/backlog-1 >/dev/null && fail "issue branch cleanup" "loki/backlog-1 survived" || pass "passing issue branch is still removed"

echo "== failed parent skips dependents"
reset_mock
export MOCK_FAIL=b
out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dag.json" --concurrency 3 2>&1)"; rc=$?
[ $rc -eq 1 ] && pass "failed unit exits 1" || fail "failed unit rc" "rc=$rc"
grep -q "unit-g1-4 SKIPPED: dependency unit-g1-2 did not pass" <<<"$out" && pass "d is SKIPPED when parent b failed" || fail "skip message" "$out"
grep -q "^start d " "$TMP/events" && fail "d must not start" "d started" || pass "d never launched"
grep -q "^start c " "$TMP/events" && pass "independent unit c still ran" || fail "c ran" "$(cat "$TMP/events")"

echo "== validation and dry run"
reset_mock
cat > "$TMP/cycle.json" <<'DEOF'
{"units":[{"id":"x","deps":["y"]},{"id":"y","deps":["x"]}]}
DEOF
out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/cycle.json" 2>&1)"; rc=$?
{ [ $rc -eq 2 ] && grep -q "dependency cycle" <<<"$out"; } && pass "cyclic DAG refused with rc 2" || fail "cycle" "rc=$rc out=$out"
out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dag.json" --dry-run 2>&1)"; rc=$?
{ [ $rc -eq 0 ] && grep -q "would run unit g1-4 (d) after: b, c" <<<"$out" && [ ! -e "$TMP/events" ]; } && pass "dry run lists units and launches nothing" || fail "dry run" "rc=$rc out=$out"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
