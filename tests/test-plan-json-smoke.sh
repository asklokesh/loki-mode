#!/usr/bin/env bash
# tests/test-plan-json-smoke.sh -- Fast, direct regression guard for the
# v7.41.1 `loki plan --json` crash.
#
# Background: a comment edit inside a double-quoted `python3 -c "..."` heredoc
# in autonomy/loki carried unescaped `$5`/`$10`/`$25`/`$50`. Under `set -u`
# bash expanded them as positional params; `$5` was unbound, so EVERY
# `loki plan --json` invocation aborted with "$5: unbound variable". The fix
# escaped them (\$). The parity matrix caught it only indirectly. This test is
# the DIRECT guard: it actually runs `loki plan ./prd.md --json` and asserts a
# clean exit, valid JSON, a populated cost.iterations_by_model dict, and the
# absence of "unbound variable" on stderr -- across the no-env, fable-pin, and
# (implicitly via fable->opus collapse) opus dispatch paths.
#
# Conventions mirror tests/test-completion-summary.sh and tests/test-json-prd.sh:
# ok/bad helpers, SKIP-if-no-python (exit 0, not a fail), throwaway temp dir
# cleaned via EXIT trap, and "N passed, M failed" with exit 1 on any failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$LOKI" ]; then
    echo "SKIP: autonomy/loki not found. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d /tmp/loki-test-planjson-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Minimal PRD that resolves to the "simple" tier (deterministic, no network).
PRD="$WORK/prd.md"
cat > "$PRD" <<'EOF'
# Todo CLI

A small command-line todo application.

## Features
- add a task
- list tasks
- mark a task done
EOF

# ---------------------------------------------------------------------------
# Static assertion: the script must parse. A broken heredoc / quoting edit in
# autonomy/loki would already be flagged here (cheap and fast).
# ---------------------------------------------------------------------------
if bash -n "$LOKI" 2>"$WORK/syntax.err"; then
    ok "static: bash -n autonomy/loki parses clean"
else
    bad "static: bash -n autonomy/loki failed" "$(head -3 "$WORK/syntax.err" 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# Runtime smoke: run `loki plan ./prd.md --json` under three env conditions.
# Each condition asserts (a) exit 0, (b) valid JSON, (c) populated
# cost.iterations_by_model, (d) no "unbound variable" on stderr.
# ---------------------------------------------------------------------------
run_case() {
    # $1 = human label, remaining args = env assignments (KEY=VALUE ...)
    local label="$1"; shift
    local out="$WORK/out-$$-$RANDOM.json"
    local err="$WORK/err-$$-$RANDOM.txt"
    local rc

    # Run from inside the temp dir so the relative ./prd.md resolves and no
    # .loki state leaks into the repo. env applies the per-case overrides.
    ( cd "$WORK" && env "$@" "$LOKI" plan ./prd.md --json ) >"$out" 2>"$err"
    rc=$?

    # (a) exit code 0
    if [ "$rc" -eq 0 ]; then
        ok "$label: exit code 0"
    else
        bad "$label: exit code $rc" "$(head -3 "$err" 2>/dev/null)"
    fi

    # (d) stderr free of the regression signature
    if grep -q "unbound variable" "$err" 2>/dev/null; then
        bad "$label: stderr contains 'unbound variable'" "$(grep 'unbound variable' "$err" | head -1)"
    else
        ok "$label: stderr has no 'unbound variable'"
    fi

    # (b) stdout is valid JSON
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$out" 2>/dev/null; then
        ok "$label: stdout is valid JSON"
    else
        bad "$label: stdout is not valid JSON" "$(head -3 "$out" 2>/dev/null)"
        return
    fi

    # (c) cost.iterations_by_model is a non-empty dict
    local ibm
    ibm="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
v = d.get("cost", {}).get("iterations_by_model")
print("OK" if isinstance(v, dict) and len(v) > 0 else "BAD")
' "$out" 2>/dev/null || echo "BAD")"
    if [ "$ibm" = "OK" ]; then
        ok "$label: cost.iterations_by_model is a non-empty dict"
    else
        bad "$label: cost.iterations_by_model missing/empty"
    fi
}

# No-env baseline (the path every user hits).
run_case "no-env"

# Fable session pin (advisor tier; collapses fable->opus at dispatch, but the
# estimator still walks the model accounting that contains the escaped dollar
# amounts that caused the original crash).
run_case "fable-pin" LOKI_SESSION_MODEL=fable

# Explicit opus pin (exercises the same cost-table walk under a different tier).
run_case "opus-pin" LOKI_SESSION_MODEL=opus

echo ""
echo "plan --json smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
