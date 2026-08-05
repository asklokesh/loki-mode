#!/usr/bin/env bash
# Test Mutation Detector - Quality Gate #9
# Verifies that test assertions exercise real code paths
#
# Usage: ./tests/detect-test-mutations.sh [--strict] [--block-high] [--commit HASH]
#   --strict: Exit 1 on ANY finding (HIGH/MEDIUM/LOW) -- for CI; over-blocks
#   --block-high: Exit 2 when one or more HIGH-severity findings are present,
#                 0 otherwise. Does NOT block on MEDIUM/LOW. This is the clean
#                 exit-code contract for the run.sh mutation gate wrapper, so it
#                 does not have to grep stdout. --strict takes precedence if both
#                 are passed.
#   --commit HASH: Check specific commit for assertion value mutations
#
# Output contract: every HIGH-severity finding prints a line beginning with the
# literal token "[HIGH]" on stdout (ANSI-colored), so a wrapper may also grep
# '\[HIGH\]' as an alternative to --block-high.
#
# Detects:
# 1. Shell tests where functions are redefined to return canned output
# 2. Test files where all assertions check constant values
# 3. Test files with assertion-to-test ratio below threshold
# 4. Test harnesses that intercept console.error or suppress React act warnings
# 5. Optional UI or storage lookups whose required assertions can silently skip
# 6. Assertion value mutations: commits that change assertion expected values
#    alongside implementation changes (sign of fitting tests to code)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory to scan. Defaults to the repo containing this script (so
# run-all-tests.sh keeps scanning loki-mode unchanged). A run.sh gate wrapper
# MUST set LOKI_SCAN_DIR to the target project; cwd is NOT used by find/git here,
# so `cd TARGET_DIR` alone does not redirect the scan. The Check-5 git history is
# also read from this directory.
PROJECT_DIR="${LOKI_SCAN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STRICT=""
BLOCK_HIGH=""
COMMIT_HASH=""

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --strict) STRICT="--strict"; shift ;;
        --block-high) BLOCK_HIGH="--block-high"; shift ;;
        --commit) COMMIT_HASH="$2"; shift 2 ;;
        *) shift ;;
    esac
done

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

FINDINGS=0
HIGH_FINDINGS=0

echo "=========================================="
echo "Test Mutation Detector - Quality Gate #9"
echo "=========================================="
echo ""

report() {
    local severity="$1"
    local file="$2"
    local message="$3"

    case "$severity" in
        HIGH)   echo -e "${RED}[HIGH]${NC}   $file - $message"; ((HIGH_FINDINGS++)) ;;
        MEDIUM) echo -e "${YELLOW}[MEDIUM]${NC} $file - $message" ;;
        LOW)    echo -e "${CYAN}[LOW]${NC}    $file - $message" ;;
    esac
    ((FINDINGS++))
}

find_js_harness_files() {
    # Filters the ONE shared tree walk (_ALL_MUT_FILES) instead of walking the
    # tree again. The name and -path predicates below are the same set the
    # original `find` expressed, re-expressed as an ERE over full paths; the
    # trailing exclusion grep is unchanged.
    printf '%s\n' "$_ALL_MUT_FILES" \
    | grep -E '(\.(test|spec)\.(ts|tsx|js|jsx)|/(setupTests|test-setup|vitest\.setup|jest\.setup)\.(ts|tsx|js|jsx)|/(vitest|jest)\.config\.(ts|js|mjs|cjs)|/tests?/setup\.(ts|tsx|js|jsx))$' \
    | grep -Ev '/(node_modules|dist|build|coverage|\.git|\.claude|\.loki)/'
}

# Run one grep over a whole file set and stream `path:lineno:text` back.
# THE STREAM IS THE ITERATION: grep -H already emits results grouped by file in
# list order, so a per-file loop plus a lookup is redundant work. One fork per
# pattern instead of one per file (2,779 greps measured before).
# -H is mandatory: on a single-file list grep omits the path and the caller
# would parse the line number as the filename.
# Deliberately duplicated from the mock detector rather than shared: a helper
# file under tests/ would itself be scanned by Checks 1, 3 and 4 and would
# change this detector's own finding counts.
scan_lines() {
    local pattern="$1"; shift
    [ "$#" -gt 0 ] || return 0
    printf '%s\0' "$@" | xargs -0 grep -nHE -- "$pattern" 2>/dev/null || true
}

# Two count streams joined on path by awk. Emits `path:a:b` for every file, so a
# caller can apply the SAME threshold comparison the per-file bash did -- but
# with two greps total instead of two per file, and without the `echo | tr -d`
# laundering (382 forks) that existed only to clean up `grep -c` output.
count_pairs() {
    local pat_a="$1" pat_b="$2"; shift 2
    [ "$#" -gt 0 ] || return 0
    {
        printf '%s\0' "$@" | xargs -0 grep -cHE -- "$pat_a" 2>/dev/null | sed 's/^/A:/' || true
        printf '%s\0' "$@" | xargs -0 grep -cHE -- "$pat_b" 2>/dev/null | sed 's/^/B:/' || true
    } | awk -F: '
        {
            tag = $1; n = $NF
            path = $2
            for (i = 3; i < NF; i++) path = path ":" $i
            if (tag == "A") a[path] = n; else b[path] = n
        }
        END { for (p in a) print p ":" (a[p]+0) ":" (b[p]+0) }
    ' | sort -t: -k1,1
}

# Shell test files, listed once for Checks 1 and 4 (each previously globbed and
# ran 3 greps per file over the same ~378 files).
SHELL_TESTS=()
while IFS= read -r _f; do
    [ -n "$_f" ] && [ -f "$_f" ] && SHELL_TESTS+=("$_f")
done < <(printf '%s\n' "$PROJECT_DIR"/tests/test-*.sh)

# ONE tree walk feeding Checks 2, 3, 5 and 6. Each previously ran its own
# full-tree `find` (three walks, ~700 ms each under load). The walk below is a
# strict SUPERSET of all three; the per-check slices immediately after keep each
# check's own filter, so the distinct sets are preserved exactly:
#   JS_DENSITY     Check 2 -- *.test.ts, *.test.js, *.spec.js only
#   PY_DENSITY     Check 3 -- test_*.py, with its own exclusion list
#   HARNESS_FILES  Checks 5,6 -- the full harness/config/setup set
# The harness set has the widest name list and its own -path predicates, so it
# is matched by re-testing each candidate rather than by narrowing the walk.
_ALL_MUT_FILES=$(find "$PROJECT_DIR" -type f \( \
    -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.test.js" -o -name "*.test.jsx" \
    -o -name "*.spec.ts" -o -name "*.spec.tsx" -o -name "*.spec.js" -o -name "*.spec.jsx" \
    -o -name "test_*.py" \
    -o -name "setupTests.*" -o -name "test-setup.*" \
    -o -name "vitest.setup.*" -o -name "jest.setup.*" \
    -o -name "vitest.config.*" -o -name "jest.config.*" \
    -o -name "setup.ts" -o -name "setup.tsx" -o -name "setup.js" -o -name "setup.jsx" \
    \) 2>/dev/null || true)

# Check 1: Shell tests with function redefinitions that mask real behavior
echo -e "${CYAN}Scanning shell tests for function masking...${NC}"
# Same pattern and same `> 3` threshold; one grep -cH for the whole set instead
# of one grep plus an `echo | tr` pair per file.
if [ "${#SHELL_TESTS[@]}" -gt 0 ]; then
while IFS=: read -r test_file mask_count; do
    [ -n "$mask_count" ] || continue
    if [ "$mask_count" -gt 3 ]; then
        report "LOW" "${test_file#$PROJECT_DIR/}" "Redefines $mask_count source functions (acceptable for log suppression)"
    fi
done < <(printf '%s\0' "${SHELL_TESTS[@]}" \
    | xargs -0 grep -cHE -- '^\s*(log_info|log_warn|log_error|log_step|emit_event|emit_learning_signal)\(\)' 2>/dev/null \
    | sort -t: -k1,1 || true)
fi

# Check 2: JS/TS test files with very low assertion density
echo -e "${CYAN}Scanning for low assertion density...${NC}"
JS_DENSITY=()
while IFS= read -r _f; do
    [ -n "$_f" ] && [ -f "$_f" ] && JS_DENSITY+=("$_f")
done < <(printf '%s\n' "$_ALL_MUT_FILES" | grep -E '\.(test\.ts|test\.js|spec\.js)$' | grep -v node_modules | grep -v dist || true)
# Thresholds unchanged; count_pairs just supplies both counts from two greps
# total instead of two per file.
while IFS=: read -r test_file test_count assert_count; do
    [ -n "$test_count" ] || continue
    if [ "$test_count" -gt 5 ] && [ "$assert_count" -lt "$test_count" ]; then
        report "MEDIUM" "${test_file#$PROJECT_DIR/}" "Low assertion density: $assert_count assertions in $test_count tests (some tests have no assertions)"
    fi
done < <(count_pairs '(it\(|test\()' '(assert\.|expect\(|should\.)' ${JS_DENSITY[@]+"${JS_DENSITY[@]}"})

# Check 3: Python tests with no assertions
echo -e "${CYAN}Scanning Python tests for missing assertions...${NC}"
PY_DENSITY=()
while IFS= read -r _f; do
    [ -n "$_f" ] && [ -f "$_f" ] && PY_DENSITY+=("$_f")
done < <(printf '%s\n' "$_ALL_MUT_FILES" | grep -E '/test_[^/]*\.py$' | grep -vE '/(node_modules|__pycache__|\.claude|\.loki)/' || true)
while IFS=: read -r test_file test_count assert_count; do
    [ -n "$test_count" ] || continue
    if [ "$test_count" -gt 3 ] && [ "$assert_count" -lt "$test_count" ]; then
        report "MEDIUM" "${test_file#$PROJECT_DIR/}" "Low assertion density: $assert_count assertions in $test_count tests"
    fi
done < <(count_pairs '^\s*def test_' '(assert |self\.assert|pytest\.raises|assertEqual|assertTrue|assertFalse|assertRaises|assertIn)' ${PY_DENSITY[@]+"${PY_DENSITY[@]}"})

# Check 4: Shell tests with no pass/fail tracking
echo -e "${CYAN}Scanning shell tests for assertion tracking...${NC}"
# NOTE: the originals used `grep -c` (BRE with \|), not -E. count_pairs uses
# -E, so the alternations are written in ERE here -- the SAME alternation, just
# spelled for the regex dialect in use. `((PASSED` is escaped as `\(\(PASSED`
# because parens are metacharacters in ERE.
if [ "${#SHELL_TESTS[@]}" -gt 0 ]; then
while IFS=: read -r test_file has_pass has_fail; do
    [ -n "$has_pass" ] || continue
    if [ "$has_pass" -eq 0 ] && [ "$has_fail" -eq 0 ]; then
        report "MEDIUM" "${test_file#$PROJECT_DIR/}" "No pass/fail assertion tracking found"
    fi
done < <(count_pairs 'log_pass|PASSED|\(\(PASSED' 'log_fail|FAILED|\(\(FAILED' "${SHELL_TESTS[@]}")
fi

# HARNESS_INTEGRITY_START
# Check 5: console and React warning suppression in test harnesses
echo -e "${CYAN}Scanning test harnesses for hidden console or React act failures...${NC}"
console_error_re="console[[:space:]]*(\.[[:space:]]*error|\[[[:space:]]*['\"]error['\"][[:space:]]*\])[[:space:]]*=|(spyOn|stub|method|replaceProperty)[[:space:]]*\([[:space:]]*([A-Za-z_\$][A-Za-z0-9_\$]*\.)?console[[:space:]]*,[[:space:]]*['\"]error['\"]|mocked[[:space:]]*\([[:space:]]*console[.]error|defineProperty[[:space:]]*\([[:space:]]*console[[:space:]]*,[[:space:]]*['\"]error['\"]"
console_warn_re="console[[:space:]]*(\.[[:space:]]*warn|\[[[:space:]]*['\"]warn['\"][[:space:]]*\])[[:space:]]*=|(spyOn|stub|method|replaceProperty)[[:space:]]*\([[:space:]]*([A-Za-z_\$][A-Za-z0-9_\$]*\.)?console[[:space:]]*,[[:space:]]*['\"]warn['\"]"
HARNESS_FILES=()
while IFS= read -r _f; do
    [ -n "$_f" ] && [ -f "$_f" ] && HARNESS_FILES+=("$_f")
done < <(find_js_harness_files)

# Each of the four greps below ran PER FILE (4 x 172 = ~700 forks). Each now
# runs ONCE over the whole set, and `first_hit_table` keeps only the first
# matching line per path -- the exact effect of the per-file `| head -1`.
#
# The if/elif/elif CHAIN AND ITS `continue`s ARE PRESERVED VERBATIM below. That
# precedence is load-bearing: a file that trips console_error_re must NOT then
# be tested for the config or act patterns. Evaluating the three conditions
# independently would double-report and change the finding set.
first_hit_table() {
    local pattern="$1" ci="$2"; shift 2
    [ "$#" -gt 0 ] || { printf '\n'; return 0; }
    local gflags="-nHE"
    [ "$ci" = "ci" ] && gflags="-nHEi"
    printf '\n'
    printf '%s\0' "$@" | xargs -0 grep $gflags -- "$pattern" 2>/dev/null \
        | awk -F: '!seen[$1]++ { print $1 "\t" $2 }' || true
}
_t_err=$(first_hit_table "$console_error_re" "" ${HARNESS_FILES[@]+"${HARNESS_FILES[@]}"})
_t_cfg=$(first_hit_table '(^|[,{[:space:]])silent[[:space:]]*:[[:space:]]*true|onConsoleLog[[:space:]]*[:(]' "" ${HARNESS_FILES[@]+"${HARNESS_FILES[@]}"})
_t_act=$(first_hit_table 'not wrapped in (an )?act|React act warning|IS_REACT_ACT_ENVIRONMENT[[:space:]]*=[[:space:]]*false' "ci" ${HARNESS_FILES[@]+"${HARNESS_FILES[@]}"})
_t_warn=$(first_hit_table "$console_warn_re|onConsoleLog[[:space:]]*[:(]" "" ${HARNESS_FILES[@]+"${HARNESS_FILES[@]}"})

# Pull one path's first-hit line number out of a table; empty when absent,
# which is what `$(grep ... | head -1)` produced for a non-matching file.
_lookup() {
    local tbl="$1" key="$2" row
    row="${tbl#*$'\n'"$key"$'\t'}"
    [ "$row" != "$tbl" ] || { printf ''; return 0; }
    printf '%s' "${row%%$'\n'*}"
}

for test_file in ${HARNESS_FILES[@]+"${HARNESS_FILES[@]}"}; do
    rel_path="${test_file#$PROJECT_DIR/}"
    hit=$(_lookup "$_t_err" "$test_file")
    if [ -n "$hit" ]; then
        report "HIGH" "$rel_path:${hit}" "Intercepts or mocks console.error, which can hide React errors and act warnings"
        continue
    fi

    config_hit=$(_lookup "$_t_cfg" "$test_file")
    if [ -n "$config_hit" ] && echo "$rel_path" | grep -qE '(vitest|jest)\.config\.'; then
        report "HIGH" "$rel_path:${config_hit}" "Test config suppresses or filters console output"
        continue
    fi

    act_hit=$(_lookup "$_t_act" "$test_file")
    warn_hit=$(_lookup "$_t_warn" "$test_file")
    if [ -n "$act_hit" ] && [ -n "$warn_hit" ]; then
        report "HIGH" "$rel_path:${warn_hit}" "Filters React act warnings from console output"
    fi
done

# Check 6: optional lookup guarded assertions that can execute zero assertions
echo -e "${CYAN}Scanning for vacuous conditional UI assertions...${NC}"
# Check 6 keeps its per-file grep and its awk window body verbatim. Its awk
# fires ~37 times on this repo and the discovery grep ~172 -- both noise next to
# the ~2,700 forks removed from Checks 1-5, and leaving it untouched means there
# is less behavior to re-prove. Only the file list is now the shared one.
# The discovery grep is batched into ONE stream of `path:lineno:text` (it ran
# once per harness file, 172 forks). The awk window body below is untouched --
# it fires ~37 times, which is noise, and leaving it alone means less behavior
# to re-prove. Streaming also removes the outer per-file loop: the path now
# arrives on each row.
_C6_STREAM=""
if [ "${#HARNESS_FILES[@]}" -gt 0 ]; then
    _C6_STREAM=$(printf '%s\0' "${HARNESS_FILES[@]}" | xargs -0 grep -nHE -- '(const|let|var)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[^=]*=.*((local|session)Storage[.]getItem|query(By[A-Za-z]+)?[[:space:]]*\(|querySelector[[:space:]]*\(|getElementById[[:space:]]*\(|boundingBox[[:space:]]*\()' 2>/dev/null || true)
fi
while IFS=: read -r test_file assign_line source_line; do
    [ -n "$assign_line" ] || continue
    [ -f "$test_file" ] || continue
    rel_path="${test_file#$PROJECT_DIR/}"
    if true; then
        [ -n "$assign_line" ] || continue
        guarded_var=$(echo "$source_line" | sed -E 's/.*(const|let|var)[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\2/')
        guard_line=$(awk -v s="$assign_line" -v e="$((assign_line + 40))" -v v="$guarded_var" '
            NR <= s || NR > e { next }
            {
                compact=$0
                gsub(/[[:space:]]/, "", compact)
                if (index(compact, "if(" v ")") || index(compact, "if(" v "!==null)") ||
                    index(compact, "if(" v "!=null)") || index(compact, v "&&expect(")) {
                    print NR
                    exit
                }
            }
        ' "$test_file")
        [ -n "$guard_line" ] || continue

        presence_check=$(awk -v s="$assign_line" -v e="$guard_line" -v v="$guarded_var" '
            NR > s && NR < e && index($0, v) &&
            $0 ~ /(not[.]toBeNull|toBeTruthy|toBeDefined|assert[.](ok|notEqual))/ { print NR; exit }
        ' "$test_file")
        [ -z "$presence_check" ] || continue

        assertion_line=$(awk -v s="$guard_line" -v e="$((guard_line + 10))" '
            NR >= s && NR <= e && $0 ~ /(expect|assert)[[:space:]]*\(/ { print NR; exit }
        ' "$test_file")
        if [ -n "$assertion_line" ]; then
            report "HIGH" "$rel_path:$guard_line" "Required assertion is conditional on optional lookup '$guarded_var' and can silently skip"
        fi
    fi
done <<< "$_C6_STREAM"
# HARNESS_INTEGRITY_END

# Check 7: Assertion value mutations in git commits
# Detects when a commit changes BOTH implementation code AND assertion expected values
# This is a sign of "fitting the test to the code" -- changing what the test expects
# to match what the code produces, rather than fixing the code
echo -e "${CYAN}Scanning for assertion value mutations in commits...${NC}"

# Use provided commit or check the last 5 commits
if [ -n "$COMMIT_HASH" ]; then
    COMMITS_TO_CHECK="$COMMIT_HASH"
else
    COMMITS_TO_CHECK=$(cd "$PROJECT_DIR" && git log --oneline -5 --format='%H' 2>/dev/null || true)
fi

if [ -n "$COMMITS_TO_CHECK" ]; then
    for commit in $COMMITS_TO_CHECK; do
        # Get files changed in this commit
        changed_files=$(cd "$PROJECT_DIR" && git diff-tree --no-commit-id --name-only -r "$commit" 2>/dev/null || true)
        [ -z "$changed_files" ] && continue

        # Classify files: test files vs implementation files
        has_impl=false
        has_test=false
        test_files_changed=""
        impl_files_changed=""

        while IFS= read -r file; do
            # Classification is pure glob matching on a filename, so it is done
            # with `case` instead of `echo | grep -qE` -- that pipeline cost TWO
            # forks per changed file (137 subprocesses across 5 commits) to
            # answer a question the shell answers natively. The alternations
            # below are the same ones the two regexes expressed, enumerated:
            #   test:  *.test.*/*.spec.* in ts|js|tsx|jsx, a leading test/ or
            #          tests/ path, test_*.py, and the vitest|jest|playwright|
            #          cypress config / vitest|jest setup files (repo root or
            #          any subdirectory).
            #   impl:  any remaining .ts .js .tsx .jsx .py .sh
            _is_test=false
            case "$file" in
                *.test.ts|*.test.js|*.test.tsx|*.test.jsx|\
                *.spec.ts|*.spec.js|*.spec.tsx|*.spec.jsx|\
                tests/*|test/*|\
                test_*.py|*/test_*.py|*test_*.py|\
                vitest.config.ts|vitest.config.js|vitest.config.mjs|vitest.config.cjs|\
                jest.config.ts|jest.config.js|jest.config.mjs|jest.config.cjs|\
                playwright.config.ts|playwright.config.js|playwright.config.mjs|playwright.config.cjs|\
                cypress.config.ts|cypress.config.js|cypress.config.mjs|cypress.config.cjs|\
                */vitest.config.ts|*/vitest.config.js|*/vitest.config.mjs|*/vitest.config.cjs|\
                */jest.config.ts|*/jest.config.js|*/jest.config.mjs|*/jest.config.cjs|\
                */playwright.config.ts|*/playwright.config.js|*/playwright.config.mjs|*/playwright.config.cjs|\
                */cypress.config.ts|*/cypress.config.js|*/cypress.config.mjs|*/cypress.config.cjs|\
                vitest.setup.ts|vitest.setup.js|vitest.setup.tsx|vitest.setup.jsx|\
                jest.setup.ts|jest.setup.js|jest.setup.tsx|jest.setup.jsx|\
                */vitest.setup.ts|*/vitest.setup.js|*/vitest.setup.tsx|*/vitest.setup.jsx|\
                */jest.setup.ts|*/jest.setup.js|*/jest.setup.tsx|*/jest.setup.jsx)
                    _is_test=true ;;
            esac
            if [ "$_is_test" = true ]; then
                has_test=true
                test_files_changed="$test_files_changed $file"
            elif case "$file" in *.ts|*.js|*.tsx|*.jsx|*.py|*.sh) true ;; *) false ;; esac; then
                # Implementation source file. The broken `grep -q ... | grep -vq`
                # pipe that previously gated this branch always evaluated false
                # (grep -q emits no stdout, so the piped grep saw empty input and
                # exited 1), which left has_impl permanently false and made the
                # entire HIGH commit-mutation path dead. The .md/.json/.yml
                # extensions cannot match the .ts/.js/... pattern above, so the
                # exclusion grep was redundant and has been removed.
                has_impl=true
                impl_files_changed="$impl_files_changed $file"
            fi
        done <<< "$changed_files"

        # Only flag if BOTH test and implementation files changed in same commit.
        # New test files are not mutations. They have no prior assertions to
        # weaken, and blocking them punishes greenfield projects for adding real
        # coverage alongside their first implementation.
        if [ "$has_impl" = true ] && [ "$has_test" = true ]; then
            modified_test_files=""
            for test_file in $test_files_changed; do
                if (cd "$PROJECT_DIR" \
                    && git cat-file -e "${commit}^:${test_file}" 2>/dev/null \
                    && git cat-file -e "${commit}:${test_file}" 2>/dev/null); then
                    modified_test_files="$modified_test_files $test_file"
                fi
            done
            [ -z "$modified_test_files" ] && continue

            # A real expectation mutation has both a removed assertion and an
            # added replacement assertion. Counting additions alone confused
            # expanded coverage with test fitting. Require at least three paired
            # replacements to preserve the existing high-confidence threshold.
            test_diff=$(cd "$PROJECT_DIR" && git diff "$commit^" "$commit" -- $modified_test_files 2>/dev/null || true)
            removed_assertions=$(echo "$test_diff" | grep -E '^-[^-].*(\.toBe\(|\.toEqual\(|\.toStrictEqual\(|strictEqual\(|deepEqual\(|assertEqual\(|assert.*==)' 2>/dev/null | wc -l | tr -d '[:space:]')
            added_assertions=$(echo "$test_diff" | grep -E '^\+[^+].*(\.toBe\(|\.toEqual\(|\.toStrictEqual\(|strictEqual\(|deepEqual\(|assertEqual\(|assert.*==)' 2>/dev/null | wc -l | tr -d '[:space:]')
            removed_assertions="${removed_assertions:-0}"
            added_assertions="${added_assertions:-0}"
            changed_assertions="$removed_assertions"
            if [ "$added_assertions" -lt "$changed_assertions" ]; then
                changed_assertions="$added_assertions"
            fi

            if [ "$changed_assertions" -gt 2 ]; then
                short_hash=$(echo "$commit" | cut -c1-8)
                report "HIGH" "commit:$short_hash" "Replaced $changed_assertions assertion values alongside implementation code -- possible test fitting"
            fi
        fi
    done
fi

# Summary
echo ""
echo "=========================================="
echo "Results: $FINDINGS finding(s)"
echo "=========================================="

echo "  HIGH:    $HIGH_FINDINGS"

# --strict takes precedence: block on ANY finding (legacy CI behavior, unchanged).
if [ "$STRICT" = "--strict" ] && [ $FINDINGS -gt 0 ]; then
    echo -e "${RED}GATE FAILED: $FINDINGS finding(s)${NC}"
    exit 1
fi

# --block-high: exit 2 only when HIGH-severity findings are present. MEDIUM/LOW
# do not block (they are routed to the findings injector by the run.sh wrapper).
if [ "$BLOCK_HIGH" = "--block-high" ] && [ $HIGH_FINDINGS -gt 0 ]; then
    echo -e "${RED}GATE FAILED: $HIGH_FINDINGS HIGH-severity finding(s)${NC}"
    exit 2
fi

if [ $FINDINGS -eq 0 ]; then
    echo -e "${GREEN}All tests pass mutation detection gate.${NC}"
fi

exit 0
