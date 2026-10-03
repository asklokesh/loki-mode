#!/usr/bin/env bash
# RC-AUTO: scripts/train-cycle.sh against a bare-repo origin and a stub gh.
# Covers: green train promoted, red train held (TRAIN_RED), docs-only main not
# released, release in progress waits, live-PID lock exits, dry-run pushes
# nothing, parent != origin/main refuses, Security Audit cancelled reruns once,
# and a full phase C release commit (identity, trailer, CHANGELOG, map guard).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TC="$REPO_ROOT/scripts/train-cycle.sh"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi; }
has() { if grep -qE -- "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3 (no match for: $2)"; fi; }
hasnt() { if grep -qE -- "$2" "$1" 2>/dev/null; then bad "$3 (unexpected: $2)"; else ok "$3"; fi; }

temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || exit 2
chmod 700 "$RUN_TMP"
printf '%s\n' "$RUN_TMP" >"$RUN_TMP/.loki-run-owned"
cleanup() {
    if [ "$(cat "$RUN_TMP/.loki-run-owned" 2>/dev/null)" = "$RUN_TMP" ]; then rm -rf -- "$RUN_TMP"; fi
}
trap cleanup EXIT

command -v jq >/dev/null 2>&1 || { echo "jq missing, skipping"; exit 0; }

# stub gh: canned run lists under $GH_FIX; logs every call
mkdir -p "$RUN_TMP/bin"
cat >"$RUN_TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$GH_FIX/calls.log"
[ "$1" = "run" ] || exit 0
case "$2" in
    rerun) exit 0 ;;
    list)
        sha=""; wf=""; prev=""
        for a in "$@"; do
            [ "$prev" = "--commit" ] && sha="$a"
            [ "$prev" = "--workflow" ] && wf="$a"
            prev="$a"
        done
        if [ -n "$wf" ]; then f="$GH_FIX/release.json"; else f="$GH_FIX/runs-$sha.json"; fi
        if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi ;;
esac
STUB
chmod +x "$RUN_TMP/bin/gh"
export PATH="$RUN_TMP/bin:$PATH"

# runs <sha> "Name:status:conclusion" ... -> runs-<sha>.json
runs() {
    local sha="$1"; shift
    local arr="[]" spec n s c i=100
    for spec in "$@"; do
        IFS=: read -r n s c <<<"$spec"
        i=$((i+1))
        arr="$(printf '%s' "$arr" | jq --arg n "$n" --arg s "$s" --arg c "$c" --argjson i "$i" \
            '. + [{workflowName:$n,status:$s,conclusion:$c,databaseId:$i}]')"
    done
    printf '%s\n' "$arr" >"$GH_FIX/runs-$sha.json"
}
all_green() { runs "$1" "Tests:completed:success" "Bun Parity:completed:success" "Coverage (baseline):completed:success" "Security Audit:completed:success"; }

gitc() { git -C "$1" -c user.name=testbot -c user.email=t@example.invalid "${@:2}"; }

# mkfix <name>: sets ORIGIN SEED REPO WT GH_FIX; origin main = release v1.0.0 (tagged)
mkfix() {
    F="$RUN_TMP/$1"; mkdir -p "$F"
    ORIGIN="$F/origin.git"; SEED="$F/seed"; REPO="$F/repo"; WT="$F/wt"
    export GH_FIX="$F/gh"; mkdir -p "$GH_FIX"
    git init -q --bare "$ORIGIN"
    # Linux git defaults to master: pin HEAD to main so clones check out main.
    git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
    git init -q "$SEED"
    git -C "$SEED" symbolic-ref HEAD refs/heads/main
    git -C "$SEED" remote add origin "$ORIGIN"
    mkdir -p "$SEED/scripts" "$SEED/loki-ts/dist" "$SEED/docs"
    cp "$REPO_ROOT/scripts/release.sh" "$SEED/scripts/release.sh"
    echo 1.0.0 >"$SEED/VERSION"
    echo "// 1.0.0" >"$SEED/loki-ts/dist/loki.js"
    printf '# Changelog\n\n## Unreleased\n\n## v1.0.0 (2026-01-01)\n\nold\n' >"$SEED/CHANGELOG.md"
    gitc "$SEED" add -A; gitc "$SEED" commit -q -m "release: v1.0.0"
    gitc "$SEED" tag v1.0.0
    gitc "$SEED" push -q origin main v1.0.0 2>/dev/null
    git clone -q -b main "$ORIGIN" "$REPO" 2>/dev/null
    git -C "$REPO" config user.name testbot; git -C "$REPO" config user.email t@example.invalid
    git -C "$REPO" worktree add -q --detach "$WT" main 2>/dev/null
    BUMP="$F/bump.sh"
    cat >"$BUMP" <<'B'
#!/usr/bin/env bash
echo 1.0.1 >VERSION
echo "// 1.0.1" >loki-ts/dist/loki.js
echo '{"version":3,"sources":["../src/a.ts"]}' >loki-ts/dist/loki.js.map
[ -n "${FAKE_BUMP_ADVANCE:-}" ] && ( cd "$FAKE_BUMP_ADVANCE" && echo x >>adv.txt && git add adv.txt && git -c user.name=t -c user.email=t@e.invalid commit -q -m "late: advance" && git push -q origin main 2>/dev/null )
echo "stage these files:"
echo "  git add VERSION"
echo "  git add -f loki-ts/dist/loki.js"
echo "  git add -f loki-ts/dist/loki.js.map"
B
    export LOKI_TC_BUMP_CMD="bash $BUMP" LOKI_TC_INSTALL_CMD="true"
}
# commit_file <dir> <subject> <path>: a commit touching one file
commit_file() { mkdir -p "$(dirname "$1/$3")"; echo "$2" >>"$1/$3"; gitc "$1" add "$3"; gitc "$1" commit -q -m "$2"; }
tc() { # tc [args]: run the script against the fixture
    LOKI_TC_REPO="$REPO" LOKI_RELEASE_WORKTREE="${WT_ENV-$WT}" bash "$TC" "$@" >"$F/out.txt" 2>&1
    RC=$?
}
LOG() { echo "$REPO/.loki/state/train-cycle.log"; }
omain() { git -C "$ORIGIN" rev-parse refs/heads/main; }
trains() { git -C "$ORIGIN" for-each-ref --format='%(refname:short)' 'refs/heads/train/*' | tr '\n' ' '; }

echo "T1 -- green train is pushed as train/1 then promoted to main"
mkfix t1
commit_file "$REPO" "feat: x" src/x.txt
S1="$(git -C "$REPO" rev-parse main)"
tc
check "$(trains)" "train/1 " "phase A pushed train/1"
check "$(git -C "$ORIGIN" rev-parse refs/heads/train/1)" "$S1" "train points at the local main SHA"
has "$(LOG)" "WAIT train/1" "no checks yet: waits"
check "$(omain)" "$(git -C "$SEED" rev-parse HEAD)" "main untouched while waiting"
tc; check "$(trains)" "train/1 " "second cycle does not push a duplicate train"
all_green "$S1"
WT_ENV="" tc
check "$(omain)" "$S1" "main promoted to the train SHA"
has "$(LOG)" "PROMOTED train/1" "promotion logged"
check "$(jq -r .last_train "$REPO/.loki/state/train-cycle.json")" "1" "state file records the train"

echo "T2 -- red train is not promoted"
mkfix t2
commit_file "$REPO" "feat: y" src/y.txt
S2="$(git -C "$REPO" rev-parse main)"
tc
runs "$S2" "Tests:completed:failure" "Bun Parity:completed:success" "Coverage (baseline):completed:success" "Security Audit:completed:success"
tc
check "$RC" "2" "exit 2 on a red train"
has "$(LOG)" "TRAIN_RED 1 Tests" "TRAIN_RED logged with suite"
check "$(omain)" "$(git -C "$SEED" rev-parse HEAD)" "main not moved"

echo "T3 -- docs-only main is not released"
mkfix t3
commit_file "$SEED" "docs: note" docs/note.md; gitc "$SEED" push -q origin main 2>/dev/null
D3="$(omain)"; all_green "$D3"
tc
check "$(omain)" "$D3" "no release commit pushed"
has "$(LOG)" "SKIP docs-only" "docs-only logged"

echo "T4 -- a release in progress causes a wait"
mkfix t4
commit_file "$SEED" "feat: z" src/z.txt; gitc "$SEED" push -q origin main 2>/dev/null
H4="$(omain)"; all_green "$H4"
echo '[{"status":"in_progress","conclusion":""}]' >"$GH_FIX/release.json"
tc
check "$(omain)" "$H4" "nothing pushed while Release runs"
has "$(LOG)" "WAIT release in progress" "wait logged"

echo "T5 -- lock held by a live PID exits; a stale lock is reclaimed"
mkfix t5
commit_file "$REPO" "feat: l" src/l.txt
mkdir -p "$REPO/.loki/state/train-cycle.lock"; echo $$ >"$REPO/.loki/state/train-cycle.lock/pid"
tc
check "$RC" "0" "exits 0 on a held lock"
has "$(LOG)" "LOCK_HELD" "LOCK_HELD logged"
check "$(trains)" "" "no train pushed under a held lock"
echo 999999 >"$REPO/.loki/state/train-cycle.lock/pid"
tc
check "$(trains)" "train/1 " "stale lock reclaimed, cycle ran"
check "$([ -d "$REPO/.loki/state/train-cycle.lock" ] && echo held || echo free)" "free" "lock released at exit"

echo "T6 -- dry-run pushes nothing"
mkfix t6
commit_file "$REPO" "feat: d" src/d.txt
S6="$(git -C "$REPO" rev-parse main)"
tc --dry-run
check "$(trains)" "" "dry-run pushed no train"
has "$(LOG)" "WOULD_PUSH.*train/1" "dry-run prints the action"
git -C "$REPO" push -q origin "$S6:refs/heads/train/1" 2>/dev/null; all_green "$S6"
tc --dry-run
check "$(omain)" "$(git -C "$SEED" rev-parse HEAD)" "dry-run did not promote"
has "$(LOG)" "WOULD_PROMOTE" "dry-run promote printed"

echo "T7 -- release commit whose parent is not origin/main is refused"
mkfix t7
commit_file "$SEED" "feat: r" src/r.txt; gitc "$SEED" push -q origin main 2>/dev/null
H7="$(omain)"; all_green "$H7"
FAKE_BUMP_ADVANCE="$SEED" tc
check "$RC" "1" "exit 1 on parent mismatch"
has "$(LOG)" "PARENT_MISMATCH" "PARENT_MISMATCH logged"
check "$(git -C "$ORIGIN" log -1 --format=%s refs/heads/main)" "late: advance" "release commit not pushed"

echo "T8 -- Security Audit cancelled is rerun exactly once"
mkfix t8
commit_file "$REPO" "feat: s" src/s.txt
S8="$(git -C "$REPO" rev-parse main)"
tc
runs "$S8" "Tests:completed:success" "Bun Parity:completed:success" "Coverage (baseline):completed:success" "Security Audit:completed:cancelled"
tc; tc
check "$(grep -c '^run rerun' "$GH_FIX/calls.log")" "1" "one gh run rerun across two cycles"
check "$(omain)" "$(git -C "$SEED" rev-parse HEAD)" "not promoted while Security Audit is cancelled"

echo "T9 -- full release: bump, CHANGELOG, identity, trailer, push by SHA"
mkfix t9
commit_file "$SEED" "feat: shipped thing" src/q.txt; commit_file "$SEED" "docs: skip me" docs/q.md
gitc "$SEED" push -q origin main 2>/dev/null
H9="$(omain)"; all_green "$H9"
echo '[{"status":"completed","conclusion":"success"}]' >"$GH_FIX/release.json"
tc
check "$RC" "0" "cycle exits 0"
R="$(omain)"
check "$(git -C "$ORIGIN" log -1 --format=%s "$R")" "release: v1.0.1" "release commit on origin main"
check "$(git -C "$ORIGIN" rev-parse "$R^")" "$H9" "parent is the verified SHA"
check "$(git -C "$ORIGIN" log -1 --format=%an "$R")" "asklokesh" "author identity"
check "$(git -C "$ORIGIN" log -1 --format=%ae "$R")" "lokeshmure@live.com" "author email"
git -C "$ORIGIN" log -1 --format=%B "$R" >"$F/msg.txt"
has "$F/msg.txt" "^Claude-Session: https://claude.ai/code/session_01GFNzL4TEfAXvX1KK5buE9w$" "session trailer"
git -C "$ORIGIN" show "$R:CHANGELOG.md" >"$F/cl.txt"
has "$F/cl.txt" "^## v1.0.1 \([0-9-]+\)$" "CHANGELOG heading"
has "$F/cl.txt" "^- feat: shipped thing$" "non-docs commit listed"
hasnt "$F/cl.txt" "docs: skip me" "docs commit omitted"
check "$(grep -n '^## ' "$F/cl.txt" | head -2 | tr '\n' '|')" "3:## Unreleased|5:## v1.0.1 ($(date -u +%Y-%m-%d))|" "section sits between Unreleased and the previous version"
tc
check "$(omain)" "$R" "a second cycle on a release commit is a no-op"

echo "T10 -- dist map with an absolute source is refused"
mkfix t10
commit_file "$SEED" "feat: m" src/m.txt; gitc "$SEED" push -q origin main 2>/dev/null
H10="$(omain)"; all_green "$H10"
sed -i.bak 's#"../src/a.ts"#"/Users/x/a.ts"#' "$BUMP"; rm -f "$BUMP.bak"
tc
check "$(omain)" "$H10" "bad map not released"
has "$(LOG)" "MAP_BAD" "MAP_BAD logged"

echo "T11 -- a green unpromoted train is promoted before it is superseded"
mkfix t11
commit_file "$REPO" "feat: g1" src/g1.txt
G1="$(git -C "$REPO" rev-parse main)"
WT_ENV="" tc
check "$(trains)" "train/1 " "train/1 pushed"
all_green "$G1"
commit_file "$REPO" "feat: g2" src/g2.txt
G2="$(git -C "$REPO" rev-parse main)"
WT_ENV="" tc
check "$(trains)" "train/1 " "green unpromoted train/1 is not superseded"
has "$(LOG)" "HOLD train/1 green, awaiting promote" "HOLD green logged"
check "$(omain)" "$G1" "phase B promoted train/1 in the same run"
WT_ENV="" tc
check "$(trains)" "train/1 train/2 " "next run pushes train/2 once train/1 is promoted"
check "$(git -C "$ORIGIN" rev-parse refs/heads/train/2)" "$G2" "train/2 carries the newer main"

echo "T12 -- a red newest train is still superseded"
mkfix t12
commit_file "$REPO" "feat: r1" src/r1.txt
R1="$(git -C "$REPO" rev-parse main)"
WT_ENV="" tc
runs "$R1" "Tests:completed:failure" "Bun Parity:completed:success" "Coverage (baseline):completed:success" "Security Audit:completed:success"
commit_file "$REPO" "feat: r2" src/r2.txt
WT_ENV="" tc
check "$(trains)" "train/1 train/2 " "red train/1 superseded by train/2"
hasnt "$(LOG)" "HOLD train/1 green" "no green hold for a red train"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
