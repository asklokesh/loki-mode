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
if [ -n "${LOKI_UNIT_ID:-}" ]; then
    echo "head $id $(git rev-parse HEAD)" >> "$MOCK_DIR/events"
    echo "spec $id ${LOKI_UNIT_SPEC:-none} speed=${LOKI_SPEED:-unset}" >> "$MOCK_DIR/events"
    rd=".loki/runs/r1"; mkdir -p "$rd"
    if [ "$id" = "${MOCK_SYMLINK:-}" ]; then ln -s "$MOCK_DIR/secret.json" "$rd/receipt.json"; else echo "{\"unit\":\"$id\"}" > "$rd/receipt.json"; fi
    echo "{\"ev\":\"$id\"}" > "$rd/events.jsonl"
fi
sleep 1
rmdir "$MOCK_DIR/lock.$id"
if [ "$id" = "${MOCK_FAIL:-}" ]; then echo "Outcome:    FAILED"; echo "Reason:     boom"; echo "end $id fail" >> "$MOCK_DIR/events"; exit 1; fi
echo "end $id ok" >> "$MOCK_DIR/events"
echo "Outcome:    VERIFIED"; echo "PR:         none"
[ -n "${MOCK_COST:-}" ] && echo "Cost:       \$$MOCK_COST (claude, 10k tokens)"
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

reset_mock() { rm -rf "$REPO/.loki/groups"; rm -rf "$TMP"/lock.* "$TMP"/events "$TMP"/conc "$HOME/.loki"; MOCK_FAIL=""; export MOCK_FAIL; }
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

echo "== hostile and malformed DAGs are refused before anything launches"
refuse() { # name json expected-substring [extra args]
    local name="$1" json="$2" want="$3"; shift 3
    reset_mock
    printf '%s' "$json" > "$TMP/bad.json"
    out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/bad.json" "$@" 2>&1)"; rc=$?
    { [ $rc -eq 2 ] && grep -qF -- "$want" <<<"$out" && [ ! -e "$TMP/events" ]; } && pass "$name" || fail "$name" "rc=$rc out=$out"
}
refuse "option-like task text refused (S1)" '{"units":[{"id":"a","items":["--evil"]}]}' "would be read as an option"
refuse "leading-dot group refused (S2)" '{"units":[{"id":"a","items":["x"]}]}' "group must match" --group .hidden
refuse "dotdot group refused (S2)" '{"units":[{"id":"a","items":["x"]}]}' "group must match" --group a..b
refuse "edge naming unknown id refused (S3)" '{"units":[{"id":"a","items":["x"]}],"edges":[{"from":"a","to":"ghost"}]}' "unknown unit id"
refuse "unknown dep id refused (S3)" '{"units":[{"id":"a","items":["x"],"deps":["ghost"]}]}' "unknown or itself"
refuse "duplicate ids refused (S4)" '{"units":[{"id":"a","items":["x"]},{"id":"a","items":["y"]}]}' "unique"
refuse "self dependency refused (S4)" '{"units":[{"id":"a","items":["x"],"deps":["a"]}]}' "unknown or itself"
refuse "hostile id with newline refused (S4)" '{"units":[{"id":"a\nb","items":["x"]}]}' "is invalid"
refuse "hostile id with comma refused (S4)" '{"units":[{"id":"a,b","items":["x"]}]}' "is invalid"
# shellcheck disable=SC2016
refuse "hostile id with shell metachar refused (S4)" '{"units":[{"id":"$(touch pwned)","items":["x"]}]}' "is invalid"
refuse "non-object edge refused (S6)" '{"units":[{"id":"a","items":["x"]}],"edges":["a"]}' "edge must be an object"
big="$(python3 -c 'import json;print(json.dumps({"units":[{"id":"u%d"%i,"items":["x"]} for i in range(501)]}))')"
refuse "unit count over the cap refused (S6)" "$big" "the limit is"
long="$(python3 -c 'import json;n=400;print(json.dumps({"units":[{"id":"u%d"%i,"items":["x"],"deps":["u%d"%(i-1)] if i else []} for i in range(n)]}))')"
reset_mock; printf '%s' "$long" > "$TMP/long.json"
out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/long.json" --dry-run 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "400-deep chain validates without recursion (S6)" || fail "deep chain" "rc=$rc out=${out:0:200}"

echo "== summary header (S5)"
reset_mock
out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dag.json" --concurrency 3 2>&1)"
grep -q '^ITEM ' <<<"$out" && ! grep -q '^ISSUE ' <<<"$out" && pass "summary header says ITEM, not ISSUE" || fail "summary header" "$out"

echo "== receipts, resume, frozen spec (V118-02)"
GU="$REPO/.loki/groups/g1/group/units"
reset_mock
echo '{"secret":1}' > "$TMP/secret.json"
cat > "$TMP/dag2.json" <<DEOF
{"group":"g1","units":[
 {"id":"a","items":["do a"],"done":true},
 {"id":"b","items":["do b"],"deps":["a"],"spec":"$TMP/accept.json"},
 {"id":"c","items":["do c"]}]}
DEOF
out="$(MOCK_FAIL=c MOCK_SYMLINK=b $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dag2.json" --concurrency 2 2>&1)"
grep -q 'backlog: unit-g1-1 VERIFIED (resumed)' <<<"$out" && pass "done unit reports VERIFIED (resumed)" || fail "resumed line" "$out"
! grep -q '^start a ' "$TMP/events" && pass "launcher never called for the done unit" || fail "done launched" "$(cat "$TMP/events")"
grep -q '^start b ' "$TMP/events" && pass "dependent of a done unit still runs" || fail "dependent" "$(cat "$TMP/events")"
grep -q "^spec b $TMP/accept.json speed=1" "$TMP/events" && pass "spec unit gets LOKI_UNIT_SPEC and LOKI_SPEED=1" || fail "spec env" "$(cat "$TMP/events")"
grep -q '^spec c none speed=unset' "$TMP/events" && pass "unit without spec gets neither" || fail "no spec env" "$(cat "$TMP/events")"
grep -q '"unit":"c"' "$GU/c/receipt.json" 2>/dev/null && [ -f "$GU/c/events.jsonl" ] && pass "failed unit receipt and events harvested" || fail "fail harvest" "$(ls -R "$REPO/.loki" 2>&1 | head -20)"
[ ! -e "$GU/b/receipt.json" ] && pass "symlinked receipt is not copied" || fail "symlink copied" "$(ls -l "$GU/b")"
mode="$(stat -c %a "$GU/c" 2>/dev/null || stat -f %Lp "$GU/c")"
[ "$mode" = "700" ] && pass "harvest dir mode 0700" || fail "mode" "$mode"

echo "== unit base forwarded to the worktree (fix units start at the group tip)"
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m tip
TIP="$(git -C "$REPO" rev-parse HEAD)"; ORIGIN="$(git -C "$REPO" rev-parse origin/HEAD)"
cat > "$TMP/dagb.json" <<DEOF
{"group":"gb","units":[{"id":"fixu-1","items":["fix"],"base":"$TIP"}]}
DEOF
for ws in 1 0; do
    reset_mock
    LOKI_WORKSPACES=$ws $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagb.json" >/dev/null 2>&1
    grep -q "^head fixu-1 $TIP" "$TMP/events" && pass "LOKI_WORKSPACES=$ws: unit with base starts at the base, not origin/HEAD" || fail "base ws=$ws" "$(cat "$TMP/events" 2>&1) origin=$ORIGIN"
done
reset_mock
sed 's/,"base":"[0-9a-f]*"//' "$TMP/dagb.json" > "$TMP/dagn.json"
LOKI_WORKSPACES=1 $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagn.json" >/dev/null 2>&1
grep -q "^head fixu-1 $ORIGIN" "$TMP/events" && pass "control: no base under workspaces starts at origin/HEAD" || fail "control" "$(cat "$TMP/events" 2>&1)"

echo "== non-hex base: ref resolves to its SHA, unresolvable fails loudly"
git -C "$REPO" branch -f basebr "$TIP"
sed 's/"base":"[0-9a-f]*"/"base":"basebr"/' "$TMP/dagb.json" > "$TMP/dagr.json"
for ws in 1 0; do
    reset_mock
    LOKI_WORKSPACES=$ws $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagr.json" >/dev/null 2>&1
    grep -q "^head fixu-1 $TIP" "$TMP/events" && pass "LOKI_WORKSPACES=$ws: ref-name base resolved to its SHA" || fail "ref base ws=$ws" "$(cat "$TMP/events" 2>&1)"
done
for bad in nosuchref -x; do
    reset_mock
    sed "s/\"base\":\"[0-9a-f]*\"/\"base\":\"$bad\"/" "$TMP/dagb.json" > "$TMP/dagx.json"
    out="$($TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagx.json" 2>&1)"; rc=$?
    [ "$rc" -ne 0 ] && grep -q "base '$bad' is not a commit SHA" <<<"$out" && [ ! -s "$TMP/events" ] && pass "bad base '$bad' fails loudly, nothing launched" || fail "bad base $bad" "rc=$rc $out"
done

echo ""
echo "== group budget: LOKI_BUDGET_LIMIT bounds the sum of units"
cat > "$TMP/dagc.json" <<'DEOF'
{"group":"gc","units":[{"id":"x","items":["do x"]},{"id":"y","items":["do y"]},{"id":"z","items":["do z"]}],"edges":[]}
DEOF
reset_mock
out="$(MOCK_COST=0.80 LOKI_BUDGET_LIMIT=1 $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagc.json" --concurrency 1 2>&1)"; rc=$?
[ "$(grep -c '^start ' "$TMP/events")" = "2" ] && pass "third unit not launched once group total >= cap" || fail "group cap launches" "$(cat "$TMP/events") $out"
grep -q 'BUDGET_STOP: group budget' <<<"$out" && [ "$rc" -ne 0 ] && pass "pending unit reports group BUDGET_STOP" || fail "group stop line" "rc=$rc $out"
reset_mock
out="$(MOCK_COST=0.80 $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagc.json" --concurrency 1 2>&1)"
[ "$(grep -c '^start ' "$TMP/events")" = "3" ] && pass "no cap set: all units run" || fail "no cap" "$out"

echo "== skipped dependency dirs are named in the unit task"
git -C "$REPO" worktree prune
printf '.venv/\n' > "$REPO/.gitignore"; git -C "$REPO" add .gitignore; git -C "$REPO" -c user.name=t -c user.email=t@t commit -q -m ign
mkdir -p "$REPO/.venv/bin"; ln -s /usr/bin/true "$REPO/.venv/bin/python"
cat > "$TMP/dagv.json" <<'DEOF'
{"group":"gv","units":[{"id":"v1","items":["do v"]}]}
DEOF
reset_mock
LOKI_WORKSPACES=1 $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagv.json" >/dev/null 2>&1
flat="$(tr '\n' ' ' < "$TMP/events")"
case "$flat" in *"args=do v  These dependency directories were not copied into this worktree: .venv. Install them"*) pass "skipped .venv named with an install instruction";; *) fail "skipped .venv named" "$flat";; esac
rm -rf "$REPO/.venv"
reset_mock
LOKI_WORKSPACES=1 $TO bash "$LOKI" backlog acme/widgets --dag "$TMP/dagv.json" >/dev/null 2>&1
[ "$(grep '^start v1 ' "$TMP/events")" = "start v1 loki/unit-gv-1 args=do v --no-pr" ] && pass "nothing skipped: task text byte-identical" || fail "no-skip control" "$(cat "$TMP/events" 2>&1)"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
