#!/usr/bin/env bash
# Semantic Test-Authenticity Detector - Quality Gate #10
# Catches the HARDER class of fake tests that the regex detectors (gates 5+6,
# tests/detect-mock-problems.sh and tests/detect-test-mutations.sh) miss: tests
# that LOOK like real assertions but verify nothing because the asserted value
# never flows through the code under test.
#
# Usage: ./tests/detect-semantic-test-problems.sh [--strict] [--block-high]
#   --strict:     Exit 1 if ANY CRITICAL or HIGH finding exists (for CI gates).
#                 Mirrors the --strict block in tests/detect-mock-problems.sh.
#   --block-high: Exit 2 when one or more HIGH-severity findings are present, 0
#                 otherwise (clean exit-code contract for a run.sh wrapper that
#                 does not want to grep stdout). --strict takes precedence.
#
# Output contract: every HIGH-severity finding prints a line beginning with the
# literal token "[HIGH]" on stdout (ANSI-colored), so a wrapper may grep
# '\[HIGH\]' as an alternative to --block-high. Same severity tokens as the
# sibling detectors: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW].
#
# ----------------------------------------------------------------------------
# WHAT THIS CATCHES (the gap left by gates 5 and 6)
# ----------------------------------------------------------------------------
# 1. Literal-via-variable echo (HIGH): a variable is bound to a literal, then
#    asserted to equal the SAME literal text, with NO function call between the
#    binding and the assertion. Example (genuinely fake):
#        const x = "hello";
#        expect(x).toBe("hello");      // verifies nothing -- x never changed
#    The regex detectors only catch the inline form expect("hello").toBe("hello")
#    or expect(1).toBe(1); the indirection through a variable defeats them.
#
# 2. Mock-return echo (MEDIUM): within a small window, a mock is configured to
#    return a literal and an assertion checks that SAME literal. The test then
#    only proves the mock returns what you told it to, not that real code works.
#        mockFn.mockReturnValue("ok");
#        expect(result).toBe("ok");    // possibly just echoing the mock
#    MEDIUM (not HIGH) because provenance is uncertain: "result" may legitimately
#    be a transform of the mock output. Conservative by design.
#
# 3. Deleted/weakened assertions across a commit (MEDIUM): a commit that REMOVES
#    more assertion lines than it adds from a test file (the test still "passes"
#    because the check that could fail is gone). Detected from git history, like
#    Check 5 of detect-test-mutations.sh. Degrades silently with no findings
#    outside a git repo or when git returns nothing.
#
# ----------------------------------------------------------------------------
# WHAT THIS DELIBERATELY DOES NOT CATCH (honesty -- read before trusting)
# ----------------------------------------------------------------------------
# - Legitimate computed literal assertions. expect(add(2,2)).toBe(4) is CORRECT
#   testing: 4 is the genuine expected output. Any assertion whose target
#   contains a function call is NEVER flagged -- a call means the value has
#   provenance through code. This is the explicit conservative boundary
#   (prefer false-negatives over false-positives).
# - Deep dataflow. We cannot prove a literal "is just the input" without real
#   dataflow analysis (impossible in bash). We only flag the textually obvious
#   var = literal; expect(var).toBe(SAME literal) with nothing in between.
# - Multi-line assertion targets, template literals with interpolation, and
#   computed property chains -- these are skipped rather than guessed at.
# - The inline tautologies expect(true).toBe(true) / expect(1).toBe(1) -- those
#   are already gate 5's job (detect-mock-problems.sh). No double-reporting.
# - Reassignment between binding and assertion: if anything rebinds the variable,
#   we do not flag (the value may now carry real behavior).
# - Python and shell tests for the literal/mock-echo checks (JS/TS only). The
#   deleted-assertion git check covers .test/.spec.{ts,js,tsx,jsx} only.
#
# ----------------------------------------------------------------------------
# HOW TO WIRE INTO run.sh (mirror enforce_mock_integrity; DO NOT wire here --
# run.sh has another owner this wave). Add alongside the gate-5/6 wrappers:
#
#   enforce_semantic_integrity() {
#       local loki_dir="${TARGET_DIR:-.}/.loki"
#       local quality_dir="$loki_dir/quality"
#       mkdir -p "$quality_dir"
#       local findings_file="$quality_dir/semantic-findings.txt"
#       local detector="$SCRIPT_DIR/../tests/detect-semantic-test-problems.sh"
#       local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"
#       [ -f "$detector" ] || { log_info "Semantic gate: detector not found, skipping"; rm -f "$findings_file" 2>/dev/null||true; return 0; }
#       local output rc
#       output=$(cd "${TARGET_DIR:-.}" && LOKI_SCAN_DIR="${TARGET_DIR:-.}" \
#           timeout "$gate_timeout" bash "$detector" --strict 2>&1); rc=$?
#       if [ "$rc" -eq 124 ]; then log_warn "Semantic gate: timed out -- inconclusive"; rm -f "$findings_file" 2>/dev/null||true; return 0; fi
#       if [ "$rc" -ne 0 ]; then
#           { echo "# Semantic test-authenticity findings (CRITICAL/HIGH block)"; echo "$output" | grep -E '\[(CRITICAL|HIGH|MEDIUM|LOW)\]' || true; } > "$findings_file"
#           log_warn "Semantic gate: CRITICAL/HIGH problems detected -- BLOCK"; return 1
#       fi
#       local med_low; med_low=$(echo "$output" | grep -E '\[(MEDIUM|LOW)\]' || true)
#       if [ -n "$med_low" ]; then { echo "# Semantic advisory findings (MED/LOW, non-blocking)"; echo "$med_low"; } > "$findings_file"; else rm -f "$findings_file" 2>/dev/null||true; fi
#       log_info "Semantic gate: PASS"; return 0
#   }
#
# Then call it from the gate loop next to enforce_mock_integrity /
# enforce_mutation_integrity (run.sh ~14299). Opt out with LOKI_GATE_SEMANTIC=false
# gating the call, matching the LOKI_GATE_MOCK / LOKI_GATE_MUTATION pattern.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory to scan. Defaults to the repo containing this script (so
# run-all-tests.sh keeps scanning loki-mode unchanged). A run.sh gate wrapper
# MUST set LOKI_SCAN_DIR to the target project; cwd is NOT used by find/git here,
# so `cd TARGET_DIR` alone does not redirect the scan. Git history (Check 3) is
# also read from this directory.
PROJECT_DIR="${LOKI_SCAN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

STRICT=""
BLOCK_HIGH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --strict) STRICT="--strict"; shift ;;
        --block-high) BLOCK_HIGH="--block-high"; shift ;;
        *) shift ;;
    esac
done

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

CRITICAL=0
HIGH=0
MEDIUM=0
LOW=0

echo "=========================================="
echo "Semantic Test-Authenticity Detector - Quality Gate #10"
echo "=========================================="
echo ""

report() {
    local severity="$1"
    local file="$2"
    local line="$3"
    local message="$4"

    case "$severity" in
        CRITICAL) echo -e "${RED}[CRITICAL]${NC} $file:$line - $message"; ((CRITICAL++)) ;;
        HIGH)     echo -e "${RED}[HIGH]${NC}     $file:$line - $message"; ((HIGH++)) ;;
        MEDIUM)   echo -e "${YELLOW}[MEDIUM]${NC}   $file:$line - $message"; ((MEDIUM++)) ;;
        LOW)      echo -e "${CYAN}[LOW]${NC}      $file:$line - $message"; ((LOW++)) ;;
    esac
}

# Shared find filter for JS/TS test files (Python tests use different syntax and
# are out of scope for the literal/mock-echo checks here).
find_js_tests() {
    find "$PROJECT_DIR" \( -name "*.test.ts" -o -name "*.test.js" \
        -o -name "*.test.tsx" -o -name "*.test.jsx" \
        -o -name "*.spec.ts" -o -name "*.spec.js" \) 2>/dev/null \
        | grep -v node_modules | grep -v dist
}

# A line whose expect(...) target contains a function call has provenance
# through code and must NEVER be flagged. Returns 0 (true) if the actual value
# passed to expect() contains a call like foo(...) -- including method calls.
# Conservative: when in doubt, treat as "has a call" so we do not flag.
expect_target_has_call() {
    local line="$1"
    # Extract the actual value passed to expect( ... ) up to .toBe / .toEqual.
    local inner
    inner=$(echo "$line" | sed -E 's/.*expect\((.*)\)\.(toBe|toEqual|toStrictEqual|toMatchObject).*/\1/')
    # If sed did not strip anything (no match), be conservative -> treat as call.
    if [ "$inner" = "$line" ]; then
        return 0
    fi
    # A call looks like identifier( ... ). Method chains (.foo()) also count.
    if echo "$inner" | grep -qE '[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\('; then
        return 0
    fi
    return 1
}

# ----------------------------------------------------------------------------
# Check 1: Literal-via-variable echo (HIGH)
#   const|let|var NAME = <literal>;   then   expect(NAME).toBe(<same literal>)
#   with NO function call in the assertion target and no reassignment of NAME
#   between the binding and the assertion.
# ----------------------------------------------------------------------------
echo -e "${CYAN}Scanning for literal-via-variable echo (fake assertions)...${NC}"
while IFS= read -r test_file; do
    [ -f "$test_file" ] || continue
    rel_path="${test_file#$PROJECT_DIR/}"

    # Find variable bindings to a bare string or integer literal.
    #   const x = "hello";   let n = 42;   var s = 'ok';
    while IFS=: read -r bind_lineno bind_line; do
        [ -n "$bind_lineno" ] || continue
        var_name=$(echo "$bind_line" | sed -E "s/^[[:space:]]*(const|let|var)[[:space:]]+([A-Za-z_\$][A-Za-z0-9_\$]*)[[:space:]]*=.*/\2/")
        lit=$(echo "$bind_line" | sed -E "s/^[[:space:]]*(const|let|var)[[:space:]]+[A-Za-z_\$][A-Za-z0-9_\$]*[[:space:]]*=[[:space:]]*//; s/;[[:space:]]*$//")
        [ -n "$var_name" ] || continue
        [ -n "$lit" ] || continue

        # Defense-in-depth: the binding grep below already pins the RHS to a pure
        # single string ('..'/"..") or integer literal, so this re-confirms the
        # extracted literal is exactly that shape. We do NOT additionally reject
        # literals that merely contain operator characters (- + * / & | etc.):
        # those are valid string contents (e.g. "loki-mode", a URL, a path), and
        # rejecting them would silently miss real fakes. $lit is only ever used in
        # a string equality test ([ "$expected" = "$lit" ]), never as a regex, so
        # punctuation in the literal is harmless.
        if ! echo "$lit" | grep -qE "^('[^']*'|\"[^\"]*\"|[0-9]+)$"; then
            continue
        fi

        # Scan a forward window for reassignment (disqualifies) or an assertion
        # echoing the same literal back. Window lines come with absolute line nums.
        window_end=$((bind_lineno + 8))
        flagged_lineno=""
        reassigned=false
        while IFS=: read -r a_lineno a_line; do
            [ -n "$a_lineno" ] || continue
            # Reassignment of the same var (NAME = ... but not const/let/var NAME =).
            if echo "$a_line" | grep -qE "(^|[^A-Za-z0-9_\$.])${var_name}[[:space:]]*=[^=]" \
               && ! echo "$a_line" | grep -qE "(const|let|var)[[:space:]]+${var_name}[[:space:]]*="; then
                reassigned=true
                break
            fi
            # Assertion echoing the same literal back.
            if echo "$a_line" | grep -qE "expect\([[:space:]]*${var_name}[[:space:]]*\)\.(toBe|toEqual|toStrictEqual)\("; then
                if expect_target_has_call "$a_line"; then
                    continue
                fi
                expected=$(echo "$a_line" | sed -E "s/.*expect\([[:space:]]*${var_name}[[:space:]]*\)\.(toBe|toEqual|toStrictEqual)\((.*)\).*/\2/")
                expected=$(echo "$expected" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
                if [ "$expected" = "$lit" ]; then
                    flagged_lineno="$a_lineno"
                fi
            fi
        done < <(awk -v s="$((bind_lineno + 1))" -v e="$window_end" 'NR>=s && NR<=e {print NR":"$0}' "$test_file" 2>/dev/null)

        if [ "$reassigned" = false ] && [ -n "$flagged_lineno" ]; then
            report "HIGH" "$rel_path" "$flagged_lineno" "Literal echo: variable '$var_name' bound to literal $lit and asserted == same literal with no transformation (verifies nothing)"
        fi
    done < <(grep -nE "^[[:space:]]*(const|let|var)[[:space:]]+[A-Za-z_\$][A-Za-z0-9_\$]*[[:space:]]*=[[:space:]]*('[^']*'|\"[^\"]*\"|[0-9]+)[[:space:]]*;[[:space:]]*$" "$test_file" 2>/dev/null)
done < <(find_js_tests)

# ----------------------------------------------------------------------------
# Check 2: Mock-return echo (MEDIUM)
#   Within a small window, a mock is configured to return a literal and an
#   assertion checks that SAME literal. MEDIUM because provenance is uncertain.
# ----------------------------------------------------------------------------
echo -e "${CYAN}Scanning for mock-return echo...${NC}"
while IFS= read -r test_file; do
    [ -f "$test_file" ] || continue
    rel_path="${test_file#$PROJECT_DIR/}"

    while IFS=: read -r mret_lineno mret_line; do
        [ -n "$mret_lineno" ] || continue
        mlit=$(echo "$mret_line" | sed -E "s/.*(mockReturnValueOnce|mockResolvedValueOnce|mockReturnValue|mockResolvedValue|\.returns)\((.*)/\2/")
        mlit=$(echo "$mlit" | sed -E 's/\).*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/;[[:space:]]*$//')
        # Only bare string/number literals.
        echo "$mlit" | grep -qE "^('[^']*'|\"[^\"]*\"|[0-9]+)$" || continue

        window_end=$((mret_lineno + 12))
        while IFS= read -r a_line; do
            echo "$a_line" | grep -qE "\.(toBe|toEqual|toStrictEqual)\(" || continue
            aexpected=$(echo "$a_line" | sed -E "s/.*\.(toBe|toEqual|toStrictEqual)\((.*)\).*/\2/")
            aexpected=$(echo "$aexpected" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
            if [ "$aexpected" = "$mlit" ]; then
                report "MEDIUM" "$rel_path" "$mret_lineno" "Mock-return echo: mock configured to return $mlit and an assertion checks the same literal nearby (may assert the mock, not real behavior)"
                break
            fi
        done < <(awk -v s="$((mret_lineno + 1))" -v e="$window_end" 'NR>=s && NR<=e {print}' "$test_file" 2>/dev/null)
    done < <(grep -nE "(mockReturnValue|mockResolvedValue|mockReturnValueOnce|mockResolvedValueOnce|\.returns)\(" "$test_file" 2>/dev/null)
done < <(find_js_tests)

# ----------------------------------------------------------------------------
# Check 3: Deleted/weakened assertions across commits (MEDIUM)
#   A commit that REMOVES more assertion lines than it adds from a test file
#   (the test still passes because the failing check is gone).
#   Degrades silently outside a git repo (mirrors detect-test-mutations.sh:144).
# ----------------------------------------------------------------------------
echo -e "${CYAN}Scanning for deleted assertions in recent commits...${NC}"
COMMITS_TO_CHECK=$(cd "$PROJECT_DIR" && git log --oneline -5 --format='%H' 2>/dev/null || true)
if [ -n "$COMMITS_TO_CHECK" ]; then
    for commit in $COMMITS_TO_CHECK; do
        changed_test_files=$(cd "$PROJECT_DIR" && git diff-tree --no-commit-id --name-only -r "$commit" 2>/dev/null \
            | grep -E '\.(test|spec)\.(ts|js|tsx|jsx)$' || true)
        [ -z "$changed_test_files" ] && continue

        # shellcheck disable=SC2086
        diff_text=$(cd "$PROJECT_DIR" && git diff "$commit^" "$commit" -- $changed_test_files 2>/dev/null || true)
        [ -z "$diff_text" ] && continue

        assert_re='(\.toBe\(|\.toEqual\(|\.toStrictEqual\(|\.toThrow\(|\.toHaveBeenCalled|strictEqual\(|deepEqual\(|assert\.|assertEqual\()'
        removed=$(echo "$diff_text" | grep -E '^-' | grep -vE '^---' | grep -cE "$assert_re" || true)
        added=$(echo "$diff_text"   | grep -E '^\+' | grep -vE '^\+\+\+' | grep -cE "$assert_re" || true)
        removed="${removed:-0}"; added="${added:-0}"
        removed=$(echo "$removed" | tr -d '[:space:]'); added=$(echo "$added" | tr -d '[:space:]')

        net_removed=$((removed - added))
        if [ "$net_removed" -gt 0 ]; then
            short_hash=$(echo "$commit" | cut -c1-8)
            report "MEDIUM" "commit:$short_hash" "1" "Net $net_removed assertion line(s) removed from test files ($removed removed, $added added) -- weakened tests may still pass"
        fi
    done
fi

# Summary
echo ""
echo "=========================================="
TOTAL=$((CRITICAL + HIGH + MEDIUM + LOW))
echo "Results: $TOTAL finding(s)"
echo "  CRITICAL: $CRITICAL"
echo "  HIGH:     $HIGH"
echo "  MEDIUM:   $MEDIUM"
echo "  LOW:      $LOW"
echo "=========================================="

# --strict takes precedence: block on CRITICAL or HIGH (mirrors gate 5).
if [ "$STRICT" = "--strict" ]; then
    if [ $CRITICAL -gt 0 ] || [ $HIGH -gt 0 ]; then
        echo ""
        echo -e "${RED}GATE FAILED: $CRITICAL critical + $HIGH high findings${NC}"
        exit 1
    fi
fi

# --block-high: exit 2 only when HIGH/CRITICAL present (clean wrapper contract).
if [ "$BLOCK_HIGH" = "--block-high" ]; then
    if [ $CRITICAL -gt 0 ] || [ $HIGH -gt 0 ]; then
        echo -e "${RED}GATE FAILED: $((CRITICAL + HIGH)) HIGH-severity finding(s)${NC}"
        exit 2
    fi
fi

if [ $TOTAL -eq 0 ]; then
    echo -e "${GREEN}All tests pass semantic authenticity gate.${NC}"
fi

exit 0
