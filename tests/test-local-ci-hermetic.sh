#!/usr/bin/env bash
#
# tests/test-local-ci-hermetic.sh
#
# E-94: guards scripts/local-ci.sh's hermetic changed-tests scan
# (_lci_hermetic_scan) -- the red-main class from df7dc134 day:
# tests/test-dep-inventory.sh passed locally because `gh` was authenticated
# on this Mac, then failed on the CI runner, which has neither `gh` nor
# GH_TOKEN/GITHUB_TOKEN.
#
# Static half: greps local-ci.sh for the scope (real test files only, not
# tests/run-all-tests.sh or a fixture .ts, under tests/ or loki-ts/tests/,
# merge-base diff against origin/main), the stripped-env shape (env -i,
# fresh HOME, a curated bindir listed FIRST on PATH), the serial (not
# background-lane) call site, and the fast-tier keep-list membership.
#
# Live half: awk-extracts the REAL _lci_hermetic_scan function body out of
# scripts/local-ci.sh (same technique as
# tests/test-local-ci-parent-exit-isolation.sh) and executes it -- not a
# mirrored reimplementation -- against disposable fixture repos:
#   1. a new test that calls `gh` directly: passes normally, fails stripped
#      -> the scan must FAIL and name the file. Gated on gh actually being
#      reachable normally and actually being UNREACHABLE under the scan's
#      own stripped PATH, not assumed.
#   2. a hermetic-clean new test: passes both runs.
#   3. the actual pre-E-92 scripts/dep-inventory.py (git show
#      4f7f1487^1:scripts/dep-inventory.py), replayed through a copy of the
#      real test-dep-inventory.sh wrapper -> caught the same way, gated on
#      it actually passing normally in this environment first.
#   4. the REAL, current (post-E-92) tests/test-dep-inventory.sh and
#      scripts/dep-inventory.py from this repo, replayed verbatim -> must
#      pass BOTH runs (the must-not-regress case: if the fixed file itself
#      cannot survive the scan, the scan is broken against the exact
#      incident it exists to guard).
#   5. a test using `mapfile`/`declare -A` (bash4+ only): must pass both
#      runs, proving the scan compares like-for-like bash versions rather
#      than false-flagging a version gap (macOS /bin/bash is 3.2) as a
#      credential dependency.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CI="$REPO_ROOT/scripts/local-ci.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

echo "=== local-ci hermetic changed-tests scan (E-94) ==="

[ -f "$CI" ] || { echo "  FAIL: $CI missing"; exit 1; }

# --- static -----------------------------------------------------------
if grep -q '^_lci_hermetic_scan() {' "$CI"; then
  ok "_lci_hermetic_scan is defined as a standalone function"
else
  bad "_lci_hermetic_scan function not found"
fi

if grep -q "diff --name-only --diff-filter=ACMR origin/main...HEAD -- tests loki-ts/tests" "$CI"; then
  ok "scope is the merge-base diff (three dots) over tests/ and loki-ts/tests/"
else
  bad "merge-base diff scope not found"
fi

if grep -qE "test\[-_\]\[\^/\]\+\\\\\.\(sh\|py\)\\\$\|\^loki-ts/tests/\.\*\\\\\.test\\\\\.ts\\\$" "$CI"; then
  ok "scope is basename-anchored to real test files (excludes run-all-tests.sh, fixture .ts)"
else
  bad "basename-anchored test-file filter not found (scope may sweep in non-test .sh/.py/.ts files)"
fi

if grep -q 'spath="\$bindir:/usr/bin:/bin"' "$CI"; then
  ok "the stripped bin dir is listed FIRST on PATH (so /usr/bin's own stub python3 cannot shadow it)"
else
  bad "bindir-first PATH ordering not found"
fi

if grep -q 'PYTHONUSERBASE="\$userbase"' "$CI"; then
  ok "PYTHONUSERBASE is preserved so pip --user packages (fastapi) stay importable under the fresh HOME"
else
  bad "PYTHONUSERBASE preservation not found"
fi

if grep -q 'command -v bash 2>/dev/null.*ln -sf' "$CI"; then
  ok "the real bash binary is symlinked into the private bindir (not just /bin's ancient 3.2)"
else
  bad "bash is not symlinked into the private bindir -- a bash4+ test would false-fail stripped"
fi

if grep -q 'holding ONLY symlinks to the real, ambient bash/bun/python3' "$CI"; then
  ok "the private bin dir holds only bash+bun+python3 (never gh's real parent dir)"
else
  bad "private-bindir rationale/comment not found (could regress to a whole real bin/ dir)"
fi

if grep -q '"hermetic changed-tests (no gh/network, E-94)"' "$CI"; then
  ok "the scan is on the fast-tier keep list (would not silently defer to full)"
else
  bad "the scan is not on _FAST_KEEP -- it would defer out of the fast tier"
fi

if grep -qE "^\s*run_check \"hermetic changed-tests \(no gh/network, E-94\)\" '_lci_hermetic_scan'" "$CI"; then
  ok "the call site is a SERIAL run_check (not a background lane running against real HOME/repo state)"
else
  bad "the call site is not run_check -- if it is run_check_bg it violates the serial-spine invariant (#588)"
fi

if grep -q "not command -v timeout" "$CI" || grep -q '! command -v timeout' "$CI"; then
  ok "the scan is SKIPPED (not a vacuous pass) when the timeout binary is absent"
else
  bad "no fail-closed skip for a missing timeout binary"
fi

if grep -q 'no changed test\[-_\]\*\.sh, test\[-_\]\*\.py under tests/, or \*\.test\.ts under loki-ts/tests/, vs origin/main' "$CI"; then
  ok "the scan is SKIPPED (not silently passed) when no in-scope test file changed"
else
  bad "no skip-when-nothing-changed path found"
fi

# --- live: exercise the REAL function body, not a mirrored copy -------
PY3_TOOLS="$(command -v python3 2>/dev/null)"
GH_BIN="$(command -v gh 2>/dev/null)"

if [ -z "$PY3_TOOLS" ] || [ -z "$GH_BIN" ]; then
  echo "  SKIP: python3 and/or gh not on PATH -- live scenarios not run (not a pass)"
  echo
  echo "=== $PASS passed, $FAIL failed (live scenarios skipped) ==="
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# The scenarios below assume /usr/bin:/bin do NOT themselves carry a `gh`
# binary (the scan's own stripped PATH always ends in exactly those two
# directories). If some environment's /usr/bin or /bin DOES carry `gh`, the
# scan's PATH restriction cannot exclude it and scenario 1 would legitimately
# not prove anything -- so this is checked, not assumed.
if env -i PATH=/usr/bin:/bin command -v gh >/dev/null 2>&1; then
  echo "  SKIP: gh resolves under a bare /usr/bin:/bin PATH on this host -- the scan's PATH restriction cannot exclude it here, so gh-exclusion scenarios are not run"
  echo
  echo "=== $PASS passed, $FAIL failed (gh-exclusion live scenarios skipped) ==="
  [ "$FAIL" -eq 0 ]
  exit $?
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-ci-hermetic-test.XXXXXX")"
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

FN_FILE="$TMP_ROOT/hermetic-scan.fn"
awk '/^_lci_hermetic_scan\(\) \{/{copy=1} copy{print} copy && /^}/{exit}' "$CI" > "$FN_FILE"
if [ ! -s "$FN_FILE" ]; then
  bad "could not awk-extract _lci_hermetic_scan from $CI"
  echo
  echo "=== $PASS passed, $FAIL failed ==="
  exit 1
fi

# A disposable repo with a local "origin/main" (a bare mirror, no network
# needed), matching tests/test-local-ci-gitleaks.sh's _new_repo helper.
_new_repo() {
  local repo="$1"
  git init -q -b main "$repo" >/dev/null
  git -C "$repo" config user.email "hermetic-e94-test@loki.local"
  git -C "$repo" config user.name "hermetic e94 test"
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath /dev/null
  mkdir -p "$repo/tests"
  : > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm "baseline" --no-gpg-sign --no-verify
  git clone -q --bare "$repo" "$repo.origin.git"
  git -C "$repo" remote add origin "$repo.origin.git"
  git -C "$repo" fetch -q origin
}

# Runs the real extracted function inside $1, and prints its stdout.
_run_scan() {
  local repo="$1"
  ( cd "$repo" && bash -c '
    set -uo pipefail
    TMPDIR="'"$TMP_ROOT"'"
    export TMPDIR
    source "'"$FN_FILE"'"
    _lci_hermetic_scan
  ' )
}

# Scenario 1: a new test file this branch adds calls `gh` directly. It
# passes normally (gh is authenticated on this dev machine) and must fail
# stripped (gh unreachable) -> the scan must FAIL and name the file.
REPO_A="$TMP_ROOT/repo-calls-gh"
_new_repo "$REPO_A"
cat > "$REPO_A/tests/test-calls-gh.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
gh --version >/dev/null
echo "gh reachable"
EOF
chmod +x "$REPO_A/tests/test-calls-gh.sh"
git -C "$REPO_A" add tests/test-calls-gh.sh
git -C "$REPO_A" commit -qm "add a test that calls gh directly" --no-gpg-sign --no-verify

out_a="$(_run_scan "$REPO_A")"; rc_a=$?
if [ "$rc_a" -ne 0 ] && printf '%s\n' "$out_a" | grep -q "tests/test-calls-gh.sh"; then
  ok "a new test calling gh directly fails the scan and is named"
else
  bad "a gh-calling test was not caught (rc=$rc_a, out: $out_a)"
fi

# Scenario 2: a clean test file (no gh, no network) added by the branch must
# pass both runs, so the scan is not just failing everything.
REPO_B="$TMP_ROOT/repo-clean"
_new_repo "$REPO_B"
cat > "$REPO_B/tests/test-clean.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$((1 + 1))" -eq 2 ]
echo "ok"
EOF
chmod +x "$REPO_B/tests/test-clean.sh"
git -C "$REPO_B" add tests/test-clean.sh
git -C "$REPO_B" commit -qm "add a hermetic-clean test" --no-gpg-sign --no-verify

out_b="$(_run_scan "$REPO_B")"; rc_b=$?
if [ "$rc_b" -eq 0 ]; then
  ok "a hermetic-clean changed test passes the scan"
else
  bad "a hermetic-clean test was wrongly flagged (out: $out_b)"
fi

# Scenario 5: a bash4+-only test (mapfile / declare -A) must pass both runs.
# macOS ships /bin/bash 3.2 (no mapfile, no declare -A); without the real
# bash symlinked into the scan's private bindir, this would false-fail
# stripped for a version-gap reason that has nothing to do with credentials.
REPO_E="$TMP_ROOT/repo-bash4"
_new_repo "$REPO_E"
cat > "$REPO_E/tests/test-uses-mapfile.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
declare -A seen=()
seen[x]=1
mapfile -t lines < <(printf 'a\nb\n')
[ "${#lines[@]}" -eq 2 ]
echo "bash4 features ok"
EOF
chmod +x "$REPO_E/tests/test-uses-mapfile.sh"
git -C "$REPO_E" add tests/test-uses-mapfile.sh
git -C "$REPO_E" commit -qm "add a bash4+-only test" --no-gpg-sign --no-verify

out_e="$(_run_scan "$REPO_E")"; rc_e=$?
if [ "$rc_e" -eq 0 ]; then
  ok "a bash4+-only test (mapfile/declare -A) is not false-flagged by a bash version gap"
else
  bad "a bash4+-only test false-failed the scan (out: $out_e) -- /bin/bash 3.2 is leaking in unsymlinked"
fi

# Scenario 3: the real pre-E-92 regression. The old dep-inventory.py's
# self-test fell through to a real `gh api` call for one uncached resolver
# path, so it passed wherever `gh` happened to be authenticated and would
# have failed on the CI runner. Wire the actual historical file in under a
# copy of the real test wrapper and confirm the scan catches it exactly the
# way it caught tests/test-dep-inventory.sh on df7dc134 day. Gated on the old
# self-test actually passing NORMALLY first: if this environment has no `gh`
# authenticated at all, the old file already fails normally too, and this
# scenario would prove nothing.
OLD_DEPINV="$TMP_ROOT/dep-inventory-old.py"
if git -C "$REPO_ROOT" show 4f7f1487^1:scripts/dep-inventory.py > "$OLD_DEPINV" 2>/dev/null \
  && [ -s "$OLD_DEPINV" ] \
  && timeout 30 python3 "$OLD_DEPINV" --self-test >/dev/null 2>&1; then
  REPO_C="$TMP_ROOT/repo-pre-e92"
  _new_repo "$REPO_C"
  mkdir -p "$REPO_C/scripts"
  cp "$OLD_DEPINV" "$REPO_C/scripts/dep-inventory.py"
  # Minimal wrapper: the real test-dep-inventory.sh's load-bearing check (T1)
  # is exactly this call; the DEPS.md-specific assertions (T2/T3) are not
  # part of what this scan is proving, so this fixture stays lean.
  cat > "$REPO_C/tests/test-dep-inventory.sh" <<'EOF'
#!/usr/bin/env bash
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$REPO_ROOT/scripts/dep-inventory.py" --self-test
EOF
  chmod +x "$REPO_C/tests/test-dep-inventory.sh"
  git -C "$REPO_C" add scripts/dep-inventory.py tests/test-dep-inventory.sh
  git -C "$REPO_C" commit -qm "replay pre-E-92 dep-inventory.py self-test" --no-gpg-sign --no-verify

  out_c="$(_run_scan "$REPO_C")"; rc_c=$?
  if [ "$rc_c" -ne 0 ] && printf '%s\n' "$out_c" | grep -q "tests/test-dep-inventory.sh"; then
    ok "the pre-E-92 dep-inventory.py self-test is caught (passes normally, fails stripped)"
  else
    bad "the pre-E-92 regression was not caught (rc=$rc_c, out: $out_c)"
  fi
else
  echo "  SKIP: pre-E-92 dep-inventory.py --self-test does not pass normally here (no gh auth, or history unavailable) -- scenario 3 not run"
fi

# Scenario 4: the REAL, current (post-E-92) dep-inventory.py and its test
# wrapper from THIS repo, replayed verbatim -> must pass BOTH runs. If the
# fixed file cannot survive the scan, the scan is broken against the exact
# incident it exists to guard, and every future push touching it would be
# blocked for no reason.
REPO_D="$TMP_ROOT/repo-current-depinv"
_new_repo "$REPO_D"
mkdir -p "$REPO_D/scripts" "$REPO_D/docs/v10"
cp "$REPO_ROOT/scripts/dep-inventory.py" "$REPO_D/scripts/dep-inventory.py"
cp "$REPO_ROOT/tests/test-dep-inventory.sh" "$REPO_D/tests/test-dep-inventory.sh"
if [ -f "$REPO_ROOT/docs/v10/DEPS.md" ]; then
  cp "$REPO_ROOT/docs/v10/DEPS.md" "$REPO_D/docs/v10/DEPS.md"
fi
git -C "$REPO_D" add scripts/dep-inventory.py tests/test-dep-inventory.sh
git -C "$REPO_D" add docs/v10/DEPS.md 2>/dev/null || true
git -C "$REPO_D" commit -qm "replay the current (fixed) dep-inventory self-test" --no-gpg-sign --no-verify

out_d="$(_run_scan "$REPO_D")"; rc_d=$?
if [ "$rc_d" -eq 0 ]; then
  ok "the current (post-E-92) dep-inventory.py self-test survives the scan (no regression)"
else
  bad "the current, already-fixed dep-inventory.py false-failed the scan (out: $out_d)"
fi

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
