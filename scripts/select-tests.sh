#!/usr/bin/env bash
# scripts/select-tests.sh -- Tier A fast-gate test selector.
#
# Prints one "<rule>\t<kind>\t<target>" line per suite a change can affect.
# Feedback only: Tier B (the full tests/run-all-tests.sh run in test.yml)
# still runs on every main commit and is the release gate. This is a fast
# heads-up, nothing here blocks anything test.yml doesn't already block.
#
# Usage:
#   scripts/select-tests.sh [--base REF] [--head REF] [--run]
#   scripts/select-tests.sh --files-from FILE [--run]
#   git diff --name-only ... | scripts/select-tests.sh --files - [--run]
#
# --base REF     diff BASE...HEAD to find changed files (default: HEAD^).
# --head REF     the "HEAD" side of that diff (default: HEAD). Needed to
#                evaluate a historical commit c: --base c^ --head c. Without
#                this, --base alone always diffs against the *current* HEAD,
#                which is empty for anything already an ancestor of it.
# --files-from   read changed file paths from FILE (one per line). Used by
#                the selector's own tests to drive fixed scenarios without a
#                real commit. In this mode R3's "changed hunks" refinement for
#                autonomy/run.sh and autonomy/loki is not available (no git
#                history to diff), so those two files fall back to the plain
#                path/basename grep every other source file gets -- a superset,
#                never a miss. ponytail: acceptable for a test-only code path.
# --files -      same, reading paths from stdin.
# --run          also execute every selected suite (bash -n, shellcheck,
#                python syntax, the matched test files, bun test, pytest...)
#                and exit non-zero if any of them fails. R0 runs the full
#                tests/run-all-tests.sh suite untimed (that IS "everything");
#                everything else is capped at 100s per suite.
#
# --guards-only print only the R8 global guard rows (scripts/global-guards.tsv plus the marker-only walkers) and exit.
#
# --gate         pre-BUILT slice gate, one command for a builder and a reviewer:
#                (1) HEAD must contain the current origin/main (never rebases for you),
#                (2) every --guards-only row (tsv rows plus marker-only walkers, one shared emitter), one at a time, red rows named,
#                (3) each --suite PATH (.sh, .test.ts, .py),
#                (4) full engine10 (`bun run test:engine10` in loki-ts, via the slot queue) unless --no-loki-ts.
#                Every row, suite and engine10 is bounded by `timeout -k 15 N`
#                (LOKI_GATE_ROW_TIMEOUT / LOKI_GATE_SUITE_TIMEOUT / LOKI_GATE_ENGINE10_TIMEOUT);
#                a timeout, an empty guard list, a failed fetch or a missing bun FAILS the gate.
#                Prints a pass/fail summary per step; exits non-zero on any failure.
#   --suite PATH   extra suite for step 3 (repeatable)
#   --no-loki-ts   the slice touched no loki-ts source: skip step 4 and say so
#   --no-fetch     do not fetch origin main before step 1 (a failed fetch otherwise fails the gate)
#   --origin-ref R ref step 1 compares against (default origin/main)
#
# R0-R8 selection rules are implemented below, in order. R8 (always-on global
# guards) is declared in scripts/global-guards.tsv and emitted for every
# non-empty, non-R0 diff, docs-only included (GATE-GUARDS, FC-41).
set -uo pipefail  # not -e: grep/diff "no match" is an expected rc 1 throughout

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

BASE_REF=""
HEAD_REF=""
FILES_FROM=""
MODE="git"
DO_RUN=0
GUARDS_ONLY=0
GATE=0
GATE_SUITES=()
GATE_NO_LOKI_TS=0
GATE_FETCH=1
GATE_ORIGIN_REF="origin/main"

while [ $# -gt 0 ]; do
    case "$1" in
        --base) BASE_REF="${2:-}"; shift 2 ;;
        --head) HEAD_REF="${2:-}"; shift 2 ;;
        --files-from) MODE="files"; FILES_FROM="${2:-}"; shift 2 ;;
        --files) MODE="files"; FILES_FROM="${2:--}"; shift 2 ;;
        --run) DO_RUN=1; shift ;;
        --guards-only) GUARDS_ONLY=1; shift ;;
        --gate) GATE=1; shift ;;
        --suite) GATE_SUITES+=("${2:-}"); shift 2 ;;
        --no-loki-ts) GATE_NO_LOKI_TS=1; shift ;;
        --no-fetch) GATE_FETCH=0; shift ;;
        --origin-ref) GATE_ORIGIN_REF="${2:-origin/main}"; shift 2 ;;
        -h | --help)
            sed -n '2,48p' "$0"
            exit 0
            ;;
        *)
            echo "select-tests: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

GUARDS_TSV="${SELECT_TESTS_GUARDS_TSV:-$SCRIPT_DIR/global-guards.tsv}"

# R8: the repo-wide guards, always selected. The one row emitter: tsv rows plus the marker-only walkers,
# used by --guards-only and by --gate step 2 so the two row sets cannot drift. Returns non-zero (after
# printing an R0 row) on a missing tsv or a failed walker grep so callers can fail closed.
emit_guard_rows() {
    local gk gt
    [ -f "$GUARDS_TSV" ] || { emit R0 ALL "scripts/global-guards.tsv missing"; return 1; }
    while IFS=$'\t' read -r gk gt || [ -n "$gk" ]; do
        case "$gk" in '' | '#'*) continue ;; esac
        [ -n "$gt" ] || continue
        emit R8 "$gk" "$gt"
    done <"$GUARDS_TSV"
    emit_marked_walkers
}

# bun tests that walk the whole loki-ts/src tree name no src stem, so R4 never selects them. Each carries
# the marker "select: walk-all-src" and is found here by content, so a new walker needs no list edit. Files that a
# declared tsv row already covers (exact path, or a bun_test directory row above them) are not repeated.
emit_marked_walkers() {
    local mf covered gk gt found grc
    [ -d loki-ts/tests ] || return 0
    found="$(grep -rlF 'select: walk-all-src' loki-ts/tests --include='*.test.ts' 2>/dev/null)"; grc=$?
    if [ "$grc" -gt 1 ]; then
        emit R0 ALL "walker grep failed (rc=$grc)"
        return 1
    fi
    [ -n "$found" ] || return 0
    while IFS= read -r mf; do
        [ -n "$mf" ] || continue
        covered=0
        while IFS=$'\t' read -r gk gt; do
            case "$gk" in bun_test) ;; *) continue ;; esac
            case "$mf" in "$gt" | "$gt"/*) covered=1; break ;; esac
        done <"$GUARDS_TSV"
        [ "$covered" -eq 1 ] || emit R8 bun_test "$mf"
    done < <(printf '%s\n' "$found" | LC_ALL=C sort)
}

# ---- --gate: the pre-BUILT slice gate -------------------------------
# Separate from the selector and --run paths. Engine10 goes through the one
# function gate_run_engine10 so a queue lock can wrap it. Every row, suite and
# engine10 run is bounded by `timeout -k 15 N` (the helper the repo already
# uses); a timed-out unit counts as FAILED and is named in the summary.
# Env: LOKI_GATE_ROW_TIMEOUT (default 600s), LOKI_GATE_SUITE_TIMEOUT (900s),
# LOKI_GATE_ENGINE10_TIMEOUT (2400s); a non-positive-integer value is ignored.
gate_secs() { # $1 = env value, $2 = default
    case "$1" in '' | *[!0-9]* | 0*) echo "$2" ;; *) echo "$1" ;; esac
}
GATE_ROW_SECS="$(gate_secs "${LOKI_GATE_ROW_TIMEOUT:-}" 600)"
GATE_SUITE_SECS="$(gate_secs "${LOKI_GATE_SUITE_TIMEOUT:-}" 900)"
GATE_ENGINE10_SECS="$(gate_secs "${LOKI_GATE_ENGINE10_TIMEOUT:-}" 2400)"

gate_timeout_bin() {
    local t
    for t in timeout gtimeout; do
        if command -v "$t" >/dev/null 2>&1; then echo "$t"; return 0; fi
    done
    return 1
}

gate_bounded() { # $1 = seconds, rest = command
    local secs="$1" tbin
    shift
    tbin="$(gate_timeout_bin)" || { echo "gate: no timeout helper (timeout/gtimeout) on PATH" >&2; return 125; }
    "$tbin" -k 15 "$secs" "$@"
}

gate_timed_out() { [ "$1" -eq 124 ] || [ "$1" -eq 137 ]; }

gate_run_engine10() {
    # Prefer the package script (goes through scripts/test-slot.sh, so at most
    # a fixed number of full runs per machine). A tree without that script
    # falls back to the bare run and says so.
    if grep -q '"test:engine10"' loki-ts/package.json 2>/dev/null; then
        ( cd loki-ts && gate_bounded "$GATE_ENGINE10_SECS" bun run test:engine10 )
    else
        echo "gate: note: loki-ts/package.json has no test:engine10 script, running bun test directly (no slot queue)"
        ( cd loki-ts && gate_bounded "$GATE_ENGINE10_SECS" bun test tests/engine10 )
    fi
}

gate_run_row() {
    local kind="$1" target="$2"
    case "$kind" in
        bun_test) ( cd loki-ts && gate_bounded "$GATE_ROW_SECS" bun test "${target#loki-ts/}" ) ;;
        shell_test | moat) gate_bounded "$GATE_ROW_SECS" bash "$target" ;;
        *) echo "gate: unknown guard row kind: $kind" >&2; return 2 ;;
    esac
}

gate_run_suite() {
    case "$1" in
        *.sh) gate_bounded "$GATE_SUITE_SECS" bash "$1" ;;
        *.test.ts) ( cd loki-ts && gate_bounded "$GATE_SUITE_SECS" bun test "${1#loki-ts/}" ) ;;
        *.py) gate_bounded "$GATE_SUITE_SECS" python3 -m pytest -q "$1" ;;
        *) echo "gate: unrecognized suite type: $1" >&2; return 2 ;;
    esac
}

run_gate() {
    local rc=0 behind behind_rc rows_pass=0 rows_fail=0 suites_pass=0 suites_fail=0
    local failed_rows="" failed_suites="" s1 s2 s3 s4 gk gt gr gate_rows rows_rc suite urc fetch_failed=0

    echo "=== gate step 1: HEAD contains $GATE_ORIGIN_REF ==="
    if [ "$GATE_FETCH" -eq 1 ]; then
        if ! git fetch -q origin main; then
            echo "gate: fetch of origin main failed; refusing to compare against a stale local $GATE_ORIGIN_REF (pass --no-fetch to accept it)"
            fetch_failed=1
        fi
    fi
    if [ "$fetch_failed" -eq 1 ]; then
        s1="FAIL (fetch of origin main failed; --no-fetch skips the fetch)"; rc=1
    elif ! git rev-parse --verify -q "$GATE_ORIGIN_REF" >/dev/null; then
        echo "gate: cannot resolve $GATE_ORIGIN_REF"
        s1="FAIL (unresolvable $GATE_ORIGIN_REF)"; rc=1
    else
        behind="$(git rev-list --count "HEAD..$GATE_ORIGIN_REF")"; behind_rc=$?
        case "$behind" in '' | *[!0-9]*) behind_rc=1 ;; esac
        if [ "$behind_rc" -ne 0 ]; then
            echo "gate: rev-list failed for HEAD..$GATE_ORIGIN_REF; cannot tell whether HEAD is behind"
            s1="FAIL (rev-list failed for $GATE_ORIGIN_REF)"; rc=1
        elif [ "$behind" -gt 0 ]; then
            echo "gate: behind $GATE_ORIGIN_REF by $behind commit(s); rebase onto $GATE_ORIGIN_REF and rerun (the gate never rebases for you)"
            s1="FAIL (behind $GATE_ORIGIN_REF by $behind)"; rc=1
        else
            s1="PASS"
        fi
    fi

    echo "=== gate step 2: global guard rows, one at a time ==="
    gate_rows="$(emit_guard_rows)"; rows_rc=$?
    if [ "$rows_rc" -ne 0 ]; then
        echo "gate: row emitter failed: $gate_rows"
        rows_fail=1; failed_rows="row emitter (failed)"
    else
        while IFS=$'\t' read -r gr gk gt; do
            [ "$gr" = "R8" ] || continue
            echo "--- guard row: $gk $gt ---"
            gate_run_row "$gk" "$gt" </dev/null; urc=$?
            if [ "$urc" -eq 0 ]; then
                rows_pass=$((rows_pass + 1))
            elif gate_timed_out "$urc"; then
                echo "RED GUARD ROW: $gk $gt (TIMED OUT after ${GATE_ROW_SECS}s)"
                rows_fail=$((rows_fail + 1)); failed_rows="${failed_rows} ${gt}(timed out)"
            else
                echo "RED GUARD ROW: $gk $gt"
                rows_fail=$((rows_fail + 1)); failed_rows="${failed_rows} ${gt}"
            fi
        done <<<"$gate_rows"
        if [ $((rows_pass + rows_fail)) -eq 0 ]; then
            echo "gate: the row emitter yielded zero guard rows; failing closed"
            rows_fail=1; failed_rows="no rows (zero rows ran)"
        fi
    fi
    s2="$rows_pass passed, $rows_fail failed"
    [ "$rows_fail" -eq 0 ] || rc=1

    echo "=== gate step 3: named suites ==="
    for suite in ${GATE_SUITES[@]+"${GATE_SUITES[@]}"}; do
        echo "--- suite: $suite ---"
        gate_run_suite "$suite" </dev/null; urc=$?
        if [ "$urc" -eq 0 ]; then
            suites_pass=$((suites_pass + 1))
        elif gate_timed_out "$urc"; then
            echo "RED SUITE: $suite (TIMED OUT after ${GATE_SUITE_SECS}s)"
            suites_fail=$((suites_fail + 1)); failed_suites="${failed_suites} ${suite}(timed out)"
        else
            echo "RED SUITE: $suite"
            suites_fail=$((suites_fail + 1)); failed_suites="${failed_suites} ${suite}"
        fi
    done
    s3="$suites_pass passed, $suites_fail failed"
    [ "$suites_fail" -eq 0 ] || rc=1

    echo "=== gate step 4: full engine10 ==="
    if [ "$GATE_NO_LOKI_TS" -eq 1 ]; then
        echo "gate: SKIPPED engine10 because --no-loki-ts says this slice touched no loki-ts source"
        s4="SKIPPED (--no-loki-ts: slice touched no loki-ts source)"
    elif ! command -v bun >/dev/null 2>&1; then
        echo "gate: bun is not on PATH; engine10 cannot run"
        s4="FAIL (bun not found)"; rc=1
    else
        gate_run_engine10; urc=$?
        if [ "$urc" -eq 0 ]; then
            s4="PASS"
        elif gate_timed_out "$urc"; then
            s4="FAIL (TIMED OUT after ${GATE_ENGINE10_SECS}s)"; rc=1
        else
            s4="FAIL"; rc=1
        fi
    fi

    echo ""
    echo "=== gate summary ==="
    echo "1 rebase check : $s1"
    echo "2 guard rows   : $s2${failed_rows:+ (red:$failed_rows)}"
    echo "3 named suites : $s3${failed_suites:+ (red:$failed_suites)}"
    echo "4 engine10     : $s4"
    if [ "$rc" -eq 0 ]; then echo "gate: PASS"; else echo "gate: FAIL"; fi
    return "$rc"
}

if [ "$GATE" -eq 1 ]; then
    run_gate
    exit $?
fi

CHANGED_FILE_LIST=""
UNPARSEABLE=0
CHANGED=()

if [ "$MODE" = "git" ]; then
    BASE_REF="${BASE_REF:-HEAD^}"
    HEAD_REF="${HEAD_REF:-HEAD}"
    if ! git rev-parse --verify -q "$BASE_REF" >/dev/null || ! git rev-parse --verify -q "$HEAD_REF" >/dev/null; then
        UNPARSEABLE=1
    elif ! CHANGED_FILE_LIST="$(git diff --name-only "${BASE_REF}...${HEAD_REF}" -- . 2>/dev/null)"; then
        UNPARSEABLE=1
    fi
else
    if [ "$FILES_FROM" = "-" ]; then
        CHANGED_FILE_LIST="$(cat)"
    elif [ -n "$FILES_FROM" ] && [ -f "$FILES_FROM" ]; then
        CHANGED_FILE_LIST="$(cat "$FILES_FROM")"
    else
        UNPARSEABLE=1
    fi
fi

# ---- --run: execute everything selected ---------------------------
# Every selection path, including the early R0 / docs-only / empty exits,
# ends in finish() so --run can never return having silently run nothing.
run_selection() {
    FAILED=0
    INNER_ARGS=()
    [ "$GUARDS_ONLY" -eq 1 ] && INNER_ARGS=(--guards-only)
    EXECUTED=0
    TB=""
    if command -v timeout >/dev/null 2>&1; then TB="timeout"; elif command -v gtimeout >/dev/null 2>&1; then TB="gtimeout"; fi
    run_one() {
        local desc="$1"; shift
        echo "--- $desc ---"
        EXECUTED=$((EXECUTED + 1))
        if [ -n "$TB" ]; then
            "$TB" 100 "$@"
        else
            "$@"
        fi
        local rc=$?
        if [ "$rc" -ne 0 ]; then
            echo "FAIL ($rc): $desc"
            FAILED=1
        fi
        return 0
    }

    if [ "$UNPARSEABLE" -eq 1 ] && [ "$GUARDS_ONLY" -eq 0 ]; then
        SELECTION="$(printf 'R0\tALL\tunparseable diff -- running everything\n')"
    elif [ "$MODE" = "git" ]; then
        SELECTION="$("$0" --base "$BASE_REF" --head "$HEAD_REF" "${INNER_ARGS[@]}")"
    else
        SELECTION="$(printf '%s\n' "$CHANGED_FILE_LIST" | "$0" --files - "${INNER_ARGS[@]}")"
    fi

    while IFS=$'\t' read -r rule kind target; do
        [ -n "$rule" ] || continue
        case "$rule:$kind" in
            R0:ALL)
                # R0 means "run everything" -- that IS the full suite, so run it,
                # untimed by us (run-all-tests.sh manages its own per-suite
                # timeouts). This is the one path exempt from the 2-minute
                # Tier A target; the workflow gives it its own budget.
                echo "R0: $target -- running the full suite (tests/run-all-tests.sh)"
                EXECUTED=$((EXECUTED + 1))
                bash tests/run-all-tests.sh || FAILED=1
                ;;
            *:bash_n) run_one "bash -n $target" bash -n "$target" ;;
            *:shellcheck)
                if command -v shellcheck >/dev/null 2>&1; then
                    # Mirror tests/run-shellcheck.sh's severity floor and excludes
                    # exactly (-S warning, SC1090/SC1091 global, +SC2034 for
                    # providers/ and tests/) -- a bare `shellcheck file` uses the
                    # default style severity and flags pre-existing nits this
                    # repo has already accepted, which is not what a per-diff
                    # fast gate should fail a PR over.
                    sc_excludes="SC1090,SC1091"
                    case "$target" in
                        providers/*.sh | tests/*.sh) sc_excludes="${sc_excludes},SC2034" ;;
                    esac
                    run_one "shellcheck $target" shellcheck -S warning -e "$sc_excludes" "$target"
                fi
                ;;
            *:py_syntax)
                run_one "py syntax $target" python3 -c "import ast; ast.parse(open('$target').read())"
                ;;
            *:shell_test | *:moat) run_one "$target" bash "$target" ;;
            *:py_test) run_one "$target" python3 -m pytest -q "$target" ;;
            *:bun_test)
                # bun test resolves its path filter relative to --cwd, which we
                # set to loki-ts/ below; strip that prefix off the target first.
                run_one "bun test $target" bash -c "cd loki-ts && bun test '${target#loki-ts/}'"
                ;;
            *:bun_typecheck) run_one "bun typecheck" bash -c "cd loki-ts && bun run typecheck" ;;
            *:pytest) run_one "pytest $target" python3 -m pytest -q "$target" ;;
            *:node_lint) run_one "npm run lint ($target)" bash -c "cd '$target' && npm run lint" ;;
            *:node_test) run_one "node --test $target" node --test "$target" ;;
        esac
    done <<<"$SELECTION"

    echo "suites executed: $EXECUTED"
    if [ "$EXECUTED" -eq 0 ]; then
        if [ "$GUARDS_ONLY" -eq 0 ] && [ "${#CHANGED[@]}" -eq 0 ] && [ "$UNPARSEABLE" -eq 0 ]; then
            echo "select-tests: empty diff, nothing selected (documented empty selection)"
            return 0
        fi
        echo "select-tests: NOTHING RUN -- --run executed zero suites" >&2
        return 1
    fi
    return "$FAILED"
}

finish() {
    if [ "$DO_RUN" -eq 0 ]; then
        exit 0
    fi
    run_selection
    exit $?
}

if [ "$GUARDS_ONLY" -eq 1 ]; then
    emit_guard_rows
    finish
fi

if [ "$UNPARSEABLE" -eq 1 ]; then
    emit R0 ALL "unparseable diff -- running everything"
    finish
fi

# Strip blank lines; nothing changed at all is not "unknown", just nothing to do.
CHANGED=()
while IFS= read -r _f; do
    [ -n "$_f" ] && CHANGED+=("$_f")
done <<<"$CHANGED_FILE_LIST"

if [ "${#CHANGED[@]}" -eq 0 ]; then
    finish
fi

# ---- R0: broad-blast-radius files -> run everything ------------------------
for f in "${CHANGED[@]}"; do
    case "$f" in
        tests/lib/* | tests/run-all-tests.sh | package.json | */package.json \
            | requirements*.txt | requirements*.in | */requirements*.txt | */requirements*.in \
            | loki-ts/dist/* | VERSION | .github/workflows/*)
            emit R0 ALL "matched broad-blast-radius path: $f"
            finish
            ;;
    esac
done

# ---- R0 (unknown path): a changed file of a shape this selector has no rule
# for at all -- neither a recognized top-level area nor a recognized source
# extension. This is deliberately narrower than "R3 found zero matching
# tests": a real source file with no test referencing it yet is a coverage
# gap, not an unknown diff, and treating every untested new file as "run
# everything" would defeat the whole point of a narrow selector. "Unknown"
# here means the selector genuinely does not know what kind of thing changed.
is_recognized_shape() {
    case "$1" in
        tests/* | loki-ts/* | dashboard/* | web-app/* | skills/* | autonomy/* \
            | providers/* | memory/* | mcp/* | events/* | docs/* | scripts/* \
            | references/* | templates/* | benchmarks/* | wiki/* | plugins/* \
            | vscode-extension/* | SKILL.md | CLAUDE.md | README.md | CHANGELOG.md)
            return 0
            ;;
    esac
    case "$1" in
        *.sh | *.py | *.md | *.ts | *.tsx | *.js | *.mjs | *.json | *.yml | *.yaml)
            return 0
            ;;
    esac
    return 1
}
for f in "${CHANGED[@]}"; do
    if ! is_recognized_shape "$f"; then
        emit R0 ALL "unknown path shape: $f"
        finish
    fi
done

# ---- R7: docs-only diff -> R1 only (R1 is emitted below regardless) --------
DOCS_ONLY=1
for f in "${CHANGED[@]}"; do
    case "$f" in
        *.md)
            case "$f" in
                skills/* | SKILL.md) DOCS_ONLY=0 ;;
            esac
            ;;
        *) DOCS_ONLY=0 ;;
    esac
done

# ---- R1: always -- static checks on every changed shell/python file -------
for f in "${CHANGED[@]}"; do
    [ -f "$f" ] || continue
    case "$f" in
        *.sh)
            emit R1 bash_n "$f"
            emit R1 shellcheck "$f"
            ;;
        *.py) emit R1 py_syntax "$f" ;;
    esac
done

emit_guard_rows

if [ "$DOCS_ONLY" -eq 1 ]; then
    finish
fi

TEST_FILES_CACHE=""
all_test_files() {
    if [ -z "$TEST_FILES_CACHE" ]; then
        TEST_FILES_CACHE="$(find tests -type f \( -name '*.sh' -o -name '*.py' \) 2>/dev/null)"
    fi
    printf '%s\n' "$TEST_FILES_CACHE"
}

# Extra needles for a changed .py source file: python tests here import the
# bare module name (sys.path-appended, e.g. "from workspace_diff import x" or
# "import fast_verify"), never the file path or the ".py" suffix, and
# sometimes the dotted package form ("import pkg.mod" / "from pkg.mod import
# x" / "from pkg import mod"). The stem alone already covers all of the
# observed forms including "from pkg import mod"; the dotted form is added
# for the "pkg.mod" spelling. Matched with a word boundary (grep -w), not a
# bare substring: an unqualified module name like "state" or "auth" is a
# common English/code word and would false-positive almost everywhere as a
# plain substring search.
py_module_needles() {
    local f="$1"
    local rel="$f" stem dotted
    rel="${rel%.py}"
    stem="${rel##*/}"
    dotted="${rel//\//.}"
    # __init__/__main__ etc: a dunder stem is not a name anyone imports by --
    # "from pkg import x" never spells the package's own __init__ -- and as a
    # grep needle it is pathologically unspecific (every class in the
    # language defines one), fanning out to match nearly the whole test tree
    # and turning a sub-second selection into a multi-minute one. Verified
    # directly: dashboard/__init__.py alone made the full run exceed a 150s
    # timeout before this exclusion.
    case "$stem" in
        __*__) return 0 ;;
    esac
    printf '%s\n' "$stem"
    [ "$dotted" != "$stem" ] && printf '%s\n' "$dotted"
}

# FC-31 route needle: an API route handler is exercised by suites that hit its
# URL (curl, fetch), never by naming the handler file. Extract the route paths
# a Python handler declares (@app.get("/x"), @router.post("/y") plus the
# APIRouter prefix) and use each static path (cut at the first "{param}") as a
# fixed-string needle. No per-route table: the handler file is the source of
# truth. Output is captured into variables, never piped into an early-exit
# consumer, so there is no SIGPIPE exposure under pipefail.
route_needles() {
    local f="$1" decos prefix p full out=""
    [ -f "$f" ] || return 0
    decos="$(grep -oE "@[A-Za-z_][A-Za-z0-9_]*\.(get|post|put|delete|patch|websocket|api_route)\( *f?[\"'][^\"']*[\"']" "$f" 2>/dev/null)" || decos=""
    [ -n "$decos" ] || return 0
    prefix="$(grep -oE "prefix *= *[\"'][^\"']*[\"']" "$f" 2>/dev/null)" || prefix=""
    prefix="${prefix%%$'\n'*}"
    prefix="$(printf '%s\n' "$prefix" | sed -e "s/^[^\"']*[\"']//" -e "s/[\"']\$//")"
    while IFS= read -r p; do
        p="$(printf '%s\n' "$p" | sed -e "s/^[^\"']*[\"']//" -e "s/[\"']\$//")"
        full="${prefix}${p}"
        full="${full%%\{*}"
        full="${full%/}"
        case "$full" in
            /api/?*) out="${out}${full}"$'\n' ;;
        esac
    done <<<"$decos"
    [ -n "$out" ] && printf '%s' "$out" | sort -u
    return 0
}

grep_word_and_emit() {
    local rule="$1" kind="$2" needle="$3" candidates="$4"
    [ -n "$needle" ] || return 0
    local match emit_kind
    # Boundary excludes letters/digits only, NOT underscore: this repo's own
    # naming convention wraps a referenced module/function in a snake_case
    # prefix or suffix (moat's "case_fast_verify" for fast_verify.py, "test_"
    # for a bare module). A strict \b (underscore counts as a word char)
    # would reject exactly that, real-commit-verified against
    # tests/moat/p2-honest-verdict.sh's "case_fast_verify". This still blocks
    # a generic stem like "state" from matching inside "statement" (still
    # alnum-adjacent) while matching it inside "auth_state" or "state_test".
    while IFS= read -r match; do
        [ -n "$match" ] || continue
        emit_kind="$(match_kind "$kind" "$match")"
        [ -n "$emit_kind" ] || continue
        already_seen "$emit_kind:$match" && continue
        mark_seen "$emit_kind:$match"
        emit "$rule" "$emit_kind" "$match"
    done < <(printf '%s\n' "$candidates" | tr '\n' '\0' | xargs -0 grep -lE -- "(^|[^A-Za-z0-9])${needle}($|[^A-Za-z0-9])" 2>/dev/null)
}

# Function names touched by a diff's changed hunks, for autonomy/run.sh and
# autonomy/loki. NOT implemented via git's hunk-header context line: git has
# no shell funcname pattern configured for this repo (no .gitattributes
# entry), so that context line is just "nearest preceding non-blank line",
# almost never an actual "name() {" -- verified directly against a real
# commit, where it produced zero function names and silently fell back to the
# path/basename flood this special case exists to avoid. Instead: find every
# "name() {" definition in the post-change file, and map each changed line
# number (from -U0 hunks, new-file side) to the nearest preceding definition.
changed_functions() {
    local file="$1" base="$2" head="$3"
    python3 - "$file" "$base" "$head" 2>/dev/null <<'PYEOF'
import bisect, re, subprocess, sys

file, base, head = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    content = subprocess.run(["git", "show", f"{head}:{file}"],
                              capture_output=True, text=True, check=True).stdout
except Exception:
    sys.exit(0)

starts = []
pat = re.compile(r'^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{?\s*$')
for i, ln in enumerate(content.split("\n"), start=1):
    m = pat.match(ln)
    if m:
        starts.append((i, m.group(1)))
starts.sort()
start_lines = [s[0] for s in starts]

diff = subprocess.run(["git", "diff", "-U0", f"{base}...{head}", "--", file],
                       capture_output=True, text=True).stdout
changed = set()
hunk_re = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')
for line in diff.split("\n"):
    m = hunk_re.match(line)
    if not m:
        continue
    c = int(m.group(1))
    d = int(m.group(2)) if m.group(2) is not None else 1
    if d == 0:
        changed.add(max(c - 1, 1))
    else:
        changed.update(range(c, c + d))

names = set()
for ln in changed:
    idx = bisect.bisect_right(start_lines, ln) - 1
    if idx >= 0:
        names.add(starts[idx][1])

for n in sorted(names):
    print(n)
PYEOF
}

SEEN=""
already_seen() {
    case "$SEEN" in *"|$1|"*) return 0 ;; esac
    return 1
}
mark_seen() { SEEN="${SEEN}|$1|"; }

# A "shell_test" kind (the default the callers below pass) is corrected
# per-match to how the matched file is actually run: py_test for a .py match
# (tests/**/*.py mixes both), node_test for a .js/.mjs match -- never invoked with `bash`.
match_kind() {
    local kind="$1" match="$2" basename
    basename="$(basename "$match")"
    # A shell_test candidate that is not a runnable test (a helper under
    # tests/lib, a fixture) yields no kind: callers skip it, never run it.
    [ "$kind" = "shell_test" ] || { printf '%s\n' "$kind"; return; }
    case "$basename" in
        test_*.py | *_test.py) kind="py_test" ;;
        # the aggregate runner is not a suite; run bare it executes everything (rc=124 in the fast gate).
        run-all-tests.sh) kind="" ;;
        test-*.sh | run-*.sh | run_*.sh) ;;
        *.js | *.mjs) kind="node_test" ;;
        *) kind="" ;;
    esac
    printf '%s\n' "$kind"
}

# grep a set of candidate files for a literal needle (path or basename or
# function name), emitting each match once under the given rule/kind.
grep_and_emit() {
    local rule="$1" kind="$2" needle="$3" candidates="$4"
    [ -n "$needle" ] || return 0
    local match emit_kind
    while IFS= read -r match; do
        [ -n "$match" ] || continue
        emit_kind="$(match_kind "$kind" "$match")"
        [ -n "$emit_kind" ] || continue
        already_seen "$emit_kind:$match" && continue
        mark_seen "$emit_kind:$match"
        emit "$rule" "$emit_kind" "$match"
    done < <(printf '%s\n' "$candidates" | tr '\n' '\0' | xargs -0 grep -lF -- "$needle" 2>/dev/null)
}

# FC-32 / RC-SLICE-SHELL-GATE: the loki-ts/src files the control plane bundles (import closure of
# packages/control-plane/src, any import form, conservative). CP-04 builds exactly that closure, so a change
# to any of these must select tests/test-control-plane.sh. Computed once; python3 missing => treat every
# loki-ts/src file as reached (fail safe, never a miss).
CP_CLOSURE_CACHE=""
CP_CLOSURE_DONE=0
cp_closure_load() {
    if [ "$CP_CLOSURE_DONE" -eq 0 ]; then
        CP_CLOSURE_DONE=1
        if command -v python3 >/dev/null 2>&1 && [ -d packages/control-plane/src ]; then
            CP_CLOSURE_CACHE="$(python3 "$SCRIPT_DIR/cp-closure.py" 2>/dev/null)" || CP_CLOSURE_CACHE=""
            # An empty closure is never legitimate: python3 failing or printing nothing fails safe to ALL.
            [ -n "$CP_CLOSURE_CACHE" ] || CP_CLOSURE_CACHE="ALL"
        else
            CP_CLOSURE_CACHE="ALL"
        fi
    fi
}

BUN_TYPECHECK_EMITTED=0

for f in "${CHANGED[@]}"; do
    base="${f##*/}"

    # R2: a changed test file runs itself.
    case "$f" in
        tests/*)
            case "$base" in
                test-*.sh | test_*.py | run_*.sh | run-*.sh)
                    if [ -f "$f" ]; then
                        # Same dedup key space as grep_and_emit ("shell_test:"
                        # / "py_test:") -- R3 also scans tests/**, so without
                        # this a self-referencing test would be both R2- and
                        # R3-selected and run twice.
                        case "$f" in
                            *.py)
                                already_seen "py_test:$f" || { mark_seen "py_test:$f"; emit R2 py_test "$f"; }
                                ;;
                            *)
                                already_seen "shell_test:$f" || { mark_seen "shell_test:$f"; emit R2 shell_test "$f"; }
                                ;;
                        esac
                    fi
                    # Meta guards over tests/ itself (home-directory paths, D44-C structural checks):
                    # any changed shell test must run them, not just itself.
                    case "$f" in
                        *.sh)
                            for meta in tests/test-no-hardcoded-paths.sh tests/test-structural-checks.sh; do
                                if [ -f "$meta" ]; then
                                    already_seen "shell_test:$meta" || { mark_seen "shell_test:$meta"; emit R3 shell_test "$meta"; }
                                fi
                            done
                            ;;
                    esac
                    continue
                    ;;
            esac
            ;;
    esac

    # R6: a changed moat property script runs only that property.
    case "$f" in
        tests/moat/p*.sh)
            already_seen "moat:$f" && continue
            mark_seen "moat:$f"
            emit R6 moat "$f"
            continue
            ;;
    esac

    # The repo-root TS state manager is covered by a bun test under loki-ts/tests (#312).
    case "$f" in
        state/manager.ts | loki-ts/tests/state_manager.test.ts)
            already_seen "bun_test:loki-ts/tests/state_manager.test.ts" || { mark_seen "bun_test:loki-ts/tests/state_manager.test.ts"; emit R4 bun_test "loki-ts/tests/state_manager.test.ts"; }
            ;;
    esac

    # R4: changed loki-ts/src -> matching bun tests + typecheck. Match on the
    # src-relative path minus extension ("runner/council"), not the bare
    # basename ("council") -- the bare word appears as ordinary English in
    # nearly every test file's comments and false-positives almost the whole
    # suite.
    case "$f" in
        loki-ts/src/*)
            rel="${f#loki-ts/src/}"
            stem="${rel%.*}"
            grep_and_emit R4 bun_test "$stem" "$(find loki-ts/test loki-ts/tests -type f -name '*.test.ts' 2>/dev/null)"
            if [ "$BUN_TYPECHECK_EMITTED" -eq 0 ]; then
                emit R4 bun_typecheck "loki-ts"
                BUN_TYPECHECK_EMITTED=1
            fi
            # shell suites guard loki-ts/src files too. Select any shell
            # suite that names the file's full path, or (for a command module,
            # loki-ts/src/commands/X.ts) that runs it as "loki X". A bun-only
            # selection let a doctor.ts slice skip tests/test-doctor-blocker-
            # parity.sh and go red in Tier B.
            grep_and_emit R3 shell_test "$f" "$(all_test_files)"
            # CP-04 builds the control-plane server from what its Dockerfile copies.
            cp_closure_load
            if { grep -qxF -- "$f" <<<"$CP_CLOSURE_CACHE" || [ "$CP_CLOSURE_CACHE" = "ALL" ]; } && [ -f tests/test-control-plane.sh ]; then
                already_seen "shell_test:tests/test-control-plane.sh" || { mark_seen "shell_test:tests/test-control-plane.sh"; emit R3 shell_test "tests/test-control-plane.sh"; }
            fi
            case "$rel" in
                commands/*.ts)
                    cmd="${stem##*/}"
                    case "$cmd" in
                        *[!A-Za-z0-9_-]* | "") ;;
                        *) grep_word_and_emit R3 shell_test "loki\"? +${cmd}" "$(all_test_files)" ;;
                    esac
                    ;;
            esac
            continue
            ;;
    esac

    # R5: changed dashboard/ or web-app/ -> their python + node tests.
    case "$f" in
        dashboard/*)
            if ! already_seen "r5area:dashboard"; then
                mark_seen "r5area:dashboard"
                # dashboard/*.py source files are not themselves pytest-
                # discoverable; the actual suite lives under tests/dashboard.
                emit R5 pytest "tests/dashboard"
            fi
            ;;
        web-app/*)
            if ! already_seen "r5area:web-app"; then
                mark_seen "r5area:web-app"
                emit R5 pytest "web-app/tests"
                # ponytail: web-app/package.json has no "test" script (only
                # lint/build); lint is the closest node-side check today.
                # Add a real test script and select it here when one exists.
                emit R5 node_lint "web-app"
            fi
            ;;
    esac

    # R3: changed source file -> every test that references it. run.sh and
    # loki are referenced by nearly every suite by path, so a plain grep
    # would select almost the whole tree; use the function names touched in
    # the diff's hunks instead.
    case "$f" in
        autonomy/run.sh | autonomy/loki)
            funcs=""
            if [ "$MODE" = "git" ] && command -v python3 >/dev/null 2>&1; then
                funcs="$(changed_functions "$f" "$BASE_REF" "$HEAD_REF")"
            fi
            if [ -n "$funcs" ]; then
                while IFS= read -r fn; do
                    grep_and_emit R3 shell_test "$fn" "$(all_test_files)"
                    grep_and_emit R6 moat "$fn" "$(find tests/moat -maxdepth 1 -name 'p*.sh')"
                done <<<"$funcs"
            else
                # No hunk hint available (e.g. --files-from mode): fall back
                # to the same path/basename grep every other file gets. A
                # superset of the ideal selection, never a miss.
                grep_and_emit R3 shell_test "$f" "$(all_test_files)"
                grep_and_emit R3 shell_test "$base" "$(all_test_files)"
                grep_and_emit R6 moat "$base" "$(find tests/moat -maxdepth 1 -name 'p*.sh')"
            fi
            ;;
        *)
            grep_and_emit R3 shell_test "$f" "$(all_test_files)"
            grep_and_emit R3 shell_test "$base" "$(all_test_files)"
            # R6 (second half): changed code a moat property covers.
            grep_and_emit R6 moat "$f" "$(find tests/moat -maxdepth 1 -name 'p*.sh')"
            grep_and_emit R6 moat "$base" "$(find tests/moat -maxdepth 1 -name 'p*.sh')"
            # A .py source's tests/scripts reference it by bare module name or
            # dotted import, never the path or the ".py" suffix -- see
            # py_module_needles.
            case "$f" in
                dashboard/*.py | web-app/*.py)
                    while IFS= read -r needle; do
                        grep_and_emit R3 shell_test "$needle" "$(all_test_files)"
                    done < <(route_needles "$f")
                    ;;
            esac
            case "$f" in
                *.py)
                    while IFS= read -r needle; do
                        grep_word_and_emit R3 shell_test "$needle" "$(all_test_files)"
                        grep_word_and_emit R6 moat "$needle" "$(find tests/moat -maxdepth 1 -name 'p*.sh')"
                    done < <(py_module_needles "$f")
                    ;;
            esac
            ;;
    esac
done

finish
