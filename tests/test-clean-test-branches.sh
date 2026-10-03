#!/usr/bin/env bash
# PO-TEST-3: scripts/clean-test-branches.sh safety rules.
# The script is NEVER run against this repository. A copy is placed in two
# throwaway layouts under the run-owned temp dir: one where the sandbox repo
# IS the repo containing the copy (must refuse), and one where the copy lives
# elsewhere and is pointed at a sandbox repo with a repo-local identity.
#  T1 refuses to run on the repo that contains the script (and on a tree that
#     looks like the loki-mode source), leaving every branch intact.
#  T2 --apply never deletes main, master, develop, feat/*, fix/*, release/*,
#     hotfix/*, chore/*, docs/* or the checked-out branch.
#  T3 --apply deletes exactly the allowlisted debris branches and nothing
#     else; the default dry run deletes nothing.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export LOKI_NO_BROWSER=1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC_SH="$REPO_ROOT/scripts/clean-test-branches.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

[ -f "$SRC_SH" ] || { echo "FAIL: $SRC_SH missing"; exit 1; }

# The script needs bash 4+ (mapfile).
B4=""
for c in "$(command -v bash)" /opt/homebrew/bin/bash /usr/local/bin/bash; do
    [ -x "$c" ] || continue
    # shellcheck disable=SC2016
    if "$c" -c '[ "${BASH_VERSINFO[0]}" -ge 4 ]' 2>/dev/null; then B4="$c"; break; fi
done
[ -n "$B4" ] || { echo "SKIP: bash 4+ required"; exit 0; }

mkrepo() { # dir
    mkdir -p "$1"
    git -C "$1" init -q -b main
    git -C "$1" config user.email t@example.invalid
    git -C "$1" config user.name t
    git -C "$1" config commit.gpgsign false
    git -C "$1" commit -q --allow-empty -m base
}
branches() { git -C "$1" for-each-ref --format='%(refname:short)' refs/heads/ | sort | tr '\n' ' '; }
has() { git -C "$1" rev-parse --verify -q "refs/heads/$2" >/dev/null; }

# Rule 3 (live loki run) is host-dependent, so pgrep is stubbed on PATH:
# "busy" reports a live run, "idle" (the default below) reports none.
mkdir -p "$T/stub-busy" "$T/stub-idle"
printf '#!/bin/sh\nexit 0\n' > "$T/stub-busy/pgrep"
printf '#!/bin/sh\nexit 1\n' > "$T/stub-idle/pgrep"
chmod +x "$T/stub-busy/pgrep" "$T/stub-idle/pgrep"
export PATH="$T/stub-idle:$PATH"

# Layout A: the sandbox repo contains its own copy of the script.
SELF="$T/selfrepo"
mkrepo "$SELF"
mkdir -p "$SELF/scripts"
cp "$SRC_SH" "$SELF/scripts/clean-test-branches.sh"
git -C "$SELF" branch case1
before="$(branches "$SELF")"
out="$("$B4" "$SELF/scripts/clean-test-branches.sh" "$SELF" --apply 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "refusing to run on the real loki-mode repo"; then
    ok "T1a refuses when target is the repo containing the script (rc=$rc)"
else bad "T1a expected refusal, rc=$rc out=$out"; fi
if [ "$(branches "$SELF")" = "$before" ]; then ok "T1b refused run deleted no branch"; else bad "T1b branches changed"; fi

# Layout B: the copy lives elsewhere (SELF_REPO = $T/tool).
mkdir -p "$T/tool/scripts"
cp "$SRC_SH" "$T/tool/scripts/clean-test-branches.sh"
TOOL="$T/tool/scripts/clean-test-branches.sh"

# Defense in depth: target that looks like the loki-mode source tree.
LOOK="$T/lookalike"
mkrepo "$LOOK"
mkdir -p "$LOOK/autonomy"; : > "$LOOK/VERSION"; : > "$LOOK/autonomy/loki"
git -C "$LOOK" branch case2
out="$("$B4" "$TOOL" "$LOOK" --apply 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "looks like the loki-mode source tree" && has "$LOOK" case2; then
    ok "T1c refuses a loki-mode-shaped tree and keeps its branches (rc=$rc)"
else bad "T1c expected refusal, rc=$rc out=$out"; fi

out="$("$B4" "$TOOL" "$T/not-a-repo" --apply 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then ok "T1d non-repo target rejected (rc=$rc)"; else bad "T1d non-repo accepted"; fi

BUSYREPO="$T/busy"
mkrepo "$BUSYREPO"
git -C "$BUSYREPO" branch case5
out="$(PATH="$T/stub-busy:$PATH" "$B4" "$TOOL" "$BUSYREPO" --apply 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "live loki run is active" && has "$BUSYREPO" case5; then
    ok "T1e refuses while a live loki run is active and keeps branches"
else bad "T1e live-run refusal missing (rc=$rc)"; fi

SB="$T/sandbox"
mkrepo "$SB"
PROTECTED=(master develop feat/x fix/y release/1.0 hotfix/z chore/c docs/d feat/case1 fix/conflict-1 release/test-wt-1)
DEBRIS=(case1 case3a case21 conflict-10527 loki-prdstub-BsoWju loki-pgtest-reap-0ReuUA loki-pgtest-XXXXXX loki-prdstub-bin-abc test-loki-fs loki-test-wt-123 test-wt-456)
KEEP=(my-case1 case1-keep conflict-abc loki-pgtest- test-loki-fs2 feature-work wip/case1)
for b in "${PROTECTED[@]}" "${DEBRIS[@]}" "${KEEP[@]}"; do git -C "$SB" branch "$b"; done
before="$(branches "$SB")"

out="$("$B4" "$TOOL" "$SB" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(branches "$SB")" = "$before" ] && printf '%s' "$out" | grep -q "DRY RUN"; then
    ok "T3a default dry run deletes nothing"
else bad "T3a dry run changed branches or failed (rc=$rc)"; fi
listed_ok=1
for b in "${DEBRIS[@]}"; do printf '%s\n' "$out" | grep -qx "  - $b" || listed_ok=0; done
if [ "$listed_ok" -eq 1 ]; then ok "T3b dry run lists every debris branch"; else bad "T3b debris missing from dry-run list"; fi

out="$("$B4" "$TOOL" "$SB" --apply 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "T3c --apply exits 0"; else bad "T3c --apply rc=$rc out=$out"; fi

for b in main "${PROTECTED[@]}"; do
    if has "$SB" "$b"; then ok "T2 kept protected $b"; else bad "T2 protected $b was deleted"; fi
done
for b in "${KEEP[@]}"; do
    if has "$SB" "$b"; then ok "T3 kept non-allowlisted $b"; else bad "T3 non-allowlisted $b was deleted"; fi
done
for b in "${DEBRIS[@]}"; do
    if has "$SB" "$b"; then bad "T3 debris $b survived"; else ok "T3 deleted debris $b"; fi
done

# Checked-out debris-named branch is never deleted.
CO="$T/checkedout"
mkrepo "$CO"
git -C "$CO" checkout -q -b case9
git -C "$CO" branch case10
out="$("$B4" "$TOOL" "$CO" --apply 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && has "$CO" case9 && ! has "$CO" case10; then
    ok "T2e checked-out debris-named branch survives, sibling debris deleted"
else bad "T2e checked-out branch handling wrong (rc=$rc)"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
