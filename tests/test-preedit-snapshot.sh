#!/usr/bin/env bash
# Pre-edit snapshot: measure the AGENT, not the agent-plus-whoever-fixed-it.
#
# THE CONTAMINATION UNDER TEST. 8090 AI's evaluation framework makes an argument
# we could not answer: "A skilled writer rescues an unusable draft, and the
# post-edit score looks acceptable; a junior writer leaves the model's failures
# visible, and the same model appears to perform worse. In either case, the
# metric describes the writer-plus-AI workflow, not the AI alone."
#
# Every quality number we publish is measured after a human may have touched the
# diff, so a strong reviewer flatters the agent and a weak one maligns it. The
# fix is order of operations, not analysis: capture the agent's output at the
# moment it stops, before any edit. 8090's own constraint is that the two must be
# "separated by the workflow itself, not reconstructed afterward from logs".
#
# So the load-bearing assertion here is test 3: WRITE-ONCE. A snapshot a later
# run can overwrite is not a snapshot -- re-capturing after a human edit would
# record the human's work as the agent's, which is precisely the contamination
# this module exists to prevent, reintroduced by the tool meant to stop it.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SNAP="$REPO_ROOT/autonomy/lib/preedit_snapshot.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: pre-edit snapshot separates agent output from human rescue"

[ -f "$SNAP" ] || { echo "  FAIL: $SNAP missing"; exit 1; }

_mk() {
    local d; d="$(mktemp -d)"
    git -C "$d" init -q .
    git -C "$d" config user.email t@t
    git -C "$d" config user.name t
    echo "base" > "$d/a.txt"
    git -C "$d" add a.txt
    git -C "$d" commit -qm base
    printf 'base\nagent line 1\nagent line 2\n' > "$d/a.txt"
    printf '%s' "$d"
}

# --- 1. capture records the agent's output with a checkable hash -------------
D="$(_mk)"; export LOKI_DIR="$D/.loki"
OUT="$(cd "$D" && python3 "$SNAP" capture run1 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"status": "captured"'; then
    ok "the agent's output is captured before any human edit"
else
    bad "capture failed"
fi
# The hash is what makes a later comparison evidence rather than an assertion.
if printf '%s' "$OUT" | grep -q '"diff_sha256"'; then
    ok "the snapshot carries a sha256 anyone can recompute"
else
    bad "no hash recorded, so the comparison would be unverifiable"
fi
# The raw diff must be kept beside it, or the hash cannot be checked by hand.
if [ -f "$D/.loki/preedit/run1.diff" ]; then
    ok "the raw diff is retained so the hash is checkable"
else
    bad "the raw diff was not retained"
fi

# --- 2. an untouched diff is reported as the agent's alone ------------------
OUT="$(cd "$D" && python3 "$SNAP" compare run1 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"human_edited": false'; then
    ok "an unedited diff reports human_edited false"
else
    bad "an unedited diff was misreported as edited"
fi

# --- 3. THE LOAD-BEARING ONE: a human edit is detected, and write-once holds -
# A human rescues the agent's work. Post-edit scoring would silently credit the
# agent for this.
printf 'base\nagent line 1 (fixed by a human)\nagent line 2\nhuman added a test\n' > "$D/a.txt"
OUT="$(cd "$D" && python3 "$SNAP" compare run1 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"human_edited": true'; then
    ok "a human edit after the fact is detected"
else
    bad "a human edit was NOT detected -- scores would credit the agent for it"
fi
# Re-capturing must refuse. If it overwrote, the human's lines would become the
# agent's and the whole module would be self-defeating.
OUT="$(cd "$D" && python3 "$SNAP" capture run1 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"status": "exists"'; then
    ok "re-capture refuses to overwrite (human work can never become agent work)"
else
    bad "re-capture overwrote the snapshot -- reintroduces the contamination"
fi
# And the stored snapshot must still describe the AGENT's line count, not the
# post-edit one.
N="$(python3 -c "
import json
print(json.load(open('$D/.loki/preedit/run1.json'))['lines_added'])" 2>/dev/null)"
if [ "$N" = "2" ]; then
    ok "the snapshot still holds the agent's 2 lines, not the post-edit 3"
else
    bad "the snapshot line count drifted after a human edit (got '$N')"
fi
rm -rf "$D"

# --- 4. UNKNOWN discipline, never a zero and never a pass -------------------
D="$(_mk)"; export LOKI_DIR="$D/.loki"
OUT="$(cd "$D" && python3 "$SNAP" compare never-captured 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_snapshot"'; then
    ok "comparing without a snapshot reports a named UNKNOWN"
else
    bad "a missing snapshot did not report a named UNKNOWN"
fi
if ! printf '%s' "$OUT" | grep -qE '"(human_edited|agent_lines_added)": (false|0)'; then
    ok "an unmeasurable comparison emits no zero and no false pass"
else
    bad "an unmeasurable comparison emitted a number (false green)"
fi
rm -rf "$D"

# --- 5. It scores nothing. Deliberately. -------------------------------------
# A composite score would invite the ranking behaviour that made post-edit
# numbers misleading in the first place, and a gate that punished the agent for
# needing edits would train it to produce diffs nobody edits -- which is not the
# same thing as good diffs.
# Checked with Python's own parser, not grep. A line-based filter cannot strip a
# triple-quoted docstring, and the first version of this test went red on the
# module's own prose explaining that no score exists. A guard that fires on its
# own documentation gets deleted by the next person, so it inspects the parsed
# AST: assignments, function names, and dict keys -- what the code actually DOES.
if python3 - "$SNAP" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
banned = ("score", "grade", "rating", "percent")
hits = []
for node in ast.walk(tree):
    if isinstance(node, ast.Name) and any(b in node.id.lower() for b in banned):
        hits.append(node.id)
    if isinstance(node, ast.FunctionDef) and any(b in node.name.lower() for b in banned):
        hits.append(node.name)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        # Only dict KEYS matter: an emitted field named *_score would be the
        # forbidden thing. Prose inside a note string is not.
        pass
for node in ast.walk(tree):
    if isinstance(node, ast.Dict):
        for k in node.keys:
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                if any(b in k.value.lower() for b in banned):
                    hits.append(k.value)
sys.exit(1 if hits else 0)
PY
then
    ok "the snapshot records facts and computes no score (AST-checked)"
else
    bad "the snapshot computes or emits a score -- it must record facts only"
fi

# --- 6. No second telemetry egress point ------------------------------------
if [ "$(grep -c 'loki_telemetry\|curl ' "$SNAP")" = "0" ]; then
    ok "no second telemetry egress point"
else
    bad "the snapshot emits telemetry directly"
fi

# --- 7. House style ----------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$SNAP" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
