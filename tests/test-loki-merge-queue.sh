#!/usr/bin/env bash
# loki merge: serial queue, green-only, rebase-next, --dry-run. Uses a stub gh.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/repo"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "pr checks") [ "$3" = "12" ] && exit 1; [ "$3" = "feat-red" ] && exit 1
               [ "$3" = "21" ] && [ ! -f "$STUB_WORK/repaired" ] && exit 1
               [ "$3" = "22" ] && exit 1
               [ "$3" = "feat-pend" ] && exit 8; [ "$3" = "feat-auth" ] && exit 4
               exit 0 ;;
  "pr view") case "$*" in *headRefName*) echo feat-w ;; *) [ "$3" = "feat-draft" ] && echo true || echo false ;; esac; exit 0 ;;
  "pr merge") [ "$3" = "feat-mfail" ] && exit 1; exit 0 ;;
  "run list") echo 99; exit 0 ;;
  "run view") echo "FAILED: boom in test_x"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/gh"
export STUB_WORK="$WORK" STUB_LOG="$WORK/calls.log"; : > "$STUB_LOG"
export PATH="$WORK/bin:$PATH" LOKI_MERGE_POLL_S=0
cd "$WORK/repo" || exit 1

bash "$LOKI" merge add 11 12 13 >/dev/null
[ "$(wc -l < .loki/merge-queue | tr -d ' ')" = "3" ] && ok "add queues three PRs" || bad "add"

OUT="$(bash "$LOKI" merge run --dry-run)"
echo "$OUT" | grep -q "#12: checks not green, would skip" && ok "dry-run flags red PR" || bad "dry-run red: $OUT"
grep -q "pr merge\|update-branch" "$STUB_LOG" && bad "dry-run mutated" || ok "dry-run makes no merge or rebase call"

OUT="$(bash "$LOKI" merge run)"; RC=$?
grep -q "^pr merge 11 " "$STUB_LOG" && ok "green PR 11 merged" || bad "11 not merged: $OUT"
grep -q "^pr merge 12" "$STUB_LOG" && bad "red PR 12 merged" || ok "red PR 12 never merged"
grep -q "^pr update-branch 12 --rebase" "$STUB_LOG" && ok "next PR rebased after merge" || bad "no rebase"
grep -q "^pr merge 13 " "$STUB_LOG" && ok "PR 13 merged after rebase" || bad "13 not merged"
[ "$RC" -ne 0 ] && [ "$(cat .loki/merge-queue)" = "12" ] && ok "red PR left in queue, nonzero exit" || bad "queue/rc: rc=$RC"

# Gated single-PR merge (the --ship path): checks, draft and verdict all block.
mkdir -p .loki/proofs/p1 .loki/state
echo p1 > .loki/state/last-proof-id.txt
printf '{"honesty":{"headline":"VERIFIED"}}' > .loki/proofs/p1/proof.json
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-red --require-verified --delete-branch 2>&1)"; RC=$?
grep -q "^pr merge feat-red" "$STUB_LOG" && bad "red-check ship PR merged" || ok "ship: failing checks never merge"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: checks" && ok "ship: message names the checks gate" || bad "checks msg rc=$RC: $OUT"
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-draft --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-draft" "$STUB_LOG" && bad "draft PR merged" || ok "ship: draft PR never merges"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: draft" && ok "ship: message names the draft gate" || bad "draft msg: $OUT"
printf '{"honesty":{"headline":"PARTIAL"}}' > .loki/proofs/p1/proof.json
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-ok --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-ok" "$STUB_LOG" && bad "non-VERIFIED run merged" || ok "ship: non-VERIFIED verdict never merges"
echo "$OUT" | grep -q "gate: verdict" && ok "ship: message names the verdict gate" || bad "verdict msg: $OUT"
printf '{"honesty":{"headline":"VERIFIED"}}' > .loki/proofs/p1/proof.json
: > "$STUB_LOG"
bash "$LOKI" merge pr feat-ok --require-verified --delete-branch >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ] && grep -q "^pr merge feat-ok --squash --delete-branch" "$STUB_LOG" && ok "ship: green VERIFIED PR merges" || bad "green ship rc=$RC: $(cat "$STUB_LOG")"
grep -q 'gh pr merge "$branch_current"' "$LOKI" && bad "inline ungated gh pr merge still present" || ok "no inline ungated gh pr merge of the branch"

# FV-pr-loop-4: the gate's own result lands in pr.json for the SAME PR only.
prj() { jq -r "$1" .loki/state/pr.json; }
seed() { printf '{"state":"%s","url":"https://github.com/o/r/pull/%s","branch":"%s","merge":{"outcome":"waiting","gate":"human_review","checks":"not recorded"}}' "$3" "$2" "$1" > .loki/state/pr.json; }
seed feat-red 7 created
bash "$LOKI" merge pr feat-red >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:checks" ] && [ "$(prj .merge.gate)" = "checks" ] && [ "$(prj .merge.checks)" = "failing" ] && [ "$(prj .state)" = "created" ] && ok "pr.json: red checks record blocked:checks/failing" || bad "pr.json red: $(cat .loki/state/pr.json)"
bash "$LOKI" merge pr feat-ok >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:checks" ] && ok "pr.json: a different PR leaves the record untouched" || bad "pr.json mismatch: $(cat .loki/state/pr.json)"
seed feat-draft 8 created
bash "$LOKI" merge pr feat-draft >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:draft" ] && ok "pr.json: draft records blocked:draft" || bad "pr.json draft: $(cat .loki/state/pr.json)"
seed feat-ok 9 created
bash "$LOKI" merge pr 9 >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "merged" ] && ok "pr.json: PR matched by url number, merged recorded" || bad "pr.json merged: $(cat .loki/state/pr.json)"
seed feat-pend 10 created
bash "$LOKI" merge pr feat-pend >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "waiting" ] && [ "$(prj .merge.gate)" = "checks" ] && [ "$(prj .merge.checks)" = "pending" ] && ok "pr.json: rc=8 records waiting/pending" || bad "pr.json waiting: $(cat .loki/state/pr.json)"
seed feat-auth 11 created
bash "$LOKI" merge pr feat-auth >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:checks" ] && [ "$(prj .merge.checks)" = "unknown" ] && ok "pr.json: non-check rc records checks unknown" || bad "pr.json unknown: $(cat .loki/state/pr.json)"
seed feat-mfail 12 created
bash "$LOKI" merge pr feat-mfail >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:merge" ] && [ "$(prj .merge.gate)" = "merge" ] && ok "pr.json: gh merge failure records blocked:merge" || bad "pr.json merge: $(cat .loki/state/pr.json)"
printf '{"honesty":{"headline":"PARTIAL"}}' > .loki/proofs/p1/proof.json
seed feat-ok 13 created
bash "$LOKI" merge pr feat-ok --require-verified >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:verdict" ] && [ "$(prj .merge.gate)" = "verdict" ] && ok "pr.json: verdict gate records blocked:verdict" || bad "pr.json verdict: $(cat .loki/state/pr.json)"
printf '{"honesty":{"headline":"VERIFIED"}}' > .loki/proofs/p1/proof.json
seed feat-ok 14 prepared
BEFORE="$(cat .loki/state/pr.json)"
bash "$LOKI" merge pr feat-ok >/dev/null 2>&1
[ "$(cat .loki/state/pr.json)" = "$BEFORE" ] && ok "pr.json: non-created state is a no-op" || bad "pr.json prepared stamped: $(cat .loki/state/pr.json)"
seed feat-ok 15 created
chmod 644 .loki/state/pr.json
bash "$LOKI" merge pr feat-ok >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "merged" ] && [ "$(stat -c %a .loki/state/pr.json 2>/dev/null || stat -f %Lp .loki/state/pr.json)" = "644" ] && ok "pr.json: file mode preserved" || bad "pr.json mode: $(ls -l .loki/state/pr.json)"
# A PATH holding every system tool except gh (runners ship a real gh in /usr/bin)
mkdir -p "$WORK/jqonly"; ln -sf "$(command -v jq)" "$WORK/jqonly/jq"
for d in /usr/bin /bin; do for f in "$d"/*; do b="${f##*/}"; [ "$b" = gh ] || [ -e "$WORK/jqonly/$b" ] || ln -s "$f" "$WORK/jqonly/$b"; done; done
seed feat-ok 16 created
PATH="$WORK/jqonly" bash "$LOKI" merge pr feat-ok >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:gh" ] && ok "pr.json: missing gh records blocked:gh" || bad "pr.json gh: $(cat .loki/state/pr.json)"
seed feat-ok 17 created
bash "$LOKI" merge pr https://github.com/o/r/pull/17 >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "merged" ] && ok "pr.json: URL arg matches by number" || bad "pr.json url arg: $(cat .loki/state/pr.json)"
seed feat-ok 18 created
bash "$LOKI" merge pr '#18' >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "merged" ] && ok "pr.json: #N arg matches by number" || bad "pr.json hash arg: $(cat .loki/state/pr.json)"
seed feat-ok 19 created
bash "$LOKI" merge pr . >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "waiting" ] && ok "pr.json: a '.' arg is not a regex wildcard" || bad "pr.json dot: $(cat .loki/state/pr.json)"
rm -f .loki/state/pr.json
bash "$LOKI" merge pr feat-ok >/dev/null 2>&1
[ ! -e .loki/state/pr.json ] && ok "pr.json never invented when absent" || bad "pr.json invented"

# CI repair loop: loki merge watch.
git init -q -b feat-w . && git config user.email t@t && git config user.name t
git commit -q --allow-empty -m base
git init -q --bare "$WORK/remote.git" && git remote add origin "$WORK/remote.git"
git push -q origin feat-w
cat > "$WORK/repair.sh" <<'REP'
#!/usr/bin/env bash
echo "$1" >> "$STUB_WORK/repair.log"
grep -q "boom in test_x" "$1" || exit 3
touch "$STUB_WORK/repaired"; echo fix > fix.txt; git add fix.txt; git commit -q -m fix
REP
export LOKI_PR_REPAIR_CMD="bash $WORK/repair.sh"
: > "$STUB_LOG"; rm -f "$WORK/repair.log"
OUT="$(bash "$LOKI" merge watch 21 2>&1)"; RC=$?
[ "$(wc -l < "$WORK/repair.log" | tr -d ' ')" = "1" ] && ok "watch: repair invoked once with failed log" || bad "repair count: $OUT"
[ "$(git rev-parse HEAD)" = "$(git --git-dir="$WORK/remote.git" rev-parse feat-w)" ] && ok "watch: repair commit pushed" || bad "not pushed"
[ "$RC" -eq 0 ] && grep -q "^pr merge 21 --squash" "$STUB_LOG" && ok "watch: merged after green" || bad "watch merge rc=$RC: $OUT"
: > "$STUB_LOG"; rm -f "$WORK/repair.log" "$WORK/repaired"
OUT="$(LOKI_PR_REPAIR_MAX=2 bash "$LOKI" merge watch 22 2>&1)"; RC=$?
[ "$(wc -l < "$WORK/repair.log" | tr -d ' ')" = "2" ] && ok "watch: bounded to LOKI_PR_REPAIR_MAX attempts" || bad "attempts: $(cat "$WORK/repair.log")"
grep -q "^pr merge 22" "$STUB_LOG" && bad "exhausted PR merged" || ok "watch: exhausted attempts never merge"
grep -q "^pr ready 22 --undo" "$STUB_LOG" && [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: checks" && ok "watch: left draft with evidence" || bad "exhausted: rc=$RC $OUT"
printf '{"state":"created","url":"https://github.com/o/r/pull/22","branch":"feat-w"}' > .loki/state/pr.json
LOKI_PR_REPAIR_MAX=1 bash "$LOKI" merge watch 22 >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:checks" ] && echo "$(prj .merge.checks)" | grep -q "repair attempt" && ok "pr.json: exhausted watch records blocked:checks" || bad "pr.json watch: $(cat .loki/state/pr.json)"
grep -q '^  /merge ' "$SCRIPT_DIR/../autonomy/lib/chat.sh" && ok "chat: /merge verb documented" || bad "chat /merge missing"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
