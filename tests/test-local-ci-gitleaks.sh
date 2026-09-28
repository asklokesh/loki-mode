#!/usr/bin/env bash
# tests/test-local-ci-gitleaks.sh
#
# E-60: guards scripts/local-ci.sh's fast-tier gitleaks step -- secrets over
# origin/main..HEAD only (not security-audit.yml's full-history "--all" scan),
# using the reviewed .gitleaksignore baseline, SKIPPING (never silently
# passing) when no gitleaks binary is on PATH.
#
# Static half: greps local-ci.sh for the skip path, the ignore-file baseline
# and the origin/main..HEAD scope, so a future edit that drops any of the
# three is caught even on a machine with no gitleaks installed.
#
# Live half (only when gitleaks IS on PATH): drives the EXACT command shape
# local-ci.sh runs against two disposable temp repos, proving the step
# actually distinguishes a real secret from a look-alike:
#   - a commit adding a literal AKIA-shaped token (contiguous in the file)
#     -> the step FAILS.
#   - a commit adding the same characters via source-level concatenation
#     (never contiguous in the committed bytes, the same shape this repo's
#     own test fixtures use to stay gitleaks-clean) -> the step PASSES.
#
# Per CLAUDE.md, a test fixture that looks like a secret must be built at
# runtime by string concatenation so gitleaks never sees a literal -- so this
# file's own source never writes "AKIA" immediately followed by 16
# alphanumeric characters; _akia_prefix and _akia_rest below are joined only
# inside the disposable temp repos, never in this file's committed bytes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CI="$REPO_ROOT/scripts/local-ci.sh"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== local-ci gitleaks fast-tier step (E-60) ==="

[ -f "$CI" ] || { echo "  FAIL: $CI missing"; exit 1; }

# --- static: the step exists, skips (not passes) on a missing tool, and is
#     scoped the way the incident that motivated it required -------------
if grep -q 'gitleaks not installed.*this is a SKIP, not a pass' "$CI"; then
  ok "local-ci.sh skips (not passes) when gitleaks is absent"
else
  bad "local-ci.sh has no explicit skip (not pass) path for a missing gitleaks binary"
fi

if grep -q -- '--gitleaks-ignore-path .gitleaksignore' "$CI"; then
  ok "local-ci.sh's gitleaks step uses the reviewed .gitleaksignore baseline"
else
  bad "local-ci.sh's gitleaks step does not reference .gitleaksignore"
fi

if grep -q 'log-opts="origin/main..HEAD"' "$CI"; then
  ok "local-ci.sh scopes the fast-tier scan to origin/main..HEAD"
else
  bad "local-ci.sh does not scope the gitleaks scan to origin/main..HEAD"
fi

if grep -q '"gitleaks (secrets, origin/main..HEAD)"' "$CI"; then
  ok "the gitleaks step is on the fast-tier keep list (would not silently defer to full)"
else
  bad "the gitleaks step is not on _FAST_KEEP -- it would defer out of the fast tier"
fi

GITLEAKS_BIN="$(command -v gitleaks 2>/dev/null || true)"
if [ -z "$GITLEAKS_BIN" ]; then
  echo "  SKIP: no gitleaks binary on PATH -- live pass/fail scenarios not run (not a pass)"
  echo
  echo "=== $PASS passed, $FAIL failed (live scenarios skipped) ==="
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# --- live: drive the same command shape over disposable temp repos --------
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-ci-gitleaks-test.XXXXXX")"
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

# Mirrors the exact invocation scripts/local-ci.sh's gitleaks step runs.
_run_gitleaks_scope() {
  local repo="$1"
  (cd "$repo" && "$GITLEAKS_BIN" git . \
    --log-opts="origin/main..HEAD" \
    --gitleaks-ignore-path .gitleaksignore \
    --no-banner --redact >/dev/null 2>&1)
}

# A disposable repo with a local "origin/main" to diff against (a bare mirror,
# no network needed) and an empty .gitleaksignore (this test's baseline is
# never the real repo's reviewed one).
_new_repo() {
  local repo="$1"
  git init -q -b main "$repo" >/dev/null
  git -C "$repo" config user.email "gitleaks-e60-test@loki.local"
  git -C "$repo" config user.name "gitleaks e60 test"
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath /dev/null
  : > "$repo/.gitleaksignore"
  git -C "$repo" add .gitleaksignore
  git -C "$repo" commit -qm "baseline" --no-gpg-sign --no-verify
  git clone -q --bare "$repo" "$repo.origin.git"
  git -C "$repo" remote add origin "$repo.origin.git"
  git -C "$repo" fetch -q origin
}

# Built by concatenation so this file's own committed bytes never carry a
# contiguous AKIA-shaped token: "AKIA" + 16 alphanumeric characters is the
# exact AWS access-key-id shape gitleaks' built-in rule matches.
_akia_prefix='AKIA'
_akia_rest='1234567890ABCDEF'

# Scenario A: a literal (contiguous) secret-shaped token committed to a file
# -> the step must FAIL.
REPO_A="$TMP_ROOT/repo-literal"
_new_repo "$REPO_A"
printf '%s\n' "const key = \"${_akia_prefix}${_akia_rest}\";" > "$REPO_A/secret.js"
git -C "$REPO_A" add secret.js
git -C "$REPO_A" commit -qm "add literal secret-shaped fixture" --no-gpg-sign --no-verify

if _run_gitleaks_scope "$REPO_A"; then
  bad "gitleaks accepted a committed literal AKIA-shaped secret (should have failed)"
else
  ok "the step fails on a committed literal AKIA-shaped secret"
fi

# Scenario B: the identical characters, but the FILE constructs them via
# concatenation (two adjacent string literals joined with '" + "'), so they
# are never contiguous in the committed bytes -> the step must PASS.
REPO_B="$TMP_ROOT/repo-concat"
_new_repo "$REPO_B"
printf '%s\n' "const key = \"${_akia_prefix}\" + \"${_akia_rest}\";" > "$REPO_B/secret.js"
git -C "$REPO_B" add secret.js
git -C "$REPO_B" commit -qm "add concatenated non-literal fixture" --no-gpg-sign --no-verify

if _run_gitleaks_scope "$REPO_B"; then
  ok "the step passes when the same characters are never contiguous in the file"
else
  bad "the step blocked a non-contiguous (concatenated) fixture (false positive)"
fi

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
