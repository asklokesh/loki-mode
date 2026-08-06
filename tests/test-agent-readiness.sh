#!/usr/bin/env bash
# Agent readiness: a measurement, where the competitor ships an opinion.
#
# THE DIFFERENTIATOR UNDER TEST. Factory AI's Agent Readiness Model is a good
# idea and a category-defining artifact -- but it is LLM-SCORED: their report
# objects record modelUsed and reasoningEffort per report, so the number is a
# model's opinion of a repo and two runs can disagree about the same commit.
#
# Test 3 is therefore the load-bearing one: THREE RUNS OF THE SAME REPO MUST
# PRODUCE BYTE-IDENTICAL OUTPUT. That is the claim their version structurally
# cannot make, and it is the only reason ours is worth having. If determinism
# ever breaks, the feature has become a worse copy of theirs.
#
# Test 5 pins the other half: no percentage, no grade, no composite. A composite
# invites ranking, ranking invites gaming, and "there is no test command" is the
# actionable part that a score would hide.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AR="$REPO_ROOT/autonomy/lib/agent_readiness.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: agent readiness is measured, not judged"

[ -f "$AR" ] || { echo "  FAIL: $AR missing"; exit 1; }

# --- 1. A well-equipped repo scores every criterion, with evidence ----------
OUT="$(python3 "$AR" "$REPO_ROOT" --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"can_self_verify": true'; then
    ok "a repo with a test command reports it can self-verify"
else
    bad "a repo with a test command was not recognised"
fi
# Naming the evidence is what makes it checkable rather than asserted.
if printf '%s' "$OUT" | grep -q '"found":'; then
    ok "each present criterion names the file that satisfied it"
else
    bad "criteria are reported without the evidence that satisfied them"
fi

# --- 2. A bare repo reports the CONSEQUENCE, not just a low number ---------
T="$(mktemp -d)"; git -C "$T" init -q .
echo "x" > "$T/a.py"
OUT="$(python3 "$AR" "$T" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q "0 of 6 present"; then
    ok "a bare repo reports every criterion missing"
else
    bad "a bare repo did not report its missing criteria"
fi
if printf '%s' "$OUT" | grep -qi "is guessing whether its change worked"; then
    ok "the missing test command states what it means for an agent"
else
    bad "a missing test command was reported without its consequence"
fi
rm -rf "$T"

# --- 3. THE LOAD-BEARING ONE: determinism --------------------------------
# Factory's is LLM-scored and records modelUsed per report. Ours must give the
# same answer for the same commit on any machine, with no key and no spend.
H1="$(python3 "$AR" "$REPO_ROOT" --json 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
H2="$(python3 "$AR" "$REPO_ROOT" --json 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
H3="$(python3 "$AR" "$REPO_ROOT" --json 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
if [ "$H1" = "$H2" ] && [ "$H2" = "$H3" ]; then
    ok "three runs of the same repo are byte-identical (an opinion cannot promise this)"
else
    bad "runs disagree -- this is now a worse copy of the LLM-scored version"
fi

# --- 4. No model is invoked, and no network is touched --------------------
# Checked as IMPORTS and CALLS, not as text. A grep for "claude" matched the
# string "CLAUDE.md" -- a filename this check legitimately looks for as an agent
# brief -- and would have failed forever on correct code. The question is not
# whether a vendor name appears, it is whether this module can reach a model or
# the network at all, which the import table answers exactly.
if python3 - "$AR" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
banned = ("urllib", "requests", "http", "socket", "subprocess", "anthropic", "openai")
mods = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            mods.add(a.name.split(".")[0])
    if isinstance(node, ast.ImportFrom) and node.module:
        mods.add(node.module.split(".")[0])
hits = sorted(m for m in mods if any(b in m.lower() for b in banned))
if hits:
    sys.stderr.write("reachable: " + ",".join(hits) + "\n")
sys.exit(1 if hits else 0)
PY
then
    ok "no model and no network are reachable; every criterion is a filesystem fact"
else
    bad "readiness can reach a model or the network -- it must be a filesystem fact"
fi

# --- 5. No composite score is emitted ------------------------------------
# AST-checked rather than grepped: the module's own prose explains why a score
# is absent, and a line filter cannot tell documentation from implementation.
if python3 - "$AR" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
banned = ("score", "grade", "percent", "rating")
hits = []
for node in ast.walk(tree):
    if isinstance(node, ast.Dict):
        for k in node.keys:
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                if any(b in k.value.lower() for b in banned):
                    hits.append(k.value)
sys.exit(1 if hits else 0)
PY
then
    ok "no composite score is emitted (AST-checked)"
else
    bad "a composite score is emitted -- it invites ranking and hides the actionable part"
fi

# --- 6. It does not duplicate the existing maturity rubric ----------------
# `loki modernize heal --assess` already scores general code maturity with its
# own deterministic 4-level model. Two numbers for one repo eventually disagree,
# so this asks a different question: can an agent verify itself here.
if grep -qiE "'Ad hoc'|maturity_level" "$AR"; then
    bad "readiness duplicates the modernize maturity rubric -- two numbers will diverge"
else
    ok "readiness does not duplicate the existing maturity rubric"
fi

# --- 7. Read-only ---------------------------------------------------------
T="$(mktemp -d)"; git -C "$T" init -q .; echo "x" > "$T/a.py"
git -C "$T" add -A >/dev/null 2>&1; git -C "$T" -c user.email=t@t -c user.name=t commit -qm base
BEFORE="$(git -C "$T" status --porcelain)"
python3 "$AR" "$T" >/dev/null 2>&1
AFTER="$(git -C "$T" status --porcelain)"
if [ "$BEFORE" = "$AFTER" ]; then
    ok "assessing a repo does not modify it"
else
    bad "the readiness check mutated the repo it assessed"
fi
rm -rf "$T"

# --- 8. A missing directory is UNKNOWN, not a zero score -----------------
OUT="$(python3 "$AR" /nonexistent-path-xyz --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_such_directory"'; then
    ok "a missing path reports a named UNKNOWN rather than 0 of 6"
else
    bad "a missing path was scored instead of reported unmeasurable"
fi

# --- 9. House style -------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$AR" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
