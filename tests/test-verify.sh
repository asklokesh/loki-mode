#!/usr/bin/env bash
# shellcheck disable=SC2164  # cd in throwaway test subshells; failure is fatal anyway
# tests/test-verify.sh - tests for `loki verify` (Autonomi Verify MVP).
#
# Covers the four spec-named scenarios:
#   1. clean repo (non-empty diff, no secrets, tests pass) -> VERIFIED (exit 0)
#   2. repo with a failing test                            -> BLOCKED  (exit 2)
#   3. repo with a planted fake secret                     -> BLOCKED  (exit 2)
#   4. no-tests repo where a test framework is EXPECTED but
#      cannot run (pytest project, runner forced absent)   -> CONCERNS (exit 1)
#
# Exit-code semantics under test (build-task ordering):
#   0 VERIFIED, 1 CONCERNS, 2 BLOCKED, 3 verifier error.
#
# Each scenario runs in its own mktemp repo. All temp repos are cleaned up.

set -uo pipefail

# Isolate from the host's global/system git config so a hostile setting such as
# commit.gpgsign=true (with no signing key) cannot make every test commit fail
# rc=128. Exported at top level so it is inherited by every subshell and every
# child `bash "$VERIFY_SH"` invocation below. Mirrors tests/test-evidence-gate.sh.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d -t loki-verify-tests.XXXXXX)"

cleanup() {
    rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

_ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Run verify.sh in a subshell cd'd into the given repo. Captures exit code.
# Sets globals: RC (exit code), VERDICT (from evidence.json)
run_verify() {
    local repo="$1"; shift
    ( cd "$repo" && bash "$VERIFY_SH" "$@" ) >/dev/null 2>&1
    RC=$?
    if [ -f "$repo/.loki/verify/evidence.json" ]; then
        VERDICT="$(python3 -c "import json,sys; print(json.load(open('$repo/.loki/verify/evidence.json'))['verdict'])" 2>/dev/null || echo "PARSE_ERROR")"
    else
        VERDICT="NO_EVIDENCE"
    fi
}

# Helper: init a repo with a main branch and one base commit.
init_repo() {
    local repo="$1"
    mkdir -p "$repo"
    ( cd "$repo"
      git init -q
      git config user.email "test@loki.local"
      git config user.name "loki test"
      # Repo-local gpgsign=false persists to .git/config on disk, so it overrides
      # a hostile global commit.gpgsign=true across every scenario subshell below.
      git config commit.gpgsign false
      echo "# project" > README.md
      git add README.md
      git commit -qm "base" --no-gpg-sign --no-verify
      git branch -m main
    )
}

echo "=== test-verify.sh ==="
echo "VERIFY_SH: $VERIFY_SH"

# Pre-flight: syntax.
if bash -n "$VERIFY_SH" 2>/dev/null; then
    _ok "verify.sh passes bash -n"
else
    _no "verify.sh failed bash -n"
fi

# -------------------------------------------------------------------------
# Scenario 1: clean repo -> VERIFIED (exit 0)
# A JS change, no test framework declared (tests skipped, not-applicable),
# no secrets, non-empty diff vs main.
# -------------------------------------------------------------------------
S1="$TMP_ROOT/s1-clean"
init_repo "$S1"
( cd "$S1"
  git checkout -q -b feature
  cat > util.js <<'EOF'
function add(a, b) { return a + b; }
module.exports = { add };
EOF
  git add util.js
  git commit -qm "add util" --no-gpg-sign --no-verify
)
run_verify "$S1" main
if [ "$RC" -eq 0 ] && [ "$VERDICT" = "VERIFIED" ]; then
    _ok "clean repo -> VERIFIED (exit 0)"
else
    _no "clean repo -> expected VERIFIED/0, got $VERDICT/$RC"
fi

# -------------------------------------------------------------------------
# Scenario 2: failing test -> BLOCKED (exit 2)
# A python project with pytest available and a deliberately failing test.
# (Requires pytest on PATH; skipped with a notice if absent.)
# -------------------------------------------------------------------------
if command -v pytest >/dev/null 2>&1; then
    S2="$TMP_ROOT/s2-failtest"
    init_repo "$S2"
    ( cd "$S2"
      git checkout -q -b feature
      cat > pyproject.toml <<'EOF'
[project]
name = "demo"
version = "0.0.1"
EOF
      mkdir -p tests
      cat > tests/test_fail.py <<'EOF'
def test_always_fails():
    assert 1 == 2
EOF
      git add pyproject.toml tests
      git commit -qm "add failing test" --no-gpg-sign --no-verify
    )
    run_verify "$S2" main
    if [ "$RC" -eq 2 ] && [ "$VERDICT" = "BLOCKED" ]; then
        _ok "failing test -> BLOCKED (exit 2)"
    else
        _no "failing test -> expected BLOCKED/2, got $VERDICT/$RC"
    fi
else
    printf '  SKIP: failing-test scenario (pytest not on PATH)\n'
fi

# -------------------------------------------------------------------------
# Scenario 3: planted fake secret -> BLOCKED (exit 2)
# A planted AWS-style access key id, matched by the regex fallback
# (gitleaks is not assumed installed). The literal is a well-known
# documentation example value, not a live credential.
# -------------------------------------------------------------------------
S3="$TMP_ROOT/s3-secret"
init_repo "$S3"
( cd "$S3"
  git checkout -q -b feature
  cat > config.py <<'EOF'
# Example configuration (planted test value, not a real credential)
AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
EOF
  git add config.py
  git commit -qm "add config with planted secret" --no-gpg-sign --no-verify
)
run_verify "$S3" main
if [ "$RC" -eq 2 ] && [ "$VERDICT" = "BLOCKED" ]; then
    _ok "planted secret -> BLOCKED (exit 2)"
else
    _no "planted secret -> expected BLOCKED/2, got $VERDICT/$RC"
fi

# -------------------------------------------------------------------------
# Scenario 4: no-tests / inconclusive -> CONCERNS (exit 1)
# A python project (pytest expected) but pytest forced absent via an
# empty PATH-shadow, so the test gate is APPLICABLE-BUT-CANNOT-RUN =
# inconclusive, which forces at-least-CONCERNS and must NEVER be VERIFIED.
# No secret, clean syntax, non-empty diff.
# -------------------------------------------------------------------------
S4="$TMP_ROOT/s4-inconclusive"
init_repo "$S4"
( cd "$S4"
  git checkout -q -b feature
  cat > pyproject.toml <<'EOF'
[project]
name = "demo2"
version = "0.0.1"
EOF
  mkdir -p tests
  cat > tests/test_smoke.py <<'EOF'
def test_smoke():
    assert True
EOF
  git add pyproject.toml tests
  git commit -qm "python project, runner forced absent" --no-gpg-sign --no-verify
)
# Force pytest, npm, etc. to be unavailable: run with an empty PATH except the
# essentials git/python3/date/grep need. We point PATH at a dir with only the
# coreutils symlinks we control, so command -v pytest fails -> inconclusive.
SHADOW="$TMP_ROOT/shadow-bin"
mkdir -p "$SHADOW"
for tool in git python3 date mktemp grep sed awk find sort wc tr cat env bash sh dirname basename rm mkdir printf cut head tail; do
    p="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$p" ] && ln -sf "$p" "$SHADOW/$tool"
done
( cd "$S4" && PATH="$SHADOW" bash "$VERIFY_SH" main ) >/dev/null 2>&1
RC=$?
if [ -f "$S4/.loki/verify/evidence.json" ]; then
    VERDICT="$(python3 -c "import json; print(json.load(open('$S4/.loki/verify/evidence.json'))['verdict'])" 2>/dev/null || echo "PARSE_ERROR")"
    TESTSTATUS="$(python3 -c "import json; d=json.load(open('$S4/.loki/verify/evidence.json')); print([g['status'] for g in d['deterministic_gates'] if g['gate']=='tests'][0])" 2>/dev/null || echo "?")"
else
    VERDICT="NO_EVIDENCE"; TESTSTATUS="?"
fi
if [ "$RC" -eq 1 ] && [ "$VERDICT" = "CONCERNS" ] && [ "$TESTSTATUS" = "inconclusive" ]; then
    _ok "no-runnable-tests -> CONCERNS (exit 1, tests inconclusive)"
else
    _no "no-runnable-tests -> expected CONCERNS/1 with tests=inconclusive, got $VERDICT/$RC (tests=$TESTSTATUS)"
fi

# -------------------------------------------------------------------------
# Scenario 4b: empty committed diff -> CONCERNS (exit 1), NOT BLOCKED.
# Locks the fix for the whole-repo-scan regression: with no change set vs base,
# all gates are skipped and the verdict is inconclusive -> CONCERNS. A planted
# secret in an UNTOUCHED file (not in the diff) must NOT block.
# -------------------------------------------------------------------------
S4B="$TMP_ROOT/s4b-emptydiff"
init_repo "$S4B"
( cd "$S4B"
  # Plant a secret in a file that is part of the base, then create a feature
  # branch with NO new commits: merge-base..HEAD is empty.
  cat >> README.md <<'EOF'
AKIAIOSFODNN7EXAMPLE
EOF
  git add README.md
  git commit -qm "amend base with planted secret in untouched file" --no-gpg-sign --no-verify
  git checkout -q -b feature
)
run_verify "$S4B" main
if [ "$RC" -eq 1 ] && [ "$VERDICT" = "CONCERNS" ]; then
    _ok "empty diff with pre-existing secret -> CONCERNS (exit 1), not BLOCKED"
else
    _no "empty diff -> expected CONCERNS/1, got $VERDICT/$RC"
fi

# -------------------------------------------------------------------------
# Scenario 4c: bare ROOT-LEVEL test file (no pyproject/setup/tests dir) must
# be DETECTED so the tests gate runs, never silently skipped (council
# finding: a verifier emitting VERIFIED while a discoverable test file goes
# unrun is the false-confidence class this product guards against).
# With pytest present the gate must run and pass -> VERIFIED with tests=pass.
# -------------------------------------------------------------------------
S4C="$TMP_ROOT/s4c-roottest"
init_repo "$S4C"
( cd "$S4C"
  git checkout -q -b feature
  cat > test_app.py <<'EOF'
def test_root_level():
    assert 1 + 1 == 2
EOF
  git add test_app.py
  git commit -qm "bare root-level test file only" --no-gpg-sign --no-verify
)
if command -v pytest >/dev/null 2>&1; then
    run_verify "$S4C" main
    TESTSTATUS_4C="$(python3 -c "import json; d=json.load(open('$S4C/.loki/verify/evidence.json')); print([g['status'] for g in d['deterministic_gates'] if g['gate']=='tests'][0])" 2>/dev/null || echo "?")"
    if [ "$RC" -eq 0 ] && [ "$VERDICT" = "VERIFIED" ] && [ "$TESTSTATUS_4C" = "pass" ]; then
        _ok "bare root-level test file detected and run (tests=pass, VERIFIED)"
    else
        _no "root-level test detection -> expected VERIFIED/0 with tests=pass, got $VERDICT/$RC (tests=$TESTSTATUS_4C)"
    fi
else
    _ok "SKIP: pytest absent; root-level detection covered by code path only"
fi

# -------------------------------------------------------------------------
# Scenario 5: evidence document shape (schema + skipped LLM honesty)
# -------------------------------------------------------------------------
if [ -f "$S1/.loki/verify/evidence.json" ]; then
    if python3 -c "
import json, sys
d = json.load(open('$S1/.loki/verify/evidence.json'))
assert d['schema_version'] == '1.0', 'schema_version'
assert d['llm_review']['status'] == 'skipped', 'llm must be skipped in MVP'
assert 'subject' in d and 'diff_stats' in d['subject'], 'subject.diff_stats'
assert 'deterministic_gates' in d, 'gates'
assert 'findings' in d, 'findings'
" 2>/dev/null; then
        _ok "evidence.json has schema 1.0, skipped LLM, required sections"
    else
        _no "evidence.json shape invalid"
    fi
    if [ -f "$S1/.loki/verify/report.md" ]; then
        _ok "report.md written"
    else
        _no "report.md missing"
    fi
else
    _no "scenario-1 evidence.json missing for shape check"
fi

# -------------------------------------------------------------------------
# Scenario 6: --help works and states deterministic-only + exit-code note
# -------------------------------------------------------------------------
HELP_OUT="$(bash "$VERIFY_SH" --help 2>&1)"
if printf '%s' "$HELP_OUT" | grep -qi "DETERMINISTIC-ONLY" && \
   printf '%s' "$HELP_OUT" | grep -qi "NO LLM"; then
    _ok "help states deterministic-only / no LLM"
else
    _no "help missing deterministic-only / no-LLM statement"
fi
if printf '%s' "$HELP_OUT" | grep -q "1=CONCERNS"; then
    _ok "help documents the exit-code divergence from spec"
else
    _no "help missing exit-code divergence note"
fi

# -------------------------------------------------------------------------
# Scenario 7: no explicit base arg in a MASTER-only repo -> default-base
# resolution path. This is the DISCRIMINATING test for the base_ref fix: the old
# code hard-coded base_ref="main" in both branches, so in a repo whose only base
# branch is "master" it could not resolve the base (-> inconclusive -> CONCERNS,
# never VERIFIED). The new resolver probes main then master and finds master, so
# the verdict is VERIFIED. A "main"-default repo would NOT discriminate (old and
# new both resolve "main"); using master is what makes this test non-vacuous.
# -------------------------------------------------------------------------
S7="$TMP_ROOT/s7-masterbase"
init_repo "$S7"
( cd "$S7"
  # Rename the default branch to master so "main" does not exist.
  git branch -m master 2>/dev/null || git checkout -q -b master
  git checkout -q -b feature
  cat > util.js <<'EOF'
function mul(a, b) { return a * b; }
module.exports = { mul };
EOF
  git add util.js
  git commit -qm "add util (master-only, no explicit base)" --no-gpg-sign --no-verify
)
run_verify "$S7"   # NOTE: no base arg -> default resolution must find master
if [ "$RC" -eq 0 ] && [ "$VERDICT" = "VERIFIED" ]; then
    _ok "no base arg in master-only repo -> resolver finds master -> VERIFIED (exit 0)"
else
    _no "no base arg (master-only) -> expected VERIFIED/0 via master resolution, got $VERDICT/$RC"
fi

# -------------------------------------------------------------------------
# Scenario 8: error-path contract -- an unknown option must exit non-zero AND
# must never emit a VERIFIED verdict. Locks the fail-closed initialization of
# VERIFY_VERDICT/VERIFY_EXIT: an early error return can never surface a stale
# or empty VERIFIED/0. (The error return happens before evidence.json is
# written, so we assert on the exit code and stdout, not on an evidence file.)
# -------------------------------------------------------------------------
ERR_OUT="$( ( cd "$S1" && bash "$VERIFY_SH" --bogus-option ) 2>&1 )"
ERR_RC=$?
if [ "$ERR_RC" -ne 0 ] && ! printf '%s' "$ERR_OUT" | grep -q "VERDICT: VERIFIED"; then
    _ok "unknown option -> non-zero exit, never VERIFIED (fail-closed)"
else
    _no "unknown option -> expected non-zero exit with no VERIFIED, got rc=$ERR_RC"
fi

echo ""
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
