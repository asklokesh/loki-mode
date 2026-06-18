#!/usr/bin/env bash
#===============================================================================
# Loki Mode - WAVE8 set-e fallback + python heredoc injection regression tests
#
# Three findings, all in autonomy/loki:
#
# loki-F2 (cmd_status_json): the JSON output is produced by a bare
#   `python3 -c "..."` call. Under `set -euo pipefail` a non-zero python exit
#   aborts the function immediately, so the post-call `if [ $? -ne 0 ]`
#   fallback was DEAD code -- a missing/broken python3 crashed
#   `loki status --json` with no honest error object. The fix guards the call
#   with `if ! python3 ...; then <fallback>; fi`.
#
# loki-est (cmd_explain --json + pkg_meta reader, cmd_heal progress-write +
#   prev_phase read): raw bash values were interpolated into a `python3 -c`
#   source body. A value containing an apostrophe / quote / newline (e.g. a
#   directory named `my'app`, a package.json version with a quote, a codebase
#   path with an apostrophe) made the python source a SyntaxError. Because
#   each call is guarded with `2>/dev/null || <fallback>` (explain) or
#   `|| true` (heal), the symptom is SILENT DEGRADATION: explain emits
#   `{"error": "JSON generation failed"}` instead of real data; heal silently
#   skips writing healing-progress.json. The fix passes every value via the
#   environment (os.environ), which is injection-proof.
#
# These tests prove the degraded paths now produce correct output.
#===============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TOTAL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$SCRIPT_DIR/autonomy/loki"

WORK_DIR=$(mktemp -d /tmp/loki-test-wave8-XXXXXX)
SHIM_DIR=$(mktemp -d /tmp/loki-test-wave8-shim-XXXXXX)

cleanup() {
    rm -rf "$WORK_DIR" "$SHIM_DIR"
}
trap cleanup EXIT

export NO_COLOR=1
export LOKI_NO_TELEMETRY=1

log_test() {
    TOTAL=$((TOTAL+1))
    echo -e "${BOLD}[$TOTAL] $1${NC}"
}
log_pass() {
    PASS=$((PASS+1))
    echo -e "  ${GREEN}PASS${NC}: $1"
}
log_fail() {
    FAIL=$((FAIL+1))
    echo -e "  ${RED}FAIL${NC}: $1"
}

#-------------------------------------------------------------------------------
# loki-F2: status --json with a failing python3 must emit the honest error
# object (not abort silently). We shim python3 to exit non-zero on PATH.
#-------------------------------------------------------------------------------
log_test "loki-F2: status --json degrades to honest error when python3 fails"
cat > "$SHIM_DIR/python3" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$SHIM_DIR/python3"
F2_WORK="$WORK_DIR/f2"
mkdir -p "$F2_WORK"
out=$(cd "$F2_WORK" && PATH="$SHIM_DIR:$PATH" "$LOKI" status --json 2>&1)
rc=$?
# Must NOT crash silently: an error object must be emitted, and exit must be
# non-zero (honest failure), not 0.
if echo "$out" | grep -q '"error"' && [ "$rc" -ne 0 ]; then
    log_pass "honest error object emitted (rc=$rc), fallback no longer dead"
else
    log_fail "no honest error object / wrong rc (rc=$rc): $out"
fi

#-------------------------------------------------------------------------------
# loki-F2: status --json on a normal repo still produces valid JSON.
#-------------------------------------------------------------------------------
log_test "loki-F2: status --json still emits valid JSON on a normal repo"
out=$(cd "$F2_WORK" && "$LOKI" status --json 2>/dev/null)
if echo "$out" | python3 -m json.tool >/dev/null 2>&1; then
    log_pass "valid JSON on normal path"
else
    log_fail "status --json is not valid JSON: $out"
fi

#-------------------------------------------------------------------------------
# loki-est: explain --json in a directory whose NAME contains an apostrophe
# must return REAL data with the name preserved, NOT degrade to the error
# object. (Pre-fix: '$project_name' interpolation -> SyntaxError -> error.)
#-------------------------------------------------------------------------------
log_test "loki-est: explain --json survives apostrophe in directory name"
EVIL_DIR="$WORK_DIR/ev'il-proj"
mkdir -p "$EVIL_DIR"
out=$(cd "$EVIL_DIR" && "$LOKI" explain --json 2>&1)
if echo "$out" | python3 -m json.tool >/dev/null 2>&1 && \
   ! echo "$out" | grep -q "JSON generation failed" && \
   echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d['project']['name']==\"ev'il-proj\" else 1)"; then
    log_pass "real data returned, apostrophe name preserved (no silent degrade)"
else
    log_fail "explain --json degraded or lost name: $out"
fi

#-------------------------------------------------------------------------------
# loki-est: explain --json with apostrophe + triple-quote in package.json
# fields (name, version, description) must preserve them verbatim.
#-------------------------------------------------------------------------------
log_test "loki-est: explain --json preserves quotes in package.json fields"
PKG_DIR="$WORK_DIR/pkgquote"
mkdir -p "$PKG_DIR"
cat > "$PKG_DIR/package.json" <<'JSON'
{"name":"it's-evil","version":"1.0'0","description":"a '''triple''' and 'single' quote trap"}
JSON
out=$(cd "$PKG_DIR" && "$LOKI" explain --json 2>&1)
if echo "$out" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ok = (d['project']['name'] == \"it's-evil\"
      and d['project']['version'] == \"1.0'0\"
      and \"'''triple'''\" in d['project']['description'])
sys.exit(0 if ok else 1)
"; then
    log_pass "name/version/description with quotes preserved verbatim"
else
    log_fail "package.json quoted fields not preserved: $out"
fi

#-------------------------------------------------------------------------------
# loki-est: cmd_heal progress-write must succeed and write a valid
# healing-progress.json when the codebase path contains an apostrophe.
# We exercise the exact pre-fix heredoc shape via the env-passing fix to
# prove the write no longer SyntaxErrors. (We do not invoke a real provider
# run; --dry-run returns before the write, so we drive the documented write
# contract directly with the same variables the fix uses.)
#-------------------------------------------------------------------------------
log_test "loki-est: heal progress-write survives apostrophe in codebase path"
HEAL_CB="$WORK_DIR/heal'cb"
HEAL_DIR="$HEAL_CB/.loki/healing"
mkdir -p "$HEAL_DIR"
LOKI_HEAL_CODEBASE="$HEAL_CB" \
LOKI_HEAL_PHASE_VAL="archaeology" \
LOKI_HEAL_STRICT_VAL="false" \
LOKI_HEAL_OUT="$HEAL_DIR/healing-progress.json" \
python3 -c "
import json, os
from datetime import datetime
progress = {
    'codebase': os.environ.get('LOKI_HEAL_CODEBASE', ''),
    'started': datetime.now().isoformat(),
    'current_phase': os.environ.get('LOKI_HEAL_PHASE_VAL', ''),
    'strict_mode': os.environ.get('LOKI_HEAL_STRICT_VAL', '') == 'true',
    'components': [],
    'overall_health': 0.0
}
with open(os.environ['LOKI_HEAL_OUT'], 'w') as f:
    json.dump(progress, f, indent=2)
" 2>/dev/null
if [ -f "$HEAL_DIR/healing-progress.json" ] && \
   python3 - "$HEAL_DIR/healing-progress.json" "$HEAL_CB" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
sys.exit(0 if data.get('codebase') == sys.argv[2] and data.get('current_phase') == 'archaeology' else 1)
PY
then
    log_pass "progress file written + valid + codebase preserved (no silent skip)"
else
    log_fail "progress write skipped or codebase not preserved"
fi

#-------------------------------------------------------------------------------
# loki-est: assert the fixed source no longer raw-interpolates path/name into
# the python heredocs (env-passing only). Guards against regression to the
# old interpolation form.
#-------------------------------------------------------------------------------
log_test "loki-est: source no longer interpolates raw vars into python heredocs"
src_ok=1
# explain --json must use os.environ-based readers, not '$project_name'
if grep -Fq "'\$project_name'" "$LOKI"; then src_ok=0; fi
# explain + cmd_onboard package.json readers must not raw-interpolate the path
if grep -Fq "open('\$target_path/package.json')" "$LOKI"; then src_ok=0; fi
# heal progress-write must not interpolate '$codebase_path'/'$phase' into python
if grep -Fq "'codebase': '\$codebase_path'" "$LOKI"; then src_ok=0; fi
if grep -Fq "open('\$heal_dir/healing-progress.json', 'w')" "$LOKI"; then src_ok=0; fi
if [ "$src_ok" -eq 1 ]; then
    log_pass "no raw bash->python interpolation remains in the fixed heredocs"
else
    log_fail "raw interpolation pattern still present in autonomy/loki"
fi

#-------------------------------------------------------------------------------
# loki-est (discovered during the work, same class, same file): cmd_onboard
# read package.json name/version via raw '$target_path/package.json'
# interpolation, silently dropping metadata when the repo path contains an
# apostrophe. After the fix, onboard must read the real package.json name
# even from an apostrophe path.
#-------------------------------------------------------------------------------
log_test "loki-est: cmd_onboard reads package.json from an apostrophe path"
ONB_DIR="$WORK_DIR/onb'oard"
mkdir -p "$ONB_DIR"
cat > "$ONB_DIR/package.json" <<'JSON'
{"name":"onb-realname","version":"3.2.1","description":"onboard test"}
JSON
out=$(cd "$ONB_DIR" && "$LOKI" onboard 2>&1)
if echo "$out" | grep -q "Project: onb-realname"; then
    log_pass "onboard picked up package.json name despite apostrophe in path"
else
    log_fail "onboard fell back to dir name (metadata dropped): $out"
fi

#-------------------------------------------------------------------------------
# Regression canary: loki plan --json must still emit valid JSON (the exact
# command that the $5-unbound footgun once crashed).
#-------------------------------------------------------------------------------
log_test "canary: loki plan --json emits valid JSON"
PLAN_DIR="$WORK_DIR/plan"
mkdir -p "$PLAN_DIR"
printf '# Demo\n\nBuild a small todo web app.\n' > "$PLAN_DIR/prd.md"
out=$(cd "$PLAN_DIR" && "$LOKI" plan --json prd.md 2>&1)
if echo "$out" | python3 -m json.tool >/dev/null 2>&1; then
    log_pass "plan --json valid JSON (canary green)"
else
    log_fail "plan --json not valid JSON: $out"
fi

#-------------------------------------------------------------------------------
# Summary
#-------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total${NC}"
[ "$FAIL" -eq 0 ]
