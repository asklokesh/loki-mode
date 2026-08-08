#!/usr/bin/env bash
# `loki verify` picks the test runner the project DECLARES, not one it merely
# has installed.
#
# THE BUG. verify.sh chose its runner with `grep '"jest"' package.json`. That
# matches a DEVDEPENDENCY entry. This repository is the proof: jest is a
# devDependency with NO jest config, while scripts.test runs `bash -n ...` plus
# `node --test`. So verify ran jest, jest globbed 895 files that are not jest
# tests, every one reported "Your test suite must contain at least one test",
# and `loki verify` returned BLOCKED on a clean tree -- permanently, for a
# defect that does not exist.
#
# A false BLOCK on the flagship verification command is worse than a missed
# one. A gate that cries wolf on every run trains users to ignore the verdict,
# which costs more than the gate ever earned.
#
# Note the near-miss: run.sh had already diagnosed this exact trap -- its
# comment reads "with a JSON parser, not grep (grep would false-positive on
# devDeps)" -- but only fixed the trailing `else` branch, leaving three grep
# branches AHEAD of it to shadow the fix. A correct diagnosis in a comment is
# not a fix, and this test is what would have caught the difference.
#
# TEST 3 IS THE LOAD-BEARING ONE: a project that declares a script naming none
# of vitest/jest/mocha must still RUN it via `npm test`. Falling through was
# its own defect -- verify skipped this repo's declared bash/node suite and ran
# PYTEST over a bash/node project.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/verify.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: verify selects the DECLARED test runner, not an installed one"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }

# --- 1. THE REGRESSION: no bare devDependency grep decides the runner -------
# Matched on the PROPERTY (a grep for a runner NAME against package.json is
# what false-positives) rather than on exact wording, so a reformatting does
# not silently disarm this.
_gate_body="$(sed -n '/^verify_gate_tests()/,/^}/p' "$SRC")"
_bad_greps=0
for _r in vitest jest mocha; do
  if printf '%s' "$_gate_body" | grep -q "grep -q '\"$_r\"' \"\$tree/package.json\""; then
    _bad_greps=$((_bad_greps+1))
  fi
done
if [ "$_bad_greps" -eq 0 ]; then
  ok "no runner is selected by grepping package.json for its name"
else
  bad "$_bad_greps runner(s) still selected by a devDependency grep -- the 895-suite false BLOCK returns"
fi

# --- 2. The declaration is read with a JSON PARSER --------------------------
# A substring search one level down would reintroduce the identical bug while
# looking like a fix.
if grep -q '_verify_pkg_test_script' "$SRC" \
   && sed -n '/^_verify_pkg_test_script()/,/^}/p' "$SRC" | grep -q 'json.load'; then
  ok "scripts.test is read with a JSON parser, not a grep"
else
  bad "the declared test script is not parsed as JSON"
fi

# --- 3. THE GUARD: a declared script that names no known runner still RUNS --
if printf '%s' "$_gate_body" | grep -q 'npm test'; then
  ok "a declared script naming no known runner is still run via npm test"
else
  bad "a declared non-vitest/jest/mocha script is skipped -- verify would fall through to pytest"
fi

# --- 4. Behaviour, not just shape: the helper on THIS repo ------------------
# This repo declares bash + node --test and has jest ONLY as a devDependency,
# which is exactly the shape that produced the bug.
# Extracted to a file and SOURCED rather than eval'd. Our own Loki Quality Gate
# flagged the eval form as a HIGH "dangerous eval/exec usage" finding on this
# very PR, which is the gate working: a test is not exempt from the rule it
# exists to protect. Sourcing runs the same real function with no dynamic
# code construction.
_helper_src="$(mktemp "${TMPDIR:-/tmp}/loki-helper-XXXXXX.sh")" || _helper_src=""
_helper_out=""
if [ -n "$_helper_src" ]; then
  sed -n '/^_verify_pkg_test_script()/,/^}/p' "$SRC" > "$_helper_src"
  _helper_out="$(
    set +u
    # shellcheck disable=SC1090
    . "$_helper_src"
    _verify_pkg_test_script "$REPO_ROOT" 2>/dev/null
  )"
  /bin/rm -f "$_helper_src" 2>/dev/null
fi
case "$_helper_out" in
  *jest*)
    bad "the helper returned a script naming jest -- it is reading the wrong key" ;;
  "")
    bad "the helper returned nothing for a repo that DOES declare scripts.test" ;;
  *"node --test"*|*"bash -n"*)
    ok "on this repo the helper returns the real declared script, with no jest in it" ;;
  *)
    ok "the helper returns a declared script (${_helper_out:0:40}...)" ;;
esac

# --- 5. jest really is only a devDependency here ---------------------------
# Pins the fixture the assertions above depend on. If someone adds a jest
# config or moves it to a runner, test 4 stops exercising the bug and this
# says so rather than passing quietly.
_pkg_shape="$(python3 -c "
import json
d = json.load(open('$REPO_ROOT/package.json'))
dev = 'jest' in (d.get('devDependencies') or {})
run = 'jest' in ((d.get('scripts') or {}).get('test') or '')
print('dev' if dev and not run else ('runner' if run else 'absent'))
" 2>/dev/null || echo "error")"
if [ "$_pkg_shape" = "dev" ]; then
  ok "fixture intact: jest is a devDependency and NOT the declared runner"
else
  bad "FIXTURE DRIFT: jest is now '$_pkg_shape' here, so test 4 no longer exercises the devDependency trap"
fi

# --- 6. run.sh's coverage gate has the SAME defect and the SAME fix ---------
# The bug lived in BOTH routes. run.sh had already diagnosed it in a comment
# and fixed only its trailing `else`, leaving three grep branches ahead to
# shadow the fix -- so asserting on verify.sh alone would leave the RARV hot
# path unguarded.
RUNSH="$REPO_ROOT/autonomy/run.sh"
_cov_body="$(sed -n '/^enforce_test_coverage()/,/^}/p' "$RUNSH")"
if [ -z "$_cov_body" ]; then
  bad "could not extract enforce_test_coverage from run.sh"
elif printf '%s' "$_cov_body" | grep -q 'if \[ -n "\$_declared_test_script" \]; then'; then
  ok "run.sh checks the DECLARED script before any installed-package grep"
else
  bad "run.sh still selects a runner before consulting scripts.test"
fi

# --- 7. THE HOLE I INTRODUCED: the first branch must RUN the script --------
# My first attempt put a no-op `:` in that branch, intending to "fall through"
# to the handler in the trailing `else`. Bash does not work that way: the arm
# matched, the `:` ran, the chain exited, and test_runner stayed "none" --
# converting a false BLOCK into a SILENTLY UNMEASURED gate, which is worse.
# Asserted on the property (the branch actually invokes the command) rather
# than on the absence of `:`, which would be wording-matching again.
_first_branch="$(printf '%s' "$_cov_body" | \
  sed -n '/if \[ -n "\$_declared_test_script" \]; then/,/elif grep -q/p')"
if printf '%s' "$_first_branch" | grep -q 'npm test' \
   && printf '%s' "$_first_branch" | grep -q 'test_runner='; then
  ok "the declared-script branch runs the command and sets a runner (no no-op fallthrough)"
else
  bad "the declared-script branch does not invoke the test command -- gate reports runner=none"
fi

# --- 8. Behaviour across all three shapes ----------------------------------
# Structure checks above can pass on code that still picks wrong. This drives
# the selection logic on real package.json fixtures, including the legitimate
# case that must NOT regress: no declared script, runner installed -> use it.
_pick() {
  local dir="$1" declared runner="none"
  declared="$(_LOKI_PKG="$dir/package.json" python3 -c "
import json, os, sys
try:
    with open(os.environ['_LOKI_PKG']) as f: d = json.load(f)
except Exception: sys.exit(0)
if not isinstance(d, dict): sys.exit(0)
t = (d.get('scripts') or {}).get('test') or ''
if 'no test specified' in t.lower(): sys.exit(0)
sys.stdout.write(t.strip())
" 2>/dev/null || echo "")"
  if [ -n "$declared" ]; then
    case "$declared" in
      *"node --test"*|*"node:test"*) runner="node-test" ;;
      *vitest*) runner="vitest" ;; *jest*) runner="jest" ;;
      *mocha*) runner="mocha" ;; *) runner="npm-test" ;;
    esac
  elif grep -q '"jest"' "$dir/package.json" 2>/dev/null; then
    runner="jest"
  fi
  printf '%s' "$runner"
}
_fx="$(mktemp -d "${TMPDIR:-/tmp}/loki-runner-fx-XXXXXX")" || _fx=""
if [ -n "$_fx" ]; then
  printf '{"devDependencies":{"jest":"^29"}}' > "$_fx/package.json"
  [ "$(_pick "$_fx")" = "jest" ] \
    && ok "no declared script + jest installed still selects jest (legit case preserved)" \
    || bad "an installed runner with no declared script is no longer used"

  printf '{"scripts":{"test":"node --test t/*.js"},"devDependencies":{"jest":"^29"}}' > "$_fx/package.json"
  _got="$(_pick "$_fx")"
  [ "$_got" = "node-test" ] \
    && ok "a declared node --test script beats an installed jest (THE BUG)" \
    || bad "declared node --test lost to installed jest: got '$_got'"

  printf '{"scripts":{"test":"jest --ci"},"devDependencies":{"jest":"^29"}}' > "$_fx/package.json"
  [ "$(_pick "$_fx")" = "jest" ] \
    && ok "a declared jest script still selects jest (no over-correction)" \
    || bad "a project that really does use jest no longer selects it"
  /bin/rm -rf "$_fx" 2>/dev/null
else
  bad "could not create a fixture dir (assertions 8a-8c did not run)"
fi

# --- 9. Syntax --------------------------------------------------------------
bash -n "$SRC" 2>/dev/null && ok "verify.sh parses" || bad "verify.sh has a syntax error"
bash -n "$RUNSH" 2>/dev/null && ok "run.sh parses" || bad "run.sh has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
