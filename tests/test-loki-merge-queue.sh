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
  "pr view") case "$*" in *"--json files"*) cat "$STUB_WORK/files-$3" 2>/dev/null || exit 1; exit 0 ;; *headRefOid*) [ "$3" = "feat-nohead" ] && exit 1
                if [ "$3" = "feat-race" ]; then if [ -f "$STUB_WORK/race1" ]; then echo "$STUB_HEAD2"; else touch "$STUB_WORK/race1"; echo "$STUB_HEAD"; fi; exit 0; fi; if [ "$3" = "feat-moved" ]; then echo "$STUB_HEAD2"; else echo "$STUB_HEAD"; fi; exit 0 ;; *headRefName*) echo feat-w ;; *) [ "$3" = "feat-draft" ] && echo true || echo false ;; esac; exit 0 ;;
  "pr merge") [ "$3" = "feat-mfail" ] && exit 1; [ "$3" = "feat-race" ] && exit 1; exit 0 ;;
  "run list") echo 99; exit 0 ;;
  "run view") echo "FAILED: boom in test_x"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/gh"
export STUB_HEAD=1111111111111111111111111111111111111111 STUB_HEAD2=2222222222222222222222222222222222222222
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
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD" > .loki/proofs/p1/proof.json
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-red --require-verified --delete-branch 2>&1)"; RC=$?
grep -q "^pr merge feat-red" "$STUB_LOG" && bad "red-check ship PR merged" || ok "ship: failing checks never merge"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: checks" && ok "ship: message names the checks gate" || bad "checks msg rc=$RC: $OUT"
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-draft --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-draft" "$STUB_LOG" && bad "draft PR merged" || ok "ship: draft PR never merges"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: draft" && ok "ship: message names the draft gate" || bad "draft msg: $OUT"
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"PARTIAL"}}' "$STUB_HEAD" > .loki/proofs/p1/proof.json
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-ok --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-ok" "$STUB_LOG" && bad "non-VERIFIED run merged" || ok "ship: non-VERIFIED verdict never merges"
echo "$OUT" | grep -q "gate: verdict" && ok "ship: message names the verdict gate" || bad "verdict msg: $OUT"
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD" > .loki/proofs/p1/proof.json
: > "$STUB_LOG"
bash "$LOKI" merge pr feat-ok --require-verified --delete-branch >/dev/null 2>&1; RC=$?
[ "$RC" -eq 0 ] && grep -q "^pr merge feat-ok --squash --delete-branch" "$STUB_LOG" && ok "ship: green VERIFIED PR merges" || bad "green ship rc=$RC: $(cat "$STUB_LOG")"
grep -q "^pr merge feat-ok --squash --delete-branch --match-head-commit $STUB_HEAD\$" "$STUB_LOG" && ok "ship: merge pinned with --match-head-commit <proof head>" || bad "merge not head-pinned: $(cat "$STUB_LOG")"
# Stale proof: the PR head moved after the proof, so the VERIFIED proof is for another commit.
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-moved --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-moved" "$STUB_LOG" && bad "stale-proof PR merged" || ok "ship: stale proof (head moved) never merges"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: head" && ok "ship: message names the head gate" || bad "head msg rc=$RC: $OUT"
# A matching proof is found by head even when last-proof-id points at a stale one.
mkdir -p .loki/proofs/p2
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD2" > .loki/proofs/p2/proof.json
: > "$STUB_LOG"
bash "$LOKI" merge pr feat-moved --require-verified >/dev/null 2>&1
grep -q "^pr merge feat-moved --squash --match-head-commit $STUB_HEAD2\$" "$STUB_LOG" && ok "ship: proof resolved by PR head, not last-proof-id" || bad "head-resolved proof: $(cat "$STUB_LOG")"
rm -rf .loki/proofs/p2
# Older VERIFIED must not override a newer NOT_PROVEN for the same head (disagreement refuses).
mkdir -p .loki/proofs/p3 .loki/proofs/p2
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"NOT_PROVEN"}}' "$STUB_HEAD2" > .loki/proofs/p3/proof.json
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD2" > .loki/proofs/p2/proof.json
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-moved --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-moved" "$STUB_LOG" && bad "conflicting proofs merged" || ok "ship: VERIFIED + NOT_PROVEN for one head never merges"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: verdict" && ok "ship: disagreement names the verdict gate" || bad "disagree msg: $OUT"
rm -r .loki/proofs/p2 .loki/proofs/p3
# A dirty-tree proof for the head does not count.
mkdir -p .loki/proofs/p4
printf '{"facts":{"git":{"head_sha":"%s","dirty":true}},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD2" > .loki/proofs/p4/proof.json
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-moved --require-verified 2>&1)"; RC=$?
grep -q "^pr merge feat-moved" "$STUB_LOG" && bad "dirty proof merged" || ok "ship: dirty-tree proof never merges"
echo "$OUT" | grep -q "gate: head" && ok "ship: dirty proof names the head gate" || bad "dirty msg: $OUT"
echo "$OUT" | grep -q "dirty (1), dirty-unknown (0)" && ! echo "$OUT" | grep -q "unknown dirty state" && ok "ship: explicit dirty proof counted as dirty, not unknown" || bad "dirty count msg: $OUT"
rm -r .loki/proofs/p4
# P12-03b: a proof with dirty missing or null counts as dirty (fail closed).
for _variant in 'missing:{"head_sha":"%s"}' 'null:{"head_sha":"%s","dirty":null}'; do
  _vn="${_variant%%:*}"; _vj="${_variant#*:}"
  mkdir -p .loki/proofs/p5
  # shellcheck disable=SC2059
  printf '{"facts":{"git":'"$_vj"'},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD2" > .loki/proofs/p5/proof.json
  : > "$STUB_LOG"
  OUT="$(bash "$LOKI" merge pr feat-moved --require-verified 2>&1)"; RC=$?
  grep -q "^pr merge feat-moved" "$STUB_LOG" && bad "dirty-$_vn proof merged" || ok "ship: proof with dirty $_vn never merges"
  echo "$OUT" | grep -q "gate: head" && ok "ship: dirty $_vn names the head gate" || bad "dirty $_vn msg: $OUT"
  echo "$OUT" | grep -q "dirty-unknown (1)" && echo "$OUT" | grep -q "re-run 'loki start" && echo "$OUT" | grep -q "predates the dirty flag" && ok "ship: dirty $_vn names unknown state and next step" || bad "dirty $_vn unknown msg: $OUT"
  rm -r .loki/proofs/p5
done
# P12-03b: the shared proof writer marks an untracked-only tree dirty, even when
# git config hides untracked files from status.
GD_REPO="$WORK/gdrepo"; mkdir -p "$GD_REPO"
git -C "$GD_REPO" init -q
git -C "$GD_REPO" config user.email t@t
git -C "$GD_REPO" config user.name t
git -C "$GD_REPO" config status.showUntrackedFiles no
echo a > "$GD_REPO/a"
git -C "$GD_REPO" add a
git -C "$GD_REPO" commit -qm init
gd() { python3 -I -c 'import importlib.util,sys;s=importlib.util.spec_from_file_location("pv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.git_dirty(sys.argv[2]))' "$SCRIPT_DIR/../autonomy/lib/proof-verify.py" "$GD_REPO"; }
[ "$(gd)" = "False" ] && ok "writer: clean tree is not dirty" || bad "writer clean: $(gd)"
echo x > "$GD_REPO/untracked.txt"
[ "$(gd)" = "True" ] && ok "writer: untracked-only tree is dirty" || bad "writer untracked: $(gd)"
rm "$GD_REPO/untracked.txt"
mkdir -p "$GD_REPO/.loki"; echo y > "$GD_REPO/.loki/x"
[ "$(gd)" = "False" ] && ok "writer: .loki/ untracked stays clean" || bad "writer .loki: $(gd)"
# P12-03b: a rename out of .loki/ must not hide the dirty destination.
echo s > "$GD_REPO/.loki/src.js"
git -C "$GD_REPO" add -f .loki/src.js
git -C "$GD_REPO" -c user.name=t -c user.email=t@t commit -qm loki-src
[ "$(gd)" = "False" ] && ok "writer: committed .loki/ file is clean" || bad "writer loki commit: $(gd)"
git -C "$GD_REPO" mv .loki/src.js src.js
[ "$(gd)" = "True" ] && ok "writer: rename out of .loki/ is dirty" || bad "writer rename: $(gd)"
git -C "$GD_REPO" mv src.js app.js
echo edit >> "$GD_REPO/app.js"
[ "$(gd)" = "True" ] && ok "writer: rename plus edit is dirty" || bad "writer rename+edit: $(gd)"
git -C "$GD_REPO" reset -q --hard
git -C "$GD_REPO" clean -fdq -e .loki
# P12-03b: a committed ignore=all submodule setting must not hide a modified submodule.
SUB_REPO="$WORK/subrepo"; mkdir -p "$SUB_REPO"
git -C "$SUB_REPO" init -q
echo 1 > "$SUB_REPO/f"
git -C "$SUB_REPO" add f
git -C "$SUB_REPO" -c user.name=t -c user.email=t@t commit -qm sub
git -C "$GD_REPO" -c protocol.file.allow=always submodule add -q "$SUB_REPO" sub >/dev/null 2>&1
git -C "$GD_REPO" config -f .gitmodules submodule.sub.ignore all
git -C "$GD_REPO" add .gitmodules sub
git -C "$GD_REPO" -c user.name=t -c user.email=t@t commit -qm addsub
[ "$(gd)" = "False" ] && ok "writer: clean submodule tree is clean" || bad "writer sub clean: $(gd)"
echo 2 > "$GD_REPO/sub/f"
[ "$(gd)" = "True" ] && ok "writer: modified submodule is dirty despite ignore=all" || bad "writer sub dirty: $(gd)"
# P12-03c: skip-worktree and assume-unchanged flags must not hide a modified file.
echo 1 > "$GD_REPO/sub/f"
[ "$(gd)" = "False" ] && ok "writer: restored submodule is clean again" || bad "writer sub restore: $(gd)"
for _flag in skip-worktree assume-unchanged; do
  git -C "$GD_REPO" update-index "--$_flag" a
  echo "edit-$_flag" >> "$GD_REPO/a"
  [ "$(gd 2>/dev/null)" = "True" ] && ok "writer: $_flag-hidden edit is dirty" || bad "writer $_flag: $(gd 2>&1)"
  gd 2>&1 >/dev/null | grep -q "a is flagged $_flag.*update-index --no-$_flag -- a" && ok "writer: $_flag reason names path and fix" || bad "writer $_flag reason: $(gd 2>&1)"
  git -C "$GD_REPO" update-index "--no-$_flag" a
  git -C "$GD_REPO" checkout -q -- a
  [ "$(gd)" = "False" ] && ok "writer: cleared $_flag is clean" || bad "writer $_flag cleared: $(gd)"
done
# P12-03c: a flagged but unmodified file, and a sparse-excluded (absent) skip-worktree file, are clean.
for _flag in skip-worktree assume-unchanged; do
  git -C "$GD_REPO" update-index "--$_flag" a
  [ "$(gd)" = "False" ] && ok "writer: $_flag on an unmodified file is clean" || bad "writer $_flag unmodified: $(gd)"
  git -C "$GD_REPO" update-index "--no-$_flag" a
done
git -C "$GD_REPO" update-index --skip-worktree a
rm "$GD_REPO/a"
[ "$(gd 2>/dev/null)" = "True" ] && ok "writer: skip-worktree file deleted without sparse checkout is dirty" || bad "writer skip deleted: $(gd 2>&1)"
git -C "$GD_REPO" update-index --no-skip-worktree a
git -C "$GD_REPO" checkout -q -- a
# Real sparse checkout: an excluded file is absent and flagged skip-worktree by git itself; clean.
SP_REPO="$WORK/sprepo"; mkdir -p "$SP_REPO/keep" "$SP_REPO/other"
git -C "$SP_REPO" init -q
echo 1 > "$SP_REPO/keep/f"; echo 2 > "$SP_REPO/other/g"
git -C "$SP_REPO" add keep other
git -C "$SP_REPO" -c user.name=t -c user.email=t@t commit -qm sp
git -C "$SP_REPO" sparse-checkout set --no-cone /keep/ >/dev/null 2>&1
[ ! -e "$SP_REPO/other/g" ] && ok "sparse: excluded file absent" || bad "sparse setup: other/g present"
SPV="$(python3 -I -c 'import importlib.util,sys;s=importlib.util.spec_from_file_location("pv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.git_dirty(sys.argv[2]))' "$SCRIPT_DIR/../autonomy/lib/proof-verify.py" "$SP_REPO")"
[ "$SPV" = "False" ] && ok "writer: real sparse-checkout repo is clean" || bad "writer real sparse: $SPV"
# P12-03d: under sparse checkout only an OUT-of-cone missing skip-worktree path is clean.
spd() { python3 -I -c 'import importlib.util,sys;s=importlib.util.spec_from_file_location("pv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.git_dirty(sys.argv[2]))' "$SCRIPT_DIR/../autonomy/lib/proof-verify.py" "$SP_REPO" 2>/dev/null; }
git -C "$SP_REPO" update-index --skip-worktree keep/f
rm "$SP_REPO/keep/f"
[ "$(spd)" = "True" ] && ok "sparse non-cone: in-cone skip-worktree path deleted is dirty" || bad "sparse in-cone deleted: $(spd)"
git -C "$SP_REPO" update-index --no-skip-worktree keep/f
git -C "$SP_REPO" checkout -q -- keep/f
[ "$(spd)" = "False" ] && ok "sparse non-cone: restored in-cone path is clean" || bad "sparse in-cone restored: $(spd)"
git -C "$SP_REPO" ls-files -v | grep -q '^S other/g$' && [ ! -e "$SP_REPO/other/g" ] && [ "$(spd)" = "False" ] && ok "sparse non-cone: out-of-cone skip-worktree path absent is clean" || bad "sparse out-of-cone: $(spd)"
git -C "$SP_REPO" sparse-checkout set --cone keep >/dev/null 2>&1
git -C "$SP_REPO" update-index --skip-worktree keep/f
rm "$SP_REPO/keep/f"
[ "$(spd)" = "True" ] && ok "sparse cone: in-cone skip-worktree path deleted is dirty" || bad "sparse cone in-cone deleted: $(spd)"
git -C "$SP_REPO" update-index --no-skip-worktree keep/f
git -C "$SP_REPO" checkout -q -- keep/f
[ "$(spd)" = "False" ] && ok "sparse cone: out-of-cone paths absent is clean" || bad "sparse cone out-of-cone: $(spd)"
# Fail closed: an unreadable cone makes the missing flagged path dirty.
git -C "$SP_REPO" update-index --skip-worktree keep/f
rm "$SP_REPO/keep/f"
mv "$SP_REPO/.git/info/sparse-checkout" "$SP_REPO/.git/info/sparse-checkout.bak"
[ "$(spd)" = "True" ] && ok "sparse: undeterminable cone fails closed (dirty)" || bad "sparse fail-closed: $(spd)"
mv "$SP_REPO/.git/info/sparse-checkout.bak" "$SP_REPO/.git/info/sparse-checkout"
git -C "$SP_REPO" update-index --no-skip-worktree keep/f
git -C "$SP_REPO" checkout -q -- keep/f
# P12-03d review: nested cone and negation sets are clean untouched, and a relative repo works.
spdr() { (cd "$2" && python3 -I -c 'import importlib.util,sys;s=importlib.util.spec_from_file_location("pv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.git_dirty(sys.argv[2]))' "$SCRIPT_DIR/../autonomy/lib/proof-verify.py" "$1" 2>/dev/null); }
NS_REPO="$WORK/nsrepo"; mkdir -p "$NS_REPO/a/b/c" "$NS_REPO/a/d" "$NS_REPO/x/y" "$NS_REPO/x/z"
git -C "$NS_REPO" init -q
for _f in a/f a/b/f a/b/c/f a/d/f x/f x/y/f x/z/f top; do echo 1 > "$NS_REPO/$_f"; git -C "$NS_REPO" add "$_f"; done
git -C "$NS_REPO" -c user.name=t -c user.email=t@t commit -qm ns
git -C "$NS_REPO" sparse-checkout set --cone a/b >/dev/null 2>&1
[ ! -e "$NS_REPO/a/d/f" ] && [ "$(spdr "$NS_REPO" "$WORK")" = "False" ] && ok "sparse nested cone (a/b), sibling a/d untouched, is clean" || bad "nested cone: $(spdr "$NS_REPO" "$WORK")"
git -C "$NS_REPO" sparse-checkout set --cone a/b/c x/y >/dev/null 2>&1
[ "$(spdr "$NS_REPO" "$WORK")" = "False" ] && ok "sparse nested cone (a/b/c x/y) untouched is clean" || bad "nested cone 2: $(spdr "$NS_REPO" "$WORK")"
[ "$(cd "$WORK" && python3 -I -c 'import importlib.util,sys;s=importlib.util.spec_from_file_location("pv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.git_dirty("nsrepo"))' "$SCRIPT_DIR/../autonomy/lib/proof-verify.py" 2>&1)" = "False" ] && ok "sparse: relative repo path is clean" || bad "relative repo"
git -C "$NS_REPO" update-index --skip-worktree a/b/c/f
rm "$NS_REPO/a/b/c/f"
[ "$(cd "$WORK" && python3 -I -c 'import importlib.util,sys;s=importlib.util.spec_from_file_location("pv",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.git_dirty("nsrepo"))' "$SCRIPT_DIR/../autonomy/lib/proof-verify.py" 2>/dev/null)" = "True" ] && ok "sparse: relative repo, in-cone deletion is dirty" || bad "relative repo dirty"
git -C "$NS_REPO" update-index --no-skip-worktree a/b/c/f
git -C "$NS_REPO" checkout -q -- a/b/c/f
git -C "$NS_REPO" sparse-checkout set --no-cone /a/ '!/a/b/' >/dev/null 2>&1
[ ! -e "$NS_REPO/a/b/f" ] && [ "$(spdr "$NS_REPO" "$WORK")" = "False" ] && ok "sparse no-cone negation (/a/ !/a/b/) untouched is clean" || bad "negation: $(spdr "$NS_REPO" "$WORK")"
git -C "$NS_REPO" update-index --skip-worktree a/f
rm "$NS_REPO/a/f"
[ "$(spdr "$NS_REPO" "$WORK")" = "True" ] && ok "sparse no-cone negation: in-cone deletion is dirty" || bad "negation in-cone: $(spdr "$NS_REPO" "$WORK")"
git -C "$NS_REPO" update-index --no-skip-worktree a/f
git -C "$NS_REPO" checkout -q -- a/f
# P12-03d perf: many out-of-cone paths use one batched matcher call, not one process each.
BIG_REPO="$WORK/bigrepo"; mkdir -p "$BIG_REPO/keep" "$BIG_REPO/out"
git -C "$BIG_REPO" init -q
echo 1 > "$BIG_REPO/keep/f"
for _i in $(seq 1 400); do echo "$_i" > "$BIG_REPO/out/f$_i"; done
git -C "$BIG_REPO" add keep/f out
git -C "$BIG_REPO" -c user.name=t -c user.email=t@t commit -qm big
git -C "$BIG_REPO" sparse-checkout set --cone keep >/dev/null 2>&1
_t0=$SECONDS
_bv="$(spdr "$BIG_REPO" "$WORK")"
_dt=$((SECONDS - _t0))
[ ! -e "$BIG_REPO/out/f1" ] && [ "$_bv" = "False" ] && ok "sparse: 400 out-of-cone files read clean" || bad "big sparse: $_bv"
[ "$_dt" -lt 5 ] && ok "sparse: 400 out-of-cone files checked in ${_dt}s (<5s, batched)" || bad "big sparse slow: ${_dt}s"
git -C "$BIG_REPO" update-index --skip-worktree keep/f
rm "$BIG_REPO/keep/f"
[ "$(spdr "$BIG_REPO" "$WORK")" = "True" ] && ok "sparse: in-cone deletion among 400 out-of-cone files is dirty" || bad "big sparse dirty"
git -C "$BIG_REPO" update-index --no-skip-worktree keep/f
# CRLF in the index plus autocrlf: raw bytes match, so a flagged file is clean.
printf 'x\r\n' > "$GD_REPO/crlf"
git -C "$GD_REPO" -c core.autocrlf=false add crlf
git -C "$GD_REPO" -c user.name=t -c user.email=t@t commit -qm crlf
git -C "$GD_REPO" config core.autocrlf true
git -C "$GD_REPO" update-index --skip-worktree crlf
[ "$(gd)" = "False" ] && ok "writer: CRLF-in-index flagged file is clean under autocrlf" || bad "writer crlf: $(gd)"
git -C "$GD_REPO" update-index --no-skip-worktree crlf
git -C "$GD_REPO" config --unset core.autocrlf
git -C "$GD_REPO" update-index --assume-unchanged a
rm "$GD_REPO/a"
[ "$(gd 2>/dev/null)" = "True" ] && ok "writer: assume-unchanged file deleted on disk is dirty" || bad "writer assume deleted: $(gd 2>&1)"
git -C "$GD_REPO" update-index --no-assume-unchanged a
git -C "$GD_REPO" checkout -q -- a
# Head moving after the gate (merge refused) records blocked:head, not blocked:merge.
printf '{"state":"created","url":"https://github.com/o/r/pull/50","branch":"feat-race"}' > .loki/state/pr.json
bash "$LOKI" merge pr feat-race >/dev/null 2>&1
[ "$(jq -r .merge.outcome .loki/state/pr.json)" = "blocked:head" ] && ok "pr.json: head moved during checks records blocked:head" || bad "race: $(cat .loki/state/pr.json)"
rm -f .loki/state/pr.json
# Unreadable PR head fails closed, even without --require-verified.
: > "$STUB_LOG"
OUT="$(bash "$LOKI" merge pr feat-nohead 2>&1)"; RC=$?
grep -q "^pr merge feat-nohead" "$STUB_LOG" && bad "unreadable head merged" || ok "unreadable PR head never merges"
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
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"PARTIAL"}}' "$STUB_HEAD" > .loki/proofs/p1/proof.json
seed feat-ok 13 created
bash "$LOKI" merge pr feat-ok --require-verified >/dev/null 2>&1
[ "$(prj .merge.outcome)" = "blocked:verdict" ] && [ "$(prj .merge.gate)" = "verdict" ] && ok "pr.json: verdict gate records blocked:verdict" || bad "pr.json verdict: $(cat .loki/state/pr.json)"
printf '{"facts":{"git":{"head_sha":"%s","dirty":false}},"honesty":{"headline":"VERIFIED"}}' "$STUB_HEAD" > .loki/proofs/p1/proof.json
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

# Owner opt-in earned merge: LOKI_EARNED_MERGE=1 consults the per-path Seal
# record (loki trust --json). Off by default; protected, reverted and
# revert-unknown paths stay PR-only. Real bin/loki trust over a fixture repo.
EM="$WORK/earn"; mkdir -p "$EM"
git -C "$EM" init -q
git -C "$EM" config user.email t@t
git -C "$EM" config user.name t
for _n in 1 2; do
  mkdir -p "$EM/.loki/proofs/r$_n"
  printf '{"honesty":{"headline":"VERIFIED"},"files_changed":{"files":[{"path":"good.txt"},{"path":"gone.txt"},{"path":".github/w.yml"}]}}' > "$EM/.loki/proofs/r$_n/proof.json"
done
echo a > "$EM/gone.txt"; git -C "$EM" add gone.txt; git -C "$EM" commit -qm "add gone"
echo b >> "$EM/gone.txt"; git -C "$EM" commit -qam "change gone"
git -C "$EM" revert --no-edit HEAD >/dev/null 2>&1
printf 'good.txt\n' > "$WORK/files-feat-em"
OUT="$(cd "$EM" && bash "$LOKI" merge pr feat-em 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && grep -q "^pr merge feat-em --squash --match-head-commit $STUB_HEAD\$" "$STUB_LOG" && ! grep -q "pr view feat-em --json files" "$STUB_LOG" && ok "earned: default off, merge path unchanged and no record consulted" || bad "earned default rc=$RC: $OUT"
: > "$STUB_LOG"
OUT="$(cd "$EM" && LOKI_EARNED_MERGE_MIN_VERIFIED=2 LOKI_EARNED_MERGE=1 bash "$LOKI" merge pr feat-em 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && grep -q "^pr merge feat-em " "$STUB_LOG" && ok "earned: opted-in eligible path merges" || bad "earned eligible rc=$RC: $OUT"
for _case in "protected:.github/w.yml" "protected-env:.env.local" "reverted:gone.txt" "unknown-record:nothing.txt"; do
  _cn="${_case%%:*}"; _cp="${_case#*:}"
  printf 'good.txt\n%s\n' "$_cp" > "$WORK/files-feat-em"
  : > "$STUB_LOG"
  OUT="$(cd "$EM" && LOKI_EARNED_MERGE_MIN_VERIFIED=2 LOKI_EARNED_MERGE=1 bash "$LOKI" merge pr feat-em 2>&1)"; RC=$?
  grep -q "^pr merge feat-em" "$STUB_LOG" && bad "earned $_cn merged" || ok "earned: $_cn path never merges"
  [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "gate: trust" && ok "earned: $_cn names the trust gate" || bad "earned $_cn msg rc=$RC: $OUT"
done
printf 'good.txt\ndocs/x.md\n' > "$WORK/files-feat-em"
: > "$STUB_LOG"
OUT="$(cd "$EM" && LOKI_EARNED_MERGE_MIN_VERIFIED=2 LOKI_EARNED_MERGE=1 LOKI_EARNED_MERGE_PROTECTED="docs/*" bash "$LOKI" merge pr feat-em 2>&1)"
grep -q "^pr merge feat-em" "$STUB_LOG" && bad "owner-protected glob merged" || ok "earned: owner-listed protected glob stays PR-only"
# Unknown revert status: a non-git directory cannot read history, so reverts is null.
NG="$WORK/earn-nogit"; mkdir -p "$NG/.loki/proofs/r1" "$NG/.loki/proofs/r2"
cp "$EM/.loki/proofs/r1/proof.json" "$NG/.loki/proofs/r1/"; cp "$EM/.loki/proofs/r2/proof.json" "$NG/.loki/proofs/r2/"
printf 'good.txt\n' > "$WORK/files-feat-em"
: > "$STUB_LOG"
OUT="$(cd "$NG" && LOKI_EARNED_MERGE_MIN_VERIFIED=2 LOKI_EARNED_MERGE=1 bash "$LOKI" merge pr feat-em 2>&1)"; RC=$?
grep -q "^pr merge feat-em" "$STUB_LOG" && bad "unknown revert status merged" || ok "earned: unknown revert status never merges"
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q "revert status is unknown" && ok "earned: names the unknown revert status" || bad "earned unknown msg rc=$RC: $OUT"
# Below the VERIFIED floor (default 20) refuses.
: > "$STUB_LOG"
OUT="$(cd "$EM" && LOKI_EARNED_MERGE=1 bash "$LOKI" merge pr feat-em 2>&1)"
grep -q "^pr merge feat-em" "$STUB_LOG" && bad "below floor merged" || ok "earned: below the VERIFIED floor never merges"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
