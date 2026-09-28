#!/usr/bin/env bash
#
# tests/test-local-ci-hermetic.sh
#
# E-94: guards scripts/local-ci.sh's fast-tier hermetic changed-tests scan
# (_lci_hermetic_scan) -- the red-main class from df7dc134 day:
# tests/test-dep-inventory.sh passed locally because `gh` was authenticated
# on this Mac, then failed on the CI runner, which has neither `gh` nor
# GH_TOKEN/GITHUB_TOKEN.
#
# Static half: greps local-ci.sh for the scope (tests/, loki-ts/tests/,
# origin/main...HEAD merge-base diff), the stripped-env shape (env -i, fresh
# HOME, minimal PATH), and the fast-tier keep-list membership.
#
# Live half: awk-extracts the REAL _lci_hermetic_scan function body out of
# scripts/local-ci.sh (same technique as
# tests/test-local-ci-parent-exit-isolation.sh) and executes it -- not a
# mirrored reimplementation -- against two scenarios:
#   1. a disposable fixture repo whose new test calls `gh` directly: passes
#      normally (this dev machine has `gh` authenticated), fails stripped ->
#      the scan must FAIL and name the file.
#   2. the actual pre-E-92 scripts/dep-inventory.py (git show
#      4f7f1487^1:scripts/dep-inventory.py) wired in under tests/, run
#      through tests/test-dep-inventory.sh's own self-test path -> the scan
#      must catch it the same way.

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

if grep -q 'env -i HOME="\$home" PATH="/usr/bin:/bin:\$bindir"' "$CI"; then
  ok "stripped run uses env -i with a fresh HOME and a minimal PATH"
else
  bad "stripped-env invocation shape not found"
fi

if grep -q 'holding ONLY symlinks to the bun and python3 binaries' "$CI"; then
  ok "the private bin dir holds only bun+python3 (never gh's real parent dir)"
else
  bad "private-bindir rationale/comment not found (could regress to a whole real bin/ dir)"
fi

if grep -q '"hermetic changed-tests (no gh/network, E-94)"' "$CI"; then
  ok "the scan is on the fast-tier keep list (would not silently defer to full)"
else
  bad "the scan is not on _FAST_KEEP -- it would defer out of the fast tier"
fi

if grep -q 'no changed tests/\*.sh, tests/\*.py, or loki-ts/tests/\*\* vs origin/main' "$CI"; then
  ok "the scan is SKIPPED (not silently passed) when no test file changed"
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

# Runs the real extracted function inside $1, with $2/$3 as the private
# bun/python3 symlink targets (mirrors what local-ci.sh itself resolves via
# `command -v`), and prints its stdout.
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

# Scenario 3: the real pre-E-92 regression. The old dep-inventory.py's
# self-test fell through to a real `gh api` call for one uncached resolver
# path, so it passed wherever `gh` happened to be authenticated and would
# have failed on the CI runner. Wire the actual historical file in under a
# copy of the real test wrapper and confirm the scan catches it exactly the
# way it caught tests/test-dep-inventory.sh on df7dc134 day.
REPO_C="$TMP_ROOT/repo-pre-e92"
_new_repo "$REPO_C"
mkdir -p "$REPO_C/scripts" "$REPO_C/docs/v10"
if git -C "$REPO_ROOT" show 4f7f1487^1:scripts/dep-inventory.py > "$REPO_C/scripts/dep-inventory.py" 2>/dev/null \
  && [ -s "$REPO_C/scripts/dep-inventory.py" ]; then
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
  echo "  SKIP: could not extract git show 4f7f1487^1:scripts/dep-inventory.py (history unavailable) -- scenario 3 not run"
fi

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
