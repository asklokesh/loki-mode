#!/usr/bin/env bash
# scripts/select-tests.sh -- Tier A fast-gate test selector (S-91).
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
# R0-R7 selection rules are implemented below, in order.
set -uo pipefail  # not -e: grep/diff "no match" is an expected rc 1 throughout

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

BASE_REF=""
HEAD_REF=""
FILES_FROM=""
MODE="git"
DO_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --base) BASE_REF="${2:-}"; shift 2 ;;
        --head) HEAD_REF="${2:-}"; shift 2 ;;
        --files-from) MODE="files"; FILES_FROM="${2:-}"; shift 2 ;;
        --files) MODE="files"; FILES_FROM="${2:--}"; shift 2 ;;
        --run) DO_RUN=1; shift ;;
        -h | --help)
            sed -n '2,31p' "$0"
            exit 0
            ;;
        *)
            echo "select-tests: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

CHANGED_FILE_LIST=""
UNPARSEABLE=0

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

emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

if [ "$UNPARSEABLE" -eq 1 ]; then
    emit R0 ALL "unparseable diff -- running everything"
    exit 0
fi

# Strip blank lines; nothing changed at all is not "unknown", just nothing to do.
CHANGED=()
while IFS= read -r _f; do
    [ -n "$_f" ] && CHANGED+=("$_f")
done <<<"$CHANGED_FILE_LIST"

if [ "${#CHANGED[@]}" -eq 0 ]; then
    exit 0
fi

# ---- R0: broad-blast-radius files -> run everything ------------------------
for f in "${CHANGED[@]}"; do
    case "$f" in
        tests/lib/* | tests/run-all-tests.sh | package.json | */package.json \
            | requirements*.txt | requirements*.in | */requirements*.txt | */requirements*.in \
            | loki-ts/dist/* | VERSION | .github/workflows/*)
            emit R0 ALL "matched broad-blast-radius path: $f"
            exit 0
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
        tests/* | loki-ts/* | dashboard/* | dashboard-ui/* | web-app/* | skills/* | autonomy/* \
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
        exit 0
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

if [ "$DOCS_ONLY" -eq 1 ]; then
    exit 0
fi

TEST_FILES_CACHE=""
all_test_files() {
    if [ -z "$TEST_FILES_CACHE" ]; then
        TEST_FILES_CACHE="$(find tests -type f \( -name '*.sh' -o -name '*.py' \) 2>/dev/null
            find dashboard-ui/tests -type f \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null)"
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
        already_seen "$emit_kind:$match" && continue
        mark_seen "$emit_kind:$match"
        emit "$rule" "$emit_kind" "$match"
    done < <(printf '%s\n' "$candidates" | xargs -I{} grep -lE -- "(^|[^A-Za-z0-9])${needle}($|[^A-Za-z0-9])" {} 2>/dev/null)
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
# (tests/**/*.py mixes both), node_test for a .js/.mjs match (dashboard-ui's
# collector mixes those in too) -- never invoked with `bash`.
match_kind() {
    local kind="$1" match="$2" basename
    basename="$(basename "$match")"
    case "$match" in
        *.py)
            case "$basename" in
                test_*.py | *_test.py) [ "$kind" = "shell_test" ] && kind="py_test" ;;
            esac
            ;;
        *.js | *.mjs) [ "$kind" = "shell_test" ] && kind="node_test" ;;
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
        already_seen "$emit_kind:$match" && continue
        mark_seen "$emit_kind:$match"
        emit "$rule" "$emit_kind" "$match"
    done < <(printf '%s\n' "$candidates" | xargs -I{} grep -lF -- "$needle" {} 2>/dev/null)
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
        dashboard-ui/*)
            # Mirror run-all-tests.sh exactly: it registers only 4 of the ~20
            # files under dashboard-ui/tests/ as real `node --test` suites
            # (the rest are Playwright e2e specs or unregistered/orphaned --
            # a pre-existing gap outside this slice). Extract the registered
            # set from run-all-tests.sh itself so this stays in sync rather
            # than hardcoding a list that drifts.
            if ! already_seen "r5area:dashboard-ui" && command -v node >/dev/null 2>&1; then
                mark_seen "r5area:dashboard-ui"
                while IFS= read -r uitest; do
                    [ -n "$uitest" ] || continue
                    emit R5 node_test "$uitest"
                done < <(grep -oE 'dashboard-ui/tests/[A-Za-z0-9_.-]+\.(js|mjs)' tests/run-all-tests.sh | sort -u)
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

if [ "$DO_RUN" -eq 0 ]; then
    exit 0
fi

# ---- --run: execute everything selected above ------------------------------
FAILED=0
TB=""
if command -v timeout >/dev/null 2>&1; then TB="timeout"; elif command -v gtimeout >/dev/null 2>&1; then TB="gtimeout"; fi
run_one() {
    local desc="$1"; shift
    echo "--- $desc ---"
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

if [ "$MODE" = "git" ]; then
    SELECTION="$("$0" --base "$BASE_REF" --head "$HEAD_REF")"
else
    SELECTION="$(printf '%s\n' "$CHANGED_FILE_LIST" | "$0" --files -)"
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

exit "$FAILED"
