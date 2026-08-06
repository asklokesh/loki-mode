#!/usr/bin/env bash
# Intent Ledger: detect the drift a verification gate structurally cannot see.
#
# THE FAILURE UNDER TEST. Our gates prove code matches spec. They cannot prove
# the spec was RIGHT. 8090 AI documents a real build where "the software
# converged with the interpretation. The interpretation had diverged from the
# intent" -- a perfect verification gate passes that build and the build is still
# wrong. Scenario 2 below reproduces exactly that: a requirement is rewritten
# from "users can export" to "admins can export via internal API", code would
# still match the spec byte for byte, and the thing the person actually wanted is
# gone.
#
# WHAT THESE TESTS DELIBERATELY DO NOT ASSERT. There is no similarity score, no
# fidelity percentage, no embedding distance -- because the implementation has
# none. The obvious version of this feature asks a model "does the spec express
# the intent?" and prints a number; that is an LLM judgment wearing the costume
# of a measurement, and our receipts exist to separate deterministic FACTS from
# AI ASSESSMENTS. Test 6 enforces the absence structurally, so a future
# contributor cannot add one as an improvement without the suite going red.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INTENT="$REPO_ROOT/autonomy/intent.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: intent ledger detects spec-drifted-from-intent"

[ -f "$INTENT" ] || { echo "  FAIL: $INTENT missing"; exit 1; }

_mk() {
    local d; d="$(mktemp -d)"
    mkdir -p "$d/.loki/spec"
    cat > "$d/.loki/spec/spec.lock" <<'EOF'
{"requirements":[
 {"id":"R1","kind":"must","level":"high","text":"Users can export their data as CSV","content_hash":"aaa111"},
 {"id":"R2","kind":"must","level":"high","text":"Export completes in under 5s","content_hash":"bbb222"}]}
EOF
    printf '%s' "$d"
}
_sid() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['statements'][0]['id'])" "$1/.loki/intent/intent.json"; }

# --- 1. record + link + status: the aligned baseline -------------------------
D="$(_mk)"; export LOKI_DIR="$D/.loki"
bash "$INTENT" record --statement "Customers get their data out without asking support" >/dev/null 2>&1
SID="$(_sid "$D")"
bash "$INTENT" link "$SID" R1 >/dev/null 2>&1
OUT="$(bash "$INTENT" status --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"verdict": "LINKED-CURRENT"'; then
    ok "an intent linked at the current hash reads LINKED-CURRENT"
else
    bad "a freshly linked intent did not read LINKED-CURRENT"
fi

# --- 2. THE 8090 FAILURE MODE ------------------------------------------------
# The requirement is rewritten so the code can still satisfy the spec perfectly
# while the intent is violated. No verification gate can see this.
python3 - "$D/.loki/spec/spec.lock" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["requirements"][0]["text"] = "Admins can export data via internal API"
d["requirements"][0]["content_hash"] = "ccc333"
json.dump(d, open(p, "w"))
PY
OUT="$(bash "$INTENT" status --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"verdict": "LINKED-STALE"'; then
    ok "a spec that drifted away from the intent reads LINKED-STALE"
else
    bad "spec drift away from intent was NOT detected -- the core failure"
fi
# The report must name both hashes, or a reader cannot check the claim by hand.
if printf '%s' "$OUT" | grep -q 'aaa111' && printf '%s' "$OUT" | grep -q 'ccc333'; then
    ok "the report names the affirmed hash and the current hash"
else
    bad "the report does not name both hashes, so the claim is unverifiable"
fi

# --- 3. affirm clears it, and APPENDS rather than overwrites -----------------
# Without affirm the first legitimate spec edit makes a statement stale forever,
# the gate stays red, and a run grinds to max iterations against a finding no
# action can clear.
bash "$INTENT" affirm "$SID" >/dev/null 2>&1
OUT="$(bash "$INTENT" status --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"verdict": "LINKED-CURRENT"'; then
    ok "re-affirming an agreed change clears the stale verdict"
else
    bad "affirm did not clear the stale verdict -- gate would stay red forever"
fi
N="$(python3 -c "
import json
d=json.load(open('$D/.loki/intent/intent.json'))
print(len(d['statements'][0]['links'][0]['affirmations']))" 2>/dev/null)"
if [ "$N" = "2" ]; then
    ok "affirmation history is appended, not overwritten (2 entries)"
else
    bad "affirmation history was overwritten (got '$N', expected 2)"
fi

# --- 4. A removed requirement is REMOVED, not STALE --------------------------
python3 - "$D/.loki/spec/spec.lock" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["requirements"] = [r for r in d["requirements"] if r["id"] != "R1"]
json.dump(d, open(p, "w"))
PY
OUT="$(bash "$INTENT" status --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"verdict": "LINKED-REMOVED"'; then
    ok "a deleted requirement reads LINKED-REMOVED, distinct from STALE"
else
    bad "a deleted requirement was not distinguished from a stale one"
fi
rm -rf "$D"

# --- 5. UNKNOWN discipline: refuse rather than invent ------------------------
D="$(_mk)"; export LOKI_DIR="$D/.loki"
OUT="$(bash "$INTENT" status --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason":"no_intent_record"'; then
    ok "no intent recorded reads UNKNOWN with a named reason"
else
    bad "a missing intent record did not report a named UNKNOWN"
fi
# The most important refusal: a user's own PRD is their INTERPRETATION already,
# so treating it as intent would score every such run perfectly aligned.
if grep -q "no_distinct_intent_source" "$INTENT"; then
    ok "the spec-is-the-user's-own-document case has a named refusal"
else
    bad "no refusal exists for the case where intent and spec are one artifact"
fi
rm -rf "$D"

# --- 6. STRUCTURAL: no similarity score may ever be emitted ------------------
# Checked against EXECUTABLE lines only. A first version grepped the whole file
# and went red on the module's own comments, which say in prose that no such
# score exists -- a guard that fires on its own documentation gets deleted by the
# next person, so it is scoped to code. Comment lines and echo'd help text are
# stripped before matching.
CODE_ONLY="$(grep -vE '^\s*#' "$INTENT" | grep -vE '^\s*echo ')"
if printf '%s' "$CODE_ONLY" | grep -qiE "similarity|fidelity_score|percent_aligned|embedding|cosine"; then
    bad "a similarity/fidelity score exists in code -- that is an LLM judgment as a measurement"
else
    ok "no similarity, fidelity, or embedding score in executable code"
fi
# And nothing may shell out to a model to decide a verdict. This is the sharper
# guard: the forbidden feature is not the WORD, it is asking an LLM a question
# whose answer becomes a status.
if printf '%s' "$CODE_ONLY" | grep -qiE "claude |anthropic|openai|llm_|provider_invoke"; then
    bad "the intent ledger invokes a model -- verdicts must be deterministic"
else
    ok "no model is invoked; every verdict is a hash comparison"
fi

# --- 7. No second telemetry egress point -------------------------------------
if [ "$(grep -c 'loki_telemetry\|curl ' "$INTENT")" = "0" ]; then
    ok "no second telemetry egress point"
else
    bad "the intent ledger emits telemetry directly"
fi

# --- 8. The assumption store is referenced, never duplicated -----------------
# spec-interrogation.sh already owns ASSUMED-BUT-NOT-STATED. Two stores drift.
if grep -q "assumption_ids" "$INTENT" && ! grep -qE '"assumed"' "$INTENT"; then
    ok "assumptions are referenced by id, not re-stored"
else
    bad "a second assumption store was introduced"
fi

# --- 9. House style ----------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$INTENT" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
