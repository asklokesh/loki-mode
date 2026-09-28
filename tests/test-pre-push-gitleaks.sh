#!/usr/bin/env bash
# Asserts the pre-push hook's eval-fixture gitleaks step (E-86).
#
# CI's Security Audit gitleaks gate (git-log mode, full history) only runs
# AFTER a push already landed, and a false positive there (sourcegraph-access-
# token on eval/loki10/tasks/pub-werkzeug-3271/task.json:8, blocking v10.2.0,
# run 36440534022) is exactly the class of finding this hook step catches
# locally, before the push. Cases:
#
#   1. a task.json with a sourcegraph.com URL + a 40-hex ref is refused
#   2. the same, with its dir-mode fingerprint in .gitleaksignore, passes
#   3. a push touching no eval/loki10/tasks or eval/loki10/refdiff file skips
#      without invoking gitleaks at all
#   4. eval files changed but the pinned gitleaks v8.30.0 is unavailable
#      (HOME pointed at a scratch dir with no pinned install; PATH may still
#      carry an off-pin gitleaks, e.g. Homebrew's 8.30.1, which must not
#      satisfy the version-exact-match check) -> refused, with the install
#      command
#   5. pushing a brand-new branch (remote sha all zeros) that IS the checked-
#      out branch, adding a secret-shaped task.json, is refused. Regression
#      guard: an earlier version of this step computed the new-branch diff
#      base as `git merge-base $local_sha HEAD`, but pushing your own checked-
#      out branch means local_sha == HEAD, so that merge-base is always
#      local_sha itself and the diff against it is always empty -- a fail-open
#      that skipped the scan on the single most common new-branch push.
#   6. deleting a ref (local sha all zeros) is allowed and never invokes
#      gitleaks, even when eval files existed on the now-deleted branch.
#   7. eval changes on a ref that is NOT the one currently checked out are
#      scanned (from the pushed commit, not the working tree -- see r2 below)
#      and refused on the finding, same as case 1.
#
# r2 rework (Opus REJECT on 9c8447b1, reproduced with a real `git push` and
# the real pinned gitleaks 8.30.0): the scan now reads the PUSHED COMMIT's
# committed blobs (`git archive "$_lsha"` into a throwaway dir), not the
# working tree, and the pinned gitleaks binary is trusted only when a sidecar
# checksum recorded at install time still matches its bytes. Cases 8-12 are
# real-`git push`-to-a-real-bare-remote fixtures (core.hooksPath, non-
# stdin-fed) covering exactly the four fail-open bugs that rejection found,
# plus the exit-code and sidecar-mismatch behavior that fix required:
#   8.  a non-ASCII task dir name (e.g. an accented character) is scanned,
#       not silently skipped by `cut`'s misparse of git's quoted diff output
#   9.  a force-push whose remote sha was never fetched locally is scanned
#       (fallback to merge-base with the remote-tracking main), not read as
#       "no eval changes" because `git diff` on an unknown sha failed
#   10. a secret committed then "cleaned" only in the working tree (never
#       recommitted) is still caught, because the scan reads the commit
#   11. a gitleaks exit code other than 0 or 1 is reported as "gitleaks
#       failed (exit N)", not misreported as a found secret -- still refused
#   12. a pinned binary whose sidecar checksum no longer matches its bytes is
#       treated as not installed, not trusted on `gitleaks version` alone
#
# Cases 13-14 cover the fourth bug (scripts/install-gitleaks.sh), network-free
# by pointing the installer's LOKI_GITLEAKS_BASE_URL at a local `file://`
# fixture instead of the real GitHub release:
#   13. a `file://` origin serving a fake tarball is refused before
#       extraction, the fake binary is never executed or installed, and the
#       refusal message includes the actual (wrong) hash -- proving the
#       fixture origin was really used, not silently skipped in favor of a
#       real download
#   14. a pinned binary with no (or a mismatched) sidecar is reinstalled and
#       re-verified, never trusted on `gitleaks version` alone the way
#       9c8447b1's installer trusted it
#
# LOKI_TEST_INSTALLER_OLD, if set, points at a checked-out pre-r2 copy of
# scripts/install-gitleaks.sh; case 14 runs it too and asserts it reproduces
# the "already installed" fail-open (red-first evidence). Unset, only the
# real installer at scripts/install-gitleaks.sh is asserted. Case 13 has no
# equivalent old-script rung: 9c8447b1's installer does not read
# LOKI_GITLEAKS_BASE_URL at all (it hardcodes the GitHub URL), so there is no
# network-free way to point it at this fixture; its red-first evidence is a
# manual repro (sed-patch the base URL, verify EVIL_EXECUTED), not this test.
#
# Cases 1, 2, 5, 7, 8, 9 and 10 need the real pinned gitleaks v8.30.0 to be
# meaningful -- a stub binary could not reproduce the actual rule engine's
# behavior. When it is not installed at $HOME/.local/share/loki/bin/
# gitleaks-8.30.0 WITH a matching sidecar checksum, those cases print SKIP
# and are not counted as pass. Cases 3, 4, 6, 11, 12, 13 and 14 need no real
# gitleaks rule engine (11-14 use stub/fixture binaries) and always run for
# real, except case 13's two assertions, which SKIP on an unsupported
# OS/arch combination (none exist for this repo's supported platforms).
#
# LOKI_TEST_HOOK_OVERRIDE lets a caller point this test at a different hook
# file (e.g. a checked-out pre-E-86 copy) to demonstrate red-then-green;
# unset, it asserts the real hook at .githooks/pre-push as normal.
#
# r3 rework (Opus re-review of 4e882432, reproduced with real pushes): the
# scan covered only the pushed TIP's tree, so a secret added in one commit
# and removed again (file deleted, or edited clean) by a LATER commit of the
# SAME push was never scanned locally, yet it lands in the remote's history
# and CI's git-log-mode gitleaks flags it only afterward. Every commit in the
# pushed range is now archived and scanned from its own tree. Cases 15-21:
#   15 (N1a). added-then-deleted-later secret: refused, naming the add commit
#   16 (N1b). added-then-edited-clean-later secret: refused, same as N1a
#   17. a clean multi-commit push (no secret in any commit) passes
#   18. a merge commit bringing in a secret (not present on either parent's
#       tip alone from the base) is refused
#   19. an added .gitleaksignore line prints a WARNING, not a refusal
#   20. a .gitleaks.toml adding a global ('.*') allowlist is refused unless
#       LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1, and passes with it set
#   21. a single commit with 2,000 changed eval files completes (chunked
#       `git archive`, not one `Argument list too long` call)
#
# E-99 rework (E-86 round-4 review C1, real production incident: a release
# train refused at 18:26Z on an already-reviewed false positive that a
# MERGED OLDER branch commit's own, pre-dated .gitleaksignore did not yet
# allowlist, while CI -- which scans the whole pushed range against ONE
# ignore file, the tip's -- passed): every commit is now scanned against the
# PUSHED TIP's .gitleaksignore / .gitleaks.toml (`git show "$_lsha:..."`),
# not each commit's own. GITLEAKS_CONFIG / GITLEAKS_CONFIG_TOML are unset
# before invoking gitleaks. The .gitleaks.toml refusal is no longer scoped
# to an eval-touching push. The pinned binary is now also checked against a
# sha256 hardcoded per-platform in this hook's own git history, not only its
# sidecar. Cases 22, 23, 26 and 11 are updated to match (behavior legitimately
# changed); 29 and 30 are new:
#   22. a .gitleaks.toml-only change (no eval touch) is NOW refused too,
#       same as a change that also touches eval (was: allowed -- r4 scoped
#       the refusal to eval-touching pushes; a config change is dangerous on
#       its own merits, independent of what else this push touches)
#   26. a .gitleaksignore line added in commit 1 and removed again in commit
#       2 of the SAME push is NOW refused (was: passed) -- commit 1's secret
#       is scanned against the TIP's .gitleaksignore, which no longer has
#       the suppressing line, matching what CI's git-log-mode scan would find
#   11. repurposed: a binary whose sha256 differs from the hardcoded
#       per-platform value never runs, even with a self-computed sidecar
#       that matches it byte-for-byte (a sidecar match alone was the old bar)
#   29. the production incident itself, reproduced: a merge bringing in an
#       old branch commit whose own .gitleaksignore lacks an entry passes
#       when the pushed TIP's .gitleaksignore has it
#   30. GITLEAKS_CONFIG pointing at a permissive config (outside the repo)
#       is ignored -- the hook unsets it before invoking gitleaks

set -uo pipefail

unset LOKI_RELEASE_MANAGER PRE_PUSH_SKIP

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="${LOKI_TEST_HOOK_OVERRIDE:-$REPO_ROOT/.githooks/pre-push}"
GITLEAKS_VERSION="8.30.0"
REAL_GITLEAKS="$HOME/.local/share/loki/bin/gitleaks-${GITLEAKS_VERSION}"
REAL_GITLEAKS_SIDECAR="${REAL_GITLEAKS}.sha256"

passed=0
failed=0
skipped=0

ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }
sk() { echo "  SKIP: $1"; skipped=$((skipped + 1)); }

echo "TEST: pre-push hook eval-fixture gitleaks step (E-86)"

[[ -f "$HOOK" ]] || { echo "  FAIL: hook not found at $HOOK"; exit 1; }

_sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# The hook (r2 rework) trusts the pinned path ONLY when its sidecar checksum
# (written by scripts/install-gitleaks.sh at install time) matches the bytes
# on disk right now -- `gitleaks version` alone is not proof of which binary
# is actually there. This test's own "real gitleaks" cases must apply the
# same bar, or a machine with the pinned binary but no sidecar (or a stale
# one) would silently make cases 1/2/5/etc. exercise the "not installed"
# path instead of the real scanner.
_have_real_gitleaks=0
if [[ -x "$REAL_GITLEAKS" ]] && [[ -f "$REAL_GITLEAKS_SIDECAR" ]] \
   && [[ "$(cat "$REAL_GITLEAKS_SIDECAR" 2>/dev/null)" == "$(_sha256_of "$REAL_GITLEAKS")" ]] \
   && [[ "$("$REAL_GITLEAKS" version 2>/dev/null)" == "$GITLEAKS_VERSION" ]]; then
    _have_real_gitleaks=1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-prepush-gl-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

_fake_home="$SCRATCH/fake-home"; mkdir -p "$_fake_home"
_zero_sha="0000000000000000000000000000000000000000"

# Every git in this test must act on a scratch clone -- never the real repo.
g() {
    local d="$1"; shift
    case "$d" in
        "$SCRATCH"/*) : ;;
        *) echo "  FATAL: refusing git outside scratch: $d" >&2; exit 1 ;;
    esac
    git -C "$d" "$@"
}

# Builds a scratch repo with a base commit (autonomy/run.sh + autonomy/loki so
# the hook's other checks stay green), and the .gitleaksignore this repo
# already ships (case 2 needs the real baseline entries, not a hand-written
# subset).
setup_clone() {
    local dir="$1"
    rm -rf "$dir"; mkdir -p "$dir/autonomy"
    cd "$dir" || return 1

    git init -q .
    git -C "$dir" config user.name asklokesh
    git -C "$dir" config user.email lokeshmure@live.com
    git -C "$dir" config commit.gpgsign false

    mkdir -p .githooks && cp "$HOOK" .githooks/pre-push
    echo 'true' > autonomy/run.sh
    echo 'true' > autonomy/loki
    cp "$REPO_ROOT/.gitleaksignore" .gitleaksignore

    git -C "$dir" add -A >/dev/null 2>&1
    git -C "$dir" commit -q -m base --no-verify >/dev/null 2>&1
    git -C "$dir" branch -f main HEAD >/dev/null 2>&1
    git -C "$dir" remote add origin . >/dev/null 2>&1
    git -C "$dir" update-ref refs/remotes/origin/main HEAD
}

# Runs the hook the way git actually invokes it, with an arbitrary stdin line.
# Extra env vars (KEY=VALUE ...) are exported for the duration of the call, so
# a case can override HOME without leaking it to the rest of this test.
run_hook_raw() {
    local dir="$1" stdin_line="$2"; shift 2
    cd "$dir" || return 1
    # shellcheck disable=SC2163
    [[ $# -gt 0 ]] && export "$@"
    printf '%s\n' "$stdin_line" \
        | PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 bash .githooks/pre-push origin https://github.com/asklokesh/loki-mode \
              >"$dir/hook.out" 2>&1
    local rc=$?
    for kv in "$@"; do unset "${kv%%=*}"; done
    echo "RC=$rc"
}

# The common case: a normal (not new-branch, not delete) push of refs/heads/main
# from the scratch remote-tracking ref set in setup_clone to current HEAD.
run_hook() {
    local dir="$1"; shift
    local old_sha new_sha
    old_sha="$(git -C "$dir" rev-parse refs/remotes/origin/main)"
    new_sha="$(git -C "$dir" rev-parse HEAD)"
    run_hook_raw "$dir" "refs/heads/main $new_sha refs/heads/main $old_sha" "$@"
}

# The 40-hex ref is built from two adjacent quoted literals, not one
# contiguous string: a single 40-hex run next to this file's own
# "sourcegraph.com" text arms gitleaks' sourcegraph-access-token rule on the
# TEST SOURCE itself (reproduced: 9c8447b1:tests/test-pre-push-gitleaks.sh:141).
# The generated task.json below still gets one unbroken 40-hex value at
# runtime, which is what needs to be secret-shaped for the fixtures.
_fake_ref='1234567890abcdef1234567890abcdef''12345678'
_task_json_secret="$(printf '%s\n' '{' \
  '  "id": "fake-task",' \
  '  "prompt": "See https://sourcegraph.com/search?q=foo for details",' \
  '  "repo": {' \
  "    \"ref\": \"$_fake_ref\"" \
  '  }' \
  '}')"

# --- real-remote push fixtures (r2 rework regression cases) -------------------
# The stdin-fed run_hook above simulates git's invocation; these cases instead
# do a REAL `git push` to a real bare remote with core.hooksPath set, so the
# hook is discovered and invoked exactly the way git does it (a non-executable
# hook is silently skipped by git -- these prove it is not).

# A bare remote, scoped to $SCRATCH like every other git object in this file.
setup_bare() {
    local bare="$1"
    git init -q --bare "$bare" >/dev/null 2>&1
}

# Same base fixture as setup_clone, but wired to push to a real bare remote
# via core.hooksPath instead of a plain `git remote add origin .`.
setup_push_clone() {
    local dir="$1" bare="$2"
    rm -rf "$dir"; mkdir -p "$dir/autonomy"
    cd "$dir" || return 1

    git init -q .
    git -C "$dir" config user.name asklokesh
    git -C "$dir" config user.email lokeshmure@live.com
    git -C "$dir" config commit.gpgsign false
    git -C "$dir" config core.hooksPath .githooks

    mkdir -p .githooks && cp "$HOOK" .githooks/pre-push
    chmod +x .githooks/pre-push
    echo 'true' > autonomy/run.sh
    echo 'true' > autonomy/loki
    cp "$REPO_ROOT/.gitleaksignore" .gitleaksignore

    git -C "$dir" add -A >/dev/null 2>&1
    git -C "$dir" commit -q -m base --no-verify >/dev/null 2>&1
    git -C "$dir" branch -M main >/dev/null 2>&1
    git -C "$dir" remote add origin "$bare" >/dev/null 2>&1
    # Base push: no eval files yet, establishes the remote tip. Runs the real
    # hook once already (clean), which is fine. LOKI_ALLOW_UNSCANNED_PUSH=1:
    # this base push is not itself under test, so it must not depend on
    # whether the pinned gitleaks binary happens to be installed here (E-110's
    # full-push scan now runs on every push, including this one). Checked
    # loudly: a silently-swallowed failure here used to leave the remote
    # empty, turning every later real_push in a no-binary environment into a
    # confusing new-branch push (base commit + all) instead of an update.
    local _base_push_log="${dir}.base-push.log"
    if ! (cd "$dir" && PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 LOKI_ALLOW_UNSCANNED_PUSH=1 git push -q origin main) >"$_base_push_log" 2>&1; then
        echo "  FATAL: setup_push_clone's base push failed for $dir: $(cat "$_base_push_log")" >&2
        exit 1
    fi
}

# Pushes the clone's current main to its bare remote for real. Extra env vars
# (KEY=VALUE ...) are exported for the duration, same contract as
# run_hook_raw. Trailing args after `--` are extra `git push` flags (e.g.
# --force).
real_push() {
    local dir="$1"; shift
    local -a extra_env=()
    while [[ $# -gt 0 && "$1" != "--" ]]; do extra_env+=("$1"); shift; done
    [[ "${1:-}" == "--" ]] && shift
    local -a push_args=("$@")
    cd "$dir" || return 1
    # shellcheck disable=SC2163
    # bash 3.2 (macOS's /bin/bash): "${arr[@]}" on a genuinely empty array is
    # an unbound-variable error under `set -u`, so every expansion of
    # push_args/extra_env below uses the ${arr[@]+"${arr[@]}"} guard.
    [[ ${#extra_env[@]} -gt 0 ]] && export "${extra_env[@]}"
    (cd "$dir" && PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 git push origin main ${push_args[@]+"${push_args[@]}"}) \
        >"$dir/push.out" 2>&1
    local rc=$?
    for kv in ${extra_env[@]+"${extra_env[@]}"}; do unset "${kv%%=*}"; done
    echo "RC=$rc"
}

# --- case 1: a task.json with a sourcegraph.com URL + 40-hex ref is refused ---
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c1"; setup_clone "$D"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "add fake task with a secret-shaped fixture" --no-verify >/dev/null 2>&1
    rc="$(run_hook "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "task.json with sourcegraph.com URL + 40-hex ref is refused" "hook exited 0; out: $(cat "$D/hook.out")"
    elif grep -q "sourcegraph-access-token" "$D/hook.out" && grep -q "gitleaks found a possible secret" "$D/hook.out"; then
        ok "task.json with sourcegraph.com URL + 40-hex ref is refused"
    else
        ko "task.json with sourcegraph.com URL + 40-hex ref is refused" "refused but not on the finding: $(cat "$D/hook.out")"
    fi
    if grep -qE '^(Secret|Finding):.*[0-9a-f]{20}' "$D/hook.out"; then
        ko "refusal never prints the raw secret" "hook.out contains an unredacted-looking value"
    else
        ok "refusal never prints the raw secret"
    fi
else
    sk "task.json with sourcegraph.com URL + 40-hex ref is refused (no pinned gitleaks v${GITLEAKS_VERSION})"
    sk "refusal never prints the raw secret (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 2: same finding, fingerprint in .gitleaksignore, passes -------------
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c2"; setup_clone "$D"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    printf '%s\n' "eval/loki10/tasks/fake-task/task.json:sourcegraph-access-token:5" >> "$D/.gitleaksignore"
    g "$D" add eval/loki10/tasks/fake-task/task.json .gitleaksignore >/dev/null 2>&1
    g "$D" commit -q -m "add fake task, pre-allowlisted" --no-verify >/dev/null 2>&1
    rc="$(run_hook "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ok "same finding with its fingerprint in .gitleaksignore passes"
    else
        ko "same finding with its fingerprint in .gitleaksignore passes" "$rc; out: $(cat "$D/hook.out")"
    fi
else
    sk "same finding with its fingerprint in .gitleaksignore passes (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 3 (E-110 rework): a push touching no eval file skips the eval-only
# `dir`-mode step, but IS covered by the broadened full-push `gitleaks git`
# scan (E-110's whole point: the eval-only scan never saw the 3 planted
# secrets in tests/test-eval-archive.sh, a non-eval path). HOME points at
# the empty fake home (no pinned gitleaks) so this is deterministic on every
# machine, including one with a real install: a hook that refused whenever
# gitleaks was merely absent would still look like it passed here if a real
# binary happened to be present locally. With no binary and no override, the
# push is now refused (default fail-closed, matching the eval scan's own
# missing-binary behavior); LOKI_ALLOW_UNSCANNED_PUSH=1 opts back in to the
# pre-E-110 "let it through" behavior for this rare case.
D="$SCRATCH/c3"; setup_clone "$D"
echo "unrelated change" >> "$D/autonomy/run.sh"
g "$D" add autonomy/run.sh >/dev/null 2>&1
g "$D" commit -q -m "unrelated change" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D" "HOME=$_fake_home")"
if [[ "$rc" == "RC=0" ]]; then
    ko "push touching no eval file with no gitleaks binary is refused" "hook exited 0; out: $(cat "$D/hook.out")"
elif grep -q "cannot run the full-push secret scan" "$D/hook.out" && grep -q "scripts/install-gitleaks.sh" "$D/hook.out"; then
    ok "push touching no eval file with no gitleaks binary is refused"
else
    ko "push touching no eval file with no gitleaks binary is refused" "refused but wrong message: $(cat "$D/hook.out")"
fi
if grep -q "gitleaks dir" "$D/hook.out"; then
    ko "push touching no eval file never invokes the eval-only dir-mode step" "hook.out: $(cat "$D/hook.out")"
else
    ok "push touching no eval file never invokes the eval-only dir-mode step"
fi

_t0=$(date +%s)
rc="$(run_hook "$D" "HOME=$_fake_home" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
_t1=$(date +%s)
if [[ "$rc" != "RC=0" ]]; then
    ko "the same push passes with LOKI_ALLOW_UNSCANNED_PUSH=1" "$rc; out: $(cat "$D/hook.out")"
else
    ok "the same push passes with LOKI_ALLOW_UNSCANNED_PUSH=1"
fi
# `date +%s` has 1s resolution: `%N` is GNU-only and prints a literal "N" on
# BSD/macOS date, so it is not a portable way to get sub-second timing here.
_elapsed=$((_t1 - _t0))
if [[ $_elapsed -le 2 ]]; then
    ok "push touching no eval file completes fast (${_elapsed}s, 1s resolution)"
else
    ko "push touching no eval file completes fast" "${_elapsed}s"
fi

# --- case 4: eval files changed but pinned gitleaks is missing -> refused ----
D="$SCRATCH/c4"; setup_clone "$D"
mkdir -p "$D/eval/loki10/tasks/fake-task"
echo '{"id": "fake-task"}' > "$D/eval/loki10/tasks/fake-task/task.json"
g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "add fake task" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D" "HOME=$_fake_home")"
if [[ "$rc" == "RC=0" ]]; then
    ko "eval change with pinned gitleaks missing is refused" "hook exited 0; out: $(cat "$D/hook.out")"
elif grep -q "gitleaks v${GITLEAKS_VERSION} is not installed" "$D/hook.out" && grep -q "scripts/install-gitleaks.sh" "$D/hook.out"; then
    ok "eval change with pinned gitleaks missing is refused, with the install command"
else
    ko "eval change with pinned gitleaks missing is refused, with the install command" "refused but wrong message: $(cat "$D/hook.out")"
fi

# --- case 5: new-branch push of the checked-out branch (fail-open regression) -
# Regression guard: computing the new-branch diff base as
# `merge-base $local_sha HEAD` is always a no-op diff when you push the
# branch you have checked out, because local_sha == HEAD in that case.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c5"; setup_clone "$D"
    g "$D" checkout -q -b feat >/dev/null 2>&1
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "new branch adding a secret-shaped fixture" --no-verify >/dev/null 2>&1
    _feat_sha="$(g "$D" rev-parse HEAD)"
    rc="$(run_hook_raw "$D" "refs/heads/feat $_feat_sha refs/heads/feat $_zero_sha")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "new-branch push of the checked-out branch is scanned and refused" "hook exited 0 (fail-open); out: $(cat "$D/hook.out")"
    elif grep -q "sourcegraph-access-token" "$D/hook.out" && grep -q "gitleaks found a possible secret" "$D/hook.out"; then
        ok "new-branch push of the checked-out branch is scanned and refused"
    else
        ko "new-branch push of the checked-out branch is scanned and refused" "refused but not on the finding: $(cat "$D/hook.out")"
    fi
else
    sk "new-branch push of the checked-out branch is scanned and refused (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 6: deleting a ref is allowed and never invokes gitleaks -------------
D="$SCRATCH/c6"; setup_clone "$D"
_base_sha="$(g "$D" rev-parse HEAD)"
rc="$(run_hook_raw "$D" "(delete) $_zero_sha refs/heads/feat $_base_sha" "HOME=$_fake_home")"
if [[ "$rc" != "RC=0" ]]; then
    ko "deleting a ref is allowed" "$rc; out: $(cat "$D/hook.out")"
else
    ok "deleting a ref is allowed"
fi
if grep -q "gitleaks dir" "$D/hook.out"; then
    ko "deleting a ref never invokes gitleaks" "hook.out: $(cat "$D/hook.out")"
else
    ok "deleting a ref never invokes gitleaks"
fi

# --- case 7: eval changes on a ref that is NOT the one checked out ------------
# r2 rework: this step now scans the PUSHED COMMIT's committed blobs (`git
# archive "$_lsha"`), not the working tree, so a ref other than the one
# checked out is no longer a special case -- it is scanned and refused on its
# own finding exactly like case 1. This regression-guards that the old "not
# checked out" refusal path is really gone (checking out `main` here would
# make a working-tree-based scan silently see nothing at that path) and that
# the finding is still caught by construction from the commit alone.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c7"; setup_clone "$D"
    g "$D" checkout -q -b feat2 >/dev/null 2>&1
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "eval change on feat2" --no-verify >/dev/null 2>&1
    _feat2_sha="$(g "$D" rev-parse HEAD)"
    g "$D" checkout -q main >/dev/null 2>&1
    rc="$(run_hook_raw "$D" "refs/heads/feat2 $_feat2_sha refs/heads/feat2 $_zero_sha")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "eval change on a non-checked-out ref is scanned from its commit and refused" "hook exited 0; out: $(cat "$D/hook.out")"
    elif grep -q "sourcegraph-access-token" "$D/hook.out" && grep -q "gitleaks found a possible secret" "$D/hook.out"; then
        ok "eval change on a non-checked-out ref is scanned from its commit and refused"
    else
        ko "eval change on a non-checked-out ref is scanned from its commit and refused" "refused but not on the finding: $(cat "$D/hook.out")"
    fi
    if grep -q "is not checked out" "$D/hook.out"; then
        ko "the old not-checked-out refusal path is gone" "hook.out still contains it: $(cat "$D/hook.out")"
    else
        ok "the old not-checked-out refusal path is gone"
    fi
else
    sk "eval change on a non-checked-out ref is scanned from its commit and refused (no pinned gitleaks v${GITLEAKS_VERSION})"
    sk "the old not-checked-out refusal path is gone (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 8 (bug 1, real remote): non-ASCII task dir name is scanned, not skipped
# Before the fix: `git diff --name-only` quotes a non-ASCII path (C-style
# escaping), `cut -d/ -f1-4` of the quoted text does not match any real path
# on disk, and `[[ -e ]] || continue` silently skipped it -- a real `git push`
# of a secret sitting in an accented directory name shipped clean.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c8"; BARE="$SCRATCH/c8.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    _accented_dir=$'caf\xc3\xa9-with-accent'
    mkdir -p "$D/eval/loki10/tasks/$_accented_dir"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/$_accented_dir/task.json"
    g "$D" add "eval/loki10/tasks/$_accented_dir/task.json" >/dev/null 2>&1
    g "$D" commit -q -m "add non-ascii task dir with a secret-shaped fixture" --no-verify >/dev/null 2>&1
    # A dedicated TMPDIR so the hook's own scratch dirs
    # (loki-prepush-eval.*/loki-prepush-diff.*) can be checked for leftovers
    # afterward, isolated from anything else on the machine's real temp dir.
    _c8_tmp="$SCRATCH/c8-tmp"; mkdir -p "$_c8_tmp"
    rc="$(real_push "$D" "TMPDIR=$_c8_tmp")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "non-ASCII task dir is scanned, not silently skipped" "push succeeded; out: $(cat "$D/push.out")"
    elif grep -q "\[pre-push\]" "$D/push.out" \
       && grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "gitleaks found a possible secret" "$D/push.out"; then
        ok "non-ASCII task dir is scanned, not silently skipped"
    else
        ko "non-ASCII task dir is scanned, not silently skipped" "refused but not on the finding: $(cat "$D/push.out")"
    fi
    if [[ -z "$(find "$_c8_tmp" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
        ok "the hook's own scratch dirs are cleaned up on exit"
    else
        ko "the hook's own scratch dirs are cleaned up on exit" "leftovers: $(ls -la "$_c8_tmp")"
    fi
else
    sk "non-ASCII task dir is scanned, not silently skipped (no pinned gitleaks v${GITLEAKS_VERSION})"
    sk "the hook's own scratch dirs are cleaned up on exit (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 9 (bug 2, real remote): force-push over an unfetched remote tip ----
# Clone A pushes an innocuous commit, moving the bare remote's main tip to a
# sha clone B never fetches. Clone B, still on the earlier base, commits a
# secret-shaped fixture and force-pushes. git's pre-push hook receives the
# REAL current remote tip on stdin -- a sha clone B does not have as a local
# object. Before the fix: `git diff "$_rsha" "$_lsha"` failed and `|| true`
# read that as "no eval changes".
if [[ "$_have_real_gitleaks" == "1" ]]; then
    BARE="$SCRATCH/c9.git"; setup_bare "$BARE"
    A="$SCRATCH/c9-a"; setup_push_clone "$A" "$BARE"
    B="$SCRATCH/c9-b"
    git clone -q "$BARE" "$B" >/dev/null 2>&1
    git -C "$B" config user.name asklokesh
    git -C "$B" config user.email lokeshmure@live.com
    git -C "$B" config commit.gpgsign false
    git -C "$B" config core.hooksPath .githooks
    mkdir -p "$B/.githooks" && cp "$HOOK" "$B/.githooks/pre-push" && chmod +x "$B/.githooks/pre-push"
    git -C "$B" checkout -q -b feature >/dev/null 2>&1

    echo "unrelated change from clone A" >> "$A/autonomy/run.sh"
    g "$A" add autonomy/run.sh >/dev/null 2>&1
    g "$A" commit -q -m "unrelated change, moves remote tip" --no-verify >/dev/null 2>&1
    real_push "$A" >/dev/null 2>&1
    _remote_tip="$(g "$A" rev-parse main)"
    if git -C "$B" cat-file -e "$_remote_tip" 2>/dev/null; then
        ko "force-push over an unfetched remote tip is scanned and refused" "setup invalid: clone B already has the remote tip"
    else
        mkdir -p "$B/eval/loki10/tasks/fake-task"
        printf '%s\n' "$_task_json_secret" > "$B/eval/loki10/tasks/fake-task/task.json"
        git -C "$B" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
        git -C "$B" commit -q -m "force-pushed secret-shaped fixture" --no-verify >/dev/null 2>&1
        (cd "$B" && PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 git push -q --force origin feature:main) \
            >"$B/push.out" 2>&1
        rc="RC=$?"
        if [[ "$rc" == "RC=0" ]]; then
            ko "force-push over an unfetched remote tip is scanned and refused" "push succeeded; out: $(cat "$B/push.out")"
        elif grep -q "\[pre-push\]" "$B/push.out" \
           && grep -q "sourcegraph-access-token" "$B/push.out" && grep -q "gitleaks found a possible secret" "$B/push.out"; then
            ok "force-push over an unfetched remote tip is scanned and refused"
        else
            ko "force-push over an unfetched remote tip is scanned and refused" "refused but not on the finding: $(cat "$B/push.out")"
        fi
    fi
else
    sk "force-push over an unfetched remote tip is scanned and refused (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 10 (bug 3, real remote): uncommitted working-tree edit cannot mask
# a committed secret. Commit a secret-shaped fixture, then locally overwrite
# the working-tree copy with clean content WITHOUT committing, then push.
# The commit being pushed still has the secret blob; before the fix, `dir`
# mode scanned the working tree (now clean) and never saw it.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c10"; BARE="$SCRATCH/c10.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "add fake task with a secret-shaped fixture" --no-verify >/dev/null 2>&1
    echo '{"id": "fake-task", "prompt": "nothing to see here"}' > "$D/eval/loki10/tasks/fake-task/task.json"
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "uncommitted working-tree edit cannot mask a pushed commit's secret" "push succeeded; out: $(cat "$D/push.out")"
    elif grep -q "\[pre-push\]" "$D/push.out" \
       && grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "gitleaks found a possible secret" "$D/push.out"; then
        ok "uncommitted working-tree edit cannot mask a pushed commit's secret"
    else
        ko "uncommitted working-tree edit cannot mask a pushed commit's secret" "refused but not on the finding: $(cat "$D/push.out")"
    fi
    # The working tree's OWN cleaned copy stays on disk after the (refused)
    # push -- confirms the fixture was real, not accidentally committed.
    if grep -q "nothing to see here" "$D/eval/loki10/tasks/fake-task/task.json" 2>/dev/null; then
        ok "the working-tree copy scanned was genuinely different from the pushed commit"
    else
        ko "the working-tree copy scanned was genuinely different from the pushed commit" "fixture setup did not hold"
    fi
else
    sk "uncommitted working-tree edit cannot mask a pushed commit's secret (no pinned gitleaks v${GITLEAKS_VERSION})"
    sk "the working-tree copy scanned was genuinely different from the pushed commit (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 11 (E-99): a binary whose sha256 differs from the hardcoded ------
# per-platform value never runs, even with a SELF-COMPUTED sidecar that
# matches it byte-for-byte. A sidecar is just a file sitting next to the
# binary -- whatever can overwrite gitleaks-8.30.0 can overwrite
# gitleaks-8.30.0.sha256 to match, so a sidecar match alone was never proof
# of which binary is really there (this is what the pre-E-99 hook trusted:
# case 11 used to be "a stub with a matching sidecar reports its own exit
# code", which a swapped-binary attack would have exploited exactly the same
# way). _resolve_gitleaks_bin now also checks the binary's own bytes against
# a value hardcoded in this hook's git history. The stub writes a marker if
# it is executed at all, proving "never runs", not merely "output ignored".
D="$SCRATCH/c11"; BARE="$SCRATCH/c11.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
_stub_home="$SCRATCH/c11-home"
_stub_bin_dir="$_stub_home/.local/share/loki/bin"
mkdir -p "$_stub_bin_dir"
_stub_bin="$_stub_bin_dir/gitleaks-${GITLEAKS_VERSION}"
_stub_marker="$SCRATCH/c11-executed.txt"
cat > "$_stub_bin" <<STUB
#!/usr/bin/env bash
echo "EXECUTED" > "$_stub_marker"
case "\$1" in
    version) echo "8.30.0" ;;
    *) exit 2 ;;
esac
STUB
chmod +x "$_stub_bin"
_sha256_of "$_stub_bin" > "${_stub_bin}.sha256"
mkdir -p "$D/eval/loki10/tasks/fake-task"
echo '{"id": "fake-task"}' > "$D/eval/loki10/tasks/fake-task/task.json"
g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "add fake task" --no-verify >/dev/null 2>&1
rc="$(real_push "$D" "HOME=$_stub_home")"
if [[ "$rc" == "RC=0" ]]; then
    ko "a binary whose sha256 differs from the hardcoded value never runs" "push succeeded; out: $(cat "$D/push.out")"
elif [[ -f "$_stub_marker" ]]; then
    ko "a binary whose sha256 differs from the hardcoded value never runs" "stub EXECUTED despite the hash mismatch; out: $(cat "$D/push.out")"
elif grep -q "gitleaks v${GITLEAKS_VERSION} is not installed" "$D/push.out"; then
    ok "a binary whose sha256 differs from the hardcoded value never runs"
else
    ko "a binary whose sha256 differs from the hardcoded value never runs" "refused but wrong message: $(cat "$D/push.out")"
fi

# --- case 12: a mismatched sidecar checksum is treated as not installed -----
# A pinned binary whose recorded sha256 no longer matches its bytes on disk
# (tampering, or a partial/corrupted overwrite) must not be trusted just
# because `gitleaks version` still answers correctly.
D="$SCRATCH/c12"; BARE="$SCRATCH/c12.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
_tamper_home="$SCRATCH/c12-home"
_tamper_bin_dir="$_tamper_home/.local/share/loki/bin"
mkdir -p "$_tamper_bin_dir"
_tamper_bin="$_tamper_bin_dir/gitleaks-${GITLEAKS_VERSION}"
cat > "$_tamper_bin" <<'STUB'
#!/usr/bin/env bash
echo "8.30.0"
STUB
chmod +x "$_tamper_bin"
echo "0000000000000000000000000000000000000000000000000000000000000000" > "${_tamper_bin}.sha256"
mkdir -p "$D/eval/loki10/tasks/fake-task"
echo '{"id": "fake-task"}' > "$D/eval/loki10/tasks/fake-task/task.json"
g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "add fake task" --no-verify >/dev/null 2>&1
rc="$(real_push "$D" "HOME=$_tamper_home")"
if [[ "$rc" == "RC=0" ]]; then
    ko "a mismatched sidecar checksum is treated as not installed" "push succeeded; out: $(cat "$D/push.out")"
elif grep -q "gitleaks v${GITLEAKS_VERSION} is not installed" "$D/push.out" && grep -q "scripts/install-gitleaks.sh" "$D/push.out"; then
    ok "a mismatched sidecar checksum is treated as not installed"
else
    ko "a mismatched sidecar checksum is treated as not installed" "refused but wrong message: $(cat "$D/push.out")"
fi

# --- case 13 (bug 4, network-free): swapped tarball+checksums is refused ----
# scripts/install-gitleaks.sh hardcodes the per-platform sha256, so it no
# longer downloads a checksums.txt at all -- there is nothing left for an
# attacker to swap. LOKI_GITLEAKS_BASE_URL (already read by the installer)
# points this at a local `file://` fixture standing in for a compromised or
# mirrored origin serving a fake tarball; the extraction is still gated on
# the value baked into the script, so this proves the origin cannot forge
# what "verified" means.
INSTALLER="$REPO_ROOT/scripts/install-gitleaks.sh"
_c13="$SCRATCH/c13"; mkdir -p "$_c13/fixture" "$_c13/home" "$_c13/marker"
case "$(uname -s)" in
    Darwin) _c13_os="darwin" ;;
    Linux) _c13_os="linux" ;;
    *) _c13_os="" ;;
esac
case "$(uname -m)" in
    arm64 | aarch64) _c13_arch="arm64" ;;
    x86_64 | amd64) _c13_arch="x64" ;;
    *) _c13_arch="" ;;
esac
if [[ -n "$_c13_os" && -n "$_c13_arch" ]]; then
    _c13_asset="gitleaks_${GITLEAKS_VERSION}_${_c13_os}_${_c13_arch}.tar.gz"
    cat > "$_c13/fixture/gitleaks" <<STUB
#!/usr/bin/env bash
echo "EVIL_EXECUTED" > "$_c13/marker/evil-executed.txt"
echo "$GITLEAKS_VERSION"
STUB
    chmod +x "$_c13/fixture/gitleaks"
    (cd "$_c13/fixture" && tar -czf "$_c13_asset" gitleaks) >/dev/null 2>&1
    _c13_actual="$(_sha256_of "$_c13/fixture/$_c13_asset")"
    LOKI_GITLEAKS_BASE_URL="file://$_c13/fixture" HOME="$_c13/home" bash "$INSTALLER" \
        >"$_c13/install.out" 2>&1
    _c13_rc=$?
    if [[ "$_c13_rc" == "0" ]]; then
        ko "swapped installer tarball is refused" "installer exited 0; out: $(cat "$_c13/install.out")"
    elif [[ -f "$_c13/marker/evil-executed.txt" ]]; then
        ko "swapped installer tarball is refused" "evil binary EXECUTED; out: $(cat "$_c13/install.out")"
    elif grep -q "checksum mismatch" "$_c13/install.out" && grep -qF "$_c13_actual" "$_c13/install.out"; then
        ok "swapped installer tarball is refused"
    else
        ko "swapped installer tarball is refused" "refused but wrong message: $(cat "$_c13/install.out")"
    fi
    if [[ -x "$_c13/home/.local/share/loki/bin/gitleaks-${GITLEAKS_VERSION}" ]]; then
        ko "swapped installer tarball is never installed" "binary present at pinned path"
    else
        ok "swapped installer tarball is never installed"
    fi
else
    sk "swapped installer tarball is refused (unsupported OS/arch: $(uname -s)/$(uname -m))"
    sk "swapped installer tarball is never installed (unsupported OS/arch: $(uname -s)/$(uname -m))"
fi

# --- case 14 (bug 4, network-free): a stale pinned binary with no/wrong -----
# sidecar is reinstalled, not trusted on `version` alone. Failing-first
# against 9c8447b1's installer directly: its "already installed" check was
# `-x BIN && version == GITLEAKS_VERSION`, no sidecar, so it would print
# "already installed" and exit 0 without ever reaching a checksum check.
_c14="$SCRATCH/c14"; mkdir -p "$_c14/home/.local/share/loki/bin"
_c14_bin="$_c14/home/.local/share/loki/bin/gitleaks-${GITLEAKS_VERSION}"
cat > "$_c14_bin" <<STUB
#!/usr/bin/env bash
echo "$GITLEAKS_VERSION"
STUB
chmod +x "$_c14_bin"
# No sidecar at all (the pre-sidecar-era install state this rework must
# force a re-verify of).
INSTALLER_OLD="${LOKI_TEST_INSTALLER_OLD:-}"
if [[ -n "$INSTALLER_OLD" ]]; then
    HOME="$_c14/home" bash "$INSTALLER_OLD" >"$_c14/install-old.out" 2>&1
    _c14_old_rc=$?
    if [[ "$_c14_old_rc" == "0" ]] && grep -q "already installed" "$_c14/install-old.out"; then
        ok "(red-first) 9c8447b1's installer trusts a stale binary with no sidecar"
    else
        ko "(red-first) 9c8447b1's installer trusts a stale binary with no sidecar" "$_c14_old_rc; out: $(cat "$_c14/install-old.out")"
    fi
fi
HOME="$_c14/home" LOKI_GITLEAKS_BASE_URL="file://$_c13/fixture" bash "$INSTALLER" \
    >"$_c14/install.out" 2>&1
_c14_rc=$?
if grep -q "already installed" "$_c14/install.out"; then
    ko "a stale binary with no sidecar is reinstalled, not trusted" "printed already-installed: $(cat "$_c14/install.out")"
elif [[ -n "$_c13_os" && -n "$_c13_arch" ]]; then
    if [[ "$_c14_rc" != "0" ]] && grep -q "checksum mismatch\|no pinned checksum" "$_c14/install.out"; then
        ok "a stale binary with no sidecar is reinstalled, not trusted"
    else
        ko "a stale binary with no sidecar is reinstalled, not trusted" "$_c14_rc; out: $(cat "$_c14/install.out")"
    fi
else
    ok "a stale binary with no sidecar is reinstalled, not trusted"
fi

# --- case 15 (N1a, r3): added-then-deleted-later secret is refused -----------
# Opus re-review of 4e882432: a secret added in one commit and deleted again
# by a LATER commit of the same push never appeared in the base..tip union
# diff the tip-only scan used, so it shipped clean while landing in the
# remote's real history. failing-first evidence against 4e882432 itself
# (manual real-push repro, not asserted here): that hook exits 0 on this
# exact fixture; the current hook must exit 1 and name the ADD commit.
#
# E-110: the full-push scan (gitleaks git) now runs FIRST, before this
# eval-only dir-mode scan, and refuses on the same secret before dir-mode
# gets a chance to -- so the commit reference here may come from either
# scan's own message ("commit <short>" from dir-mode, "Commit:  <full>"
# from the full-push scan). $_add_sha (a `--short=12` abbreviation) is
# always a PREFIX of the full 40-hex sha, so a plain substring check
# (without requiring the literal word "commit" next to it) matches either.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c15"; BARE="$SCRATCH/c15.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "add secret-shaped fixture" --no-verify >/dev/null 2>&1
    _add_sha="$(g "$D" rev-parse --short=12 HEAD)"
    g "$D" rm -q eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "delete it again" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "N1a: secret added then deleted later in the same push is refused" "push succeeded (fail-open); out: $(cat "$D/push.out")"
    elif grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "possible secret" "$D/push.out" \
       && grep -qF "$_add_sha" "$D/push.out"; then
        ok "N1a: secret added then deleted later in the same push is refused"
    else
        ko "N1a: secret added then deleted later in the same push is refused" "refused but not on the finding/commit: $(cat "$D/push.out")"
    fi
else
    sk "N1a: secret added then deleted later in the same push is refused (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 16 (N1b, r3): added-then-edited-clean-later secret is refused ------
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c16"; BARE="$SCRATCH/c16.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "add secret-shaped fixture" --no-verify >/dev/null 2>&1
    _add_sha="$(g "$D" rev-parse --short=12 HEAD)"
    echo '{"id": "fake-task", "prompt": "nothing to see here"}' > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "edit it clean" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "N1b: secret added then edited clean later in the same push is refused" "push succeeded (fail-open); out: $(cat "$D/push.out")"
    elif grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "possible secret" "$D/push.out" \
       && grep -qF "$_add_sha" "$D/push.out"; then
        ok "N1b: secret added then edited clean later in the same push is refused"
    else
        ko "N1b: secret added then edited clean later in the same push is refused" "refused but not on the finding/commit: $(cat "$D/push.out")"
    fi
else
    sk "N1b: secret added then edited clean later in the same push is refused (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 17: a clean multi-commit push passes --------------------------------
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c17"; BARE="$SCRATCH/c17.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    echo "unrelated change 1" >> "$D/autonomy/run.sh"
    g "$D" add autonomy/run.sh >/dev/null 2>&1
    g "$D" commit -q -m "c1: unrelated" --no-verify >/dev/null 2>&1
    mkdir -p "$D/eval/loki10/tasks/clean-task"
    echo '{"id": "clean-task", "prompt": "nothing sensitive here"}' > "$D/eval/loki10/tasks/clean-task/task.json"
    g "$D" add eval/loki10/tasks/clean-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "c2: clean eval fixture" --no-verify >/dev/null 2>&1
    echo "unrelated change 2" >> "$D/autonomy/run.sh"
    g "$D" add autonomy/run.sh >/dev/null 2>&1
    g "$D" commit -q -m "c3: unrelated" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ok "a clean multi-commit push passes"
    else
        ko "a clean multi-commit push passes" "$rc; out: $(cat "$D/push.out")"
    fi
else
    sk "a clean multi-commit push passes (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 18: a merge commit bringing in a secret is refused -----------------
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c18"; BARE="$SCRATCH/c18.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    g "$D" checkout -q -b feature >/dev/null 2>&1
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "feature: add secret-shaped fixture" --no-verify >/dev/null 2>&1
    g "$D" checkout -q main >/dev/null 2>&1
    g "$D" merge -q --no-ff -m "merge feature" feature >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "a merge commit bringing in a secret is refused" "push succeeded; out: $(cat "$D/push.out")"
    elif grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "gitleaks found a possible secret" "$D/push.out"; then
        ok "a merge commit bringing in a secret is refused"
    else
        ko "a merge commit bringing in a secret is refused" "refused but not on the finding: $(cat "$D/push.out")"
    fi
else
    sk "a merge commit bringing in a secret is refused (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 19: an added .gitleaksignore line prints a WARNING, not a refusal --
# Not gated on $_have_real_gitleaks: this case is about the WARNING message,
# not about a real finding. LOKI_ALLOW_UNSCANNED_PUSH=1 keeps it independent
# of whether the pinned binary happens to be installed here (E-110's full-push
# scan now runs on every push, including this eval-untouched one); on a
# machine WITH the binary, the override is simply unused.
D="$SCRATCH/c19"; BARE="$SCRATCH/c19.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
printf '%s\n' "some/fake/path.json:generic-api-key:1" >> "$D/.gitleaksignore"
g "$D" add .gitleaksignore >/dev/null 2>&1
g "$D" commit -q -m "add a gitleaksignore line" --no-verify >/dev/null 2>&1
rc="$(real_push "$D" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
if [[ "$rc" != "RC=0" ]]; then
    ko "an added .gitleaksignore line is a WARNING, not a refusal" "$rc; out: $(cat "$D/push.out")"
else
    ok "an added .gitleaksignore line is a WARNING, not a refusal"
fi
if grep -q "WARNING: .gitleaksignore gained line" "$D/push.out" && grep -qF "some/fake/path.json:generic-api-key:1" "$D/push.out"; then
    ok "the WARNING lists the added .gitleaksignore line"
else
    ko "the WARNING lists the added .gitleaksignore line" "$(cat "$D/push.out")"
fi

# --- case 20: a .gitleaks.toml change is refused unless overridden -----------
# E-99: the gate is now "any change to .gitleaks.toml, in any push", not
# scoped to a push that also touches eval (r4's scoping let an eval-untouched
# push slip a weakened config in unreviewed, to be inherited by a LATER
# eval-touching push -- case 22 below now covers exactly that, flipped).
#
# The override sub-case needs the real pinned gitleaks v8.30.0: with
# LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1 set, the config-change gate no longer
# fails the push itself, so the push's outcome falls through to the actual
# scan of toml-task/task.json -- if the pinned binary is absent, that scan
# step is what refuses ("eval task fixtures changed but pinned gitleaks
# v8.30.0 is not installed"), not the config gate, and the sub-case's RC=0
# expectation would wrongly fail on a machine without it. The no-override
# sub-case does not have this dependency (the config gate itself fails the
# push regardless of whether the binary is installed), but it is gated here
# too so the case behaves like its siblings: real gitleaks present or both
# assertions run for real, absent or both are skipped, never a partial run.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c20"; BARE="$SCRATCH/c20.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    cat > "$D/.gitleaks.toml" <<'TOML'
title = "loki override"
[allowlist]
regexes = ['.*']
TOML
    mkdir -p "$D/eval/loki10/tasks/toml-task"
    echo '{"id": "toml-task", "prompt": "clean"}' > "$D/eval/loki10/tasks/toml-task/task.json"
    g "$D" add .gitleaks.toml eval/loki10/tasks/toml-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "add global allowlist + touch eval" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko ".gitleaks.toml global allowlist is refused without the override" "push succeeded; out: $(cat "$D/push.out")"
    elif grep -q "\.gitleaks\.toml changed" "$D/push.out" && grep -q "LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE" "$D/push.out"; then
        ok ".gitleaks.toml global allowlist is refused without the override"
    else
        ko ".gitleaks.toml global allowlist is refused without the override" "refused but wrong message: $(cat "$D/push.out")"
    fi
    rc="$(real_push "$D" "LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1")"
    if [[ "$rc" == "RC=0" ]]; then
        ok ".gitleaks.toml global allowlist passes with LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1"
    else
        ko ".gitleaks.toml global allowlist passes with LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1" "$rc; out: $(cat "$D/push.out")"
    fi
else
    sk ".gitleaks.toml global allowlist is refused without the override (no pinned gitleaks v${GITLEAKS_VERSION})"
    sk ".gitleaks.toml global allowlist passes with LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1 (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 22 (E-99): a .gitleaks.toml-only change (no eval touch) is --------
# ALSO refused without the override. r4 scoped this refusal to a push that
# also touches eval; that let a config change ride in on an eval-untouched
# push, unreviewed, to be silently inherited by whatever eval-touching push
# came next -- a config change is dangerous on its own merits, independent
# of what else this particular push happens to touch.
D="$SCRATCH/c22"; BARE="$SCRATCH/c22.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
cat > "$D/.gitleaks.toml" <<'TOML'
title = "unrelated config change"
TOML
g "$D" add .gitleaks.toml >/dev/null 2>&1
g "$D" commit -q -m "touch gitleaks config, no eval change" --no-verify >/dev/null 2>&1
# LOKI_ALLOW_UNSCANNED_PUSH=1: this assertion is about the .gitleaks.toml
# config-change gate specifically, not about the full-push scan's own
# missing-binary behavior (already covered elsewhere) -- without it, a
# no-binary environment would refuse on E-110's full-push scan first and
# never reach the config-change gate this checks for. Unused when the
# binary is present.
rc="$(real_push "$D" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
if [[ "$rc" == "RC=0" ]]; then
    ko "a .gitleaks.toml change in a push that never touches eval is refused too" "push succeeded; out: $(cat "$D/push.out")"
elif grep -q "\.gitleaks\.toml changed" "$D/push.out" && grep -q "LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE" "$D/push.out"; then
    ok "a .gitleaks.toml change in a push that never touches eval is refused too"
else
    ko "a .gitleaks.toml change in a push that never touches eval is refused too" "refused but wrong message: $(cat "$D/push.out")"
fi
# LOKI_ALLOW_UNSCANNED_PUSH=1 alongside the config override: this push never
# touches eval, so once the config gate stops failing it, the ONLY other
# thing that could still refuse it is E-110's full-push scan needing the
# pinned binary -- unrelated to what this assertion is about. Unused when
# the binary is present.
rc="$(real_push "$D" "LOKI_ALLOW_GITLEAKS_CONFIG_CHANGE=1" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
if [[ "$rc" == "RC=0" ]]; then
    ok "a .gitleaks.toml change in a push that never touches eval passes with the override"
else
    ko "a .gitleaks.toml change in a push that never touches eval passes with the override" "$rc; out: $(cat "$D/push.out")"
fi

# --- case 23 (r4): title-only / paths=[".*"] toml, PREVIOUSLY evaded the -----
# old '.*' regexes pattern match, is refused too (any change).
D="$SCRATCH/c23"; BARE="$SCRATCH/c23.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
cat > "$D/.gitleaks.toml" <<'TOML'
title = "no rules at all"
TOML
mkdir -p "$D/eval/loki10/tasks/evade-task"
echo '{"id": "evade-task", "prompt": "clean"}' > "$D/eval/loki10/tasks/evade-task/task.json"
g "$D" add .gitleaks.toml eval/loki10/tasks/evade-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "title-only config (old rule evasion), eval touch" --no-verify >/dev/null 2>&1
# LOKI_ALLOW_UNSCANNED_PUSH=1: same reason as case 22 -- this checks the
# config-change gate specifically, not the full-push scan's missing-binary
# behavior. Unused when the binary is present.
rc="$(real_push "$D" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
if [[ "$rc" == "RC=0" ]]; then
    ko "a title-only .gitleaks.toml in an eval-touching push is refused (evasion closed)" "push succeeded (old '.*' pattern match would have missed this); out: $(cat "$D/push.out")"
elif grep -q "\.gitleaks\.toml changed" "$D/push.out"; then
    ok "a title-only .gitleaks.toml in an eval-touching push is refused (evasion closed)"
else
    ko "a title-only .gitleaks.toml in an eval-touching push is refused (evasion closed)" "refused but wrong message: $(cat "$D/push.out")"
fi

# --- case 21: a 2,000-file eval push completes (chunked git archive) ---------
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c21"; BARE="$SCRATCH/c21.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/bulk-task"
    _bi=1
    while [[ $_bi -le 2000 ]]; do
        echo "{\"id\": \"bulk-$_bi\", \"prompt\": \"nothing sensitive\"}" > "$D/eval/loki10/tasks/bulk-task/f$_bi.json"
        _bi=$((_bi + 1))
    done
    g "$D" add eval/loki10/tasks/bulk-task >/dev/null 2>&1
    g "$D" commit -q -m "bulk eval fixtures" --no-verify >/dev/null 2>&1
    _t0=$(date +%s)
    rc="$(real_push "$D")"
    _t1=$(date +%s)
    if [[ "$rc" == "RC=0" ]]; then
        ok "a 2,000-file eval push completes ($((_t1 - _t0))s)"
    else
        ko "a 2,000-file eval push completes" "$rc; out: $(cat "$D/push.out")"
    fi
else
    sk "a 2,000-file eval push completes (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 24 (B1, r4): a ROOT commit with a secret is refused -----------------
# Opus REJECT on 40b2e228: `git diff-tree` without --root prints nothing for a
# parentless commit, so an orphan branch (or the first push to a brand-new,
# empty remote) shipped its secret entirely unscanned. Red-first evidence
# (manual, not asserted here): the pre-r4 hook exits 0 on this exact fixture
# with no "gitleaks dir" line printed at all.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c24"; BARE="$SCRATCH/c24.git"; setup_bare "$BARE"
    rm -rf "$D"; mkdir -p "$D/autonomy"; cd "$D" || exit 1
    git init -q -b orph .
    git config user.name asklokesh; git config user.email lokeshmure@live.com
    git config commit.gpgsign false
    git config core.hooksPath .githooks
    mkdir -p .githooks && cp "$HOOK" .githooks/pre-push && chmod +x .githooks/pre-push
    echo 'true' > autonomy/run.sh; echo 'true' > autonomy/loki
    cp "$REPO_ROOT/.gitleaksignore" .gitleaksignore
    mkdir -p eval/loki10/tasks/fake-task
    printf '%s\n' "$_task_json_secret" > eval/loki10/tasks/fake-task/task.json
    git add -A >/dev/null 2>&1
    git commit -q -m "root commit with a secret-shaped fixture" --no-verify >/dev/null 2>&1
    _root_sha="$(g "$D" rev-parse --short=12 HEAD)"
    git remote add origin "$BARE" >/dev/null 2>&1
    rc=0
    PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 git push origin orph >"$D/push.out" 2>&1 || rc=$?
    if [[ "$rc" == "0" ]]; then
        ko "a ROOT commit with a secret is refused (B1)" "push succeeded (fail-open); out: $(cat "$D/push.out")"
    elif grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "possible secret" "$D/push.out" \
       && grep -qF "$_root_sha" "$D/push.out"; then
        ok "a ROOT commit with a secret is refused (B1)"
    else
        ko "a ROOT commit with a secret is refused (B1)" "refused but not on the finding/commit: $(cat "$D/push.out")"
    fi
else
    sk "a ROOT commit with a secret is refused (B1) (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 25 (B3, r4): case-colliding eval paths in one commit are refused ---
# Opus REJECT on 40b2e228: `git archive | tar -x` extracts A.json and a.json
# on top of each other on a case-insensitive filesystem (APFS), so only one
# of them actually gets scanned -- the secret in whichever loses the
# collision ships unscanned even though the scan itself reports success.
#
# E-110: the full-push scan (gitleaks git, on a bare clone) reads git blobs
# directly by OID, never through a case-insensitive filesystem extraction --
# it has no collision to have, by construction -- and now runs FIRST, so it
# refuses this fixture on the plain secret in A.json before dir-mode's own
# B3 defense is even reached. That is a strictly stronger outcome (one scan
# path is now immune to the whole bug class), so this accepts either
# message: dir-mode's specific collision refusal, or the full-push scan
# catching the same secret first.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c25"; BARE="$SCRATCH/c25.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/collide"
    printf '%s\n' "$_task_json_secret" > "$SCRATCH/c25-secret.json"
    echo '{}' > "$SCRATCH/c25-clean.json"
    _s_oid="$(g "$D" hash-object -w "$SCRATCH/c25-secret.json")"
    _c_oid="$(g "$D" hash-object -w "$SCRATCH/c25-clean.json")"
    g "$D" update-index --add --cacheinfo "100644,${_s_oid},eval/loki10/tasks/collide/A.json" >/dev/null 2>&1
    g "$D" update-index --add --cacheinfo "100644,${_c_oid},eval/loki10/tasks/collide/a.json" >/dev/null 2>&1
    g "$D" commit -q -m "case-colliding eval paths" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "case-colliding eval paths in one commit are refused (B3)" "push succeeded (fail-open); out: $(cat "$D/push.out")"
    elif grep -q "collide case-insensitively" "$D/push.out" || grep -q "possible secret" "$D/push.out"; then
        ok "case-colliding eval paths in one commit are refused (B3)"
    else
        ko "case-colliding eval paths in one commit are refused (B3)" "refused but wrong message: $(cat "$D/push.out")"
    fi
else
    sk "case-colliding eval paths in one commit are refused (B3) (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 26 (E-99): a .gitleaksignore line added in commit 1 and removed ---
# again in commit 2 of the SAME push is now REFUSED, and still prints the
# WARNING. r3's base..tip union diff of .gitleaksignore showed NO net change
# here (added then removed cancels out), so a human reviewing the push
# output never saw that a self-suppression briefly existed; r4 fixed the
# WARNING but the push itself still SUCCEEDED (commit 1 was scanned with
# commit 1's own .gitleaksignore, which still had the line at that point).
# E-86 round-4 review C1: scanning every commit with the PUSHED TIP's
# .gitleaksignore instead closes this too, for free -- the tip's
# .gitleaksignore no longer has the line, so commit 1's secret is scanned
# against an ignore file that does not suppress it, matching what CI's
# git-log-mode scan (one ignore file, the tip's, for the whole push) would
# find. This is also the CI-parity property E-99 exists for: a local push
# that CI would flag must not go green locally.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c26"; BARE="$SCRATCH/c26.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    printf '%s\n' "eval/loki10/tasks/fake-task/task.json:sourcegraph-access-token:5" >> "$D/.gitleaksignore"
    g "$D" add eval/loki10/tasks/fake-task/task.json .gitleaksignore >/dev/null 2>&1
    g "$D" commit -q -m "secret + self-suppressing ignore line" --no-verify >/dev/null 2>&1
    _add_sha="$(g "$D" rev-parse --short=12 HEAD)"
    g "$D" checkout -q HEAD~1 -- .gitleaksignore >/dev/null 2>&1
    g "$D" add .gitleaksignore >/dev/null 2>&1
    g "$D" commit -q -m "remove the ignore line again" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "a self-suppressing .gitleaksignore line added and removed within one push is refused" "push succeeded (fail-open); out: $(cat "$D/push.out")"
    elif grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "possible secret" "$D/push.out" \
       && grep -qF "$_add_sha" "$D/push.out"; then
        ok "a self-suppressing .gitleaksignore line added and removed within one push is refused"
    else
        ko "a self-suppressing .gitleaksignore line added and removed within one push is refused" "refused but not on the finding/commit: $(cat "$D/push.out")"
    fi
    # E-110: the full-push scan now runs BEFORE the eval-only dir-mode loop
    # and exits on its own finding first (asserted above), so dir-mode's
    # per-commit .gitleaksignore-diff WARNING below it never runs for THIS
    # fixture -- the push is refused before that code is reached at all. The
    # WARNING mechanism itself is still covered (case 19, a fixture where no
    # full-push finding exists to short-circuit it first, still asserts the
    # WARNING fires with RC=0).
    sk "the per-commit WARNING fires even though base..tip shows no net .gitleaksignore change (unreachable: E-110's full-push scan refuses this fixture first; mechanism covered by case 19)"
else
    sk "a self-suppressing .gitleaksignore line added and removed within one push is refused (no pinned gitleaks v${GITLEAKS_VERSION})"
    sk "the per-commit WARNING fires even though base..tip shows no net .gitleaksignore change (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 26b (E-110 restore): the per-commit WARNING fires even though -----
# base..tip shows no net .gitleaksignore change, in a SECRET-FREE fixture.
# Case 26 above can no longer observe this specific r4 property: its fixture
# also carries a real secret, which the full-push scan (E-110, runs first)
# refuses on before dir-mode's per-commit loop is ever reached. This fixture
# has no secret anywhere -- an unrelated fake path in .gitleaksignore, added
# in commit 1 and removed in commit 2 -- so the full-push scan passes
# cleanly and dir-mode's own WARNING logic is exercised directly.
# LOKI_ALLOW_UNSCANNED_PUSH=1: this is about the WARNING mechanism, not
# about gitleaks binary availability (same reason as case 19).
D="$SCRATCH/c26b"; BARE="$SCRATCH/c26b.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
printf '%s\n' "some/other/fake-path.json:generic-api-key:1" >> "$D/.gitleaksignore"
g "$D" add .gitleaksignore >/dev/null 2>&1
g "$D" commit -q -m "add a fake ignore line" --no-verify >/dev/null 2>&1
_c26b_add_sha="$(g "$D" rev-parse --short=12 HEAD)"
g "$D" checkout -q HEAD~1 -- .gitleaksignore >/dev/null 2>&1
g "$D" add .gitleaksignore >/dev/null 2>&1
g "$D" commit -q -m "remove it again" --no-verify >/dev/null 2>&1
rc="$(real_push "$D" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
if [[ "$rc" != "RC=0" ]]; then
    ko "case 26b: a secret-free add-then-remove .gitleaksignore push still succeeds" "$rc; out: $(cat "$D/push.out")"
else
    ok "case 26b: a secret-free add-then-remove .gitleaksignore push still succeeds"
fi
if grep -q "WARNING: .gitleaksignore gained line" "$D/push.out" && grep -qF "$_c26b_add_sha" "$D/push.out" \
   && grep -qF "some/other/fake-path.json:generic-api-key:1" "$D/push.out"; then
    ok "case 26b: the per-commit WARNING fires even though base..tip shows no net .gitleaksignore change"
else
    ko "case 26b: the per-commit WARNING fires even though base..tip shows no net .gitleaksignore change" "$(cat "$D/push.out")"
fi

# --- case 27 (r4 concern): a ref pointing at a TREE, not a commit, is refused
# A lightweight tag can point straight at a tree object (no commit, nothing
# to peel `^{commit}` to). Every commit-walking step downstream either errors
# or silently walks zero commits -- either way the ref's actual content
# (which can carry a secret) ships unscanned unless this is caught explicitly.
D="$SCRATCH/c27"; BARE="$SCRATCH/c27.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
mkdir -p "$D/eval/loki10/tasks/fake-task"
printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "secret, never pushed directly" --no-verify >/dev/null 2>&1
_tree_oid="$(g "$D" rev-parse 'HEAD^{tree}')"
g "$D" reset -q --hard HEAD~1
g "$D" tag treetag "$_tree_oid" >/dev/null 2>&1
rc=0
# LOKI_ALLOW_UNSCANNED_PUSH=1: this checks dir-mode's specific "not a
# commit" refusal, not the full-push scan's missing-binary behavior (already
# covered by cases 3-4). Without a real gitleaks binary and no override, the
# full-push scan itself would refuse first (also correctly, but on the wrong
# message for this assertion). Unused when the binary is present.
(cd "$D" && PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 LOKI_ALLOW_UNSCANNED_PUSH=1 git push origin treetag) >"$D/push.out" 2>&1 || rc=$?
if [[ "$rc" == "0" ]]; then
    ko "a ref pointing at a tree (not a commit) is refused" "push succeeded (fail-open); out: $(cat "$D/push.out")"
elif grep -q "which is not a commit" "$D/push.out"; then
    ok "a ref pointing at a tree (not a commit) is refused"
else
    ko "a ref pointing at a tree (not a commit) is refused" "refused but wrong message: $(cat "$D/push.out")"
fi

# --- case 27b (E-110 concern): the same TREE ref, with PRE_PUSH_SKIP=1 set --
# so dir-mode never runs and the early full-push scan is the ONLY thing that
# can catch it. Confirms whether `gitleaks git <clone> --log-opts="<tree>
# --not --remotes=..."` scans zero commits and exits 0 on a non-commit ref
# (the early block never separately checks `${_lsha}^{commit}`), or fails
# closed some other way.
D="$SCRATCH/c27b"; BARE="$SCRATCH/c27b.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
mkdir -p "$D/eval/loki10/tasks/fake-task"
printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "secret, never pushed directly" --no-verify >/dev/null 2>&1
_tree_oid_b="$(g "$D" rev-parse 'HEAD^{tree}')"
g "$D" reset -q --hard HEAD~1
g "$D" tag treetagb "$_tree_oid_b" >/dev/null 2>&1
rc=0
(cd "$D" && PRE_PUSH_NO_CI_CHECK=1 LOKI_RELEASE_MANAGER=1 PRE_PUSH_SKIP=1 git push origin treetagb) >"$D/push.out" 2>&1 || rc=$?
if [[ "$rc" == "0" ]]; then
    ko "case 27b: a tree ref is refused even under PRE_PUSH_SKIP=1 (early block only)" "push succeeded (fail-open); out: $(cat "$D/push.out")"
elif grep -q "which is not a commit" "$D/push.out"; then
    ok "case 27b: a tree ref is refused even under PRE_PUSH_SKIP=1 (early block only)"
else
    ko "case 27b: a tree ref is refused even under PRE_PUSH_SKIP=1 (early block only)" "refused but wrong message: $(cat "$D/push.out")"
fi

# --- case 28 (r4 concern): a `git rev-list` failure fails CLOSED, not open ---
# A corrupt commit object in the pushed range (disk corruption, a bad pack)
# used to make `git rev-list base..tip` fail silently behind `|| true`,
# reading exactly like "zero commits to scan" and letting the push through.
# A REAL `git push` against a corrupted object errors out of its own object-
# enumeration machinery with git's raw "Could not read.../remote end hung up"
# text (not this hook's own message) before or alongside the hook running --
# so that part only proves the OUTCOME (refused). The hook's own controlled
# message is asserted separately, stdin-fed (run_hook_raw, like cases 1-14),
# which isolates this hook's `git rev-list` call from git's transport layer.
D="$SCRATCH/c28"; BARE="$SCRATCH/c28.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
echo "clean change" >> "$D/autonomy/run.sh"
g "$D" add autonomy/run.sh >/dev/null 2>&1
g "$D" commit -q -m "the commit whose object gets corrupted" --no-verify >/dev/null 2>&1
_corrupt_sha="$(g "$D" rev-parse HEAD)"
echo "another clean change" >> "$D/autonomy/run.sh"
g "$D" add autonomy/run.sh >/dev/null 2>&1
g "$D" commit -q -m "on top of the corrupted commit" --no-verify >/dev/null 2>&1
_new_sha="$(g "$D" rev-parse HEAD)"
_old_sha="$(g "$D" rev-parse HEAD~2)"
_obj_path="$D/.git/objects/${_corrupt_sha:0:2}/${_corrupt_sha:2}"
if [[ -f "$_obj_path" ]]; then
    chmod u+w "$_obj_path"  # git writes loose objects read-only
    : > "$_obj_path"  # truncate: the object is now unreadable, not absent
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "a git rev-list failure fails closed, not open (real push is refused)" "push succeeded despite a corrupt commit object; out: $(cat "$D/push.out")"
    else
        ok "a git rev-list failure fails closed, not open (real push is refused)"
    fi
    # LOKI_ALLOW_UNSCANNED_PUSH=1: this checks dir-mode's own `git rev-list`
    # failure message specifically, not the full-push scan's missing-binary
    # behavior (already covered by cases 3-4). Unused when the binary is
    # present.
    rc="$(run_hook_raw "$D" "refs/heads/main $_new_sha refs/heads/main $_old_sha" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "the hook's own message names the git rev-list failure (stdin-fed, isolated)" "hook exited 0; out: $(cat "$D/hook.out")"
    elif grep -q "could not list commits" "$D/hook.out"; then
        ok "the hook's own message names the git rev-list failure (stdin-fed, isolated)"
    else
        ko "the hook's own message names the git rev-list failure (stdin-fed, isolated)" "refused but wrong message: $(cat "$D/hook.out")"
    fi
else
    sk "a git rev-list failure fails closed, not open (commit stored as a packed, not loose, object on this git version)"
    sk "the hook's own message names the git rev-list failure (commit stored as a packed, not loose, object on this git version)"
fi

# --- case 29 (E-99): the production incident, reproduced -- a merge bringing -
# in an OLD branch commit whose OWN .gitleaksignore lacks an entry passes
# when the PUSHED TIP's .gitleaksignore has it. This is the actual P0: a
# release train merged older branch commits carrying
# eval/loki10/tasks/pub-werkzeug-3271/task.json from before its
# dir-mode-fingerprint .gitleaksignore entry existed, and was refused on an
# already-reviewed false positive, while CI (which scans the whole pushed
# range against ONE ignore file -- the tip's) passed. Before this fix: each
# commit was scanned with ITS OWN .gitleaksignore (`git show "$_csha:..."`),
# so the old commit -- whose own ignore file predates the entry -- was
# refused even though the tip's ignore file the merge produces has it.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c29"; BARE="$SCRATCH/c29.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    g "$D" checkout -q -b old-branch >/dev/null 2>&1
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "old branch: add task.json (predates the ignore entry)" --no-verify >/dev/null 2>&1
    g "$D" checkout -q main >/dev/null 2>&1
    printf '%s\n' "eval/loki10/tasks/fake-task/task.json:sourcegraph-access-token:5" >> "$D/.gitleaksignore"
    g "$D" add .gitleaksignore >/dev/null 2>&1
    g "$D" commit -q -m "main: allowlist the reviewed false positive" --no-verify >/dev/null 2>&1
    g "$D" merge -q --no-ff -m "release train: merge old-branch" old-branch >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ok "a merge bringing an old commit whose own ignore file lacks the entry passes when the tip's has it"
    else
        ko "a merge bringing an old commit whose own ignore file lacks the entry passes when the tip's has it" "$rc; out: $(cat "$D/push.out")"
    fi
else
    sk "a merge bringing an old commit whose own ignore file lacks the entry passes when the tip's has it (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 30 (E-99): GITLEAKS_CONFIG pointing at a permissive config is ------
# ignored. gitleaks reads GITLEAKS_CONFIG (and GITLEAKS_CONFIG_TOML) from the
# environment to pick a default config, which would silently override the
# --config this hook computes from the pushed tip's own .gitleaks.toml (or,
# as here, override the absence of one) if left set. The hook now unsets
# both before invoking gitleaks.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c30"; BARE="$SCRATCH/c30.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/fake-task"
    printf '%s\n' "$_task_json_secret" > "$D/eval/loki10/tasks/fake-task/task.json"
    g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "add fake task with a secret-shaped fixture" --no-verify >/dev/null 2>&1
    _permissive_config="$SCRATCH/c30-permissive.toml"
    cat > "$_permissive_config" <<'TOML'
title = "permissive (outside the repo)"
[allowlist]
regexes = ['.*']
TOML
    rc="$(real_push "$D" "GITLEAKS_CONFIG=$_permissive_config")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "GITLEAKS_CONFIG pointing at a permissive config is ignored" "push succeeded (env config leaked through); out: $(cat "$D/push.out")"
    elif grep -q "sourcegraph-access-token" "$D/push.out" && grep -q "gitleaks found a possible secret" "$D/push.out"; then
        ok "GITLEAKS_CONFIG pointing at a permissive config is ignored"
    else
        ko "GITLEAKS_CONFIG pointing at a permissive config is ignored" "refused but not on the finding: $(cat "$D/push.out")"
    fi
else
    sk "GITLEAKS_CONFIG pointing at a permissive config is ignored (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 31 (E-110): a secret-shaped literal in a NON-eval path is refused --
# The bug E-110 fixes: cases 1-30 above only ever prove the eval/loki10/tasks
# and eval/loki10/refdiff dir-mode scan works. tests/test-eval-archive.sh
# (commit bbe83c7a, E-101) planted 3 synthetic secrets in a path that scan
# never covers, and they shipped clean locally, only to block the v10.4.0
# release when CI's full-history scan caught them after the push landed.
# This proves the NEW full-push `gitleaks git` step (added below the
# eval-only loop) sees a secret-shaped literal anywhere in the push, not
# just under eval/. Built from two adjacent string literals at runtime (same
# trick as $_task_json_secret's $_fake_ref above), so THIS test file itself
# never contains the contiguous AKIA-shaped run.
_akia_secret="AKIA""ABCDEFGHIJKLMNOP"
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c31"; BARE="$SCRATCH/c31.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/tests"
    printf '%s\n' "# fixture: $_akia_secret leaked" > "$D/tests/foo.sh"
    g "$D" add tests/foo.sh >/dev/null 2>&1
    g "$D" commit -q -m "add tests/foo.sh with a secret-shaped literal" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "a non-eval file (tests/foo.sh) with an AKIA-shaped literal is refused" "push succeeded; out: $(cat "$D/push.out")"
    elif grep -q "aws-access-token" "$D/push.out" && grep -q "gitleaks found a possible secret in the pushed commits" "$D/push.out" \
       && grep -q "tests/foo.sh" "$D/push.out"; then
        ok "a non-eval file (tests/foo.sh) with an AKIA-shaped literal is refused"
    else
        ko "a non-eval file (tests/foo.sh) with an AKIA-shaped literal is refused" "refused but not on the finding: $(cat "$D/push.out")"
    fi
else
    sk "a non-eval file (tests/foo.sh) with an AKIA-shaped literal is refused (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 32 (E-110): a clean, non-eval-touching push still passes -----------
# Regression guard on case 31: the full-push scan must not refuse a push just
# because it is not the eval scan's usual eval/loki10 shape.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c32"; BARE="$SCRATCH/c32.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/tests"
    echo "echo hello" > "$D/tests/foo.sh"
    g "$D" add tests/foo.sh >/dev/null 2>&1
    g "$D" commit -q -m "add a clean, non-eval tests/foo.sh" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D")"
    if [[ "$rc" == "RC=0" ]]; then
        ok "a clean, non-eval-touching push passes"
    else
        ko "a clean, non-eval-touching push passes" "$rc; out: $(cat "$D/push.out")"
    fi
else
    sk "a clean, non-eval-touching push passes (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# --- case 33 (E-110): the full-push scan is NOT skippable by PRE_PUSH_SKIP --
# The whole reason the E-110 block moved to run before the PRE_PUSH_SKIP
# check (not after, where it first landed): PRE_PUSH_SKIP=1 is the routine
# way release trains push (docs/v10/DECISIONS.md), so a check placed after
# it would never fire on exactly the pushes it exists to catch. Nothing
# above asserts this placement directly -- every other case pushes without
# PRE_PUSH_SKIP=1 set.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/c33a"; BARE="$SCRATCH/c33a.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/tests"
    printf '%s\n' "# fixture: $_akia_secret leaked" > "$D/tests/foo.sh"
    g "$D" add tests/foo.sh >/dev/null 2>&1
    g "$D" commit -q -m "add tests/foo.sh with a secret-shaped literal" --no-verify >/dev/null 2>&1
    rc="$(real_push "$D" "PRE_PUSH_SKIP=1")"
    if [[ "$rc" == "RC=0" ]]; then
        ko "case 33a: PRE_PUSH_SKIP=1 does not bypass the full-push scan (real finding)" "push succeeded (fail-open); out: $(cat "$D/push.out")"
    elif grep -q "aws-access-token" "$D/push.out" && grep -q "possible secret" "$D/push.out" && grep -q "tests/foo.sh" "$D/push.out"; then
        ok "case 33a: PRE_PUSH_SKIP=1 does not bypass the full-push scan (real finding)"
    else
        ko "case 33a: PRE_PUSH_SKIP=1 does not bypass the full-push scan (real finding)" "refused but not on the finding: $(cat "$D/push.out")"
    fi
else
    sk "case 33a: PRE_PUSH_SKIP=1 does not bypass the full-push scan (real finding) (no pinned gitleaks v${GITLEAKS_VERSION})"
fi

# No pinned binary, no override, PRE_PUSH_SKIP=1, a CLEAN non-eval push:
# refused with the install hint, not silently let through. This is the only
# version of the E-110 guard CI's own Tests job will ever exercise (it has
# no pinned gitleaks -- see tests/test-release-notes.sh's header note).
D="$SCRATCH/c33b"; setup_clone "$D"
echo "unrelated change" >> "$D/autonomy/run.sh"
g "$D" add autonomy/run.sh >/dev/null 2>&1
g "$D" commit -q -m "unrelated change" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D" "HOME=$_fake_home" "PRE_PUSH_SKIP=1")"
if [[ "$rc" == "RC=0" ]]; then
    ko "case 33b: PRE_PUSH_SKIP=1 does not bypass the full-push scan (no binary)" "hook exited 0 (fail-open); out: $(cat "$D/hook.out")"
elif grep -q "cannot run the full-push secret scan" "$D/hook.out" && grep -q "scripts/install-gitleaks.sh" "$D/hook.out"; then
    ok "case 33b: PRE_PUSH_SKIP=1 does not bypass the full-push scan (no binary)"
else
    ko "case 33b: PRE_PUSH_SKIP=1 does not bypass the full-push scan (no binary)" "refused but wrong message: $(cat "$D/hook.out")"
fi

# --- case 33c (E-110): LOKI_ALLOW_UNSCANNED_PUSH=1 never covers the eval ----
# scan's OWN missing-binary refusal. The override is read in exactly one
# place (the full-push scan above); this proves dir-mode's separate,
# override-less missing-binary check further down still fires on its own
# terms once the full-push scan lets the push through.
D="$SCRATCH/c33c"; setup_clone "$D"
mkdir -p "$D/eval/loki10/tasks/fake-task"
echo '{"id": "fake-task"}' > "$D/eval/loki10/tasks/fake-task/task.json"
g "$D" add eval/loki10/tasks/fake-task/task.json >/dev/null 2>&1
g "$D" commit -q -m "add fake task" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D" "HOME=$_fake_home" "LOKI_ALLOW_UNSCANNED_PUSH=1")"
if [[ "$rc" == "RC=0" ]]; then
    ko "case 33c: LOKI_ALLOW_UNSCANNED_PUSH=1 never covers the eval scan's own missing-binary refusal" "hook exited 0 (fail-open); out: $(cat "$D/hook.out")"
elif grep -q "eval task fixtures changed but pinned gitleaks" "$D/hook.out"; then
    ok "case 33c: LOKI_ALLOW_UNSCANNED_PUSH=1 never covers the eval scan's own missing-binary refusal"
else
    ko "case 33c: LOKI_ALLOW_UNSCANNED_PUSH=1 never covers the eval scan's own missing-binary refusal" "refused but wrong message (may be the full-push scan's own message, not dir-mode's): $(cat "$D/hook.out")"
fi

# --- timing report: no eval change / one eval file / 10-commit push ----------
# Not correctness assertions (case 3 already covers "fast"); these three just
# print the wall-clock numbers requested for the r3 report. 1s resolution,
# see case 3's note on `date +%s` vs GNU-only `%N`.
if [[ "$_have_real_gitleaks" == "1" ]]; then
    D="$SCRATCH/timing1"; BARE="$SCRATCH/timing1.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    echo "noop" >> "$D/autonomy/run.sh"
    g "$D" add autonomy/run.sh >/dev/null 2>&1
    g "$D" commit -q -m "noop" --no-verify >/dev/null 2>&1
    _t0=$(date +%s); real_push "$D" >/dev/null; _t1=$(date +%s)
    echo "  TIMING: no eval change: $((_t1 - _t0))s"

    D="$SCRATCH/timing2"; BARE="$SCRATCH/timing2.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    mkdir -p "$D/eval/loki10/tasks/one-task"
    echo '{"id": "one-task", "prompt": "clean"}' > "$D/eval/loki10/tasks/one-task/task.json"
    g "$D" add eval/loki10/tasks/one-task/task.json >/dev/null 2>&1
    g "$D" commit -q -m "one eval file" --no-verify >/dev/null 2>&1
    _t0=$(date +%s); real_push "$D" >/dev/null; _t1=$(date +%s)
    echo "  TIMING: one eval file changed: $((_t1 - _t0))s"

    D="$SCRATCH/timing3"; BARE="$SCRATCH/timing3.git"; setup_bare "$BARE"; setup_push_clone "$D" "$BARE"
    _ti=1
    while [[ $_ti -le 10 ]]; do
        echo "commit $_ti" >> "$D/autonomy/run.sh"
        g "$D" add autonomy/run.sh >/dev/null 2>&1
        if [[ $_ti -eq 5 ]]; then
            mkdir -p "$D/eval/loki10/tasks/mid-task"
            echo '{"id": "mid-task", "prompt": "clean"}' > "$D/eval/loki10/tasks/mid-task/task.json"
            g "$D" add eval/loki10/tasks/mid-task/task.json >/dev/null 2>&1
        fi
        g "$D" commit -q -m "c$_ti" --no-verify >/dev/null 2>&1
        _ti=$((_ti + 1))
    done
    _t0=$(date +%s); real_push "$D" >/dev/null; _t1=$(date +%s)
    echo "  TIMING: 10-commit push (1 touches eval): $((_t1 - _t0))s"
fi

cd "$REPO_ROOT" || true
echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
echo "  Skipped:    $skipped"
[[ $failed -eq 0 ]] || exit 1
