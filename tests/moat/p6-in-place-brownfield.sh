#!/usr/bin/env bash
# Moat property P6: in-place brownfield.
#
# The factory must work on an EXISTING repository without moving it: same path
# (same directory inode), history preserved, pre-existing tracked, untracked and
# gitignored user files intact, the change landing on a branch in place, and a
# proof that verifies on both CLI routes.
#
# Method: build a real repo fixture (several commits, a tag, a nested tracked
# file, an untracked user file with unique sentinel content, gitignored files),
# record path/inode/HEAD/refs/file hashes, then run ONE full autonomy/run.sh
# loop in place against a fake `claude` on PATH (hermetic: no network, no model,
# no spend). The fake provider makes a real one-function edit to a tracked file
# ONLY on the build prompt and signals completion the way a real agent does
# (.loki/signals/COMPLETION_REQUESTED). Every other provider call (doc and wiki
# generation) is logged and answered with inert text. Network tools (npx, npm,
# curl, wget, gh, pip) are shimmed on PATH to log and fail, so a new network
# path in run.sh is blocked and reported on stderr instead of silently fetched.
#
# Contract: one "CASE <ID> PASS|FAIL <text>" stdout line per case, exit 0 when
# the script ran to completion. A missing prerequisite is a FAIL, never a skip.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI_BIN="$REPO_ROOT/bin/loki"
T_START=$(date +%s)

pass() { printf 'CASE %s PASS %s\n' "$1" "$2"; }
fail() { printf 'CASE %s FAIL %s\n' "$1" "$2"; }
note() { printf '%s\n' "$*" >&2; }

ALL_CASES="P6.same-path-and-history P6.user-files-intact P6.change-landed-in-place P6.proof-produced-and-verifies P6.no-gate-artifacts-committed P6.untracked-not-swept P6.resume-does-not-sweep P6.ignored-files-not-swept P6.preexisting-edit-disclosed P6.resume-keeps-ignored-user-file P6.resume-after-interrupt-commits-agent-files"

# Caller-inherited knobs that would test something other than the default a
# user gets. Unset so the run exercises the shipped defaults.
unset LOKI_BRANCH_PROTECTION LOKI_PROOF LOKI_PROVEN_PR LOKI_HANDOFF LOKI_DIR \
      TARGET_DIR LOKI_SDK_LOOP LOKI_SDK_MODE LOKI_LEGACY_BASH LOKI_SESSION_ID \
      GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
# Config redirects that would route writes around the isolated HOME below.
unset CLAUDE_CONFIG_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME
# Deliberate deviations from shipped defaults, both for hermeticity: the caveman bootstrap
# (autonomy/lib/claude-flags.sh loki_caveman_bootstrap) runs
# `npx github:JuliusBrussee/caveman` right before the first claude call. That is
# a network fetch plus remote code execution, which a hermetic suite must not
# do. It only compresses model output tokens, which a stub ignores, so nothing
# asserted below depends on it. Activation (LOKI_CAVEMAN) stays at its default.
# Same reason for the advisory reachability probe (run.sh
# _loki_check_network_reachable curls https://api.anthropic.com); it only warns.
export LOKI_CAVEMAN_AUTO_BOOTSTRAP=0 LOKI_SKIP_NET_PREFLIGHT=1

# --- prerequisites: a missing one fails every case with the reason ----------
missing=""
for tool in git python3 mktemp; do
    command -v "$tool" >/dev/null 2>&1 || missing="${missing}${missing:+, }$tool"
done
[ -f "$RUN_SH" ] || missing="${missing}${missing:+, }autonomy/run.sh"
if [ -n "$missing" ]; then
    for c in $ALL_CASES; do fail "$c" "prerequisite missing: $missing"; done
    exit 0
fi

# --- the single run-owned temp dir; everything lives below it ----------------
T="$(mktemp -d "${TMPDIR:-/tmp}/loki-moat-p6.XXXXXXXX")" || { note "mktemp failed"; exit 1; }
T="$(cd "$T" && pwd -P)"
MAIN_PID=$$
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
    # EXIT traps can fire in subshells; only the main shell cleans up.
    [ "$(exec sh -c 'echo $PPID')" = "$MAIN_PID" ] || return 0
    local p
    for p in $(pgrep -f "$T" 2>/dev/null); do
        [ "$p" = "$MAIN_PID" ] || kill "$p" 2>/dev/null || true
    done
    rm -rf -- "$T"
}
trap cleanup EXIT

mkdir -p "$T/home" "$T/tmp" "$T/bin" "$T/log" "$T/parent/repo"
W="$T/parent/repo"

# Hermetic for EVERYTHING below, fixture included: a real ~/.gitconfig with
# commit.gpgsign or hooks would change both the fixture commits and Loki's own
# session commit (which is `git commit ... 2>/dev/null || true`, so a signing
# failure would silently leave HEAD unchanged).
export HOME="$T/home" TMPDIR="$T/tmp" GIT_CONFIG_NOSYSTEM=1
export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
       LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false

g() { git -C "$W" "$@"; }

# Hash + mode for every regular file outside .git/ and .loki/, one line each.
manifest() {
    python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
for d, dirs, files in os.walk(root):
    if d == root:
        dirs[:] = [x for x in dirs if x not in (".git", ".loki")]
    for f in files:
        p = os.path.join(d, f)
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        with open(p, "rb") as fh:
            h = hashlib.sha256(fh.read()).hexdigest()
        print("%s %o %s" % (h, os.stat(p).st_mode & 0o7777, os.path.relpath(p, root)))
PY
}
inode_of() { python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_ino)' "$1"; }

# --- fixture: an existing repo with real history -----------------------------
SENTINEL="moat-p6-sentinel-$$-${RANDOM}${RANDOM}"
fixture_ok=1
{
    git init -q "$W" \
    && g symbolic-ref HEAD refs/heads/main \
    && g config user.email moat@example.invalid \
    && g config user.name "moat p6" \
    && g config commit.gpgsign false \
    && g config tag.gpgsign false \
    && printf 'def add(a, b):\n    return a + b\n' > "$W/calc.py" \
    && printf 'build/\n*.log\n' > "$W/.gitignore" \
    && g add calc.py .gitignore && g commit -qm "c1: add" \
    && mkdir -p "$W/src" "$W/scripts" \
    && printf '# Calc\n\nA tiny calculator.\n' > "$W/README.md" \
    && printf 'def clamp(x, lo, hi):\n    return max(lo, min(hi, x))\n' > "$W/src/util.py" \
    && printf '#!/bin/sh\necho run\n' > "$W/scripts/run.sh" && chmod 755 "$W/scripts/run.sh" \
    && g add README.md src/util.py scripts/run.sh && g commit -qm "c2: docs and util" \
    && g tag v0.1 \
    && printf 'def sub(a, b):\n    return a - b\n' >> "$W/calc.py" \
    && g add calc.py && g commit -qm "c3: sub"
} >"$T/log/fixture.log" 2>&1 || fixture_ok=0
# Pre-existing user files git does not track: one untracked, two gitignored.
printf 'my private notes\n%s\n' "$SENTINEL" > "$W/NOTES.local.txt" || fixture_ok=0
mkdir -p "$W/build" && printf 'binary-ish artifact\n' > "$W/build/out.bin" || fixture_ok=0
printf 'debug log line\n' > "$W/debug.log" || fixture_ok=0

if [ "$fixture_ok" -ne 1 ]; then
    reason="fixture setup failed: $(tr '\n' ' ' < "$T/log/fixture.log" | cut -c1-200)"
    for c in $ALL_CASES; do fail "$c" "$reason"; done
    exit 0
fi

W_REAL="$(cd "$W" && pwd -P)"
W_INODE="$(inode_of "$W_REAL")"
ORIG_HEAD="$(g rev-parse HEAD)"
ORIG_TAG="$(g rev-parse v0.1)"
ORIG_REVLIST="$(g rev-list HEAD | tr '\n' ' ')"
ORIG_STASH="$(g stash list)"
list_parent() { find "$T/parent" -mindepth 1 -maxdepth 1 | LC_ALL=C sort; }
PARENT_BEFORE="$(list_parent)"
manifest "$W" | LC_ALL=C sort > "$T/log/manifest.before"

# --- fake provider ----------------------------------------------------------
cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
# Moat P6 fake provider. Edits a tracked file ONLY on the build prompt.
prompt="" prev=""
for a in "$@"; do
    [ "$prev" = "-p" ] && prompt="$a"
    prev="$a"
done
# Drain a piped prompt so the writer never dies of SIGPIPE under load.
[ "$prompt" = "-" ] && cat >/dev/null
kind=other
case "$prompt" in *"<loki_system>"*) kind=build ;; esac
printf '%s\t%s\t%s\n' "$kind" "$(pwd -P)" "${1:-}" >> "$MOAT_STUB_LOG"
if [ "$kind" = build ] && [ "${MOAT_STUB_MODE:-}" = session2 ]; then
    # Session 2: a real edit, a .gitignore rewrite that un-ignores the user's
    # build/ and *.log files, and an edit to the user's untracked notes.
    grep -q 'def div' calc.py 2>/dev/null \
        || printf 'def div(a, b):\n    return a / b\n' >> calc.py
    printf 'node_modules/\n' > .gitignore
    grep -q 'agent was here' NOTES.local.txt 2>/dev/null \
        || printf 'agent was here\n' >> NOTES.local.txt
    mkdir -p .loki/signals
    printf 'added div() to calc.py\n' > .loki/signals/COMPLETION_REQUESTED
elif [ "$kind" = build ] && [ "${MOAT_STUB_MODE:-}" = cfg1 ]; then
    # Second fixture, session 1: un-ignore config.local.json and commit a copy.
    printf 'build/\n' > .gitignore
    printf '{"agent":1}\n' > config.local.json
    printf 'print(1)\n' > app.py
    mkdir -p .loki/signals
    printf 'added app.py\n' > .loki/signals/COMPLETION_REQUESTED
elif [ "$kind" = build ] && [ "${MOAT_STUB_MODE:-}" = cfg2 ]; then
    # Second fixture, session 2: record the user's config.local.json as the
    # agent sees it mid-session, then un-ignore it again and make an edit.
    cat config.local.json > "$MOAT_STUB_SEEN" 2>/dev/null || printf 'MISSING\n' > "$MOAT_STUB_SEEN"
    printf 'build/\n' > .gitignore
    printf 'print(2)\n' > app2.py
    mkdir -p .loki/signals
    printf 'added app2.py\n' > .loki/signals/COMPLETION_REQUESTED
elif [ "$kind" = build ] && [ "${MOAT_STUB_MODE:-}" = intr1 ]; then
    # Third fixture, session 1: turn 1 makes helper.py and does not finish;
    # turn 2 saves the session-created record as the post-provider hook left
    # it, makes test_helper.py, and stops the runner the way a supervisor does
    # (one SIGTERM under LOKI_SUPERVISED_BUILD=1), so no session commit runs.
    if [ "$(grep -c '^build' "$MOAT_STUB_LOG")" -le 1 ]; then
        printf 'def greet():\n    return "hi"\n' > helper.py
    else
        cp .loki/state/session-created.z "${MOAT_STUB_LOG%.log}.record" 2>/dev/null \
            || printf 'MISSING' > "${MOAT_STUB_LOG%.log}.record"
        printf 'from helper import greet\n\n\ndef test_greet():\n    assert greet() == "hi"\n' > test_helper.py
        # run.sh execs a temp copy of itself (LOKI_TEMP_SCRIPT_PATH, exported).
        pid="$(cat .loki/loki.pid 2>/dev/null)"
        case "$(ps -o command= -p "$pid" 2>/dev/null)" in
            *"${LOKI_TEMP_SCRIPT_PATH:-autonomy/run.sh}"*) kill -TERM "$pid" ;;
            *) printf 'no run.sh at pid [%s]\n' "$pid" > "${MOAT_STUB_LOG%.log}.kill-error" ;;
        esac
    fi
    echo "moat stub provider turn done"
    exit 0
elif [ "$kind" = build ] && [ "${MOAT_STUB_MODE:-}" = intr2 ]; then
    # Third fixture, session 2: finish the work by making app.py use helper.
    printf 'import helper\nprint(helper.greet())\n' > app.py
    mkdir -p .loki/signals
    printf 'app.py uses helper\n' > .loki/signals/COMPLETION_REQUESTED
elif [ "$kind" = build ]; then
    grep -q 'def mul' calc.py 2>/dev/null \
        || printf 'def mul(a, b):\n    return a * b\n' >> calc.py
    mkdir -p .loki/signals
    printf 'added mul() to calc.py\n' > .loki/signals/COMPLETION_REQUESTED
fi
echo "moat stub provider done. MOAT_P6_COMPLETE"
exit 0
STUB
chmod +x "$T/bin/claude"
STUB_LOG="$T/log/stub.log"
: > "$STUB_LOG"

# Fail-closed network shims: log the attempt, never reach the network.
NET_LOG="$T/log/net-blocked.log"
: > "$NET_LOG"
for tool in npx npm curl wget gh pip pip3; do
    printf '#!/bin/sh\nprintf "%%s %%s\\n" "%s" "$*" >> "%s"\nexit 1\n' "$tool" "$NET_LOG" > "$T/bin/$tool"
    chmod +x "$T/bin/$tool"
done

# --- run the pipeline in place -----------------------------------------------
TO=""
command -v timeout >/dev/null 2>&1 && TO="timeout 240"
# run_pipeline <output tag> <stub log> <stub mode> [repo]: one full run.sh loop
# in place (repo defaults to $W, iteration cap to $MOAT_MAX_ITER or 2); output
# in $T/log/<tag>.out and .err; returns run.sh's exit code.
run_pipeline() {
    local repo="${4:-$W}"
    # shellcheck disable=SC2086  # $TO is intentionally word-split (empty or "timeout 240")
    ( cd "$repo" && PATH="$T/bin:$PATH" MOAT_STUB_LOG="$2" MOAT_STUB_MODE="$3" \
        MOAT_STUB_SEEN="$T/log/cfg-seen.txt" \
        LOKI_TARGET_DIR="$repo" LOKI_PROVIDER=claude LOKI_MAX_ITERATIONS="${MOAT_MAX_ITER:-2}" \
        LOKI_COMPLETION_PROMISE=MOAT_P6_COMPLETE LOKI_AUTO_CONFIRM=true \
        LOKI_SKIP_PREREQS=true LOKI_PHASE_CODE_REVIEW=false LOKI_COUNCIL_ENABLED=false \
        LOKI_APP_RUNNER=false LOKI_NO_NEW_SESSION=1 LOKI_SKIP_AUTH_PREFLIGHT=1 \
        $TO bash "$RUN_SH" </dev/null >"$T/log/$1.out" 2>"$T/log/$1.err" )
}
kill_leftovers() {
    local leftover p
    leftover="$(pgrep -f "$T" 2>/dev/null | tr '\n' ' ')"
    if [ -n "$leftover" ]; then
        note "P6: killing processes left behind by the run: $leftover"
        for p in $leftover; do kill "$p" 2>/dev/null || true; done
    fi
}
RUN_T0=$(date +%s)
run_pipeline run "$STUB_LOG" session1
RUN_RC=$?
RUN_SECS=$(( $(date +%s) - RUN_T0 ))
echo "INFO P6 pipeline run.sh rc=$RUN_RC seconds=$RUN_SECS"
kill_leftovers
if [ -d "$T/home" ]; then
    note "P6: files the run wrote under the isolated HOME:"
    (cd "$T/home" && find . -type f | LC_ALL=C sort | sed 's/^/  /' | head -20) >&2
fi
if [ "$RUN_RC" -ne 0 ]; then
    note "P6: run.sh exited $RUN_RC; last lines of its output:"
    tail -n 15 "$T/log/run.out" >&2
    tail -n 15 "$T/log/run.err" >&2
fi
if [ -s "$NET_LOG" ]; then
    note "P6: network tool calls blocked by the shims (the run stayed hermetic):"
    sed 's/^/  /' "$NET_LOG" | head -20 >&2
fi
BUILD_CALLS=$(awk -F'\t' '$1 == "build" {n++} END {print n + 0}' "$STUB_LOG")
note "P6: provider calls: $(grep -c . "$STUB_LOG") total, $BUILD_CALLS build"
# Vacuity gate: "nothing was damaged" means nothing if no work happened. The
# no-damage cases below FAIL unless the provider actually got a build prompt.
VACUOUS=""
[ "$BUILD_CALLS" -ge 1 ] \
    || VACUOUS="vacuous: the pipeline never reached the provider build step (run.sh rc=$RUN_RC); "

# ============================================================================
# P6.same-path-and-history
# ============================================================================
id=P6.same-path-and-history
why="$VACUOUS"
if [ ! -d "$W_REAL" ]; then
    why="repo directory no longer exists at $W_REAL"
else
    now_real="$(cd "$W_REAL" && pwd -P)"
    now_inode="$(inode_of "$W_REAL")"
    [ "$now_real" = "$W_REAL" ] || why="${why}path moved ($now_real); "
    [ "$now_inode" = "$W_INODE" ] || why="${why}directory inode changed ($W_INODE -> $now_inode); "
    [ "$(g rev-parse main 2>/dev/null)" = "$ORIG_HEAD" ] || why="${why}base branch main was moved or rewritten; "
    [ "$(g rev-parse v0.1 2>/dev/null)" = "$ORIG_TAG" ] || why="${why}tag v0.1 changed; "
    g cat-file -e "${ORIG_HEAD}^{commit}" 2>/dev/null || why="${why}original HEAD object is gone; "
    [ "$(g rev-list "$ORIG_HEAD" 2>/dev/null | tr '\n' ' ')" = "$ORIG_REVLIST" ] \
        || why="${why}original history differs; "
    [ "$(g stash list)" = "$ORIG_STASH" ] || why="${why}user stash stack changed; "
    wt_count=$(g worktree list --porcelain | grep -c '^worktree ')
    [ "$wt_count" = "1" ] || why="${why}git worktree count is $wt_count (expected 1); "
    NEW_HEAD="$(g rev-parse HEAD 2>/dev/null)"
    CUR_BRANCH="$(g symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
    if [ "$NEW_HEAD" = "$ORIG_HEAD" ]; then
        head_desc="HEAD unchanged at ${ORIG_HEAD:0:7} (no commit made)"
    elif g merge-base --is-ancestor "$ORIG_HEAD" "$NEW_HEAD" 2>/dev/null; then
        head_desc="HEAD advanced ${ORIG_HEAD:0:7} -> ${NEW_HEAD:0:7} on $CUR_BRANCH with the original HEAD as ancestor"
    else
        why="${why}original HEAD ${ORIG_HEAD:0:7} is not an ancestor of new HEAD ${NEW_HEAD:0:7}; "
    fi
fi
if [ -z "$why" ]; then
    pass "$id" "same absolute path and inode; main, tag v0.1, history and stash untouched; one worktree; $head_desc"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.user-files-intact
# ============================================================================
id=P6.user-files-intact
why="$VACUOUS"
manifest "$W" | LC_ALL=C sort > "$T/log/manifest.after"
checked=0
while IFS= read -r line; do
    path="${line#* * }"
    [ "$path" = "calc.py" ] && continue   # the one file the provider edits
    checked=$((checked + 1))
    grep -qxF "$line" "$T/log/manifest.after" || why="${why}changed or missing: $path; "
done < "$T/log/manifest.before"
# Vacuity guard: the manifest must actually cover the untracked and ignored files.
for must in NOTES.local.txt debug.log build/out.bin README.md src/util.py scripts/run.sh .gitignore; do
    grep -q " ${must}\$" "$T/log/manifest.before" || why="${why}probe did not record $must; "
done
PARENT_AFTER="$(list_parent)"
[ "$PARENT_AFTER" = "$PARENT_BEFORE" ] \
    || why="${why}parent directory entries changed: $(printf '%s' "$PARENT_AFTER" | tr '\n' ' '); "
# No copy of the repo outside it: the untracked file's unique sentinel must not
# appear anywhere else under the run's HOME, TMPDIR or parent directory.
copies="$(grep -rlF "$SENTINEL" "$T/home" "$T/tmp" "$T/bin" 2>/dev/null | tr '\n' ' ')"
[ -z "$copies" ] || why="${why}sentinel copied outside the repo: $copies; "
# Positive control: the same probe finds the sentinel inside the repo.
grep -rlF "$SENTINEL" "$W" > "$T/log/sentinel-in-repo.txt" 2>/dev/null
grep -q '/NOTES\.local\.txt$' "$T/log/sentinel-in-repo.txt" \
    || why="${why}positive control failed: sentinel probe cannot see NOTES.local.txt in the repo; "
if [ -z "$why" ]; then
    pass "$id" "$checked pre-existing files byte-identical with same mode (tracked, untracked, gitignored); no sibling or temp copy"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.change-landed-in-place
# ============================================================================
id=P6.change-landed-in-place
why=""
if [ "$BUILD_CALLS" -lt 1 ]; then
    why="provider never received a build prompt (0 of $(grep -c . "$STUB_LOG") calls); "
else
    bad_pwd="$(awk -F'\t' -v w="$W_REAL" '$1 == "build" && $2 != w {print $2; exit}' "$STUB_LOG")"
    [ -z "$bad_pwd" ] || why="${why}provider ran outside the repo ($bad_pwd); "
fi
grep -q '^def mul' "$W/calc.py" 2>/dev/null || why="${why}change absent from working tree; "
CUR_BRANCH="$(g symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
case "$CUR_BRANCH" in loki/*) ;; *) why="${why}not on an in-place loki branch (on $CUR_BRANCH); " ;; esac
g show HEAD:calc.py > "$T/log/head-calc.py" 2>/dev/null
grep -q '^def mul' "$T/log/head-calc.py" || why="${why}change not committed on $CUR_BRANCH; "
g show main:calc.py > "$T/log/main-calc.py" 2>/dev/null
grep -q '^def mul' "$T/log/main-calc.py" && why="${why}change leaked onto the base branch main; "
# Positive control: the base-branch probe reads real content.
grep -q '^def sub' "$T/log/main-calc.py" || why="${why}positive control failed: cannot read main:calc.py; "
if [ -z "$why" ]; then
    pass "$id" "provider edit in working tree and committed on $CUR_BRANCH in place; base branch main unchanged"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.proof-produced-and-verifies (both routes, bound to this run, tamper control)
# ============================================================================
id=P6.proof-produced-and-verifies
why=""
ID_FILE="$W/.loki/state/last-proof-id.txt"
PROOF_ID=""
[ -s "$ID_FILE" ] && PROOF_ID="$(cat "$ID_FILE")"
PJ="$W/.loki/proofs/$PROOF_ID/proof.json"
# Run `loki proof verify $PROOF_ID` on one route (bin/loki execs autonomy/loki
# when LOKI_LEGACY_BASH=1, so the two routes are distinct entry points). The
# verifier JSON report lands in $T/log/verify-<tag>.out; returns the exit code.
run_verify() {  # $1 = route (bun|bash), $2 = log tag, [$3 = repo, default $W]
    local out="$T/log/verify-$2" repo="${3:-$W}"
    if [ "$1" = bun ]; then
        (cd "$repo" && "$LOKI_BIN" proof verify "$PROOF_ID") >"$out.out" 2>"$out.err"
    else
        (cd "$repo" && LOKI_LEGACY_BASH=1 "$LOKI_BIN" proof verify "$PROOF_ID") >"$out.out" 2>"$out.err"
    fi
}
# "<ok> <hash_ok>" from a verifier report, e.g. "True True", or "unparsed".
report_fields() {
    python3 -c 'import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get("ok"), d.get("hash_ok"))
except Exception:
    print("unparsed")' "$1" 2>/dev/null
}
if [ -z "$PROOF_ID" ]; then
    why="no .loki/state/last-proof-id.txt after the run (proof generation failed silently; run rc=$RUN_RC)"
elif [ ! -f "$PJ" ]; then
    why="last-proof-id.txt names $PROOF_ID but $PJ does not exist (generator failed silently)"
else
    routes="bash"
    if command -v bun >/dev/null 2>&1; then
        routes="bun bash"
    else
        why="${why}prerequisite missing: bun (Bun route not verified); "
    fi
    for r in $routes; do
        run_verify "$r" "$r-clean"; rc=$?
        f="$(report_fields "$T/log/verify-$r-clean.out")"
        [ "$rc" -eq 0 ] && [ "$f" = "True True" ] \
            || why="${why}$r route: proof verify $PROOF_ID rc=$rc report=[$f]; "
    done
    # Binding: a receipt that verifies but describes some other change proves
    # nothing about this run. It must span original HEAD -> current HEAD and
    # list the provider's edit.
    bind="$(python3 - "$PJ" "$ORIG_HEAD" "$(g rev-parse HEAD 2>/dev/null)" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
git = (d.get("facts") or {}).get("git") or {}
bad = []
if git.get("base_sha") != sys.argv[2]:
    bad.append("base_sha %s is not the original HEAD" % git.get("base_sha"))
if git.get("head_sha") != sys.argv[3]:
    bad.append("head_sha %s is not the current HEAD" % git.get("head_sha"))
paths = [f.get("path") for f in (d.get("files_changed") or {}).get("files") or []]
if "calc.py" not in paths:
    bad.append("calc.py missing from files_changed %s" % paths)
print("; ".join(bad))
PY
)" || bind="proof.json could not be parsed"
    [ -z "$bind" ] || why="${why}receipt not bound to this run: $bind; "
    # Negative control under the REAL id, only after the real verifies: edit one
    # hashed fact in place and require an integrity rejection (not a lookup
    # error), then restore the bytes and require a clean verify again.
    cp -p "$PJ" "$T/log/proof.json.orig"
    python3 - "$PJ" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["wall_clock_sec"] = int(d.get("wall_clock_sec") or 0) + 1
json.dump(d, open(p, "w"))
PY
    for r in $routes; do
        run_verify "$r" "$r-tampered"; rc=$?
        f="$(report_fields "$T/log/verify-$r-tampered.out")"
        { [ "$rc" -ne 0 ] && [ "$f" = "False False" ]; } \
            || why="${why}$r route: negative control failed, edited receipt gave rc=$rc report=[$f] (want nonzero rc, ok=False hash_ok=False); "
    done
    cp -p "$T/log/proof.json.orig" "$PJ"
    for r in $routes; do
        run_verify "$r" "$r-restored"; rc=$?
        f="$(report_fields "$T/log/verify-$r-restored.out")"
        [ "$rc" -eq 0 ] && [ "$f" = "True True" ] \
            || why="${why}$r route: restored receipt no longer verifies (rc=$rc report=[$f]); "
    done
fi
if [ -z "$why" ]; then
    pass "$id" "proof $PROOF_ID spans original HEAD to session commit and lists calc.py; loki proof verify exits 0 with ok and hash_ok on bun and bash routes; an in-place edit is rejected as an integrity mismatch on both"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.no-gate-artifacts-committed
# ============================================================================
# The static-analysis gate syntax-checks the changed calc.py inside the user's
# repo. It must leave no bytecode there, so none can land in the session commit.
id=P6.no-gate-artifacts-committed
why="$VACUOUS"
# Positive control: the gate ran and checked at least one file this run.
grep -Eq 'Static analysis: ([1-9][0-9]* files checked|[0-9]+ issue\(s\) in [1-9][0-9]* files)' "$T/log/run.out" \
    || why="${why}vacuous: the static-analysis gate never checked a file (no 'Static analysis: N files' line with N >= 1); "
g ls-tree -r --name-only HEAD > "$T/log/head-tree-gate.txt" 2>/dev/null
grep -qx 'calc.py' "$T/log/head-tree-gate.txt" \
    || why="${why}positive control failed: HEAD tree listing does not show calc.py; "
committed_bc="$(grep -E '(^|/)__pycache__/|\.py[co]$' "$T/log/head-tree-gate.txt" | tr '\n' ' ')"
[ -z "$committed_bc" ] || why="${why}bytecode committed on $CUR_BRANCH: $committed_bc; "
disk_bc="$(cd "$W" && find . \( -path ./.git -o -path ./.loki \) -prune -o \( -name __pycache__ -o -name '*.py[co]' \) -print | tr '\n' ' ')"
[ -z "$disk_bc" ] || why="${why}bytecode written into the repo: $disk_bc; "
if [ -z "$why" ]; then
    pass "$id" "the static-analysis gate checked the changed files and left no __pycache__ or .pyc in the repo or in the commit on $CUR_BRANCH"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.untracked-not-swept (last session-1 case: it switches branches and back)
# ============================================================================
# A pre-existing untracked user file must stay the user's: not committed onto
# the agent branch, and still on disk after the user returns to their branch.
id=P6.untracked-not-swept
why="$VACUOUS"
g ls-tree -r --name-only HEAD > "$T/log/head-tree.txt" 2>/dev/null
grep -qx 'calc.py' "$T/log/head-tree.txt" \
    || why="${why}positive control failed: HEAD tree listing does not show calc.py; "
if grep -qx 'NOTES.local.txt' "$T/log/head-tree.txt"; then
    why="${why}pre-existing untracked NOTES.local.txt was committed onto $CUR_BRANCH; "
fi
# The receipt must not claim the user's file as a change this run made. The
# positive control (calc.py listed) keeps an empty or unreadable list from
# passing.
if [ -f "$PJ" ]; then
    receipt_paths="$(python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
for f in (d.get("files_changed") or {}).get("files") or []:
    print(f.get("path"))' "$PJ" 2>/dev/null)"
    printf '%s\n' "$receipt_paths" | grep -qx 'calc.py' \
        || why="${why}positive control failed: receipt files_changed does not list calc.py; "
    printf '%s\n' "$receipt_paths" | grep -qx 'NOTES.local.txt' \
        && why="${why}receipt files_changed lists pre-existing NOTES.local.txt as changed by this run; "
else
    why="${why}no receipt to inspect; "
fi
if g checkout -q main 2>"$T/log/checkout.err"; then
    if [ ! -f "$W/NOTES.local.txt" ]; then
        why="${why}switching back to main deleted it from disk; "
    elif ! grep -qF "$SENTINEL" "$W/NOTES.local.txt"; then
        why="${why}switching back to main changed its content; "
    fi
    g checkout -q "$CUR_BRANCH" 2>/dev/null || note "P6: could not return to $CUR_BRANCH"
else
    why="${why}could not switch back to main: $(head -c 160 "$T/log/checkout.err" | tr '\n' ' '); "
fi
if [ -z "$why" ]; then
    pass "$id" "pre-existing untracked file not committed on $CUR_BRANCH and survives switching back to main"
else
    fail "$id" "$why"
fi

# ============================================================================
# Session 2: the user goes back to main, makes a file, and runs Loki again.
# ============================================================================
# The recorded session branch is resumed (setup_agent_branch's resume path).
# The fake provider now edits calc.py, rewrites .gitignore so the user's
# build/out.bin and debug.log are no longer ignored, and appends to the user's
# untracked NOTES.local.txt. Three cases read this one run.
S1_BRANCH="$CUR_BRANCH"
S1_HEAD="$(g rev-parse HEAD 2>/dev/null)"
SENTINEL2="moat-p6-between-$$-${RANDOM}${RANDOM}"
S2_WHY=""
if g checkout -q main 2>"$T/log/s2-checkout.err"; then
    printf 'made between sessions\n%s\n' "$SENTINEL2" > "$W/BETWEEN.local.txt" \
        || S2_WHY="could not create BETWEEN.local.txt; "
else
    S2_WHY="could not switch to main before session 2: $(head -c 160 "$T/log/s2-checkout.err" | tr '\n' ' '); "
fi
STUB_LOG2="$T/log/stub2.log"
: > "$STUB_LOG2"
RUN2_RC=-1
if [ -z "$S2_WHY" ]; then
    RUN2_T0=$(date +%s)
    run_pipeline run2 "$STUB_LOG2" session2
    RUN2_RC=$?
    echo "INFO P6 session-2 run.sh rc=$RUN2_RC seconds=$(( $(date +%s) - RUN2_T0 ))"
    kill_leftovers
    if [ "$RUN2_RC" -ne 0 ]; then
        note "P6: session-2 run.sh exited $RUN2_RC; last lines of its output:"
        tail -n 15 "$T/log/run2.out" >&2
        tail -n 15 "$T/log/run2.err" >&2
    fi
fi
BUILD_CALLS2=$(awk -F'\t' '$1 == "build" {n++} END {print n + 0}' "$STUB_LOG2")
note "P6: session-2 provider calls: $(grep -c . "$STUB_LOG2") total, $BUILD_CALLS2 build"
# Vacuity gate: session 2 must have reached the provider, resumed the SAME
# branch (no second loki branch), and committed its own edit there.
[ "$BUILD_CALLS2" -ge 1 ] \
    || S2_WHY="${S2_WHY}vacuous: session 2 never reached the provider build step (run.sh rc=$RUN2_RC); "
S2_BRANCH="$(g symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
[ "$S2_BRANCH" = "$S1_BRANCH" ] \
    || S2_WHY="${S2_WHY}session 2 is on $S2_BRANCH, not the resumed $S1_BRANCH; "
n_loki="$(g branch --list 'loki/*' | grep -c .)"
[ "$n_loki" = "1" ] || S2_WHY="${S2_WHY}$n_loki loki branches after session 2 (expected the one resumed); "
g show HEAD:calc.py > "$T/log/s2-head-calc.py" 2>/dev/null
grep -q '^def div' "$T/log/s2-head-calc.py" \
    || S2_WHY="${S2_WHY}vacuous: session 2 committed no edit on $S2_BRANCH (HEAD:calc.py lacks div); "
[ "$(g rev-parse HEAD 2>/dev/null)" != "$S1_HEAD" ] \
    || S2_WHY="${S2_WHY}vacuous: HEAD did not move in session 2; "

# Everything read from the session branch, before switching away from it.
g ls-tree -r --name-only HEAD > "$T/log/s2-head-tree.txt" 2>/dev/null
g show HEAD:.gitignore > "$T/log/s2-head-gitignore" 2>/dev/null
# Exposed: no longer ignored on the session branch once the rewrite landed.
S2_EXPOSED=""
for p in build/out.bin debug.log; do
    [ -f "$W/$p" ] && ! g check-ignore -q "$p" 2>/dev/null && S2_EXPOSED="$S2_EXPOSED $p"
done
PROOF_ID2=""
[ -s "$ID_FILE" ] && PROOF_ID2="$(cat "$ID_FILE")"
PJ2="$W/.loki/proofs/$PROOF_ID2/proof.json"
: > "$T/log/s2-receipt.txt"
if [ -n "$PROOF_ID2" ] && [ -f "$PJ2" ]; then
    # "<status> <path>" per receipt entry.
    python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
for f in (d.get("files_changed") or {}).get("files") or []:
    print("%s %s" % (f.get("status"), f.get("path")))' "$PJ2" > "$T/log/s2-receipt.txt" 2>/dev/null
fi
note "P6: session-2 receipt entries: $(tr '\n' ',' < "$T/log/s2-receipt.txt")"
S2_RECEIPT_WHY=""
if [ -z "$PROOF_ID2" ] || [ ! -f "$PJ2" ]; then
    S2_RECEIPT_WHY="no session-2 receipt (last-proof-id.txt='$PROOF_ID2'); "
else
    grep -q ' calc\.py$' "$T/log/s2-receipt.txt" \
        || S2_RECEIPT_WHY="positive control failed: session-2 receipt does not list calc.py; "
fi
# receipt_lists <path>: true when the session-2 receipt names <path>.
receipt_lists() { awk -v p="$1" '{ s = $0; sub(/^[^ ]* /, "", s); if (s == p) f = 1 } END { exit !f }' "$T/log/s2-receipt.txt"; }
S2_VERIFY_WHY=""
if [ -z "$S2_RECEIPT_WHY" ]; then
    PROOF_ID_SAVED="$PROOF_ID"
    PROOF_ID="$PROOF_ID2"
    s2_routes="bash"
    if command -v bun >/dev/null 2>&1; then
        s2_routes="bun bash"
    else
        S2_VERIFY_WHY="prerequisite missing: bun (Bun route not verified); "
    fi
    for r in $s2_routes; do
        run_verify "$r" "$r-s2"; rc=$?
        f="$(report_fields "$T/log/verify-$r-s2.out")"
        [ "$rc" -eq 0 ] && [ "$f" = "True True" ] \
            || S2_VERIFY_WHY="${S2_VERIFY_WHY}$r route: proof verify $PROOF_ID2 rc=$rc report=[$f]; "
    done
    PROOF_ID="$PROOF_ID_SAVED"
fi
grep -q 'agent was here' "$W/NOTES.local.txt" 2>/dev/null && NOTES_EDITED=1 || NOTES_EDITED=0

# Back on the base branch: the user's files must all still be on disk.
S2_BASE_WHY=""
: > "$T/log/manifest.s2-main"
: > "$T/log/s2-main-untracked.txt"
: > "$T/log/s2-main-between.txt"
: > "$T/log/s2-main-notes.txt"
if g checkout -q main 2>"$T/log/s2-checkout-main.err"; then
    manifest "$W" | LC_ALL=C sort > "$T/log/manifest.s2-main"
    g ls-files --others --exclude-standard > "$T/log/s2-main-untracked.txt" 2>/dev/null
    cat "$W/BETWEEN.local.txt" > "$T/log/s2-main-between.txt" 2>/dev/null
    cat "$W/NOTES.local.txt" > "$T/log/s2-main-notes.txt" 2>/dev/null
    g checkout -q "$S2_BRANCH" 2>/dev/null || note "P6: could not return to $S2_BRANCH"
else
    S2_BASE_WHY="could not switch back to main after session 2: $(head -c 160 "$T/log/s2-checkout-main.err" | tr '\n' ' '); "
fi

# ============================================================================
# P6.resume-does-not-sweep
# ============================================================================
id=P6.resume-does-not-sweep
why="$S2_WHY$S2_BASE_WHY"
grep -qx 'BETWEEN.local.txt' "$T/log/s2-head-tree.txt" \
    && why="${why}BETWEEN.local.txt (made between sessions) was committed onto $S2_BRANCH; "
receipt_lists BETWEEN.local.txt \
    && why="${why}session-2 receipt lists BETWEEN.local.txt as changed by the run; "
if [ -z "$S2_BASE_WHY" ]; then
    grep -qF "$SENTINEL2" "$T/log/s2-main-between.txt" \
        || why="${why}BETWEEN.local.txt is gone or changed after switching back to main; "
    grep -qx 'BETWEEN.local.txt' "$T/log/s2-main-untracked.txt" \
        || why="${why}BETWEEN.local.txt is not an untracked file on main; "
fi
if [ -z "$why" ]; then
    pass "$id" "a file made between sessions stayed untracked through the resumed session on $S2_BRANCH (which committed its own edit) and is intact after switching back to main"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.ignored-files-not-swept
# ============================================================================
id=P6.ignored-files-not-swept
why="$S2_WHY$S2_BASE_WHY"
# Positive control: the rewrite landed and really exposed the files to git add.
[ "$(cat "$T/log/s2-head-gitignore" 2>/dev/null)" = "node_modules/" ] \
    || why="${why}positive control failed: HEAD:.gitignore is not the agent's rewrite; "
for p in build/out.bin debug.log; do
    case " $S2_EXPOSED " in *" $p "*) ;;
        *) why="${why}positive control failed: $p is still ignored (or missing) on $S2_BRANCH after the rewrite; " ;;
    esac
    grep -qx "$p" "$T/log/s2-head-tree.txt" && why="${why}gitignored $p was committed onto $S2_BRANCH; "
    receipt_lists "$p" && why="${why}session-2 receipt lists gitignored $p as changed by the run; "
    if [ -z "$S2_BASE_WHY" ]; then
        orig="$(grep " ${p}\$" "$T/log/manifest.before")"
        [ -n "$orig" ] || why="${why}probe did not record $p before the run; "
        grep -qxF "$orig" "$T/log/manifest.s2-main" \
            || why="${why}$p is gone or changed after switching back to main; "
    fi
done
if [ -z "$why" ]; then
    pass "$id" "the agent's .gitignore rewrite exposed build/out.bin and debug.log, neither was committed or claimed, and both are byte-identical on main"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.preexisting-edit-disclosed
# ============================================================================
id=P6.preexisting-edit-disclosed
why="$S2_WHY$S2_BASE_WHY$S2_RECEIPT_WHY$S2_VERIFY_WHY"
[ "$NOTES_EDITED" = 1 ] \
    || why="${why}positive control failed: the agent's edit is not in NOTES.local.txt; "
grep -qx 'NOTES.local.txt' "$T/log/s2-head-tree.txt" \
    && why="${why}pre-existing NOTES.local.txt was committed onto $S2_BRANCH; "
grep -qx 'preexisting_modified NOTES.local.txt' "$T/log/s2-receipt.txt" \
    || why="${why}session-2 receipt does not list NOTES.local.txt as preexisting_modified ($(tr '\n' ',' < "$T/log/s2-receipt.txt")); "
if [ -z "$S2_BASE_WHY" ]; then
    { grep -qF "$SENTINEL" "$T/log/s2-main-notes.txt" && grep -q 'agent was here' "$T/log/s2-main-notes.txt"; } \
        || why="${why}NOTES.local.txt is gone or lost content after switching back to main; "
fi
if [ -z "$why" ]; then
    pass "$id" "the agent's edit to the user's untracked NOTES.local.txt was not committed, is listed in the receipt as preexisting_modified, and that receipt verifies on bun and bash routes"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.resume-keeps-ignored-user-file (second fixture, two more sessions)
# ============================================================================
# main ignores config.local.json. Session 1 un-ignores it and commits its own
# copy on the session branch. Back on main, the user writes their real
# config.local.json (ignored there). Resuming that branch would let git
# overwrite the user's file, and the next checkout of main would delete it. The
# resume must be refused and a new session branch minted; the user's file stays
# intact during and after session 2 and after checkout of main, never committed.
id=P6.resume-keeps-ignored-user-file
why=""
C="$T/cfg/repo"
USER_CFG='{"user":"my real settings"}'
gc() { git -C "$C" "$@"; }
{
    mkdir -p "$C" && git init -q "$C" \
    && gc symbolic-ref HEAD refs/heads/main \
    && gc config user.email moat@example.invalid \
    && gc config user.name "moat p6" \
    && gc config commit.gpgsign false \
    && printf 'def hello():\n    return "hi"\n' > "$C/main.py" \
    && printf 'config.local.json\n' > "$C/.gitignore" \
    && gc add main.py .gitignore && gc commit -qm "c1: app, ignore local config"
} >"$T/log/cfg-fixture.log" 2>&1 || why="second fixture setup failed: $(tr '\n' ' ' < "$T/log/cfg-fixture.log" | cut -c1-200); "
CFG_LOG1="$T/log/cfg-stub1.log"
CFG_LOG2="$T/log/cfg-stub2.log"
: > "$CFG_LOG1"
: > "$CFG_LOG2"
if [ -z "$why" ]; then
    run_pipeline cfg1 "$CFG_LOG1" cfg1 "$C"
    rc=$?
    echo "INFO P6 cfg session-1 run.sh rc=$rc"
    kill_leftovers
    [ "$(awk -F'\t' '$1 == "build" {n++} END {print n + 0}' "$CFG_LOG1")" -ge 1 ] \
        || why="${why}vacuous: cfg session 1 never reached the provider build step (run.sh rc=$rc); "
    C1_BRANCH="$(gc symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
    case "$C1_BRANCH" in loki/session-*) ;; *) why="${why}cfg session 1 is not on a minted session branch ($C1_BRANCH); " ;; esac
    C1_HEAD="$(gc rev-parse HEAD 2>/dev/null)"
    # Vacuity guard: the session-1 branch really tracks config.local.json.
    [ "$(gc show "$C1_BRANCH:config.local.json" 2>/dev/null)" = '{"agent":1}' ] \
        || why="${why}vacuous: $C1_BRANCH does not track the agent's config.local.json; "
    if gc checkout -q main 2>"$T/log/cfg-checkout1.err"; then
        printf '%s\n' "$USER_CFG" > "$C/config.local.json"
        gc check-ignore -q config.local.json \
            || why="${why}vacuous: the user's config.local.json is not ignored on main; "
    else
        why="${why}could not switch to main before cfg session 2: $(head -c 160 "$T/log/cfg-checkout1.err" | tr '\n' ' '); "
    fi
fi
if [ -z "$why" ]; then
    run_pipeline cfg2 "$CFG_LOG2" cfg2 "$C"
    rc=$?
    echo "INFO P6 cfg session-2 run.sh rc=$rc"
    kill_leftovers
    # Vacuity guard: session 2 really ran and committed its own edit.
    [ "$(awk -F'\t' '$1 == "build" {n++} END {print n + 0}' "$CFG_LOG2")" -ge 1 ] \
        || why="${why}vacuous: cfg session 2 never reached the provider build step (run.sh rc=$rc); "
    C2_BRANCH="$(gc symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
    gc cat-file -e HEAD:app2.py 2>/dev/null \
        || why="${why}vacuous: cfg session 2 committed no edit on $C2_BRANCH; "
    case "$C2_BRANCH" in
        loki/session-*) [ "$C2_BRANCH" != "$C1_BRANCH" ] \
            || why="${why}session 2 resumed $C1_BRANCH instead of minting a new branch; " ;;
        *) why="${why}cfg session 2 is not on a session branch ($C2_BRANCH); " ;;
    esac
    n_loki="$(gc branch --list 'loki/*' | grep -c .)"
    [ "$n_loki" = "2" ] || why="${why}$n_loki loki branches after cfg session 2 (expected 2); "
    [ "$(cat "$C/.loki/state/agent-branch.txt" 2>/dev/null)" = "$C2_BRANCH" ] \
        || why="${why}agent-branch.txt does not name $C2_BRANCH; "
    [ "$(gc rev-parse "$C1_BRANCH" 2>/dev/null)" = "$C1_HEAD" ] \
        || why="${why}$C1_BRANCH moved during session 2; "
    [ "$(cat "$T/log/cfg-seen.txt" 2>/dev/null)" = "$USER_CFG" ] \
        || why="${why}during session 2 config.local.json was '$(head -c 80 "$T/log/cfg-seen.txt" 2>/dev/null)'; "
    [ "$(cat "$C/config.local.json" 2>/dev/null)" = "$USER_CFG" ] \
        || why="${why}after session 2 config.local.json is '$(head -c 80 "$C/config.local.json" 2>/dev/null)'; "
    # Positive control: session 2's rewrite exposed the file to git add -A.
    { [ "$(gc show HEAD:.gitignore 2>/dev/null)" = "build/" ] && ! gc check-ignore -q config.local.json; } \
        || why="${why}positive control failed: config.local.json is still ignored on $C2_BRANCH; "
    gc ls-tree -r --name-only HEAD 2>/dev/null | grep -qx 'config.local.json' \
        && why="${why}config.local.json was committed onto $C2_BRANCH; "
    if gc checkout -q main 2>"$T/log/cfg-checkout2.err"; then
        [ "$(cat "$C/config.local.json" 2>/dev/null)" = "$USER_CFG" ] \
            || why="${why}after checkout of main config.local.json is '$(head -c 80 "$C/config.local.json" 2>/dev/null || echo MISSING)'; "
    else
        why="${why}could not switch back to main after cfg session 2: $(head -c 160 "$T/log/cfg-checkout2.err" | tr '\n' ' '); "
    fi
fi
if [ -z "$why" ]; then
    pass "$id" "resuming $C1_BRANCH (which tracks config.local.json) was refused and $C2_BRANCH minted; the user's gitignored config.local.json was intact during and after session 2 and after checkout of main, and never committed"
else
    fail "$id" "$why"
fi

# ============================================================================
# P6.resume-after-interrupt-commits-agent-files (third fixture, two sessions)
# ============================================================================
# Session 1 makes helper.py (turn 1) and test_helper.py (turn 2) and is stopped
# by a supervisor SIGTERM: state "interrupted", no session commit. Back on main
# the user makes a file, then runs again; the recorded branch is resumed and
# session 2 makes app.py import helper and finishes normally. The interrupted
# session's files must be committed (the committed tree runs) and listed in the
# receipt; the user's file must not be committed and must survive checkout of
# main; the receipt must verify on both routes.
id=P6.resume-after-interrupt-commits-agent-files
why=""
I="$T/intr/repo"
gi() { git -C "$I" "$@"; }
{
    mkdir -p "$I" && git init -q "$I" \
    && gi symbolic-ref HEAD refs/heads/main \
    && gi config user.email moat@example.invalid \
    && gi config user.name "moat p6" \
    && gi config commit.gpgsign false \
    && printf 'print("app")\n' > "$I/app.py" \
    && printf 'build/\n__pycache__/\n' > "$I/.gitignore" \
    && gi add app.py .gitignore && gi commit -qm "c1: app"
} >"$T/log/intr-fixture.log" 2>&1 || why="third fixture setup failed: $(tr '\n' ' ' < "$T/log/intr-fixture.log" | cut -c1-200); "
I_ORIG="$(gi rev-parse HEAD 2>/dev/null)"
INTR_LOG1="$T/log/intr-stub1.log"
INTR_LOG2="$T/log/intr-stub2.log"
: > "$INTR_LOG1"
: > "$INTR_LOG2"
SENTINEL3="moat-p6-after-interrupt-$$-${RANDOM}${RANDOM}"
if [ -z "$why" ]; then
    LOKI_SUPERVISED_BUILD=1 run_pipeline intr1 "$INTR_LOG1" intr1 "$I"
    rc=$?
    echo "INFO P6 interrupted session-1 run.sh rc=$rc"
    kill_leftovers
    # Vacuity guards: session 1 really made both files over two provider
    # turns, was interrupted (not finished), and made no commit.
    n="$(awk -F'\t' '$1 == "build" {n++} END {print n + 0}' "$INTR_LOG1")"
    [ "$n" = 2 ] || why="${why}vacuous: interrupted session 1 made $n build calls (expected 2; run.sh rc=$rc); "
    [ -s "$T/log/intr-stub1.kill-error" ] && why="${why}the stub could not signal run.sh: $(cat "$T/log/intr-stub1.kill-error"); "
    [ "$rc" = 143 ] || why="${why}interrupted session 1 exited $rc (expected 143, SIGTERM); "
    I1_STATUS="$(python3 -E -c 'import json, sys; print(json.load(open(sys.argv[1])).get("status"))' "$I/.loki/autonomy-state.json" 2>/dev/null)"
    [ "$I1_STATUS" = interrupted ] || why="${why}state after session 1 is '$I1_STATUS', not interrupted; "
    for f in helper.py test_helper.py; do
        [ -f "$I/$f" ] || why="${why}vacuous: session 1 did not leave $f on disk; "
    done
    I1_BRANCH="$(gi symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
    case "$I1_BRANCH" in loki/session-*) ;; *) why="${why}interrupted session 1 is not on a minted session branch ($I1_BRANCH); " ;; esac
    [ "$(gi rev-parse HEAD 2>/dev/null)" = "$I_ORIG" ] \
        || why="${why}vacuous: interrupted session 1 made a commit; "
    # Only the post-provider record could have listed helper.py before turn 2.
    # Not a vacuity guard, so session 2 still runs when it fails.
    I_REC_WHY=""
    tr '\000' '\n' < "$T/log/intr-stub1.record" 2>/dev/null | grep -qx 'helper.py' \
        || I_REC_WHY="the post-provider record did not list helper.py before the interrupt ($(tr '\000' ',' < "$T/log/intr-stub1.record" 2>/dev/null)); "
    if gi checkout -q main 2>"$T/log/intr-checkout1.err"; then
        printf 'made after the interrupt\n%s\n' "$SENTINEL3" > "$I/AFTER.local.txt"
    else
        why="${why}could not switch to main before session 2: $(head -c 160 "$T/log/intr-checkout1.err" | tr '\n' ' '); "
    fi
fi
if [ -z "$why" ]; then
    # Session 1's iteration count is restored on an interrupted resume.
    MOAT_MAX_ITER=5 run_pipeline intr2 "$INTR_LOG2" intr2 "$I"
    rc=$?
    echo "INFO P6 resumed session-2 run.sh rc=$rc"
    kill_leftovers
    [ "$(awk -F'\t' '$1 == "build" {n++} END {print n + 0}' "$INTR_LOG2")" -ge 1 ] \
        || why="${why}vacuous: resumed session 2 never reached the provider build step (run.sh rc=$rc); "
    [ "$rc" = 0 ] || why="${why}resumed session 2 exited $rc; "
    I2_BRANCH="$(gi symbolic-ref --short -q HEAD 2>/dev/null || echo DETACHED)"
    [ "$I2_BRANCH" = "$I1_BRANCH" ] || why="${why}session 2 is on $I2_BRANCH, not the resumed $I1_BRANCH; "
    gi show HEAD:app.py 2>/dev/null | grep -q '^import helper' \
        || why="${why}vacuous: session 2 committed no edit (HEAD:app.py does not import helper); "
    grep -q 'Carried over.*helper\.py' "$T/log/intr2.out" "$T/log/intr2.err" 2>/dev/null \
        || why="${why}the resume did not name helper.py as carried over; "
    gi ls-tree -r --name-only HEAD > "$T/log/intr-head-tree.txt" 2>/dev/null
    for f in helper.py test_helper.py; do
        grep -qx "$f" "$T/log/intr-head-tree.txt" || why="${why}$f (made by the interrupted session) is not committed on $I2_BRANCH; "
    done
    grep -qx 'AFTER.local.txt' "$T/log/intr-head-tree.txt" \
        && why="${why}AFTER.local.txt (made by the user after the interrupt) was committed; "
    # The committed tree alone must run: app.py imports the committed helper.
    mkdir -p "$T/intr/tree"
    ran="$(gi archive HEAD | tar -x -C "$T/intr/tree" && (cd "$T/intr/tree" && python3 -E app.py 2>&1))"
    [ "$ran" = hi ] || why="${why}the committed tree does not run: $(printf '%s' "$ran" | tail -n 1); "
    PROOF_ID_SAVED="$PROOF_ID"
    PROOF_ID="$(cat "$I/.loki/state/last-proof-id.txt" 2>/dev/null)"
    IPJ="$I/.loki/proofs/$PROOF_ID/proof.json"
    if [ -z "$PROOF_ID" ] || [ ! -f "$IPJ" ]; then
        why="${why}no session-2 receipt (last-proof-id.txt='$PROOF_ID'); "
    else
        # A resume keeps the run id, so bind the receipt by its head commit.
        python3 -E -c 'import json, sys
d = json.load(open(sys.argv[1]))
print("head_sha", ((d.get("facts") or {}).get("git") or {}).get("head_sha"))
for f in (d.get("files_changed") or {}).get("files") or []:
    print(f.get("path"))' "$IPJ" > "$T/log/intr-receipt.txt" 2>/dev/null
        grep -qx "head_sha $(gi rev-parse HEAD 2>/dev/null)" "$T/log/intr-receipt.txt" \
            || why="${why}the receipt is not bound to session 2's commit ($(head -n 1 "$T/log/intr-receipt.txt")); "
        for f in helper.py test_helper.py app.py; do
            grep -qx "$f" "$T/log/intr-receipt.txt" || why="${why}the receipt does not list $f ($(tr '\n' ',' < "$T/log/intr-receipt.txt")); "
        done
        grep -qx 'AFTER.local.txt' "$T/log/intr-receipt.txt" \
            && why="${why}the receipt lists the user's AFTER.local.txt; "
        i_routes="bash"
        if command -v bun >/dev/null 2>&1; then
            i_routes="bun bash"
        else
            why="${why}prerequisite missing: bun (Bun route not verified); "
        fi
        for r in $i_routes; do
            run_verify "$r" "$r-intr" "$I"; rc=$?
            f="$(report_fields "$T/log/verify-$r-intr.out")"
            [ "$rc" -eq 0 ] && [ "$f" = "True True" ] \
                || why="${why}$r route: proof verify $PROOF_ID rc=$rc report=[$f]; "
        done
    fi
    PROOF_ID="$PROOF_ID_SAVED"
    if gi checkout -q main 2>"$T/log/intr-checkout2.err"; then
        grep -qF "$SENTINEL3" "$I/AFTER.local.txt" 2>/dev/null \
            || why="${why}AFTER.local.txt is gone or changed after checkout of main; "
    else
        why="${why}could not switch back to main after session 2: $(head -c 160 "$T/log/intr-checkout2.err" | tr '\n' ' '); "
    fi
fi
why="${why}${I_REC_WHY:-}"
if [ -z "$why" ]; then
    pass "$id" "an interrupted session's helper.py and test_helper.py were committed on $I2_BRANCH by the resumed session (the committed tree runs) and listed in its receipt, which verifies on bun and bash routes; the user's file made after the interrupt was not committed and survives checkout of main"
else
    fail "$id" "$why"
fi

echo "INFO P6 total_seconds=$(( $(date +%s) - T_START )) pipeline_seconds=$RUN_SECS"
exit 0
