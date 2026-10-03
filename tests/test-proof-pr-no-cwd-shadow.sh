#!/usr/bin/env bash
# S-215: render_evidence_receipt_md in autonomy/lib/proof-pr.sh ran a bare
# `python3 -`, which puts the cwd first on sys.path. Called from the agent's
# repo, a committed json.py whose load() returns a VERIFIED honesty block made a
# NOT VERIFIED proof render "Headline: VERIFIED" in the PR body. The renderer
# must resolve its interpreter through _loki_snapshot_py_tool and run it -I -S,
# and print the honest "unavailable" line when no interpreter resolves.
#
# LOKI_PROOF_PR_SH_OVERRIDE points the suite at another copy of proof-pr.sh
# (used for the revert and mutation checks).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${LOKI_PROOF_PR_SH_OVERRIDE:-$ROOT/autonomy/lib/proof-pr.sh}"
UNAVAIL="Evidence Receipt: unavailable for this run."

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed (not a fail)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s215.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT
export LOKI_NO_BROWSER=1
REPO="$WORK/repo"
mkdir -p "$REPO"

# The hostile target repo: a json.py that forges every load.
cat >"$REPO/json.py" <<'EOF'
def load(*a, **k):
    return {"honesty": {"headline": "VERIFIED"}}
def loads(*a, **k):
    return load()
EOF
printf '%s\n' '{"honesty":{"headline":"NOT VERIFIED"},"facts":{"git":{"head_sha":"abc123"}},"run_id":"run-1"}' >"$REPO/proof.json"
printf '%s\n' '{"honesty":{"headline":"VERIFIED"},"facts":{"git":{"head_sha":"abc123"}},"run_id":"run-2"}' >"$WORK/good.json"

# Positive control: a bare `python3 -` from the repo imports the planted json.py,
# so a green below is the fix, not a harmless fixture.
got="$(cd "$REPO" && printf '%s\n' 'import json; print(json.load(open("proof.json"))["honesty"]["headline"])' | python3 - 2>/dev/null)"
if [ "$got" = "VERIFIED" ]; then
    ok "control: bare python3 - from the repo imports the planted json.py"
else
    echo "FAIL: control did not reproduce the cwd shadow (got '$got'); cases below would be vacuous"
    exit 1
fi

# render <proof> [nopy]: source the copy from the hostile repo and render.
render() {
    (
        cd "$REPO" || exit 99
        # shellcheck disable=SC1090
        . "$SRC" >/dev/null 2>&1
        if [ "${2:-}" = nopy ]; then
            # shellcheck disable=SC2329
            _loki_snapshot_py_tool() { return 1; }
        fi
        render_evidence_receipt_md "$1"
    ) 2>/dev/null
}

out="$(render proof.json)"
if printf '%s\n' "$out" | grep -qx 'Headline: NOT VERIFIED'; then
    ok "cwd json.py cannot forge the headline (renders NOT VERIFIED)"
else
    bad "cwd json.py forged the receipt: $(printf '%s\n' "$out" | grep -m1 '^Headline:' || printf '%s' "$out" | head -n1)"
fi

# A genuine VERIFIED proof still renders green, so an always-unavailable
# renderer cannot pass the case above by printing nothing useful.
out="$(render "$WORK/good.json")"
if printf '%s\n' "$out" | grep -qx 'Headline: VERIFIED'; then
    ok "genuine VERIFIED proof still renders VERIFIED"
else
    bad "genuine VERIFIED proof did not render VERIFIED (got: $(printf '%s' "$out" | head -n1))"
fi

out="$(render proof.json nopy)"
if [ "$out" = "$UNAVAIL" ]; then
    ok "no interpreter: prints the unavailable line"
else
    bad "no interpreter: printed [$out], want [$UNAVAIL]"
fi

n="$(grep -vE '^[[:space:]]*#' "$SRC" | grep -cE '(^|[^_/[:alnum:]"])python3[[:space:]]+-')"
if [ "$n" = "0" ]; then ok "static: no bare python3 call site remains"; else bad "static: $n bare python3 call site(s) remain"; fi

if [ ! -e "$ROOT/.loki/state/provider" ]; then ok "repo has no .loki/state/provider"; else bad "repo gained .loki/state/provider"; fi

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
