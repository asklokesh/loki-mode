#!/usr/bin/env bash
# Asserts the pre-push hook's pytest step stays SCOPED without failing open.
#
# The hook narrows a 149s / 1801-test full suite down to the tests a push
# actually changes. The risk that buys is a fail-open: a scoping bug that
# quietly runs nothing looks exactly like a fast, passing gate.
#
# Every case below runs the real hook in a scratch clone and asserts on what
# pytest ACTUALLY DID -- not on whether the hook's source still contains a
# particular echo string. A source-grep test passes when someone breaks the
# logic while keeping the message, and fails when someone fixes it with
# different wording; it gates nothing.
#
#   1. docs-only push          -> pytest does not run
#   2. only test modules       -> runs exactly those files, not the full suite
#   3. non-test SOURCE changed -> escalates to the full suite
#   4. shell-only push         -> still runs the full suite (the fail-open that
#                                 the first draft of this hook shipped: five
#                                 Python tests assert on shell/JSON source, so
#                                 skipping on "no .py changed" fails open on
#                                 exactly the case the hook exists to catch)
#   5. conftest.py changed     -> escalates (never `pytest conftest.py`, which
#                                 collects nothing and exits 5)
#   6. a failing test          -> still exits nonzero

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/.githooks/pre-push"

passed=0
failed=0

ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: pre-push scoped pytest"

[[ -f "$HOOK" ]] || { echo "  FAIL: hook not found at $HOOK"; exit 1; }
if bash -n "$HOOK" 2>/dev/null; then ok "hook parses"; else ko "hook parses"; fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-prepush-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Build a scratch repo whose "pytest" is a stub recording how it was invoked.
# Using a stub rather than real pytest keeps the test fast and, more
# importantly, lets us assert on the ARGUMENTS -- which is the actual contract.
setup_clone() {
    local dir="$1"
    rm -rf "$dir"; mkdir -p "$dir/tests" "$dir/autonomy" "$dir/docs" "$dir/bin"
    cd "$dir" || return 1

    git init -q .
    git -C "$dir" config user.name asklokesh
    git -C "$dir" config user.email lokeshmure@live.com
    git -C "$dir" config commit.gpgsign false

    cp "$HOOK" .githooks_pre_push 2>/dev/null || true
    mkdir -p .githooks && cp "$HOOK" .githooks/pre-push
    touch pytest.ini
    echo 'true' > autonomy/run.sh
    echo 'true' > autonomy/loki
    printf 'def test_baseline():\n    assert True\n' > tests/test_alpha.py
    printf 'def test_beta():\n    assert True\n' > tests/test_beta.py
    printf '# collection hook\n' > tests/conftest.py
    echo '# doc' > docs/guide.md

    # Stub python3: records argv, then behaves like a passing pytest.
    cat > bin/python3 <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-m" && "${2:-}" == "pytest" ]]; then
    shift 2
    printf '%s\n' "$*" > "$PYTEST_ARGV_FILE"
    exit "${STUB_PYTEST_RC:-0}"
fi
exec /usr/bin/env python3 "$@"
STUB
    chmod +x bin/python3
    # The hook prefers python3.12 when present (v8.63.0: CI runs 3.12 and a
    # local 3.14 cannot observe the PEP 649 annotation bug). The stub must
    # therefore stand in for whichever interpreter the hook actually selects,
    # or it records no argv and every scoping assertion below reads as a
    # failure while the hook is working correctly.
    cp bin/python3 bin/python3.12
    chmod +x bin/python3.12

    git -C "$dir" add -A >/dev/null 2>&1
    git -C "$dir" commit -q -m base --no-verify >/dev/null 2>&1
    git -C "$dir" branch -f main HEAD >/dev/null 2>&1
    git -C "$dir" remote add origin . >/dev/null 2>&1
    git -C "$dir" update-ref refs/remotes/origin/main HEAD
}

# Runs the hook after committing whatever the caller staged. Echoes "RC=<n>".
run_hook() {
    local dir="$1"
    cd "$dir" || return 1
    export PYTEST_ARGV_FILE="$dir/pytest_argv.txt"
    rm -f "$PYTEST_ARGV_FILE"
    PATH="$dir/bin:$PATH" PRE_PUSH_NO_CI_CHECK=1 \
        bash .githooks/pre-push origin https://github.com/asklokesh/loki-mode \
        >"$dir/hook.out" 2>&1
    echo "RC=$?"
}

argv_of() { cat "$1/pytest_argv.txt" 2>/dev/null || echo "__PYTEST_NEVER_RAN__"; }

# Every git in this test must act on a scratch clone. A bare `git commit` run
# from the wrong cwd commits into the REAL repository -- that happened once
# during development and rewrote this branch's history. This wrapper makes it
# structurally impossible rather than a matter of remembering to cd.
g() {
    local d="$1"; shift
    case "$d" in
        "$SCRATCH"/*) : ;;
        *) echo "  FATAL: refusing git outside scratch: $d" >&2; exit 1 ;;
    esac
    git -C "$d" "$@"
}

# --- case 1: docs-only push must not run pytest ------------------------------
D="$SCRATCH/c1"; setup_clone "$D"
echo '# more docs' >> docs/guide.md
g "$D" add docs/guide.md >/dev/null 2>&1
g "$D" commit -q -m docs --no-verify >/dev/null 2>&1
rc="$(run_hook "$D")"
if [[ "$(argv_of "$D")" == "__PYTEST_NEVER_RAN__" ]]; then
    ok "docs-only push skips pytest"
else
    ko "docs-only push skips pytest" "pytest ran with: $(argv_of "$D")"
fi

# --- case 2: only test modules -> scoped to exactly those --------------------
D="$SCRATCH/c2"; setup_clone "$D"
printf 'def test_added():\n    assert True\n' >> tests/test_alpha.py
g "$D" add tests/test_alpha.py >/dev/null 2>&1
g "$D" commit -q -m "one test file" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D")"
argv="$(argv_of "$D")"
if [[ "$argv" == *"tests/test_alpha.py"* && "$argv" != *"tests/test_beta.py"* ]]; then
    ok "a test-only push runs exactly the changed module"
else
    ko "a test-only push runs exactly the changed module" "argv: $argv"
fi

# --- case 3: non-test source -> full suite (no file args) --------------------
D="$SCRATCH/c3"; setup_clone "$D"
mkdir -p dashboard && printf '__version__ = "1"\n' > dashboard/__init__.py
g "$D" add dashboard/__init__.py >/dev/null 2>&1
g "$D" commit -q -m "source" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D")"
argv="$(argv_of "$D")"
if [[ "$argv" != "__PYTEST_NEVER_RAN__" && "$argv" != *".py"* ]]; then
    ok "a non-test Python change escalates to the full suite"
else
    ko "a non-test Python change escalates to the full suite" "argv: $argv"
fi

# --- case 4: shell-only push must NOT skip (the fail-open) -------------------
# Five Python tests in this repo assert on shell/JSON source. A hook that skips
# pytest whenever no .py changed fails open on exactly those.
D="$SCRATCH/c4"; setup_clone "$D"
echo '# changed' >> autonomy/run.sh
g "$D" add autonomy/run.sh >/dev/null 2>&1
g "$D" commit -q -m "shell only" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D")"
argv="$(argv_of "$D")"
if [[ "$argv" == "__PYTEST_NEVER_RAN__" ]]; then
    ko "a shell-only push still runs pytest (fail-open)" \
       "pytest was skipped; python tests assert on shell source"
elif [[ "$argv" == *".py"* ]]; then
    ko "a shell-only push runs the FULL suite" "argv scoped to files: $argv"
else
    ok "a shell-only push still runs the full suite"
fi

# --- case 5: conftest.py must escalate, never be passed as a target ----------
D="$SCRATCH/c5"; setup_clone "$D"
echo '# changed' >> tests/conftest.py
g "$D" add tests/conftest.py >/dev/null 2>&1
g "$D" commit -q -m conftest --no-verify >/dev/null 2>&1
rc="$(run_hook "$D")"
argv="$(argv_of "$D")"
if [[ "$argv" == *"conftest.py"* ]]; then
    ko "conftest.py escalates instead of being a pytest target" \
       "pytest <conftest.py> collects nothing and exits 5; argv: $argv"
elif [[ "$argv" == "__PYTEST_NEVER_RAN__" ]]; then
    ko "conftest.py escalates to the full suite" "pytest never ran"
else
    ok "conftest.py escalates to the full suite"
fi

# --- case 6: a failing test still blocks the push ---------------------------
D="$SCRATCH/c6"; setup_clone "$D"
printf 'def test_boom():\n    assert False\n' >> tests/test_alpha.py
g "$D" add tests/test_alpha.py >/dev/null 2>&1
g "$D" commit -q -m failing --no-verify >/dev/null 2>&1
export STUB_PYTEST_RC=1
rc="$(run_hook "$D")"
unset STUB_PYTEST_RC
if [[ "$rc" == "RC=0" ]]; then
    ko "a failing test still blocks the push (fail-open regression)" \
       "hook exited 0 with pytest reporting failure"
else
    ok "a failing test still blocks the push"
fi

# --- case 7: git's exported env must not leak into pytest -------------------
# Git exports GIT_DIR / GIT_INDEX_FILE into every hook. Those are inherited by
# each `git` a test spawns, redirecting tests that build a throwaway fixture
# repo at the real repository instead. Measured: 22 failures under `git push`
# that pass the instant GIT_DIR is unset. The stub records whether the leak
# reached it.
D="$SCRATCH/c7"; setup_clone "$D"
cd "$D" || exit 1   # setup_clone already cd's here; be explicit -- a git
                    # command run from the wrong cwd commits into the REAL
                    # repository. That happened once during development.
cat > bin/python3 <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-m" && "${2:-}" == "pytest" ]]; then
    printf 'GIT_DIR=[%s] GIT_INDEX_FILE=[%s]\n' \
        "${GIT_DIR:-}" "${GIT_INDEX_FILE:-}" > "$PYTEST_ARGV_FILE"
    exit 0
fi
exec /usr/bin/env python3 "$@"
STUB
chmod +x bin/python3
cp bin/python3 bin/python3.12 && chmod +x bin/python3.12
printf 'def test_added():\n    assert True\n' >> tests/test_alpha.py
g "$D" add tests/test_alpha.py bin/python3 >/dev/null 2>&1
g "$D" commit -q -m "env leak probe" --no-verify >/dev/null 2>&1
rc="$(run_hook "$D")"
leak="$(argv_of "$D")"
if [[ "$leak" == *"GIT_DIR=[]"* && "$leak" == *"GIT_INDEX_FILE=[]"* ]]; then
    ok "git's exported env does not leak into pytest"
else
    ko "git's exported env does not leak into pytest" "saw: $leak"
fi

# --- case 8: pytest rc is not masked by a pipe ------------------------------
# The trap this replaced: `pytest -q 2>&1 | tail -25` reports TAIL's status.
if grep -qE 'pytest -q[^|]*\| *tail' "$HOOK"; then
    ko "pytest rc is not masked by a pipe to tail"
else
    ok "pytest rc is not masked by a pipe to tail"
fi

cd "$REPO_ROOT" || true
echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
