#!/usr/bin/env bash
# Failure memory: learn from being wrong, without poisoning the next run.
#
# THE GAP. Factory AI has NO memory system -- verified by grep over their whole
# doc corpus. AGENTS.md is hand-authored, AutoWiki regenerates from CODE not
# outcomes, QA failure learning is `suggest_in_report` (a human reads it), and
# mission-generated skills are DISCARDED with the mission. Devin has a memory
# layer but every session starts from a fresh snapshot and all changes are
# discarded at teardown -- and their Session Insights ships a "Misleading
# Knowledge" tab enumerating memory items that led Devin astray. They shipped a
# UI to manage their memory poisoning output.
#
# THE POISONING MECHANISM, AND THE TEST THAT PREVENTS IT. Memory written from an
# agent's own narration records what the agent BELIEVED -- which is exactly what
# was wrong when it failed. So test 1 is the load-bearing one: a lesson without
# EVIDENCE is refused outright. If we cannot say what was observed, we write
# nothing, because an unfalsifiable lesson cannot be retired later and will
# accumulate forever.
#
# Test 5 is its twin: no summary, no generalization, no "what this means". A
# judgement stored beside facts is indistinguishable from a fact to the next
# reader, which is how a memory system starts lying.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FM="$REPO_ROOT/autonomy/lib/failure_memory.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: failure memory learns from measured events, not from narration"

[ -f "$FM" ] || { echo "  FAIL: $FM missing"; exit 1; }

# --- 1. THE LOAD-BEARING ONE: no evidence, no lesson ------------------------
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
OUT="$(cd "$T" && python3 "$FM" record --gate=mock_integrity --verdict=FAIL 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_evidence"'; then
    ok "a lesson with no evidence is refused (unfalsifiable memory is the poison)"
else
    bad "an unfalsifiable lesson was accepted -- this is how memory starts lying"
fi
if [ ! -f "$T/.loki/memory/failures.jsonl" ]; then
    ok "the refused lesson wrote nothing to disk"
else
    bad "a refused lesson still created a store"
fi
# A gate name is equally required: a failure attributed to nothing is not a lesson.
OUT="$(cd "$T" && python3 "$FM" record --evidence="something happened" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_gate"'; then
    ok "a lesson with no gate to attribute to is refused"
else
    bad "a lesson with no attribution was accepted"
fi

# --- 2. A measured failure becomes durable ----------------------------------
(cd "$T" && python3 "$FM" record --gate=mock_integrity --verdict=FAIL \
    --evidence="require.resolve stub in src/api.ts:42" >/dev/null 2>&1)
(cd "$T" && python3 "$FM" record --gate=mock_integrity --verdict=FAIL \
    --evidence="spawnSync stub in src/db.ts:18" >/dev/null 2>&1)
(cd "$T" && python3 "$FM" record --gate=secret_leak --verdict=FAIL \
    --evidence="AWS key in config.yml" >/dev/null 2>&1)
N="$(wc -l < "$T/.loki/memory/failures.jsonl" | tr -d ' ')"
if [ "$N" = "3" ]; then
    ok "measured failures append and persist (3 lessons)"
else
    bad "lessons did not persist (got '$N')"
fi

# --- 3. Recall is a COUNT, which a reader can check -------------------------
OUT="$(cd "$T" && python3 "$FM" recall 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"mock_integrity": 2'; then
    ok "recall reports a checkable count per gate"
else
    bad "recall did not report per-gate counts"
fi
# The evidence must survive, or the lesson cannot be retired when it stops holding.
if printf '%s' "$OUT" | grep -q 'src/api.ts:42'; then
    ok "the evidence is retained so a stale lesson can be retired"
else
    bad "evidence was dropped, making lessons unfalsifiable after the fact"
fi

# --- 4. The next run is told facts, not advice ------------------------------
OUT="$(cd "$T" && python3 "$FM" context 2>/dev/null)"
if printf '%s' "$OUT" | grep -q 'has failed 2 times in this repo before'; then
    ok "the next run receives a countable fact"
else
    bad "context did not surface prior failures"
fi
# Prescribing a fix from a count would invent a causal claim the data lacks.
if printf '%s' "$OUT" | grep -qiE '"lines".*(you should|try |fix by|recommend)'; then
    bad "context prescribes a fix -- that is a judgement the counts do not support"
else
    ok "context states what happened, not what to do about it"
fi
rm -rf "$T"

# --- 5. STRUCTURAL: no generalization is ever stored ------------------------
# Checked against the parsed AST rather than by grep, because the module's own
# prose explains why these are absent and a line filter cannot tell the two
# apart -- a guard that fires on its own documentation gets deleted.
if python3 - "$FM" <<'PY'
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
banned = ("summary", "generaliz", "lesson_text", "insight", "recommendation")
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
    ok "no stored field holds a summary or generalization (AST-checked)"
else
    bad "a generalization is stored beside facts -- indistinguishable to a reader"
fi

# --- 6. No model is invoked -------------------------------------------------
if grep -qiE "claude|anthropic|openai|llm_" "$FM"; then
    bad "the memory invokes a model -- lessons must come from measured events"
else
    ok "no model is invoked; lessons come only from measured events"
fi

# --- 7. UNKNOWN discipline on an empty project -----------------------------
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
OUT="$(cd "$T" && python3 "$FM" recall 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_lessons"'; then
    ok "an empty project reports a named UNKNOWN, not an empty pass"
else
    bad "an empty project did not report a named UNKNOWN"
fi
rm -rf "$T"

# --- 8. A corrupt line is counted, never silently dropped ------------------
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
mkdir -p "$T/.loki/memory"
printf '{"gate":"g1","evidence":"e"}\ngarbage\n' > "$T/.loki/memory/failures.jsonl"
OUT="$(cd "$T" && python3 "$FM" recall 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"unparseable_lines": 1'; then
    ok "an unreadable lesson is counted and reported"
else
    bad "an unreadable lesson was silently dropped"
fi
rm -rf "$T"

# --- 9. Not telemetry -------------------------------------------------------
if [ "$(grep -c 'loki_telemetry\|curl \|urllib\|requests' "$FM")" = "0" ]; then
    ok "nothing is transmitted; telemetry.sh stays the single egress point"
else
    bad "the failure memory transmits data"
fi

# --- 10. House style --------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$FM" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
