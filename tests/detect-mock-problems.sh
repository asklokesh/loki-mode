#!/usr/bin/env bash
# Mock Detector - Quality Gate #8
# Scans test files for problematic mock patterns that mask real failures
#
# Usage: ./tests/detect-mock-problems.sh [--strict]
#   --strict: Exit with error code on any finding (for CI)
#
# Detects:
# 1. Tests that define inline functions and test them instead of importing real code
# 2. Tautological assertions (assert on literal values)
# 3. Conditional assertions that silently pass (if guards around expects)
# 4. Empty test bodies
# 5. Tests with no imports from source code
# 6. Internal mock ratio: mocks of own code vs external service mocks

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory to scan. Defaults to the repo containing this script (so
# run-all-tests.sh keeps scanning loki-mode unchanged). A run.sh gate wrapper
# MUST set LOKI_SCAN_DIR to the target project; cwd is NOT used by find here,
# so `cd TARGET_DIR` alone does not redirect the scan.
PROJECT_DIR="${LOKI_SCAN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STRICT="${1:-}"

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
echo "Mock Detector - Quality Gate #8"
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

local_import_is_source() {
    local test_file="$1"
    local spec="$2"
    local normalized leaf test_dir import_base candidate

    spec="${spec%%\?*}"
    spec="${spec%%#*}"
    # Bash's own lowercase expansion (4.0+). The `printf | tr` it replaces cost
    # TWO forks per import spec -- 149 subprocesses on this repo -- to do what
    # the shell does natively. Falls back to tr on bash 3.2 (stock macOS), which
    # lacks ${var,,}, so behavior is identical on every supported shell.
    if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
        normalized="${spec,,}"
    else
        normalized=$(printf '%s' "$spec" | tr '[:upper:]' '[:lower:]')
    fi
    leaf="${normalized##*/}"

    case "/$normalized/" in
        */__mocks__/*|*/mocks/*|*/mock/*|*/__tests__/*|*/tests/*|*/test/*|*/__fixtures__/*|*/fixtures/*|*/test-utils/*|*/test_utils/*|*/test-helpers/*|*/test_helpers/*)
            return 1
            ;;
    esac
    case "$leaf" in
        mock|mocks|mock.*|mocks.*|mock-*|mock_*|*.mock|*.mock.*|*.test|*.test.*|*.spec|*.spec.*|fixture|fixtures|fixture.*|fixtures.*|test-helper*|test_helper*|test-util*|test_util*|setup-tests*|setup_tests*|setuptests*)
            return 1
            ;;
    esac

    test_dir="${test_file%/*}"
    [ "$test_dir" != "$test_file" ] || test_dir="."
    import_base="$test_dir/$spec"

    case "$leaf" in
        *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.mts|*.cts|*.vue|*.svelte)
            [ -f "$import_base" ] && return 0
            ;;
        *.*) ;;
        *) [ -f "$import_base" ] && return 0 ;;
    esac

    for candidate in \
        "$import_base.js" "$import_base.jsx" "$import_base.ts" "$import_base.tsx" \
        "$import_base.mjs" "$import_base.cjs" "$import_base.mts" "$import_base.cts" \
        "$import_base.vue" "$import_base.svelte" \
        "$import_base/index.js" "$import_base/index.jsx" \
        "$import_base/index.ts" "$import_base/index.tsx" \
        "$import_base/index.mjs" "$import_base/index.cjs" \
        "$import_base/index.mts" "$import_base/index.cts" \
        "$import_base/index.vue" "$import_base/index.svelte"; do
        [ -f "$candidate" ] && return 0
    done
    return 1
}

test_has_source_import() {
    local test_file="$1"
    local line spec import_open=false
    local esm_from_re="^[[:space:]]*import[[:space:]]+.*[[:space:]]from[[:space:]]*['\"](\.{1,2}/[^'\"]+)['\"]"
    local esm_side_re="^[[:space:]]*import[[:space:]]*['\"](\.{1,2}/[^'\"]+)['\"]"
    local esm_continue_re="^[[:space:]]*.*[[:space:]]from[[:space:]]*['\"](\.{1,2}/[^'\"]+)['\"]"
    local cjs_re="require[[:space:]]*\([[:space:]]*['\"](\.{1,2}/[^'\"]+)['\"]"
    # `require.resolve('./x')` names the real module just as `require('./x')`
    # does -- it is how a subprocess/E2E test points at the source it runs.
    # Separate pattern (not an alternation) so the path stays BASH_REMATCH[1].
    local cjs_resolve_re="require\.resolve[[:space:]]*\([[:space:]]*['\"](\.{1,2}/[^'\"]+)['\"]"
    # A test that hands a literal source path to a child process exercises the
    # real code end-to-end without ever naming it in an import. Gated on the
    # file importing child_process, because this flag unlocks a deliberately
    # broad path-literal pattern -- keep the enabling condition as narrow as
    # possible. You cannot spawn in Node without importing child_process, so
    # matching spawnSync/execFile/fork( as well would add no true positives
    # while letting a mock-only test that merely MENTIONS them unlock it.
    # Two shapes, both gated on has_subprocess below:
    #   1. an explicitly-relative path      -- './greet.js', '../src/cli.js'
    #   2. a BARE source filename           -- path.join(__dirname, 'greet.js')
    # Shape 2 is idiomatic Node for locating a sibling script to spawn, and it
    # was the exact form a real benchmark build produced. Requiring a leading
    # './' missed it and re-raised the false positive. The bare form demands a
    # source-code EXTENSION so ordinary string literals ('utf8', 'Hello, Ada!',
    # 'node') can never satisfy it, and local_import_is_source() still has to
    # resolve the name to a real file on disk before it counts.
    local subproc_re="['\"](\.{1,2}/[^'\"]+)['\"]"
    local subproc_bare_re="['\"]([A-Za-z0-9_.-]+\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|rb|go|sh))['\"]"
    # Flags come from two repo-wide `grep -lE` lists built once (P1_CHILD_PROC /
    # P1_SPAWN_CALL), not two greps per file. Identical patterns; membership is a
    # newline-delimited substring test, which stays in-process.
    local has_subprocess=false
    case "$P1_CHILD_PROC" in
        *$'\n'"$test_file"$'\n'*) has_subprocess=true ;;
    esac
    # Stricter companion flag: the file must actually CALL a spawn function, not
    # merely import the module. Guards the deliberately broad bare-filename
    # pattern below (see its comment for the mock-only case this rejects).
    local has_spawn_call=false
    case "$P1_SPAWN_CALL" in
        *$'\n'"$test_file"$'\n'*) has_spawn_call=true ;;
    esac

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            *'jest.mock('*|*'vi.mock('*) continue ;;
        esac
        if [[ "$line" =~ ^[[:space:]]*(//|/\*|\*) ]]; then
            continue
        fi

        # Cheap pre-filter, and a PROVABLE SUPERSET of the branches below -- it
        # can only skip lines that every branch would have rejected anyway.
        # Justification, branch by branch:
        #   - the import_open continuation branches are excluded by requiring
        #     import_open=false here;
        #   - every remaining ESM/CJS branch (esm_from, esm_side, bare `import`,
        #     require, require.resolve) needs the literal "import" or "require";
        #   - the two broad path-literal branches (subproc_re, subproc_bare_re)
        #     are gated on has_subprocess / has_spawn_call, so requiring BOTH to
        #     be false here means neither could have fired.
        # A glob `case` runs in-process; the 7 `[[ =~ ]]` below use variable
        # patterns that bash recompiles on every line, which is the real cost on
        # 43k lines. Skipping a line here is indistinguishable from evaluating
        # all branches and matching none.
        if [ "$import_open" = false ] && [ "$has_subprocess" = false ] && [ "$has_spawn_call" = false ]; then
            case "$line" in
                *import*|*require*) ;;
                *) continue ;;
            esac
        fi

        spec=""
        if [ "$import_open" = true ]; then
            if [[ "$line" =~ $esm_continue_re ]]; then
                spec="${BASH_REMATCH[1]}"
                import_open=false
            elif [[ "$line" == *';'* ]]; then
                import_open=false
            fi
        elif [[ "$line" =~ ^[[:space:]]*import[[:space:]]+type[[:space:]] ]]; then
            continue
        elif [[ "$line" =~ $esm_from_re ]]; then
            spec="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ $esm_side_re ]]; then
            spec="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^[[:space:]]*import[[:space:]] ]]; then
            # Only latch an UNFINISHED multi-line import. A single-line import of
            # a NON-relative module (`import { execFileSync } from
            # 'node:child_process';`) reaches this branch because no ./-relative
            # pattern matched -- latching on it left import_open stuck true for
            # the REST OF THE FILE, so every later line was swallowed by the
            # import_open branch and the subprocess patterns never ran. Effect:
            # an ESM subprocess test was flagged CRITICAL while the
            # byte-identical CJS version passed. Latch only when the statement is
            # genuinely incomplete (no from-clause and no terminator on the line).
            if [[ ! "$line" =~ from[[:space:]]*[\'\"][^\'\"]+[\'\"] ]] && [[ "$line" != *';'* ]]; then
                import_open=true
            fi
        elif [[ "$line" =~ $cjs_resolve_re ]]; then
            spec="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ $cjs_re ]]; then
            spec="${BASH_REMATCH[1]}"
        elif [ "$has_subprocess" = true ] && [[ "$line" =~ $subproc_re ]]; then
            spec="${BASH_REMATCH[1]}"
        elif [ "$has_spawn_call" = true ] && [[ "$line" =~ $subproc_bare_re ]]; then
            # Bare filename ('greet.js'), normalized so local_import_is_source()
            # resolves it against the test's own directory.
            #
            # Gated on has_spawn_call, NOT has_subprocess. An adversarial review
            # produced a mock-only test that imports child_process, assigns
            # `const TARGET_NAME = 'greet.js'`, then asserts on an INLINE stub and
            # never spawns anything -- importing alone let that pass, blinding a
            # fail-closed gate. Requiring an actual spawn INVOCATION somewhere in
            # the file keeps the legitimate shapes (path.join(__dirname,'x.js')
            # assigned on one line and spawned on the next) while rejecting a file
            # that merely imports the module.
            spec="./${BASH_REMATCH[1]}"
        fi

        if [ -n "$spec" ] && local_import_is_source "$test_file" "$spec"; then
            return 0
        fi
    done < "$test_file"
    return 1
}

# File-set discovery. Each pattern below used to run its OWN full-tree `find`
# (four walks). The tree is walked ONCE here and sliced into the three DISTINCT
# sets the patterns actually used -- they are not interchangeable:
#   SET_TEST_ONLY  Pattern 1    -- *.test.* only, e2e excluded
#   SET_TEST_SPEC  Patterns 3,4,6 -- test + spec, no Python
#   SET_WITH_PY    Patterns 2,5  -- test + spec + test_*.py
# Collapsing them would silently change which findings are produced.
SET_WITH_PY=()
SET_TEST_SPEC=()
SET_TEST_ONLY=()
while IFS= read -r _f; do
    [ -n "$_f" ] || continue
    # A tree entry can name a file that vanished mid-scan; grep on a missing
    # file yields no finding, so skip rather than report a phantom.
    [ -f "$_f" ] || continue
    SET_WITH_PY+=("$_f")
    case "$_f" in *.py) continue ;; esac
    SET_TEST_SPEC+=("$_f")
    case "$_f" in
        *.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx) continue ;;
        *e2e*) continue ;;
    esac
    SET_TEST_ONLY+=("$_f")
done < <(find "$PROJECT_DIR" \( \
    -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.test.js" -o -name "*.test.jsx" \
    -o -name "*.spec.ts" -o -name "*.spec.tsx" -o -name "*.spec.js" -o -name "*.spec.jsx" \
    -o -name "test_*.py" \) 2>/dev/null | grep -v node_modules | grep -v dist)

# Run one grep over a whole file set and stream `path:lineno:text` back.
# THE STREAM IS THE ITERATION: grep -H already emits results grouped by file in
# file-list order, so a per-file loop plus a lookup table is redundant work. One
# fork per pattern instead of one per file (2,495 greps measured before).
# -H is mandatory: with a single-file list grep omits the path and the caller
# would parse the line number as the filename.
scan_lines() {
    local pattern="$1"; shift
    [ "$#" -gt 0 ] || return 0
    printf '%s\0' "$@" | xargs -0 grep -nHE -- "$pattern" 2>/dev/null || true
}

# Pattern 1: TypeScript/JavaScript tests that never import from source
# (excludes E2E/spec files which interact via browser, not imports)
echo -e "${CYAN}Scanning for tests that never import real code...${NC}"
# Two repo-wide flag lists + one test-count table, each ONE grep for the whole
# set. Wrapped in newlines so a `case` membership test cannot match a path that
# is merely a suffix of another.
P1_CHILD_PROC=$'\n'
P1_SPAWN_CALL=$'\n'
if [ "${#SET_TEST_ONLY[@]}" -gt 0 ]; then
    P1_CHILD_PROC=$'\n'"$(printf '%s\0' "${SET_TEST_ONLY[@]}" | xargs -0 grep -lE -- "child_process" 2>/dev/null || true)"$'\n'
    P1_SPAWN_CALL=$'\n'"$(printf '%s\0' "${SET_TEST_ONLY[@]}" | xargs -0 grep -lE -- "(spawnSync|spawn|execFile|execFileSync|execSync|exec|fork)[[:space:]]*\\(" 2>/dev/null || true)"$'\n'
fi
# Per-file test counts, one grep -cH for the whole set. `grep -c` prints a row
# for EVERY file including zeros, so this is a complete table.
P1_TEST_COUNT=$'\n'
if [ "${#SET_TEST_ONLY[@]}" -gt 0 ]; then
    P1_TEST_COUNT=$'\n'"$(printf '%s\0' "${SET_TEST_ONLY[@]}" | xargs -0 grep -cHE -- '(it\(|test\(|describe\()' 2>/dev/null || true)"$'\n'
fi
while IFS= read -r test_file; do
    rel_path="${test_file#$PROJECT_DIR/}"

    # Resolve local imports so same-directory source counts, while imports of
    # test helpers, fixtures, mocks, or missing modules do not.
    has_source_import=false
    test_has_source_import "$test_file" && has_source_import=true

    if [ "$has_source_import" = false ]; then
        # Count actual test cases
        # Pull this file's count out of the precomputed table.
        test_count="${P1_TEST_COUNT#*$'\n'"$test_file":}"
        test_count="${test_count%%$'\n'*}"
        case "$test_count" in ''|*[!0-9]*) test_count=0 ;; esac
        if [ "$test_count" -gt 0 ]; then
            report "CRITICAL" "$rel_path" "1" "Test file has $test_count test(s) but never imports source code -- tests only test inline mocks"
        fi
    fi
done < <(printf '%s\n' ${SET_TEST_ONLY[@]+"${SET_TEST_ONLY[@]}"})

# Pattern 2: Tautological assertions on literals
echo -e "${CYAN}Scanning for tautological assertions...${NC}"
# Each of these was one grep PER FILE inside a per-file loop. grep -H already
# emits `path:lineno:text` grouped by file in list order, so the stream IS the
# iteration and the outer loop is redundant. Patterns are byte-identical.
# Process substitution (not a pipe) keeps `report` in the current shell, so the
# HIGH counter still increments -- a pipe would send every count to a subshell
# and silently zero the gate.
while IFS=: read -r f lineno line; do
    report "HIGH" "${f#$PROJECT_DIR/}" "$lineno" "Tautological assertion on literal string"
done < <(scan_lines "assert\.(ok|strictEqual|equal)\(['\"].*['\"]\.includes\(['\"]" ${SET_WITH_PY[@]+"${SET_WITH_PY[@]}"})

while IFS=: read -r f lineno line; do
    report "HIGH" "${f#$PROJECT_DIR/}" "$lineno" "Tautological assertion: expect(literal).toBe(same literal)"
done < <(scan_lines "expect\(true\)\.toBe\(true\)|expect\(false\)\.toBe\(false\)|expect\([0-9]+\)\.toBe\([0-9]+\)" ${SET_WITH_PY[@]+"${SET_WITH_PY[@]}"})

while IFS=: read -r f lineno line; do
    report "HIGH" "${f#$PROJECT_DIR/}" "$lineno" "Tautological assertion: assert.ok(true) always passes"
done < <(scan_lines "assert\.ok\((true|1)\)" ${SET_WITH_PY[@]+"${SET_WITH_PY[@]}"})

# Pattern 3: Conditional assertions (if guards that silently skip)
echo -e "${CYAN}Scanning for conditional assertions...${NC}"
# The if-guard pattern is kept BYTE-IDENTICAL, including the `\s` (a GNU/BSD
# grep -E extension, not POSIX). "Fixing" it to [[:space:]] would be a semantic
# change smuggled in as a cleanup.
#
# Only the DISCOVERY is streamed. The per-match window check keeps its original
# `sed -n` + `grep -q` body: it fires ~167 times total on this repo, which is
# noise next to the 2,495 greps removed elsewhere, and leaving it untouched
# means there is less behavior to re-prove.
# The window check (do lines ln+1..ln+3 contain assert./expect( ?) used to be a
# `sed -n` plus a `grep -q` PER MATCHED LINE. One awk now does both: it re-reads
# each matching file once and tests the same 3-line window with the same
# substring test. Window bounds and match semantics are unchanged; only the
# ~340 subprocesses are gone.
while IFS=: read -r f ln; do
    report "MEDIUM" "${f#$PROJECT_DIR/}" "$ln" "Conditional assertion: expect/assert inside if-guard may silently pass"
done < <(
    scan_lines "if\s*\(.*\)\s*\{?\s*$" ${SET_TEST_SPEC[@]+"${SET_TEST_SPEC[@]}"} \
    | awk -F: '
        # Stream of `path:lineno:text`. Collect the candidate line numbers per
        # path, then read each path once and check its windows.
        { p = $1; hits[p] = hits[p] " " $2 }
        END {
            for (p in hits) {
                nl = 0
                delete L
                while ((getline ln < p) > 0) L[++nl] = ln
                close(p)
                n = split(hits[p], cand, " ")
                for (i = 1; i <= n; i++) {
                    c = cand[i] + 0
                    if (c == 0) continue
                    win = ""
                    for (o = 1; o <= 3; o++) if (c + o <= nl) win = win L[c + o] "\n"
                    if (index(win, "assert.") || index(win, "expect(")) print p ":" c
                }
            }
        }
    ' | sort -t: -k1,1 -k2,2n
)

# Pattern 4: Empty test bodies
echo -e "${CYAN}Scanning for empty test bodies...${NC}"
# it('name', () => {}) or test('name', () => {})
while IFS=: read -r f lineno line; do
    report "MEDIUM" "${f#$PROJECT_DIR/}" "$lineno" "Empty test body -- test does nothing"
done < <(scan_lines "(it|test)\(['\"].*['\"],\s*(\(\)|function\s*\(\))\s*\{?\s*\}?\s*\);" ${SET_TEST_SPEC[@]+"${SET_TEST_SPEC[@]}"})

# Pattern 5: Skipped tests
echo -e "${CYAN}Scanning for skipped tests...${NC}"
# The original capped this at `head -5` PER FILE. In a single stream the cap
# becomes a counter that resets when the path changes -- same 5-per-file limit.
# A counter rather than a pipe because `report` must stay in the current shell.
_p5_file=""
_p5_n=0
while IFS=: read -r f lineno line; do
    if [ "$f" != "$_p5_file" ]; then _p5_file="$f"; _p5_n=0; fi
    _p5_n=$((_p5_n + 1))
    [ "$_p5_n" -le 5 ] || continue
    report "LOW" "${f#$PROJECT_DIR/}" "$lineno" "Skipped test: $line"
done < <(scan_lines "(xit|xtest|xdescribe|\.skip)\(" ${SET_WITH_PY[@]+"${SET_WITH_PY[@]}"})

# Pattern 6: Internal vs External mock classification
# Internal mocks (mocking your own code) are problematic -- you're hiding bugs
# External mocks (mocking HTTP, DB, filesystem, APIs) are expected
echo -e "${CYAN}Scanning for internal mock ratio...${NC}"

# Mock patterns for external services (acceptable)
EXTERNAL_MOCK_PATTERN='(fetch|axios|http|request|database|db\.|redis|pg\.|mysql|mongo|s3|aws|gcp|azure|stripe|twilio|sendgrid|smtp|mailer|fs\.|readFile|writeFile|unlink|mkdir|createServer|listen|connect|socket)'
# Mock patterns for internal code (problematic if excessive)
INTERNAL_MOCK_PATTERN='(jest\.fn|sinon\.stub|sinon\.spy|vi\.fn|mock\(\)|spyOn|jest\.spyOn|stub\()'

# This ratio needs BOTH counts for the same file, so the two `grep -cH` streams
# are joined on path by one awk. The thresholds are unchanged; awk only decides
# WHICH files trip them, and bash still does the reporting so the severity
# counters keep incrementing in the current shell.
#
# `grep -c` emits a row for every file (zeros included), so the join is complete
# and a file missing from the internal stream simply never trips a threshold.
if [ "${#SET_TEST_SPEC[@]}" -gt 0 ]; then
while IFS=: read -r sev f total external; do
    rel_path="${f#$PROJECT_DIR/}"
    if [ "$sev" = "HIGH" ]; then
        report "HIGH" "$rel_path" "1" "High internal mock ratio: $total mocks with 0 external service references -- likely mocking own code"
    else
        report "MEDIUM" "$rel_path" "1" "Elevated internal mock ratio: $total mocks, only $external external refs -- review mock targets"
    fi
done < <(
    {
        printf '%s\0' "${SET_TEST_SPEC[@]}" | xargs -0 grep -cHE -- "$INTERNAL_MOCK_PATTERN" 2>/dev/null | sed 's/^/I:/' || true
        printf '%s\0' "${SET_TEST_SPEC[@]}" | xargs -0 grep -cHE -- "$EXTERNAL_MOCK_PATTERN" 2>/dev/null | sed 's/^/E:/' || true
    } | awk -F: '
        # Rows arrive as I:<path>:<count> then E:<path>:<count>. Rebuild the path
        # from fields 2..NF-1 so a path containing a colon still joins correctly.
        {
            tag = $1; n = $NF
            path = $2
            for (i = 3; i < NF; i++) path = path ":" $i
            if (tag == "I") internal[path] = n; else external[path] = n
        }
        END {
            for (p in internal) {
                t = internal[p] + 0; e = external[p] + 0
                # Thresholds copied verbatim from the original bash conditions.
                if (t > 5 && e == 0)        print "HIGH:" p ":" t ":" e
                else if (t > 10 && e < 3)   print "MEDIUM:" p ":" t ":" e
            }
        }
    ' | sort -t: -k2
)
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

if [ "$STRICT" = "--strict" ]; then
    if [ $CRITICAL -gt 0 ] || [ $HIGH -gt 0 ]; then
        echo ""
        echo -e "${RED}GATE FAILED: $CRITICAL critical + $HIGH high findings${NC}"
        exit 1
    fi
fi

if [ $TOTAL -eq 0 ]; then
    echo -e "${GREEN}All tests pass mock quality gate.${NC}"
fi

exit 0
