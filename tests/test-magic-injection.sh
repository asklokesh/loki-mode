#!/usr/bin/env bash
#===============================================================================
# Python-literal injection regression test for `loki magic` (BUG-PU-010 class).
#
# Before the fix, free-text user input was interpolated RAW into a
# `python3 -c "..."` body in autonomy/loki:
#   - _magic_generate registry block:
#         description='''$description'''.strip()
#         tags=[... '''$tags'''.split(',') ...]
#   - _magic_update:
#         name='${name}'    (and --name was NOT validated)
# A --description / --tags / --name value containing triple-quotes, a single
# quote, a backslash, a newline, or $(...) could close the string literal and
# either crash the python body or execute attacker-chosen python (and, via the
# enclosing bash double-quoted string, attacker-chosen shell). The fix passes
# these values through environment variables read with os.environ in the python
# body (mirroring the established LOKI_MEM_QUERY pattern), and validates --name
# in _magic_update via _magic_valid_name.
#
# This test drives the REAL `loki magic generate` / `loki magic update`
# code paths and the REAL magic.core.* python modules (which run locally with
# no network/provider), inside a mktemp sandbox. After each generate it reads
# the genuine .loki/magic/registry.json that register_component() writes, so it
# asserts on the actual value that crossed the bash->python boundary.
#
# Non-vacuity: the test first proves a NORMAL invocation succeeds AND the
# registry records the exact benign description/tags (so the code path is truly
# exercised, not failing early). If the env-var plumbing regressed to raw
# interpolation, the `'''`/quote/`$(...)` vectors below would crash the python
# body (generate exits non-zero -> assert_no_crash fails) or execute
# `touch $PWNED_MARKER` (assert_not_pwned fails). The malicious-but-inert check
# then confirms a payload string was stored verbatim as data, not run.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/loki-magic-inject.XXXXXX")"
PWNED_MARKER="$SANDBOX/pwned"          # injected code would create this
PWNED_GLOBAL="/tmp/pwned-loki-magic-test"
REGISTRY="$SANDBOX/.loki/magic/registry.json"

cleanup() {
    rm -rf "$SANDBOX" 2>/dev/null || true
    rm -f "$PWNED_GLOBAL" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Make _magic_pypath deterministic regardless of where the test is invoked.
export SKILL_DIR="$REPO_ROOT"

run_generate() {
    ( cd "$SANDBOX" && "$LOKI" magic generate "$@" ) >/dev/null 2>&1
}
run_update() {
    ( cd "$SANDBOX" && "$LOKI" magic update "$@" ) >/dev/null 2>&1
}

# Read a field of the LAST registry component via python (handles quoting).
reg_field() {
    python3 - "$REGISTRY" "$1" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    comps = d.get("components", [])
    if not comps:
        print("<no-components>"); sys.exit(0)
    print(json.dumps(comps[-1].get(sys.argv[2], "<missing>")))
except Exception as e:
    print("<error:%s>" % e)
PYEOF
}

assert_no_crash() {
    local desc="$1"; shift
    if run_generate "$@"; then
        printf 'PASS: no crash -- %s\n' "$desc"
        PASS=$((PASS+1))
    else
        printf 'FAIL: command crashed (rc!=0) -- %s\n' "$desc" >&2
        FAIL=$((FAIL+1))
    fi
}

assert_not_pwned() {
    local desc="$1"
    if [ -e "$PWNED_MARKER" ] || [ -e "$PWNED_GLOBAL" ]; then
        printf 'FAIL: injected code executed (pwn marker present) -- %s\n' "$desc" >&2
        rm -f "$PWNED_MARKER" "$PWNED_GLOBAL" 2>/dev/null || true
        FAIL=$((FAIL+1))
    else
        printf 'PASS: no injected execution -- %s\n' "$desc"
        PASS=$((PASS+1))
    fi
}

#==============================================================================
# 0. Sanity: the real magic modules must be importable, else the test is vacuous.
#==============================================================================
if ! PYTHONPATH="$REPO_ROOT" python3 -c "import magic.core.registry, magic.core.generator, magic.core.spec" 2>/dev/null; then
    printf 'FAIL: real magic.core modules not importable; cannot run a meaningful test\n' >&2
    printf '\n--- summary: 0 passed, 1 failed ---\n'
    exit 1
fi

#==============================================================================
# 1. NON-VACUITY: a normal invocation must succeed and store values intact.
#==============================================================================
if run_generate widgetcard --description "A normal card" --tags "ui,card,demo"; then
    got_desc="$(reg_field description)"
    got_tags="$(reg_field tags)"
    if [ "$got_desc" = '"A normal card"' ]; then
        printf 'PASS: normal description preserved (%s)\n' "$got_desc"
        PASS=$((PASS+1))
    else
        printf 'FAIL: normal description not preserved, got %s\n' "$got_desc" >&2
        FAIL=$((FAIL+1))
    fi
    if [ "$got_tags" = '["ui", "card", "demo"]' ]; then
        printf 'PASS: normal tags preserved (%s)\n' "$got_tags"
        PASS=$((PASS+1))
    else
        printf 'FAIL: normal tags not preserved, got %s\n' "$got_tags" >&2
        FAIL=$((FAIL+1))
    fi
else
    printf 'FAIL: normal generate crashed -- environment/path broken, test is vacuous\n' >&2
    FAIL=$((FAIL+1))
fi

#==============================================================================
# 2. INJECTION VECTORS via --description (must not crash, must not execute).
#==============================================================================
assert_no_crash "triple-quote+python in description" tqdesc \
    --description "x'''+__import__('os').system('touch $PWNED_MARKER')+'''"
assert_not_pwned "triple-quote+python in description"

assert_no_crash "command-substitution in description" cmdsub \
    --description "hi \$(touch $PWNED_GLOBAL)"
assert_not_pwned "command-substitution in description"

assert_no_crash "single-quote in description" sqdesc --description "it's a card"
assert_not_pwned "single-quote in description"

assert_no_crash "backslash+newline in description" bsdesc --description $'line1\\\nline2'
assert_not_pwned "backslash+newline in description"

#==============================================================================
# 3. INJECTION VECTORS via --tags (must not crash, must not execute).
#==============================================================================
assert_no_crash "triple-quote+python in tags" tqtags \
    --tags "a''',__import__('os').system('touch $PWNED_MARKER'),b"
assert_not_pwned "triple-quote+python in tags"

#==============================================================================
# 4. A malicious description must be stored as INERT DATA (proves it crossed the
#    boundary as a plain string and was neither executed nor crashed the body).
#==============================================================================
INERT_PAYLOAD="x'''+payload"
if run_generate inertcheck --description "$INERT_PAYLOAD"; then
    if LOKI_INERT_EXPECT="$INERT_PAYLOAD" python3 - "$REGISTRY" <<'PYEOF'
import json, os, sys
want = os.environ["LOKI_INERT_EXPECT"]
with open(sys.argv[1]) as f:
    d = json.load(f)
got = d["components"][-1].get("description")
sys.exit(0 if got == want else 1)
PYEOF
    then
        printf 'PASS: malicious description stored verbatim/inert\n'
        PASS=$((PASS+1))
    else
        printf 'FAIL: malicious description not stored verbatim, got %s\n' "$(reg_field description)" >&2
        FAIL=$((FAIL+1))
    fi
else
    printf 'FAIL: generate with malicious description crashed (injection not contained)\n' >&2
    FAIL=$((FAIL+1))
fi

#==============================================================================
# 5. _magic_update --name validation: a malicious --name must be REJECTED
#    (defense in depth) and must not execute injected code; a valid one works.
#==============================================================================
if run_update --name "x'+__import__('os').system('touch $PWNED_MARKER')+'"; then
    printf 'FAIL: malicious --name accepted (should be rejected)\n' >&2
    FAIL=$((FAIL+1))
else
    printf 'PASS: malicious --name rejected\n'
    PASS=$((PASS+1))
fi
assert_not_pwned "malicious --name"

if run_update --name widgetcard; then
    printf 'PASS: valid --name update succeeds\n'
    PASS=$((PASS+1))
else
    printf 'FAIL: valid --name update crashed\n' >&2
    FAIL=$((FAIL+1))
fi

printf '\n--- summary: %d passed, %d failed ---\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
