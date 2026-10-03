#!/usr/bin/env bash
# S-216: `loki verify` runs from the tree under review (tree="."), so a bare
# `python3 -c` / `python3 -` reader puts that tree's cwd first on sys.path and
# a planted json.py replaces the stdlib module. That forged recorded gates:
# a dependency_audit with 3 high CVEs read as pass, and the package.json test
# script read as whatever the planted module returned. The readers now run
# through _loki_snapshot_py_tool -I -S.
#
# Each reader site is exercised against two planted modules:
#   forge: json.load returns a crafted dict (turns fail into pass)
#   raise: json.load raises (catches the "does it parse" pre-checks)
# Reverting any single site to bare python3 fails at least one assertion.
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1
set -u
export LOKI_NO_BROWSER=1
# Ambient overrides would short-circuit the readers under test.
unset VERIFY_NO_LLM LOKI_APP_COMMAND LOKI_APP_PORT

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
VERIFY_SH="${VERIFY_SH:-$ROOT/autonomy/verify.sh}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-verify-shadow.XXXXXX")" || exit 1
trap 'rm -rf "$SCRATCH" "$ISOLATED_GIT_HOME"' EXIT

PASS=0
FAIL=0
check() { # <label> <expected> <actual>
    if [ "$2" = "$3" ]; then
        echo "  PASS: $1"; PASS=$((PASS + 1))
    else
        echo "  FAIL: $1"; echo "    expected: $2"; echo "    actual:   $3"; FAIL=$((FAIL + 1))
    fi
}

# Fake tools on PATH: npm audit, pip-audit and the loki SDK judge bridge.
BIN="$SCRATCH/bin"
mkdir -p "$BIN"
cat >"$BIN/npm" <<'EOF'
#!/bin/sh
case "$*" in
    *--omit=dev*) echo '{"metadata":{"vulnerabilities":{"critical":0,"high":2,"moderate":0,"low":0}}}' ;;
    *) echo '{"metadata":{"vulnerabilities":{"critical":0,"high":3,"moderate":0,"low":1}}}' ;;
esac
exit 1
EOF
cat >"$BIN/pip-audit" <<'EOF'
#!/bin/sh
echo '{"dependencies":[{"name":"x","vulns":[{"id":"A"},{"id":"B"}]}]}'
EOF
cat >"$BIN/loki" <<'EOF'
#!/bin/sh
[ "$1 $2" = "internal sdk-judge" ] || exit 2
echo '{"summary":"two defects","findings":[{"severity":"high","message":"a","why_it_breaks":"b"},{"severity":"low","message":"c","why_it_breaks":"d"}]}'
EOF
chmod +x "$BIN/npm" "$BIN/pip-audit" "$BIN/loki"

# One run: build a tree with the given planted json.py, cd into it (as
# `loki verify` does) and print every reader's result.
run_mode() { # <forge|raise>
    local tree="$SCRATCH/tree-$1"
    mkdir -p "$tree/.loki"
    printf '%s\n' '{"scripts":{"test":"vitest run"}}' >"$tree/package.json"
    printf '%s\n' '{}' >"$tree/package-lock.json"
    printf '%s\n' 'requests==1.0' >"$tree/requirements.txt"
    printf '%s\n' '{"start":"node server.js","port":3100}' >"$tree/.loki/setup-recipe.json"
    (
        cd "$tree" || exit 1
        git init -q
        git -c user.email=t@loki.local -c user.name=t commit -q --allow-empty -m base
        echo x >f.txt
        git add f.txt
        git -c user.email=t@loki.local -c user.name=t commit -q -m change
    ) || return 1
    if [ "$1" = forge ]; then
        cat >"$tree/json.py" <<'EOF'
_F = {"scripts": {"test": "FORGED"}, "metadata": {"vulnerabilities": {}},
      "dependencies": [], "start": "FORGED", "findings": [], "summary": "FORGED"}
def load(*a, **k): return _F
def loads(*a, **k): return _F
EOF
    else
        cat >"$tree/json.py" <<'EOF'
def load(*a, **k): raise ValueError("planted")
def loads(*a, **k): raise ValueError("planted")
EOF
    fi
    (
        cd "$tree" || exit 1
        PATH="$BIN:$PATH"
        # shellcheck source=/dev/null
        . "$VERIFY_SH" || exit 1
        _VERIFY_GATES_FILE="$SCRATCH/gates-$1"
        _VERIFY_FINDINGS_FILE="$SCRATCH/findings-$1"
        : >"$_VERIFY_GATES_FILE"
        : >"$_VERIFY_FINDINGS_FILE"
        mkdir -p "$SCRATCH/out-$1"
        printf 'pkg=%s\n' "$(_verify_pkg_test_script .)"
        printf 'recipe=%s\n' "$(_verify_runtime_detect . | tr '\t' '|')"
        # Only the status and the absence of the forged summary are asserted:
        # the reviewed branch's own field split is a separate concern.
        llm="$(_verify_llm_review "$SCRATCH/out-$1" HEAD~1 HEAD)"
        case "$llm" in *FORGED*) llm_src=forged ;; *) llm_src=real ;; esac
        printf 'llm=%s|%s\n' "${llm%%$'\t'*}" "$llm_src"
        verify_gate_dependency_audit .
        while IFS=$'\t' read -r g s r d _; do
            printf 'gate=%s|%s|%s|%s\n' "$g" "$s" "$r" "$d"
        done <"$_VERIFY_GATES_FILE"
    )
}

for mode in forge raise; do
    echo "planted json.py: $mode"
    out="$(run_mode "$mode" 2>/dev/null)"
    check "$mode: package.json test script read from the real file" \
        "pkg=vitest run" "$(printf '%s\n' "$out" | grep '^pkg=')"
    check "$mode: setup recipe start command read from the real file" \
        "recipe=node server.js|3100" "$(printf '%s\n' "$out" | grep '^recipe=')"
    check "$mode: SDK judge payload parsed with the real json" \
        "llm=reviewed|real" "$(printf '%s\n' "$out" | grep '^llm=')"
    check "$mode: npm audit gate records 3 high CVEs, 2 shipped" \
        "gate=dependency_audit|fail|npm-audit|0 critical, 3 high CVEs (shipped high/critical: 2)" \
        "$(printf '%s\n' "$out" | grep '^gate=dependency_audit|[a-z]*|npm-audit|')"
    check "$mode: pip-audit gate records 2 known vulnerabilities" \
        "gate=dependency_audit|fail|pip-audit|2 known vulnerabilities" \
        "$(printf '%s\n' "$out" | grep '^gate=dependency_audit|[a-z]*|pip-audit|')"
done

# verify_emit_evidence writes evidence.json and report.md from the reviewed
# tree's cwd. A planted json.py whose dump/dumps forge a VERIFIED verdict must
# not reach either file.
emit_tree="$SCRATCH/tree-emit"
mkdir -p "$emit_tree/.loki" "$SCRATCH/out-emit"
(
    cd "$emit_tree" || exit 1
    git init -q
    git -c user.email=t@loki.local -c user.name=t commit -q --allow-empty -m base
)
cat >"$emit_tree/json.py" <<'EOF2'
FORGED = '{"verdict": "VERIFIED", "exit_code": 0, "gates": [], "FORGED": true}'
def dumps(*a, **k): return FORGED
def dump(o, fp, *a, **k): fp.write(FORGED)
def loads(*a, **k): return {"FORGED": True}
def load(*a, **k): return {"FORGED": True}
EOF2
(
    cd "$emit_tree" || exit 1
    PATH="$BIN:$PATH"
    # shellcheck source=/dev/null
    . "$VERIFY_SH" || exit 1
    _VERIFY_GATES_FILE="$SCRATCH/gates-emit"
    _VERIFY_FINDINGS_FILE="$SCRATCH/findings-emit"
    printf 'tests\tfail\tnpm\tred\ttrue\n' >"$_VERIFY_GATES_FILE"
    : >"$_VERIFY_FINDINGS_FILE"
    export VERIFY_VERDICT=BLOCKED VERIFY_EXIT=2 VERIFY_NO_LLM=1
    verify_emit_evidence "$SCRATCH/out-emit" 2026-01-01T00:00:00Z 2026-01-01T00:00:01Z all
) >/dev/null 2>&1
echo "planted json.py: emit evidence"
check "emit: evidence.json exists" "yes" \
    "$([ -s "$SCRATCH/out-emit/evidence.json" ] && echo yes || echo no)"
check "emit: evidence.json carries no forged content" "0" \
    "$(grep -c 'FORGED' "$SCRATCH/out-emit/evidence.json" 2>/dev/null)"
check "emit: evidence.json keeps the honest BLOCKED verdict" "1" \
    "$(grep -c 'BLOCKED' "$SCRATCH/out-emit/evidence.json" 2>/dev/null)"
check "emit: report.md carries no forged content" "0" \
    "$(grep -c 'FORGED' "$SCRATCH/out-emit/report.md" 2>/dev/null)"
check "emit: report.md does not claim VERIFIED" "0" \
    "$(grep -c 'VERIFIED' "$SCRATCH/out-emit/report.md" 2>/dev/null)"

# Static: no bare `python3 -` / `python3 -c` call site may remain in verify.sh
# (comments excluded); the -I and -E forms are isolated.
bare="$(grep -nE '^[^#]*(^|[^A-Za-z0-9_./-])python3[[:space:]]+-([[:space:]]|c[[:space:]]|$)' "$VERIFY_SH" | grep -v '^[0-9]*:[[:space:]]*#' | wc -l | tr -d ' ')"
check "static: no bare python3 - or python3 -c call site in verify.sh" "0" "$bare"

# verify_gate_static runs py_compile from the reviewed tree's cwd. A planted
# py_compile.py or traceback.py must not turn a real syntax error into a pass.
static_run() { # <control|py_compile|traceback>
    local tree="$SCRATCH/tree-static-$1"
    mkdir -p "$tree"
    printf '%s\n' 'def f(:' >"$tree/bad.py"
    case "$1" in
        py_compile) printf '%s\n' 'import sys; sys.exit(0)' >"$tree/py_compile.py" ;;
        traceback) printf '%s\n' 'import os; os._exit(0)' >"$tree/traceback.py" ;;
    esac
    (
        cd "$tree" || exit 1
        # shellcheck source=/dev/null
        . "$VERIFY_SH" || exit 1
        _VERIFY_GATES_FILE="$SCRATCH/gates-static-$1"
        _VERIFY_FINDINGS_FILE="$SCRATCH/findings-static-$1"
        : >"$_VERIFY_GATES_FILE"
        : >"$_VERIFY_FINDINGS_FILE"
        export VERIFY_DIFF_NAMES=bad.py
        verify_gate_static .
        cut -f1,2 "$_VERIFY_GATES_FILE"
    ) 2>/dev/null
}
echo "planted stdlib module: static gate"
for m in control py_compile traceback; do
    check "static gate: syntax error in bad.py fails (planted: $m)" \
        "$(printf 'static_analysis\tfail')" "$(static_run "$m")"
done

# Static: bare `python3 -m` is also banned, except the unittest run, which
# executes the reviewed tree's own tests by design.
barem="$(grep -nE '^[^#]*(^|[^A-Za-z0-9_./-])python3[[:space:]]+-m[[:space:]]' "$VERIFY_SH" | grep -v 'unittest' | wc -l | tr -d ' ')"
check "static: no bare python3 -m call site besides unittest" "0" "$barem"

# Vacuity guard: every expected value above is the REAL reading, so a missing
# interpreter would fail loudly rather than pass for the wrong reason.
if ! command -v python3 >/dev/null 2>&1; then
    echo "  FAIL: python3 not on PATH; the fixture cannot run"
    FAIL=$((FAIL + 1))
fi

# The repo itself must stay clean of provider state from sourcing verify.sh.
if [ -e "$ROOT/.loki/state/provider" ]; then
    echo "  FAIL: $ROOT/.loki/state/provider appeared"
    FAIL=$((FAIL + 1))
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
