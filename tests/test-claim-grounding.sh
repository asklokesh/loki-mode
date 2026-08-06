#!/usr/bin/env bash
# Claim grounding: the completion claim is the one artifact nobody checks.
#
# THE GAP. Our evidence gate has six axes -- diff non-empty, tests green, runtime
# boot, no-mock, authorization, secret leak. Every one is a REPO-LEVEL fact and
# none reads what the agent actually CLAIMED. So an agent can finish by asserting
# "added retry logic to autonomy/payments.py and covered it with tests" while the
# diff shows a README edit, and every axis passes: the diff is non-empty, the
# tests are green, the app boots.
#
# 8090 AI blocks ungrounded output at generation rather than at review, and their
# stated payoff is the reason this is worth having: "the rubric measures the
# quality of what survives the architectural filter, which is a much smaller and
# more interesting space."
#
# THE FAIL-OPEN DIRECTION IS THE DESIGN, AND TESTS 3-5 PIN IT. Only a claim that
# names a path demonstrably NOT in the diff is a finding. Prose with no paths is
# UNGROUNDABLE and passes. A check that failed on ambiguity would fire on
# ordinary sentences and be disabled inside a week, which is worse than not
# having it at all -- so "it does not cry wolf" is asserted as hard as "it
# catches the real thing".

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CG="$REPO_ROOT/autonomy/lib/claim_grounding.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a completion claim must name work that exists in the diff"

[ -f "$CG" ] || { echo "  FAIL: $CG missing"; exit 1; }

# --- 1. THE FAILURE THIS EXISTS TO CATCH ------------------------------------
# Claim names a file the run never touched. Every existing evidence axis passes
# for this run: the diff is non-empty, so (a) is satisfied.
OUT="$(python3 "$CG" --claim "Added retry logic to autonomy/payments.py and covered it with tests" --files "README.md,docs/setup.md" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"has_ungrounded_claim": true'; then
    ok "a claim naming an untouched file is caught"
else
    bad "an ungrounded claim was NOT caught -- the core failure"
fi
if printf '%s' "$OUT" | grep -q 'autonomy/payments.py'; then
    ok "the report names the specific unsupported path"
else
    bad "the offending path was not named, so the finding is not actionable"
fi

# --- 2. A grounded claim passes ---------------------------------------------
OUT="$(python3 "$CG" --claim "Fixed the parser in autonomy/run.sh" --files "autonomy/run.sh,tests/t.sh" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"has_ungrounded_claim": false'; then
    ok "a claim naming a genuinely changed file passes"
else
    bad "a correct claim was flagged -- false positive"
fi

# --- 3. Informal path forms must not false-fire ------------------------------
# An agent writes `run.sh` and `autonomy/run.sh` for the same file. Demanding an
# exact repo-relative string would make every informal mention a finding.
OUT="$(python3 "$CG" --claim "patched run.sh" --files "autonomy/run.sh" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"has_ungrounded_claim": false'; then
    ok "a bare filename matches its repo-relative path (no false positive)"
else
    bad "an informal but correct path form was flagged"
fi

# --- 4. Prose with no paths is UNGROUNDABLE, never a failure ----------------
OUT="$(python3 "$CG" --claim "fixed the login bug and added tests" --files "src/auth.py" 2>/dev/null)"
RC=$?
if printf '%s' "$OUT" | grep -q '"reason": "ungroundable"'; then
    ok "a claim with no paths reports UNGROUNDABLE with a named reason"
else
    bad "a path-free claim did not report a named UNKNOWN"
fi
if [ "$RC" = "0" ]; then
    ok "an ungroundable claim does not fail (a check that cries wolf gets disabled)"
else
    bad "an ordinary prose claim caused a failure -- this would be turned off in a week"
fi

# --- 5. Missing inputs report a reason, never a silent pass ------------------
OUT="$(python3 "$CG" --claim "" --files "a.py" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_claim"'; then
    ok "an empty claim reports no_claim rather than passing silently"
else
    bad "an empty claim did not report a named reason"
fi
OUT="$(python3 "$CG" --claim "touched a.py" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_diff"'; then
    ok "a missing diff reports no_diff rather than passing silently"
else
    bad "a missing diff did not report a named reason"
fi

# --- 6. Exit code is the signal a gate can consume --------------------------
python3 "$CG" --claim "changed autonomy/nope.py" --files "README.md" >/dev/null 2>&1
[ "$?" = "1" ] && ok "an ungrounded claim exits 1 (gate-consumable)" \
                || bad "an ungrounded claim did not exit 1"
python3 "$CG" --claim "changed autonomy/run.sh" --files "autonomy/run.sh" >/dev/null 2>&1
[ "$?" = "0" ] && ok "a grounded claim exits 0" \
                || bad "a grounded claim did not exit 0"

# --- 7. No model is invoked. Every verdict is a string-set comparison --------
# "Added retry logic" vs "added a retry constant" is a JUDGEMENT. Asking an LLM
# to grade it would be the LLM-judge-as-measurement this codebase refuses.
CODE="$(python3 - "$CG" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
names = []
for n in ast.walk(tree):
    if isinstance(n, ast.Name): names.append(n.id.lower())
    if isinstance(n, ast.Attribute): names.append(n.attr.lower())
print(" ".join(names))
PY
)"
if printf '%s' "$CODE" | grep -qiE "claude|anthropic|openai|llm|model"; then
    bad "the grounding check invokes a model -- verdicts must be deterministic"
else
    ok "no model is invoked; grounding is a deterministic path comparison"
fi

# --- 8. No second telemetry egress point ------------------------------------
if [ "$(grep -c 'loki_telemetry\|curl ' "$CG")" = "0" ]; then
    ok "no second telemetry egress point"
else
    bad "the grounding check emits telemetry directly"
fi

# --- 9. House style ----------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$CG" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
