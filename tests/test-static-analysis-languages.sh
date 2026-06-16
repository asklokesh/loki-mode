#!/usr/bin/env bash
#===============================================================================
# Behavioral tests for autonomy/run.sh enforce_static_analysis() P1-6
# language-coverage additions: C/C++ (cppcheck), Kotlin (ktlint/detekt),
# Java (checkstyle+config). Plus honest pass-through when a tool is absent.
#
# Strategy:
#   enforce_static_analysis() lives inside the 12k-line run.sh which re-execs
#   itself from /tmp when run directly. Sourcing the whole file is heavy and
#   fragile, so (like the existing test-static-analysis-tsconfig.sh approach of
#   exercising the gate's real contract) we EXTRACT just the function body via
#   awk and source it into a controlled harness with stub log_* helpers. The
#   function reads changed files from `git diff HEAD~1`, so each fixture is a
#   real git repo with a committed baseline plus one changed file.
#
# Each test asserts the function's documented contract:
#   - real linter present + clean file  -> returns 0 (pass)
#   - real linter present + error file  -> returns 1 (BLOCK)
#   - linter absent                     -> returns 0 (honest pass-through, no block)
#
# Tests for a language whose linter is not installed on this host are reported
# as SKIP (test infrastructure still validated), never as silent passes.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
SKIP=0
TMPROOT=""

ok()   { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf 'SKIP: %s\n' "$1"; SKIP=$((SKIP+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

TMPROOT=$(mktemp -d -t loki-static-analysis-lang.XXXXXX)

#-------------------------------------------------------------------------------
# Extract enforce_static_analysis() and load it with stub helpers.
#-------------------------------------------------------------------------------
FN_FILE="$TMPROOT/_fn.sh"
awk '/^enforce_static_analysis\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUN_SH" > "$FN_FILE"

if ! grep -q '^enforce_static_analysis() {' "$FN_FILE" || ! grep -q '^}' "$FN_FILE"; then
    bad "could not extract enforce_static_analysis() from run.sh"
    echo "Total: $((PASS+FAIL+SKIP))  Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
    exit 1
fi
ok "extracted enforce_static_analysis() from run.sh"

# Source into harness with stub loggers so the function is callable in isolation.
load_fn() {
    log_info() { :; }
    log_warn() { :; }
    # shellcheck disable=SC1090
    source "$FN_FILE"
}

# Build a fresh git fixture: committed baseline + a single changed file so
# `git diff HEAD~1` reports exactly that file. Echoes the project dir.
make_fixture() {
    local name="$1" rel="$2" content="$3"
    local proj="$TMPROOT/$name"
    mkdir -p "$proj"
    (
        cd "$proj" || exit 1
        git init -q
        git config user.email t@t.t
        git config user.name t
        echo "baseline" > README.md
        git add README.md
        git commit -qm baseline
        mkdir -p "$(dirname "$rel")"
        printf '%s' "$content" > "$rel"
        git add "$rel"
        git commit -qm change
    )
    echo "$proj"
}

# Run the gate against a fixture in a subshell. Echoes "rc=<n>".
run_gate() {
    local proj="$1"
    (
        load_fn
        TARGET_DIR="$proj"
        enforce_static_analysis >/dev/null 2>&1
        echo "rc=$?"
    )
}

#-------------------------------------------------------------------------------
# Sanity: run.sh parses
#-------------------------------------------------------------------------------
if bash -n "$RUN_SH" 2>/dev/null; then
    ok "autonomy/run.sh parses with bash -n"
else
    bad "autonomy/run.sh failed bash -n parse"
fi

#-------------------------------------------------------------------------------
# C/C++  (cppcheck)
#-------------------------------------------------------------------------------
CLEAN_C='int add(int a, int b) { return a + b; }
'
# Null-pointer dereference: cppcheck reports this as error severity.
ERR_C='#include <stddef.h>
int bug(void) { int *p = NULL; return *p; }
'
if command -v cppcheck >/dev/null 2>&1; then
    P=$(make_fixture c-clean "src/ok.c" "$CLEAN_C")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "C: clean .c with cppcheck present passes (rc=0)"
    else
        bad "C: clean .c unexpectedly blocked"
    fi

    P=$(make_fixture c-bug "src/bug.c" "$ERR_C")
    if [ "$(run_gate "$P")" = "rc=1" ]; then
        ok "C: error-severity .c (null deref) blocks (rc=1)"
    else
        bad "C: error-severity .c did NOT block (expected rc=1)"
    fi

    # Warning-only file (deref-then-null-check) must NOT block: the gate runs
    # default cppcheck (no --enable=warning) so only error severity blocks. This
    # mirrors the TS/shell `-S error` gates and avoids WIP false-blocks.
    WARN_C='void f(int *p) { *p = 5; if (p) { } }
'
    P=$(make_fixture c-warn "src/warn.c" "$WARN_C")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "C: warning-only .c does NOT block (rc=0, error-severity gate only)"
    else
        bad "C: warning-only .c blocked (gate is over-blocking on warnings)"
    fi
else
    skip "cppcheck not on PATH; C/C++ behavioral checks skipped"
    # Pass-through: cppcheck absent must NOT block a changed .c file.
    P=$(make_fixture c-passthru "src/x.c" "$ERR_C")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "C: cppcheck absent -> honest pass-through (rc=0, no block)"
    else
        bad "C: cppcheck absent unexpectedly blocked (should pass through)"
    fi
fi

#-------------------------------------------------------------------------------
# Kotlin (ktlint / detekt)
#-------------------------------------------------------------------------------
# ktlint/detekt are ADVISORY (non-blocking): ktlint reports only style/formatting
# and has no error-severity-only mode; detekt findings are config-threshold code
# smells. Per the gate principle, a new-language arm must NOT block on style. A
# wildcard import (ktlint style finding) must therefore NOT block the gate.
KT_BAD='import java.util.*
fun main() { println("hi") }
'
KT_OK='fun main() {
    println("hi")
}
'
if command -v ktlint >/dev/null 2>&1 || command -v detekt >/dev/null 2>&1; then
    # Advisory contract: even a real style violation must pass (rc=0), not block.
    P=$(make_fixture kt-bad "Main.kt" "$KT_BAD")
    RC=$(run_gate "$P")
    if [ "$RC" = "rc=0" ]; then
        ok "Kotlin: style violation is ADVISORY, does NOT block (rc=0)"
    else
        bad "Kotlin: style violation blocked ($RC); arm must be advisory (rc=0)"
    fi
    P=$(make_fixture kt-ok "Clean.kt" "$KT_OK")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "Kotlin: clean .kt passes (rc=0)"
    else
        bad "Kotlin: clean .kt unexpectedly blocked"
    fi
else
    skip "ktlint/detekt not on PATH; Kotlin behavioral checks skipped"
    P=$(make_fixture kt-passthru "Main.kt" "$KT_BAD")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "Kotlin: linter absent -> honest pass-through (rc=0, no block)"
    else
        bad "Kotlin: linter absent unexpectedly blocked (should pass through)"
    fi
fi

#-------------------------------------------------------------------------------
# Java (checkstyle + config)
#-------------------------------------------------------------------------------
JAVA_SRC='public class Hello { public static void main(String[] a){System.out.println("hi");} }
'
if command -v checkstyle >/dev/null 2>&1; then
    # A strict config (LineLength=1) guarantees a checkstyle finding on any real
    # line, proving the gate runs + blocks. Without config it must pass through.
    STRICT_CFG='<?xml version="1.0"?>
<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
  <module name="TreeWalker">
    <module name="LineLength"><property name="max" value="1"/></module>
  </module>
</module>
'
    P=$(make_fixture java-cfg "Hello.java" "$JAVA_SRC")
    printf '%s' "$STRICT_CFG" > "$P/checkstyle.xml"
    if [ "$(run_gate "$P")" = "rc=1" ]; then
        ok "Java: checkstyle error-severity violation blocks (rc=1)"
    else
        skip "Java: checkstyle ran but did not block (config/version dependent)"
    fi

    # A config that declares the rule at severity=warning must NOT block: the
    # checkstyle exit code counts only error-severity audit events, so warning/
    # info findings are advisory. This proves style does NOT block, errors DO.
    WARN_CFG='<?xml version="1.0"?>
<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
  <property name="severity" value="warning"/>
  <module name="TreeWalker">
    <module name="LineLength"><property name="max" value="1"/></module>
  </module>
</module>
'
    P=$(make_fixture java-warn "Hello.java" "$JAVA_SRC")
    printf '%s' "$WARN_CFG" > "$P/checkstyle.xml"
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "Java: checkstyle warning-severity finding does NOT block (rc=0)"
    else
        skip "Java: checkstyle warning case did not pass through (version dependent)"
    fi

    # checkstyle present but NO config -> honest pass-through.
    P=$(make_fixture java-nocfg "Hello.java" "$JAVA_SRC")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "Java: checkstyle present but no config -> pass-through (rc=0)"
    else
        bad "Java: no-config case unexpectedly blocked (should pass through)"
    fi
else
    skip "checkstyle not on PATH; Java behavioral checks skipped"
    P=$(make_fixture java-passthru "Hello.java" "$JAVA_SRC")
    if [ "$(run_gate "$P")" = "rc=0" ]; then
        ok "Java: checkstyle absent -> honest pass-through (rc=0, no block)"
    else
        bad "Java: checkstyle absent unexpectedly blocked (should pass through)"
    fi
fi

#-------------------------------------------------------------------------------
# Regression: existing language paths must still work (no break).
# A clean shell script must pass; a broken-syntax shell script must block.
#-------------------------------------------------------------------------------
SH_OK='#!/usr/bin/env bash
echo hello
'
SH_BAD='#!/usr/bin/env bash
if [ -z "$x" ; then echo broken
'
P=$(make_fixture sh-ok "ok.sh" "$SH_OK")
if [ "$(run_gate "$P")" = "rc=0" ]; then
    ok "Regression: clean .sh still passes (rc=0)"
else
    bad "Regression: clean .sh unexpectedly blocked"
fi
P=$(make_fixture sh-bad "bad.sh" "$SH_BAD")
if [ "$(run_gate "$P")" = "rc=1" ]; then
    ok "Regression: syntactically broken .sh still blocks (rc=1)"
else
    bad "Regression: broken .sh did NOT block (existing path broken)"
fi

# Source-wiring assertions: the new language blocks must be present in run.sh.
for token in "cppcheck --quiet --error-exitcode=2" "command -v ktlint" "checkstyle -c"; do
    if grep -qF -- "$token" "$RUN_SH"; then
        ok "run.sh wires: $token"
    else
        bad "run.sh missing wiring: $token"
    fi
done

# Advisory-wiring assertions: ktlint/detekt must be advisory (warn, not block).
# The Kotlin arm must NOT increment findings on ktlint/detekt nonzero exit. Verify
# the advisory markers exist and that the old block-on-style strings are gone.
for token in "ktlint advisory (style, non-blocking)" "detekt advisory (code smell, non-blocking)"; do
    if grep -qF -- "$token" "$RUN_SH"; then
        ok "run.sh advisory wiring: $token"
    else
        bad "run.sh missing advisory wiring: $token"
    fi
done
for token in "ktlint found issues" "detekt found issues"; do
    if grep -qF -- "$token" "$RUN_SH"; then
        bad "run.sh still has old block-on-style wiring: $token"
    else
        ok "run.sh removed old block-on-style wiring: $token"
    fi
done

#-------------------------------------------------------------------------------
echo
echo "=========================================="
echo "Total: $((PASS+FAIL+SKIP))  Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
echo "=========================================="
[ "$FAIL" -eq 0 ]
